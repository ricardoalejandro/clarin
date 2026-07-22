package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
)

type ProgramService struct {
	repo *repository.Repositories
}

var (
	ErrProgramInput                  = errors.New("invalid program input")
	ErrProgramParticipantEndInFuture = errors.New("program participant end date is in the future")
)

func programInputError(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrProgramInput, fmt.Sprintf(format, args...))
}

func NewProgramService(repo *repository.Repositories) *ProgramService {
	return &ProgramService{repo: repo}
}

// --- Programs ---

func normalizeCourseProgramEventFields(p *domain.Program) error {
	if p.Type != "course" {
		return nil
	}

	location := ""
	if p.Location != nil {
		location = strings.TrimSpace(*p.Location)
	}
	formulaMode := strings.ToUpper(strings.TrimSpace(p.TagFormulaMode))
	formulaType := strings.ToLower(strings.TrimSpace(p.TagFormulaType))
	if p.PipelineID != nil || strings.TrimSpace(p.TagFormula) != "" ||
		(formulaMode != "" && formulaMode != "OR") ||
		(formulaType != "" && formulaType != "simple") ||
		p.EventDate != nil || p.EventEnd != nil || location != "" {
		return programInputError("event fields are not allowed in class-group programs")
	}

	// Historical database defaults used OR/simple even for rows that never had
	// event behavior. Normalize those harmless defaults away so every new write
	// keeps Programs purely academic.
	p.PipelineID = nil
	p.TagFormula = ""
	p.TagFormulaMode = ""
	p.TagFormulaType = ""
	p.EventDate = nil
	p.EventEnd = nil
	p.Location = nil
	return nil
}

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
	if p.Type != "course" {
		return programInputError("new programs must be class groups; create events from the Events module")
	}
	if err := normalizeCourseProgramEventFields(p); err != nil {
		return err
	}
	return s.repo.Program.Create(ctx, p)
}

func (s *ProgramService) GetProgram(ctx context.Context, accountID, id uuid.UUID) (*domain.Program, error) {
	return s.repo.Program.GetByID(ctx, accountID, id)
}

func (s *ProgramService) ListPrograms(ctx context.Context, accountID uuid.UUID, status string) ([]*domain.Program, error) {
	return s.repo.Program.List(ctx, accountID, status)
}

func (s *ProgramService) UpdateProgram(ctx context.Context, p *domain.Program) error {
	if p.Name == "" {
		return errors.New("program name is required")
	}
	if p.Type == "course" {
		if err := normalizeCourseProgramEventFields(p); err != nil {
			return err
		}
	} else if p.Type == "event" {
		if p.PipelineID == nil {
			return errors.New("event-type programs require a pipeline")
		}
		belongs, err := s.repo.Program.LegacyEventPipelineBelongsToAccount(ctx, p.AccountID, *p.PipelineID)
		if err != nil {
			return err
		}
		if !belongs {
			return programInputError("event pipeline does not belong to the program account")
		}
	} else {
		return programInputError("program type is invalid")
	}
	return s.repo.Program.Update(ctx, p)
}

func (s *ProgramService) GetMigratedEventTarget(ctx context.Context, accountID, programID uuid.UUID) (*uuid.UUID, bool, error) {
	return s.repo.Program.GetMigratedEventTarget(ctx, accountID, programID)
}

func (s *ProgramService) DeleteProgram(ctx context.Context, accountID, id uuid.UUID) error {
	program, err := s.repo.Program.GetByID(ctx, accountID, id)
	if err != nil {
		return err
	}
	if program != nil && program.Type == "event" {
		return programInputError("legacy event-program records are protected; manage the migrated event from the Events module")
	}
	return s.repo.Program.Delete(ctx, accountID, id)
}

// --- Reusable course plans and academic configuration ---

func (s *ProgramService) CreateCourse(ctx context.Context, course *domain.Course) error {
	if err := validateCourseAggregate(course); err != nil {
		return err
	}
	return s.repo.Program.CreateCourse(ctx, course)
}

func (s *ProgramService) ListCourses(ctx context.Context, accountID uuid.UUID, status, search string, page, pageSize int) ([]*domain.Course, int, error) {
	status = strings.TrimSpace(status)
	if status != "" && status != "active" && status != "archived" {
		return nil, 0, programInputError("course status must be active or archived")
	}
	search = strings.TrimSpace(search)
	if len([]rune(search)) > 160 {
		return nil, 0, programInputError("course search must be 160 characters or fewer")
	}
	if page < 1 {
		return nil, 0, programInputError("page must be at least 1")
	}
	if pageSize < 1 || pageSize > 100 {
		return nil, 0, programInputError("page_size must be between 1 and 100")
	}
	return s.repo.Program.ListCourses(ctx, accountID, status, search, pageSize, (page-1)*pageSize)
}

func (s *ProgramService) GetCourse(ctx context.Context, accountID, courseID uuid.UUID) (*domain.Course, error) {
	return s.repo.Program.GetCourse(ctx, accountID, courseID)
}

func (s *ProgramService) UpdateCourse(ctx context.Context, course *domain.Course) error {
	if course.ID == uuid.Nil {
		return programInputError("course id is required")
	}
	if course.ExpectedUpdatedAt == nil || course.ExpectedUpdatedAt.IsZero() {
		return programInputError("expected_updated_at is required when updating a course")
	}
	if err := validateCourseAggregate(course); err != nil {
		return err
	}
	return s.repo.Program.UpdateCourse(ctx, course)
}

func (s *ProgramService) DeleteCourse(ctx context.Context, accountID, courseID uuid.UUID, expectedUpdatedAt time.Time) (*repository.CourseDeleteResult, error) {
	if expectedUpdatedAt.IsZero() {
		return nil, programInputError("expected_updated_at is required when deleting a course")
	}
	return s.repo.Program.DeleteCourse(ctx, accountID, courseID, expectedUpdatedAt)
}

func (s *ProgramService) GetAcademicConfig(ctx context.Context, accountID, programID uuid.UUID) (*domain.ProgramAcademicConfig, error) {
	return s.repo.Program.GetAcademicConfig(ctx, accountID, programID)
}

func (s *ProgramService) ReplaceAcademicConfig(ctx context.Context, accountID, programID uuid.UUID, courseIDs, contactIDs []uuid.UUID, expectedUpdatedAt *time.Time) (*domain.ProgramAcademicConfig, error) {
	if expectedUpdatedAt == nil || expectedUpdatedAt.IsZero() {
		return nil, programInputError("expected_updated_at is required when updating a program configuration")
	}
	if len(courseIDs) > 100 {
		return nil, programInputError("a program can contain at most 100 courses")
	}
	if len(contactIDs) > 100 {
		return nil, programInputError("a program can contain at most 100 instructors")
	}
	return s.repo.Program.ReplaceAcademicConfig(ctx, accountID, programID, courseIDs, contactIDs, *expectedUpdatedAt)
}

func (s *ProgramService) ReplaceProgramCourses(ctx context.Context, accountID, programID uuid.UUID, courseIDs []uuid.UUID, expectedUpdatedAt *time.Time) (*domain.ProgramAcademicConfig, error) {
	if expectedUpdatedAt == nil || expectedUpdatedAt.IsZero() {
		return nil, programInputError("expected_updated_at is required when updating a program configuration")
	}
	if len(courseIDs) > 100 {
		return nil, programInputError("a program can contain at most 100 courses")
	}
	return s.repo.Program.ReplaceProgramCourses(ctx, accountID, programID, courseIDs, *expectedUpdatedAt)
}

func (s *ProgramService) ReplaceProgramInstructors(ctx context.Context, accountID, programID uuid.UUID, contactIDs []uuid.UUID, expectedUpdatedAt *time.Time) (*domain.ProgramAcademicConfig, error) {
	if expectedUpdatedAt == nil || expectedUpdatedAt.IsZero() {
		return nil, programInputError("expected_updated_at is required when updating a program configuration")
	}
	if len(contactIDs) > 100 {
		return nil, programInputError("a program can contain at most 100 instructors")
	}
	return s.repo.Program.ReplaceProgramInstructors(ctx, accountID, programID, contactIDs, *expectedUpdatedAt)
}

func validateCourseAggregate(course *domain.Course) error {
	course.Name = strings.TrimSpace(course.Name)
	if course.Name == "" {
		return programInputError("course name is required")
	}
	if len([]rune(course.Name)) > 255 {
		return programInputError("course name must be 255 characters or fewer")
	}
	if course.Description != nil {
		description := strings.TrimSpace(*course.Description)
		if description == "" {
			course.Description = nil
		} else {
			course.Description = &description
		}
	}
	if course.Status == "" {
		course.Status = "active"
	}
	if course.Status != "active" && course.Status != "archived" {
		return programInputError("course status must be active or archived")
	}
	if len(course.Topics) > 500 {
		return programInputError("a course can contain at most 500 topics")
	}
	seen := make(map[uuid.UUID]struct{}, len(course.Topics))
	course.TopicCount = len(course.Topics)
	course.ActiveTopicCount = 0
	course.TopicPreview = make([]string, 0, 3)
	for position, topic := range course.Topics {
		if topic == nil {
			return programInputError("course topics cannot be null")
		}
		topic.Title = strings.TrimSpace(topic.Title)
		if topic.Title == "" {
			return programInputError("topic %d title is required", position+1)
		}
		if len([]rune(topic.Title)) > 255 {
			return programInputError("topic %d title must be 255 characters or fewer", position+1)
		}
		if topic.Description != nil {
			description := strings.TrimSpace(*topic.Description)
			if description == "" {
				topic.Description = nil
			} else {
				topic.Description = &description
			}
		}
		if topic.Status == "" {
			topic.Status = "active"
		}
		if topic.Status != "active" && topic.Status != "archived" {
			return programInputError("topic %d status must be active or archived", position+1)
		}
		if topic.Status == "active" {
			course.ActiveTopicCount++
			if len(course.TopicPreview) < 3 {
				course.TopicPreview = append(course.TopicPreview, topic.Title)
			}
		}
		if topic.ID != uuid.Nil {
			if _, duplicate := seen[topic.ID]; duplicate {
				return programInputError("course topic ids cannot be duplicated")
			}
			seen[topic.ID] = struct{}{}
		}
		topic.Position = position
	}
	if course.Topics == nil {
		course.Topics = make([]*domain.CourseTopic, 0)
	}
	return nil
}

// --- Participants ---

func (s *ProgramService) AddParticipant(ctx context.Context, accountID uuid.UUID, pp *domain.ProgramParticipant) error {
	if pp.Status == "" {
		pp.Status = "active"
	}
	return s.repo.Program.AddParticipant(ctx, accountID, pp)
}

func (s *ProgramService) AddParticipantsByContactIDs(ctx context.Context, accountID, programID uuid.UUID, contactIDs []uuid.UUID) (repository.ProgramParticipantBulkResult, error) {
	return s.repo.Program.AddParticipantsByContactIDs(ctx, accountID, programID, contactIDs)
}

func (s *ProgramService) UpdateParticipantStage(ctx context.Context, accountID, programID, participantID uuid.UUID, stageID *uuid.UUID) error {
	return s.repo.Program.UpdateParticipantStage(ctx, accountID, programID, participantID, stageID)
}

func (s *ProgramService) ListParticipants(ctx context.Context, accountID, programID uuid.UUID) ([]*domain.ProgramParticipant, error) {
	return s.repo.Program.ListParticipants(ctx, accountID, programID)
}

func (s *ProgramService) UpdateParticipantEnrollmentDate(ctx context.Context, accountID, programID, participantID uuid.UUID, enrolledAt time.Time) (time.Time, error) {
	enrolledOn, err := normalizeParticipantEnrollmentDate(enrolledAt, time.Now())
	if err != nil {
		return time.Time{}, err
	}
	return s.repo.Program.UpdateParticipantEnrollmentDate(ctx, accountID, programID, participantID, enrolledOn)
}

func normalizeParticipantEnrollmentDate(enrolledAt, now time.Time) (time.Time, error) {
	enrolledOn := time.Date(enrolledAt.Year(), enrolledAt.Month(), enrolledAt.Day(), 0, 0, 0, 0, time.UTC)
	now = now.UTC()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	if enrolledOn.After(today) {
		return time.Time{}, programInputError("enrollment date cannot be in the future")
	}
	return enrolledOn, nil
}

func (s *ProgramService) RemoveParticipant(ctx context.Context, accountID, programID, participantID uuid.UUID) error {
	return s.repo.Program.RemoveParticipant(ctx, accountID, programID, participantID)
}

// --- Sessions ---

func (s *ProgramService) CreateSession(ctx context.Context, accountID uuid.UUID, session *domain.ProgramSession) error {
	if err := validateSession(session); err != nil {
		return err
	}
	return s.repo.Program.CreateSession(ctx, accountID, session)
}

func (s *ProgramService) ListSessions(ctx context.Context, accountID, programID uuid.UUID) ([]*domain.ProgramSession, error) {
	return s.repo.Program.ListSessions(ctx, accountID, programID)
}

func (s *ProgramService) UpdateSession(ctx context.Context, accountID uuid.UUID, session *domain.ProgramSession) error {
	if err := validateSession(session); err != nil {
		return err
	}
	return s.repo.Program.UpdateSession(ctx, accountID, session)
}

func validateSession(session *domain.ProgramSession) error {
	if len(session.Topics) == 0 {
		if session.CourseTopicID != nil {
			session.Topics = []*domain.ProgramSessionTopic{{Kind: "course", CourseTopicID: session.CourseTopicID}}
		} else if session.Topic != nil {
			session.Topics = []*domain.ProgramSessionTopic{{Kind: "free", TopicTitleSnapshot: *session.Topic}}
		}
	}
	if len(session.Topics) == 0 {
		return programInputError("session must contain at least one topic")
	}
	if len(session.Topics) > 50 {
		return programInputError("session cannot contain more than 50 topics")
	}
	freeCount := 0
	seenTopicIDs := make(map[uuid.UUID]struct{}, len(session.Topics))
	for position, topic := range session.Topics {
		if topic == nil {
			return programInputError("session topic is invalid")
		}
		topic.Position = position
		switch topic.Kind {
		case "course":
			if topic.CourseTopicID == nil || *topic.CourseTopicID == uuid.Nil {
				return programInputError("course_topic_id is invalid")
			}
			if _, duplicate := seenTopicIDs[*topic.CourseTopicID]; duplicate {
				return programInputError("course topic cannot be repeated")
			}
			seenTopicIDs[*topic.CourseTopicID] = struct{}{}
		case "free":
			freeCount++
			title := strings.TrimSpace(topic.TopicTitleSnapshot)
			if title == "" {
				return programInputError("free session topic cannot be empty")
			}
			if len([]rune(title)) > 255 {
				return programInputError("session topic must be 255 characters or fewer")
			}
			topic.TopicTitleSnapshot = title
		default:
			return programInputError("session topic kind must be 'course' or 'free'")
		}
	}
	if freeCount > 0 && (freeCount != 1 || len(session.Topics) != 1) {
		return programInputError("a free topic cannot be combined with course topics")
	}
	if err := normalizeSessionTitle(session); err != nil {
		return err
	}
	if session.SessionType == "" {
		session.SessionType = "regular"
	}
	if session.SessionType != "regular" && session.SessionType != "recovery" {
		return programInputError("session type must be 'regular' or 'recovery'")
	}
	startTime, endTime, location, err := normalizeSessionLogistics(session.StartTime, session.EndTime, session.Location)
	if err != nil {
		return err
	}
	session.StartTime = startTime
	session.EndTime = endTime
	session.Location = location
	return nil
}

// normalizeSessionTitle validates an explicit class title while preserving the
// distinction between an omitted and an empty field. Create derives an omitted
// title only after canonical topics have been resolved in the repository;
// update uses the same omission marker to retain the locked database value.
func normalizeSessionTitle(session *domain.ProgramSession) error {
	title := strings.TrimSpace(session.Title)
	if session.TitleProvided && title == "" {
		return programInputError("session title cannot be empty")
	}
	if len([]rune(title)) > 255 {
		return programInputError("session title must be 255 characters or fewer")
	}
	if title != "" {
		session.Title = title
		// Programmatic callers can set Title directly. Treat a non-empty value as
		// intentional even when they do not know about the transport-only marker.
		session.TitleProvided = true
	}
	return nil
}

func normalizeSessionLogistics(startTime, endTime, location *string) (*string, *string, *string, error) {
	normalizeTime := func(value *string, field string) (*string, *time.Time, error) {
		if value == nil || strings.TrimSpace(*value) == "" {
			return nil, nil, nil
		}
		normalized := strings.TrimSpace(*value)
		parsed, err := time.Parse("15:04", normalized)
		if err != nil {
			return nil, nil, programInputError("%s time must use HH:MM format", field)
		}
		return &normalized, &parsed, nil
	}

	normalizedStart, parsedStart, err := normalizeTime(startTime, "start")
	if err != nil {
		return nil, nil, nil, err
	}
	normalizedEnd, parsedEnd, err := normalizeTime(endTime, "end")
	if err != nil {
		return nil, nil, nil, err
	}
	if parsedStart != nil && parsedEnd != nil && !parsedEnd.After(*parsedStart) {
		return nil, nil, nil, programInputError("end time must be later than start time")
	}

	var normalizedLocation *string
	if location != nil {
		value := strings.TrimSpace(*location)
		if len([]rune(value)) > 500 {
			return nil, nil, nil, programInputError("session location must be 500 characters or fewer")
		}
		if value != "" {
			normalizedLocation = &value
		}
	}
	return normalizedStart, normalizedEnd, normalizedLocation, nil
}

func (s *ProgramService) DeleteSession(ctx context.Context, accountID, programID, sessionID uuid.UUID) error {
	return s.repo.Program.DeleteSession(ctx, accountID, programID, sessionID)
}

// --- Attendance ---

func (s *ProgramService) MarkAttendance(ctx context.Context, accountID, userID, programID, sessionID uuid.UUID, a *domain.ProgramAttendance) error {
	return s.BatchMarkAttendance(ctx, accountID, userID, programID, sessionID, []*domain.ProgramAttendance{a})
}

func (s *ProgramService) BatchMarkAttendance(ctx context.Context, accountID, userID, programID, sessionID uuid.UUID, attendances []*domain.ProgramAttendance) error {
	validStatuses := map[string]bool{"": true, domain.AttendanceStatusPresent: true, domain.AttendanceStatusAbsent: true, domain.AttendanceStatusLate: true}
	seen := make(map[uuid.UUID]struct{}, len(attendances))
	for _, attendance := range attendances {
		if attendance == nil || attendance.ParticipantID == uuid.Nil {
			return errors.New("participant_id is required")
		}
		if !validStatuses[attendance.Status] {
			return fmt.Errorf("invalid attendance status: %s", attendance.Status)
		}
		if _, exists := seen[attendance.ParticipantID]; exists {
			return errors.New("duplicate participant in attendance batch")
		}
		seen[attendance.ParticipantID] = struct{}{}
		attendance.SessionID = sessionID
	}
	return s.repo.Program.BatchMarkAttendance(ctx, accountID, userID, programID, sessionID, attendances)
}

func (s *ProgramService) GetAttendanceBySession(ctx context.Context, accountID, sessionID uuid.UUID) ([]*domain.ProgramAttendance, error) {
	return s.repo.Program.GetAttendanceBySession(ctx, accountID, sessionID)
}

func (s *ProgramService) ListAttendanceObservations(ctx context.Context, accountID, programID, sessionID, participantID uuid.UUID) ([]*domain.ProgramAttendanceObservation, error) {
	return s.repo.Program.ListAttendanceObservations(ctx, accountID, programID, sessionID, participantID)
}

func (s *ProgramService) CreateAttendanceObservation(ctx context.Context, accountID, userID, programID, sessionID, participantID uuid.UUID, notes string) (*domain.ProgramAttendanceObservation, error) {
	notes = strings.TrimSpace(notes)
	if notes == "" {
		return nil, programInputError("attendance observation cannot be empty")
	}
	if len([]rune(notes)) > 4000 {
		return nil, programInputError("attendance observation must be 4000 characters or fewer")
	}
	return s.repo.Program.CreateAttendanceObservation(ctx, accountID, userID, programID, sessionID, participantID, notes)
}

func (s *ProgramService) DeleteAttendanceObservation(ctx context.Context, accountID, programID, sessionID, participantID, observationID uuid.UUID) error {
	return s.repo.Program.DeleteAttendanceObservation(ctx, accountID, programID, sessionID, participantID, observationID)
}

func (s *ProgramService) GetParticipantsByAttendanceStatus(ctx context.Context, accountID, programID, sessionID uuid.UUID, status string) ([]*domain.ProgramParticipant, error) {
	if status != "unmarked" && status != domain.AttendanceStatusPresent && status != domain.AttendanceStatusAbsent && status != domain.AttendanceStatusLate {
		return nil, programInputError("attendance status must be present, absent, late or unmarked")
	}
	return s.repo.Program.GetParticipantsByAttendanceStatus(ctx, accountID, programID, sessionID, status)
}

type SessionGenerationResult struct {
	Sessions           []*domain.ProgramSession
	AssignedTopicCount int
	FallbackCount      int
	Warning            string
}

const maxGeneratedSessions = 500

// GenerateSessions creates recurring sessions based on a schedule configuration.
func (s *ProgramService) GenerateSessions(ctx context.Context, accountID, programID uuid.UUID, startDate, endDate time.Time, daysOfWeek []int, startTime, endTime, titlePrefix string, location *string, assignCourseTopics bool) (*SessionGenerationResult, error) {
	sessions, err := buildRecurringSessionDrafts(programID, startDate, endDate, daysOfWeek, startTime, endTime, titlePrefix, location)
	if err != nil {
		return nil, err
	}
	created, assignedCount, err := s.repo.Program.GenerateSessions(ctx, accountID, programID, sessions, assignCourseTopics)
	if err != nil {
		return nil, err
	}
	result := &SessionGenerationResult{Sessions: created, AssignedTopicCount: assignedCount}
	if assignCourseTopics {
		result.FallbackCount = len(created) - assignedCount
		if result.FallbackCount > 0 {
			result.Warning = fmt.Sprintf("No hay suficientes temas pendientes; %d sesiones conservaron su título automático.", result.FallbackCount)
		}
	}
	return result, nil
}

func buildRecurringSessionDrafts(programID uuid.UUID, startDate, endDate time.Time, daysOfWeek []int, startTime, endTime, titlePrefix string, location *string) ([]*domain.ProgramSession, error) {
	if startDate.After(endDate) {
		return nil, programInputError("start date must be before end date")
	}
	if endDate.After(startDate.AddDate(2, 0, 0)) {
		return nil, programInputError("session schedules cannot span more than two years")
	}
	if len(daysOfWeek) == 0 {
		return nil, programInputError("at least one day of week is required")
	}
	var recurringStartTime, recurringEndTime *string
	if strings.TrimSpace(startTime) != "" {
		recurringStartTime = &startTime
	}
	if strings.TrimSpace(endTime) != "" {
		recurringEndTime = &endTime
	}
	recurringStartTime, recurringEndTime, location, err := normalizeSessionLogistics(recurringStartTime, recurringEndTime, location)
	if err != nil {
		return nil, err
	}

	// Build a set of valid weekdays
	daySet := make(map[time.Weekday]bool)
	for _, d := range daysOfWeek {
		if d < 0 || d > 6 {
			return nil, programInputError("invalid day of week: %d", d)
		}
		daySet[time.Weekday(d)] = true
	}

	titlePrefix = strings.TrimSpace(titlePrefix)
	if titlePrefix == "" {
		titlePrefix = "Sesión"
	}
	// The numeric suffix can add up to three digits at the current generation
	// cap. Validate the final title below as well so the database's VARCHAR(255)
	// limit is always reported as a useful 400 instead of an internal error.
	if len([]rune(titlePrefix)) > 251 {
		return nil, programInputError("session title prefix must be 251 characters or fewer")
	}
	sessions := make([]*domain.ProgramSession, 0)
	sessionNum := 1
	current := startDate

	for !current.After(endDate) {
		if daySet[current.Weekday()] {
			if len(sessions) >= maxGeneratedSessions {
				return nil, programInputError("a schedule can generate at most %d sessions", maxGeneratedSessions)
			}
			title := fmt.Sprintf("%s %d", titlePrefix, sessionNum)
			if len([]rune(title)) > 255 {
				return nil, programInputError("generated session titles must be 255 characters or fewer")
			}
			// Topic remains populated as a legacy/free-topic fallback. When automatic
			// course assignment is requested, the repository replaces only the topic;
			// the independent session title remains stable.
			topic := title
			sessions = append(sessions, &domain.ProgramSession{
				ProgramID:     programID,
				Date:          current,
				Title:         title,
				TitleProvided: true,
				Topic:         &topic,
				StartTime:     recurringStartTime,
				EndTime:       recurringEndTime,
				Location:      location,
			})
			sessionNum++
		}
		current = current.AddDate(0, 0, 1)
	}

	if len(sessions) == 0 {
		return nil, programInputError("no sessions generated for the given date range and days")
	}

	return sessions, nil
}

// --- Folders ---

func (s *ProgramService) GetFolders(ctx context.Context, accountID uuid.UUID, programStatus string) ([]*domain.ProgramFolder, error) {
	return s.repo.ProgramFolder.GetByAccountID(ctx, accountID, programStatus)
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

func (s *ProgramService) GetAttendanceStats(ctx context.Context, accountID, programID uuid.UUID, months []time.Time) ([]*domain.ProgramSessionAttendanceStat, []*domain.ProgramParticipantAttendanceStat, error) {
	return s.repo.Program.GetAttendanceStats(ctx, accountID, programID, months)
}

func (s *ProgramService) GetProgramGoals(ctx context.Context, accountID uuid.UUID, programID *uuid.UUID) (*domain.ProgramGoal, error) {
	return s.repo.Program.GetProgramGoals(ctx, accountID, programID)
}

func (s *ProgramService) UpsertProgramGoals(ctx context.Context, goal *domain.ProgramGoal) error {
	return s.repo.Program.UpsertProgramGoals(ctx, goal)
}

func (s *ProgramService) UpdateParticipantOutcome(ctx context.Context, accountID, programID, participantID uuid.UUID, status string, droppedAt *time.Time, dropReason, dropNotes string, completedAt *time.Time, transferredToLevel string, transferredAt *time.Time) error {
	if status != "completed" && status != "dropped" {
		return errors.New("participant status must be completed or dropped; re-enrollment requires an explicit flow")
	}
	if status == "dropped" && droppedAt == nil {
		now := time.Now()
		droppedAt = &now
	}
	if status == "completed" && completedAt == nil {
		now := time.Now()
		completedAt = &now
	}
	if transferredToLevel != "" && transferredAt == nil {
		now := time.Now()
		transferredAt = &now
	}
	if status != "dropped" {
		droppedAt = nil
		dropReason = ""
		dropNotes = ""
	} else {
		completedAt = nil
		transferredToLevel = ""
		transferredAt = nil
	}
	// An outcome changes roster membership immediately, so accepting a future
	// date would hide an otherwise active participant before that date arrives.
	// Keep a small tolerance for harmless clock skew between clients and API.
	latestAllowed := time.Now().Add(time.Minute)
	if (droppedAt != nil && droppedAt.After(latestAllowed)) ||
		(completedAt != nil && completedAt.After(latestAllowed)) ||
		(transferredAt != nil && transferredAt.After(latestAllowed)) {
		return ErrProgramParticipantEndInFuture
	}
	return s.repo.Program.UpdateParticipantOutcome(ctx, accountID, programID, participantID, status, droppedAt, dropReason, dropNotes, completedAt, transferredToLevel, transferredAt)
}

func (s *ProgramService) CreateParticipantNote(ctx context.Context, note *domain.ProgramParticipantNote) error {
	if note.Note == "" {
		return errors.New("note is required")
	}
	return s.repo.Program.CreateParticipantNote(ctx, note)
}

func (s *ProgramService) ListParticipantNotes(ctx context.Context, accountID, programID uuid.UUID, participantID *uuid.UUID) ([]*domain.ProgramParticipantNote, error) {
	return s.repo.Program.ListParticipantNotes(ctx, accountID, programID, participantID)
}

func (s *ProgramService) GetProgramHealth(ctx context.Context, accountID, programID uuid.UUID) (*domain.ProgramHealthSummary, error) {
	return s.repo.Program.GetProgramHealth(ctx, accountID, programID)
}

func (s *ProgramService) GetProgramsDashboard(ctx context.Context, accountID uuid.UUID, from, to *time.Time) (*domain.ProgramDashboardSummary, error) {
	return s.repo.Program.GetProgramsDashboard(ctx, accountID, from, to)
}
