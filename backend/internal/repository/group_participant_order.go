package repository

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

const GroupParticipantsOrderAdminsFirst = "admins_first"

var ErrGroupParticipantsCursorReset = errors.New("group participants cursor must restart")

const groupParticipantsCursorPrefix = "gp1."

type groupParticipantsCursor struct {
	Version       int       `json:"v"`
	AccountID     uuid.UUID `json:"account"`
	ChatID        uuid.UUID `json:"chat"`
	Query         string    `json:"query"`
	Order         string    `json:"order"`
	GroupRevision int64     `json:"revision"`
	Rank          int       `json:"rank"`
	JID           string    `json:"jid"`
}

func groupParticipantRoleRank(role string) int {
	if role == "admin" || role == "super_admin" {
		return 0
	}
	return 1
}

func groupParticipantsQueryHash(search string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(search)))
	return hex.EncodeToString(sum[:])
}

func decodeGroupParticipantsCursor(raw string, accountID, chatID uuid.UUID, search string) (*groupParticipantsCursor, error) {
	if raw == "" {
		return nil, nil
	}
	if len(raw) > 2048 || !strings.HasPrefix(raw, groupParticipantsCursorPrefix) {
		return nil, ErrGroupParticipantsCursorReset
	}
	data, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(raw, groupParticipantsCursorPrefix))
	if err != nil {
		return nil, ErrGroupParticipantsCursorReset
	}
	var cursor groupParticipantsCursor
	if err = json.Unmarshal(data, &cursor); err != nil || cursor.Version != 1 || cursor.AccountID != accountID || cursor.ChatID != chatID || cursor.Query != groupParticipantsQueryHash(search) || cursor.Order != GroupParticipantsOrderAdminsFirst || cursor.GroupRevision < 0 || (cursor.Rank != 0 && cursor.Rank != 1) || cursor.JID == "" || len(cursor.JID) > 256 {
		return nil, ErrGroupParticipantsCursorReset
	}
	return &cursor, nil
}

func encodeGroupParticipantsCursor(accountID, chatID uuid.UUID, search string, revision int64, member domain.GroupParticipant) string {
	data, _ := json.Marshal(groupParticipantsCursor{
		Version: 1, AccountID: accountID, ChatID: chatID,
		Query: groupParticipantsQueryHash(search), Order: GroupParticipantsOrderAdminsFirst,
		GroupRevision: revision, Rank: groupParticipantRoleRank(member.Role), JID: member.JID,
	})
	return groupParticipantsCursorPrefix + base64.RawURLEncoding.EncodeToString(data)
}

// Keep the legacy JID cursor untouched. This opt-in order uses its own keyset,
// scoped cursor and group revision, all read from one PostgreSQL snapshot.
func (r *ChatRepository) GroupParticipantsAdminFirst(ctx context.Context, accountID, chatID uuid.UUID, search, cursor string, limit int, matchingJIDs []string) ([]domain.GroupParticipant, string, error) {
	result := []domain.GroupParticipant{}
	after, err := decodeGroupParticipantsCursor(cursor, accountID, chatID, search)
	if err != nil {
		return result, "", err
	}
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	afterJID, afterRank, expectedRevision := "", 0, int64(0)
	if after != nil {
		afterJID, afterRank, expectedRevision = after.JID, after.Rank, after.GroupRevision
	}
	rows, err := r.db.Query(ctx, `WITH snapshot AS (
 SELECT g.participants,COALESCE(v.revision,0) AS revision
 FROM chat_groups g JOIN chats c ON c.account_id=g.account_id AND c.id=g.chat_id
 LEFT JOIN whatsapp_identity_group_versions v ON v.account_id=c.account_id AND v.device_id=c.device_id AND v.group_jid=c.jid
 WHERE g.account_id=$1 AND g.chat_id=$2
), page AS (
 SELECT member,CASE WHEN member->>'role' IN ('admin','super_admin') THEN 0 ELSE 1 END AS role_rank
 FROM snapshot g CROSS JOIN LATERAL jsonb_array_elements(g.participants) member
 WHERE (($6::bool AND member->>'jid'=ANY($7::text[])) OR (NOT $6::bool AND ($3::text='' OR member->>'name' ILIKE '%'||$3||'%' OR member->>'phone' ILIKE '%'||$3||'%')))
 AND (NOT $9::bool OR g.revision=$10::bigint)
 AND (NOT $9::bool OR (CASE WHEN member->>'role' IN ('admin','super_admin') THEN 0 ELSE 1 END,member->>'jid')>($8::int,$4::text))
 ORDER BY role_rank,member->>'jid' LIMIT $5
)
SELECT snapshot.revision,page.member::text FROM snapshot LEFT JOIN page ON TRUE
ORDER BY page.role_rank,page.member->>'jid'`, accountID, chatID, strings.TrimSpace(search), afterJID, limit+1, matchingJIDs != nil, matchingJIDs, afterRank, after != nil, expectedRevision)
	if err != nil {
		return result, "", err
	}
	defer rows.Close()
	var revision int64
	for rows.Next() {
		var raw *string
		if err = rows.Scan(&revision, &raw); err != nil {
			return result, "", err
		}
		if after != nil && revision != after.GroupRevision {
			return []domain.GroupParticipant{}, "", ErrGroupParticipantsCursorReset
		}
		if raw == nil {
			continue
		}
		var member domain.GroupParticipant
		if err = json.Unmarshal([]byte(*raw), &member); err != nil {
			return result, "", err
		}
		result = append(result, member)
	}
	if err = rows.Err(); err != nil {
		return result, "", err
	}
	next := ""
	if len(result) > limit {
		result = result[:limit]
		next = encodeGroupParticipantsCursor(accountID, chatID, search, revision, result[len(result)-1])
	}
	return result, next, nil
}
