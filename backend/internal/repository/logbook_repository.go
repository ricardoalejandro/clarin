package repository

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/formula"
)

// SnapshotFilter contains optional filter parameters for logbook snapshot capture.
// When nil or all fields are zero-values, all participants are captured.
type SnapshotFilter struct {
	StageIDs        string   `json:"stage_ids"` // comma-separated UUIDs
	TagNames        []string `json:"tag_names"`
	TagMode         string   `json:"tag_mode"` // "OR" or "AND"
	ExcludeTagNames []string `json:"exclude_tag_names"`
	TagFormula      string   `json:"tag_formula"`
	HasPhone        bool     `json:"has_phone"`
	DateField       string   `json:"date_field"`
	DateFrom        string   `json:"date_from"`
	DateTo          string   `json:"date_to"`
	TextSearch      string   `json:"text_search"`
}

var snapshotDateFields = map[string]bool{
	"created_at": true, "updated_at": true, "invited_at": true,
	"confirmed_at": true, "attended_at": true,
}

type LogbookRepository struct {
	db *pgxpool.Pool
}

var (
	ErrLogbookInvalid              = errors.New("invalid logbook data")
	ErrLogbookNotesOutsideSnapshot = errors.New("logbook notes would be excluded by the snapshot")
)

// All contextual writes lock the owning event before the logbook. Lifecycle
// transitions lock that same row, so closing an event cannot race a mutation.
func lockWritableLogbookEvent(ctx context.Context, tx pgx.Tx, accountID, eventID uuid.UUID) error {
	var status string
	if err := tx.QueryRow(ctx, `SELECT status FROM events WHERE id=$1 AND account_id=$2 FOR UPDATE`, eventID, accountID).Scan(&status); err != nil {
		return err
	}
	if status == domain.EventStatusCompleted || status == domain.EventStatusCancelled {
		return ErrEventMembershipFrozen
	}
	return nil
}

func optionalLogbookScope(id uuid.UUID) interface{} {
	if id == uuid.Nil {
		return nil
	}
	return id
}

func validLogbookStatus(status string) bool {
	return status == domain.LogbookStatusPending || status == "active" || status == domain.LogbookStatusCompleted
}

// LogbookPatch distinguishes omitted fields from explicit edits. A supplied
// null saved_filter clears the filter; required date/status/text are non-null.
type LogbookPatch struct {
	Title              *string
	GeneralNotes       *string
	Date               *time.Time
	Status             *string
	SavedFilter        json.RawMessage
	SavedFilterPresent bool
}

// Create inserts a new logbook entry for an event date.
func (r *LogbookRepository) Create(ctx context.Context, lb *domain.EventLogbook) error {
	if lb.Date.IsZero() || !validLogbookStatus(lb.Status) {
		return ErrLogbookInvalid
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := lockWritableLogbookEvent(ctx, tx, lb.AccountID, lb.EventID); err != nil {
		return err
	}
	snapshotJSON, _ := json.Marshal(lb.StageSnapshot)
	var savedFilterJSON []byte
	if len(lb.SavedFilter) > 0 {
		savedFilterJSON = lb.SavedFilter
	}
	err = tx.QueryRow(ctx, `
		INSERT INTO event_logbooks (event_id, account_id, date, title, status, general_notes, stage_snapshot, total_participants, captured_at, created_by, saved_filter)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
		RETURNING id, created_at, updated_at
	`, lb.EventID, lb.AccountID, lb.Date, lb.Title, lb.Status, lb.GeneralNotes, snapshotJSON, lb.TotalParticipants, lb.CapturedAt, lb.CreatedBy, savedFilterJSON).Scan(&lb.ID, &lb.CreatedAt, &lb.UpdatedAt)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// GetByID returns a logbook with its entries populated.
func (r *LogbookRepository) GetByID(ctx context.Context, logbookID uuid.UUID) (*domain.EventLogbook, error) {
	return r.getByID(ctx, uuid.Nil, uuid.Nil, logbookID)
}

func (r *LogbookRepository) GetByIDForEvent(ctx context.Context, accountID, eventID, logbookID uuid.UUID) (*domain.EventLogbook, error) {
	if accountID == uuid.Nil || eventID == uuid.Nil {
		return nil, pgx.ErrNoRows
	}
	return r.getByID(ctx, accountID, eventID, logbookID)
}

func (r *LogbookRepository) getByID(ctx context.Context, accountID, eventID, logbookID uuid.UUID) (*domain.EventLogbook, error) {
	lb := &domain.EventLogbook{}
	var snapshotJSON []byte
	var savedFilterJSON []byte
	err := r.db.QueryRow(ctx, `
		SELECT l.id, l.event_id, l.account_id, l.date, l.title, l.status,
		       l.general_notes, l.stage_snapshot, l.total_participants,
		       l.captured_at, l.created_by, l.created_at, l.updated_at,
		       u.display_name, l.saved_filter
		FROM event_logbooks l
		JOIN events event_scope ON event_scope.id=l.event_id AND event_scope.account_id=l.account_id
		LEFT JOIN users u ON u.id = l.created_by
		WHERE l.id = $1 AND ($2::uuid IS NULL OR l.account_id=$2) AND ($3::uuid IS NULL OR l.event_id=$3)
	`, logbookID, optionalLogbookScope(accountID), optionalLogbookScope(eventID)).Scan(
		&lb.ID, &lb.EventID, &lb.AccountID, &lb.Date, &lb.Title, &lb.Status,
		&lb.GeneralNotes, &snapshotJSON, &lb.TotalParticipants,
		&lb.CapturedAt, &lb.CreatedBy, &lb.CreatedAt, &lb.UpdatedAt,
		&lb.CreatedByName, &savedFilterJSON,
	)
	if err != nil {
		return nil, err
	}
	if len(snapshotJSON) > 0 {
		_ = json.Unmarshal(snapshotJSON, &lb.StageSnapshot)
	}
	if len(savedFilterJSON) > 0 {
		lb.SavedFilter = savedFilterJSON
	}

	// Load entries
	entries, err := r.getEntries(ctx, lb.AccountID, lb.EventID, logbookID)
	if err != nil {
		return nil, err
	}
	lb.Entries = entries
	return lb, nil
}

// GetByEventID returns all logbooks for an event (without entries), ordered by date.
func (r *LogbookRepository) GetByEventID(ctx context.Context, eventID uuid.UUID) ([]*domain.EventLogbook, error) {
	return r.GetByEventIDForAccount(ctx, uuid.Nil, eventID)
}

func (r *LogbookRepository) GetByEventIDForAccount(ctx context.Context, accountID, eventID uuid.UUID) ([]*domain.EventLogbook, error) {
	rows, err := r.db.Query(ctx, `
		SELECT l.id, l.event_id, l.account_id, l.date, l.title, l.status,
		       l.general_notes, l.stage_snapshot, l.total_participants,
		       l.captured_at, l.created_by, l.created_at, l.updated_at,
		       u.display_name, l.saved_filter
		FROM event_logbooks l
		JOIN events event_scope ON event_scope.id=l.event_id AND event_scope.account_id=l.account_id
		LEFT JOIN users u ON u.id = l.created_by
		WHERE l.event_id = $1 AND ($2::uuid IS NULL OR l.account_id=$2)
		ORDER BY l.date ASC
	`, eventID, optionalLogbookScope(accountID))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var logbooks []*domain.EventLogbook
	for rows.Next() {
		lb := &domain.EventLogbook{}
		var snapshotJSON []byte
		var savedFilterJSON []byte
		if err := rows.Scan(
			&lb.ID, &lb.EventID, &lb.AccountID, &lb.Date, &lb.Title, &lb.Status,
			&lb.GeneralNotes, &snapshotJSON, &lb.TotalParticipants,
			&lb.CapturedAt, &lb.CreatedBy, &lb.CreatedAt, &lb.UpdatedAt,
			&lb.CreatedByName, &savedFilterJSON,
		); err != nil {
			return nil, err
		}
		if len(snapshotJSON) > 0 {
			_ = json.Unmarshal(snapshotJSON, &lb.StageSnapshot)
		}
		if len(savedFilterJSON) > 0 {
			lb.SavedFilter = savedFilterJSON
		}
		logbooks = append(logbooks, lb)
	}
	return logbooks, rows.Err()
}

// Update applies only supplied editable fields to the freshly locked logbook.
func (r *LogbookRepository) Update(ctx context.Context, accountID, eventID, logbookID uuid.UUID, patch LogbookPatch) (*domain.EventLogbook, error) {
	if (patch.Date != nil && patch.Date.IsZero()) || (patch.Status != nil && !validLogbookStatus(*patch.Status)) || (patch.SavedFilterPresent && patch.SavedFilter != nil && !json.Valid(patch.SavedFilter)) {
		return nil, ErrLogbookInvalid
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if err := lockWritableLogbookEvent(ctx, tx, accountID, eventID); err != nil {
		return nil, err
	}
	var lb domain.EventLogbook
	if err := tx.QueryRow(ctx, `SELECT title,general_notes,status,saved_filter,date
		FROM event_logbooks WHERE id=$1 AND account_id=$2 AND event_id=$3 FOR UPDATE`, logbookID, accountID, eventID).
		Scan(&lb.Title, &lb.GeneralNotes, &lb.Status, &lb.SavedFilter, &lb.Date); err != nil {
		return nil, err
	}
	if patch.Title != nil {
		lb.Title = *patch.Title
	}
	if patch.GeneralNotes != nil {
		lb.GeneralNotes = *patch.GeneralNotes
	}
	if patch.Status != nil {
		lb.Status = *patch.Status
	}
	if patch.Date != nil {
		lb.Date = *patch.Date
	}
	if patch.SavedFilterPresent {
		lb.SavedFilter = patch.SavedFilter
	}
	result, err := tx.Exec(ctx, `
		UPDATE event_logbooks
		SET title=$1, general_notes=$2, status=$3, saved_filter=$4, date=$5, updated_at=NOW()
		WHERE id=$6 AND account_id=$7 AND event_id=$8
	`, lb.Title, lb.GeneralNotes, lb.Status, lb.SavedFilter, lb.Date, logbookID, accountID, eventID)
	if err != nil {
		return nil, err
	}
	if result.RowsAffected() != 1 {
		return nil, pgx.ErrNoRows
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return r.GetByIDForEvent(ctx, accountID, eventID, logbookID)
}

// Delete removes a logbook and its cascade-deleted entries.
func (r *LogbookRepository) Delete(ctx context.Context, accountID, eventID, logbookID uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := lockWritableLogbookEvent(ctx, tx, accountID, eventID); err != nil {
		return err
	}
	result, err := tx.Exec(ctx, `DELETE FROM event_logbooks WHERE id=$1 AND account_id=$2 AND event_id=$3`, logbookID, accountID, eventID)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return pgx.ErrNoRows
	}
	return tx.Commit(ctx)
}

// CaptureSnapshot takes a snapshot of all participants' current state, saves entries,
// computes stage counts, and marks the logbook as completed.
// If filter is nil, captures ALL participants. Otherwise, applies the same filter logic
// used by handleGetEventParticipants.
func (r *LogbookRepository) CaptureSnapshot(ctx context.Context, accountID, eventID, logbookID uuid.UUID, filter *SnapshotFilter) (*domain.EventLogbook, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := lockWritableLogbookEvent(ctx, tx, accountID, eventID); err != nil {
		return nil, err
	}

	// Get logbook with event_id
	var lb domain.EventLogbook
	var snapshotJSON []byte
	err = tx.QueryRow(ctx, `
		SELECT id, event_id, account_id, date, title, status, general_notes,
		       stage_snapshot, total_participants, captured_at, created_by, created_at, updated_at
		FROM event_logbooks WHERE id=$1 AND account_id=$2 AND event_id=$3 FOR UPDATE
	`, logbookID, accountID, eventID).Scan(
		&lb.ID, &lb.EventID, &lb.AccountID, &lb.Date, &lb.Title, &lb.Status,
		&lb.GeneralNotes, &snapshotJSON, &lb.TotalParticipants,
		&lb.CapturedAt, &lb.CreatedBy, &lb.CreatedAt, &lb.UpdatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("get logbook: %w", err)
	}

	// Build dynamic WHERE clause for participants
	args := []interface{}{lb.EventID}
	argIdx := 2
	whereClauses := []string{"ep.event_id = $1", "ep.membership_state = 'active'"}

	if filter != nil {
		// Tag formula (advanced mode)
		if filter.TagFormula != "" {
			ast, parseErr := formula.Parse(filter.TagFormula)
			if parseErr == nil && ast != nil {
				innerSQL, innerArgs, buildErr := formula.BuildSQLForParticipants(ast, lb.EventID)
				if buildErr == nil && innerSQL != "" {
					remappedSQL := formula.RemapSQLParams(innerSQL, len(innerArgs), argIdx)
					whereClauses = append(whereClauses, fmt.Sprintf("ep.id IN (%s)", remappedSQL))
					args = append(args, innerArgs...)
					argIdx += len(innerArgs)
				}
			}
		} else if len(filter.TagNames) > 0 || len(filter.ExcludeTagNames) > 0 {
			// Simple tag mode
			tagMode := strings.ToUpper(filter.TagMode)
			if tagMode == "" {
				tagMode = "OR"
			}
			if len(filter.TagNames) > 0 {
				if tagMode == "AND" {
					whereClauses = append(whereClauses, fmt.Sprintf(
						"ep.id IN (SELECT p2.id FROM event_participants p2 JOIN contact_tags ct ON ct.contact_id = p2.contact_id JOIN tags t ON t.id = ct.tag_id WHERE p2.event_id = $1 AND t.name = ANY($%d) GROUP BY p2.id HAVING COUNT(DISTINCT t.name) = $%d)",
						argIdx, argIdx+1,
					))
					args = append(args, filter.TagNames, len(filter.TagNames))
					argIdx += 2
				} else {
					whereClauses = append(whereClauses, fmt.Sprintf(
						"ep.id IN (SELECT p2.id FROM event_participants p2 JOIN contact_tags ct ON ct.contact_id = p2.contact_id JOIN tags t ON t.id = ct.tag_id WHERE p2.event_id = $1 AND t.name = ANY($%d))",
						argIdx,
					))
					args = append(args, filter.TagNames)
					argIdx++
				}
			}
			if len(filter.ExcludeTagNames) > 0 {
				whereClauses = append(whereClauses, fmt.Sprintf(
					"ep.id NOT IN (SELECT p2.id FROM event_participants p2 JOIN contact_tags ct ON ct.contact_id = p2.contact_id JOIN tags t ON t.id = ct.tag_id WHERE p2.event_id = $1 AND t.name = ANY($%d))",
					argIdx,
				))
				args = append(args, filter.ExcludeTagNames)
				argIdx++
			}
		}

		// Has phone
		if filter.HasPhone {
			whereClauses = append(whereClauses, "ep.phone IS NOT NULL AND ep.phone != ''")
		}

		// Stage IDs
		if filter.StageIDs != "" {
			var validStageIDs []uuid.UUID
			for _, sid := range strings.Split(filter.StageIDs, ",") {
				if id, err := uuid.Parse(strings.TrimSpace(sid)); err == nil {
					validStageIDs = append(validStageIDs, id)
				}
			}
			if len(validStageIDs) > 0 {
				whereClauses = append(whereClauses, fmt.Sprintf("ep.stage_id = ANY($%d)", argIdx))
				args = append(args, validStageIDs)
				argIdx++
			}
		}

		// Date filters
		if filter.DateField != "" && snapshotDateFields[filter.DateField] {
			col := "ep." + filter.DateField
			if filter.DateFrom != "" {
				if t, err := time.Parse(time.RFC3339, filter.DateFrom); err == nil {
					whereClauses = append(whereClauses, fmt.Sprintf("%s >= $%d", col, argIdx))
					args = append(args, t)
					argIdx++
				}
			}
			if filter.DateTo != "" {
				if t, err := time.Parse(time.RFC3339, filter.DateTo); err == nil {
					whereClauses = append(whereClauses, fmt.Sprintf("%s < $%d", col, argIdx))
					args = append(args, t)
					argIdx++
				}
			}
		}

		// Text Search
		if filter.TextSearch != "" {
			term := "%" + filter.TextSearch + "%"
			whereClauses = append(whereClauses, fmt.Sprintf("(ep.name ILIKE $%d OR ep.phone ILIKE $%d OR ep.email ILIKE $%d)", argIdx, argIdx, argIdx))
			args = append(args, term)
			argIdx++
		}
	}

	whereSQL := strings.Join(whereClauses, " AND ")

	// Pre-populate stageCount with ALL pipeline stages (so stages with 0 participants appear)
	stageCount := make(map[string]map[string]interface{})
	var eventPipelineID *uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT pipeline_id FROM events WHERE id = $1`, lb.EventID).Scan(&eventPipelineID); err == nil && eventPipelineID != nil {
		stageRows, stageErr := tx.Query(ctx, `
			SELECT id, name, color FROM event_pipeline_stages
			WHERE pipeline_id = $1 ORDER BY position
		`, *eventPipelineID)
		if stageErr == nil {
			for stageRows.Next() {
				var sID uuid.UUID
				var sName, sColor string
				if err := stageRows.Scan(&sID, &sName, &sColor); err == nil {
					stageCount[sID.String()] = map[string]interface{}{
						"name":  sName,
						"color": sColor,
						"count": 0,
					}
				}
			}
			stageRows.Close()
		}
	}

	// Query participants with their stage info using dynamic WHERE
	query := fmt.Sprintf(`
		SELECT ep.id, ep.stage_id,
		       COALESCE(eps.name, ''), COALESCE(eps.color, ''),
		       COALESCE(ep.name, ''), ep.phone
		FROM event_participants ep
		LEFT JOIN event_pipeline_stages eps ON eps.id = ep.stage_id
		WHERE %s
		ORDER BY eps.position ASC NULLS LAST, ep.name ASC
	`, whereSQL)
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("query participants: %w", err)
	}
	defer rows.Close()

	type entryData struct {
		participantID uuid.UUID
		stageID       *uuid.UUID
		stageName     string
		stageColor    string
		name          string
		phone         *string
	}
	var entries []entryData

	for rows.Next() {
		var e entryData
		if err := rows.Scan(&e.participantID, &e.stageID, &e.stageName, &e.stageColor, &e.name, &e.phone); err != nil {
			return nil, fmt.Errorf("scan participant: %w", err)
		}
		entries = append(entries, e)
		// Aggregate stage counts
		key := "unassigned"
		if e.stageID != nil {
			key = e.stageID.String()
		}
		if _, ok := stageCount[key]; !ok {
			stageCount[key] = map[string]interface{}{
				"name":  e.stageName,
				"color": e.stageColor,
				"count": 0,
			}
		}
		stageCount[key]["count"] = stageCount[key]["count"].(int) + 1
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read participants: %w", err)
	}
	rows.Close()
	participantIDs := make([]uuid.UUID, 0, len(entries))
	for _, entry := range entries {
		participantIDs = append(participantIDs, entry.participantID)
	}
	// Excluding an annotated participant must never silently erase their work or
	// count them in a snapshot they no longer match. Reject the whole capture.
	var excludesNotes bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM event_logbook_entries
		WHERE logbook_id=$1 AND NOT(participant_id=ANY($2::uuid[])) AND notes<>'')`, logbookID, participantIDs).Scan(&excludesNotes); err != nil {
		return nil, err
	}
	if excludesNotes {
		return nil, ErrLogbookNotesOutsideSnapshot
	}
	if _, err := tx.Exec(ctx, `DELETE FROM event_logbook_entries WHERE logbook_id=$1 AND NOT(participant_id=ANY($2::uuid[])) AND notes=''`, logbookID, participantIDs); err != nil {
		return nil, err
	}

	// Bulk insert entries
	for _, e := range entries {
		_, err := tx.Exec(ctx, `
			INSERT INTO event_logbook_entries (logbook_id, participant_id, stage_id, stage_name, stage_color)
			VALUES ($1, $2, $3, $4, $5)
			ON CONFLICT (logbook_id, participant_id) DO UPDATE
			SET stage_id = EXCLUDED.stage_id, stage_name = EXCLUDED.stage_name, stage_color = EXCLUDED.stage_color
		`, logbookID, e.participantID, e.stageID, e.stageName, e.stageColor)
		if err != nil {
			return nil, fmt.Errorf("insert entry: %w", err)
		}
	}

	// Update logbook with snapshot
	now := time.Now()
	snapshotOut, _ := json.Marshal(stageCount)
	_, err = tx.Exec(ctx, `
		UPDATE event_logbooks
		SET status = CASE WHEN status = 'pending' THEN 'completed' ELSE status END, stage_snapshot = $1, total_participants = $2,
		    captured_at = $3, updated_at = NOW()
		WHERE id=$4 AND account_id=$5 AND event_id=$6
	`, snapshotOut, len(entries), now, logbookID, accountID, eventID)
	if err != nil {
		return nil, fmt.Errorf("update logbook: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit: %w", err)
	}

	// Return full logbook
	return r.GetByIDForEvent(ctx, accountID, eventID, logbookID)
}

// GetEntries returns all entries for a logbook with participant info.
func (r *LogbookRepository) GetEntries(ctx context.Context, logbookID uuid.UUID) ([]*domain.EventLogbookEntry, error) {
	return r.getEntries(ctx, uuid.Nil, uuid.Nil, logbookID)
}

func (r *LogbookRepository) getEntries(ctx context.Context, accountID, eventID, logbookID uuid.UUID) ([]*domain.EventLogbookEntry, error) {
	rows, err := r.db.Query(ctx, `
		SELECT e.id, e.logbook_id, e.participant_id, e.stage_id, e.stage_name,
		       e.stage_color, e.notes, e.created_at,
		       COALESCE(ep.name, ''), ep.phone
		FROM event_logbook_entries e
		JOIN event_logbooks lb ON lb.id=e.logbook_id
		JOIN events event_scope ON event_scope.id=lb.event_id AND event_scope.account_id=lb.account_id
		JOIN event_participants ep ON ep.id=e.participant_id AND ep.event_id=lb.event_id
		WHERE e.logbook_id=$1 AND ($2::uuid IS NULL OR lb.account_id=$2) AND ($3::uuid IS NULL OR lb.event_id=$3)
		ORDER BY e.stage_name ASC, ep.name ASC
	`, logbookID, optionalLogbookScope(accountID), optionalLogbookScope(eventID))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var entries []*domain.EventLogbookEntry
	for rows.Next() {
		entry := &domain.EventLogbookEntry{}
		if err := rows.Scan(
			&entry.ID, &entry.LogbookID, &entry.ParticipantID, &entry.StageID,
			&entry.StageName, &entry.StageColor, &entry.Notes, &entry.CreatedAt,
			&entry.ParticipantName, &entry.ParticipantPhone,
		); err != nil {
			return nil, err
		}
		entries = append(entries, entry)
	}
	return entries, rows.Err()
}

// UpdateEntryNotes updates the notes for a specific logbook entry.
func (r *LogbookRepository) UpdateEntryNotes(ctx context.Context, accountID, eventID, logbookID, entryID uuid.UUID, notes string) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := lockWritableLogbookEvent(ctx, tx, accountID, eventID); err != nil {
		return err
	}
	var ownedLogbook uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT id FROM event_logbooks WHERE id=$1 AND account_id=$2 AND event_id=$3 FOR UPDATE`, logbookID, accountID, eventID).Scan(&ownedLogbook); err != nil {
		return err
	}
	result, err := tx.Exec(ctx, `UPDATE event_logbook_entries entry SET notes=$1
		FROM event_logbooks lb,event_participants participant
		WHERE entry.id=$2 AND entry.logbook_id=$3 AND lb.id=entry.logbook_id
		AND lb.account_id=$4 AND lb.event_id=$5 AND participant.id=entry.participant_id AND participant.event_id=lb.event_id`, notes, entryID, logbookID, accountID, eventID)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return pgx.ErrNoRows
	}
	return tx.Commit(ctx)
}

// AutoCreateFromDateRange creates pending logbooks for each day in the event's date range.
// Skips dates that already have a logbook. Returns the list of created logbooks.
func (r *LogbookRepository) AutoCreateFromDateRange(ctx context.Context, eventID, accountID uuid.UUID, startDate, endDate time.Time, createdBy *uuid.UUID) ([]*domain.EventLogbook, error) {
	if startDate.IsZero() || endDate.Before(startDate) {
		return nil, ErrLogbookInvalid
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if err := lockWritableLogbookEvent(ctx, tx, accountID, eventID); err != nil {
		return nil, err
	}
	// Normalize to date-only
	start := time.Date(startDate.Year(), startDate.Month(), startDate.Day(), 0, 0, 0, 0, time.UTC)
	end := time.Date(endDate.Year(), endDate.Month(), endDate.Day(), 0, 0, 0, 0, time.UTC)

	var created []*domain.EventLogbook
	for d := start; !d.After(end); d = d.AddDate(0, 0, 1) {
		lb := &domain.EventLogbook{
			EventID:       eventID,
			AccountID:     accountID,
			Date:          d,
			Title:         d.Format("02/01/2006"),
			Status:        domain.LogbookStatusPending,
			CreatedBy:     createdBy,
			StageSnapshot: make(map[string]interface{}),
		}
		err := tx.QueryRow(ctx, `
			INSERT INTO event_logbooks (event_id, account_id, date, title, status, created_by)
			VALUES ($1, $2, $3, $4, $5, $6)
			ON CONFLICT (event_id, date) DO NOTHING
			RETURNING id, created_at, updated_at
		`, lb.EventID, lb.AccountID, lb.Date, lb.Title, lb.Status, lb.CreatedBy).Scan(&lb.ID, &lb.CreatedAt, &lb.UpdatedAt)
		if err != nil {
			if err == pgx.ErrNoRows {
				continue // already exists
			}
			return nil, fmt.Errorf("create logbook for %s: %w", d.Format("2006-01-02"), err)
		}
		created = append(created, lb)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return created, nil
}

// PreviewParticipants returns the participants that would match the saved filter
// for a pending logbook. This is a dynamic preview — it re-queries current participants.
func (r *LogbookRepository) PreviewParticipants(ctx context.Context, accountID, eventID, logbookID uuid.UUID) ([]map[string]interface{}, error) {
	lb, err := r.GetByIDForEvent(ctx, accountID, eventID, logbookID)
	if err != nil {
		return nil, fmt.Errorf("get logbook: %w", err)
	}

	// Parse saved filter
	var filter *SnapshotFilter
	if len(lb.SavedFilter) > 0 {
		filter = &SnapshotFilter{}
		if err := json.Unmarshal(lb.SavedFilter, filter); err != nil {
			filter = nil
		}
	}

	// Build dynamic WHERE clause (same logic as CaptureSnapshot)
	args := []interface{}{lb.EventID}
	argIdx := 2
	whereClauses := []string{"ep.event_id = $1", "ep.membership_state = 'active'"}

	if filter != nil {
		if filter.TagFormula != "" {
			ast, parseErr := formula.Parse(filter.TagFormula)
			if parseErr == nil && ast != nil {
				innerSQL, innerArgs, buildErr := formula.BuildSQLForParticipants(ast, lb.EventID)
				if buildErr == nil && innerSQL != "" {
					remappedSQL := formula.RemapSQLParams(innerSQL, len(innerArgs), argIdx)
					whereClauses = append(whereClauses, fmt.Sprintf("ep.id IN (%s)", remappedSQL))
					args = append(args, innerArgs...)
					argIdx += len(innerArgs)
				}
			}
		} else if len(filter.TagNames) > 0 || len(filter.ExcludeTagNames) > 0 {
			tagMode := strings.ToUpper(filter.TagMode)
			if tagMode == "" {
				tagMode = "OR"
			}
			if len(filter.TagNames) > 0 {
				if tagMode == "AND" {
					whereClauses = append(whereClauses, fmt.Sprintf(
						"ep.id IN (SELECT p2.id FROM event_participants p2 JOIN contact_tags ct ON ct.contact_id = p2.contact_id JOIN tags t ON t.id = ct.tag_id WHERE p2.event_id = $1 AND t.name = ANY($%d) GROUP BY p2.id HAVING COUNT(DISTINCT t.name) = $%d)",
						argIdx, argIdx+1,
					))
					args = append(args, filter.TagNames, len(filter.TagNames))
					argIdx += 2
				} else {
					whereClauses = append(whereClauses, fmt.Sprintf(
						"ep.id IN (SELECT p2.id FROM event_participants p2 JOIN contact_tags ct ON ct.contact_id = p2.contact_id JOIN tags t ON t.id = ct.tag_id WHERE p2.event_id = $1 AND t.name = ANY($%d))",
						argIdx,
					))
					args = append(args, filter.TagNames)
					argIdx++
				}
			}
			if len(filter.ExcludeTagNames) > 0 {
				whereClauses = append(whereClauses, fmt.Sprintf(
					"ep.id NOT IN (SELECT p2.id FROM event_participants p2 JOIN contact_tags ct ON ct.contact_id = p2.contact_id JOIN tags t ON t.id = ct.tag_id WHERE p2.event_id = $1 AND t.name = ANY($%d))",
					argIdx,
				))
				args = append(args, filter.ExcludeTagNames)
				argIdx++
			}
		}

		if filter.HasPhone {
			whereClauses = append(whereClauses, "ep.phone IS NOT NULL AND ep.phone != ''")
		}

		if filter.StageIDs != "" {
			var validStageIDs []uuid.UUID
			for _, sid := range strings.Split(filter.StageIDs, ",") {
				if id, err := uuid.Parse(strings.TrimSpace(sid)); err == nil {
					validStageIDs = append(validStageIDs, id)
				}
			}
			if len(validStageIDs) > 0 {
				whereClauses = append(whereClauses, fmt.Sprintf("ep.stage_id = ANY($%d)", argIdx))
				args = append(args, validStageIDs)
				argIdx++
			}
		}

		if filter.DateField != "" && snapshotDateFields[filter.DateField] {
			col := "ep." + filter.DateField
			if filter.DateFrom != "" {
				if t, err := time.Parse(time.RFC3339, filter.DateFrom); err == nil {
					whereClauses = append(whereClauses, fmt.Sprintf("%s >= $%d", col, argIdx))
					args = append(args, t)
					argIdx++
				}
			}
			if filter.DateTo != "" {
				if t, err := time.Parse(time.RFC3339, filter.DateTo); err == nil {
					whereClauses = append(whereClauses, fmt.Sprintf("%s < $%d", col, argIdx))
					args = append(args, t)
					argIdx++
				}
			}
		}
	}

	whereSQL := strings.Join(whereClauses, " AND ")

	query := fmt.Sprintf(`
		SELECT ep.id, COALESCE(ep.name, ''), ep.phone,
		       COALESCE(eps.name, ''), COALESCE(eps.color, ''),
		       ep.stage_id
		FROM event_participants ep
		LEFT JOIN event_pipeline_stages eps ON eps.id = ep.stage_id
		WHERE %s
		ORDER BY eps.position ASC NULLS LAST, ep.name ASC
	`, whereSQL)

	rows, err := r.db.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("query preview participants: %w", err)
	}
	defer rows.Close()

	var results []map[string]interface{}
	for rows.Next() {
		var id uuid.UUID
		var name string
		var phone *string
		var stageName, stageColor string
		var stageID *uuid.UUID
		if err := rows.Scan(&id, &name, &phone, &stageName, &stageColor, &stageID); err != nil {
			return nil, fmt.Errorf("scan preview participant: %w", err)
		}
		entry := map[string]interface{}{
			"id":          id,
			"name":        name,
			"phone":       phone,
			"stage_name":  stageName,
			"stage_color": stageColor,
			"stage_id":    stageID,
		}
		results = append(results, entry)
	}
	return results, rows.Err()
}
