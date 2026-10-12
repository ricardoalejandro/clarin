package repository

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
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
	ExpectedVersion    int64
	ActorID            *uuid.UUID
	Title              *string
	GeneralNotes       *string
	Date               *time.Time
	Status             *string
	SavedFilter        json.RawMessage
	SavedFilterPresent bool
}

// Create inserts a new logbook entry for an event date.
func (r *LogbookRepository) Create(ctx context.Context, lb *domain.EventLogbook) error {
	return r.CreateWithCapture(ctx, lb, false)
}
func (r *LogbookRepository) CreateWithCapture(ctx context.Context, lb *domain.EventLogbook, capture bool) error {
	if lb.Date.IsZero() || lb.Status != domain.LogbookStatusPending {
		return ErrLogbookInvalid
	}
	filter, err := savedSnapshotFilter(lb.SavedFilter)
	if err != nil {
		return err
	}
	if _, _, err = snapshotPredicate(lb.EventID, filter); err != nil {
		return err
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = lockWritableLogbookEvent(ctx, tx, lb.AccountID, lb.EventID); err != nil {
		return err
	}
	err = tx.QueryRow(ctx, `INSERT INTO event_logbooks(event_id,account_id,date,title,status,general_notes,created_by,saved_filter) VALUES($1,$2,$3,$4,'pending',$5,$6,$7) RETURNING id,created_at,updated_at,version`, lb.EventID, lb.AccountID, lb.Date, lb.Title, lb.GeneralNotes, lb.CreatedBy, lb.SavedFilter).Scan(&lb.ID, &lb.CreatedAt, &lb.UpdatedAt, &lb.Version)
	if err != nil {
		return err
	}
	if err = recordLogbookAction(ctx, tx, lb.AccountID, lb.EventID, lb.ID, "created", lb.CreatedBy); err != nil {
		return err
	}
	if capture {
		if err = r.captureSnapshotTx(ctx, tx, lb.AccountID, lb.EventID, lb.ID, filter, LogbookWriteOptions{ActorID: lb.CreatedBy}); err != nil {
			return err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	canonical, err := r.GetByIDForEvent(ctx, lb.AccountID, lb.EventID, lb.ID)
	if err == nil {
		*lb = *canonical
	}
	return err
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
		       u.display_name, l.saved_filter, l.version, l.captured_by, l.completed_at, l.completed_by,l.captured_filter
		FROM event_logbooks l
		JOIN events event_scope ON event_scope.id=l.event_id AND event_scope.account_id=l.account_id
		LEFT JOIN users u ON u.id = l.created_by
		WHERE l.id = $1 AND ($2::uuid IS NULL OR l.account_id=$2) AND ($3::uuid IS NULL OR l.event_id=$3)
	`, logbookID, optionalLogbookScope(accountID), optionalLogbookScope(eventID)).Scan(
		&lb.ID, &lb.EventID, &lb.AccountID, &lb.Date, &lb.Title, &lb.Status,
		&lb.GeneralNotes, &snapshotJSON, &lb.TotalParticipants,
		&lb.CapturedAt, &lb.CreatedBy, &lb.CreatedAt, &lb.UpdatedAt,
		&lb.CreatedByName, &savedFilterJSON, &lb.Version, &lb.CapturedBy, &lb.CompletedAt, &lb.CompletedBy, &lb.CapturedFilter,
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

	// Detail is deliberately bounded. Dedicated entry/export paths own pagination.
	page, err := r.EntriesPage(ctx, lb.AccountID, lb.EventID, logbookID, LogbookPageOptions{})
	if err != nil {
		return nil, err
	}
	lb.Entries = page.Items
	lb.EntriesNextCursor = page.NextCursor

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
		       u.display_name, l.saved_filter, l.version, l.captured_by, l.completed_at, l.completed_by,l.captured_filter
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
			&lb.CreatedByName, &savedFilterJSON, &lb.Version, &lb.CapturedBy, &lb.CompletedAt, &lb.CompletedBy, &lb.CapturedFilter,
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
	if patch.Status != nil {
		return nil, ErrLogbookTransition
	}
	if patch.SavedFilterPresent {
		filter, err := savedSnapshotFilter(patch.SavedFilter)
		if err != nil {
			return nil, err
		}
		if _, _, err = snapshotPredicate(eventID, filter); err != nil {
			return nil, err
		}
	}
	if (patch.Date != nil && patch.Date.IsZero()) || (patch.Status != nil && !validLogbookStatus(*patch.Status)) || (patch.SavedFilterPresent && patch.SavedFilter != nil && !json.Valid(patch.SavedFilter)) {
		return nil, ErrLogbookInvalid
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, _, err := lockLogbook(ctx, tx, accountID, eventID, logbookID, patch.ExpectedVersion, false); err != nil {
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
		SET title=$1, general_notes=$2, status=$3, saved_filter=$4, date=$5, version=version+1, updated_at=NOW()
		WHERE id=$6 AND account_id=$7 AND event_id=$8
	`, lb.Title, lb.GeneralNotes, lb.Status, lb.SavedFilter, lb.Date, logbookID, accountID, eventID)
	if err != nil {
		return nil, err
	}
	if result.RowsAffected() != 1 {
		return nil, pgx.ErrNoRows
	}
	if err := recordLogbookAction(ctx, tx, accountID, eventID, logbookID, "updated", patch.ActorID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return r.GetByIDForEvent(ctx, accountID, eventID, logbookID)
}

// Delete removes a logbook and its cascade-deleted entries.
func (r *LogbookRepository) Delete(ctx context.Context, accountID, eventID, logbookID uuid.UUID, options ...LogbookWriteOptions) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, _, err := lockLogbook(ctx, tx, accountID, eventID, logbookID, logbookWriteOption(options).ExpectedVersion, false); err != nil {
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
// computes stage counts and opens the logbook for review. A nil filter uses the
// saved selection; an explicit empty filter captures all active participants.
func captureStageKey(id *uuid.UUID) string {
	if id == nil {
		return "unassigned"
	}
	return id.String()
}
func (r *LogbookRepository) CaptureSnapshot(ctx context.Context, accountID, eventID, logbookID uuid.UUID, filter *SnapshotFilter, options ...LogbookWriteOptions) (*domain.EventLogbook, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if err = r.captureSnapshotTx(ctx, tx, accountID, eventID, logbookID, filter, logbookWriteOption(options)); err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return r.GetByIDForEvent(ctx, accountID, eventID, logbookID)
}
func (r *LogbookRepository) captureSnapshotTx(ctx context.Context, tx pgx.Tx, accountID, eventID, logbookID uuid.UUID, filter *SnapshotFilter, options LogbookWriteOptions) error {
	var lb domain.EventLogbook
	lb.ID, lb.EventID, lb.AccountID = logbookID, eventID, accountID
	if _, _, err := lockLogbook(ctx, tx, accountID, eventID, logbookID, options.ExpectedVersion, false); err != nil {
		return err
	}
	// Read the saved audience under the same lock as the capture.
	if filter == nil {
		var raw []byte
		if err := tx.QueryRow(ctx, `SELECT saved_filter FROM event_logbooks WHERE id=$1 AND account_id=$2`, logbookID, accountID).Scan(&raw); err != nil {
			return err
		}
		var err error
		filter, err = savedSnapshotFilter(raw)
		if err != nil {
			return err
		}
	}
	if filter == nil {
		filter = &SnapshotFilter{}
	}
	whereSQL, args, err := snapshotPredicate(eventID, filter)
	if err != nil {
		return err
	}
	// Pre-populate stageCount with ALL pipeline stages (so stages with 0 participants appear)
	stageCount := make(map[string]map[string]interface{})
	var eventPipelineID *uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT pipeline_id FROM events WHERE id=$1 AND account_id=$2`, eventID, accountID).Scan(&eventPipelineID); err != nil {
		return err
	}
	if eventPipelineID != nil {
		stageRows, err := tx.Query(ctx, `SELECT s.id,s.name,s.color,s.position FROM event_pipeline_stages s JOIN event_pipelines p ON p.id=s.pipeline_id WHERE s.pipeline_id=$1 AND p.account_id=$2 ORDER BY s.position`, *eventPipelineID, accountID)
		if err != nil {
			return err
		}
		for stageRows.Next() {
			var id uuid.UUID
			var name, color string
			var position int
			if err := stageRows.Scan(&id, &name, &color, &position); err != nil {
				stageRows.Close()
				return err
			}
			stageCount[id.String()] = map[string]interface{}{"name": name, "color": color, "position": position, "count": 0}
		}
		err = stageRows.Err()
		stageRows.Close()
		if err != nil {
			return err
		}
	}

	// Query participants with their stage info using dynamic WHERE
	query := fmt.Sprintf(`SELECT ep.id,ep.stage_id,COALESCE(eps.name,''),COALESCE(eps.color,''),%s,%s,eps.position`+logbookParticipantFrom+` WHERE %s ORDER BY eps.position ASC NULLS LAST,ep.id`, logbookNameSQL, logbookPhoneSQL, whereSQL)

	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return fmt.Errorf("query participants: %w", err)
	}
	defer rows.Close()

	type entryData struct {
		participantID uuid.UUID
		stageID       *uuid.UUID
		stageName     string
		stageColor    string
		name          string
		phone         *string
		position      *int
	}
	var entries []entryData

	for rows.Next() {
		var e entryData
		if err := rows.Scan(&e.participantID, &e.stageID, &e.stageName, &e.stageColor, &e.name, &e.phone, &e.position); err != nil {
			return fmt.Errorf("scan participant: %w", err)
		}
		entries = append(entries, e)
		// Aggregate stage counts
		key := "unassigned"
		if e.stageID != nil {
			key = e.stageID.String()
		}
		if _, ok := stageCount[key]; !ok {
			stageCount[key] = map[string]interface{}{
				"name":     e.stageName,
				"position": e.position,
				"color":    e.stageColor,
				"count":    0,
			}
		}
		stageCount[key]["count"] = stageCount[key]["count"].(int) + 1
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("read participants: %w", err)
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
		return err
	}
	if excludesNotes {
		return ErrLogbookNotesOutsideSnapshot
	}
	if _, err := tx.Exec(ctx, `DELETE FROM event_logbook_entries WHERE logbook_id=$1 AND NOT(participant_id=ANY($2::uuid[])) AND notes=''`, logbookID, participantIDs); err != nil {
		return err
	}

	// Batch upserts preserve note/entry identity without one query per participant.
	for offset := 0; offset < len(entries); offset += 500 {
		end := offset + 500
		if end > len(entries) {
			end = len(entries)
		}
		ids := []uuid.UUID{}
		stageIDs := []string{}
		names := []string{}
		colors := []string{}
		keys := []string{}
		positions := []int32{}
		for _, entry := range entries[offset:end] {
			ids = append(ids, entry.participantID)
			sid := ""
			if entry.stageID != nil {
				sid = entry.stageID.String()
			}
			stageIDs = append(stageIDs, sid)
			names = append(names, entry.stageName)
			colors = append(colors, entry.stageColor)
			keys = append(keys, captureStageKey(entry.stageID))
			pos := int32(-1)
			if entry.position != nil {
				pos = int32(*entry.position)
			}
			positions = append(positions, pos)
		}
		_, err := tx.Exec(ctx, `INSERT INTO event_logbook_entries(logbook_id,participant_id,stage_id,stage_name,stage_color,capture_stage_key,stage_position)
  SELECT $1,pid,NULLIF(sid,'')::uuid,name,color,key,NULLIF(position,-1) FROM unnest($2::uuid[],$3::text[],$4::text[],$5::text[],$6::text[],$7::int[]) AS x(pid,sid,name,color,key,position)
  ON CONFLICT(logbook_id,participant_id) DO UPDATE SET stage_id=EXCLUDED.stage_id,stage_name=EXCLUDED.stage_name,stage_color=EXCLUDED.stage_color,capture_stage_key=EXCLUDED.capture_stage_key,stage_position=EXCLUDED.stage_position`, logbookID, ids, stageIDs, names, colors, keys, positions)
		if err != nil {
			return fmt.Errorf("upsert capture batch: %w", err)
		}
	}

	// Update logbook with snapshot
	now := time.Now()
	snapshotOut, _ := json.Marshal(stageCount)
	filterJSON, _ := json.Marshal(filter)
	_, err = tx.Exec(ctx, `
		UPDATE event_logbooks
		SET status = 'active', stage_snapshot = $1, total_participants = $2,
		    captured_at = $3, captured_by=$7, saved_filter=$8,captured_filter=$8,version=version+1,updated_at = NOW()
		WHERE id=$4 AND account_id=$5 AND event_id=$6
	`, snapshotOut, len(entries), now, logbookID, accountID, eventID, options.ActorID, filterJSON)
	if err != nil {
		return fmt.Errorf("update logbook: %w", err)
	}

	return recordLogbookAction(ctx, tx, accountID, eventID, logbookID, "captured", options.ActorID)
}

// GetEntries returns all entries for a logbook with participant info.
func (r *LogbookRepository) GetEntries(ctx context.Context, logbookID uuid.UUID) ([]*domain.EventLogbookEntry, error) {
	return r.getEntries(ctx, uuid.Nil, uuid.Nil, logbookID)
}

func (r *LogbookRepository) getEntries(ctx context.Context, accountID, eventID, logbookID uuid.UUID) ([]*domain.EventLogbookEntry, error) {
	rows, err := r.db.Query(ctx, logbookEntrySelect+` WHERE e.logbook_id=$1 AND ($2::uuid IS NULL OR lb.account_id=$2) AND ($3::uuid IS NULL OR lb.event_id=$3) ORDER BY COALESCE(e.stage_position,2147483647),e.capture_stage_key,e.id`, logbookID, optionalLogbookScope(accountID), optionalLogbookScope(eventID))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*domain.EventLogbookEntry{}
	for rows.Next() {
		e, err := scanLogbookEntry(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// UpdateEntryNotes updates the notes for a specific logbook entry.
func (r *LogbookRepository) UpdateEntryNotes(ctx context.Context, accountID, eventID, logbookID, entryID uuid.UUID, notes string, options ...LogbookWriteOptions) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	option := logbookWriteOption(options)
	if _, _, err := lockLogbook(ctx, tx, accountID, eventID, logbookID, option.ExpectedVersion, false); err != nil {
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
	if _, err = tx.Exec(ctx, `UPDATE event_logbooks SET version=version+1,updated_at=NOW() WHERE id=$1 AND account_id=$2 AND event_id=$3`, logbookID, accountID, eventID); err != nil {
		return err
	}
	if err = recordLogbookAction(ctx, tx, accountID, eventID, logbookID, "entry_updated", option.ActorID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// AutoCreateFromDateRange creates pending logbooks for each day in the event's date range.
// Skips dates that already have a logbook. Returns the list of created logbooks.
func (r *LogbookRepository) AutoCreateFromDateRange(ctx context.Context, eventID, accountID uuid.UUID, startDate, endDate time.Time, createdBy *uuid.UUID) ([]*domain.EventLogbook, error) {
	if startDate.IsZero() || endDate.Before(startDate) || endDate.Sub(startDate) > 366*24*time.Hour {
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
			RETURNING id, created_at, updated_at,version
		`, lb.EventID, lb.AccountID, lb.Date, lb.Title, lb.Status, lb.CreatedBy).Scan(&lb.ID, &lb.CreatedAt, &lb.UpdatedAt, &lb.Version)
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
	page, err := r.PreviewPage(ctx, accountID, eventID, logbookID, LogbookPageOptions{})
	if err != nil {
		return nil, err
	}
	out := []map[string]interface{}{}
	for _, e := range page.Items {
		out = append(out, map[string]interface{}{"id": e.ParticipantID, "name": e.ParticipantName, "phone": e.ParticipantPhone, "stage_id": e.StageID, "stage_name": e.StageName, "stage_color": e.StageColor})
	}
	return out, nil
}
