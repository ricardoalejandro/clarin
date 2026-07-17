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

// --- Programs ---

func (r *ProgramRepository) Create(ctx context.Context, p *domain.Program) error {
	if p.Type == "" {
		p.Type = "course"
	}
	if p.TagFormulaMode == "" {
		p.TagFormulaMode = "OR"
	}
	if p.TagFormulaType == "" {
		p.TagFormulaType = "simple"
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

func (r *ProgramRepository) GetByID(ctx context.Context, accountID, id uuid.UUID) (*domain.Program, error) {
	p := &domain.Program{}
	err := r.db.QueryRow(ctx, `
SELECT p.id, p.account_id, p.type, p.name, p.description, p.status, p.color, p.created_by, p.folder_id, p.created_at, p.updated_at,
p.schedule_start_date, p.schedule_end_date, p.schedule_days, p.schedule_start_time, p.schedule_end_time,
p.pipeline_id, COALESCE(p.tag_formula, ''), COALESCE(p.tag_formula_mode, 'OR'), COALESCE(p.tag_formula_type, 'simple'),
p.event_date, p.event_end, p.location, ep.name as pipeline_name,
(SELECT COUNT(*) FROM program_participants WHERE program_id = p.id) as participant_count,
(SELECT COUNT(*) FROM program_sessions WHERE program_id = p.id) as session_count
FROM programs p
LEFT JOIN event_pipelines ep ON ep.id = p.pipeline_id
WHERE p.id = $1 AND p.account_id = $2
`, id, accountID).Scan(
		&p.ID, &p.AccountID, &p.Type, &p.Name, &p.Description, &p.Status, &p.Color, &p.CreatedBy, &p.FolderID, &p.CreatedAt, &p.UpdatedAt,
		&p.ScheduleStartDate, &p.ScheduleEndDate, &p.ScheduleDays, &p.ScheduleStartTime, &p.ScheduleEndTime,
		&p.PipelineID, &p.TagFormula, &p.TagFormulaMode, &p.TagFormulaType,
		&p.EventDate, &p.EventEnd, &p.Location, &p.PipelineName,
		&p.ParticipantCount, &p.SessionCount,
	)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	return p, err
}

func (r *ProgramRepository) List(ctx context.Context, accountID uuid.UUID, status string) ([]*domain.Program, error) {
	query := `
SELECT p.id, p.account_id, p.type, p.name, p.description, p.status, p.color, p.created_by, p.folder_id, p.created_at, p.updated_at,
p.schedule_start_date, p.schedule_end_date, p.schedule_days, p.schedule_start_time, p.schedule_end_time,
p.pipeline_id, COALESCE(p.tag_formula, ''), COALESCE(p.tag_formula_mode, 'OR'), COALESCE(p.tag_formula_type, 'simple'),
p.event_date, p.event_end, p.location, ep.name as pipeline_name,
(SELECT COUNT(*) FROM program_participants WHERE program_id = p.id) as participant_count,
(SELECT COUNT(*) FROM program_sessions WHERE program_id = p.id) as session_count
FROM programs p
LEFT JOIN event_pipelines ep ON ep.id = p.pipeline_id
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

func (r *ProgramRepository) AddParticipant(ctx context.Context, pp *domain.ProgramParticipant) error {
	err := r.db.QueryRow(ctx, `
INSERT INTO program_participants (program_id, contact_id, stage_id, status, auto_tag_sync)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (program_id, contact_id) DO UPDATE SET
status = EXCLUDED.status,
stage_id = COALESCE(EXCLUDED.stage_id, program_participants.stage_id),
auto_tag_sync = EXCLUDED.auto_tag_sync
RETURNING id, enrolled_at
`, pp.ProgramID, pp.ContactID, pp.StageID, pp.Status, pp.AutoTagSync).Scan(&pp.ID, &pp.EnrolledAt)
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

func (r *ProgramRepository) UpdateParticipantStage(ctx context.Context, programID, participantID uuid.UUID, stageID *uuid.UUID) error {
	_, err := r.db.Exec(ctx, `
UPDATE program_participants SET stage_id = $1 WHERE id = $2 AND program_id = $3
`, stageID, participantID, programID)
	return err
}

func (r *ProgramRepository) ListParticipants(ctx context.Context, accountID, programID uuid.UUID) ([]*domain.ProgramParticipant, error) {
	rows, err := r.db.Query(ctx, `
SELECT pp.id, pp.program_id, pp.contact_id, pp.stage_id, pp.status, pp.enrolled_at,
pp.dropped_at, COALESCE(pp.drop_reason, ''), COALESCE(pp.drop_notes, ''), pp.completed_at,
COALESCE(pp.transferred_to_level, ''), pp.transferred_at, COALESCE(pp.auto_tag_sync, false),
COALESCE(c.custom_name, c.name, c.push_name, c.phone, '') as display_name, c.phone,
c.avatar_url, COALESCE(c.avatar_revision, 0),
s.name as stage_name, s.color as stage_color
FROM program_participants pp
JOIN programs p ON p.id = pp.program_id AND p.account_id = $1
JOIN contacts c ON c.id = pp.contact_id AND c.account_id = p.account_id
LEFT JOIN event_pipeline_stages s ON s.id = pp.stage_id
WHERE pp.program_id = $2
ORDER BY COALESCE(c.custom_name, c.name, c.push_name, c.phone) ASC
`, accountID, programID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var participants []*domain.ProgramParticipant
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

func (r *ProgramRepository) RemoveParticipant(ctx context.Context, programID, participantID uuid.UUID) error {
	_, err := r.db.Exec(ctx, "DELETE FROM program_participants WHERE id = $1 AND program_id = $2", participantID, programID)
	return err
}

// --- Sessions ---

func (r *ProgramRepository) CreateSession(ctx context.Context, s *domain.ProgramSession) error {
	if s.SessionType == "" {
		s.SessionType = "regular"
	}
	err := r.db.QueryRow(ctx, `
INSERT INTO program_sessions (program_id, date, topic, session_type, start_time, end_time, location)
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING id, created_at, updated_at
`, s.ProgramID, s.Date, s.Topic, s.SessionType, s.StartTime, s.EndTime, s.Location).Scan(&s.ID, &s.CreatedAt, &s.UpdatedAt)
	return err
}

func (r *ProgramRepository) ListSessions(ctx context.Context, programID uuid.UUID) ([]*domain.ProgramSession, error) {
	rows, err := r.db.Query(ctx, `
SELECT id, program_id, date, topic, COALESCE(session_type, 'regular'), start_time, end_time, location, created_at, updated_at
FROM program_sessions
WHERE program_id = $1
ORDER BY date ASC
`, programID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var sessions []*domain.ProgramSession
	for rows.Next() {
		s := &domain.ProgramSession{}
		err := rows.Scan(&s.ID, &s.ProgramID, &s.Date, &s.Topic, &s.SessionType, &s.StartTime, &s.EndTime, &s.Location, &s.CreatedAt, &s.UpdatedAt)
		if err != nil {
			return nil, err
		}

		// Get attendance stats
		statsRows, err := r.db.Query(ctx, `
SELECT status, COUNT(*) FROM program_attendance WHERE session_id = $1 GROUP BY status
`, s.ID)
		if err == nil {
			s.AttendanceStats = make(map[string]int)
			for statsRows.Next() {
				var status string
				var count int
				if err := statsRows.Scan(&status, &count); err == nil {
					s.AttendanceStats[status] = count
				}
			}
			statsRows.Close()
		}

		sessions = append(sessions, s)
	}
	return sessions, nil
}

func (r *ProgramRepository) UpdateSession(ctx context.Context, s *domain.ProgramSession) error {
	if s.SessionType == "" {
		s.SessionType = "regular"
	}
	_, err := r.db.Exec(ctx, `
UPDATE program_sessions
SET date = $1, topic = $2, session_type = $3, start_time = $4, end_time = $5, location = $6, updated_at = NOW()
WHERE id = $7 AND program_id = $8
`, s.Date, s.Topic, s.SessionType, s.StartTime, s.EndTime, s.Location, s.ID, s.ProgramID)
	return err
}

func (r *ProgramRepository) DeleteSession(ctx context.Context, programID, sessionID uuid.UUID) error {
	_, err := r.db.Exec(ctx, "DELETE FROM program_sessions WHERE id = $1 AND program_id = $2", sessionID, programID)
	return err
}

// --- Attendance ---

func (r *ProgramRepository) BatchMarkAttendance(ctx context.Context, accountID, userID, programID, sessionID uuid.UUID, attendances []*domain.ProgramAttendance) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	var programName, sessionTopic string
	var sessionDate time.Time
	if err := tx.QueryRow(ctx, `
		SELECT p.name, COALESCE(NULLIF(ps.topic, ''), 'Sesión'), ps.date
		FROM program_sessions ps
		JOIN programs p ON p.id = ps.program_id
		WHERE p.account_id = $1 AND p.id = $2 AND ps.id = $3
		FOR SHARE
	`, accountID, programID, sessionID).Scan(&programName, &sessionTopic, &sessionDate); err != nil {
		if err == pgx.ErrNoRows {
			return errors.New("session does not belong to this account and program")
		}
		return err
	}

	for _, a := range attendances {
		var contactID uuid.UUID
		if err := tx.QueryRow(ctx, `
			SELECT pp.contact_id
			FROM program_participants pp
			JOIN programs p ON p.id = pp.program_id
			JOIN contacts c ON c.id = pp.contact_id AND c.account_id = p.account_id
			WHERE p.account_id = $1 AND pp.program_id = $2 AND pp.id = $3
		`, accountID, programID, a.ParticipantID).Scan(&contactID); err != nil {
			if err == pgx.ErrNoRows {
				return fmt.Errorf("participant %s does not belong to this account and program", a.ParticipantID)
			}
			return err
		}

		notes := ""
		if a.Notes != nil {
			notes = strings.TrimSpace(*a.Notes)
		}
		if a.Status == "" && notes == "" {
			if _, err := tx.Exec(ctx, `DELETE FROM interactions WHERE account_id=$1 AND type='attendance' AND program_session_id=$2 AND program_participant_id=$3`, accountID, sessionID, a.ParticipantID); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `DELETE FROM program_attendance WHERE session_id=$1 AND participant_id=$2`, sessionID, a.ParticipantID); err != nil {
				return err
			}
			continue
		}

		if err := tx.QueryRow(ctx, `
			INSERT INTO program_attendance (session_id, participant_id, status, notes)
			VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''))
			ON CONFLICT (session_id, participant_id) DO UPDATE
			SET status = NULLIF(EXCLUDED.status, ''), notes = EXCLUDED.notes, updated_at = NOW()
			RETURNING id, created_at, updated_at
		`, sessionID, a.ParticipantID, a.Status, notes).Scan(&a.ID, &a.CreatedAt, &a.UpdatedAt); err != nil {
			return err
		}

		if notes == "" {
			if _, err := tx.Exec(ctx, `DELETE FROM interactions WHERE account_id=$1 AND type='attendance' AND program_session_id=$2 AND program_participant_id=$3`, accountID, sessionID, a.ParticipantID); err != nil {
				return err
			}
			continue
		}

		sourceLabel := fmt.Sprintf("%s · %s · %s", programName, sessionTopic, sessionDate.Format("02/01/2006"))
		if _, err := tx.Exec(ctx, `
			INSERT INTO interactions (account_id, contact_id, type, notes, created_by, program_id, program_session_id, program_participant_id, source_label)
			VALUES ($1, $2, 'attendance', $3, $4, $5, $6, $7, $8)
			ON CONFLICT (program_session_id, program_participant_id)
			WHERE type = 'attendance' AND program_session_id IS NOT NULL AND program_participant_id IS NOT NULL
			DO UPDATE SET contact_id=EXCLUDED.contact_id, notes=EXCLUDED.notes,
			              source_label=EXCLUDED.source_label,
			              created_by=COALESCE(interactions.created_by, EXCLUDED.created_by)
		`, accountID, contactID, notes, userID, programID, sessionID, a.ParticipantID, sourceLabel); err != nil {
			return err
		}
	}

	return tx.Commit(ctx)
}

func (r *ProgramRepository) GetAttendanceBySession(ctx context.Context, sessionID uuid.UUID) ([]*domain.ProgramAttendance, error) {
	rows, err := r.db.Query(ctx, `
SELECT a.id, a.session_id, a.participant_id, COALESCE(a.status, ''), a.notes,
a.created_at, a.updated_at,
c.name, c.phone
FROM program_attendance a
JOIN program_participants pp ON pp.id = a.participant_id
JOIN contacts c ON c.id = pp.contact_id
WHERE a.session_id = $1
`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var attendance []*domain.ProgramAttendance
	for rows.Next() {
		a := &domain.ProgramAttendance{}
		err := rows.Scan(
			&a.ID, &a.SessionID, &a.ParticipantID, &a.Status, &a.Notes, &a.CreatedAt, &a.UpdatedAt,
			&a.ParticipantName, &a.ParticipantPhone,
		)
		if err != nil {
			return nil, err
		}
		attendance = append(attendance, a)
	}
	return attendance, nil
}

func (r *ProgramRepository) GetParticipantsByAttendanceStatus(ctx context.Context, sessionID uuid.UUID, status string) ([]*domain.ProgramParticipant, error) {
	query := `
SELECT pp.id, pp.program_id, pp.contact_id, pp.status, pp.enrolled_at,
c.name, c.phone
FROM program_participants pp
JOIN contacts c ON c.id = pp.contact_id
JOIN program_attendance a ON a.participant_id = pp.id
WHERE a.session_id = $1 AND a.status = $2
`

	// If status is "unmarked", we need to find participants who don't have an attendance record for this session
	if status == "unmarked" {
		query = `
SELECT pp.id, pp.program_id, pp.contact_id, pp.status, pp.enrolled_at,
c.name, c.phone
FROM program_participants pp
JOIN contacts c ON c.id = pp.contact_id
JOIN program_sessions s ON s.program_id = pp.program_id
LEFT JOIN program_attendance a ON a.participant_id = pp.id AND a.session_id = s.id
WHERE s.id = $1 AND a.id IS NULL
`
		rows, err := r.db.Query(ctx, query, sessionID)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		return scanParticipants(rows)
	}

	rows, err := r.db.Query(ctx, query, sessionID, status)
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

// GenerateSessions bulk-inserts multiple sessions for a program and returns them
func (r *ProgramRepository) GenerateSessions(ctx context.Context, sessions []*domain.ProgramSession) ([]*domain.ProgramSession, error) {
	if len(sessions) == 0 {
		return nil, nil
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	var result []*domain.ProgramSession
	for _, s := range sessions {
		err := tx.QueryRow(ctx, `
			INSERT INTO program_sessions (program_id, date, topic, session_type, start_time, end_time, location)
			VALUES ($1, $2, $3, COALESCE(NULLIF($4, ''), 'regular'), $5, $6, $7)
			RETURNING id, created_at, updated_at
		`, s.ProgramID, s.Date, s.Topic, s.SessionType, s.StartTime, s.EndTime, s.Location).Scan(&s.ID, &s.CreatedAt, &s.UpdatedAt)
		if err != nil {
			return nil, err
		}
		result = append(result, s)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return result, nil
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
		dateFilter = "AND (" + strings.Join(parts, " OR ") + ")"
	}

	filteredSessions := fmt.Sprintf(`
		WITH filtered_sessions AS (
			SELECT ps.id, ps.topic, ps.date
			FROM program_sessions ps
			JOIN programs p ON p.id = ps.program_id AND p.account_id = $1
			WHERE p.id = $2 %s
		)
	`, dateFilter)
	sessionQuery := filteredSessions + `
		SELECT fs.id, fs.topic, fs.date,
			COUNT(*) FILTER (WHERE pa.status = 'present') AS present,
			COUNT(*) FILTER (WHERE pa.status = 'absent') AS absent,
			COUNT(*) FILTER (WHERE pa.status = 'late') AS late,
			COUNT(*) FILTER (WHERE pa.status = 'excused') AS excused
		FROM filtered_sessions fs
		LEFT JOIN program_attendance pa ON pa.session_id = fs.id
		GROUP BY fs.id, fs.topic, fs.date
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
		if err := sessionRows.Scan(&stat.SessionID, &topic, &date, &stat.Present, &stat.Absent, &stat.Late, &stat.Excused); err != nil {
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
			COUNT(*) FILTER (WHERE pa.status = 'excused') as excused,
			(SELECT COUNT(*) FROM filtered_sessions) as total_sessions
		FROM program_participants pp
		JOIN programs p ON p.id = pp.program_id AND p.account_id = $1
		JOIN contacts c ON c.id = pp.contact_id AND c.account_id = p.account_id
		LEFT JOIN program_attendance pa ON pa.participant_id = pp.id
			AND pa.session_id IN (SELECT id FROM filtered_sessions)
		WHERE pp.program_id = $2
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
		if err := participantRows.Scan(&stat.ParticipantID, &stat.Name, &stat.Present, &stat.Absent, &stat.Late, &stat.Excused, &stat.TotalSessions); err != nil {
			return sessionStats, nil, err
		}
		if stat.TotalSessions > 0 {
			stat.Rate = float64(stat.Present+stat.Late) / float64(stat.TotalSessions) * 100
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
	_, err := r.db.Exec(ctx, `
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
	return err
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
		WHERE program_id = $1 AND date <= CURRENT_DATE
	`, programID).Scan(&sessionCount, &recoverySessionCount); err != nil {
		return nil, err
	}

	rows, err := r.db.Query(ctx, `
		WITH att AS (
			SELECT pa.participant_id,
			       COUNT(*) FILTER (WHERE pa.status = 'present') AS present,
			       COUNT(*) FILTER (WHERE pa.status = 'late') AS late,
			       COUNT(*) FILTER (WHERE pa.status = 'absent') AS absent,
			       COUNT(*) FILTER (WHERE pa.status = 'excused') AS excused,
			       COUNT(*) FILTER (WHERE ps.session_type = 'recovery' AND pa.status IN ('present','late')) AS recovery_sessions
			FROM program_attendance pa
			JOIN program_sessions ps ON ps.id = pa.session_id
			WHERE ps.program_id = $2 AND ps.date <= CURRENT_DATE
			GROUP BY pa.participant_id
		),
		notes AS (
			SELECT pp2.id AS participant_id, COUNT(i.id) AS notes_count, MAX(i.created_at) AS last_note_at
			FROM program_participants pp2
			JOIN programs p2 ON p2.id = pp2.program_id
			JOIN interactions i ON i.account_id = p2.account_id
			 AND (
				i.contact_id = pp2.contact_id
				OR (
					i.contact_id IS NULL
					AND i.lead_id IS NOT NULL
					AND EXISTS (
						SELECT 1
						FROM leads l
						WHERE l.id = i.lead_id
						  AND l.account_id = p2.account_id
						  AND l.contact_id = pp2.contact_id
					)
				)
			 )
			WHERE p2.account_id = $1 AND pp2.program_id = $2
			GROUP BY pp2.id
		)
		SELECT pp.id, pp.contact_id, COALESCE(c.custom_name, c.name, c.push_name, c.phone, '') AS name, c.phone,
		       c.avatar_url, COALESCE(c.avatar_revision, 0),
		       pp.status, COALESCE(pp.transferred_to_level, ''),
		       COALESCE(att.present, 0), COALESCE(att.late, 0), COALESCE(att.absent, 0), COALESCE(att.excused, 0),
		       COALESCE(att.recovery_sessions, 0),
		       COALESCE(notes.notes_count, 0), notes.last_note_at
		FROM program_participants pp
		JOIN programs p ON p.id = pp.program_id
		JOIN contacts c ON c.id = pp.contact_id AND c.account_id = p.account_id
		LEFT JOIN att ON att.participant_id = pp.id
		LEFT JOIN notes ON notes.participant_id = pp.id
		WHERE p.account_id = $1 AND pp.program_id = $2
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
		Health:                "healthy",
	}
	var presentTotal, lateTotal int
	for rows.Next() {
		p := &domain.ProgramHealthParticipant{}
		if err := rows.Scan(&p.ParticipantID, &p.ContactID, &p.Name, &p.Phone, &p.AvatarURL, &p.AvatarRevision, &p.Status, &p.TransferredToLevel, &p.Present, &p.Late, &p.Absent, &p.Excused, &p.RecoverySessions, &p.NotesCount, &p.LastNoteAt); err != nil {
			return nil, err
		}
		if sessionCount > 0 {
			p.AttendanceRate = float64(p.Present+p.Late) / float64(sessionCount) * 100
		}
		unresolvedAbsences := p.Absent - p.RecoverySessions
		if unresolvedAbsences < 0 {
			unresolvedAbsences = 0
		}
		p.Health = "healthy"
		if p.Status == "dropped" {
			p.Health = "critical"
			p.Reasons = append(p.Reasons, "desistio del curso")
		}
		if unresolvedAbsences >= 2 {
			p.Health = "critical"
			p.Reasons = append(p.Reasons, fmt.Sprintf("%d faltas no regularizadas", unresolvedAbsences))
		} else if unresolvedAbsences == 1 && p.Health == "healthy" {
			p.Health = "watch"
			p.Reasons = append(p.Reasons, "una falta pendiente")
		}
		if sessionCount > 0 && p.AttendanceRate < float64(goal.AttendanceGoalPercent) && p.Status == "active" && p.Health == "healthy" {
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
			p.Reasons = append(p.Reasons, "sin alertas")
		}
		if p.Status == "active" {
			summary.ActiveCount++
		}
		if p.Status == "completed" {
			summary.CompletedCount++
		}
		if p.Status == "dropped" {
			summary.DroppedCount++
		}
		if p.TransferredToLevel != "" {
			summary.TransferredCount++
		}
		presentTotal += p.Present
		lateTotal += p.Late
		summary.Participants = append(summary.Participants, p)
	}
	summary.ParticipantCount = len(summary.Participants)
	if summary.ParticipantCount > 0 && sessionCount > 0 {
		summary.AttendanceRate = float64(presentTotal+lateTotal) / float64(summary.ParticipantCount*sessionCount) * 100
	}
	if summary.ParticipantCount > 0 {
		summary.TransferRate = float64(summary.TransferredCount) / float64(summary.ParticipantCount) * 100
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
	if summary.AttendanceRate < float64(goal.AttendanceGoalPercent) && summary.ParticipantCount > 0 && sessionCount > 0 {
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
			WHERE ($2::date IS NULL OR ps.date >= $2::date)
			  AND ($3::date IS NULL OR ps.date <= $3::date)
			GROUP BY ps.program_id
		),
		att AS (
			SELECT ps.program_id,
			       COUNT(*) FILTER (WHERE pa.status = 'present') AS present,
			       COUNT(*) FILTER (WHERE pa.status = 'late') AS late,
			       COUNT(*) FILTER (WHERE pa.status = 'absent') AS absent,
			       COUNT(*) FILTER (WHERE pa.status = 'excused') AS excused,
			       COUNT(DISTINCT pa.participant_id) FILTER (WHERE pa.status = 'absent') AS absent_people
			FROM program_attendance pa
			JOIN program_sessions ps ON ps.id = pa.session_id
			JOIN fp ON fp.id = ps.program_id
			WHERE ($2::date IS NULL OR ps.date >= $2::date)
			  AND ($3::date IS NULL OR ps.date <= $3::date)
			GROUP BY ps.program_id
		),
		pp AS (
			SELECT pp.program_id,
			       COUNT(*) AS participant_count,
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
		       COALESCE(att.present, 0), COALESCE(att.late, 0), COALESCE(att.absent_people, 0),
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
	var totalAttended, totalAttendanceSlots int
	for rows.Next() {
		g := &domain.ProgramDashboardGroup{}
		var present, late, absentPeople int
		if err := rows.Scan(&g.ProgramID, &g.Name, &g.Status, &g.Color, &g.ParticipantCount, &g.ActiveCount, &g.CompletedCount, &g.DroppedCount, &g.TransferredCount, &g.SessionCount, &present, &late, &absentPeople, &g.AttendanceGoalPercent, &g.TransferGoalPercent); err != nil {
			return nil, err
		}
		if g.ParticipantCount > 0 && g.SessionCount > 0 {
			g.AttendanceRate = float64(present+late) / float64(g.ParticipantCount*g.SessionCount) * 100
		}
		if g.ParticipantCount > 0 {
			g.TransferRate = float64(g.TransferredCount) / float64(g.ParticipantCount) * 100
		}
		g.AtRiskCount = g.DroppedCount + absentPeople
		g.Health = "healthy"
		if g.AtRiskCount > 0 || (g.ParticipantCount > 0 && g.SessionCount > 0 && g.AttendanceRate < float64(g.AttendanceGoalPercent)) {
			g.Health = "watch"
		}
		if g.DroppedCount > 0 {
			g.Health = "critical"
		}
		if g.ParticipantCount > 0 && g.SessionCount > 0 && g.AttendanceRate < float64(g.AttendanceGoalPercent) {
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
		totalAttendanceSlots += g.ParticipantCount * g.SessionCount
		summary.Groups = append(summary.Groups, g)
	}
	if totalAttendanceSlots > 0 {
		summary.AttendanceRate = float64(totalAttended) / float64(totalAttendanceSlots) * 100
	}
	if summary.ParticipantCount > 0 {
		summary.TransferRate = float64(summary.TransferredCount) / float64(summary.ParticipantCount) * 100
	}
	return summary, nil
}
