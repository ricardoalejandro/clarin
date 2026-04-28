package service

import (
"context"
"errors"
"fmt"
"time"

"github.com/google/uuid"
"github.com/naperu/clarin/internal/domain"
"github.com/naperu/clarin/internal/repository"
)

type ProgramService struct {
repo *repository.Repositories
}

func NewProgramService(repo *repository.Repositories) *ProgramService {
return &ProgramService{repo: repo}
}

// --- Programs ---

func (s *ProgramService) CreateProgram(ctx context.Context, p *domain.Program) error {
if p.Name == "" {
return errors.New("program name is required")
}
if p.Status == "" {
p.Status = "active"
}
if p.Type == "" {
p.Type = "course"
}
if p.Type != "course" && p.Type != "event" {
return errors.New("program type must be 'course' or 'event'")
}
if p.Type == "event" && p.PipelineID == nil {
return errors.New("event-type programs require a pipeline")
}
return s.repo.Program.Create(ctx, p)
}

func (s *ProgramService) GetProgram(ctx context.Context, accountID, id uuid.UUID) (*domain.Program, error) {
return s.repo.Program.GetByID(ctx, accountID, id)
}

func (s *ProgramService) ListPrograms(ctx context.Context, accountID uuid.UUID) ([]*domain.Program, error) {
return s.repo.Program.List(ctx, accountID)
}

func (s *ProgramService) UpdateProgram(ctx context.Context, p *domain.Program) error {
if p.Name == "" {
return errors.New("program name is required")
}
if p.Type == "event" && p.PipelineID == nil {
return errors.New("event-type programs require a pipeline")
}
return s.repo.Program.Update(ctx, p)
}

func (s *ProgramService) DeleteProgram(ctx context.Context, accountID, id uuid.UUID) error {
return s.repo.Program.Delete(ctx, accountID, id)
}

// --- Participants ---

func (s *ProgramService) AddParticipant(ctx context.Context, pp *domain.ProgramParticipant) error {
if pp.Status == "" {
pp.Status = "active"
}
return s.repo.Program.AddParticipant(ctx, pp)
}

func (s *ProgramService) UpdateParticipantStage(ctx context.Context, programID, participantID uuid.UUID, stageID *uuid.UUID) error {
return s.repo.Program.UpdateParticipantStage(ctx, programID, participantID, stageID)
}

func (s *ProgramService) ListParticipants(ctx context.Context, programID uuid.UUID) ([]*domain.ProgramParticipant, error) {
return s.repo.Program.ListParticipants(ctx, programID)
}

func (s *ProgramService) RemoveParticipant(ctx context.Context, programID, participantID uuid.UUID) error {
return s.repo.Program.RemoveParticipant(ctx, programID, participantID)
}

// --- Sessions ---

func (s *ProgramService) CreateSession(ctx context.Context, session *domain.ProgramSession) error {
if session.Topic != nil && *session.Topic == "" {
return errors.New("session topic cannot be empty")
}
return s.repo.Program.CreateSession(ctx, session)
}

func (s *ProgramService) ListSessions(ctx context.Context, programID uuid.UUID) ([]*domain.ProgramSession, error) {
return s.repo.Program.ListSessions(ctx, programID)
}

func (s *ProgramService) UpdateSession(ctx context.Context, session *domain.ProgramSession) error {
if session.Topic != nil && *session.Topic == "" {
return errors.New("session topic cannot be empty")
}
return s.repo.Program.UpdateSession(ctx, session)
}

func (s *ProgramService) DeleteSession(ctx context.Context, programID, sessionID uuid.UUID) error {
return s.repo.Program.DeleteSession(ctx, programID, sessionID)
}

// --- Attendance ---

func (s *ProgramService) MarkAttendance(ctx context.Context, a *domain.ProgramAttendance) error {
return s.repo.Program.MarkAttendance(ctx, a)
}

func (s *ProgramService) BatchMarkAttendance(ctx context.Context, attendances []*domain.ProgramAttendance) error {
return s.repo.Program.BatchMarkAttendance(ctx, attendances)
}

func (s *ProgramService) GetAttendanceBySession(ctx context.Context, sessionID uuid.UUID) ([]*domain.ProgramAttendance, error) {
return s.repo.Program.GetAttendanceBySession(ctx, sessionID)
}

func (s *ProgramService) GetParticipantsByAttendanceStatus(ctx context.Context, sessionID uuid.UUID, status string) ([]*domain.ProgramParticipant, error) {
return s.repo.Program.GetParticipantsByAttendanceStatus(ctx, sessionID, status)
}

// GenerateSessions creates recurring sessions based on a schedule configuration
func (s *ProgramService) GenerateSessions(ctx context.Context, programID uuid.UUID, startDate, endDate time.Time, daysOfWeek []int, startTime, endTime, topicPrefix string, location *string) ([]*domain.ProgramSession, error) {
	if startDate.After(endDate) {
		return nil, errors.New("start date must be before end date")
	}
	if len(daysOfWeek) == 0 {
		return nil, errors.New("at least one day of week is required")
	}

	// Build a set of valid weekdays
	daySet := make(map[time.Weekday]bool)
	for _, d := range daysOfWeek {
		if d < 0 || d > 6 {
			return nil, fmt.Errorf("invalid day of week: %d", d)
		}
		daySet[time.Weekday(d)] = true
	}

	var sessions []*domain.ProgramSession
	sessionNum := 1
	current := startDate

	for !current.After(endDate) {
		if daySet[current.Weekday()] {
			topic := fmt.Sprintf("%s %d", topicPrefix, sessionNum)
			var st, et *string
			if startTime != "" {
				st = &startTime
			}
			if endTime != "" {
				et = &endTime
			}
			sessions = append(sessions, &domain.ProgramSession{
				ProgramID: programID,
				Date:      current,
				Topic:     &topic,
				StartTime: st,
				EndTime:   et,
				Location:  location,
			})
			sessionNum++
		}
		current = current.AddDate(0, 0, 1)
	}

	if len(sessions) == 0 {
		return nil, errors.New("no sessions generated for the given date range and days")
	}

	return s.repo.Program.GenerateSessions(ctx, sessions)
}

// --- Folders ---

func (s *ProgramService) GetFolders(ctx context.Context, accountID uuid.UUID) ([]*domain.ProgramFolder, error) {
	return s.repo.ProgramFolder.GetByAccountID(ctx, accountID)
}

func (s *ProgramService) GetFolderByID(ctx context.Context, id uuid.UUID) (*domain.ProgramFolder, error) {
	return s.repo.ProgramFolder.GetByID(ctx, id)
}

func (s *ProgramService) CreateFolder(ctx context.Context, f *domain.ProgramFolder) error {
	return s.repo.ProgramFolder.Create(ctx, f)
}

func (s *ProgramService) UpdateFolder(ctx context.Context, f *domain.ProgramFolder) error {
	return s.repo.ProgramFolder.Update(ctx, f)
}

func (s *ProgramService) DeleteFolder(ctx context.Context, id uuid.UUID) error {
	return s.repo.ProgramFolder.Delete(ctx, id)
}

func (s *ProgramService) MoveProgramToFolder(ctx context.Context, programID uuid.UUID, folderID *uuid.UUID) error {
	return s.repo.ProgramFolder.MoveProgram(ctx, programID, folderID)
}

// --- Attendance Stats ---

func (s *ProgramService) GetAttendanceStats(ctx context.Context, programID uuid.UUID, months string) ([]map[string]interface{}, []map[string]interface{}, error) {
	return s.repo.Program.GetAttendanceStats(ctx, programID, months)
}
