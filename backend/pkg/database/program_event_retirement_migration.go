package database

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
)

const programEventRetirementLock = "program_event_retirement_v1"

type legacyProgramEventSource struct {
	ID             uuid.UUID
	AccountID      uuid.UUID
	PipelineID     *uuid.UUID
	Name           string
	Description    *string
	Status         string
	Color          string
	CreatedBy      *uuid.UUID
	TagFormula     string
	TagFormulaMode string
	TagFormulaType string
	EventDate      *time.Time
	EventEnd       *time.Time
	Location       *string
	CreatedAt      time.Time
	UpdatedAt      time.Time
	HasFolder      bool
	HasSchedule    bool
}

type legacyProgramEventActivity struct {
	Sessions          int
	Attendance        int
	Notes             int
	Interactions      int
	Tasks             int
	Courses           int
	Instructors       int
	Goals             int
	Transfers         int
	InvalidContacts   int
	InvalidStatuses   int
	InvalidStageLinks int
}

// migrateLegacyProgramEvents retires the historical event subtype from
// Programs without deleting its source data. Only rows whose contextual data
// has a lossless equivalent in Events are copied automatically. Every other
// row is retained and recorded as blocked for an explicit, auditable follow-up.
func migrateLegacyProgramEvents(ctx context.Context, db *pgxpool.Pool) error {
	for _, statement := range []string{
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_events_account_id ON events(account_id, id)`,
		`CREATE TABLE IF NOT EXISTS program_event_retirements (
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			program_id UUID NOT NULL,
			event_id UUID,
			status VARCHAR(20) NOT NULL CHECK (status IN ('migrated', 'blocked')),
			reason TEXT NOT NULL DEFAULT '',
			source_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
			migrated_participant_count INTEGER NOT NULL DEFAULT 0,
			migrated_at TIMESTAMPTZ,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			PRIMARY KEY (account_id, program_id),
			CONSTRAINT program_event_retirements_program_fkey
				FOREIGN KEY (account_id, program_id)
				REFERENCES programs(account_id, id) ON DELETE CASCADE,
			CONSTRAINT program_event_retirements_event_fkey
				FOREIGN KEY (account_id, event_id)
				REFERENCES events(account_id, id) ON DELETE SET NULL (event_id)
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_program_event_retirements_event
		 ON program_event_retirements(account_id, event_id) WHERE event_id IS NOT NULL`,
		`CREATE INDEX IF NOT EXISTS idx_program_event_retirements_status
		 ON program_event_retirements(account_id, status, updated_at DESC)`,
	} {
		if _, err := db.Exec(ctx, statement); err != nil {
			return fmt.Errorf("prepare program event retirement: %w", err)
		}
	}

	tx, err := db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin program event retirement: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1::text))`, programEventRetirementLock); err != nil {
		return fmt.Errorf("lock program event retirement: %w", err)
	}

	rows, err := tx.Query(ctx, `
		SELECT p.id
		FROM programs p
		LEFT JOIN program_event_retirements retirement
		  ON retirement.account_id=p.account_id AND retirement.program_id=p.id
		WHERE p.type='event' AND retirement.program_id IS NULL
		ORDER BY p.account_id, p.id
	`)
	if err != nil {
		return fmt.Errorf("list legacy event programs: %w", err)
	}
	var programIDs []uuid.UUID
	for rows.Next() {
		var programID uuid.UUID
		if err := rows.Scan(&programID); err != nil {
			rows.Close()
			return fmt.Errorf("scan legacy event program: %w", err)
		}
		programIDs = append(programIDs, programID)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return fmt.Errorf("iterate legacy event programs: %w", err)
	}
	rows.Close()

	for _, programID := range programIDs {
		if err := migrateLegacyProgramEvent(ctx, tx, programID); err != nil {
			return err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit program event retirement: %w", err)
	}
	return nil
}

func migrateLegacyProgramEvent(ctx context.Context, tx pgx.Tx, programID uuid.UUID) error {
	source := legacyProgramEventSource{}
	err := tx.QueryRow(ctx, `
		SELECT id, account_id, pipeline_id, name, description, status, color,
		       created_by, COALESCE(tag_formula,''), COALESCE(tag_formula_mode,'OR'),
		       COALESCE(tag_formula_type,'simple'), event_date, event_end, location,
		       created_at, updated_at, folder_id IS NOT NULL,
		       schedule_start_date IS NOT NULL OR schedule_end_date IS NOT NULL OR
		       COALESCE(cardinality(schedule_days),0) > 0 OR
		       schedule_start_time IS NOT NULL OR schedule_end_time IS NOT NULL
		FROM programs
		WHERE id=$1 AND type='event'
		FOR UPDATE
	`, programID).Scan(
		&source.ID, &source.AccountID, &source.PipelineID, &source.Name,
		&source.Description, &source.Status, &source.Color, &source.CreatedBy,
		&source.TagFormula, &source.TagFormulaMode, &source.TagFormulaType,
		&source.EventDate, &source.EventEnd, &source.Location,
		&source.CreatedAt, &source.UpdatedAt, &source.HasFolder, &source.HasSchedule,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("lock legacy event program %s: %w", programID, err)
	}

	pipelineID, err := resolveLegacyProgramEventPipeline(ctx, tx, source)
	if err != nil {
		return fmt.Errorf("resolve pipeline for legacy event program %s: %w", programID, err)
	}
	activity, err := loadLegacyProgramEventActivity(ctx, tx, source, pipelineID)
	if err != nil {
		return fmt.Errorf("inspect legacy event program %s: %w", programID, err)
	}
	reasons := legacyProgramEventBlockReasons(source, activity)
	snapshot, err := legacyProgramEventSnapshot(source, activity)
	if err != nil {
		return fmt.Errorf("snapshot legacy event program %s: %w", programID, err)
	}
	if len(reasons) > 0 {
		_, err := tx.Exec(ctx, `
			INSERT INTO program_event_retirements
			(account_id,program_id,status,reason,source_snapshot,updated_at)
			VALUES ($1,$2,'blocked',$3,$4,NOW())
			ON CONFLICT (account_id,program_id) DO UPDATE SET
				status='blocked', event_id=NULL, reason=EXCLUDED.reason,
				source_snapshot=EXCLUDED.source_snapshot, migrated_participant_count=0,
				migrated_at=NULL, updated_at=NOW()
		`, source.AccountID, source.ID, strings.Join(reasons, ","), snapshot)
		if err != nil {
			return fmt.Errorf("record blocked legacy event program %s: %w", programID, err)
		}
		return nil
	}

	eventID := uuid.New()
	eventStatus := legacyProgramEventStatus(source.Status)
	formulaMode := strings.ToUpper(strings.TrimSpace(source.TagFormulaMode))
	if formulaMode != "AND" {
		formulaMode = "OR"
	}
	formulaType := strings.ToLower(strings.TrimSpace(source.TagFormulaType))
	if formulaType != "advanced" {
		formulaType = "simple"
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO events
		(id,account_id,pipeline_id,name,description,event_date,event_end,location,status,color,
		 tag_formula_mode,tag_formula,tag_formula_type,created_by,created_at,updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
	`, eventID, source.AccountID, pipelineID, source.Name, source.Description,
		source.EventDate, source.EventEnd, source.Location, eventStatus, source.Color,
		formulaMode, source.TagFormula, formulaType, source.CreatedBy,
		source.CreatedAt, source.UpdatedAt); err != nil {
		return fmt.Errorf("create event from legacy program %s: %w", programID, err)
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO event_participants (
			id,event_id,contact_id,stage_id,name,last_name,short_name,phone,email,age,
			company,dni,birth_date,address,distrito,ocupacion,status,notes,
			auto_tag_sync,membership_state,membership_reason,membership_source,
			membership_changed_at,invited_at,confirmed_at,attended_at,created_at,updated_at
		)
		SELECT gen_random_uuid(),$1,c.id,eps.id,
		       COALESCE(NULLIF(BTRIM(c.custom_name),''),NULLIF(BTRIM(c.name),''),
		                NULLIF(BTRIM(c.push_name),''),NULLIF(BTRIM(c.phone),''),c.jid),
		       c.last_name,c.short_name,c.phone,c.email,c.age,c.company,c.dni,c.birth_date,
		       c.address,c.distrito,c.ocupacion,
		       CASE pp.status WHEN 'completed' THEN 'attended' WHEN 'dropped' THEN 'declined' ELSE 'invited' END,
		       NULLIF(CONCAT_WS(E'\n',NULLIF(BTRIM(pp.drop_reason),''),NULLIF(BTRIM(pp.drop_notes),'')),''),
		       FALSE,'active',
		       CASE WHEN pp.status='active' THEN '' ELSE 'program_participant_' || pp.status END,
		       'program_migration',COALESCE(pp.completed_at,pp.dropped_at,pp.enrolled_at),
		       pp.enrolled_at,
		       CASE WHEN pp.status='completed' THEN pp.completed_at ELSE NULL END,
		       CASE WHEN pp.status='completed' THEN pp.completed_at ELSE NULL END,
		       pp.enrolled_at,COALESCE(pp.completed_at,pp.dropped_at,pp.enrolled_at)
		FROM program_participants pp
		JOIN contacts c ON c.id=pp.contact_id AND c.account_id=$2
		LEFT JOIN event_pipeline_stages eps ON eps.id=pp.stage_id AND eps.pipeline_id=$3
		WHERE pp.program_id=$4
		ON CONFLICT (event_id,contact_id) WHERE contact_id IS NOT NULL DO NOTHING
	`, eventID, source.AccountID, pipelineID, source.ID); err != nil {
		return fmt.Errorf("copy participants from legacy event program %s: %w", programID, err)
	}

	var sourceParticipants, migratedParticipants, missingParticipants int
	if err := tx.QueryRow(ctx, `
		SELECT
			(SELECT COUNT(*) FROM program_participants WHERE program_id=$1),
			(SELECT COUNT(*) FROM event_participants WHERE event_id=$2),
			(SELECT COUNT(*)
			 FROM program_participants pp
			 WHERE pp.program_id=$1 AND NOT EXISTS (
				SELECT 1 FROM event_participants ep
				WHERE ep.event_id=$2 AND ep.contact_id=pp.contact_id
			 ))
	`, source.ID, eventID).Scan(&sourceParticipants, &migratedParticipants, &missingParticipants); err != nil {
		return fmt.Errorf("verify participants for legacy event program %s: %w", programID, err)
	}
	if sourceParticipants != migratedParticipants || missingParticipants != 0 {
		return fmt.Errorf("verify legacy event program %s: expected %d participants, copied %d, missing %d", programID, sourceParticipants, migratedParticipants, missingParticipants)
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO program_event_retirements
		(account_id,program_id,event_id,status,reason,source_snapshot,migrated_participant_count,migrated_at,updated_at)
		VALUES ($1,$2,$3,'migrated','automatic_safe_migration',$4,$5,NOW(),NOW())
	`, source.AccountID, source.ID, eventID, snapshot, migratedParticipants); err != nil {
		return fmt.Errorf("link migrated event for legacy program %s: %w", programID, err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE programs SET status='archived',updated_at=NOW()
		WHERE id=$1 AND account_id=$2 AND type='event'
	`, source.ID, source.AccountID); err != nil {
		return fmt.Errorf("archive migrated legacy event program %s: %w", programID, err)
	}
	return nil
}

func resolveLegacyProgramEventPipeline(ctx context.Context, tx pgx.Tx, source legacyProgramEventSource) (uuid.UUID, error) {
	var pipelineID uuid.UUID
	if source.PipelineID != nil {
		err := tx.QueryRow(ctx, `SELECT id FROM event_pipelines WHERE id=$1 AND account_id=$2`, *source.PipelineID, source.AccountID).Scan(&pipelineID)
		if err == nil {
			return pipelineID, nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return uuid.Nil, err
		}
	}
	err := tx.QueryRow(ctx, `
		SELECT id FROM event_pipelines
		WHERE account_id=$1
		ORDER BY is_default DESC, created_at, id
		LIMIT 1
	`, source.AccountID).Scan(&pipelineID)
	if err == nil {
		return pipelineID, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, err
	}
	if err := tx.QueryRow(ctx, `
		INSERT INTO event_pipelines (account_id,name,description,is_default)
		VALUES ($1,'Pipeline por Defecto','Pipeline por defecto para eventos',TRUE)
		RETURNING id
	`, source.AccountID).Scan(&pipelineID); err != nil {
		return uuid.Nil, err
	}
	return pipelineID, nil
}

func loadLegacyProgramEventActivity(ctx context.Context, tx pgx.Tx, source legacyProgramEventSource, pipelineID uuid.UUID) (legacyProgramEventActivity, error) {
	activity := legacyProgramEventActivity{}
	err := tx.QueryRow(ctx, `
		SELECT
			(SELECT COUNT(*) FROM program_sessions ps WHERE ps.program_id=$1),
			(SELECT COUNT(*) FROM program_attendance pa JOIN program_sessions ps ON ps.id=pa.session_id WHERE ps.program_id=$1),
			(SELECT COUNT(*) FROM program_participant_notes pn WHERE pn.program_id=$1),
			(SELECT COUNT(*) FROM interactions i WHERE i.account_id=$2 AND (
				i.program_id=$1 OR
				i.program_participant_id IN (SELECT id FROM program_participants WHERE program_id=$1) OR
				i.program_session_id IN (SELECT id FROM program_sessions WHERE program_id=$1)
			)),
			(SELECT COUNT(*) FROM tasks t WHERE t.program_id=$1),
			(SELECT COUNT(*) FROM program_courses pc WHERE pc.account_id=$2 AND pc.program_id=$1),
				(SELECT COUNT(*) FROM program_instructors pi WHERE pi.account_id=$2 AND pi.program_id=$1),
				(SELECT COUNT(*) FROM program_goals pg WHERE pg.account_id=$2 AND pg.program_id=$1),
				(SELECT COUNT(*) FROM program_participants pp
				 WHERE pp.program_id=$1 AND (COALESCE(pp.transferred_to_level,'') <> '' OR pp.transferred_at IS NOT NULL)),
				(SELECT COUNT(*)
			 FROM program_participants pp
			 LEFT JOIN contacts c ON c.id=pp.contact_id AND c.account_id=$2
			 WHERE pp.program_id=$1 AND (c.id IS NULL OR c.is_group)),
			(SELECT COUNT(*) FROM program_participants pp
			 WHERE pp.program_id=$1 AND pp.status NOT IN ('active','dropped','completed')),
			(SELECT COUNT(*) FROM program_participants pp
			 WHERE pp.program_id=$1 AND pp.stage_id IS NOT NULL AND NOT EXISTS (
				SELECT 1 FROM event_pipeline_stages eps WHERE eps.id=pp.stage_id AND eps.pipeline_id=$3
			 ))
	`, source.ID, source.AccountID, pipelineID).Scan(
		&activity.Sessions, &activity.Attendance, &activity.Notes,
		&activity.Interactions, &activity.Tasks, &activity.Courses,
		&activity.Instructors, &activity.Goals, &activity.Transfers, &activity.InvalidContacts,
		&activity.InvalidStatuses, &activity.InvalidStageLinks,
	)
	return activity, err
}

func legacyProgramEventBlockReasons(source legacyProgramEventSource, activity legacyProgramEventActivity) []string {
	reasons := make([]string, 0, 12)
	if source.Status != "active" && source.Status != "completed" && source.Status != "archived" {
		reasons = append(reasons, "unsupported_program_status")
	}
	if source.HasFolder {
		reasons = append(reasons, "program_folder")
	}
	if source.HasSchedule {
		reasons = append(reasons, "program_schedule")
	}
	if strings.EqualFold(strings.TrimSpace(source.TagFormulaType), "advanced") && strings.TrimSpace(source.TagFormula) != "" {
		// Advanced formulas were inert metadata in the retired Program subtype,
		// but become live membership rules in Events. Automatic activation would
		// therefore not be lossless and must be reviewed explicitly.
		reasons = append(reasons, "advanced_tag_formula")
	}
	checks := []struct {
		count  int
		reason string
	}{
		{activity.Sessions, "sessions"},
		{activity.Attendance, "attendance"},
		{activity.Notes, "participant_notes"},
		{activity.Interactions, "interactions"},
		{activity.Tasks, "tasks"},
		{activity.Courses, "academic_courses"},
		{activity.Instructors, "academic_instructors"},
		{activity.Goals, "program_goals"},
		{activity.Transfers, "participant_transfers"},
		{activity.InvalidContacts, "invalid_participant_contacts"},
		{activity.InvalidStatuses, "unsupported_participant_status"},
		{activity.InvalidStageLinks, "participant_stage_mismatch"},
	}
	for _, check := range checks {
		if check.count > 0 {
			reasons = append(reasons, check.reason)
		}
	}
	return reasons
}

func legacyProgramEventStatus(programStatus string) string {
	switch programStatus {
	case "completed":
		return "completed"
	case "archived":
		return "cancelled"
	default:
		return "active"
	}
}

func legacyProgramEventSnapshot(source legacyProgramEventSource, activity legacyProgramEventActivity) ([]byte, error) {
	return json.Marshal(map[string]any{
		"program_id":          source.ID,
		"name":                source.Name,
		"status":              source.Status,
		"created_at":          source.CreatedAt,
		"has_folder":          source.HasFolder,
		"has_schedule":        source.HasSchedule,
		"sessions":            activity.Sessions,
		"attendance":          activity.Attendance,
		"participant_notes":   activity.Notes,
		"interactions":        activity.Interactions,
		"tasks":               activity.Tasks,
		"courses":             activity.Courses,
		"instructors":         activity.Instructors,
		"goals":               activity.Goals,
		"transfers":           activity.Transfers,
		"invalid_contacts":    activity.InvalidContacts,
		"invalid_statuses":    activity.InvalidStatuses,
		"invalid_stage_links": activity.InvalidStageLinks,
	})
}
