package api

import (
	"errors"
	"log"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
)

type courseTopicRequest struct {
	ID          *uuid.UUID `json:"id"`
	Title       string     `json:"title"`
	Description *string    `json:"description"`
	Status      string     `json:"status"`
}

type courseRequest struct {
	Name              string               `json:"name"`
	Description       *string              `json:"description"`
	Status            string               `json:"status"`
	ExpectedUpdatedAt *time.Time           `json:"expected_updated_at"`
	Topics            []courseTopicRequest `json:"topics"`
}

func courseFromRequest(accountID, courseID uuid.UUID, req courseRequest) *domain.Course {
	course := &domain.Course{
		ID:                courseID,
		AccountID:         accountID,
		Name:              req.Name,
		Description:       req.Description,
		Status:            req.Status,
		ExpectedUpdatedAt: req.ExpectedUpdatedAt,
		Topics:            make([]*domain.CourseTopic, 0, len(req.Topics)),
	}
	for position, input := range req.Topics {
		topic := &domain.CourseTopic{
			AccountID:   accountID,
			CourseID:    courseID,
			Title:       input.Title,
			Description: input.Description,
			Status:      input.Status,
			Position:    position,
		}
		if input.ID != nil {
			topic.ID = *input.ID
		}
		course.Topics = append(course.Topics, topic)
	}
	return course
}

func (s *Server) handleListCourses(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	page := c.QueryInt("page", 1)
	pageSize := c.QueryInt("page_size", 10)
	courses, total, err := s.services.Program.ListCourses(c.Context(), accountID, c.Query("status"), c.Query("search"), page, pageSize)
	if err != nil {
		return writeAcademicAPIError(c, err)
	}
	if courses == nil {
		courses = make([]*domain.Course, 0)
	}
	return c.JSON(fiber.Map{"courses": courses, "total": total, "page": page, "page_size": pageSize})
}

func (s *Server) handleCreateCourse(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	var req courseRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
	}
	course := courseFromRequest(accountID, uuid.Nil, req)
	if err := s.services.Program.CreateCourse(c.Context(), course); err != nil {
		return writeAcademicAPIError(c, err)
	}
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"course": course})
}

func (s *Server) handleGetCourse(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	courseID, err := uuid.Parse(c.Params("courseId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid course ID"})
	}
	course, err := s.services.Program.GetCourse(c.Context(), accountID, courseID)
	if err != nil {
		return writeAcademicAPIError(c, err)
	}
	if course == nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Course not found"})
	}
	return c.JSON(fiber.Map{"course": course})
}

func (s *Server) handleUpdateCourse(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	courseID, err := uuid.Parse(c.Params("courseId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid course ID"})
	}
	var req courseRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
	}
	course := courseFromRequest(accountID, courseID, req)
	if err := s.services.Program.UpdateCourse(c.Context(), course); err != nil {
		return writeAcademicAPIError(c, err)
	}
	return c.JSON(fiber.Map{"course": course})
}

func (s *Server) handleDeleteCourse(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	courseID, err := uuid.Parse(c.Params("courseId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid course ID"})
	}
	expectedUpdatedAt, err := time.Parse(time.RFC3339Nano, c.Query("expected_updated_at"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "expected_updated_at is required and must be an RFC3339 timestamp"})
	}
	result, err := s.services.Program.DeleteCourse(c.Context(), accountID, courseID, expectedUpdatedAt)
	if err != nil {
		return writeAcademicAPIError(c, err)
	}
	return c.JSON(result)
}

func (s *Server) handleGetProgramAcademicConfig(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	programID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid program ID"})
	}
	config, err := s.services.Program.GetAcademicConfig(c.Context(), accountID, programID)
	if err != nil {
		return writeAcademicAPIError(c, err)
	}
	return c.JSON(config)
}

// handleReplaceProgramAcademicConfig replaces both halves of a program's
// academic setup in one transaction. Keeping the operation atomic prevents a
// user from ending up with saved courses but stale instructors (or vice
// versa) when either validation or the network fails.
func (s *Server) handleReplaceProgramAcademicConfig(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	programID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid program ID"})
	}
	var req struct {
		CourseIDs         []uuid.UUID `json:"course_ids"`
		ContactIDs        []uuid.UUID `json:"contact_ids"`
		ExpectedUpdatedAt *time.Time  `json:"expected_updated_at"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
	}
	if len(req.CourseIDs) > 100 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "A program can contain at most 100 courses"})
	}
	if len(req.ContactIDs) > 100 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "A program can contain at most 100 instructors"})
	}
	config, err := s.services.Program.ReplaceAcademicConfig(
		c.Context(), accountID, programID, req.CourseIDs, req.ContactIDs, req.ExpectedUpdatedAt,
	)
	if err != nil {
		return writeAcademicAPIError(c, err)
	}
	return c.JSON(config)
}

func (s *Server) handleReplaceProgramCourses(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	programID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid program ID"})
	}
	var req struct {
		CourseIDs         []uuid.UUID `json:"course_ids"`
		ExpectedUpdatedAt *time.Time  `json:"expected_updated_at"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
	}
	if len(req.CourseIDs) > 100 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "A program can contain at most 100 courses"})
	}
	config, err := s.services.Program.ReplaceProgramCourses(c.Context(), accountID, programID, req.CourseIDs, req.ExpectedUpdatedAt)
	if err != nil {
		return writeAcademicAPIError(c, err)
	}
	return c.JSON(config)
}

func (s *Server) handleReplaceProgramInstructors(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	programID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid program ID"})
	}
	var req struct {
		ContactIDs        []uuid.UUID `json:"contact_ids"`
		ExpectedUpdatedAt *time.Time  `json:"expected_updated_at"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
	}
	if len(req.ContactIDs) > 100 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "A program can contain at most 100 instructors"})
	}
	config, err := s.services.Program.ReplaceProgramInstructors(c.Context(), accountID, programID, req.ContactIDs, req.ExpectedUpdatedAt)
	if err != nil {
		return writeAcademicAPIError(c, err)
	}
	return c.JSON(config)
}

func writeAcademicAPIError(c *fiber.Ctx, err error) error {
	switch {
	case errors.Is(err, repository.ErrCourseNotFound), errors.Is(err, repository.ErrProgramNotFound), errors.Is(err, repository.ErrSessionNotFound):
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": err.Error()})
	case errors.Is(err, repository.ErrProgramNotCourse),
		errors.Is(err, repository.ErrCourseConflict),
		errors.Is(err, repository.ErrAcademicConfigConflict):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": err.Error()})
	case errors.Is(err, repository.ErrInvalidCourseTopic),
		errors.Is(err, repository.ErrInvalidProgramCourse),
		errors.Is(err, repository.ErrInvalidInstructor),
		errors.Is(err, repository.ErrInvalidSessionTopic):
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	case errors.Is(err, service.ErrProgramInput):
		message := strings.TrimPrefix(err.Error(), service.ErrProgramInput.Error()+": ")
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": message})
	default:
		log.Printf("[programs] academic operation failed: %v", err)
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Academic operation failed"})
	}
}
