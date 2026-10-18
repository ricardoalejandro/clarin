package repository

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"strings"
	"time"
)

func GroupChannelKey(deviceID uuid.UUID) string { return "whatsapp_web_group:" + deviceID.String() }

func (r *ChatRepository) GetOrCreateGroup(ctx context.Context, accountID, deviceID uuid.UUID, jid, subject string) (*domain.Chat, error) {
	if !domain.IsGroupJID(jid) || deviceID == uuid.Nil {
		return nil, fmt.Errorf("invalid group identity")
	}
	var id uuid.UUID
	var created bool
	err := r.db.QueryRow(ctx, `WITH contact AS (
 INSERT INTO contacts(account_id,device_id,jid,name,is_group)
 SELECT $1,$2,$3,NULLIF($4::text,''),TRUE FROM devices WHERE account_id=$1 AND id=$2 AND delete_operation_id IS NULL
 AND COALESCE(NULLIF(provider,''),'whatsapp_web')='whatsapp_web'
 ON CONFLICT(account_id,jid) DO UPDATE SET name=COALESCE(NULLIF(EXCLUDED.name,''),contacts.name),is_group=TRUE,phone=NULL
 RETURNING id,(xmax=0) AS created), chat AS (
 INSERT INTO chats(account_id,device_id,contact_id,jid,name,channel_key)
 SELECT $1,$2,id,$3,NULLIF($4::text,''),$5 FROM contact
 ON CONFLICT(account_id,channel_key,jid) DO UPDATE SET name=COALESCE(NULLIF(EXCLUDED.name,''),chats.name)
 RETURNING id) SELECT chat.id,contact.created FROM chat CROSS JOIN contact`, accountID, deviceID, jid, subject, GroupChannelKey(deviceID)).Scan(&id, &created)
	if err != nil {
		return nil, err
	}
	chat, err := r.GetByID(ctx, id)
	if chat != nil {
		chat.ContactCreated = created
	}
	return chat, err
}

func (r *ChatRepository) FindByDeviceJID(ctx context.Context, accountID, deviceID uuid.UUID, jid string) (*domain.Chat, error) {
	if !domain.IsGroupJID(jid) {
		return r.FindByJID(ctx, accountID, jid)
	}
	var id uuid.UUID
	err := r.db.QueryRow(ctx, `SELECT id FROM chats WHERE account_id=$1 AND channel_key=$2 AND jid=$3`, accountID, GroupChannelKey(deviceID), jid).Scan(&id)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return r.GetByID(ctx, id)
}

func (r *ChatRepository) GroupHidden(ctx context.Context, accountID, deviceID uuid.UUID, jid string) (bool, error) {
	var hidden bool
	err := r.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM chat_group_hidden WHERE account_id=$1 AND channel_key=$2 AND jid=$3)`, accountID, GroupChannelKey(deviceID), jid).Scan(&hidden)
	return hidden, err
}
func (r *ChatRepository) RevealGroupActivity(ctx context.Context, accountID, deviceID uuid.UUID, jid string, at time.Time) (bool, error) {
	_, err := r.db.Exec(ctx, `DELETE FROM chat_group_hidden WHERE account_id=$1 AND channel_key=$2 AND jid=$3 AND hidden_at<$4`, accountID, GroupChannelKey(deviceID), jid, at)
	if err != nil {
		return false, err
	}
	hidden, err := r.GroupHidden(ctx, accountID, deviceID, jid)
	return !hidden, err
}
func (r *ChatRepository) SaveGroup(ctx context.Context, accountID, chatID uuid.UUID, group *domain.ChatGroup, participants []domain.GroupParticipant) error {
	if participants == nil {
		participants = []domain.GroupParticipant{}
	}
	data, err := json.Marshal(participants)
	if err != nil {
		return err
	}
	_, err = r.db.Exec(ctx, `INSERT INTO chat_groups(account_id,chat_id,subject,description,membership_status,announce,is_admin,suspended,kind,participants,synced_at)
 SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,NOW() FROM chats WHERE account_id=$1 AND id=$2 AND jid LIKE '%@g.us'
 ON CONFLICT(account_id,chat_id) DO UPDATE SET subject=EXCLUDED.subject,description=EXCLUDED.description,membership_status=EXCLUDED.membership_status,
 announce=EXCLUDED.announce,is_admin=EXCLUDED.is_admin,suspended=EXCLUDED.suspended,kind=EXCLUDED.kind,participants=EXCLUDED.participants,synced_at=EXCLUDED.synced_at`, accountID, chatID, group.Subject, group.Description, group.MembershipStatus, group.Announce, group.IsAdmin, group.Suspended, group.Kind, data)
	return err
}
func (r *ChatRepository) HydrateGroups(ctx context.Context, accountID uuid.UUID, chats []*domain.Chat) error {
	ids := []uuid.UUID{}
	byID := map[uuid.UUID]*domain.Chat{}
	for _, chat := range chats {
		if chat != nil && chat.AccountID == accountID {
			setChatIdentityState(chat)
			if domain.IsGroupJID(chat.JID) {
				ids = append(ids, chat.ID)
				byID[chat.ID] = chat
				chat.Group = &domain.ChatGroup{Subject: "Grupo", MembershipStatus: "unknown", Kind: "group"}
				if chat.Name != nil {
					chat.Group.Subject = *chat.Name
				}
				chat.Group.ResolveSendCapability(false)
			}
		}
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := r.db.Query(ctx, `SELECT g.chat_id,g.subject,g.description,g.membership_status,g.announce,g.is_admin,g.suspended,g.kind,jsonb_array_length(g.participants),g.synced_at,
 COALESCE(d.status='connected' AND d.delete_operation_id IS NULL,FALSE),ct.avatar_url,latest.from_name,latest.is_from_me
 FROM chat_groups g JOIN chats c ON c.account_id=g.account_id AND c.id=g.chat_id LEFT JOIN devices d ON d.account_id=c.account_id AND d.id=c.device_id
 LEFT JOIN contacts ct ON ct.account_id=c.account_id AND ct.id=c.contact_id
 LEFT JOIN LATERAL (SELECT from_name,is_from_me FROM messages WHERE account_id=c.account_id AND chat_id=c.id ORDER BY timestamp DESC,id DESC LIMIT 1) latest ON TRUE WHERE g.account_id=$1 AND g.chat_id=ANY($2::uuid[])`, accountID, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		var connected bool
		var fromName *string
		var fromMe *bool
		g := &domain.ChatGroup{}
		if err = rows.Scan(&id, &g.Subject, &g.Description, &g.MembershipStatus, &g.Announce, &g.IsAdmin, &g.Suspended, &g.Kind, &g.ParticipantCount, &g.SyncedAt, &connected, &g.AvatarURL, &fromName, &fromMe); err != nil {
			return err
		}
		g.ResolveSendCapability(connected)
		byID[id].Group = g
		byID[id].LastMessageFromName = fromName
		byID[id].LastMessageFromMe = fromMe
	}
	return rows.Err()
}
func (r *ChatRepository) GroupParticipants(ctx context.Context, accountID, chatID uuid.UUID, search, cursor string, limit int) ([]domain.GroupParticipant, string, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	result := []domain.GroupParticipant{}
	rows, err := r.db.Query(ctx, `SELECT member::text FROM chat_groups g CROSS JOIN LATERAL jsonb_array_elements(g.participants) member
 WHERE account_id=$1 AND chat_id=$2 AND ($3::text='' OR member->>'name' ILIKE '%'||$3||'%' OR member->>'phone' ILIKE '%'||$3||'%')
 AND ($4::text='' OR member->>'jid'>$4) ORDER BY member->>'jid' LIMIT $5`, accountID, chatID, strings.TrimSpace(search), cursor, limit+1)
	if err != nil {
		return result, "", err
	}
	defer rows.Close()
	for rows.Next() {
		var raw []byte
		var member domain.GroupParticipant
		if err = rows.Scan(&raw); err != nil {
			return result, "", err
		}
		if err = json.Unmarshal(raw, &member); err != nil {
			return result, "", err
		}
		result = append(result, member)
	}
	next := ""
	if len(result) > limit {
		result = result[:limit]
		next = result[len(result)-1].JID
	}
	return result, next, rows.Err()
}
func (r *ChatRepository) MarkGroupLeft(ctx context.Context, accountID, deviceID uuid.UUID, jid string) error {
	_, err := r.db.Exec(ctx, `UPDATE chat_groups g SET membership_status='left',synced_at=NOW() FROM chats c WHERE c.account_id=$1 AND c.channel_key=$2 AND c.jid=$3 AND g.account_id=c.account_id AND g.chat_id=c.id`, accountID, GroupChannelKey(deviceID), jid)
	return err
}
func (r *MessageRepository) SaveGroupReceipt(ctx context.Context, accountID, chatID uuid.UUID, messageID, sender, status string, at time.Time) error {
	_, err := r.db.Exec(ctx, `INSERT INTO chat_group_receipts(account_id,chat_id,message_id,sender_jid,delivered_at,read_at)
 SELECT $1,$2,$3,$4,$5::timestamptz,CASE WHEN $6::text='read' THEN $5::timestamptz ELSE NULL END
 WHERE EXISTS(SELECT 1 FROM messages WHERE account_id=$1 AND chat_id=$2 AND message_id=$3 AND is_from_me)
 ON CONFLICT(account_id,chat_id,message_id,sender_jid) DO UPDATE SET delivered_at=LEAST(chat_group_receipts.delivered_at,EXCLUDED.delivered_at),read_at=LEAST(chat_group_receipts.read_at,EXCLUDED.read_at)`, accountID, chatID, messageID, sender, at, status)
	return err
}

const groupReceiptProjection = `WITH resolved AS (
 SELECT COALESCE(p.member->>'jid',r.sender_jid) jid,COALESCE(p.member->>'name','') name,r.delivered_at,r.read_at FROM chat_group_receipts r
 LEFT JOIN chat_groups g ON g.account_id=r.account_id AND g.chat_id=r.chat_id
 LEFT JOIN LATERAL (SELECT member FROM jsonb_array_elements(g.participants) member WHERE member->>'jid'=r.sender_jid OR member->>'lid'=r.sender_jid LIMIT 1) p ON TRUE
 WHERE r.account_id=$1 AND r.chat_id=$2 AND r.message_id=$3), canonical AS (SELECT jid,MAX(name) name,MIN(delivered_at) delivered_at,MIN(read_at) read_at FROM resolved GROUP BY jid) `

func (r *MessageRepository) GroupReceipts(ctx context.Context, accountID, chatID uuid.UUID, messageID, cursor string, limit int) ([]domain.GroupReceipt, string, int, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	result := []domain.GroupReceipt{}
	var total int
	if err := r.db.QueryRow(ctx, groupReceiptProjection+`SELECT COUNT(*) FROM canonical`, accountID, chatID, messageID).Scan(&total); err != nil {
		return result, "", 0, err
	}
	rows, err := r.db.Query(ctx, groupReceiptProjection+`SELECT jid,name,delivered_at,read_at FROM canonical WHERE ($4::text='' OR jid>$4) ORDER BY jid LIMIT $5`, accountID, chatID, messageID, cursor, limit+1)
	if err != nil {
		return result, "", total, err
	}
	defer rows.Close()
	for rows.Next() {
		var row domain.GroupReceipt
		if err = rows.Scan(&row.JID, &row.Name, &row.DeliveredAt, &row.ReadAt); err != nil {
			return result, "", total, err
		}
		result = append(result, row)
	}
	next := ""
	if len(result) > limit {
		result = result[:limit]
		next = result[len(result)-1].JID
	}
	return result, next, total, rows.Err()
}
func (r *MessageRepository) HydrateMentions(ctx context.Context, accountID, chatID uuid.UUID, messages []*domain.Message) error {
	ids := []uuid.UUID{}
	byID := map[uuid.UUID]*domain.Message{}
	for _, m := range messages {
		if m != nil && m.AccountID == accountID && m.ChatID == chatID {
			ids = append(ids, m.ID)
			byID[m.ID] = m
		}
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := r.db.Query(ctx, `SELECT m.id,m.group_mentions,EXISTS(SELECT 1 FROM chat_group_media_recovery r WHERE r.account_id=m.account_id AND r.message_id=m.id) AND m.media_url IS NULL AND NOT m.media_deleted AND NOT COALESCE(m.is_revoked,FALSE) FROM messages m WHERE m.account_id=$1 AND m.chat_id=$2 AND m.id=ANY($3::uuid[])`, accountID, chatID, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		var raw []byte
		var recoverable bool
		if err = rows.Scan(&id, &raw, &recoverable); err != nil {
			return err
		}
		byID[id].MediaRecoverable = recoverable
		if err = json.Unmarshal(raw, &byID[id].Mentions); err != nil {
			return err
		}
	}
	if err = rows.Err(); err != nil {
		return err
	}
	rows.Close()
	return r.hydrateGroupSenderLabels(ctx, accountID, chatID, messages)
}

// RevokeInChat preserves device-specific group histories and attention state atomically.
func (r *MessageRepository) RevokeInChat(ctx context.Context, accountID, chatID uuid.UUID, messageID string) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var id uuid.UUID
	if err = tx.QueryRow(ctx, `SELECT id FROM chats WHERE account_id=$1 AND id=$2 FOR UPDATE`, accountID, chatID).Scan(&id); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE messages SET is_revoked=TRUE,body=NULL WHERE account_id=$1 AND chat_id=$2 AND message_id=$3`, accountID, chatID, messageID); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE chats c SET unread_count=(SELECT COUNT(*) FROM messages m WHERE m.account_id=c.account_id AND m.chat_id=c.id AND NOT m.is_from_me AND NOT m.is_read AND NOT COALESCE(m.is_revoked,FALSE)),
 waiting_since=(SELECT MIN(timestamp) FROM messages m WHERE m.account_id=c.account_id AND m.chat_id=c.id AND NOT m.is_from_me AND NOT COALESCE(m.is_revoked,FALSE) AND COALESCE(m.sender->>'origin','')<>'history'
 AND (c.attention_through_at IS NULL OR (m.timestamp,m.id)>(c.attention_through_at,c.attention_through_id))),state_version=state_version+1 WHERE c.account_id=$1 AND c.id=$2`, accountID, chatID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (r *MessageRepository) EditInChat(ctx context.Context, accountID, chatID uuid.UUID, messageID, body string) error {
	_, err := r.db.Exec(ctx, `UPDATE messages SET body=$4,is_edited=TRUE,group_mentions=COALESCE($5::jsonb,group_mentions) WHERE account_id=$1 AND chat_id=$2 AND message_id=$3 AND NOT COALESCE(is_revoked,FALSE)`, accountID, chatID, messageID, body, domain.MessageMentionsFrom(ctx))
	return err
}

// Sender labels are display-only snapshots; member identities never create or mutate CRM Contacts.
func (r *MessageRepository) hydrateGroupSenderLabels(ctx context.Context, accountID, chatID uuid.UUID, messages []*domain.Message) error {
	var raw []byte
	err := r.db.QueryRow(ctx, `SELECT participants FROM chat_groups WHERE account_id=$1 AND chat_id=$2`, accountID, chatID).Scan(&raw)
	if err == pgx.ErrNoRows {
		return nil
	}
	if err != nil {
		return err
	}
	var members []domain.GroupParticipant
	if err = json.Unmarshal(raw, &members); err != nil {
		return err
	}
	names := map[string]string{}
	for _, member := range members {
		names[member.JID] = member.Name
		if member.LID != "" {
			names[member.LID] = member.Name
		}
	}
	for _, message := range messages {
		if message == nil {
			continue
		}
		for i := range message.Mentions {
			if message.Mentions[i].Name == "" {
				message.Mentions[i].Name = names[message.Mentions[i].JID]
			}
		}
		if message.FromJID != nil && (message.FromName == nil || *message.FromName == "") {
			if name := names[*message.FromJID]; name != "" {
				value := name
				message.FromName = &value
			}
		}
		if message.QuotedSender != nil {
			if name := names[*message.QuotedSender]; name != "" {
				value := name
				message.QuotedSenderName = &value
			}
		}
	}
	return nil
}

// A failed attachment becomes a durable orphan candidate. Existing admin cleanup
// still requires its age/confirmation rules and rechecks every live reference.
func (r *MessageRepository) MarkRecoveredMediaOrphan(ctx context.Context, accountID, assetID uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var key string
	if err = tx.QueryRow(ctx, `SELECT object_key FROM media_assets WHERE account_id=$1 AND id=$2 FOR UPDATE`, accountID, assetID).Scan(&key); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE media_assets SET status='orphan',updated_at=NOW() WHERE account_id=$1 AND id=$2 AND status='active' AND NOT clarin_storage_has_live_references($1,$3,$2)`, accountID, assetID, key)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *ChatRepository) ReconcileJoinedGroups(ctx context.Context, accountID, deviceID uuid.UUID, jids []string) error {
	_, err := r.db.Exec(ctx, `UPDATE chat_groups g SET membership_status='left',synced_at=NOW() FROM chats c WHERE c.account_id=$1 AND c.channel_key=$2 AND c.jid<>ALL($3::text[]) AND g.account_id=c.account_id AND g.chat_id=c.id AND g.membership_status<>'left'`, accountID, GroupChannelKey(deviceID), jids)
	return err
}
