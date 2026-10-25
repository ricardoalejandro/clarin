package whatsapp

import (
	"context"
	"fmt"
	"github.com/naperu/clarin/internal/repository"
	"strings"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/types"
)

// Group metadata's DisplayName is a redacted phone, never a personal name.
func resolveGroupMemberIdentity(part types.GroupParticipant, ownPN, ownLID, mappedPN types.JID, contacts map[types.JID]types.ContactInfo) domain.GroupParticipant {
	primary, pn, lid := part.JID.ToNonAD(), part.PhoneNumber.ToNonAD(), part.LID.ToNonAD()
	if primary.Server == types.DefaultUserServer && pn.IsEmpty() {
		pn = primary
	}
	if primary.Server == types.HiddenUserServer && lid.IsEmpty() {
		lid = primary
	}
	if pn.IsEmpty() && !phoneIdentityJID(mappedPN).IsEmpty() {
		pn = mappedPN.ToNonAD()
	}
	if primary.IsEmpty() {
		if !lid.IsEmpty() {
			primary = lid
		} else {
			primary = pn
		}
	}
	// Keep the established PN-first projection; aliases retain the provider LID.
	jid := primary
	if !pn.IsEmpty() {
		jid = pn
	}
	member := domain.GroupParticipant{JID: jid.String(), Role: "member", RedactedPhone: strings.TrimSpace(part.DisplayName)}
	if !lid.IsEmpty() {
		member.LID = lid.String()
	}
	if phone := phoneIdentityJID(pn); !phone.IsEmpty() {
		member.Phone = phone.User
	}
	aliases := []types.JID{pn, primary, lid}
	infos := make([]types.ContactInfo, 0, len(aliases))
	for _, alias := range aliases {
		if !alias.IsEmpty() {
			if info, ok := contacts[alias.ToNonAD()]; ok {
				infos = append(infos, info)
				if member.RedactedPhone == "" {
					member.RedactedPhone = strings.TrimSpace(info.RedactedPhone)
				}
			}
		}
	}
	for _, source := range []string{"full_name", "first_name", "business_name", "push_name"} {
		for _, info := range infos {
			name := ""
			switch source {
			case "full_name":
				name = info.FullName
			case "first_name":
				name = info.FirstName
			case "business_name":
				name = info.BusinessName
			case "push_name":
				name = info.PushName
			}
			if name = strings.TrimSpace(name); name != "" {
				member.Name, member.NameSource = name, source
				break
			}
		}
		if member.Name != "" {
			break
		}
	}
	if member.Name == "" {
		if member.Phone != "" {
			member.Name, member.NameSource = member.Phone, "phone"
		} else {
			member.Name, member.NameSource = "Nombre no disponible", "unavailable"
		}
	}
	if part.IsSuperAdmin {
		member.Role = "super_admin"
	} else if part.IsAdmin {
		member.Role = "admin"
	}
	member.IsSelf = sameReportJID(primary, ownPN) || sameReportJID(primary, ownLID) || sameReportJID(pn, ownPN) || sameReportJID(lid, ownLID)
	return member
}

// ResolveCachedGroupParticipant reads only the selected device's provider cache.
// It never creates or updates CRM identity records.
func (p *DevicePool) ResolveCachedGroupParticipant(ctx context.Context, accountID, deviceID uuid.UUID, member domain.GroupParticipant) (domain.GroupParticipant, error) {
	rows, err := p.ResolveCachedGroupParticipants(ctx, accountID, deviceID, []domain.GroupParticipant{member})
	if err != nil {
		return domain.GroupParticipant{}, err
	}
	return rows[0], nil
}

// Secondary photo/about lookups need verified addressing, not an address-book
// scan or CRM projection for every image request.
func (p *DevicePool) ResolveCachedGroupParticipantAddress(ctx context.Context, accountID, deviceID uuid.UUID, member domain.GroupParticipant) (domain.GroupParticipant, error) {
	var instance *DeviceInstance
	if p != nil {
		instance = p.GetDevice(deviceID)
		if instance != nil && instance.AccountID != accountID {
			instance = nil
		}
	}
	fingerprint := ""
	if instance != nil && instance.Client != nil {
		fingerprint = deviceSessionFingerprint(instance.Client.Store)
	}
	var aliases *domain.WhatsAppPeerIdentitySnapshot
	if p != nil && p.repos != nil && p.repos.Chat != nil {
		var err error
		aliases, err = p.repos.Chat.WhatsAppPeerAliases(ctx, accountID, deviceID, peerIdentityJIDs([]domain.GroupParticipant{member}))
		if err != nil {
			return domain.GroupParticipant{}, fmt.Errorf("load participant addressing: %w", err)
		}
	}
	if fingerprint != "" {
		if err := p.requirePeerIdentitySession(instance, fingerprint); err != nil {
			return domain.GroupParticipant{}, err
		}
	}
	return projectDurablePeer(ctx, instance, member, nil, aliases), nil
}

// The provider has no bounded name-batch API. Prefetch its local contact cache
// once per page/operation instead of issuing a lookup for every PN/LID alias.
func (p *DevicePool) ResolveCachedGroupParticipants(ctx context.Context, accountID, deviceID uuid.UUID, members []domain.GroupParticipant) ([]domain.GroupParticipant, error) {
	return p.GroupParticipantIdentities(ctx, accountID, deviceID).Resolve(ctx, members)
}

// One operation owns this provider-local snapshot, shared by search and its
// returned page so filtering cannot miss a name that the page will display.
type GroupParticipantIdentitySnapshot struct {
	pool                *DevicePool
	fingerprint         string
	instance            *DeviceInstance
	contacts            map[types.JID]types.ContactInfo
	repo                *repository.ChatRepository
	accountID, deviceID uuid.UUID
	initErr             error
}

func (p *DevicePool) GroupParticipantIdentities(ctx context.Context, accountID, deviceID uuid.UUID) *GroupParticipantIdentitySnapshot {
	snapshot := &GroupParticipantIdentitySnapshot{pool: p, accountID: accountID, deviceID: deviceID}
	if p == nil {
		return snapshot
	}
	if p.repos != nil {
		snapshot.repo = p.repos.Chat
	}
	instance := p.GetDevice(deviceID)
	if instance == nil || instance.AccountID != accountID || instance.Client == nil || instance.Client.Store == nil {
		return snapshot
	}
	snapshot.instance = instance
	snapshot.fingerprint = deviceSessionFingerprint(instance.Client.Store)
	if instance.Client.Store.Contacts != nil {
		snapshot.contacts, snapshot.initErr = instance.Client.Store.Contacts.GetAllContacts(ctx)
	}
	return snapshot
}

func (s *GroupParticipantIdentitySnapshot) Resolve(ctx context.Context, members []domain.GroupParticipant) ([]domain.GroupParticipant, error) {
	if s != nil && s.initErr != nil {
		return nil, fmt.Errorf("load participant names: %w", s.initErr)
	}
	if s != nil && s.instance != nil && s.fingerprint != "" {
		if err := s.pool.requirePeerIdentitySession(s.instance, s.fingerprint); err != nil {
			return nil, err
		}
	}
	members = append([]domain.GroupParticipant(nil), members...)
	var instance *DeviceInstance
	var contacts map[types.JID]types.ContactInfo
	if s != nil {
		instance, contacts = s.instance, s.contacts
	}
	for i := range members {
		members[i] = resolveCachedGroupParticipant(ctx, instance, members[i], contacts)
	}
	var durable *domain.WhatsAppPeerIdentitySnapshot
	if s != nil && s.repo != nil {
		var err error
		durable, err = s.repo.WhatsAppPeerIdentities(ctx, s.accountID, s.deviceID, peerIdentityJIDs(members))
		if err != nil {
			return nil, fmt.Errorf("load participant identity: %w", err)
		}
	}
	if s != nil && s.instance != nil && s.fingerprint != "" {
		if err := s.pool.requirePeerIdentitySession(s.instance, s.fingerprint); err != nil {
			return nil, err
		}
	}
	for i := range members {
		members[i] = projectDurablePeer(ctx, instance, members[i], contacts, durable)
	}
	return members, nil
}

func resolveCachedGroupParticipant(ctx context.Context, instance *DeviceInstance, member domain.GroupParticipant, contacts map[types.JID]types.ContactInfo) domain.GroupParticipant {
	// Older snapshots incorrectly stored the metadata's masked phone as Name.
	// Preserve that useful hint in its own field without presenting it as a name.
	if member.RedactedPhone == "" && isRedactedPhoneLabel(member.Name) {
		member.RedactedPhone = strings.TrimSpace(member.Name)
	}
	part := types.GroupParticipant{DisplayName: member.RedactedPhone, IsAdmin: member.Role == "admin", IsSuperAdmin: member.Role == "super_admin"}
	part.JID, _ = types.ParseJID(member.JID)
	part.LID, _ = types.ParseJID(member.LID)
	if part.LID.IsEmpty() && part.JID.Server == types.HiddenUserServer {
		part.LID = part.JID.ToNonAD()
	}
	if member.Phone != "" {
		part.PhoneNumber = types.NewJID(member.Phone, types.DefaultUserServer)
	}
	var ownPN, ownLID types.JID
	if instance != nil && instance.Client != nil && instance.Client.Store != nil {
		if instance.Client.Store.ID != nil {
			ownPN = instance.Client.Store.ID.ToNonAD()
		}
		ownLID = instance.Client.Store.LID
	}
	resolved := resolveGroupMemberIdentity(part, ownPN, ownLID, types.EmptyJID, contacts)
	if resolved.NameSource == "unavailable" || resolved.NameSource == "phone" {
		if name := strings.TrimSpace(member.Name); name != "" && name != "Integrante" && name != "Nombre no disponible" && name != member.Phone && name != resolved.Phone && name != member.RedactedPhone && !isRedactedPhoneLabel(name) {
			resolved.Name, resolved.NameSource = name, member.NameSource
			if resolved.NameSource == "" {
				resolved.NameSource = "cached_whatsapp"
			}
		}
	}
	resolved.IsSelf = resolved.IsSelf || member.IsSelf
	resolved.JID = member.JID
	return resolved
}

func isRedactedPhoneLabel(value string) bool {
	masked, digits := false, false
	for _, r := range value {
		switch {
		case r >= '0' && r <= '9':
			digits = true
		case r == '·' || r == '∙' || r == '*':
			masked = true
		case r == ' ' || r == '+' || r == '-' || r == '(' || r == ')' || r == '.':
		default:
			return false
		}
	}
	return masked && digits
}

func (p *DevicePool) updateGroupParticipantNames(ctx context.Context, instance *DeviceInstance, jids ...types.JID) {
	if !p.GroupsEnabledForAccount(instance.AccountID) {
		return
	}
	aliases := []string{}
	var seed types.JID
	for _, jid := range jids {
		if !jid.IsEmpty() {
			aliases = append(aliases, jid.ToNonAD().String())
			if seed.IsEmpty() {
				seed = jid.ToNonAD()
			}
		}
	}
	if seed.IsEmpty() {
		return
	}
	member := domain.GroupParticipant{JID: seed.String()}
	for _, jid := range jids {
		if jid.Server == types.HiddenUserServer {
			member.LID = jid.ToNonAD().String()
		} else if pn := phoneIdentityJID(jid); !pn.IsEmpty() {
			member.Phone = pn.User
		}
	}
	resolved, err := p.ResolveCachedGroupParticipant(ctx, instance.AccountID, instance.ID, member)
	if err != nil {
		return
	}
	if resolved.NameSource == "phone" || resolved.NameSource == "unavailable" {
		return
	}
	ids, err := p.repos.Chat.UpdateGroupMemberName(ctx, instance.AccountID, instance.ID, aliases, resolved.Name, resolved.NameSource)
	if err != nil {
		return
	}
	if p.hub != nil {
		for _, id := range ids {
			p.hub.BroadcastToAccountWithPermission(instance.AccountID, domain.PermChats, "chat_group_updated", map[string]interface{}{"chat_id": id, "device_id": instance.ID})
		}
	}
}

// History cache persistence is asynchronous upstream. Use the trusted names in
// this event as an input to one projection update, never as Contact mutations.
func (p *DevicePool) updateHistoricalGroupParticipantNames(ctx context.Context, instance *DeviceInstance, names []*waHistorySync.Pushname) {
	if len(names) == 0 || !p.GroupsEnabledForAccount(instance.AccountID) || instance.Client == nil || instance.Client.Store == nil || instance.Client.Store.Contacts == nil {
		return
	}
	contacts, err := instance.Client.Store.Contacts.GetAllContacts(ctx)
	if err != nil {
		return
	}
	copyCache := make(map[types.JID]types.ContactInfo, len(contacts))
	for jid, info := range contacts {
		copyCache[jid] = info
	}
	seeds := []domain.GroupParticipant{}
	for _, entry := range names {
		if entry == nil || entry.GetPushname() == "-" {
			continue
		}
		jid, err := types.ParseJID(entry.GetID())
		if err != nil || (jid.Server != types.HiddenUserServer && jid.Server != types.DefaultUserServer) {
			continue
		}
		jid = jid.ToNonAD()
		info := copyCache[jid]
		info.PushName = entry.GetPushname()
		copyCache[jid] = info
		seed := domain.GroupParticipant{JID: jid.String()}
		if jid.Server == types.HiddenUserServer {
			seed.LID = jid.String()
		}
		seeds = append(seeds, seed)
	}
	updates := make([]domain.GroupParticipant, 0, len(seeds))
	for _, seed := range seeds {
		resolved := resolveCachedGroupParticipant(ctx, instance, seed, copyCache)
		if resolved.NameSource != "phone" && resolved.NameSource != "unavailable" {
			updates = append(updates, resolved)
		}
	}
	ids, err := p.repos.Chat.UpdateGroupMemberNames(ctx, instance.AccountID, instance.ID, updates)
	if err != nil {
		return
	}
	if p.hub != nil {
		for _, id := range ids {
			p.hub.BroadcastToAccountWithPermission(instance.AccountID, domain.PermChats, "chat_group_updated", map[string]interface{}{"chat_id": id, "device_id": instance.ID})
		}
	}
}
