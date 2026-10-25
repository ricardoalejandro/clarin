package repository

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

var ErrGroupMemberIdentityChanged = errors.New("group participant identity changed")

type GroupMemberContact struct {
	ContactID    uuid.UUID
	Name         string
	AvatarURL    string
	DirectChatID *uuid.UUID
}

// Search needs the same identity projection as rendering. This is one cached
// metadata row for one account/group, not an unbounded collection response.
func (r *ChatRepository) GroupParticipantIdentitySnapshot(ctx context.Context, accountID, chatID uuid.UUID) ([]domain.GroupParticipant, error) {
	members := []domain.GroupParticipant{}
	var raw []byte
	err := r.db.QueryRow(ctx, `SELECT participants FROM chat_groups WHERE account_id=$1 AND chat_id=$2`, accountID, chatID).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return members, nil
	}
	if err != nil {
		return nil, err
	}
	if err = json.Unmarshal(raw, &members); err != nil {
		return nil, err
	}
	return members, nil
}

func (r *ChatRepository) GroupParticipant(ctx context.Context, accountID, chatID uuid.UUID, jid string) (*domain.GroupParticipant, error) {
	var raw []byte
	err := r.db.QueryRow(ctx, `SELECT member FROM chat_groups g CROSS JOIN LATERAL jsonb_array_elements(g.participants) member WHERE g.account_id=$1 AND g.chat_id=$2 AND (member->>'jid'=$3 OR member->>'lid'=$3) LIMIT 1`, accountID, chatID, jid).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var member domain.GroupParticipant
	err = json.Unmarshal(raw, &member)
	return &member, err
}

// Match once for the page, then project CRM fields only through an allowed
// Contact module or an actual private chat linked to that Contact.
func (r *ChatRepository) GroupMemberContacts(ctx context.Context, accountID uuid.UUID, members []domain.GroupParticipant, allowContacts bool) (map[int]uuid.UUID, map[uuid.UUID]GroupMemberContact, error) {
	identities := make([]domain.WhatsAppGroupReportIdentity, 0, len(members))
	for i, m := range members {
		var phone *string
		if m.Phone != "" {
			v := m.Phone
			phone = &v
		}
		identities = append(identities, domain.WhatsAppGroupReportIdentity{Ordinal: i, Phone: phone, PhoneJID: groupMemberPhoneJID(m), LID: m.LID})
	}
	matches, err := (&ReportRepository{db: r.db}).MatchWhatsAppGroupMembers(ctx, accountID, identities)
	if err != nil {
		return nil, nil, err
	}
	canonical := map[int]uuid.UUID{}
	ids := []uuid.UUID{}
	seen := map[uuid.UUID]bool{}
	for ordinal, candidates := range matches {
		if len(candidates) == 1 {
			canonical[ordinal] = candidates[0]
			if !seen[candidates[0]] {
				seen[candidates[0]] = true
				ids = append(ids, candidates[0])
			}
		}
	}
	visible := map[uuid.UUID]GroupMemberContact{}
	if len(ids) == 0 {
		return canonical, visible, nil
	}
	rows, err := r.db.Query(ctx, `SELECT c.id,COALESCE(NULLIF(BTRIM(c.custom_name),''),NULLIF(BTRIM(CONCAT_WS(' ',c.name,c.last_name)),''),NULLIF(BTRIM(c.push_name),''),NULLIF(c.phone,''),c.jid),COALESCE(c.avatar_url,''),private_chat.id
 FROM contacts c LEFT JOIN LATERAL (SELECT ch.id FROM chats ch WHERE ch.account_id=c.account_id AND ch.contact_id=c.id AND ch.channel_key='whatsapp_web' AND ch.jid NOT LIKE '%@g.us' ORDER BY ch.created_at,ch.id LIMIT 1) private_chat ON TRUE
 WHERE c.account_id=$1 AND c.id=ANY($2::uuid[]) AND c.is_group=FALSE AND ($3::bool OR private_chat.id IS NOT NULL)`, accountID, ids, allowContacts)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var item GroupMemberContact
		if err = rows.Scan(&item.ContactID, &item.Name, &item.AvatarURL, &item.DirectChatID); err != nil {
			return nil, nil, err
		}
		visible[item.ContactID] = item
	}
	return canonical, visible, rows.Err()
}

func groupMemberPhoneJID(member domain.GroupParticipant) string {
	if member.Phone != "" {
		return member.Phone + "@s.whatsapp.net"
	}
	if strings.HasSuffix(member.JID, "@s.whatsapp.net") {
		return member.JID
	}
	return ""
}

func (r *ChatRepository) GroupMemberCommonGroups(ctx context.Context, accountID, deviceID uuid.UUID, member domain.GroupParticipant, cursor string, limit int) ([]domain.GroupCommonGroup, string, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	items := []domain.GroupCommonGroup{}
	rows, err := r.db.Query(ctx, `SELECT g.chat_id,g.subject,jsonb_array_length(g.participants),g.synced_at FROM chat_groups g JOIN chats c ON c.account_id=g.account_id AND c.id=g.chat_id WHERE g.account_id=$1 AND c.device_id=$2 AND g.membership_status='member' AND ($6::text='' OR g.chat_id::text>$6) AND EXISTS (SELECT 1 FROM jsonb_array_elements(g.participants) peer WHERE peer->>'jid'=$3 OR ($4::text<>'' AND (peer->>'lid'=$4 OR peer->>'jid'=$4)) OR ($5::text<>'' AND peer->>'phone'=$5)) ORDER BY g.chat_id LIMIT $7`, accountID, deviceID, member.JID, member.LID, member.Phone, cursor, limit+1)
	if err != nil {
		return items, "", err
	}
	defer rows.Close()
	for rows.Next() {
		var item domain.GroupCommonGroup
		if err = rows.Scan(&item.ChatID, &item.Subject, &item.ParticipantCount, &item.SyncedAt); err != nil {
			return items, "", err
		}
		items = append(items, item)
	}
	next := ""
	if len(items) > limit {
		items = items[:limit]
		next = items[len(items)-1].ChatID.String()
	}
	return items, next, rows.Err()
}

type GroupParticipantChatGuard struct {
	AccountID, DeviceID, ChatID uuid.UUID
	Member                      domain.GroupParticipant
	VerifiedJID                 string
	VerifiedPhone               string
	VerifiedLID                 string
	ExpectedCanonicalContactID  *uuid.UUID
}
type groupParticipantChatGuardKey struct{}

func WithGroupParticipantChatGuard(ctx context.Context, guard GroupParticipantChatGuard) context.Context {
	return context.WithValue(ctx, groupParticipantChatGuardKey{}, guard)
}

func sameGroupMemberIdentity(a, b domain.GroupParticipant) bool {
	return a.JID == b.JID && a.LID == b.LID && a.Phone == b.Phone
}

func validateGroupParticipantChatGuard(ctx context.Context, tx pgx.Tx, accountID, deviceID uuid.UUID, jid, phone string) error {
	guard, ok := ctx.Value(groupParticipantChatGuardKey{}).(GroupParticipantChatGuard)
	if !ok {
		return nil
	}
	if guard.AccountID != accountID || guard.DeviceID != deviceID || guard.VerifiedJID != jid || guard.VerifiedPhone != phone {
		return ErrGroupMemberIdentityChanged
	}
	var raw []byte
	var membership string
	var sourceDevice *uuid.UUID
	err := tx.QueryRow(ctx, `SELECT c.device_id,g.membership_status,g.participants FROM chats c JOIN chat_groups g ON g.account_id=c.account_id AND g.chat_id=c.id WHERE c.account_id=$1 AND c.id=$2 FOR SHARE OF c,g`, accountID, guard.ChatID).Scan(&sourceDevice, &membership, &raw)
	if err != nil {
		return err
	}
	if sourceDevice == nil || *sourceDevice != deviceID || membership != "member" {
		return ErrGroupMemberIdentityChanged
	}
	var members []domain.GroupParticipant
	if err = json.Unmarshal(raw, &members); err != nil {
		return err
	}
	for _, member := range members {
		if sameGroupMemberIdentity(member, guard.Member) {
			return validateGroupParticipantCanonicalContact(ctx, tx, accountID, guard)
		}
	}
	return ErrGroupMemberIdentityChanged
}

func sameGroupCanonicalContact(a, b *uuid.UUID) bool {
	return (a == nil && b == nil) || (a != nil && b != nil && *a == *b)
}

func validateGroupParticipantCanonicalContact(ctx context.Context, tx pgx.Tx, accountID uuid.UUID, guard GroupParticipantChatGuard) error {
	if guard.VerifiedJID == "" || guard.VerifiedPhone == "" {
		return ErrGroupMemberIdentityChanged
	}
	// Lock the expected identity parent before re-matching. A Contact edit that
	// won the lock must be visible to this read; one that loses waits for commit.
	if guard.ExpectedCanonicalContactID != nil {
		var id uuid.UUID
		err := tx.QueryRow(ctx, `SELECT id FROM contacts WHERE account_id=$1 AND id=$2 AND is_group=FALSE FOR UPDATE`, accountID, *guard.ExpectedCanonicalContactID).Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrGroupMemberIdentityChanged
		}
		if err != nil {
			return err
		}
	}
	phone := guard.VerifiedPhone
	matches, err := matchWhatsAppGroupMembers(ctx, tx, accountID, []domain.WhatsAppGroupReportIdentity{{Ordinal: 0, Phone: &phone, PhoneJID: guard.VerifiedJID, LID: guard.VerifiedLID}})
	if err != nil {
		return err
	}
	var actual *uuid.UUID
	if len(matches[0]) > 1 {
		return ErrGroupMemberIdentityChanged
	}
	if len(matches[0]) == 1 {
		id := matches[0][0]
		actual = &id
	}
	if !sameGroupCanonicalContact(actual, guard.ExpectedCanonicalContactID) {
		return ErrGroupMemberIdentityChanged
	}
	return nil
}

func validateGroupParticipantContactSelection(ctx context.Context, selected, linked *uuid.UUID) error {
	guard, ok := ctx.Value(groupParticipantChatGuardKey{}).(GroupParticipantChatGuard)
	if !ok {
		return nil
	}
	if !sameGroupCanonicalContact(selected, guard.ExpectedCanonicalContactID) || (linked != nil && !sameGroupCanonicalContact(linked, guard.ExpectedCanonicalContactID)) {
		return ErrGroupMemberIdentityChanged
	}
	return nil
}

// Update only provider-owned participant projections. No Contact writes occur.
func (r *ChatRepository) UpdateGroupMemberName(ctx context.Context, accountID, deviceID uuid.UUID, jids []string, name, source string) ([]uuid.UUID, error) {
	updates := make([]domain.GroupParticipant, 0, len(jids))
	for _, jid := range jids {
		updates = append(updates, domain.GroupParticipant{JID: jid, Name: name, NameSource: source})
	}
	return r.UpdateGroupMemberNames(ctx, accountID, deviceID, updates)
}

func (r *ChatRepository) UpdateGroupMemberNames(ctx context.Context, accountID, deviceID uuid.UUID, updates []domain.GroupParticipant) ([]uuid.UUID, error) {
	ids := []uuid.UUID{}
	jids, names, sources := []string{}, []string{}, []string{}
	seen := map[string]bool{}
	for _, update := range updates {
		if strings.TrimSpace(update.Name) == "" {
			continue
		}
		for _, jid := range []string{update.JID, update.LID} {
			if jid != "" && !seen[jid] {
				seen[jid] = true
				jids = append(jids, jid)
				names = append(names, update.Name)
				sources = append(sources, update.NameSource)
			}
		}
	}
	if len(jids) == 0 {
		return ids, nil
	}
	rows, err := r.db.Query(ctx, `WITH requested AS (SELECT * FROM unnest($3::text[],$4::text[],$5::text[]) WITH ORDINALITY AS r(jid,name,source,position))
 UPDATE chat_groups g SET participants=(SELECT jsonb_agg(CASE WHEN resolved.name IS NOT NULL THEN member||jsonb_build_object('name',resolved.name,'name_source',resolved.source) ELSE member END ORDER BY ordinal) FROM jsonb_array_elements(g.participants) WITH ORDINALITY AS p(member,ordinal) LEFT JOIN LATERAL (SELECT name,source FROM requested WHERE requested.jid=member->>'jid' OR requested.jid=member->>'lid' ORDER BY position LIMIT 1) resolved ON TRUE)
 FROM chats c WHERE g.account_id=$1 AND c.account_id=g.account_id AND c.id=g.chat_id AND c.device_id=$2 AND EXISTS(SELECT 1 FROM jsonb_array_elements(g.participants) member JOIN requested ON requested.jid=member->>'jid' OR requested.jid=member->>'lid') RETURNING g.chat_id`, accountID, deviceID, jids, names, sources)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		if err = rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}
