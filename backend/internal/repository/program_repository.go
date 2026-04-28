package repository

import (
	"context"
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

func (r *ProgramRepository) List(ctx context.Context, accountID uuid.UUID) ([]*domain.Program, error) {
rows, err := r.db.Query(ctx, `
SELECT p.id, p.account_id, p.type, p.name, p.description, p.status, p.color, p.created_by, p.folder_id, p.created_at, p.updated_at,
p.schedule_start_date, p.schedule_end_date, p.schedule_days, p.schedule_start_time, p.schedule_end_time,
p.pipeline_id, COALESCE(p.tag_formula, ''), COALESCE(p.tag_formula_mode, 'OR'), COALESCE(p.tag_formula_type, 'simple'),
p.event_date, p.event_end, p.location, ep.name as pipeline_name,
(SELECT COUNT(*) FROM program_participants WHERE program_id = p.id) as participant_count,
(SELECT COUNT(*) FROM program_sessions WHERE program_id = p.id) as session_count
FROM programs p
LEFT JOIN event_pipelines ep ON ep.id = p.pipeline_id
WHERE p.account_id = $1
ORDER BY p.created_at DESC
`, accountID)
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
INSERT INTO program_participants (program_id, contact_id, lead_id, stage_id, status, auto_tag_sync)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (program_id, contact_id) DO UPDATE SET
status = EXCLUDED.status,
lead_id = COALESCE(EXCLUDED.lead_id, program_participants.lead_id),
stage_id = COALESCE(EXCLUDED.stage_id, program_participants.stage_id),
auto_tag_sync = EXCLUDED.auto_tag_sync
RETURNING id, enrolled_at
`, pp.ProgramID, pp.ContactID, pp.LeadID, pp.StageID, pp.Status, pp.AutoTagSync).Scan(&pp.ID, &pp.EnrolledAt)
return err
}

func (r *ProgramRepository) UpdateParticipantStage(ctx context.Context, programID, participantID uuid.UUID, stageID *uuid.UUID) error {
_, err := r.db.Exec(ctx, `
UPDATE program_participants SET stage_id = $1 WHERE id = $2 AND program_id = $3
`, stageID, participantID, programID)
return err
}

func (r *ProgramRepository) ListParticipants(ctx context.Context, programID uuid.UUID) ([]*domain.ProgramParticipant, error) {
rows, err := r.db.Query(ctx, `
SELECT pp.id, pp.program_id, pp.contact_id, pp.lead_id, pp.stage_id, pp.status, pp.enrolled_at, COALESCE(pp.auto_tag_sync, false),
COALESCE(c.custom_name, c.name, c.push_name, c.phone, '') as display_name, c.phone,
COALESCE(pp.lead_id, l.id) as resolved_lead_id,
s.name as stage_name, s.color as stage_color
FROM program_participants pp
JOIN contacts c ON c.id = pp.contact_id
LEFT JOIN leads l ON l.contact_id = pp.contact_id AND l.account_id = (SELECT account_id FROM programs WHERE id = pp.program_id)
LEFT JOIN event_pipeline_stages s ON s.id = pp.stage_id
WHERE pp.program_id = $1
ORDER BY COALESCE(c.custom_name, c.name, c.push_name, c.phone) ASC
`, programID)
if err != nil {
return nil, err
}
defer rows.Close()

var participants []*domain.ProgramParticipant
for rows.Next() {
pp := &domain.ProgramParticipant{}
var resolvedLeadID *uuid.UUID
err := rows.Scan(
&pp.ID, &pp.ProgramID, &pp.ContactID, &pp.LeadID, &pp.StageID, &pp.Status, &pp.EnrolledAt, &pp.AutoTagSync,
&pp.ContactName, &pp.ContactPhone, &resolvedLeadID,
&pp.StageName, &pp.StageColor,
)
if err != nil {
return nil, err
}
// Use resolved lead_id if the stored one is nil
if pp.LeadID == nil && resolvedLeadID != nil {
pp.LeadID = resolvedLeadID
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
err := r.db.QueryRow(ctx, `
INSERT INTO program_sessions (program_id, date, topic, start_time, end_time, location)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING id, created_at, updated_at
`, s.ProgramID, s.Date, s.Topic, s.StartTime, s.EndTime, s.Location).Scan(&s.ID, &s.CreatedAt, &s.UpdatedAt)
return err
}

func (r *ProgramRepository) ListSessions(ctx context.Context, programID uuid.UUID) ([]*domain.ProgramSession, error) {
rows, err := r.db.Query(ctx, `
SELECT id, program_id, date, topic, start_time, end_time, location, created_at, updated_at
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
err := rows.Scan(&s.ID, &s.ProgramID, &s.Date, &s.Topic, &s.StartTime, &s.EndTime, &s.Location, &s.CreatedAt, &s.UpdatedAt)
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
_, err := r.db.Exec(ctx, `
UPDATE program_sessions
SET date = $1, topic = $2, start_time = $3, end_time = $4, location = $5, updated_at = NOW()
WHERE id = $6 AND program_id = $7
`, s.Date, s.Topic, s.StartTime, s.EndTime, s.Location, s.ID, s.ProgramID)
return err
}

func (r *ProgramRepository) DeleteSession(ctx context.Context, programID, sessionID uuid.UUID) error {
_, err := r.db.Exec(ctx, "DELETE FROM program_sessions WHERE id = $1 AND program_id = $2", sessionID, programID)
return err
}

// --- Attendance ---

func (r *ProgramRepository) MarkAttendance(ctx context.Context, a *domain.ProgramAttendance) error {
err := r.db.QueryRow(ctx, `
INSERT INTO program_attendance (session_id, participant_id, status, notes)
VALUES ($1, $2, NULLIF($3, ''), $4)
ON CONFLICT (session_id, participant_id) DO UPDATE
SET status = NULLIF(EXCLUDED.status, ''), notes = EXCLUDED.notes, updated_at = NOW()
RETURNING id, created_at, updated_at
`, a.SessionID, a.ParticipantID, a.Status, a.Notes).Scan(&a.ID, &a.CreatedAt, &a.UpdatedAt)
return err
}

func (r *ProgramRepository) BatchMarkAttendance(ctx context.Context, attendances []*domain.ProgramAttendance) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	for _, a := range attendances {
		_, err := tx.Exec(ctx, `
			INSERT INTO program_attendance (session_id, participant_id, status, notes)
			VALUES ($1, $2, NULLIF($3, ''), $4)
			ON CONFLICT (session_id, participant_id) DO UPDATE
			SET status = NULLIF(EXCLUDED.status, ''), notes = EXCLUDED.notes, updated_at = NOW()
		`, a.SessionID, a.ParticipantID, a.Status, a.Notes)
		if err != nil {
			return err
		}
	}

	return tx.Commit(ctx)
}

func (r *ProgramRepository) GetAttendanceBySession(ctx context.Context, sessionID uuid.UUID) ([]*domain.ProgramAttendance, error) {
rows, err := r.db.Query(ctx, `
SELECT a.id, a.session_id, a.participant_id, COALESCE(a.status, ''), a.notes, a.created_at, a.updated_at,
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
			INSERT INTO program_sessions (program_id, date, topic, start_time, end_time, location)
			VALUES ($1, $2, $3, $4, $5, $6)
			RETURNING id, created_at, updated_at
		`, s.ProgramID, s.Date, s.Topic, s.StartTime, s.EndTime, s.Location).Scan(&s.ID, &s.CreatedAt, &s.UpdatedAt)
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

func (r *ProgramFolderRepository) GetByAccountID(ctx context.Context, accountID uuid.UUID) ([]*domain.ProgramFolder, error) {
	rows, err := r.db.Query(ctx, `
		SELECT pf.id, pf.account_id, pf.parent_id, pf.name, pf.color, pf.icon, pf.position, pf.created_at, pf.updated_at,
		       COUNT(p.id) AS program_count
		FROM program_folders pf
		LEFT JOIN programs p ON p.folder_id = pf.id
		WHERE pf.account_id = $1
		GROUP BY pf.id
		ORDER BY pf.position, pf.name
	`, accountID)
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

func (r *ProgramRepository) GetAttendanceStats(ctx context.Context, programID uuid.UUID, months string) ([]map[string]interface{}, []map[string]interface{}, error) {
	// Build date filter: by default sessions up to today; if months provided, filter by those months
	dateFilter := "AND ps.date <= CURRENT_DATE"
	args := []interface{}{programID}
	if months != "" {
		// Parse comma-separated YYYY-MM into OR conditions
		parts := []string{}
		for _, m := range splitMonths(months) {
			if len(m) == 7 { // YYYY-MM format
				args = append(args, m+"-01")
				parts = append(parts, fmt.Sprintf("(ps.date >= $%d::date AND ps.date < ($%d::date + INTERVAL '1 month'))", len(args), len(args)))
			}
		}
		if len(parts) > 0 {
			dateFilter = "AND (" + joinStrings(parts, " OR ") + ")"
		}
	}

	// Per-session stats
	sessionQuery := fmt.Sprintf(`
		SELECT ps.id, ps.topic, ps.date,
			COUNT(CASE WHEN pa.status = 'present' THEN 1 END) as present,
			COUNT(CASE WHEN pa.status = 'absent' THEN 1 END) as absent,
			COUNT(CASE WHEN pa.status = 'late' THEN 1 END) as late,
			COUNT(CASE WHEN pa.status = 'excused' THEN 1 END) as excused
		FROM program_sessions ps
		LEFT JOIN program_attendance pa ON pa.session_id = ps.id
		WHERE ps.program_id = $1 %s
		GROUP BY ps.id, ps.topic, ps.date
		ORDER BY ps.date ASC
	`, dateFilter)
	sessionRows, err := r.db.Query(ctx, sessionQuery, args...)
	if err != nil {
		return nil, nil, err
	}
	defer sessionRows.Close()

	var sessionStats []map[string]interface{}
	for sessionRows.Next() {
		var id uuid.UUID
		var topic *string
		var date time.Time
		var present, absent, late, excused int
		if err := sessionRows.Scan(&id, &topic, &date, &present, &absent, &late, &excused); err != nil {
			return nil, nil, err
		}
		label := ""
		if topic != nil {
			label = *topic
		}
		sessionStats = append(sessionStats, map[string]interface{}{
			"session_id": id,
			"topic":      label,
			"date":       date,
			"present":    present,
			"absent":     absent,
			"late":       late,
			"excused":    excused,
		})
	}

	// Per-participant stats — only count sessions that match the date filter
	participantQuery := fmt.Sprintf(`
		SELECT pp.id, COALESCE(c.custom_name, c.name, c.push_name, c.phone, '') as name,
			COUNT(CASE WHEN pa.status = 'present' THEN 1 END) as present,
			COUNT(CASE WHEN pa.status = 'absent' THEN 1 END) as absent,
			COUNT(CASE WHEN pa.status = 'late' THEN 1 END) as late,
			COUNT(CASE WHEN pa.status = 'excused' THEN 1 END) as excused,
			(SELECT COUNT(*) FROM program_sessions ps WHERE ps.program_id = $1 %s) as total_sessions
		FROM program_participants pp
		JOIN contacts c ON c.id = pp.contact_id
		LEFT JOIN program_attendance pa ON pa.participant_id = pp.id
			AND pa.session_id IN (SELECT ps.id FROM program_sessions ps WHERE ps.program_id = $1 %s)
		WHERE pp.program_id = $1
		GROUP BY pp.id, c.custom_name, c.name, c.push_name, c.phone
		ORDER BY COUNT(CASE WHEN pa.status = 'present' THEN 1 END) DESC, name ASC
	`, dateFilter, dateFilter)
	participantRows, err := r.db.Query(ctx, participantQuery, args...)
	if err != nil {
		return sessionStats, nil, err
	}
	defer participantRows.Close()

	var participantStats []map[string]interface{}
	for participantRows.Next() {
		var id uuid.UUID
		var name string
		var present, absent, late, excused, totalSessions int
		if err := participantRows.Scan(&id, &name, &present, &absent, &late, &excused, &totalSessions); err != nil {
			return sessionStats, nil, err
		}
		rate := 0.0
		if totalSessions > 0 {
			rate = float64(present+late) / float64(totalSessions) * 100
		}
		participantStats = append(participantStats, map[string]interface{}{
			"participant_id": id,
			"name":           name,
			"present":        present,
			"absent":         absent,
			"late":           late,
			"excused":        excused,
			"total_sessions": totalSessions,
			"rate":           rate,
		})
	}

	return sessionStats, participantStats, nil
}

func splitMonths(s string) []string {
	var result []string
	for _, p := range strings.Split(s, ",") {
		p = strings.TrimSpace(p)
		if p != "" {
			result = append(result, p)
		}
	}
	return result
}

func joinStrings(parts []string, sep string) string {
	result := ""
	for i, p := range parts {
		if i > 0 {
			result += sep
		}
		result += p
	}
	return result
}
