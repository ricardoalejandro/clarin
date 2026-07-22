package repository

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
)

type ProgramRepository struct {
	db *pgxpool.Pool
}

type ProgramParticipantBulkResult struct {
	Requested      int `json:"requested"`
	Created        int `json:"created"`
	AlreadyPresent int `json:"already_present"`
	Rejected       int `json:"rejected"`
}

var (
	ErrProgramParticipantEnrollmentAfterEnd  = errors.New("program participant enrollment date is after participation end")
	ErrProgramParticipantAlreadyExists       = errors.New("program participant already exists")
	ErrProgramParticipantHasActivity         = errors.New("program participant has activity")
	ErrProgramParticipantOutsideWindow       = errors.New("program participant is outside the session participation window")
	ErrProgramParticipantAlreadyEnded        = errors.New("program participant already ended")
	ErrProgramParticipantEndBeforeEnrollment = errors.New("program participant end date is before enrollment")
	ErrProgramParticipantStageInvalid        = errors.New("program participant stage does not belong to the program pipeline and account")
)

// --- Programs ---

func (r *ProgramRepository) Create(ctx context.Context, p *domain.Program) error {
	if p.Type == "" {
		p.Type = "course"
	}
	if p.Type == "event" {
		if p.TagFormulaMode == "" {
			p.TagFormulaMode = "OR"
		}
		if p.TagFormulaType == "" {
			p.TagFormulaType = "simple"
		}
	} else {
		clearProgramEventFields(p)
	}
	err := r.db.QueryRow(ctx, `
INSERT INTO programs (account_id, type, name, description, status, color, created_by, folder_id,
schedule_start_date, schedule_end_date, schedule_days, schedule_start_time, schedule_end_time,
pipeline_id, tag_formula, tag_formula_mode, tag_formula_type, event_date, event_end, location)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
RETURNING id, created_at, updated_at
`, p.AccountID, p.Type, p.Name, p.Description, p.Status, p.Color, p.CreatedBy, p.FolderID,
		p.ScheduleStartDate, p.ScheduleEndDate, p.ScheduleDays, p.ScheduleStartTime, p.ScheduleEndTime,
		p.PipelineID, p.TagFormula, p.TagFormulaMode, p.TagFormulaType, p.EventDate, p.EventEnd, p.Location,
	).Scan(&p.ID, &p.CreatedAt, &p.UpdatedAt)
	return err
}

func clearProgramEventFields(p *domain.Program) {
	p.PipelineID = nil
	p.TagFormula = ""
	p.TagFormulaMode = ""
	p.TagFormulaType = ""
	p.EventDate = nil
	p.EventEnd = nil
	p.Location = nil
}

func (r *ProgramRepository) GetByID(ctx context.Context, accountID, id uuid.UUID) (*domain.Program, error) {
	p := &domain.Program{}
	err := r.db.QueryRow(ctx, `
SELECT p.id, p.account_id, p.type, p.name, p.description, p.status, p.color, p.created_by, p.folder_id, p.created_at, p.updated_at,
p.schedule_start_date, p.schedule_end_date, p.schedule_days, p.schedule_start_time, p.schedule_end_time,
p.pipeline_id, COALESCE(p.tag_formula, ''), COALESCE(p.tag_formula_mode, 'OR'), COALESCE(p.tag_formula_type, 'simple'),
p.event_date, p.event_end, p.location, ep.name as pipeline_name,
retirement.event_id, retirement.status, NULLIF(retirement.reason, ''),
(SELECT COUNT(*) FROM program_participants WHERE program_id = p.id AND status = 'active') as participant_count,
(SELECT COUNT(*) FROM program_sessions WHERE program_id = p.id) as session_count
FROM programs p
LEFT JOIN event_pipelines ep ON ep.id = p.pipeline_id AND ep.account_id = p.account_id
LEFT JOIN program_event_retirements retirement ON retirement.account_id = p.account_id AND retirement.program_id = p.id
WHERE p.id = $1 AND p.account_id = $2
`, id, accountID).Scan(
		&p.ID, &p.AccountID, &p.Type, &p.Name, &p.Description, &p.Status, &p.Color, &p.CreatedBy, &p.FolderID, &p.CreatedAt, &p.UpdatedAt,
		&p.ScheduleStartDate, &p.ScheduleEndDate, &p.ScheduleDays, &p.ScheduleStartTime, &p.ScheduleEndTime,
		&p.PipelineID, &p.TagFormula, &p.TagFormulaMode, &p.TagFormulaType,
		&p.EventDate, &p.EventEnd, &p.Location, &p.PipelineName,
		&p.MigratedEventID, &p.EventRetirementStatus, &p.EventRetirementReason,
		&p.ParticipantCount, &p.SessionCount,
	)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	return p, err
}

const getMigratedProgramEventTargetQuery = `
	SELECT retirement.event_id
	FROM programs p
	JOIN program_event_retirements retirement
	  ON retirement.account_id = p.account_id AND retirement.program_id = p.id
	WHERE p.account_id = $1 AND p.id = $2 AND retirement.status = 'migrated'
`

const legacyProgramEventPipelineAccountQuery = `
	SELECT EXISTS(
		SELECT 1 FROM event_pipelines WHERE account_id = $1 AND id = $2
	)
`

// GetMigratedEventTarget is the single account-scoped source used by the API
// mutation guard. The boolean distinguishes an absent retirement row from the
// exceptional case where the migrated Event was removed and event_id is NULL.
func (r *ProgramRepository) GetMigratedEventTarget(ctx context.Context, accountID, programID uuid.UUID) (*uuid.UUID, bool, error) {
	var eventID *uuid.UUID
	err := r.db.QueryRow(ctx, getMigratedProgramEventTargetQuery, accountID, programID).Scan(&eventID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return eventID, true, nil
}

func (r *ProgramRepository) LegacyEventPipelineBelongsToAccount(ctx context.Context, accountID, pipelineID uuid.UUID) (bool, error) {
	var belongs bool
	err := r.db.QueryRow(ctx, legacyProgramEventPipelineAccountQuery, accountID, pipelineID).Scan(&belongs)
	return belongs, err
}

func (r *ProgramRepository) List(ctx context.Context, accountID uuid.UUID, status string) ([]*domain.Program, error) {
	query := `
SELECT p.id, p.account_id, p.type, p.name, p.description, p.status, p.color, p.created_by, p.folder_id, p.created_at, p.updated_at,
p.schedule_start_date, p.schedule_end_date, p.schedule_days, p.schedule_start_time, p.schedule_end_time,
p.pipeline_id, COALESCE(p.tag_formula, ''), COALESCE(p.tag_formula_mode, 'OR'), COALESCE(p.tag_formula_type, 'simple'),
p.event_date, p.event_end, p.location, ep.name as pipeline_name,
retirement.event_id, retirement.status, NULLIF(retirement.reason, ''),
(SELECT COUNT(*) FROM program_participants WHERE program_id = p.id AND status = 'active') as participant_count,
(SELECT COUNT(*) FROM program_sessions WHERE program_id = p.id) as session_count
FROM programs p
LEFT JOIN event_pipelines ep ON ep.id = p.pipeline_id AND ep.account_id = p.account_id
LEFT JOIN program_event_retirements retirement ON retirement.account_id = p.account_id AND retirement.program_id = p.id
WHERE p.account_id = $1`
	args := []interface{}{accountID}
	if status != "" {
		query += " AND p.status = $2"
		args = append(args, status)
	}
	query += " ORDER BY p.created_at DESC"
	rows, err := r.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var programs []*domain.Program
	for rows.Next() {
		p := &domain.Program{}
		err := rows.Scan(
			&p.ID, &p.AccountID, &p.Type, &p.Name, &p.Description, &p.Status, &p.Color, &p.CreatedBy, &p.FolderID, &p.CreatedAt, &p.UpdatedAt,
			&p.ScheduleStartDate, &p.ScheduleEndDate, &p.ScheduleDays, &p.ScheduleStartTime, &p.ScheduleEndTime,
			&p.PipelineID, &p.TagFormula, &p.TagFormulaMode, &p.TagFormulaType,
			&p.EventDate, &p.EventEnd, &p.Location, &p.PipelineName,
			&p.MigratedEventID, &p.EventRetirementStatus, &p.EventRetirementReason,
			&p.ParticipantCount, &p.SessionCount,
		)
		if err != nil {
			return nil, err
		}
		programs = append(programs, p)
	}
	return programs, nil
}

func (r *ProgramRepository) Update(ctx context.Context, p *domain.Program) error {
	if p.Type != "event" {
		clearProgramEventFields(p)
	}
	_, err := r.db.Exec(ctx, `
UPDATE programs
SET name = $1, description = $2, status = $3, color = $4, folder_id = $5,
schedule_start_date = $6, schedule_end_date = $7, schedule_days = $8, schedule_start_time = $9, schedule_end_time = $10,
pipeline_id = $11, tag_formula = $12, tag_formula_mode = $13, tag_formula_type = $14,
event_date = $15, event_end = $16, location = $17,
updated_at = NOW()
WHERE id = $18 AND account_id = $19
`, p.Name, p.Description, p.Status, p.Color, p.FolderID,
		p.ScheduleStartDate, p.ScheduleEndDate, p.ScheduleDays, p.ScheduleStartTime, p.ScheduleEndTime,
		p.PipelineID, p.TagFormula, p.TagFormulaMode, p.TagFormulaType,
		p.EventDate, p.EventEnd, p.Location,
		p.ID, p.AccountID)
	return err
}

func (r *ProgramRepository) Delete(ctx context.Context, accountID, id uuid.UUID) error {
	_, err := r.db.Exec(ctx, "DELETE FROM programs WHERE id = $1 AND account_id = $2", id, accountID)
	return err
}

// --- Participants ---

const addProgramParticipantQuery = `
	INSERT INTO program_participants (program_id, contact_id, stage_id, status, auto_tag_sync)
	SELECT p.id, c.id, $4::uuid, $5, $6
	FROM programs p
	JOIN contacts c ON c.account_id = p.account_id AND c.id = $3 AND c.is_group = FALSE
	WHERE p.account_id = $1 AND p.id = $2 AND p.status = 'active'
	  AND (
		$4::uuid IS NULL OR (
			p.type = 'event' AND EXISTS (
				SELECT 1
				FROM event_pipeline_stages stage
				JOIN event_pipelines pipeline
				  ON pipeline.id = stage.pipeline_id AND pipeline.account_id = p.account_id
				WHERE stage.id = $4::uuid AND stage.pipeline_id = p.pipeline_id
			)
		)
	  )
	ON CONFLICT (program_id, contact_id) DO NOTHING
	RETURNING id, enrolled_at
`

func (r *ProgramRepository) AddParticipant(ctx context.Context, accountID uuid.UUID, pp *domain.ProgramParticipant) error {
	err := r.db.QueryRow(ctx, addProgramParticipantQuery, accountID, pp.ProgramID, pp.ContactID, pp.StageID, pp.Status, pp.AutoTagSync).Scan(&pp.ID, &pp.EnrolledAt)
	if errors.Is(err, pgx.ErrNoRows) {
		var alreadyExists bool
		if lookupErr := r.db.QueryRow(ctx, `
			SELECT EXISTS(
				SELECT 1
				FROM program_participants participant
				JOIN programs program ON program.id = participant.program_id AND program.account_id = $1
				WHERE participant.program_id = $2 AND participant.contact_id = $3
			)
		`, accountID, pp.ProgramID, pp.ContactID).Scan(&alreadyExists); lookupErr != nil {
			return lookupErr
		}
		if alreadyExists {
			return ErrProgramParticipantAlreadyExists
		}
		return ErrProgramParticipantStageInvalid
	}
	return err
}

func (r *ProgramRepository) AddParticipantsByContactIDs(ctx context.Context, accountID, programID uuid.UUID, contactIDs []uuid.UUID) (ProgramParticipantBulkResult, error) {
	result := ProgramParticipantBulkResult{}
	seen := make(map[uuid.UUID]struct{}, len(contactIDs))
	uniqueIDs := make([]uuid.UUID, 0, len(contactIDs))
	for _, contactID := range contactIDs {
		if contactID == uuid.Nil {
			continue
		}
		if _, exists := seen[contactID]; exists {
			continue
		}
		seen[contactID] = struct{}{}
		uniqueIDs = append(uniqueIDs, contactID)
	}
	result.Requested = len(uniqueIDs)
	if result.Requested == 0 {
		return result, nil
	}

	tx, err := r.db.Begin(ctx)
	if err != nil {
		return result, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var active bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM programs
			WHERE id=$1 AND account_id=$2 AND status='active'
		)
	`, programID, accountID).Scan(&active); err != nil {
		return result, err
	}
	if !active {
		return result, pgx.ErrNoRows
	}

	if err := tx.QueryRow(ctx, `
		SELECT COUNT(*)
		FROM contacts
		WHERE account_id=$1 AND id=ANY($2::uuid[]) AND is_group=FALSE
	`, accountID, uniqueIDs).Scan(&result.Created); err != nil {
		return result, err
	}
	validContacts := result.Created
	result.Rejected = result.Requested - validContacts

	commandTag, err := tx.Exec(ctx, `
		INSERT INTO program_participants (program_id, contact_id, status)
		SELECT $1, c.id, 'active'
		FROM contacts c
		WHERE c.account_id=$2 AND c.id=ANY($3::uuid[]) AND c.is_group=FALSE
		ON CONFLICT (program_id, contact_id) DO NOTHING
	`, programID, accountID, uniqueIDs)
	if err != nil {
		return result, err
	}
	result.Created = int(commandTag.RowsAffected())
	result.AlreadyPresent = validContacts - result.Created
	if result.AlreadyPresent < 0 {
		result.AlreadyPresent = 0
	}

	if err := tx.Commit(ctx); err != nil {
		return result, err
	}
	return result, nil
}

const updateProgramParticipantStageQuery = `
	UPDATE program_participants participant
	SET stage_id = $1
	FROM programs program
	WHERE program.account_id = $2 AND program.id = $3 AND program.type = 'event'
	  AND participant.id = $4 AND participant.program_id = program.id
	  AND (
		$1::uuid IS NULL OR EXISTS (
			SELECT 1
			FROM event_pipeline_stages stage
			JOIN event_pipelines pipeline
			  ON pipeline.id = stage.pipeline_id AND pipeline.account_id = program.account_id
			WHERE stage.id = $1::uuid AND stage.pipeline_id = program.pipeline_id
		)
	  )
`

func (r *ProgramRepository) UpdateParticipantStage(ctx context.Context, accountID, programID, participantID uuid.UUID, stageID *uuid.UUID) error {
	command, err := r.db.Exec(ctx, updateProgramParticipantStageQuery, stageID, accountID, programID, participantID)
	if err != nil {
		return err
	}
	if command.RowsAffected() > 0 {
		return nil
	}
	var participantExists bool
	if err := r.db.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1
			FROM program_participants participant
			JOIN programs program ON program.id = participant.program_id AND program.account_id = $1
			WHERE participant.program_id = $2 AND participant.id = $3
		)
	`, accountID, programID, participantID).Scan(&participantExists); err != nil {
		return err
	}
	if !participantExists {
		return ErrProgramParticipantNotFound
	}
	return ErrProgramParticipantStageInvalid
}

const listProgramParticipantsQuery = `
	SELECT pp.id, pp.program_id, pp.contact_id, pp.stage_id, pp.status, pp.enrolled_at,
	pp.dropped_at, COALESCE(pp.drop_reason, ''), COALESCE(pp.drop_notes, ''), pp.completed_at,
	COALESCE(pp.transferred_to_level, ''), pp.transferred_at, COALESCE(pp.auto_tag_sync, false),
	COALESCE(c.custom_name, c.name, c.push_name, c.phone, '') as display_name, c.phone,
	c.avatar_url, COALESCE(c.avatar_revision, 0),
	s.name as stage_name, s.color as stage_color
	FROM program_participants pp
	JOIN programs p ON p.id = pp.program_id AND p.account_id = $1
	JOIN contacts c ON c.id = pp.contact_id AND c.account_id = p.account_id
	LEFT JOIN event_pipelines stage_pipeline
	  ON stage_pipeline.id = p.pipeline_id AND stage_pipeline.account_id = p.account_id
	LEFT JOIN event_pipeline_stages s
	  ON s.id = pp.stage_id AND s.pipeline_id = stage_pipeline.id
	WHERE pp.program_id = $2
	ORDER BY COALESCE(c.custom_name, c.name, c.push_name, c.phone) ASC
`

func (r *ProgramRepository) ListParticipants(ctx context.Context, accountID, programID uuid.UUID) ([]*domain.ProgramParticipant, error) {
	rows, err := r.db.Query(ctx, listProgramParticipantsQuery, accountID, programID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	participants := make([]*domain.ProgramParticipant, 0)
	for rows.Next() {
		pp := &domain.ProgramParticipant{}
		err := rows.Scan(
			&pp.ID, &pp.ProgramID, &pp.ContactID, &pp.StageID, &pp.Status, &pp.EnrolledAt,
			&pp.DroppedAt, &pp.DropReason, &pp.DropNotes, &pp.CompletedAt, &pp.TransferredToLevel, &pp.TransferredAt, &pp.AutoTagSync,
			&pp.ContactName, &pp.ContactPhone, &pp.AvatarURL, &pp.AvatarRevision,
			&pp.StageName, &pp.StageColor,
		)
		if err != nil {
			return nil, err
		}
		participants = append(participants, pp)
	}
	return participants, nil
}

// UpdateParticipantEnrollmentDate preserves the automatic enrollment default
// while allowing an explicit correction. The participant is resolved through
// the account-owned Program inside the same transaction, so an ID from another
// account cannot be used as an existence oracle or mutation target.
func (r *ProgramRepository) UpdateParticipantEnrollmentDate(ctx context.Context, accountID, programID, participantID uuid.UUID, enrolledAt time.Time) (time.Time, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return time.Time{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var endedAt *time.Time
	err = tx.QueryRow(ctx, `
		SELECT CASE
		         WHEN pp.dropped_at IS NULL THEN pp.completed_at
		         WHEN pp.completed_at IS NULL THEN pp.dropped_at
		         ELSE LEAST(pp.dropped_at, pp.completed_at)
		       END
		FROM program_participants pp
		JOIN programs p ON p.id = pp.program_id AND p.account_id = $1
		WHERE pp.program_id = $2 AND pp.id = $3
		FOR UPDATE OF pp
	`, accountID, programID, participantID).Scan(&endedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return time.Time{}, ErrProgramParticipantNotFound
	}
	if err != nil {
		return time.Time{}, err
	}
	if endedAt != nil {
		endDate := time.Date(endedAt.Year(), endedAt.Month(), endedAt.Day(), 0, 0, 0, 0, time.UTC)
		if enrolledAt.After(endDate) {
			return time.Time{}, ErrProgramParticipantEnrollmentAfterEnd
		}
	}

	var updated time.Time
	if err := tx.QueryRow(ctx, `
		UPDATE program_participants pp
		SET enrolled_at = $1
		FROM programs p
		WHERE p.id = pp.program_id AND p.account_id = $4
		  AND pp.program_id = $2 AND pp.id = $3
		RETURNING pp.enrolled_at
	`, enrolledAt, programID, participantID, accountID).Scan(&updated); err != nil {
		return time.Time{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return time.Time{}, err
	}
	return updated, nil
}

const programParticipantHasActivityQuery = `
	SELECT
		EXISTS(SELECT 1 FROM program_attendance WHERE participant_id = $1)
		OR EXISTS(
			SELECT 1 FROM interactions
			WHERE account_id = $2 AND program_id = $3 AND program_participant_id = $1
		)
		OR EXISTS(
			SELECT 1 FROM program_participant_notes
			WHERE account_id = $2 AND program_id = $3 AND participant_id = $1
		)
		OR EXISTS(
			SELECT 1 FROM survey_instance_recipients
			WHERE account_id = $2 AND program_id = $3 AND program_participant_id = $1
		)
		OR EXISTS(
			SELECT 1 FROM survey_responses
			WHERE account_id = $2 AND program_id = $3 AND program_participant_id = $1
		)
`

// RemoveParticipant is deliberately limited to annulling an enrollment that
// was created by mistake and still has no operational history. A normal exit
// must use UpdateParticipantOutcome(status=dropped), which preserves the
// participant, attendance and observations as program-specific history.
func (r *ProgramRepository) RemoveParticipant(ctx context.Context, accountID, programID, participantID uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var status string
	var hasEnded bool
	err = tx.QueryRow(ctx, `
		SELECT pp.status, (pp.dropped_at IS NOT NULL OR pp.completed_at IS NOT NULL)
		FROM program_participants pp
		JOIN programs p ON p.id = pp.program_id AND p.account_id = $1
		WHERE pp.program_id = $2 AND pp.id = $3
		FOR UPDATE OF pp
	`, accountID, programID, participantID).Scan(&status, &hasEnded)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrProgramParticipantNotFound
	}
	if err != nil {
		return err
	}
	if status != "active" || hasEnded {
		return ErrProgramParticipantHasActivity
	}

	var hasActivity bool
	if err := tx.QueryRow(ctx, programParticipantHasActivityQuery, participantID, accountID, programID).Scan(&hasActivity); err != nil {
		return err
	}
	if hasActivity {
		return ErrProgramParticipantHasActivity
	}

	command, err := tx.Exec(ctx, `
		DELETE FROM program_participants pp
		USING programs p
		WHERE pp.id = $1 AND pp.program_id = $2
		  AND p.id = pp.program_id AND p.account_id = $3
	`, participantID, programID, accountID)
	if err != nil {
		return err
	}
	if command.RowsAffected() == 0 {
		return ErrProgramParticipantNotFound
	}
	return tx.Commit(ctx)
}

// --- Sessions ---

func (r *ProgramRepository) CreateSession(ctx context.Context, accountID uuid.UUID, s *domain.ProgramSession) error {
	if s.SessionType == "" {
		s.SessionType = "regular"
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var programType string
	if err := tx.QueryRow(ctx, `
		SELECT type FROM programs WHERE account_id = $1 AND id = $2 FOR SHARE
	`, accountID, s.ProgramID).Scan(&programType); err != nil {
		if err == pgx.ErrNoRows {
			return ErrProgramNotFound
		}
		return err
	}
	if programType != "course" {
		for _, topic := range s.Topics {
			if topic.Kind == "course" {
				return ErrInvalidSessionTopic
			}
		}
	}
	resolvedTopics, err := resolveSessionTopics(ctx, tx, accountID, s.ProgramID, s.Topics, nil)
	if err != nil {
		return err
	}
	s.Topics = resolvedTopics
	applyLegacySessionTopic(s)
	applyCompatibleSessionTitle(s)

	if err := tx.QueryRow(ctx, `
		INSERT INTO program_sessions (account_id, program_id, date, title, topic, course_topic_id, session_type, start_time, end_time, location)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		RETURNING id, created_at, updated_at
	`, accountID, s.ProgramID, s.Date, s.Title, s.Topic, s.CourseTopicID, s.SessionType, s.StartTime, s.EndTime, s.Location).
		Scan(&s.ID, &s.CreatedAt, &s.UpdatedAt); err != nil {
		return err
	}
	if err := replaceSessionTopics(ctx, tx, accountID, s.ID, s.Topics); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *ProgramRepository) ListSessions(ctx context.Context, accountID, programID uuid.UUID) ([]*domain.ProgramSession, error) {
	rows, err := r.db.Query(ctx, `
		SELECT ps.id, ps.program_id, ps.date, ps.title, ps.topic, ps.course_topic_id,
		       COALESCE(ps.session_type, 'regular'), ps.start_time, ps.end_time,
		       ps.location, ps.created_at, ps.updated_at,
		       c.id, c.name, ct.title,
		       COALESCE(att.present_count, 0), COALESCE(att.absent_count, 0),
		       COALESCE(att.late_count, 0)
		FROM program_sessions ps
		JOIN programs p ON p.id = ps.program_id AND p.account_id = $1
		LEFT JOIN course_topics ct ON ct.id = ps.course_topic_id AND ct.account_id = p.account_id
		LEFT JOIN courses c ON c.id = ct.course_id AND c.account_id = p.account_id
		LEFT JOIN LATERAL (
			SELECT
				COUNT(*) FILTER (WHERE pa.status = 'present')::int AS present_count,
				COUNT(*) FILTER (WHERE pa.status = 'absent')::int AS absent_count,
				COUNT(*) FILTER (WHERE pa.status = 'late')::int AS late_count
			FROM program_attendance pa
			JOIN program_participants pp
			  ON pp.id = pa.participant_id AND pp.program_id = p.id
			JOIN contacts participant_contact
			  ON participant_contact.id = pp.contact_id AND participant_contact.account_id = p.account_id
			WHERE pa.session_id = ps.id
		) att ON TRUE
		WHERE ps.program_id = $2
		ORDER BY ps.date ASC, ps.created_at ASC
	`, accountID, programID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	sessions := make([]*domain.ProgramSession, 0)
	byID := make(map[uuid.UUID]*domain.ProgramSession)
	for rows.Next() {
		s := &domain.ProgramSession{Topics: make([]*domain.ProgramSessionTopic, 0)}
		var present, absent, late int
		if err := rows.Scan(
			&s.ID, &s.ProgramID, &s.Date, &s.Title, &s.Topic, &s.CourseTopicID,
			&s.SessionType, &s.StartTime, &s.EndTime, &s.Location, &s.CreatedAt, &s.UpdatedAt,
			&s.CourseID, &s.CourseName, &s.CourseTopicTitle,
			&present, &absent, &late,
		); err != nil {
			return nil, err
		}
		s.AttendanceStats = make(map[string]int)
		for status, count := range map[string]int{
			domain.AttendanceStatusPresent: present,
			domain.AttendanceStatusAbsent:  absent,
			domain.AttendanceStatusLate:    late,
		} {
			if count > 0 {
				s.AttendanceStats[status] = count
			}
		}
		sessions = append(sessions, s)
		byID[s.ID] = s
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := r.loadSessionTopics(ctx, accountID, byID); err != nil {
		return nil, err
	}
	return sessions, nil
}

func (r *ProgramRepository) UpdateSession(ctx context.Context, accountID uuid.UUID, s *domain.ProgramSession) error {
	if s.SessionType == "" {
		s.SessionType = "regular"
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var programType, existingTitle string
	if err := tx.QueryRow(ctx, `
		SELECT p.type, ps.title
		FROM program_sessions ps
		JOIN programs p ON p.id = ps.program_id AND p.account_id = $1
		WHERE ps.program_id = $2 AND ps.id = $3
		FOR UPDATE OF ps
	`, accountID, s.ProgramID, s.ID).Scan(&programType, &existingTitle); err != nil {
		if err == pgx.ErrNoRows {
			return ErrSessionNotFound
		}
		return err
	}
	if !s.TitleProvided {
		s.Title = existingTitle
	}

	if programType != "course" {
		for _, topic := range s.Topics {
			if topic.Kind == "course" {
				return ErrInvalidSessionTopic
			}
		}
	}
	existingTopics, err := loadSessionTopicsForUpdate(ctx, tx, accountID, s.ID)
	if err != nil {
		return err
	}
	resolvedTopics, err := resolveSessionTopics(ctx, tx, accountID, s.ProgramID, s.Topics, existingTopics)
	if err != nil {
		return err
	}
	s.Topics = resolvedTopics
	applyLegacySessionTopic(s)

	if err := tx.QueryRow(ctx, `
		UPDATE program_sessions
		SET date = $1, title = $2, topic = $3, course_topic_id = $4, session_type = $5,
		    start_time = $6, end_time = $7, location = $8, updated_at = NOW()
		WHERE id = $9 AND program_id = $10
		RETURNING title, created_at, updated_at
	`, s.Date, s.Title, s.Topic, s.CourseTopicID, s.SessionType, s.StartTime, s.EndTime, s.Location, s.ID, s.ProgramID).
		Scan(&s.Title, &s.CreatedAt, &s.UpdatedAt); err != nil {
		return err
	}
	if err := replaceSessionTopics(ctx, tx, accountID, s.ID, s.Topics); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *ProgramRepository) DeleteSession(ctx context.Context, accountID, programID, sessionID uuid.UUID) error {
	command, err := r.db.Exec(ctx, `
		DELETE FROM program_sessions ps
		USING programs p
		WHERE ps.id = $1 AND ps.program_id = $2
		  AND p.id = ps.program_id AND p.account_id = $3
	`, sessionID, programID, accountID)
	if err != nil {
		return err
	}
	if command.RowsAffected() == 0 {
		return ErrSessionNotFound
	}
	return nil
}

// --- Attendance ---

const participantEligibleForSessionQuery = `
	SELECT EXISTS(
	SELECT 1
	FROM program_participants pp
	JOIN programs p ON p.id = pp.program_id
	JOIN contacts c ON c.id = pp.contact_id AND c.account_id = p.account_id
	WHERE p.account_id = $1 AND pp.program_id = $2 AND pp.id = $3
	  AND $4::date >= pp.enrolled_at::date
	  AND $4::date <= COALESCE(
		CASE
		  WHEN pp.dropped_at IS NULL THEN pp.completed_at
		  WHEN pp.completed_at IS NULL THEN pp.dropped_at
		  ELSE LEAST(pp.dropped_at, pp.completed_at)
		END::date,
		'infinity'::date
	  )
	)
`

func (r *ProgramRepository) BatchMarkAttendance(ctx context.Context, accountID, _ uuid.UUID, programID, sessionID uuid.UUID, attendances []*domain.ProgramAttendance) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	var sessionDate time.Time
	if err := tx.QueryRow(ctx, `
		SELECT ps.date
		FROM program_sessions ps
		JOIN programs p ON p.id = ps.program_id
		WHERE p.account_id = $1 AND p.id = $2 AND ps.id = $3
	`, accountID, programID, sessionID).Scan(&sessionDate); errors.Is(err, pgx.ErrNoRows) {
		return errors.New("session does not belong to this account and program")
	} else if err != nil {
		return err
	}

	for _, a := range attendances {
		var participantEligible bool
		if err := tx.QueryRow(ctx, participantEligibleForSessionQuery, accountID, programID, a.ParticipantID, sessionDate).Scan(&participantEligible); err != nil {
			return err
		}
		if !participantEligible {
			return fmt.Errorf("%w: %s", ErrProgramParticipantOutsideWindow, a.ParticipantID)
		}

		if a.Status == "" {
			var hasObservations bool
			if err := tx.QueryRow(ctx, `
				SELECT EXISTS(
					SELECT 1 FROM interactions
					WHERE account_id = $1 AND type = 'attendance'
					  AND program_session_id = $2 AND program_participant_id = $3
				)
			`, accountID, sessionID, a.ParticipantID).Scan(&hasObservations); err != nil {
				return err
			}
			if hasObservations {
				if err := tx.QueryRow(ctx, `
					INSERT INTO program_attendance (session_id, participant_id, status)
					VALUES ($1, $2, NULL)
					ON CONFLICT (session_id, participant_id) DO UPDATE
					SET status = NULL, updated_at = NOW()
					RETURNING id, created_at, updated_at
				`, sessionID, a.ParticipantID).Scan(&a.ID, &a.CreatedAt, &a.UpdatedAt); err != nil {
					return err
				}
			} else if _, err := tx.Exec(ctx, `DELETE FROM program_attendance WHERE session_id=$1 AND participant_id=$2`, sessionID, a.ParticipantID); err != nil {
				return err
			}
			continue
		}

		if err := tx.QueryRow(ctx, `
			INSERT INTO program_attendance (session_id, participant_id, status)
			VALUES ($1, $2, $3)
			ON CONFLICT (session_id, participant_id) DO UPDATE
			SET status = EXCLUDED.status, updated_at = NOW()
			RETURNING id, created_at, updated_at
		`, sessionID, a.ParticipantID, a.Status).Scan(&a.ID, &a.CreatedAt, &a.UpdatedAt); err != nil {
			return err
		}
	}

	return tx.Commit(ctx)
}

const getAttendanceBySessionQuery = `
	SELECT a.id, a.session_id, a.participant_id, COALESCE(a.status, ''), a.notes,
	       a.created_at, a.updated_at,
	       COALESCE(
	         NULLIF(c.custom_name, ''), NULLIF(c.name, ''), NULLIF(c.push_name, ''),
	         NULLIF(c.phone, ''), 'Sin nombre'
	       ) AS participant_name,
	       c.phone,
	       latest.id, latest.notes, latest.created_by, latest.created_by_name,
	       latest.created_at, latest.source_label,
	       COALESCE(latest.observation_count, 0)
	FROM program_attendance a
	JOIN program_sessions ps
	  ON ps.id = a.session_id AND ps.account_id = $1
	JOIN programs p
	  ON p.id = ps.program_id AND p.account_id = ps.account_id
	JOIN program_participants pp
	  ON pp.id = a.participant_id AND pp.program_id = p.id
	JOIN contacts c
	  ON c.id = pp.contact_id AND c.account_id = p.account_id
	LEFT JOIN LATERAL (
		SELECT i.id, COALESCE(i.notes, '') AS notes, i.created_by,
		       u.display_name AS created_by_name, i.created_at,
		       COALESCE(i.source_label, '') AS source_label,
		       (COUNT(*) OVER ())::int AS observation_count
		FROM interactions i
		LEFT JOIN users u ON u.id = i.created_by
		WHERE i.account_id = p.account_id
		  AND i.type = 'attendance'
		  AND i.program_id = p.id
		  AND i.program_session_id = ps.id
		  AND i.program_participant_id = pp.id
		ORDER BY i.created_at DESC NULLS LAST, i.id DESC
		LIMIT 1
	) latest ON TRUE
	WHERE a.session_id = $2
	ORDER BY a.created_at ASC, a.id ASC
`

type programAttendanceScanner interface {
	Scan(dest ...any) error
}

func scanProgramAttendance(row programAttendanceScanner) (*domain.ProgramAttendance, error) {
	attendance := &domain.ProgramAttendance{ObservationPreview: make([]*domain.ProgramAttendanceObservation, 0)}
	var observationID *uuid.UUID
	var observationNotes *string
	var observationCreatedBy *uuid.UUID
	var observationCreatedByName *string
	var observationCreatedAt *time.Time
	var observationSourceLabel *string
	if err := row.Scan(
		&attendance.ID, &attendance.SessionID, &attendance.ParticipantID,
		&attendance.Status, &attendance.Notes, &attendance.CreatedAt, &attendance.UpdatedAt,
		&attendance.ParticipantName, &attendance.ParticipantPhone,
		&observationID, &observationNotes, &observationCreatedBy,
		&observationCreatedByName, &observationCreatedAt, &observationSourceLabel,
		&attendance.ObservationCount,
	); err != nil {
		return nil, err
	}
	if observationID != nil {
		observation := &domain.ProgramAttendanceObservation{
			ID:            *observationID,
			CreatedBy:     observationCreatedBy,
			CreatedByName: observationCreatedByName,
		}
		if observationNotes != nil {
			observation.Notes = *observationNotes
		}
		if observationCreatedAt != nil {
			observation.CreatedAt = *observationCreatedAt
		}
		if observationSourceLabel != nil {
			observation.SourceLabel = *observationSourceLabel
		}
		attendance.ObservationPreview = append(attendance.ObservationPreview, observation)
		// notes is a compatibility field. The interaction history is canonical
		// when observations exist; otherwise the legacy attendance note survives.
		latestNotes := observation.Notes
		attendance.Notes = &latestNotes
	}
	return attendance, nil
}

func (r *ProgramRepository) GetAttendanceBySession(ctx context.Context, accountID, sessionID uuid.UUID) ([]*domain.ProgramAttendance, error) {
	rows, err := r.db.Query(ctx, getAttendanceBySessionQuery, accountID, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	attendance := make([]*domain.ProgramAttendance, 0)
	for rows.Next() {
		record, err := scanProgramAttendance(rows)
		if err != nil {
			return nil, err
		}
		attendance = append(attendance, record)
	}
	return attendance, rows.Err()
}

func attendanceObservationContext(ctx context.Context, q sessionTopicQuerier, accountID, programID, sessionID, participantID uuid.UUID) (uuid.UUID, string, error) {
	var contactID uuid.UUID
	var programName, sessionTitle string
	var sessionDate time.Time
	err := q.QueryRow(ctx, `
		SELECT pp.contact_id, p.name, ps.title,
		       ps.date
		FROM programs p
		JOIN program_sessions ps ON ps.account_id = p.account_id AND ps.program_id = p.id
		JOIN program_participants pp ON pp.program_id = p.id
		JOIN contacts c ON c.account_id = p.account_id AND c.id = pp.contact_id
		WHERE p.account_id = $1 AND p.id = $2 AND ps.id = $3 AND pp.id = $4
	`, accountID, programID, sessionID, participantID).Scan(&contactID, &programName, &sessionTitle, &sessionDate)
	if err != nil {
		if err == pgx.ErrNoRows {
			return uuid.Nil, "", ErrSessionNotFound
		}
		return uuid.Nil, "", err
	}
	return contactID, fmt.Sprintf("%s · %s · %s", programName, sessionTitle, sessionDate.Format("02/01/2006")), nil
}

func (r *ProgramRepository) ListAttendanceObservations(ctx context.Context, accountID, programID, sessionID, participantID uuid.UUID) ([]*domain.ProgramAttendanceObservation, error) {
	if _, _, err := attendanceObservationContext(ctx, r.db, accountID, programID, sessionID, participantID); err != nil {
		return nil, err
	}
	rows, err := r.db.Query(ctx, `
		SELECT i.id, COALESCE(i.notes, ''), i.created_by, u.display_name,
		       i.created_at, COALESCE(i.source_label, '')
		FROM interactions i
		LEFT JOIN users u ON u.id = i.created_by
		WHERE i.account_id = $1 AND i.type = 'attendance'
		  AND i.program_id = $2 AND i.program_session_id = $3
		  AND i.program_participant_id = $4
		ORDER BY i.created_at DESC, i.id DESC
	`, accountID, programID, sessionID, participantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	observations := make([]*domain.ProgramAttendanceObservation, 0)
	for rows.Next() {
		observation := &domain.ProgramAttendanceObservation{}
		if err := rows.Scan(&observation.ID, &observation.Notes, &observation.CreatedBy, &observation.CreatedByName, &observation.CreatedAt, &observation.SourceLabel); err != nil {
			return nil, err
		}
		observations = append(observations, observation)
	}
	return observations, rows.Err()
}

func (r *ProgramRepository) CreateAttendanceObservation(ctx context.Context, accountID, userID, programID, sessionID, participantID uuid.UUID, notes string) (*domain.ProgramAttendanceObservation, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	contactID, sourceLabel, err := attendanceObservationContext(ctx, tx, accountID, programID, sessionID, participantID)
	if err != nil {
		return nil, err
	}
	observation := &domain.ProgramAttendanceObservation{Notes: notes, CreatedBy: &userID, SourceLabel: sourceLabel}
	if err := tx.QueryRow(ctx, `
		INSERT INTO interactions (
			account_id, contact_id, type, notes, created_by,
			program_id, program_session_id, program_participant_id, source_label
		) VALUES ($1, $2, 'attendance', $3, $4, $5, $6, $7, $8)
		RETURNING id, created_at
	`, accountID, contactID, notes, userID, programID, sessionID, participantID, sourceLabel).Scan(&observation.ID, &observation.CreatedAt); err != nil {
		return nil, err
	}
	if err := tx.QueryRow(ctx, `SELECT display_name FROM users WHERE id = $1`, userID).Scan(&observation.CreatedByName); err != nil && err != pgx.ErrNoRows {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO program_attendance (session_id, participant_id, status, notes)
		VALUES ($1, $2, NULL, $3)
		ON CONFLICT (session_id, participant_id) DO UPDATE
		SET notes = EXCLUDED.notes, updated_at = NOW()
	`, sessionID, participantID, notes); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return observation, nil
}

func (r *ProgramRepository) DeleteAttendanceObservation(ctx context.Context, accountID, programID, sessionID, participantID, observationID uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, _, err := attendanceObservationContext(ctx, tx, accountID, programID, sessionID, participantID); err != nil {
		return err
	}
	command, err := tx.Exec(ctx, `
		DELETE FROM interactions
		WHERE id = $1 AND account_id = $2 AND type = 'attendance'
		  AND program_id = $3 AND program_session_id = $4
		  AND program_participant_id = $5
	`, observationID, accountID, programID, sessionID, participantID)
	if err != nil {
		return err
	}
	if command.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	var latestNotes *string
	err = tx.QueryRow(ctx, `
		SELECT notes FROM interactions
		WHERE account_id = $1 AND type = 'attendance'
		  AND program_session_id = $2 AND program_participant_id = $3
		ORDER BY created_at DESC, id DESC LIMIT 1
	`, accountID, sessionID, participantID).Scan(&latestNotes)
	if err != nil && err != pgx.ErrNoRows {
		return err
	}
	if err == pgx.ErrNoRows {
		latestNotes = nil
	}
	if _, err := tx.Exec(ctx, `
		UPDATE program_attendance SET notes = $3, updated_at = NOW()
		WHERE session_id = $1 AND participant_id = $2
	`, sessionID, participantID, latestNotes); err != nil {
		return err
	}
	if latestNotes == nil {
		if _, err := tx.Exec(ctx, `
			DELETE FROM program_attendance
			WHERE session_id = $1 AND participant_id = $2 AND status IS NULL
		`, sessionID, participantID); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (r *ProgramRepository) GetParticipantsByAttendanceStatus(ctx context.Context, accountID, programID, sessionID uuid.UUID, status string) ([]*domain.ProgramParticipant, error) {
	query := `
SELECT pp.id, pp.program_id, pp.contact_id, pp.status, pp.enrolled_at,
c.name, c.phone
FROM program_participants pp
JOIN programs p ON p.id = pp.program_id AND p.account_id = $1
JOIN program_sessions s ON s.id = $3 AND s.program_id = p.id AND s.account_id = p.account_id
JOIN contacts c ON c.id = pp.contact_id AND c.account_id = p.account_id
JOIN program_attendance a ON a.participant_id = pp.id AND a.session_id = s.id
WHERE pp.program_id = $2 AND a.status = $4
	  AND s.date >= pp.enrolled_at::date
	  AND s.date <= COALESCE(
		CASE
		  WHEN pp.dropped_at IS NULL THEN pp.completed_at
		  WHEN pp.completed_at IS NULL THEN pp.dropped_at
		  ELSE LEAST(pp.dropped_at, pp.completed_at)
		END::date,
		'infinity'::date
	  )
`

	// If status is "unmarked", we need to find participants who don't have an attendance record for this session
	if status == "unmarked" {
		query = `
SELECT pp.id, pp.program_id, pp.contact_id, pp.status, pp.enrolled_at,
c.name, c.phone
FROM program_participants pp
JOIN programs p ON p.id = pp.program_id AND p.account_id = $1
JOIN contacts c ON c.id = pp.contact_id AND c.account_id = p.account_id
JOIN program_sessions s ON s.program_id = p.id AND s.account_id = p.account_id
LEFT JOIN program_attendance a ON a.participant_id = pp.id AND a.session_id = s.id
WHERE pp.program_id = $2 AND s.id = $3 AND (a.id IS NULL OR a.status IS NULL)
	  AND s.date >= pp.enrolled_at::date
	  AND s.date <= COALESCE(
		CASE
		  WHEN pp.dropped_at IS NULL THEN pp.completed_at
		  WHEN pp.completed_at IS NULL THEN pp.dropped_at
		  ELSE LEAST(pp.dropped_at, pp.completed_at)
		END::date,
		'infinity'::date
	  )
`
		rows, err := r.db.Query(ctx, query, accountID, programID, sessionID)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		return scanParticipants(rows)
	}

	rows, err := r.db.Query(ctx, query, accountID, programID, sessionID, status)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanParticipants(rows)
}

func scanParticipants(rows pgx.Rows) ([]*domain.ProgramParticipant, error) {
	var participants []*domain.ProgramParticipant
	for rows.Next() {
		pp := &domain.ProgramParticipant{}
		err := rows.Scan(
			&pp.ID, &pp.ProgramID, &pp.ContactID, &pp.Status, &pp.EnrolledAt,
			&pp.ContactName, &pp.ContactPhone,
		)
		if err != nil {
			return nil, err
		}
		participants = append(participants, pp)
	}
	return participants, nil
}

func resolveSessionTopics(ctx context.Context, tx pgx.Tx, accountID, programID uuid.UUID, requested []*domain.ProgramSessionTopic, existing map[uuid.UUID]*domain.ProgramSessionTopic) ([]*domain.ProgramSessionTopic, error) {
	freeCount := 0
	for _, topic := range requested {
		if topic == nil {
			return nil, ErrInvalidSessionTopic
		}
		switch topic.Kind {
		case "course":
			if topic.CourseTopicID == nil || *topic.CourseTopicID == uuid.Nil {
				return nil, ErrInvalidSessionTopic
			}
		case "free":
			freeCount++
		default:
			return nil, ErrInvalidSessionTopic
		}
	}
	// Partial indexes enforce one row per course and at most one free row. The
	// transaction also rejects mixing both modes so callers cannot persist an
	// invalid aggregate even if they bypass the HTTP/service validation layer.
	if freeCount > 0 && (freeCount != 1 || len(requested) != 1) {
		return nil, ErrInvalidSessionTopic
	}

	pendingIDs := make([]uuid.UUID, 0, len(requested))
	for _, topic := range requested {
		if topic.Kind != "course" || topic.CourseTopicID == nil {
			continue
		}
		if existingTopic := existing[*topic.CourseTopicID]; existingTopic == nil {
			pendingIDs = append(pendingIDs, *topic.CourseTopicID)
		}
	}

	resolvedNew := make(map[uuid.UUID]*domain.ProgramSessionTopic, len(pendingIDs))
	if len(pendingIDs) > 0 {
		rows, err := tx.Query(ctx, `
			SELECT ct.id, c.id, c.name, ct.title
			FROM programs p
			JOIN program_courses pc
			  ON pc.account_id = p.account_id AND pc.program_id = p.id
			JOIN courses c
			  ON c.account_id = pc.account_id AND c.id = pc.course_id AND c.status = 'active'
			JOIN course_topics ct
			  ON ct.account_id = c.account_id AND ct.course_id = c.id AND ct.status = 'active'
			WHERE p.account_id = $1 AND p.id = $2 AND p.type = 'course'
			  AND ct.id = ANY($3::uuid[])
			FOR SHARE OF pc, c, ct
		`, accountID, programID, pendingIDs)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var topicID, courseID uuid.UUID
			var courseName, title string
			if err := rows.Scan(&topicID, &courseID, &courseName, &title); err != nil {
				rows.Close()
				return nil, err
			}
			resolvedNew[topicID] = &domain.ProgramSessionTopic{
				AccountID:          accountID,
				Kind:               "course",
				CourseID:           &courseID,
				CourseTopicID:      &topicID,
				CourseNameSnapshot: &courseName,
				TopicTitleSnapshot: title,
			}
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
		if len(resolvedNew) != len(pendingIDs) {
			return nil, ErrInvalidSessionTopic
		}
	}

	resolved := make([]*domain.ProgramSessionTopic, 0, len(requested))
	seenCourses := make(map[uuid.UUID]struct{}, len(requested))
	for position, requestedTopic := range requested {
		if requestedTopic.Kind == "free" {
			resolved = append(resolved, &domain.ProgramSessionTopic{
				AccountID:          accountID,
				Kind:               "free",
				TopicTitleSnapshot: requestedTopic.TopicTitleSnapshot,
				Position:           position,
			})
			continue
		}
		if requestedTopic.CourseTopicID == nil {
			return nil, ErrInvalidSessionTopic
		}
		var source *domain.ProgramSessionTopic
		if existing != nil {
			source = existing[*requestedTopic.CourseTopicID]
		}
		if source == nil {
			source = resolvedNew[*requestedTopic.CourseTopicID]
		}
		if source == nil || source.CourseID == nil {
			return nil, ErrInvalidSessionTopic
		}
		if _, duplicate := seenCourses[*source.CourseID]; duplicate {
			return nil, ErrInvalidSessionTopic
		}
		seenCourses[*source.CourseID] = struct{}{}
		courseID, topicID := *source.CourseID, *source.CourseTopicID
		courseName := ""
		if source.CourseNameSnapshot != nil {
			courseName = *source.CourseNameSnapshot
		}
		resolved = append(resolved, &domain.ProgramSessionTopic{
			AccountID:          accountID,
			Kind:               "course",
			CourseID:           &courseID,
			CourseTopicID:      &topicID,
			CourseNameSnapshot: &courseName,
			TopicTitleSnapshot: source.TopicTitleSnapshot,
			Position:           position,
		})
	}
	return resolved, nil
}

func applyLegacySessionTopic(session *domain.ProgramSession) {
	session.Topic = nil
	session.CourseTopicID = nil
	session.CourseID = nil
	session.CourseName = nil
	session.CourseTopicTitle = nil
	if len(session.Topics) == 0 {
		return
	}
	first := session.Topics[0]
	title := first.TopicTitleSnapshot
	session.Topic = &title
	if first.Kind == "course" {
		session.CourseTopicID = first.CourseTopicID
		session.CourseID = first.CourseID
		session.CourseName = first.CourseNameSnapshot
		session.CourseTopicTitle = &title
	}
}

func applyCompatibleSessionTitle(session *domain.ProgramSession) {
	if session.TitleProvided {
		return
	}
	if session.Topic != nil {
		session.Title = strings.TrimSpace(*session.Topic)
	}
	if session.Title == "" {
		session.Title = "Sesión"
	}
}

func loadSessionTopicsForUpdate(ctx context.Context, tx pgx.Tx, accountID, sessionID uuid.UUID) (map[uuid.UUID]*domain.ProgramSessionTopic, error) {
	rows, err := tx.Query(ctx, `
		SELECT id, account_id, session_id, kind, course_id, course_topic_id,
		       course_name_snapshot, topic_title_snapshot, position, created_at
		FROM program_session_topics
		WHERE account_id = $1 AND session_id = $2
		ORDER BY position, created_at
		FOR UPDATE
	`, accountID, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	existing := make(map[uuid.UUID]*domain.ProgramSessionTopic)
	for rows.Next() {
		topic := &domain.ProgramSessionTopic{}
		if err := rows.Scan(&topic.ID, &topic.AccountID, &topic.SessionID, &topic.Kind, &topic.CourseID, &topic.CourseTopicID, &topic.CourseNameSnapshot, &topic.TopicTitleSnapshot, &topic.Position, &topic.CreatedAt); err != nil {
			return nil, err
		}
		if topic.CourseTopicID != nil {
			existing[*topic.CourseTopicID] = topic
		}
	}
	return existing, rows.Err()
}

func replaceSessionTopics(ctx context.Context, tx pgx.Tx, accountID, sessionID uuid.UUID, topics []*domain.ProgramSessionTopic) error {
	if _, err := tx.Exec(ctx, `DELETE FROM program_session_topics WHERE account_id = $1 AND session_id = $2`, accountID, sessionID); err != nil {
		return err
	}
	for position, topic := range topics {
		topic.AccountID = accountID
		topic.SessionID = sessionID
		topic.Position = position
		if err := tx.QueryRow(ctx, `
			INSERT INTO program_session_topics (
				account_id, session_id, kind, course_id, course_topic_id,
				course_name_snapshot, topic_title_snapshot, position
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			RETURNING id, created_at
		`, accountID, sessionID, topic.Kind, topic.CourseID, topic.CourseTopicID, topic.CourseNameSnapshot, topic.TopicTitleSnapshot, position).Scan(&topic.ID, &topic.CreatedAt); err != nil {
			return err
		}
	}
	return nil
}

func (r *ProgramRepository) loadSessionTopics(ctx context.Context, accountID uuid.UUID, sessions map[uuid.UUID]*domain.ProgramSession) error {
	if len(sessions) == 0 {
		return nil
	}
	ids := make([]uuid.UUID, 0, len(sessions))
	for id := range sessions {
		ids = append(ids, id)
	}
	rows, err := r.db.Query(ctx, `
		SELECT id, account_id, session_id, kind, course_id, course_topic_id,
		       course_name_snapshot, topic_title_snapshot, position, created_at
		FROM program_session_topics
		WHERE account_id = $1 AND session_id = ANY($2::uuid[])
		ORDER BY session_id, position, created_at
	`, accountID, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		topic := &domain.ProgramSessionTopic{}
		if err := rows.Scan(&topic.ID, &topic.AccountID, &topic.SessionID, &topic.Kind, &topic.CourseID, &topic.CourseTopicID, &topic.CourseNameSnapshot, &topic.TopicTitleSnapshot, &topic.Position, &topic.CreatedAt); err != nil {
			return err
		}
		if session := sessions[topic.SessionID]; session != nil {
			session.Topics = append(session.Topics, topic)
		}
	}
	return rows.Err()
}

type availableProgramTopic struct {
	TopicID  uuid.UUID
	Topic    string
	CourseID uuid.UUID
	Course   string
}

type sessionTopicQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func resolveActiveSessionTopic(ctx context.Context, q sessionTopicQuerier, accountID uuid.UUID, session *domain.ProgramSession) error {
	if session.CourseTopicID == nil {
		return nil
	}
	var topicTitle, courseName string
	var courseID uuid.UUID
	err := q.QueryRow(ctx, `
		SELECT ct.title, c.id, c.name
		FROM programs p
		JOIN program_courses pc
		  ON pc.account_id = p.account_id AND pc.program_id = p.id
		JOIN courses c
		  ON c.account_id = pc.account_id AND c.id = pc.course_id AND c.status = 'active'
		JOIN course_topics ct
		  ON ct.account_id = c.account_id AND ct.course_id = c.id AND ct.status = 'active'
		WHERE p.account_id = $1 AND p.id = $2 AND p.type = 'course' AND ct.id = $3
		FOR SHARE OF pc, c, ct
	`, accountID, session.ProgramID, *session.CourseTopicID).Scan(&topicTitle, &courseID, &courseName)
	if err == pgx.ErrNoRows {
		return ErrInvalidSessionTopic
	}
	if err != nil {
		return err
	}
	session.Topic = &topicTitle
	session.CourseID = &courseID
	session.CourseName = &courseName
	session.CourseTopicTitle = &topicTitle
	return nil
}

func hydrateHistoricalSessionTopic(ctx context.Context, q sessionTopicQuerier, accountID uuid.UUID, session *domain.ProgramSession) error {
	if session.CourseTopicID == nil {
		return nil
	}
	var topicTitle, courseName string
	var courseID uuid.UUID
	err := q.QueryRow(ctx, `
		SELECT ct.title, c.id, c.name
		FROM course_topics ct
		JOIN courses c ON c.account_id = ct.account_id AND c.id = ct.course_id
		JOIN programs p ON p.account_id = ct.account_id
		WHERE p.account_id = $1 AND p.id = $2 AND ct.id = $3
	`, accountID, session.ProgramID, *session.CourseTopicID).Scan(&topicTitle, &courseID, &courseName)
	if err == pgx.ErrNoRows {
		return nil
	}
	if err != nil {
		return err
	}
	session.CourseID = &courseID
	session.CourseName = &courseName
	session.CourseTopicTitle = &topicTitle
	return nil
}

func sameOptionalUUID(left, right *uuid.UUID) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

// GenerateSessions bulk-inserts multiple sessions for an account-scoped
// program. When requested, the program row lock serializes automatic topic
// assignment and the next active, unused topics are selected in program/course
// order.
func (r *ProgramRepository) GenerateSessions(ctx context.Context, accountID, programID uuid.UUID, sessions []*domain.ProgramSession, assignCourseTopics bool) ([]*domain.ProgramSession, int, error) {
	if len(sessions) == 0 {
		return nil, 0, nil
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var programType string
	if err := tx.QueryRow(ctx, `
		SELECT type FROM programs WHERE account_id = $1 AND id = $2 FOR UPDATE
	`, accountID, programID).Scan(&programType); err != nil {
		if err == pgx.ErrNoRows {
			return nil, 0, ErrProgramNotFound
		}
		return nil, 0, err
	}
	if assignCourseTopics && programType != "course" {
		return nil, 0, ErrProgramNotCourse
	}

	availableTopics := make([]availableProgramTopic, 0)
	if assignCourseTopics {
		rows, err := tx.Query(ctx, `
			SELECT ct.id, ct.title, c.id, c.name
			FROM program_courses pc
			JOIN courses c
			  ON c.account_id = pc.account_id AND c.id = pc.course_id AND c.status = 'active'
			JOIN course_topics ct
			  ON ct.account_id = c.account_id AND ct.course_id = c.id AND ct.status = 'active'
			WHERE pc.account_id = $1 AND pc.program_id = $2
			  AND NOT EXISTS (
				SELECT 1
				FROM program_session_topics existing_topic
				JOIN program_sessions existing_session
				  ON existing_session.account_id = existing_topic.account_id
				 AND existing_session.id = existing_topic.session_id
				WHERE existing_session.program_id = pc.program_id
				  AND existing_topic.course_topic_id = ct.id
			  )
			ORDER BY pc.position, ct.position, ct.created_at
			FOR SHARE OF c, ct
		`, accountID, programID)
		if err != nil {
			return nil, 0, err
		}
		for rows.Next() {
			var topic availableProgramTopic
			if err := rows.Scan(&topic.TopicID, &topic.Topic, &topic.CourseID, &topic.Course); err != nil {
				rows.Close()
				return nil, 0, err
			}
			availableTopics = append(availableTopics, topic)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, 0, err
		}
		rows.Close()
	}

	var result []*domain.ProgramSession
	assignedCount := 0
	for index, s := range sessions {
		s.ProgramID = programID
		s.Title = strings.TrimSpace(s.Title)
		if s.Title == "" && s.Topic != nil {
			s.Title = strings.TrimSpace(*s.Topic)
		}
		if s.Title == "" {
			s.Title = "Sesión"
		}
		if assignCourseTopics && index < len(availableTopics) {
			available := availableTopics[index]
			topicTitle, courseName := available.Topic, available.Course
			topicID, courseID := available.TopicID, available.CourseID
			s.CourseTopicID = &topicID
			s.Topic = &topicTitle
			s.CourseID = &courseID
			s.CourseName = &courseName
			s.CourseTopicTitle = &topicTitle
			s.Topics = []*domain.ProgramSessionTopic{{
				AccountID: accountID, Kind: "course", CourseID: &courseID,
				CourseTopicID: &topicID, CourseNameSnapshot: &courseName,
				TopicTitleSnapshot: topicTitle, Position: 0,
			}}
			assignedCount++
		} else {
			title := ""
			if s.Topic != nil {
				title = *s.Topic
			}
			s.Topics = []*domain.ProgramSessionTopic{{
				AccountID: accountID, Kind: "free", TopicTitleSnapshot: title, Position: 0,
			}}
		}
		err := tx.QueryRow(ctx, `
		INSERT INTO program_sessions (account_id, program_id, date, title, topic, course_topic_id, session_type, start_time, end_time, location)
		VALUES ($1, $2, $3, $4, $5, $6, COALESCE(NULLIF($7, ''), 'regular'), $8, $9, $10)
		RETURNING id, created_at, updated_at
		`, accountID, s.ProgramID, s.Date, s.Title, s.Topic, s.CourseTopicID, s.SessionType, s.StartTime, s.EndTime, s.Location).
			Scan(&s.ID, &s.CreatedAt, &s.UpdatedAt)
		if err != nil {
			return nil, 0, err
		}
		if err := replaceSessionTopics(ctx, tx, accountID, s.ID, s.Topics); err != nil {
			return nil, 0, err
		}
		result = append(result, s)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, 0, err
	}
	return result, assignedCount, nil
}

// --- Program Folders ---

type ProgramFolderRepository struct {
	db *pgxpool.Pool
}

func (r *ProgramFolderRepository) Create(ctx context.Context, f *domain.ProgramFolder) error {
	f.ID = uuid.New()
	now := time.Now()
	f.CreatedAt = now
	f.UpdatedAt = now
	if f.Color == "" {
		f.Color = "#10b981"
	}
	if f.Icon == "" {
		f.Icon = "📁"
	}
	_, err := r.db.Exec(ctx, `
		INSERT INTO program_folders (id, account_id, parent_id, name, color, icon, position, created_at, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
	`, f.ID, f.AccountID, f.ParentID, f.Name, f.Color, f.Icon, f.Position, f.CreatedAt, f.UpdatedAt)
	return err
}

func (r *ProgramFolderRepository) GetByAccountID(ctx context.Context, accountID uuid.UUID, programStatus string) ([]*domain.ProgramFolder, error) {
	query := `
		SELECT pf.id, pf.account_id, pf.parent_id, pf.name, pf.color, pf.icon, pf.position, pf.created_at, pf.updated_at,
		       COUNT(p.id) AS program_count
		FROM program_folders pf
		LEFT JOIN programs p ON p.folder_id = pf.id AND p.account_id = pf.account_id`
	args := []interface{}{accountID}
	if programStatus != "" {
		query += " AND p.status = $2"
		args = append(args, programStatus)
	}
	query += `
		WHERE pf.account_id = $1
		GROUP BY pf.id
		ORDER BY pf.position, pf.name
	`
	rows, err := r.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var folders []*domain.ProgramFolder
	for rows.Next() {
		f := &domain.ProgramFolder{}
		if err := rows.Scan(&f.ID, &f.AccountID, &f.ParentID, &f.Name, &f.Color, &f.Icon, &f.Position, &f.CreatedAt, &f.UpdatedAt, &f.ProgramCount); err != nil {
			return nil, err
		}
		folders = append(folders, f)
	}
	return folders, nil
}

func (r *ProgramFolderRepository) GetByID(ctx context.Context, id uuid.UUID) (*domain.ProgramFolder, error) {
	f := &domain.ProgramFolder{}
	err := r.db.QueryRow(ctx, `
		SELECT id, account_id, parent_id, name, color, icon, position, created_at, updated_at
		FROM program_folders WHERE id = $1
	`, id).Scan(&f.ID, &f.AccountID, &f.ParentID, &f.Name, &f.Color, &f.Icon, &f.Position, &f.CreatedAt, &f.UpdatedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	return f, err
}

func (r *ProgramFolderRepository) Update(ctx context.Context, f *domain.ProgramFolder) error {
	f.UpdatedAt = time.Now()
	_, err := r.db.Exec(ctx, `
		UPDATE program_folders SET name=$1, color=$2, icon=$3, position=$4, updated_at=$5 WHERE id=$6
	`, f.Name, f.Color, f.Icon, f.Position, f.UpdatedAt, f.ID)
	return err
}

func (r *ProgramFolderRepository) Delete(ctx context.Context, id uuid.UUID) error {
	var parentID *uuid.UUID
	_ = r.db.QueryRow(ctx, `SELECT parent_id FROM program_folders WHERE id = $1`, id).Scan(&parentID)
	_, _ = r.db.Exec(ctx, `UPDATE programs SET folder_id = $1 WHERE folder_id = $2`, parentID, id)
	_, _ = r.db.Exec(ctx, `UPDATE program_folders SET parent_id = $1 WHERE parent_id = $2`, parentID, id)
	_, err := r.db.Exec(ctx, `DELETE FROM program_folders WHERE id = $1`, id)
	return err
}

func (r *ProgramFolderRepository) MoveProgram(ctx context.Context, programID uuid.UUID, folderID *uuid.UUID) error {
	_, err := r.db.Exec(ctx, `UPDATE programs SET folder_id = $1, updated_at = NOW() WHERE id = $2`, folderID, programID)
	return err
}

// --- Attendance Stats ---

func (r *ProgramRepository) GetAttendanceStats(ctx context.Context, accountID, programID uuid.UUID, months []time.Time) ([]*domain.ProgramSessionAttendanceStat, []*domain.ProgramParticipantAttendanceStat, error) {
	dateFilter := "AND ps.date <= CURRENT_DATE"
	args := []interface{}{accountID, programID}
	if len(months) > 0 {
		parts := make([]string, 0, len(months))
		for _, month := range months {
			args = append(args, month.Format("2006-01-02"))
			placeholder := len(args)
			parts = append(parts, fmt.Sprintf("(ps.date >= $%d::date AND ps.date < ($%d::date + INTERVAL '1 month'))", placeholder, placeholder))
		}
		dateFilter += " AND (" + strings.Join(parts, " OR ") + ")"
	}

	filteredSessions := fmt.Sprintf(`
		WITH filtered_sessions AS (
			SELECT ps.id, ps.title, ps.topic, ps.date
			FROM program_sessions ps
			JOIN programs p ON p.id = ps.program_id AND p.account_id = $1 AND ps.account_id = p.account_id
			WHERE p.id = $2 %s
		)
	`, dateFilter)
	sessionQuery := filteredSessions + `
		SELECT fs.id, fs.title, fs.topic, fs.date,
			COUNT(*) FILTER (WHERE pa.status = 'present' AND c.id IS NOT NULL) AS present,
			COUNT(*) FILTER (WHERE pa.status = 'absent' AND c.id IS NOT NULL) AS absent,
			COUNT(*) FILTER (WHERE pa.status = 'late' AND c.id IS NOT NULL) AS late,
			0 AS excused
		FROM filtered_sessions fs
		LEFT JOIN program_participants pp
		  ON pp.program_id = $2
		 AND fs.date >= pp.enrolled_at::date
		 AND fs.date <= COALESCE(
			CASE
			  WHEN pp.dropped_at IS NULL THEN pp.completed_at
			  WHEN pp.completed_at IS NULL THEN pp.dropped_at
			  ELSE LEAST(pp.dropped_at, pp.completed_at)
			END::date,
			'infinity'::date
		 )
		LEFT JOIN contacts c ON c.id = pp.contact_id AND c.account_id = $1
		LEFT JOIN program_attendance pa ON pa.session_id = fs.id AND pa.participant_id = pp.id
		GROUP BY fs.id, fs.title, fs.topic, fs.date
		ORDER BY fs.date ASC
	`
	sessionRows, err := r.db.Query(ctx, sessionQuery, args...)
	if err != nil {
		return nil, nil, err
	}
	defer sessionRows.Close()

	var sessionStats []*domain.ProgramSessionAttendanceStat
	for sessionRows.Next() {
		stat := &domain.ProgramSessionAttendanceStat{}
		var topic *string
		var date time.Time
		if err := sessionRows.Scan(&stat.SessionID, &stat.Title, &topic, &date, &stat.Present, &stat.Absent, &stat.Late, &stat.Excused); err != nil {
			return nil, nil, err
		}
		if topic != nil {
			stat.Topic = *topic
		}
		stat.Date = date.Format("2006-01-02")
		sessionStats = append(sessionStats, stat)
	}
	if err := sessionRows.Err(); err != nil {
		return nil, nil, err
	}

	participantQuery := filteredSessions + `
		SELECT pp.id, COALESCE(c.custom_name, c.name, c.push_name, c.phone, '') as name,
			COUNT(*) FILTER (WHERE pa.status = 'present') as present,
			COUNT(*) FILTER (WHERE pa.status = 'absent') as absent,
			COUNT(*) FILTER (WHERE pa.status = 'late') as late,
			0 as excused,
			COUNT(fs.id)::int as total_sessions,
			COUNT(*) FILTER (WHERE pa.status IN ('present','absent','late'))::int as marked_sessions
		FROM program_participants pp
		JOIN programs p ON p.id = pp.program_id AND p.account_id = $1
		JOIN contacts c ON c.id = pp.contact_id AND c.account_id = p.account_id
		LEFT JOIN filtered_sessions fs
		  ON fs.date >= pp.enrolled_at::date
		 AND fs.date <= COALESCE(
			CASE
			  WHEN pp.dropped_at IS NULL THEN pp.completed_at
			  WHEN pp.completed_at IS NULL THEN pp.dropped_at
			  ELSE LEAST(pp.dropped_at, pp.completed_at)
			END::date,
			'infinity'::date
		 )
		LEFT JOIN program_attendance pa ON pa.participant_id = pp.id AND pa.session_id = fs.id
		WHERE pp.program_id = $2 AND pp.status = 'active'
		GROUP BY pp.id, c.custom_name, c.name, c.push_name, c.phone
		ORDER BY COUNT(*) FILTER (WHERE pa.status = 'present') DESC, name ASC
	`
	participantRows, err := r.db.Query(ctx, participantQuery, args...)
	if err != nil {
		return sessionStats, nil, err
	}
	defer participantRows.Close()

	var participantStats []*domain.ProgramParticipantAttendanceStat
	for participantRows.Next() {
		stat := &domain.ProgramParticipantAttendanceStat{}
		if err := participantRows.Scan(&stat.ParticipantID, &stat.Name, &stat.Present, &stat.Absent, &stat.Late, &stat.Excused, &stat.TotalSessions, &stat.MarkedSessions); err != nil {
			return sessionStats, nil, err
		}
		stat.Pending = stat.TotalSessions - stat.MarkedSessions
		if stat.Pending < 0 {
			stat.Pending = 0
		}
		if stat.MarkedSessions > 0 {
			stat.Rate = float64(stat.Present+stat.Late) / float64(stat.MarkedSessions) * 100
		}
		participantStats = append(participantStats, stat)
	}
	if err := participantRows.Err(); err != nil {
		return sessionStats, nil, err
	}

	return sessionStats, participantStats, nil
}

// --- Goals, Health and Bitacora ---

func normalizeGoalPercent(v int, fallback int) int {
	if v <= 0 {
		return fallback
	}
	if v > 100 {
		return 100
	}
	return v
}

func (r *ProgramRepository) GetProgramGoals(ctx context.Context, accountID uuid.UUID, programID *uuid.UUID) (*domain.ProgramGoal, error) {
	goal := &domain.ProgramGoal{
		AccountID:             accountID,
		ProgramID:             programID,
		AttendanceGoalPercent: 80,
		TransferGoalPercent:   70,
	}
	if programID != nil {
		err := r.db.QueryRow(ctx, `
			SELECT id, account_id, program_id, attendance_goal_percent, transfer_goal_percent, created_at, updated_at
			FROM program_goals
			WHERE account_id = $1 AND program_id = $2
		`, accountID, *programID).Scan(&goal.ID, &goal.AccountID, &goal.ProgramID, &goal.AttendanceGoalPercent, &goal.TransferGoalPercent, &goal.CreatedAt, &goal.UpdatedAt)
		if err == nil {
			return goal, nil
		}
		if err != pgx.ErrNoRows {
			return nil, err
		}
	}
	err := r.db.QueryRow(ctx, `
		SELECT id, account_id, program_id, attendance_goal_percent, transfer_goal_percent, created_at, updated_at
		FROM program_goals
		WHERE account_id = $1 AND program_id IS NULL
	`, accountID).Scan(&goal.ID, &goal.AccountID, &goal.ProgramID, &goal.AttendanceGoalPercent, &goal.TransferGoalPercent, &goal.CreatedAt, &goal.UpdatedAt)
	if err == pgx.ErrNoRows {
		goal.ProgramID = programID
		return goal, nil
	}
	if err != nil {
		return nil, err
	}
	goal.ProgramID = programID
	return goal, nil
}

func (r *ProgramRepository) UpsertProgramGoals(ctx context.Context, goal *domain.ProgramGoal) error {
	goal.AttendanceGoalPercent = normalizeGoalPercent(goal.AttendanceGoalPercent, 80)
	goal.TransferGoalPercent = normalizeGoalPercent(goal.TransferGoalPercent, 70)
	if goal.ProgramID != nil {
		var exists bool
		if err := r.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM programs WHERE id = $1 AND account_id = $2)`, *goal.ProgramID, goal.AccountID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return pgx.ErrNoRows
		}
		var id uuid.UUID
		err := r.db.QueryRow(ctx, `SELECT id FROM program_goals WHERE account_id = $1 AND program_id = $2`, goal.AccountID, *goal.ProgramID).Scan(&id)
		if err == nil {
			return r.db.QueryRow(ctx, `
				UPDATE program_goals
				SET attendance_goal_percent = $1, transfer_goal_percent = $2, updated_at = NOW()
				WHERE id = $3
				RETURNING id, created_at, updated_at
			`, goal.AttendanceGoalPercent, goal.TransferGoalPercent, id).Scan(&goal.ID, &goal.CreatedAt, &goal.UpdatedAt)
		}
		if err != pgx.ErrNoRows {
			return err
		}
		return r.db.QueryRow(ctx, `
			INSERT INTO program_goals (account_id, program_id, attendance_goal_percent, transfer_goal_percent)
			VALUES ($1, $2, $3, $4)
			RETURNING id, created_at, updated_at
		`, goal.AccountID, *goal.ProgramID, goal.AttendanceGoalPercent, goal.TransferGoalPercent).Scan(&goal.ID, &goal.CreatedAt, &goal.UpdatedAt)
	}

	var id uuid.UUID
	err := r.db.QueryRow(ctx, `SELECT id FROM program_goals WHERE account_id = $1 AND program_id IS NULL`, goal.AccountID).Scan(&id)
	if err == nil {
		return r.db.QueryRow(ctx, `
			UPDATE program_goals
			SET attendance_goal_percent = $1, transfer_goal_percent = $2, updated_at = NOW()
			WHERE id = $3
			RETURNING id, created_at, updated_at
		`, goal.AttendanceGoalPercent, goal.TransferGoalPercent, id).Scan(&goal.ID, &goal.CreatedAt, &goal.UpdatedAt)
	}
	if err != pgx.ErrNoRows {
		return err
	}
	return r.db.QueryRow(ctx, `
		INSERT INTO program_goals (account_id, attendance_goal_percent, transfer_goal_percent)
		VALUES ($1, $2, $3)
		RETURNING id, created_at, updated_at
	`, goal.AccountID, goal.AttendanceGoalPercent, goal.TransferGoalPercent).Scan(&goal.ID, &goal.CreatedAt, &goal.UpdatedAt)
}

func (r *ProgramRepository) UpdateParticipantOutcome(ctx context.Context, accountID, programID, participantID uuid.UUID, status string, droppedAt *time.Time, dropReason, dropNotes string, completedAt *time.Time, transferredToLevel string, transferredAt *time.Time) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var enrolledAt time.Time
	var currentStatus string
	if err := tx.QueryRow(ctx, `
		SELECT pp.enrolled_at, pp.status
		FROM program_participants pp
		JOIN programs p ON p.id = pp.program_id AND p.account_id = $1
		WHERE pp.program_id = $2 AND pp.id = $3
		FOR UPDATE OF pp
	`, accountID, programID, participantID).Scan(&enrolledAt, &currentStatus); errors.Is(err, pgx.ErrNoRows) {
		return ErrProgramParticipantNotFound
	} else if err != nil {
		return err
	}
	if currentStatus != "active" {
		return ErrProgramParticipantAlreadyEnded
	}
	endedAt := completedAt
	if status == "dropped" {
		endedAt = droppedAt
	}
	if endedAt == nil || endedAt.Before(time.Date(enrolledAt.Year(), enrolledAt.Month(), enrolledAt.Day(), 0, 0, 0, 0, enrolledAt.Location())) {
		return ErrProgramParticipantEndBeforeEnrollment
	}

	command, err := tx.Exec(ctx, `
		UPDATE program_participants pp
		SET status = $1,
		    dropped_at = $2,
		    drop_reason = $3,
		    drop_notes = $4,
		    completed_at = $5,
		    transferred_to_level = $6,
		    transferred_at = $7
		FROM programs p
		WHERE p.id = pp.program_id
		  AND p.account_id = $8
		  AND pp.program_id = $9
		  AND pp.id = $10
	`, status, droppedAt, dropReason, dropNotes, completedAt, transferredToLevel, transferredAt, accountID, programID, participantID)
	if err != nil {
		return err
	}
	if command.RowsAffected() == 0 {
		return ErrProgramParticipantNotFound
	}
	return tx.Commit(ctx)
}

func (r *ProgramRepository) CreateParticipantNote(ctx context.Context, note *domain.ProgramParticipantNote) error {
	if note.Type == "" {
		note.Type = "note"
	}
	err := r.db.QueryRow(ctx, `
		INSERT INTO program_participant_notes (account_id, program_id, participant_id, contact_id, session_id, type, note, outcome, follow_up_at, created_by)
		SELECT $1, pp.program_id, pp.id, pp.contact_id, $5, $6, $7, $8, $9, $10
		FROM program_participants pp
		JOIN programs p ON p.id = pp.program_id
		WHERE p.account_id = $1 AND pp.program_id = $2 AND pp.id = $3 AND pp.contact_id = $4
		RETURNING id, created_at, updated_at
	`, note.AccountID, note.ProgramID, note.ParticipantID, note.ContactID, note.SessionID, note.Type, note.Note, note.Outcome, note.FollowUpAt, note.CreatedBy).Scan(&note.ID, &note.CreatedAt, &note.UpdatedAt)
	return err
}

func (r *ProgramRepository) ListParticipantNotes(ctx context.Context, accountID, programID uuid.UUID, participantID *uuid.UUID) ([]*domain.ProgramParticipantNote, error) {
	args := []interface{}{accountID, programID}
	where := "pn.account_id = $1 AND pn.program_id = $2"
	if participantID != nil {
		args = append(args, *participantID)
		where += fmt.Sprintf(" AND pn.participant_id = $%d", len(args))
	}
	rows, err := r.db.Query(ctx, fmt.Sprintf(`
		SELECT pn.id, pn.account_id, pn.program_id, pn.participant_id, pn.contact_id, pn.session_id, pn.type, pn.note,
		       pn.outcome, pn.follow_up_at, pn.created_by, pn.created_at, pn.updated_at,
		       COALESCE(c.custom_name, c.name, c.push_name, c.phone, '') AS participant_name,
		       COALESCE(u.display_name, u.username, '') AS created_by_name
		FROM program_participant_notes pn
		JOIN contacts c ON c.id = pn.contact_id
		LEFT JOIN users u ON u.id = pn.created_by
		WHERE %s
		ORDER BY pn.created_at DESC
		LIMIT 500
	`, where), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var notes []*domain.ProgramParticipantNote
	for rows.Next() {
		n := &domain.ProgramParticipantNote{}
		if err := rows.Scan(&n.ID, &n.AccountID, &n.ProgramID, &n.ParticipantID, &n.ContactID, &n.SessionID, &n.Type, &n.Note, &n.Outcome, &n.FollowUpAt, &n.CreatedBy, &n.CreatedAt, &n.UpdatedAt, &n.ParticipantName, &n.CreatedByName); err != nil {
			return nil, err
		}
		notes = append(notes, n)
	}
	return notes, nil
}

func (r *ProgramRepository) GetProgramHealth(ctx context.Context, accountID, programID uuid.UUID) (*domain.ProgramHealthSummary, error) {
	program, err := r.GetByID(ctx, accountID, programID)
	if err != nil || program == nil {
		return nil, err
	}
	goal, err := r.GetProgramGoals(ctx, accountID, &programID)
	if err != nil {
		return nil, err
	}
	var sessionCount, recoverySessionCount int
	if err := r.db.QueryRow(ctx, `
		SELECT COUNT(*), COUNT(*) FILTER (WHERE session_type = 'recovery')
		FROM program_sessions
		WHERE account_id = $1 AND program_id = $2 AND date <= CURRENT_DATE
	`, accountID, programID).Scan(&sessionCount, &recoverySessionCount); err != nil {
		return nil, err
	}
	var activeCount, completedCount, droppedCount, transferredCount int
	if err := r.db.QueryRow(ctx, `
		SELECT COUNT(*) FILTER (WHERE pp.status = 'active'),
		       COUNT(*) FILTER (WHERE pp.status = 'completed'),
		       COUNT(*) FILTER (WHERE pp.status = 'dropped'),
		       COUNT(*) FILTER (WHERE COALESCE(pp.transferred_to_level, '') <> '')
		FROM program_participants pp
		JOIN programs p ON p.id = pp.program_id AND p.account_id = $1
		WHERE pp.program_id = $2
	`, accountID, programID).Scan(&activeCount, &completedCount, &droppedCount, &transferredCount); err != nil {
		return nil, err
	}

	rows, err := r.db.Query(ctx, `
		SELECT pp.id, pp.contact_id, COALESCE(c.custom_name, c.name, c.push_name, c.phone, '') AS name, c.phone,
		       c.avatar_url, COALESCE(c.avatar_revision, 0),
		       pp.status, COALESCE(pp.transferred_to_level, ''),
		       COUNT(*) FILTER (WHERE pa.status = 'present')::int,
		       COUNT(*) FILTER (WHERE pa.status = 'late')::int,
		       COUNT(*) FILTER (WHERE pa.status = 'absent')::int,
		       0 AS excused,
		       COUNT(ps.id)::int AS eligible_sessions,
		       COUNT(*) FILTER (WHERE pa.status IN ('present','absent','late'))::int AS marked_sessions,
		       COUNT(*) FILTER (WHERE ps.session_type = 'recovery' AND pa.status IN ('present','late'))::int AS recovery_sessions,
		       COALESCE(notes.notes_count, 0), notes.last_note_at
		FROM program_participants pp
		JOIN programs p ON p.id = pp.program_id AND p.account_id = $1
		JOIN contacts c ON c.id = pp.contact_id AND c.account_id = p.account_id
		LEFT JOIN program_sessions ps
		  ON ps.account_id = p.account_id AND ps.program_id = pp.program_id
		 AND ps.date <= CURRENT_DATE
		 AND ps.date >= pp.enrolled_at::date
		 AND ps.date <= COALESCE(
			CASE
			  WHEN pp.dropped_at IS NULL THEN pp.completed_at
			  WHEN pp.completed_at IS NULL THEN pp.dropped_at
			  ELSE LEAST(pp.dropped_at, pp.completed_at)
			END::date,
			'infinity'::date
		 )
		LEFT JOIN program_attendance pa ON pa.session_id = ps.id AND pa.participant_id = pp.id
		LEFT JOIN LATERAL (
			SELECT COUNT(*)::int AS notes_count, MAX(event.created_at) AS last_note_at
			FROM (
				SELECT i.created_at
				FROM interactions i
				WHERE i.account_id = p.account_id
				  AND i.program_id = p.id
				  AND i.program_participant_id = pp.id
				UNION ALL
				SELECT pn.created_at
				FROM program_participant_notes pn
				WHERE pn.account_id = p.account_id
				  AND pn.program_id = p.id
				  AND pn.participant_id = pp.id
			) event
		) notes ON TRUE
		WHERE pp.program_id = $2 AND pp.status = 'active'
		GROUP BY pp.id, pp.contact_id, c.custom_name, c.name, c.push_name, c.phone,
		         c.avatar_url, c.avatar_revision, pp.status, pp.transferred_to_level,
		         notes.notes_count, notes.last_note_at
		ORDER BY COALESCE(c.custom_name, c.name, c.push_name, c.phone) ASC
	`, accountID, programID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	summary := &domain.ProgramHealthSummary{
		ProgramID:             programID,
		AttendanceGoalPercent: goal.AttendanceGoalPercent,
		TransferGoalPercent:   goal.TransferGoalPercent,
		SessionCount:          sessionCount,
		RecoverySessionCount:  recoverySessionCount,
		ActiveCount:           activeCount,
		CompletedCount:        completedCount,
		DroppedCount:          droppedCount,
		TransferredCount:      transferredCount,
		Health:                "healthy",
		Participants:          make([]*domain.ProgramHealthParticipant, 0),
	}
	var presentTotal, lateTotal, absentTotal int
	for rows.Next() {
		p := &domain.ProgramHealthParticipant{}
		if err := rows.Scan(&p.ParticipantID, &p.ContactID, &p.Name, &p.Phone, &p.AvatarURL, &p.AvatarRevision, &p.Status, &p.TransferredToLevel, &p.Present, &p.Late, &p.Absent, &p.Excused, &p.EligibleSessions, &p.MarkedSessions, &p.RecoverySessions, &p.NotesCount, &p.LastNoteAt); err != nil {
			return nil, err
		}
		p.Pending = p.EligibleSessions - p.MarkedSessions
		if p.Pending < 0 {
			p.Pending = 0
		}
		if p.MarkedSessions > 0 {
			p.AttendanceRate = float64(p.Present+p.Late) / float64(p.MarkedSessions) * 100
		}
		unresolvedAbsences := p.Absent - p.RecoverySessions
		if unresolvedAbsences < 0 {
			unresolvedAbsences = 0
		}
		p.Health = "healthy"
		if unresolvedAbsences >= 2 {
			p.Health = "critical"
			p.Reasons = append(p.Reasons, fmt.Sprintf("%d faltas no regularizadas", unresolvedAbsences))
		} else if unresolvedAbsences == 1 && p.Health == "healthy" {
			p.Health = "watch"
			p.Reasons = append(p.Reasons, "una falta pendiente")
		}
		if p.MarkedSessions > 0 && p.AttendanceRate < float64(goal.AttendanceGoalPercent) && p.Health == "healthy" {
			p.Health = "watch"
			p.Reasons = append(p.Reasons, "asistencia bajo la meta")
		}
		if unresolvedAbsences > 0 && p.NotesCount == 0 {
			if p.Health == "healthy" {
				p.Health = "watch"
			}
			p.Reasons = append(p.Reasons, "sin seguimiento registrado")
		}
		if len(p.Reasons) == 0 {
			if p.Pending > 0 {
				p.Reasons = append(p.Reasons, fmt.Sprintf("%d sesiones pendientes de registrar", p.Pending))
			} else {
				p.Reasons = append(p.Reasons, "sin alertas")
			}
		}
		presentTotal += p.Present
		lateTotal += p.Late
		absentTotal += p.Absent
		summary.Participants = append(summary.Participants, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	summary.ParticipantCount = activeCount
	markedTotal := presentTotal + lateTotal + absentTotal
	if markedTotal > 0 {
		summary.AttendanceRate = float64(presentTotal+lateTotal) / float64(markedTotal) * 100
	}
	if summary.CompletedCount > 0 {
		summary.TransferRate = float64(summary.TransferredCount) / float64(summary.CompletedCount) * 100
	}
	summary.Health = "healthy"
	for _, p := range summary.Participants {
		if p.Health == "critical" {
			summary.Health = "critical"
			break
		}
		if p.Health == "watch" && summary.Health == "healthy" {
			summary.Health = "watch"
		}
	}
	if summary.AttendanceRate < float64(goal.AttendanceGoalPercent) && markedTotal > 0 {
		summary.Reasons = append(summary.Reasons, "asistencia grupal bajo la meta")
		if summary.Health == "healthy" {
			summary.Health = "watch"
		}
	}
	if summary.TransferRate < float64(goal.TransferGoalPercent) && summary.CompletedCount > 0 {
		summary.Reasons = append(summary.Reasons, "traspaso bajo la meta")
	}
	if len(summary.Reasons) == 0 {
		summary.Reasons = append(summary.Reasons, "grupo estable")
	}
	return summary, nil
}

func (r *ProgramRepository) GetProgramsDashboard(ctx context.Context, accountID uuid.UUID, from, to *time.Time) (*domain.ProgramDashboardSummary, error) {
	globalGoal, err := r.GetProgramGoals(ctx, accountID, nil)
	if err != nil {
		return nil, err
	}
	args := []interface{}{accountID, from, to}
	rows, err := r.db.Query(ctx, `
		WITH fp AS (
			SELECT p.*
		FROM programs p
			WHERE p.account_id = $1
			  AND p.type = 'course'
			  AND p.status = 'active'
			  AND ($2::date IS NULL OR p.created_at::date >= $2::date OR EXISTS (SELECT 1 FROM program_sessions ps WHERE ps.program_id = p.id AND ps.date >= $2::date))
			  AND ($3::date IS NULL OR p.created_at::date <= $3::date OR EXISTS (SELECT 1 FROM program_sessions ps WHERE ps.program_id = p.id AND ps.date <= $3::date))
		),
			sessions AS (
				SELECT ps.program_id, COUNT(*) AS session_count
				FROM program_sessions ps
				JOIN fp ON fp.id = ps.program_id
				WHERE ps.account_id = $1
				  AND ps.date <= CURRENT_DATE
				  AND ($2::date IS NULL OR ps.date >= $2::date)
				  AND ($3::date IS NULL OR ps.date <= $3::date)
				GROUP BY ps.program_id
			),
			eligible_slots AS (
				SELECT ps.program_id, ps.id AS session_id, pp.id AS participant_id, pa.status
				FROM program_sessions ps
				JOIN fp ON fp.id = ps.program_id AND ps.account_id = fp.account_id
				JOIN program_participants pp ON pp.program_id = ps.program_id AND pp.status = 'active'
				LEFT JOIN program_attendance pa ON pa.session_id = ps.id AND pa.participant_id = pp.id
				WHERE ps.date <= CURRENT_DATE
				  AND ($2::date IS NULL OR ps.date >= $2::date)
				  AND ($3::date IS NULL OR ps.date <= $3::date)
				  AND ps.date >= pp.enrolled_at::date
				  AND ps.date <= COALESCE(
					CASE
					  WHEN pp.dropped_at IS NULL THEN pp.completed_at
					  WHEN pp.completed_at IS NULL THEN pp.dropped_at
					  ELSE LEAST(pp.dropped_at, pp.completed_at)
					END::date,
					'infinity'::date
				  )
			),
			participant_att AS (
				SELECT program_id, participant_id,
				       COUNT(*) FILTER (WHERE status = 'present') AS present,
				       COUNT(*) FILTER (WHERE status = 'late') AS late,
				       COUNT(*) FILTER (WHERE status = 'absent') AS absent,
				       COUNT(*) FILTER (WHERE status IN ('present','late','absent')) AS marked
				FROM eligible_slots
				GROUP BY program_id, participant_id
			),
			att AS (
				SELECT program_id,
				       SUM(present)::int AS present,
				       SUM(late)::int AS late,
				       SUM(absent)::int AS absent,
				       SUM(marked)::int AS marked,
				       COUNT(*) FILTER (WHERE absent > 0)::int AS absent_people,
				       COUNT(*) FILTER (WHERE absent >= 2)::int AS critical_people
				FROM participant_att
				GROUP BY program_id
			),
			pp AS (
				SELECT pp.program_id,
				       COUNT(*) FILTER (WHERE pp.status = 'active') AS participant_count,
				       COUNT(*) FILTER (WHERE pp.status = 'active') AS active_count,
			       COUNT(*) FILTER (WHERE pp.status = 'completed') AS completed_count,
			       COUNT(*) FILTER (WHERE pp.status = 'dropped') AS dropped_count,
			       COUNT(*) FILTER (WHERE COALESCE(pp.transferred_to_level, '') <> '') AS transferred_count
			FROM program_participants pp
			JOIN fp ON fp.id = pp.program_id
			GROUP BY pp.program_id
		)
		SELECT fp.id, fp.name, fp.status, fp.color,
		       COALESCE(pp.participant_count, 0), COALESCE(pp.active_count, 0), COALESCE(pp.completed_count, 0),
		       COALESCE(pp.dropped_count, 0), COALESCE(pp.transferred_count, 0), COALESCE(sessions.session_count, 0),
		       COALESCE(att.present, 0), COALESCE(att.late, 0), COALESCE(att.marked, 0),
		       COALESCE(att.absent_people, 0), COALESCE(att.critical_people, 0),
		       COALESCE(pg.attendance_goal_percent, gg.attendance_goal_percent, 80),
		       COALESCE(pg.transfer_goal_percent, gg.transfer_goal_percent, 70)
		FROM fp
		LEFT JOIN pp ON pp.program_id = fp.id
		LEFT JOIN sessions ON sessions.program_id = fp.id
		LEFT JOIN att ON att.program_id = fp.id
		LEFT JOIN program_goals pg ON pg.account_id = $1 AND pg.program_id = fp.id
		LEFT JOIN program_goals gg ON gg.account_id = $1 AND gg.program_id IS NULL
		ORDER BY fp.created_at DESC
	`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	summary := &domain.ProgramDashboardSummary{
		From:                  from,
		To:                    to,
		AttendanceGoalPercent: globalGoal.AttendanceGoalPercent,
		TransferGoalPercent:   globalGoal.TransferGoalPercent,
	}
	var totalAttended, totalMarked int
	for rows.Next() {
		g := &domain.ProgramDashboardGroup{}
		var present, late, marked, absentPeople, criticalPeople int
		if err := rows.Scan(&g.ProgramID, &g.Name, &g.Status, &g.Color, &g.ParticipantCount, &g.ActiveCount, &g.CompletedCount, &g.DroppedCount, &g.TransferredCount, &g.SessionCount, &present, &late, &marked, &absentPeople, &criticalPeople, &g.AttendanceGoalPercent, &g.TransferGoalPercent); err != nil {
			return nil, err
		}
		if marked > 0 {
			g.AttendanceRate = float64(present+late) / float64(marked) * 100
		}
		if g.CompletedCount > 0 {
			g.TransferRate = float64(g.TransferredCount) / float64(g.CompletedCount) * 100
		}
		g.AtRiskCount = absentPeople
		g.Health = "healthy"
		if g.AtRiskCount > 0 || (marked > 0 && g.AttendanceRate < float64(g.AttendanceGoalPercent)) {
			g.Health = "watch"
		}
		if criticalPeople > 0 || (marked > 0 && g.AttendanceRate < float64(g.AttendanceGoalPercent-10)) {
			g.Health = "critical"
		}
		if marked > 0 && g.AttendanceRate < float64(g.AttendanceGoalPercent) {
			summary.GroupsBelowGoal++
		}
		summary.ProgramCount++
		if g.Status == "active" {
			summary.ActiveProgramCount++
		}
		summary.ParticipantCount += g.ParticipantCount
		summary.CompletedCount += g.CompletedCount
		summary.DroppedCount += g.DroppedCount
		summary.TransferredCount += g.TransferredCount
		summary.CriticalParticipants += g.AtRiskCount
		totalAttended += present + late
		totalMarked += marked
		summary.Groups = append(summary.Groups, g)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if totalMarked > 0 {
		summary.AttendanceRate = float64(totalAttended) / float64(totalMarked) * 100
	}
	if summary.CompletedCount > 0 {
		summary.TransferRate = float64(summary.TransferredCount) / float64(summary.CompletedCount) * 100
	}
	return summary, nil
}
