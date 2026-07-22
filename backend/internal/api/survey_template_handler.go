package api

import (
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
)

type surveyTemplateMutationRequest struct {
	Name                *string                `json:"name"`
	Description         *string                `json:"description"`
	Status              *string                `json:"status"`
	WelcomeTitle        *string                `json:"welcome_title"`
	WelcomeDescription  *string                `json:"welcome_description"`
	ThankYouTitle       *string                `json:"thank_you_title"`
	ThankYouMessage     *string                `json:"thank_you_message"`
	ThankYouRedirectURL *string                `json:"thank_you_redirect_url"`
	Branding            *domain.SurveyBranding `json:"branding"`
}

type surveyInstanceCreateRequest struct {
	TemplateID   uuid.UUID  `json:"template_id"`
	Name         string     `json:"name"`
	Slug         string     `json:"slug"`
	Status       string     `json:"status"`
	AudienceMode string     `json:"audience_mode"`
	OpensAt      *time.Time `json:"opens_at"`
	ClosesAt     *time.Time `json:"closes_at"`
}

func surveyTemplateError(c *fiber.Ctx, err error) error {
	switch {
	case errors.Is(err, repository.ErrSurveyTemplateNotFound), errors.Is(err, repository.ErrSurveyInstanceNotFound):
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Recurso no encontrado"})
	case errors.Is(err, repository.ErrSurveyProgramUnavailable):
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{"error": "Solo se pueden aplicar encuestas a programas activos de clases"})
	case errors.Is(err, repository.ErrSurveyProgramNoParticipants):
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{"error": "Agrega al menos un participante activo antes de crear la encuesta"})
	case errors.Is(err, repository.ErrSurveyTemplateEmpty):
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{"error": "La plantilla necesita al menos una pregunta activa"})
	case strings.Contains(err.Error(), "obligatorio"), strings.Contains(err.Error(), "inválid"),
		strings.Contains(err.Error(), "demasiado"), strings.Contains(err.Error(), "posterior"),
		strings.Contains(err.Error(), "opciones"), strings.Contains(err.Error(), "pregunta"),
		strings.Contains(err.Error(), "archivad"), strings.Contains(err.Error(), "enlace único"):
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	default:
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "No se pudo completar la operación"})
	}
}

func (s *Server) handleListSurveyTemplates(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	items, err := s.services.SurveyTemplate.List(c.Context(), accountID, c.QueryBool("include_archived", false))
	if err != nil {
		return surveyTemplateError(c, err)
	}
	if items == nil {
		items = []*domain.SurveyTemplate{}
	}
	return c.JSON(items)
}

func (s *Server) handleCreateSurveyTemplate(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	var req surveyTemplateMutationRequest
	if err := c.BodyParser(&req); err != nil || req.Name == nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Solicitud inválida"})
	}
	template := &domain.SurveyTemplate{AccountID: accountID, Name: *req.Name, Status: "active", CreatedBy: &userID}
	applySurveyTemplateMutation(template, req)
	if err := s.services.SurveyTemplate.Create(c.Context(), template); err != nil {
		return surveyTemplateError(c, err)
	}
	return c.Status(fiber.StatusCreated).JSON(template)
}

func (s *Server) handleGetSurveyTemplate(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	templateID, err := uuid.Parse(c.Params("templateId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "ID inválido"})
	}
	template, err := s.services.SurveyTemplate.Get(c.Context(), accountID, templateID)
	if err != nil {
		return surveyTemplateError(c, err)
	}
	return c.JSON(template)
}

func (s *Server) handleUpdateSurveyTemplate(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	templateID, err := uuid.Parse(c.Params("templateId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "ID inválido"})
	}
	template, err := s.services.SurveyTemplate.Get(c.Context(), accountID, templateID)
	if err != nil {
		return surveyTemplateError(c, err)
	}
	var req surveyTemplateMutationRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Solicitud inválida"})
	}
	applySurveyTemplateMutation(template, req)
	if err := s.services.SurveyTemplate.Update(c.Context(), template); err != nil {
		return surveyTemplateError(c, err)
	}
	updated, err := s.services.SurveyTemplate.Get(c.Context(), accountID, templateID)
	if err != nil {
		return surveyTemplateError(c, err)
	}
	return c.JSON(updated)
}

func applySurveyTemplateMutation(template *domain.SurveyTemplate, req surveyTemplateMutationRequest) {
	if req.Name != nil {
		template.Name = *req.Name
	}
	if req.Description != nil {
		template.Description = *req.Description
	}
	if req.Status != nil {
		template.Status = *req.Status
	}
	if req.WelcomeTitle != nil {
		template.WelcomeTitle = *req.WelcomeTitle
	}
	if req.WelcomeDescription != nil {
		template.WelcomeDescription = *req.WelcomeDescription
	}
	if req.ThankYouTitle != nil {
		template.ThankYouTitle = *req.ThankYouTitle
	}
	if req.ThankYouMessage != nil {
		template.ThankYouMessage = *req.ThankYouMessage
	}
	if req.ThankYouRedirectURL != nil {
		template.ThankYouRedirectURL = *req.ThankYouRedirectURL
	}
	if req.Branding != nil {
		template.Branding = *req.Branding
	}
}

func (s *Server) handleListSurveyTemplateQuestions(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	templateID, err := uuid.Parse(c.Params("templateId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "ID inválido"})
	}
	questions, err := s.services.SurveyTemplate.Questions(c.Context(), accountID, templateID)
	if err != nil {
		return surveyTemplateError(c, err)
	}
	if questions == nil {
		questions = []*domain.SurveyTemplateQuestion{}
	}
	return c.JSON(questions)
}

func (s *Server) handleReplaceSurveyTemplateQuestions(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	templateID, err := uuid.Parse(c.Params("templateId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "ID inválido"})
	}
	var questions []domain.SurveyTemplateQuestion
	if err := c.BodyParser(&questions); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Solicitud inválida"})
	}
	saved, revision, err := s.services.SurveyTemplate.ReplaceQuestions(c.Context(), accountID, templateID, questions)
	if err != nil {
		return surveyTemplateError(c, err)
	}
	return c.JSON(fiber.Map{"questions": saved, "revision": revision})
}

func (s *Server) handleListSurveyTemplateInstances(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	templateID, err := uuid.Parse(c.Params("templateId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "ID inválido"})
	}
	instances, err := s.services.SurveyTemplate.ListTemplateInstances(c.Context(), accountID, templateID)
	if err != nil {
		return surveyTemplateError(c, err)
	}
	if instances == nil {
		instances = []*domain.SurveyInstanceSummary{}
	}
	return c.JSON(instances)
}

func (s *Server) handleCreateStandaloneSurveyInstance(c *fiber.Ctx) error {
	templateID, err := uuid.Parse(c.Params("templateId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "ID inválido"})
	}
	return s.handleCreateSurveyInstance(c, nil, &templateID)
}

func (s *Server) handleListProgramSurveyInstances(c *fiber.Ctx) error {
	if !s.contactAvatarCallerHasPermission(c, domain.PermSurveys) {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "No tienes permiso para consultar encuestas"})
	}
	accountID := c.Locals("account_id").(uuid.UUID)
	programID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "ID inválido"})
	}
	instances, err := s.services.SurveyTemplate.ListProgramInstances(c.Context(), accountID, programID)
	if err != nil {
		return surveyTemplateError(c, err)
	}
	if instances == nil {
		instances = []*domain.SurveyInstanceSummary{}
	}
	return c.JSON(instances)
}

func (s *Server) handleCreateProgramSurveyInstance(c *fiber.Ctx) error {
	if !s.contactAvatarCallerHasPermission(c, domain.PermSurveys) {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "No tienes permiso para crear encuestas"})
	}
	programID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "ID inválido"})
	}
	return s.handleCreateSurveyInstance(c, &programID, nil)
}

func (s *Server) handleListProgramSurveyRecipients(c *fiber.Ctx) error {
	if !s.contactAvatarCallerHasPermission(c, domain.PermSurveys) {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "No tienes permiso para consultar encuestas"})
	}
	accountID := c.Locals("account_id").(uuid.UUID)
	programID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "ID de programa inválido"})
	}
	surveyID, err := uuid.Parse(c.Params("surveyId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "ID de encuesta inválido"})
	}
	limit, _ := strconv.Atoi(c.Query("limit", "50"))
	offset, _ := strconv.Atoi(c.Query("offset", "0"))
	recipients, total, err := s.services.SurveyTemplate.ListProgramRecipients(
		c.Context(), accountID, programID, surveyID, c.Query("q"), limit, offset,
	)
	if err != nil {
		return surveyTemplateError(c, err)
	}
	items := make([]fiber.Map, 0, len(recipients))
	for _, recipient := range recipients {
		items = append(items, fiber.Map{
			"id": recipient.ID, "contact_id": recipient.ContactID,
			"program_participant_id": recipient.ProgramParticipantID,
			"contact_name":           recipient.ContactName, "status": recipient.Status,
			"recipient_token": recipient.AccessToken,
			"opened_at":       recipient.OpenedAt, "completed_at": recipient.CompletedAt,
		})
	}
	return c.JSON(fiber.Map{"recipients": items, "total": total})
}

func (s *Server) handleCreateSurveyInstance(c *fiber.Ctx, programID, forcedTemplateID *uuid.UUID) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	var req surveyInstanceCreateRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Solicitud inválida"})
	}
	if forcedTemplateID != nil {
		req.TemplateID = *forcedTemplateID
	}
	if req.TemplateID == uuid.Nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Selecciona una plantilla"})
	}
	instance, err := s.services.SurveyTemplate.CreateInstance(c.Context(), domain.CreateSurveyInstanceInput{
		TemplateID: req.TemplateID, AccountID: accountID, ProgramID: programID,
		Name: req.Name, Slug: req.Slug, Status: req.Status, AudienceMode: req.AudienceMode,
		OpensAt: req.OpensAt, ClosesAt: req.ClosesAt, CreatedBy: &userID,
	})
	if err != nil {
		return surveyTemplateError(c, err)
	}
	s.invalidateSurveysCache(accountID)
	return c.Status(fiber.StatusCreated).JSON(instance)
}
