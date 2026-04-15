package repository

import (
	"context"
	"encoding/json"
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
	StageIDs        string   `json:"stage_ids"`         // comma-separated UUIDs
	TagNames        []string `json:"tag_names"`
	TagMode         string   `json:"tag_mode"`          // "OR" or "AND"
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

// Create inserts a new logbook entry for an event date.
func (r *LogbookRepository) Create(ctx context.Context, lb *domain.EventLogbook) error {
	snapshotJSON, _ := json.Marshal(lb.StageSnapshot)
	var savedFilterJSON []byte
	if len(lb.SavedFilter) > 0 {
		savedFilterJSON = lb.SavedFilter
	}
	return r.db.QueryRow(ctx, `
		INSERT INTO event_logbooks (event_id, account_id, date, title, status, general_notes, stage_snapshot, total_participants, captured_at, created_by, saved_filter)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
		RETURNING id, created_at, updated_at
	`, lb.EventID, lb.AccountID, lb.Date, lb.Title, lb.Status, lb.GeneralNotes, snapshotJSON, lb.TotalParticipants, lb.CapturedAt, lb.CreatedBy, savedFilterJSON).Scan(&lb.ID, &lb.CreatedAt, &lb.UpdatedAt)
}

// GetByID returns a logbook with its entries populated.
func (r *LogbookRepository) GetByID(ctx context.Context, logbookID uuid.UUID) (*domain.EventLogbook, error) {
	lb := &domain.EventLogbook{}
	var snapshotJSON []byte
	var savedFilterJSON []byte
	err := r.db.QueryRow(ctx, `
		SELECT l.id, l.event_id, l.account_id, l.date, l.title, l.status,
		       l.general_notes, l.stage_snapshot, l.total_participants,
		       l.captured_at, l.created_by, l.created_at, l.updated_at,
		       u.display_name, l.saved_filter
		FROM event_logbooks l
		LEFT JOIN users u ON u.id = l.created_by
		WHERE l.id = $1
	`, logbookID).Scan(
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
	entries, err := r.GetEntries(ctx, logbookID)
	if err != nil {
		return nil, err
	}
	lb.Entries = entries
	return lb, nil
}

// GetByEventID returns all logbooks for an event (without entries), ordered by date.
func (r *LogbookRepository) GetByEventID(ctx context.Context, eventID uuid.UUID) ([]*domain.EventLogbook, error) {
	rows, err := r.db.Query(ctx, `
		SELECT l.id, l.event_id, l.account_id, l.date, l.title, l.status,
		       l.general_notes, l.stage_snapshot, l.total_participants,
		       l.captured_at, l.created_by, l.created_at, l.updated_at,
		       u.display_name, l.saved_filter
		FROM event_logbooks l
		LEFT JOIN users u ON u.id = l.created_by
		WHERE l.event_id = $1
		ORDER BY l.date ASC
	`, eventID)
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
	return logbooks, nil
}

// Update updates a logbook's editable fields.
func (r *LogbookRepository) Update(ctx context.Context, lb *domain.EventLogbook) error {
	snapshotJSON, _ := json.Marshal(lb.StageSnapshot)
	_, err := r.db.Exec(ctx, `
		UPDATE event_logbooks
		SET title = $1, general_notes = $2, stage_snapshot = $3,
		    total_participants = $4, status = $5, captured_at = $6, saved_filter = $7, updated_at = NOW()
		WHERE id = $8
	`, lb.Title, lb.GeneralNotes, snapshotJSON, lb.TotalParticipants, lb.Status, lb.CapturedAt, lb.SavedFilter, lb.ID)
	return err
}

// Delete removes a logbook and its cascade-deleted entries.
func (r *LogbookRepository) Delete(ctx context.Context, logbookID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `DELETE FROM event_logbooks WHERE id = $1`, logbookID)
	return err
}

// CaptureSnapshot takes a snapshot of all participants' current state, saves entries,
// computes stage counts, and marks the logbook as completed.
// If filter is nil, captures ALL participants. Otherwise, applies the same filter logic
// used by handleGetEventParticipants.
func (r *LogbookRepository) CaptureSnapshot(ctx context.Context, logbookID uuid.UUID, filter *SnapshotFilter) (*domain.EventLogbook, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	// Get logbook with event_id
	var lb domain.EventLogbook
	var snapshotJSON []byte
	err = tx.QueryRow(ctx, `
		SELECT id, event_id, account_id, date, title, status, general_notes,
		       stage_snapshot, total_participants, captured_at, created_by, created_at, updated_at
		FROM event_logbooks WHERE id = $1 FOR UPDATE
	`, logbookID).Scan(
		&lb.ID, &lb.EventID, &lb.AccountID, &lb.Date, &lb.Title, &lb.Status,
		&lb.GeneralNotes, &snapshotJSON, &lb.TotalParticipants,
		&lb.CapturedAt, &lb.CreatedBy, &lb.CreatedAt, &lb.UpdatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("get logbook: %w", err)
	}

	// Delete existing entries (re-capture support)
	_, _ = tx.Exec(ctx, `DELETE FROM event_logbook_entries WHERE logbook_id = $1`, logbookID)

	// Build dynamic WHERE clause for participants
	args := []interface{}{lb.EventID}
	argIdx := 2
	whereClauses := []string{"ep.event_id = $1"}

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
		WHERE id = $4
	`, snapshotOut, len(entries), now, logbookID)
	if err != nil {
		return nil, fmt.Errorf("update logbook: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit: %w", err)
	}

	// Return full logbook
	return r.GetByID(ctx, logbookID)
}

// GetEntries returns all entries for a logbook with participant info.
func (r *LogbookRepository) GetEntries(ctx context.Context, logbookID uuid.UUID) ([]*domain.EventLogbookEntry, error) {
	rows, err := r.db.Query(ctx, `
		SELECT e.id, e.logbook_id, e.participant_id, e.stage_id, e.stage_name,
		       e.stage_color, e.notes, e.created_at,
		       COALESCE(ep.name, ''), ep.phone
		FROM event_logbook_entries e
		JOIN event_participants ep ON ep.id = e.participant_id
		WHERE e.logbook_id = $1
		ORDER BY e.stage_name ASC, ep.name ASC
	`, logbookID)
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
	return entries, nil
}

// UpdateEntryNotes updates the notes for a specific logbook entry.
func (r *LogbookRepository) UpdateEntryNotes(ctx context.Context, entryID uuid.UUID, notes string) error {
	_, err := r.db.Exec(ctx, `UPDATE event_logbook_entries SET notes = $1 WHERE id = $2`, notes, entryID)
	return err
}

// AutoCreateFromDateRange creates pending logbooks for each day in the event's date range.
// Skips dates that already have a logbook. Returns the list of created logbooks.
func (r *LogbookRepository) AutoCreateFromDateRange(ctx context.Context, eventID, accountID uuid.UUID, startDate, endDate time.Time, createdBy *uuid.UUID) ([]*domain.EventLogbook, error) {
	// Normalize to date-only
	start := time.Date(startDate.Year(), startDate.Month(), startDate.Day(), 0, 0, 0, 0, time.UTC)
	end := time.Date(endDate.Year(), endDate.Month(), endDate.Day(), 0, 0, 0, 0, time.UTC)

	var created []*domain.EventLogbook
	for d := start; !d.After(end); d = d.AddDate(0, 0, 1) {
		lb := &domain.EventLogbook{
			EventID:   eventID,
			AccountID: accountID,
			Date:      d,
			Title:     d.Format("02/01/2006"),
			Status:    domain.LogbookStatusPending,
			CreatedBy: createdBy,
			StageSnapshot: make(map[string]interface{}),
		}
		err := r.db.QueryRow(ctx, `
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
	return created, nil
}

// PreviewParticipants returns the participants that would match the saved filter
// for a pending logbook. This is a dynamic preview — it re-queries current participants.
func (r *LogbookRepository) PreviewParticipants(ctx context.Context, logbookID uuid.UUID) ([]map[string]interface{}, error) {
	lb, err := r.GetByID(ctx, logbookID)
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
	whereClauses := []string{"ep.event_id = $1"}

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
	return results, nil
}
