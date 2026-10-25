package api

import (
	"context"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/whatsapp"
	"strings"
	"time"
)

func (s *Server) groupChat(c *fiber.Ctx) (*domain.Chat, error) {
	accountID := c.Locals("account_id").(uuid.UUID)
	if !s.pool.GroupsEnabledForAccount(accountID) {
		return nil, fiber.ErrNotFound
	}
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return nil, fiber.ErrBadRequest
	}
	chat, err := s.repos.Chat.GetByID(c.Context(), id)
	if err != nil {
		return nil, fiber.ErrInternalServerError
	}
	if chat == nil || chat.AccountID != accountID || !domain.IsGroupJID(chat.JID) {
		return nil, fiber.ErrNotFound
	}
	return chat, nil
}
func (s *Server) handleGetChatGroup(c *fiber.Ctx) error {
	chat, err := s.groupChat(c)
	if err != nil {
		return err
	}
	if err = s.repos.Chat.HydrateGroups(c.Context(), chat.AccountID, []*domain.Chat{chat}); err != nil {
		return fiber.ErrInternalServerError
	}
	// Read cached metadata immediately; explicit refresh reports provider failure.
	if c.QueryBool("refresh") && chat.DeviceID != nil {
		if chat, err = s.pool.RefreshGroup(c.Context(), chat.AccountID, *chat.DeviceID, chat.JID); err != nil {
			return c.Status(503).JSON(fiber.Map{"success": false, "error": "WhatsApp no pudo actualizar el grupo", "code": "group_refresh_unavailable"})
		}
	}
	return c.JSON(fiber.Map{"success": true, "group": chat.Group})
}
func (s *Server) handleGetGroupParticipants(c *fiber.Ctx) error {
	chat, err := s.groupChat(c)
	if err != nil {
		return err
	}
	var beforeIdentity, beforeGroup int64
	if chat.DeviceID != nil {
		beforeIdentity, beforeGroup, err = s.repos.Chat.SnapshotVersionByGroupJID(c.Context(), chat.AccountID, *chat.DeviceID, chat.JID)
		if err != nil {
			return fiber.ErrInternalServerError
		}
	}
	search := strings.TrimSpace(c.Query("search"))
	var identities *whatsapp.GroupParticipantIdentitySnapshot
	if chat.DeviceID != nil {
		identities = s.pool.GroupParticipantIdentities(c.Context(), chat.AccountID, *chat.DeviceID)
	}
	var matchingJIDs []string
	var projectedByJID map[string]domain.GroupParticipant
	if search != "" {
		all, readErr := s.repos.Chat.GroupParticipantIdentitySnapshot(c.Context(), chat.AccountID, chat.ID)
		if readErr != nil {
			return fiber.ErrInternalServerError
		}
		all, _, _, err = s.projectGroupParticipantsWithSnapshot(c, chat, all, identities)
		if err != nil {
			return fiber.ErrInternalServerError
		}
		matchingJIDs = groupParticipantsMatchingSearch(all, search)
		projectedByJID = make(map[string]domain.GroupParticipant, len(all))
		for _, member := range all {
			projectedByJID[member.JID] = member
		}
	}
	rows, next, err := s.repos.Chat.GroupParticipantsMatching(c.Context(), chat.AccountID, chat.ID, search, c.Query("cursor"), c.QueryInt("limit", 50), matchingJIDs)
	if err != nil {
		return fiber.ErrInternalServerError
	}
	if projectedByJID != nil {
		for i := range rows {
			rows[i] = projectedByJID[rows[i].JID]
		}
	} else {
		rows, _, _, err = s.projectGroupParticipantsWithSnapshot(c, chat, rows, identities)
		if err != nil {
			return fiber.ErrInternalServerError
		}
	}
	var identityRevision, groupRevision int64
	if chat.DeviceID != nil {
		identityRevision, groupRevision, err = s.repos.Chat.SnapshotVersionByGroupJID(c.Context(), chat.AccountID, *chat.DeviceID, chat.JID)
		if err != nil {
			return fiber.ErrInternalServerError
		}
	}
	if beforeIdentity != identityRevision || beforeGroup != groupRevision {
		return fiber.NewError(fiber.StatusConflict, "Los integrantes se actualizaron durante la consulta. Reintenta.")
	}
	return c.JSON(fiber.Map{"success": true, "participants": rows, "next_cursor": next, "identity_revision": identityRevision, "group_revision": groupRevision})
}
func (s *Server) handleSyncGroups(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	deviceID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return fiber.ErrBadRequest
	}
	if _, err = s.requireManualDeviceForAccount(c.Context(), accountID, deviceID); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(c.Context(), 50*time.Second)
	defer cancel()
	count, err := s.pool.SyncGroups(ctx, accountID, deviceID)
	if err != nil {
		return c.Status(503).JSON(fiber.Map{"success": false, "error": "No se pudieron actualizar los grupos. Verifica la conexión y la recepción de mensajes.", "code": "group_sync_unavailable"})
	}
	s.invalidateChatsCache(accountID)
	recovery, err := s.repos.Chat.IdentityRecoveryStatus(c.Context(), accountID, deviceID)
	if err != nil {
		return fiber.ErrInternalServerError
	}
	return c.JSON(fiber.Map{"success": true, "synced": count, "recovery": recovery})
}
func (s *Server) handleGroupReceipts(c *fiber.Ctx) error {
	chat, err := s.groupChat(c)
	if err != nil {
		return err
	}
	message, err := s.repos.Message.GetByReference(c.Context(), chat.AccountID, chat.ID, c.Params("messageId"))
	if err != nil || message == nil {
		return fiber.ErrNotFound
	}
	rows, next, total, err := s.repos.Message.GroupReceipts(c.Context(), chat.AccountID, chat.ID, message.MessageID, c.Query("cursor"), c.QueryInt("limit", 50))
	if err != nil {
		return fiber.ErrInternalServerError
	}
	return c.JSON(fiber.Map{"success": true, "receipts": rows, "total": total, "next_cursor": next})
}

// Group destinations have a separate authorization boundary. This also covers
// reactions (which provide only chat_id), forwarding (whose chat_id is the
// source) and message actions (which provide chat_jid).
func (s *Server) groupRequestMiddleware(c *fiber.Ctx) error {
	var req struct {
		DeviceID string                  `json:"device_id"`
		ChatID   string                  `json:"chat_id"`
		To       string                  `json:"to"`
		ChatJID  string                  `json:"chat_jid"`
		Mentions []domain.MessageMention `json:"mentions"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Next()
	}
	accountID := c.Locals("account_id").(uuid.UUID)
	destination := strings.TrimSpace(req.To)
	if destination == "" {
		destination = strings.TrimSpace(req.ChatJID)
	}
	var chat *domain.Chat
	var err error
	deviceID, _ := uuid.Parse(req.DeviceID)
	if destination == "" && req.ChatID != "" {
		if chatID, e := uuid.Parse(req.ChatID); e == nil {
			chat, err = s.repos.Chat.GetByID(c.Context(), chatID)
			if err != nil {
				return fiber.ErrInternalServerError
			}
			if chat != nil && chat.AccountID == accountID && domain.IsGroupJID(chat.JID) {
				destination = chat.JID
				if chat.DeviceID != nil {
					deviceID = *chat.DeviceID
				}
			}
		}
	}
	if !domain.IsGroupJID(destination) {
		if len(req.Mentions) > 0 {
			return c.Status(422).JSON(fiber.Map{"success": false, "error": "Las menciones requieren un grupo", "code": "group_mentions_only"})
		}
		return c.Next()
	}
	if deviceID == uuid.Nil {
		return fiber.ErrBadRequest
	}
	if chat == nil {
		chat, err = s.repos.Chat.FindByDeviceJID(c.Context(), accountID, deviceID, destination)
	}
	if err != nil {
		return fiber.ErrInternalServerError
	}
	if chat == nil || chat.AccountID != accountID {
		return fiber.ErrNotFound
	}
	if req.ChatID != "" && !strings.HasSuffix(c.Path(), "/forward") && req.ChatID != chat.ID.String() {
		return fiber.ErrConflict
	}
	if _, err = s.requireManualDeviceForAccount(c.Context(), accountID, deviceID); err != nil {
		return err
	}
	requireSend := !strings.HasSuffix(c.Path(), "/read-receipt") && !strings.HasSuffix(c.Path(), "/typing") && !strings.HasSuffix(c.Path(), "/react")
	_, err = s.pool.PrepareGroupSend(c.Context(), accountID, deviceID, chat.ID, destination, req.Mentions, requireSend)
	if err != nil {
		return c.Status(409).JSON(fiber.Map{"success": false, "error": err.Error(), "code": "group_send_unavailable"})
	}
	c.Locals("group_chat", chat)
	return c.Next()
}

func (s *Server) handleRecoverGroupMedia(c *fiber.Ctx) error {
	chat, err := s.groupChat(c)
	if err != nil {
		return err
	}
	if chat.DeviceID == nil {
		return c.Status(409).JSON(fiber.Map{"success": false, "error": "El dispositivo de este historial ya no está disponible", "code": "group_media_unavailable"})
	}
	message, err := s.repos.Message.GetByReference(c.Context(), chat.AccountID, chat.ID, c.Params("messageId"))
	if err != nil || message == nil {
		return fiber.ErrNotFound
	}
	message, err = s.pool.RecoverGroupMedia(c.Context(), chat.AccountID, *chat.DeviceID, chat.ID, message.ID)
	if err != nil {
		if message != nil && message.MediaUnavailableReason == "group_media_too_large" {
			_ = s.services.Chat.AttachReactions(c.Context(), chat.AccountID, chat.ID, []*domain.Message{message})
			return c.Status(422).JSON(fiber.Map{"success": false, "error": err.Error(), "code": "group_media_too_large", "message": message})
		}
		return c.Status(502).JSON(fiber.Map{"success": false, "error": err.Error(), "code": "group_media_unavailable"})
	}
	_ = s.services.Chat.AttachReactions(c.Context(), chat.AccountID, chat.ID, []*domain.Message{message})
	return c.JSON(fiber.Map{"success": true, "message": message})
}
