package api

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/url"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
	"github.com/naperu/clarin/internal/whatsapp"
	"go.mau.fi/whatsmeow/types"
)

type groupMemberScope struct {
	Chat               *domain.Chat
	RawMember          domain.GroupParticipant
	CanonicalContactID *uuid.UUID
	Profile            domain.GroupParticipantProfile
}

func projectGroupMemberContact(member domain.GroupParticipant, contact *repository.GroupMemberContact) domain.GroupParticipant {
	if contact == nil {
		return member
	}
	member.Name = contact.Name
	member.NameSource = "contact"
	member.AvatarURL = contact.AvatarURL
	member.AvatarSource = "contact"
	return member
}

func groupActorCanReadContacts(claims *service.JWTClaims) bool {
	if claims == nil {
		return false
	}
	if domain.HasAccountAdminAuthority(claims.Role, claims.IsSuperAdmin) {
		return true
	}
	for _, permission := range claims.Permissions {
		if permission == domain.PermAll || permission == domain.PermContacts {
			return true
		}
	}
	return false
}

func groupMemberFingerprint(secret string, accountID, deviceID, chatID uuid.UUID, member domain.GroupParticipant, contactID *uuid.UUID) string {
	contact := ""
	if contactID != nil {
		contact = contactID.String()
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(strings.Join([]string{"group-member-v1", accountID.String(), deviceID.String(), chatID.String(), member.JID, member.LID, member.Phone, contact}, "\x00")))
	return hex.EncodeToString(mac.Sum(nil))
}

func groupMemberCapabilities(member domain.GroupParticipant, connected bool) domain.GroupParticipantCapabilities {
	caps := domain.GroupParticipantCapabilities{CanQueryAvatar: connected, CanQueryAbout: connected && validWhatsAppPhone(member.Phone), CanListCommonGroups: true}
	switch {
	case member.IsSelf:
		caps.MessageDisabledReason = "Este integrante es tu propio número"
	case !connected:
		caps.MessageDisabledReason = "El dispositivo de este grupo no está conectado"
	case !validWhatsAppPhone(member.Phone):
		caps.MessageDisabledReason = "WhatsApp no proporciona un teléfono verificable para este integrante"
	default:
		caps.CanMessage = true
	}
	return caps
}

func groupMemberReference(raw string) (string, error) {
	value, err := url.PathUnescape(raw)
	if err != nil {
		return "", fiber.ErrBadRequest
	}
	jid, err := types.ParseJID(value)
	if err != nil || jid.IsEmpty() || (jid.Server != types.DefaultUserServer && jid.Server != types.HiddenUserServer) {
		return "", fiber.ErrBadRequest
	}
	return jid.ToNonAD().String(), nil
}

func (s *Server) projectGroupParticipants(c *fiber.Ctx, chat *domain.Chat, members []domain.GroupParticipant) ([]domain.GroupParticipant, map[int]uuid.UUID, map[uuid.UUID]repository.GroupMemberContact, error) {
	return s.projectGroupParticipantsWithSnapshot(c, chat, members, nil)
}

func (s *Server) projectGroupParticipantsWithSnapshot(c *fiber.Ctx, chat *domain.Chat, members []domain.GroupParticipant, snapshot *whatsapp.GroupParticipantIdentitySnapshot) ([]domain.GroupParticipant, map[int]uuid.UUID, map[uuid.UUID]repository.GroupMemberContact, error) {
	if chat.DeviceID == nil {
		return members, nil, nil, nil
	}
	if snapshot == nil {
		snapshot = s.pool.GroupParticipantIdentities(c.Context(), chat.AccountID, *chat.DeviceID)
	}
	members = snapshot.Resolve(c.Context(), members)
	for i := range members {
		members[i].WhatsAppName = members[i].Name
		members[i].AvatarSource = "whatsapp"
		members[i].AvatarURL = "/api/chats/" + chat.ID.String() + "/group/participants/" + url.PathEscape(members[i].JID) + "/avatar?preview=true"
	}
	claims, _ := c.Locals("claims").(*service.JWTClaims)
	canonical, visible, err := s.repos.Chat.GroupMemberContacts(c.Context(), chat.AccountID, members, groupActorCanReadContacts(claims))
	if err != nil {
		return nil, nil, nil, err
	}
	for i := range members {
		if contact, ok := visible[canonical[i]]; ok {
			members[i] = projectGroupMemberContact(members[i], &contact)
		}
	}
	return members, canonical, visible, nil
}

func groupParticipantsMatchingSearch(members []domain.GroupParticipant, search string) []string {
	query := strings.ToLower(strings.TrimSpace(search))
	matching := []string{}
	for _, member := range members {
		for _, value := range []string{member.Name, member.WhatsAppName, member.Phone, member.RedactedPhone} {
			if strings.Contains(strings.ToLower(value), query) {
				matching = append(matching, member.JID)
				break
			}
		}
	}
	return matching
}

func (s *Server) groupParticipantScope(c *fiber.Ctx) (*groupMemberScope, error) {
	return s.loadGroupParticipantScope(c, true)
}

func (s *Server) loadGroupParticipantScope(c *fiber.Ctx, withProjection bool) (*groupMemberScope, error) {
	chat, err := s.groupChat(c)
	if err != nil {
		return nil, err
	}
	if chat.DeviceID == nil {
		return nil, fiber.ErrNotFound
	}
	if err = s.repos.Chat.HydrateGroups(c.Context(), chat.AccountID, []*domain.Chat{chat}); err != nil {
		return nil, fiber.ErrInternalServerError
	}
	if chat.Group == nil || chat.Group.MembershipStatus != "member" {
		return nil, fiber.ErrNotFound
	}
	jid, err := groupMemberReference(c.Params("participantJID"))
	if err != nil {
		return nil, err
	}
	member, err := s.repos.Chat.GroupParticipant(c.Context(), chat.AccountID, chat.ID, jid)
	if err != nil {
		return nil, fiber.ErrInternalServerError
	}
	if member == nil {
		return nil, fiber.ErrNotFound
	}
	projected := []domain.GroupParticipant{*member}
	canonical := map[int]uuid.UUID{}
	visible := map[uuid.UUID]repository.GroupMemberContact{}
	if withProjection {
		projected, canonical, visible, err = s.projectGroupParticipants(c, chat, projected)
		if err != nil {
			return nil, fiber.ErrInternalServerError
		}
	} else {
		projected[0] = s.pool.ResolveCachedGroupParticipantAddress(c.Context(), chat.AccountID, *chat.DeviceID, *member)
	}
	device, err := s.services.Device.GetByID(c.Context(), *chat.DeviceID)
	if err != nil {
		return nil, fiber.ErrInternalServerError
	}
	if device == nil || device.AccountID != chat.AccountID || device.Deletion != nil || getDeviceProvider(device) != domain.DeviceProviderWhatsAppWeb {
		return nil, fiber.ErrNotFound
	}
	connected := deviceCanSendManual(device)
	profile := domain.GroupParticipantProfile{Participant: projected[0], DeviceID: *chat.DeviceID, Capabilities: groupMemberCapabilities(projected[0], connected)}
	scope := &groupMemberScope{Chat: chat, RawMember: *member, Profile: profile}
	if id, ok := canonical[0]; ok {
		scope.CanonicalContactID = &id
		if contact, allowed := visible[id]; allowed {
			context := &domain.GroupParticipantContactContext{ContactID: id, Context: "contact"}
			claims, _ := c.Locals("claims").(*service.JWTClaims)
			if !groupActorCanReadContacts(claims) {
				context.Context = "chat"
				context.ChatID = contact.DirectChatID
			}
			scope.Profile.ContactContext = context
		}
	}
	scope.Profile.IdentityFingerprint = groupMemberFingerprint(s.cfg.JWTSecret, chat.AccountID, *chat.DeviceID, chat.ID, projected[0], scope.CanonicalContactID)
	return scope, nil
}

func (s *Server) handleGetGroupParticipantProfile(c *fiber.Ctx) error {
	c.Set(fiber.HeaderCacheControl, "no-store")
	scope, err := s.groupParticipantScope(c)
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"success": true, "profile": scope.Profile})
}

func (s *Server) handleGetGroupParticipantAbout(c *fiber.Ctx) error {
	c.Set(fiber.HeaderCacheControl, "no-store")
	scope, err := s.loadGroupParticipantScope(c, false)
	if err != nil {
		return err
	}
	if !scope.Profile.Capabilities.CanQueryAbout {
		return c.JSON(fiber.Map{"success": true, "about": fiber.Map{"text": "", "state": "unavailable"}})
	}
	text, state, err := s.pool.GroupParticipantAbout(c.Context(), scope.Chat.AccountID, scope.Profile.DeviceID, scope.Profile.Participant)
	if err != nil {
		return c.Status(502).JSON(fiber.Map{"success": false, "code": "about_unavailable", "error": "WhatsApp no pudo consultar la información de este integrante", "about": fiber.Map{"text": "", "state": "unavailable"}})
	}
	return c.JSON(fiber.Map{"success": true, "about": fiber.Map{"text": text, "state": state, "source": "whatsapp"}})
}

func (s *Server) handleGetGroupParticipantAvatar(c *fiber.Ctx) error {
	c.Set(fiber.HeaderCacheControl, "private, no-store")
	scope, err := s.loadGroupParticipantScope(c, false)
	if err != nil {
		return err
	}
	if !scope.Profile.Capabilities.CanQueryAvatar {
		return c.Status(409).JSON(fiber.Map{"success": false, "code": "photo_unavailable", "error": "El dispositivo de este grupo no está conectado"})
	}
	data, err := s.pool.GroupParticipantPhoto(c.Context(), scope.Chat.AccountID, scope.Profile.DeviceID, scope.Chat.JID, scope.Profile.Participant, c.QueryBool("preview"))
	if err != nil {
		status, code, message := fiber.StatusBadGateway, "photo_unavailable", "WhatsApp no pudo entregar la foto"
		switch whatsapp.ProfilePictureErrorCode(err) {
		case whatsapp.ProfilePictureCodePrivate:
			status, code, message = fiber.StatusForbidden, "photo_private", "La privacidad de WhatsApp no permite ver esta foto"
		case whatsapp.ProfilePictureCodeNotSet:
			status, code, message = fiber.StatusNotFound, "photo_not_set", "Este integrante no tiene una foto visible"
		}
		return c.Status(status).JSON(fiber.Map{"success": false, "code": code, "error": message})
	}
	c.Set(fiber.HeaderContentType, "image/jpeg")
	c.Set("X-Content-Type-Options", "nosniff")
	return c.Send(data)
}

func (s *Server) handleGetGroupParticipantCommonGroups(c *fiber.Ctx) error {
	c.Set(fiber.HeaderCacheControl, "no-store")
	scope, err := s.loadGroupParticipantScope(c, false)
	if err != nil {
		return err
	}
	cursor := strings.TrimSpace(c.Query("cursor"))
	if cursor != "" {
		if _, err = uuid.Parse(cursor); err != nil {
			return fiber.ErrBadRequest
		}
	}
	items, next, err := s.repos.Chat.GroupMemberCommonGroups(c.Context(), scope.Chat.AccountID, scope.Profile.DeviceID, scope.Profile.Participant, cursor, c.QueryInt("limit", 50))
	if err != nil {
		return fiber.ErrInternalServerError
	}
	return c.JSON(fiber.Map{"success": true, "groups": items, "next_cursor": next, "source": "known_device_groups", "known_groups_only": true, "synced_at": scope.Chat.Group.SyncedAt})
}

func groupMemberIdentityChanged(c *fiber.Ctx) error {
	return c.Status(409).JSON(fiber.Map{"success": false, "code": "identity_changed", "error": "La identidad o membresía del integrante cambió. Abre nuevamente su perfil."})
}

func (s *Server) handleOpenGroupParticipantChat(c *fiber.Ctx) error {
	c.Set(fiber.HeaderCacheControl, "no-store")
	var req struct {
		IdentityFingerprint string                                 `json:"identity_fingerprint"`
		SenderConfirmation  *repository.WhatsAppSenderConfirmation `json:"sender_confirmation,omitempty"`
	}
	if c.BodyParser(&req) != nil {
		return fiber.ErrBadRequest
	}
	scope, err := s.groupParticipantScope(c)
	if err != nil {
		return err
	}
	if !hmac.Equal([]byte(req.IdentityFingerprint), []byte(scope.Profile.IdentityFingerprint)) {
		return groupMemberIdentityChanged(c)
	}
	if !scope.Profile.Capabilities.CanMessage {
		return c.Status(409).JSON(fiber.Map{"success": false, "code": "group_member_chat_unavailable", "error": scope.Profile.Capabilities.MessageDisabledReason})
	}
	device, err := s.requireManualDeviceForAccount(c.Context(), scope.Chat.AccountID, scope.Profile.DeviceID)
	if err != nil {
		return err
	}
	fresh, err := s.pool.FreshGroupParticipant(c.Context(), scope.Chat.AccountID, scope.Profile.DeviceID, scope.Chat.JID, scope.Profile.Participant)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "code": "group_member_not_found", "error": "No se pudo confirmar que este integrante siga en el grupo"})
	}
	if groupMemberFingerprint(s.cfg.JWTSecret, scope.Chat.AccountID, scope.Profile.DeviceID, scope.Chat.ID, fresh, scope.CanonicalContactID) != scope.Profile.IdentityFingerprint {
		return groupMemberIdentityChanged(c)
	}
	results, err := s.services.Chat.IsOnWhatsApp(c.Context(), scope.Profile.DeviceID, []string{"+" + fresh.Phone})
	if err != nil {
		return c.Status(503).JSON(fiber.Map{"success": false, "code": "whatsapp_validation_unavailable", "error": "No se pudo validar el número con WhatsApp"})
	}
	if len(results) == 0 || !results[0].IsOnWhatsApp {
		return c.Status(422).JSON(fiber.Map{"success": false, "code": "not_on_whatsapp", "error": "El número ya no está disponible en WhatsApp"})
	}
	canonicalJID, err := canonicalWhatsAppUserJID(results[0].JID)
	if err != nil || strings.Split(canonicalJID, "@")[0] != fresh.Phone {
		return groupMemberIdentityChanged(c)
	}
	// Remote validation may wait; recheck both provider membership and the local
	// identity before the transactional canonical Contact/Chat entry point.
	freshAgain, err := s.pool.FreshGroupParticipant(c.Context(), scope.Chat.AccountID, scope.Profile.DeviceID, scope.Chat.JID, scope.Profile.Participant)
	if err != nil {
		return groupMemberIdentityChanged(c)
	}
	if groupMemberFingerprint(s.cfg.JWTSecret, scope.Chat.AccountID, scope.Profile.DeviceID, scope.Chat.ID, freshAgain, scope.CanonicalContactID) != scope.Profile.IdentityFingerprint {
		return groupMemberIdentityChanged(c)
	}
	current, err := s.groupParticipantScope(c)
	if err != nil {
		return err
	}
	if !hmac.Equal([]byte(current.Profile.IdentityFingerprint), []byte(req.IdentityFingerprint)) {
		return groupMemberIdentityChanged(c)
	}
	existing, err := s.services.Chat.FindByJID(c.Context(), scope.Chat.AccountID, canonicalJID)
	if err != nil {
		return fiber.ErrInternalServerError
	}
	ctx := repository.WithGroupParticipantChatGuard(c.Context(), repository.GroupParticipantChatGuard{
		AccountID: scope.Chat.AccountID, DeviceID: scope.Profile.DeviceID, ChatID: scope.Chat.ID, Member: current.RawMember,
		VerifiedJID: canonicalJID, VerifiedPhone: fresh.Phone, VerifiedLID: current.Profile.Participant.LID,
		ExpectedCanonicalContactID: current.CanonicalContactID,
	})
	name := ""
	if current.Profile.Participant.NameSource != "phone" && current.Profile.Participant.NameSource != "unavailable" {
		name = current.Profile.Participant.Name
	}
	chat, err := s.repos.Chat.OpenManualWhatsAppChat(ctx, scope.Chat.AccountID, scope.Profile.DeviceID, current.CanonicalContactID, canonicalJID, fresh.Phone, name, req.SenderConfirmation)
	if errors.Is(err, repository.ErrGroupMemberIdentityChanged) {
		return groupMemberIdentityChanged(c)
	}
	if err != nil {
		status, code, message := classifyWhatsAppChatCreationError(err)
		body := fiber.Map{"success": false, "code": code, "error": message}
		if errors.Is(err, repository.ErrWhatsAppSenderConfirmation) && existing != nil {
			history, historyErr := s.repos.Chat.WhatsAppSenderContext(c.Context(), scope.Chat.AccountID, existing.ID)
			if historyErr == nil {
				body["requires_confirmation"] = true
				body["sender_confirmation"] = &repository.WhatsAppSenderConfirmation{DeviceID: scope.Profile.DeviceID, DevicePhone: normalizeDevicePhone(device), HistoryRevision: history.Revision}
			}
		}
		return c.Status(status).JSON(body)
	}
	s.invalidateChatsCache(scope.Chat.AccountID)
	if s.hub != nil {
		s.hub.BroadcastToAccountWithPermission(scope.Chat.AccountID, domain.PermChats, "chat_sender_changed", fiber.Map{"chat_id": chat.ID, "device_id": scope.Profile.DeviceID})
	}
	status := fiber.StatusOK
	if existing == nil {
		status = fiber.StatusCreated
	}
	return c.Status(status).JSON(fiber.Map{"success": true, "chat": chat, "created": existing == nil})
}
