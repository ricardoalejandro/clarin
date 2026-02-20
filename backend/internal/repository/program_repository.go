package repository

import (
	"context"

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
err := r.db.QueryRow(ctx, `
INSERT INTO programs (account_id, name, description, status, color, created_by)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING id, created_at, updated_at
`, p.AccountID, p.Name, p.Description, p.Status, p.Color, p.CreatedBy).Scan(&p.ID, &p.CreatedAt, &p.UpdatedAt)
return err
}

func (r *ProgramRepository) GetByID(ctx context.Context, accountID, id uuid.UUID) (*domain.Program, error) {
p := &domain.Program{}
err := r.db.QueryRow(ctx, `
SELECT id, account_id, name, description, status, color, created_by, created_at, updated_at,
(SELECT COUNT(*) FROM program_participants WHERE program_id = programs.id) as participant_count,
(SELECT COUNT(*) FROM program_sessions WHERE program_id = programs.id) as session_count
FROM programs
WHERE id = $1 AND account_id = $2
`, id, accountID).Scan(
&p.ID, &p.AccountID, &p.Name, &p.Description, &p.Status, &p.Color, &p.CreatedBy, &p.CreatedAt, &p.UpdatedAt,
&p.ParticipantCount, &p.SessionCount,
)
if err == pgx.ErrNoRows {
return nil, nil
}
return p, err
}

func (r *ProgramRepository) List(ctx context.Context, accountID uuid.UUID) ([]*domain.Program, error) {
rows, err := r.db.Query(ctx, `
SELECT id, account_id, name, description, status, color, created_by, created_at, updated_at,
(SELECT COUNT(*) FROM program_participants WHERE program_id = programs.id) as participant_count,
(SELECT COUNT(*) FROM program_sessions WHERE program_id = programs.id) as session_count
FROM programs
WHERE account_id = $1
ORDER BY created_at DESC
`, accountID)
if err != nil {
return nil, err
}
defer rows.Close()

var programs []*domain.Program
for rows.Next() {
p := &domain.Program{}
err := rows.Scan(
&p.ID, &p.AccountID, &p.Name, &p.Description, &p.Status, &p.Color, &p.CreatedBy, &p.CreatedAt, &p.UpdatedAt,
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
SET name = $1, description = $2, status = $3, color = $4, updated_at = NOW()
WHERE id = $5 AND account_id = $6
`, p.Name, p.Description, p.Status, p.Color, p.ID, p.AccountID)
return err
}

func (r *ProgramRepository) Delete(ctx context.Context, accountID, id uuid.UUID) error {
_, err := r.db.Exec(ctx, "DELETE FROM programs WHERE id = $1 AND account_id = $2", id, accountID)
return err
}

// --- Participants ---

func (r *ProgramRepository) AddParticipant(ctx context.Context, pp *domain.ProgramParticipant) error {
err := r.db.QueryRow(ctx, `
INSERT INTO program_participants (program_id, contact_id, status)
VALUES ($1, $2, $3)
ON CONFLICT (program_id, contact_id) DO UPDATE SET status = EXCLUDED.status
RETURNING id, enrolled_at
`, pp.ProgramID, pp.ContactID, pp.Status).Scan(&pp.ID, &pp.EnrolledAt)
return err
}

func (r *ProgramRepository) ListParticipants(ctx context.Context, programID uuid.UUID) ([]*domain.ProgramParticipant, error) {
rows, err := r.db.Query(ctx, `
SELECT pp.id, pp.program_id, pp.contact_id, pp.status, pp.enrolled_at,
c.name, c.phone
FROM program_participants pp
JOIN contacts c ON c.id = pp.contact_id
WHERE pp.program_id = $1
ORDER BY c.name ASC
`, programID)
if err != nil {
return nil, err
}
defer rows.Close()

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

func (r *ProgramRepository) RemoveParticipant(ctx context.Context, programID, participantID uuid.UUID) error {
_, err := r.db.Exec(ctx, "DELETE FROM program_participants WHERE id = $1 AND program_id = $2", participantID, programID)
return err
}

// --- Sessions ---

func (r *ProgramRepository) CreateSession(ctx context.Context, s *domain.ProgramSession) error {
err := r.db.QueryRow(ctx, `
INSERT INTO program_sessions (program_id, date, topic)
VALUES ($1, $2, $3)
RETURNING id, created_at, updated_at
`, s.ProgramID, s.Date, s.Topic).Scan(&s.ID, &s.CreatedAt, &s.UpdatedAt)
return err
}

func (r *ProgramRepository) ListSessions(ctx context.Context, programID uuid.UUID) ([]*domain.ProgramSession, error) {
rows, err := r.db.Query(ctx, `
SELECT id, program_id, date, topic, created_at, updated_at
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
err := rows.Scan(&s.ID, &s.ProgramID, &s.Date, &s.Topic, &s.CreatedAt, &s.UpdatedAt)
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
SET date = $1, topic = $2, updated_at = NOW()
WHERE id = $3 AND program_id = $4
`, s.Date, s.Topic, s.ID, s.ProgramID)
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
VALUES ($1, $2, $3, $4)
ON CONFLICT (session_id, participant_id) DO UPDATE 
SET status = EXCLUDED.status, notes = EXCLUDED.notes, updated_at = NOW()
RETURNING id, created_at, updated_at
`, a.SessionID, a.ParticipantID, a.Status, a.Notes).Scan(&a.ID, &a.CreatedAt, &a.UpdatedAt)
return err
}

func (r *ProgramRepository) GetAttendanceBySession(ctx context.Context, sessionID uuid.UUID) ([]*domain.ProgramAttendance, error) {
rows, err := r.db.Query(ctx, `
SELECT a.id, a.session_id, a.participant_id, a.status, a.notes, a.created_at, a.updated_at,
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
