package repository

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

var ErrContactObservationCursor = errors.New("invalid contact observation cursor")

type ContactObservationPage struct {
	Observations []*domain.Interaction `json:"observations"`
	NextCursor   string                `json:"next_cursor"`
	HasMore      bool                  `json:"has_more"`
}

type observationCursor struct {
	AccountID uuid.UUID  `json:"a"`
	ContactID uuid.UUID  `json:"c"`
	Scope     string     `json:"s"`
	Pinned    bool       `json:"p"`
	PinnedAt  *time.Time `json:"t"`
	CreatedAt time.Time  `json:"d"`
	ID        uuid.UUID  `json:"i"`
}

func decodeObservationCursor(value string, accountID, contactID uuid.UUID, scope string) (*observationCursor, error) {
	if value == "" {
		return nil, nil
	}
	if len(value) > 2048 {
		return nil, ErrContactObservationCursor
	}
	data, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return nil, ErrContactObservationCursor
	}
	var cursor observationCursor
	if json.Unmarshal(data, &cursor) != nil || cursor.AccountID != accountID || cursor.ContactID != contactID || cursor.Scope != scope || cursor.ID == uuid.Nil || cursor.CreatedAt.IsZero() {
		return nil, ErrContactObservationCursor
	}
	return &cursor, nil
}

func encodeObservationCursor(accountID, contactID uuid.UUID, scope string, item *domain.Interaction) string {
	data, _ := json.Marshal(observationCursor{accountID, contactID, scope, item.Type == domain.InteractionTypeNote && item.IsPinned, item.PinnedAt, item.CreatedAt, item.ID})
	return base64.RawURLEncoding.EncodeToString(data)
}

const observationMembershipSQL = `i.account_id=$1 AND (
 i.contact_id=$2 OR EXISTS(SELECT 1 FROM leads l WHERE l.account_id=$1 AND l.contact_id=$2 AND l.id=i.lead_id)
 OR EXISTS(SELECT 1 FROM event_participants ep JOIN events ev ON ev.id=ep.event_id AND ev.account_id=$1 LEFT JOIN leads l ON l.id=ep.lead_id AND l.account_id=ev.account_id WHERE COALESCE(ep.contact_id,l.contact_id)=$2 AND ep.id=i.participant_id)
 OR EXISTS(SELECT 1 FROM program_participants pp JOIN programs p ON p.id=pp.program_id AND p.account_id=$1 WHERE pp.contact_id=$2 AND pp.id=i.program_participant_id))`

const observationSelectSQL = `SELECT i.id,i.account_id,i.contact_id,i.lead_id,i.event_id,i.participant_id,
 i.program_id,i.program_session_id,i.program_participant_id,COALESCE(i.source_label,''),
 i.type,i.direction,i.outcome,i.notes,i.next_action,i.next_action_date,i.created_by,i.created_at,
 COALESCE(NULLIF(BTRIM(u.display_name),''),NULLIF(BTRIM(u.username),''),NULLIF(BTRIM(u.email),'')),
 e.name,i.updated_at,i.updated_by,
 COALESCE(NULLIF(BTRIM(editor.display_name),''),NULLIF(BTRIM(editor.username),''),NULLIF(BTRIM(editor.email),'')),
 i.is_pinned,i.pinned_at,i.pinned_by
 FROM interactions i LEFT JOIN users u ON u.id=i.created_by LEFT JOIN users editor ON editor.id=i.updated_by
 LEFT JOIN events e ON e.id=i.event_id AND e.account_id=i.account_id WHERE ` + observationMembershipSQL

func scanObservation(row pgx.Row, userID uuid.UUID, isAdmin bool) (*domain.Interaction, error) {
	item := &domain.Interaction{}
	err := row.Scan(&item.ID, &item.AccountID, &item.ContactID, &item.LeadID, &item.EventID, &item.ParticipantID,
		&item.ProgramID, &item.ProgramSessionID, &item.ProgramParticipantID, &item.SourceLabel,
		&item.Type, &item.Direction, &item.Outcome, &item.Notes, &item.NextAction, &item.NextActionDate,
		&item.CreatedBy, &item.CreatedAt, &item.CreatedByName, &item.EventName, &item.UpdatedAt, &item.UpdatedBy, &item.UpdatedByName,
		&item.IsPinned, &item.PinnedAt, &item.PinnedBy)
	if err != nil {
		return nil, err
	}
	if item.Type == domain.InteractionTypeNote {
		allowed := isAdmin || (item.CreatedBy != nil && *item.CreatedBy == userID)
		item.CanEdit, item.CanPin, item.CanDelete = allowed, allowed, allowed
	}
	return item, nil
}

func (r *ContactProfileRepository) GetObservation(ctx context.Context, accountID, contactID, observationID, userID uuid.UUID, isAdmin bool) (*domain.Interaction, error) {
	item, err := scanObservation(r.db.QueryRow(ctx, observationSelectSQL+` AND i.id=$3`, accountID, contactID, observationID), userID, isAdmin)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrContactProfileObservationMissing
	}
	return item, err
}

func (r *ContactProfileRepository) ListObservationPage(ctx context.Context, accountID, contactID, userID uuid.UUID, isAdmin bool, limit, offset int, cursorValue, scope string) (*ContactObservationPage, error) {
	cursor, err := decodeObservationCursor(cursorValue, accountID, contactID, scope)
	if err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	if offset < 0 {
		offset = 0
	}
	query := observationSelectSQL
	args := []any{accountID, contactID}
	if cursor != nil {
		query += ` AND ((i.type='note' AND i.is_pinned),COALESCE(i.pinned_at,'-infinity'::timestamptz),i.created_at,i.id) < ($3::boolean,COALESCE($4::timestamptz,'-infinity'::timestamptz),$5::timestamptz,$6::uuid)`
		args = append(args, cursor.Pinned, cursor.PinnedAt, cursor.CreatedAt, cursor.ID)
		offset = 0
	}
	query += ` ORDER BY (i.type='note' AND i.is_pinned) DESC,i.pinned_at DESC NULLS LAST,i.created_at DESC,i.id DESC`
	query += fmt.Sprintf(" LIMIT $%d OFFSET $%d", len(args)+1, len(args)+2)
	args = append(args, limit+1, offset)
	rows, err := r.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	page := &ContactObservationPage{Observations: make([]*domain.Interaction, 0, limit)}
	for rows.Next() {
		item, err := scanObservation(rows, userID, isAdmin)
		if err != nil {
			return nil, err
		}
		page.Observations = append(page.Observations, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	page.HasMore = len(page.Observations) > limit
	if page.HasMore {
		page.Observations = page.Observations[:limit]
		page.NextCursor = encodeObservationCursor(accountID, contactID, scope, page.Observations[limit-1])
	}
	return page, nil
}
