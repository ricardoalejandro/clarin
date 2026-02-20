package service

import (
"context"
"errors"

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
if a.Status == "" {
return errors.New("attendance status is required")
}
return s.repo.Program.MarkAttendance(ctx, a)
}

func (s *ProgramService) GetAttendanceBySession(ctx context.Context, sessionID uuid.UUID) ([]*domain.ProgramAttendance, error) {
return s.repo.Program.GetAttendanceBySession(ctx, sessionID)
}

func (s *ProgramService) GetParticipantsByAttendanceStatus(ctx context.Context, sessionID uuid.UUID, status string) ([]*domain.ProgramParticipant, error) {
return s.repo.Program.GetParticipantsByAttendanceStatus(ctx, sessionID, status)
}
