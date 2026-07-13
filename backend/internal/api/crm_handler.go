package api

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/kommo"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
	"github.com/naperu/clarin/internal/ws"
)

type pipelineStageLayoutRequest struct {
	ID        *string `json:"id"`
	ClientID  string  `json:"client_id"`
	Name      string  `json:"name"`
	Color     string  `json:"color"`
	StageType string  `json:"stage_type"`
	Position  int     `json:"position"`
}

type pipelineStageDeletionRequest struct {
	ID                 string  `json:"id"`
	ReassignToStageID  *string `json:"reassign_to_stage_id"`
	ReassignToClientID string  `json:"reassign_to_client_id"`
}

func parsePipelineStageDrafts(input []pipelineStageLayoutRequest) ([]repository.PipelineStageDraft, error) {
	result := make([]repository.PipelineStageDraft, 0, len(input))
	for _, item := range input {
		var id *uuid.UUID
		if item.ID != nil && strings.TrimSpace(*item.ID) != "" {
			parsed, err := uuid.Parse(strings.TrimSpace(*item.ID))
			if err != nil {
				return nil, fmt.Errorf("id de etapa inválido")
			}
			id = &parsed
		}
		result = append(result, repository.PipelineStageDraft{
			ID: id, ClientID: item.ClientID, Name: item.Name, Color: item.Color,
			StageType: item.StageType, Position: item.Position,
		})
	}
	return result, nil
}

func parsePipelineStageDeletions(input []pipelineStageDeletionRequest) ([]repository.PipelineStageDeletion, error) {
	result := make([]repository.PipelineStageDeletion, 0, len(input))
	for _, item := range input {
		id, err := uuid.Parse(strings.TrimSpace(item.ID))
		if err != nil {
			return nil, fmt.Errorf("id de etapa eliminada inválido")
		}
		var destination *uuid.UUID
		if item.ReassignToStageID != nil && strings.TrimSpace(*item.ReassignToStageID) != "" {
			parsed, err := uuid.Parse(strings.TrimSpace(*item.ReassignToStageID))
			if err != nil {
				return nil, fmt.Errorf("destino de reasignación inválido")
			}
			destination = &parsed
		}
		result = append(result, repository.PipelineStageDeletion{
			ID: id, ReassignToStageID: destination, ReassignToClientID: strings.TrimSpace(item.ReassignToClientID),
		})
	}
	return result, nil
}

func pipelineStagesToDrafts(stages []*domain.PipelineStage) []repository.PipelineStageDraft {
	result := make([]repository.PipelineStageDraft, 0, len(stages))
	for _, stage := range stages {
		id := stage.ID
		result = append(result, repository.PipelineStageDraft{
			ID: &id, Name: stage.Name, Color: stage.Color, StageType: stage.StageType, Position: stage.Position,
		})
	}
	return result
}

func writeCRMError(c *fiber.Ctx, err error) error {
	switch {
	case errors.Is(err, repository.ErrCRMNotFound), errors.Is(err, pgx.ErrNoRows):
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"success": false, "error": "Recurso no encontrado"})
	case errors.Is(err, repository.ErrInvalidStageLayout), errors.Is(err, repository.ErrLostReasonRequired):
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{"success": false, "error": err.Error()})
	default:
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
}

func (s *Server) handleGetPipelineTemplates(c *fiber.Ctx) error {
	return c.JSON(fiber.Map{"success": true, "templates": service.PipelineTemplates()})
}

func (s *Server) handleCreatePipelineProfessional(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	var req struct {
		Name        string                       `json:"name"`
		Description *string                      `json:"description"`
		TemplateID  string                       `json:"template_id"`
		Stages      []pipelineStageLayoutRequest `json:"stages"`
	}
	if err := c.BodyParser(&req); err != nil || strings.TrimSpace(req.Name) == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "El nombre es obligatorio"})
	}
	var drafts []repository.PipelineStageDraft
	if len(req.Stages) > 0 {
		var err error
		drafts, err = parsePipelineStageDrafts(req.Stages)
		if err != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": err.Error()})
		}
		manual := make([]domain.PipelineTemplateStage, 0, len(drafts))
		for _, stage := range drafts {
			manual = append(manual, domain.PipelineTemplateStage{Name: stage.Name, Color: stage.Color, StageType: stage.StageType})
		}
		if err := service.ValidatePipelineStageDesign(manual); err != nil {
			return c.Status(422).JSON(fiber.Map{"success": false, "error": err.Error()})
		}
		// template_id is accepted as origin metadata while stages remain the
		// user's customized final design.
		if strings.TrimSpace(req.TemplateID) != "" {
			if _, found := service.FindPipelineTemplate(req.TemplateID); !found {
				return c.Status(400).JSON(fiber.Map{"success": false, "error": "Plantilla de pipeline no encontrada"})
			}
		}
	} else if strings.TrimSpace(req.TemplateID) != "" {
		template, found := service.FindPipelineTemplate(req.TemplateID)
		if !found {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Plantilla de pipeline no encontrada"})
		}
		for i, stage := range template.Stages {
			drafts = append(drafts, repository.PipelineStageDraft{
				ClientID: fmt.Sprintf("template-%d", i), Name: stage.Name, Color: stage.Color,
				StageType: stage.StageType, Position: i,
			})
		}
	}

	pipeline := &domain.Pipeline{AccountID: accountID, Name: req.Name, Description: req.Description}
	if err := s.repos.Pipeline.CreateWithStages(c.Context(), pipeline, drafts); err != nil {
		return writeCRMError(c, err)
	}
	s.invalidatePipelinesCache(accountID)
	return c.Status(201).JSON(fiber.Map{"success": true, "pipeline": pipeline})
}

func (s *Server) handleSavePipelineStageLayout(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	pipelineID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Pipeline inválido"})
	}
	var req struct {
		Stages                 []pipelineStageLayoutRequest   `json:"stages"`
		DeletedStages          []pipelineStageDeletionRequest `json:"deleted_stages"`
		DefaultIncomingStageID *string                        `json:"default_incoming_stage_id"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
	}
	drafts, err := parsePipelineStageDrafts(req.Stages)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	deletions, err := parsePipelineStageDeletions(req.DeletedStages)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	var incomingID *uuid.UUID
	if req.DefaultIncomingStageID != nil && strings.TrimSpace(*req.DefaultIncomingStageID) != "" {
		parsed, err := uuid.Parse(strings.TrimSpace(*req.DefaultIncomingStageID))
		if err != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Etapa de entrada inválida"})
		}
		incomingID = &parsed
	}
	pipeline, err := s.repos.Pipeline.SaveStageLayout(c.Context(), accountID, pipelineID, drafts, deletions, incomingID)
	if err != nil {
		return writeCRMError(c, err)
	}
	s.invalidatePipelinesCache(accountID)
	s.invalidateLeadsCache(accountID)
	return c.JSON(fiber.Map{"success": true, "pipeline": pipeline})
}

func (s *Server) handleCreatePipelineStageSafe(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	pipelineID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Pipeline inválido"})
	}
	pipeline, err := s.repos.Pipeline.GetByIDForAccount(c.Context(), accountID, pipelineID)
	if err != nil || pipeline == nil {
		return writeCRMError(c, repository.ErrCRMNotFound)
	}
	var req struct {
		Name  string `json:"name"`
		Color string `json:"color"`
	}
	if err := c.BodyParser(&req); err != nil || strings.TrimSpace(req.Name) == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "El nombre es obligatorio"})
	}
	drafts := pipelineStagesToDrafts(pipeline.Stages)
	insertAt := len(drafts) - 2
	if insertAt < 0 {
		insertAt = 0
	}
	newDraft := repository.PipelineStageDraft{ClientID: "legacy-new", Name: req.Name, Color: req.Color, StageType: domain.PipelineStageTypeActive}
	drafts = append(drafts, repository.PipelineStageDraft{})
	copy(drafts[insertAt+1:], drafts[insertAt:])
	drafts[insertAt] = newDraft
	for i := range drafts {
		drafts[i].Position = i
	}
	updated, err := s.repos.Pipeline.SaveStageLayout(c.Context(), accountID, pipelineID, drafts, nil, nil)
	if err != nil {
		return writeCRMError(c, err)
	}
	s.invalidatePipelinesCache(accountID)
	return c.Status(201).JSON(fiber.Map{"success": true, "pipeline": updated})
}

func (s *Server) handleUpdatePipelineStageSafe(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	pipelineID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Pipeline inválido"})
	}
	stageID, err := uuid.Parse(c.Params("stageId"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Etapa inválida"})
	}
	pipeline, err := s.repos.Pipeline.GetByIDForAccount(c.Context(), accountID, pipelineID)
	if err != nil || pipeline == nil {
		return writeCRMError(c, repository.ErrCRMNotFound)
	}
	var req struct {
		Name     *string `json:"name"`
		Color    *string `json:"color"`
		Position *int    `json:"position"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
	}
	drafts := pipelineStagesToDrafts(pipeline.Stages)
	found := false
	for i := range drafts {
		if drafts[i].ID != nil && *drafts[i].ID == stageID {
			found = true
			if req.Name != nil {
				drafts[i].Name = *req.Name
			}
			if req.Color != nil {
				drafts[i].Color = *req.Color
			}
			if req.Position != nil {
				drafts[i].Position = *req.Position
			}
		}
	}
	if !found {
		return writeCRMError(c, repository.ErrCRMNotFound)
	}
	updated, err := s.repos.Pipeline.SaveStageLayout(c.Context(), accountID, pipelineID, drafts, nil, nil)
	if err != nil {
		return writeCRMError(c, err)
	}
	s.invalidatePipelinesCache(accountID)
	return c.JSON(fiber.Map{"success": true, "pipeline": updated})
}

func (s *Server) handleDeletePipelineStageSafe(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	pipelineID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Pipeline inválido"})
	}
	stageID, err := uuid.Parse(c.Params("stageId"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Etapa inválida"})
	}
	pipeline, err := s.repos.Pipeline.GetByIDForAccount(c.Context(), accountID, pipelineID)
	if err != nil || pipeline == nil {
		return writeCRMError(c, repository.ErrCRMNotFound)
	}
	var req struct {
		ReassignToStageID *string `json:"reassign_to_stage_id"`
	}
	_ = c.BodyParser(&req)
	drafts := make([]repository.PipelineStageDraft, 0, len(pipeline.Stages)-1)
	var target *domain.PipelineStage
	for _, stage := range pipeline.Stages {
		if stage.ID == stageID {
			target = stage
			continue
		}
		id := stage.ID
		drafts = append(drafts, repository.PipelineStageDraft{ID: &id, Name: stage.Name, Color: stage.Color, StageType: stage.StageType, Position: len(drafts)})
	}
	if target == nil {
		return writeCRMError(c, repository.ErrCRMNotFound)
	}
	if target.StageType != domain.PipelineStageTypeActive {
		return c.Status(409).JSON(fiber.Map{"success": false, "error": "Ganado y Perdido solo pueden reemplazarse desde Gestionar Etapas"})
	}
	deletion := repository.PipelineStageDeletion{ID: stageID}
	if req.ReassignToStageID != nil && strings.TrimSpace(*req.ReassignToStageID) != "" {
		parsed, err := uuid.Parse(*req.ReassignToStageID)
		if err != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Destino inválido"})
		}
		deletion.ReassignToStageID = &parsed
	}
	updated, err := s.repos.Pipeline.SaveStageLayout(c.Context(), accountID, pipelineID, drafts, []repository.PipelineStageDeletion{deletion}, nil)
	if err != nil {
		return writeCRMError(c, err)
	}
	s.invalidatePipelinesCache(accountID)
	s.invalidateLeadsCache(accountID)
	return c.JSON(fiber.Map{"success": true, "pipeline": updated})
}

func (s *Server) handleReorderPipelineStagesSafe(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	pipelineID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Pipeline inválido"})
	}
	var req struct {
		StageIDs []string `json:"stage_ids"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
	}
	pipeline, err := s.repos.Pipeline.GetByIDForAccount(c.Context(), accountID, pipelineID)
	if err != nil || pipeline == nil || len(req.StageIDs) != len(pipeline.Stages) {
		return c.Status(422).JSON(fiber.Map{"success": false, "error": "El orden debe incluir todas las etapas exactamente una vez"})
	}
	byID := make(map[uuid.UUID]*domain.PipelineStage, len(pipeline.Stages))
	for _, stage := range pipeline.Stages {
		byID[stage.ID] = stage
	}
	drafts := make([]repository.PipelineStageDraft, 0, len(req.StageIDs))
	for i, raw := range req.StageIDs {
		id, err := uuid.Parse(raw)
		stage := byID[id]
		if err != nil || stage == nil {
			return c.Status(422).JSON(fiber.Map{"success": false, "error": "El orden contiene una etapa ajena o repetida"})
		}
		delete(byID, id)
		drafts = append(drafts, repository.PipelineStageDraft{ID: &id, Name: stage.Name, Color: stage.Color, StageType: stage.StageType, Position: i})
	}
	updated, err := s.repos.Pipeline.SaveStageLayout(c.Context(), accountID, pipelineID, drafts, nil, nil)
	if err != nil {
		return writeCRMError(c, err)
	}
	s.invalidatePipelinesCache(accountID)
	return c.JSON(fiber.Map{"success": true, "pipeline": updated})
}

func (s *Server) handleCreateLeadProfessional(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	var req struct {
		Title            string     `json:"title"`
		ContactID        *uuid.UUID `json:"contact_id"`
		Name             string     `json:"name"`
		Phone            string     `json:"phone"`
		Email            string     `json:"email"`
		Source           string     `json:"source"`
		Notes            string     `json:"notes"`
		DNI              string     `json:"dni"`
		BirthDate        *string    `json:"birth_date"`
		Address          string     `json:"address"`
		Distrito         string     `json:"distrito"`
		Ocupacion        string     `json:"ocupacion"`
		StageID          *uuid.UUID `json:"stage_id"`
		Tags             []string   `json:"tags"`
		ConfirmDuplicate bool       `json:"confirm_duplicate"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
	}

	var contact *domain.Contact
	var err error
	if req.ContactID != nil {
		contact, err = s.repos.Contact.GetByID(c.Context(), *req.ContactID)
		if err != nil || contact == nil || contact.AccountID != accountID || contact.IsGroup {
			return c.Status(404).JSON(fiber.Map{"success": false, "error": "Contacto no encontrado"})
		}
	} else {
		phone := kommo.NormalizePhone(req.Phone)
		jid := ""
		if phone != "" {
			jid = phone + "@s.whatsapp.net"
			contact, _ = s.repos.Contact.GetByJID(c.Context(), accountID, jid)
		}
		if contact == nil && strings.TrimSpace(req.Email) != "" {
			var ids []uuid.UUID
			rows, queryErr := s.repos.DB().Query(c.Context(), `SELECT id FROM contacts WHERE account_id=$1 AND LOWER(BTRIM(email))=LOWER(BTRIM($2)) LIMIT 2`, accountID, req.Email)
			if queryErr == nil {
				for rows.Next() {
					var id uuid.UUID
					if rows.Scan(&id) == nil {
						ids = append(ids, id)
					}
				}
				rows.Close()
			}
			if len(ids) == 1 {
				contact, _ = s.repos.Contact.GetByID(c.Context(), ids[0])
			}
		}
		if contact == nil {
			if jid == "" {
				jid = "manual_" + uuid.NewString() + "@clarin.contact"
			}
			contact, err = s.repos.Contact.GetOrCreate(c.Context(), accountID, nil, jid, phone, req.Name, "", false)
			if err != nil {
				return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
			}
		}
	}
	if contact == nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "No se pudo asegurar el contacto"})
	}

	title := strings.TrimSpace(req.Title)
	if title == "" {
		if strings.EqualFold(strings.TrimSpace(req.Source), "whatsapp") {
			title = "Consulta por WhatsApp"
		} else {
			title = "Oportunidad"
		}
	}
	duplicates, err := s.repos.Lead.HasOpenDuplicate(c.Context(), accountID, contact.ID, title, nil)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if len(duplicates) > 0 && !req.ConfirmDuplicate {
		return c.Status(409).JSON(fiber.Map{
			"success": false, "code": "possible_duplicate", "error": "Ya existe una oportunidad abierta con este concepto para el contacto", "candidates": duplicates,
		})
	}

	// Personal profile changes belong to the contact. Apply them only after the
	// duplicate warning is accepted, so cancelling the warning has no side effect.
	if strings.TrimSpace(req.Name) != "" {
		contact.CustomName = stringPtr(strings.TrimSpace(req.Name))
	}
	if strings.TrimSpace(req.Phone) != "" {
		contact.Phone = stringPtr(req.Phone)
	}
	if strings.TrimSpace(req.Email) != "" {
		contact.Email = stringPtr(strings.TrimSpace(req.Email))
	}
	if strings.TrimSpace(req.DNI) != "" {
		contact.DNI = stringPtr(strings.TrimSpace(req.DNI))
	}
	if strings.TrimSpace(req.Address) != "" {
		contact.Address = stringPtr(strings.TrimSpace(req.Address))
	}
	if strings.TrimSpace(req.Distrito) != "" {
		contact.Distrito = stringPtr(strings.TrimSpace(req.Distrito))
	}
	if strings.TrimSpace(req.Ocupacion) != "" {
		contact.Ocupacion = stringPtr(strings.TrimSpace(req.Ocupacion))
	}
	if req.BirthDate != nil && strings.TrimSpace(*req.BirthDate) != "" {
		if parsed, parseErr := time.Parse("2006-01-02", strings.TrimSpace(*req.BirthDate)); parseErr == nil {
			contact.BirthDate = &parsed
		}
	}
	if err := s.repos.Contact.Update(c.Context(), contact); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	var pipelineID, stageID *uuid.UUID
	if req.StageID != nil {
		var stageType string
		var resolvedPipelineID, resolvedStageID uuid.UUID
		err := s.repos.DB().QueryRow(c.Context(), `
			SELECT ps.pipeline_id, ps.id, ps.stage_type FROM pipeline_stages ps JOIN pipelines p ON p.id=ps.pipeline_id
			WHERE ps.id=$1 AND p.account_id=$2
		`, *req.StageID, accountID).Scan(&resolvedPipelineID, &resolvedStageID, &stageType)
		if err != nil || stageType != domain.PipelineStageTypeActive {
			return c.Status(422).JSON(fiber.Map{"success": false, "error": "La etapa inicial debe ser una etapa activa de la cuenta"})
		}
		pipelineID, stageID = &resolvedPipelineID, &resolvedStageID
	} else {
		pipelineID, stageID, err = s.repos.Pipeline.ResolveIncomingLeadDestination(c.Context(), accountID)
		if err != nil {
			return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
		}
	}
	status := domain.LeadStatusOpen
	lead := &domain.Lead{
		AccountID: accountID, ContactID: &contact.ID, Title: title, JID: contact.JID,
		Name: contact.CustomName, LastName: contact.LastName, ShortName: contact.ShortName,
		Phone: contact.Phone, Email: contact.Email, Company: contact.Company, Age: contact.Age,
		DNI: contact.DNI, BirthDate: contact.BirthDate, Address: contact.Address,
		Distrito: contact.Distrito, Ocupacion: contact.Ocupacion,
		Status: &status, Source: stringPtr(strings.TrimSpace(req.Source)), Notes: stringPtr(strings.TrimSpace(req.Notes)),
		Tags: req.Tags, CustomFields: map[string]interface{}{}, PipelineID: pipelineID, StageID: stageID,
	}
	if err := s.repos.Lead.Create(c.Context(), lead); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if len(req.Tags) > 0 {
		if err := s.repos.Tag.SyncLeadTagsByNames(c.Context(), accountID, lead.ID, req.Tags); err != nil {
			log.Printf("[CRM] opportunity %s created but tag assignment failed: %v", lead.ID, err)
		}
	}
	s.invalidateContactsCache(accountID)
	s.invalidateLeadsCache(accountID)
	s.broadcastLeadDelta(accountID, "created", lead)
	s.triggerAutomationLeadCreated(accountID, lead.ID)
	return c.Status(201).JSON(fiber.Map{"success": true, "lead": lead})
}

func stringPtr(value string) *string {
	if value == "" {
		return nil
	}
	copy := value
	return &copy
}

func (s *Server) handleMoveLeadToStage(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	leadID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Oportunidad inválida"})
	}
	var req struct {
		StageID     string `json:"stage_id"`
		CloseReason string `json:"close_reason"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
	}
	stageID, err := uuid.Parse(req.StageID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Etapa inválida"})
	}
	var userID *uuid.UUID
	if id, ok := c.Locals("user_id").(uuid.UUID); ok {
		userID = &id
	}
	if err := s.repos.Lead.MoveToStage(c.Context(), accountID, leadID, stageID, req.CloseReason, userID); err != nil {
		return writeCRMError(c, err)
	}
	lead, err := s.repos.Lead.GetByID(c.Context(), leadID)
	if err != nil || lead == nil || lead.AccountID != accountID {
		return writeCRMError(c, repository.ErrCRMNotFound)
	}
	s.invalidateLeadsCache(accountID)
	s.invalidateLeadDetailCache(leadID)
	s.broadcastLeadDelta(accountID, "stage_changed", lead)
	s.triggerAutomationLeadStageChanged(accountID, leadID, stageID)
	return c.JSON(fiber.Map{"success": true, "lead": lead})
}

func (s *Server) handleTrashLead(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	leadID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Oportunidad inválida"})
	}
	var req struct {
		Reason string `json:"reason"`
	}
	_ = c.BodyParser(&req)
	if req.Reason == "" {
		req.Reason = c.Query("reason")
	}
	var userID *uuid.UUID
	if id, ok := c.Locals("user_id").(uuid.UUID); ok {
		userID = &id
	}
	if err := s.repos.Lead.SoftDelete(c.Context(), accountID, leadID, userID, req.Reason); err != nil {
		return writeCRMError(c, err)
	}
	s.invalidateLeadsCache(accountID)
	s.invalidateLeadDetailCache(leadID)
	s.broadcastLeadDelta(accountID, "trashed", &domain.Lead{ID: leadID, AccountID: accountID})
	return c.JSON(fiber.Map{"success": true, "message": "Oportunidad enviada a la papelera"})
}

func (s *Server) handleTrashLeadsBatch(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	var req struct {
		IDs       []string `json:"ids"`
		DeleteAll bool     `json:"delete_all"`
		Reason    string   `json:"reason"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
	}
	var userID *uuid.UUID
	if id, ok := c.Locals("user_id").(uuid.UUID); ok {
		userID = &id
	}
	var count int64
	var err error
	if req.DeleteAll {
		count, err = s.repos.Lead.SoftDeleteAll(c.Context(), accountID, userID, req.Reason)
	} else {
		ids := make([]uuid.UUID, 0, len(req.IDs))
		seen := make(map[uuid.UUID]struct{})
		for _, raw := range req.IDs {
			id, parseErr := uuid.Parse(raw)
			if parseErr != nil {
				continue
			}
			if _, duplicate := seen[id]; !duplicate {
				seen[id] = struct{}{}
				ids = append(ids, id)
			}
		}
		if len(ids) == 0 {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "No hay IDs válidos"})
		}
		count, err = s.repos.Lead.SoftDeleteBatch(c.Context(), accountID, ids, userID, req.Reason)
	}
	if err != nil {
		return writeCRMError(c, err)
	}
	s.invalidateLeadsCache(accountID)
	return c.JSON(fiber.Map{"success": true, "count": count})
}

func (s *Server) handleRestoreLead(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	leadID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Oportunidad inválida"})
	}
	if err := s.repos.Lead.Restore(c.Context(), accountID, leadID); err != nil {
		return writeCRMError(c, err)
	}
	lead, _ := s.repos.Lead.GetByID(c.Context(), leadID)
	s.invalidateLeadsCache(accountID)
	s.invalidateLeadDetailCache(leadID)
	s.broadcastLeadDelta(accountID, "restored", lead)
	return c.JSON(fiber.Map{"success": true, "lead": lead})
}

func (s *Server) handleRejectDirectLeadStatus(c *fiber.Ctx) error {
	return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
		"success": false,
		"error":   "El estado se determina al mover la oportunidad a una etapa activa, Ganado o Perdido",
	})
}

func (s *Server) handleArchiveLeadSafe(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	leadID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Oportunidad inválida"})
	}
	var req struct {
		Archive bool   `json:"archive"`
		Reason  string `json:"reason"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
	}
	var tag pgconn.CommandTag
	if req.Archive {
		tag, err = s.repos.DB().Exec(c.Context(), `UPDATE leads SET is_archived=TRUE, archived_at=NOW(), archive_reason=$3, updated_at=NOW() WHERE id=$1 AND account_id=$2 AND deleted_at IS NULL`, leadID, accountID, strings.TrimSpace(req.Reason))
	} else {
		tag, err = s.repos.DB().Exec(c.Context(), `UPDATE leads SET is_archived=FALSE, archived_at=NULL, archive_reason='', updated_at=NOW() WHERE id=$1 AND account_id=$2 AND deleted_at IS NULL`, leadID, accountID)
	}
	if err != nil {
		return writeCRMError(c, err)
	}
	if tag.RowsAffected() == 0 {
		return writeCRMError(c, repository.ErrCRMNotFound)
	}
	s.invalidateLeadsCache(accountID)
	s.invalidateLeadDetailCache(leadID)
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleArchiveLeadsBatchSafe(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	var req struct {
		IDs     []uuid.UUID `json:"ids"`
		Archive bool        `json:"archive"`
		Reason  string      `json:"reason"`
	}
	if err := c.BodyParser(&req); err != nil || len(req.IDs) == 0 {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "IDs obligatorios"})
	}
	var tag pgconn.CommandTag
	var err error
	if req.Archive {
		tag, err = s.repos.DB().Exec(c.Context(), `UPDATE leads SET is_archived=TRUE, archived_at=NOW(), archive_reason=$3, updated_at=NOW() WHERE account_id=$1 AND id=ANY($2) AND deleted_at IS NULL`, accountID, req.IDs, strings.TrimSpace(req.Reason))
	} else {
		tag, err = s.repos.DB().Exec(c.Context(), `UPDATE leads SET is_archived=FALSE, archived_at=NULL, archive_reason='', updated_at=NOW() WHERE account_id=$1 AND id=ANY($2) AND deleted_at IS NULL`, accountID, req.IDs)
	}
	if err != nil {
		return writeCRMError(c, err)
	}
	s.invalidateLeadsCache(accountID)
	return c.JSON(fiber.Map{"success": true, "count": tag.RowsAffected()})
}

func (s *Server) handleBlockLeadCompatibility(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	leadID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Oportunidad inválida"})
	}
	var req struct {
		Block  bool   `json:"block"`
		Reason string `json:"reason"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
	}
	if req.Block && isCommercialDisinterestReason(req.Reason) {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
			"success": false,
			"error":   "“No está interesado” es un motivo comercial. Mueve la oportunidad a Perdida; no bloquees al contacto.",
		})
	}
	var contactID uuid.UUID
	if err := s.repos.DB().QueryRow(c.Context(), `SELECT contact_id FROM leads WHERE id=$1 AND account_id=$2 AND contact_id IS NOT NULL`, leadID, accountID).Scan(&contactID); err != nil {
		return writeCRMError(c, repository.ErrCRMNotFound)
	}
	var userID *uuid.UUID
	if id, ok := c.Locals("user_id").(uuid.UUID); ok {
		userID = &id
	}
	if err := s.repos.Contact.SetDoNotContact(c.Context(), accountID, contactID, req.Block, req.Reason, userID); err != nil {
		return writeCRMError(c, err)
	}
	s.invalidateLeadsCache(accountID)
	s.invalidateContactsCache(accountID)
	s.invalidateLeadDetailsForContacts(c.Context(), accountID, []uuid.UUID{contactID})
	return c.JSON(fiber.Map{"success": true, "contact_id": contactID, "blocked": req.Block})
}

func (s *Server) handleBlockLeadsBatchCompatibility(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	var req struct {
		IDs    []uuid.UUID `json:"ids"`
		Block  bool        `json:"block"`
		Reason string      `json:"reason"`
	}
	if err := c.BodyParser(&req); err != nil || len(req.IDs) == 0 {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "IDs obligatorios"})
	}
	contactIDs := make([]uuid.UUID, 0, len(req.IDs))
	rows, queryErr := s.repos.DB().Query(c.Context(), `
		SELECT DISTINCT contact_id FROM leads
		WHERE account_id=$1 AND id=ANY($2) AND contact_id IS NOT NULL
	`, accountID, req.IDs)
	if queryErr != nil {
		return writeCRMError(c, queryErr)
	}
	for rows.Next() {
		var contactID uuid.UUID
		if scanErr := rows.Scan(&contactID); scanErr != nil {
			rows.Close()
			return writeCRMError(c, scanErr)
		}
		contactIDs = append(contactIDs, contactID)
	}
	rows.Close()
	if req.Block && strings.TrimSpace(req.Reason) == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "El motivo es obligatorio"})
	}
	if req.Block && isCommercialDisinterestReason(req.Reason) {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
			"success": false,
			"error":   "“No está interesado” es un motivo comercial. Mueve las oportunidades a Perdidas; no bloquees sus contactos.",
		})
	}
	var userID *uuid.UUID
	if id, ok := c.Locals("user_id").(uuid.UUID); ok {
		userID = &id
	}
	count, err := s.repos.Contact.SetDoNotContactBatch(c.Context(), accountID, contactIDs, req.Block, req.Reason, userID)
	if err != nil {
		return writeCRMError(c, err)
	}
	s.invalidateLeadsCache(accountID)
	s.invalidateContactsCache(accountID)
	s.invalidateLeadDetailsForContacts(c.Context(), accountID, contactIDs)
	return c.JSON(fiber.Map{"success": true, "count": count})
}

func (s *Server) currentUserIsAccountAdmin(c *fiber.Ctx) bool {
	claims, ok := c.Locals("claims").(*service.JWTClaims)
	if !ok {
		return false
	}
	if claims.IsAdmin || claims.IsSuperAdmin || claims.Role == domain.RoleAdmin || claims.Role == domain.RoleSuperAdmin {
		return true
	}
	var role string
	err := s.repos.DB().QueryRow(c.Context(), `SELECT role FROM user_accounts WHERE user_id=$1 AND account_id=$2`, claims.UserID, claims.AccountID).Scan(&role)
	return err == nil && (role == domain.RoleAdmin || role == domain.RoleSuperAdmin)
}

func (s *Server) handlePurgeLead(c *fiber.Ctx) error {
	if !s.currentUserIsAccountAdmin(c) {
		return c.Status(403).JSON(fiber.Map{"success": false, "error": "Se requiere rol administrador para purgar"})
	}
	accountID := c.Locals("account_id").(uuid.UUID)
	leadID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Oportunidad inválida"})
	}
	if err := s.repos.Lead.Purge(c.Context(), accountID, leadID); err != nil {
		return writeCRMError(c, err)
	}
	s.invalidateLeadsCache(accountID)
	s.invalidateLeadDetailCache(leadID)
	return c.JSON(fiber.Map{"success": true, "message": "Oportunidad purgada definitivamente"})
}

func (s *Server) handleSetContactDoNotContact(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	contactID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Contacto inválido"})
	}
	var req struct {
		Blocked bool   `json:"blocked"`
		Reason  string `json:"reason"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
	}
	if req.Blocked && isCommercialDisinterestReason(req.Reason) {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
			"success": false,
			"error":   "“No está interesado” es un motivo comercial. Marca la oportunidad como Perdida; no bloquees al contacto.",
		})
	}
	var userID *uuid.UUID
	if id, ok := c.Locals("user_id").(uuid.UUID); ok {
		userID = &id
	}
	if err := s.repos.Contact.SetDoNotContact(c.Context(), accountID, contactID, req.Blocked, req.Reason, userID); err != nil {
		return writeCRMError(c, err)
	}
	contact, err := s.repos.Contact.GetByID(c.Context(), contactID)
	if err != nil || contact == nil || contact.AccountID != accountID {
		return writeCRMError(c, repository.ErrCRMNotFound)
	}
	s.invalidateContactsCache(accountID)
	s.invalidateLeadsCache(accountID)
	s.invalidateEventsCache(accountID)
	s.invalidateLeadDetailsForContacts(c.Context(), accountID, []uuid.UUID{contactID})
	if s.hub != nil {
		s.hub.BroadcastToAccount(accountID, ws.EventContactUpdate, map[string]interface{}{"action": "do_not_contact_changed", "contact": contact})
	}
	return c.JSON(fiber.Map{"success": true, "contact": contact})
}

func isCommercialDisinterestReason(reason string) bool {
	normalized := strings.ToLower(strings.TrimSpace(reason))
	normalized = strings.NewReplacer(
		"á", "a", "é", "e", "í", "i", "ó", "o", "ú", "u", "ü", "u",
		"à", "a", "è", "e", "ì", "i", "ò", "o", "ù", "u",
	).Replace(normalized)
	normalized = strings.Join(strings.Fields(normalized), " ")
	return strings.Contains(normalized, "no esta interesado") || strings.Contains(normalized, "no esta interesada")
}

func (s *Server) invalidateLeadDetailsForContacts(ctx context.Context, accountID uuid.UUID, contactIDs []uuid.UUID) {
	if len(contactIDs) == 0 {
		return
	}
	rows, err := s.repos.DB().Query(ctx, `
		SELECT id FROM leads WHERE account_id=$1 AND contact_id=ANY($2)
	`, accountID, contactIDs)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var leadID uuid.UUID
		if rows.Scan(&leadID) == nil {
			s.invalidateLeadDetailCache(leadID)
		}
	}
}

func (s *Server) outboundContactBlocked(ctx context.Context, accountID uuid.UUID, destination string) (bool, error) {
	return s.repos.Contact.IsOutboundSuppressed(ctx, accountID, []string{destination})
}

func (s *Server) ensureOutboundContactAllowed(ctx context.Context, accountID uuid.UUID, destination string) error {
	blocked, err := s.outboundContactBlocked(ctx, accountID, destination)
	if err != nil {
		return err
	}
	if blocked {
		return fiber.NewError(fiber.StatusConflict, "Este contacto está marcado como No contactar")
	}
	return nil
}

func (s *Server) ensureEventParticipantContact(ctx context.Context, accountID uuid.UUID, participant *domain.EventParticipant) error {
	if participant == nil {
		return fmt.Errorf("participante inválido")
	}
	var contact *domain.Contact
	if participant.ContactID != nil {
		found, err := s.repos.Contact.GetByID(ctx, *participant.ContactID)
		if err != nil {
			return err
		}
		if found == nil || found.AccountID != accountID || found.IsGroup {
			return fmt.Errorf("el contacto no pertenece a la cuenta")
		}
		contact = found
	}
	if participant.LeadID != nil {
		lead, err := s.repos.Lead.GetByID(ctx, *participant.LeadID)
		if err != nil {
			return err
		}
		if lead == nil || lead.AccountID != accountID || lead.ContactID == nil {
			return fmt.Errorf("la oportunidad no pertenece a la cuenta o no tiene contacto")
		}
		if contact != nil && contact.ID != *lead.ContactID {
			return fmt.Errorf("la oportunidad y el contacto no corresponden")
		}
		if contact == nil {
			contact, err = s.repos.Contact.GetByID(ctx, *lead.ContactID)
			if err != nil {
				return err
			}
		}
	}
	if contact == nil {
		phone := ""
		if participant.Phone != nil {
			phone = kommo.NormalizePhone(*participant.Phone)
		}
		jid := ""
		if phone != "" {
			jid = phone + "@s.whatsapp.net"
			contact, _ = s.repos.Contact.GetByJID(ctx, accountID, jid)
		}
		if contact == nil && participant.Email != nil && strings.TrimSpace(*participant.Email) != "" {
			rows, err := s.repos.DB().Query(ctx, `SELECT id FROM contacts WHERE account_id=$1 AND is_group=FALSE AND LOWER(BTRIM(email))=LOWER(BTRIM($2)) LIMIT 2`, accountID, *participant.Email)
			if err != nil {
				return err
			}
			var ids []uuid.UUID
			for rows.Next() {
				var id uuid.UUID
				if rows.Scan(&id) == nil {
					ids = append(ids, id)
				}
			}
			rows.Close()
			if len(ids) == 1 {
				contact, _ = s.repos.Contact.GetByID(ctx, ids[0])
			}
		}
		if contact == nil {
			if jid == "" {
				jid = "event_" + uuid.NewString() + "@clarin.local"
			}
			var err error
			contact, err = s.repos.Contact.GetOrCreate(ctx, accountID, nil, jid, phone, participant.Name, "", false)
			if err != nil {
				return err
			}
			contact.Source = stringPtr("event")
			if participant.Email != nil && strings.TrimSpace(*participant.Email) != "" {
				contact.Email = participant.Email
			}
			if err := s.repos.Contact.Update(ctx, contact); err != nil {
				return err
			}
		}
	}
	if contact == nil || contact.AccountID != accountID || contact.IsGroup {
		return fmt.Errorf("no se pudo asegurar un contacto de la cuenta")
	}
	participant.ContactID = &contact.ID
	if strings.TrimSpace(participant.Name) == "" {
		participant.Name = contact.DisplayName()
	}
	if participant.Phone == nil {
		participant.Phone = contact.Phone
	}
	if participant.Email == nil {
		participant.Email = contact.Email
	}
	return nil
}

func (s *Server) StartLeadTrashPurgeWorker(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(24 * time.Hour)
		defer ticker.Stop()
		run := func() {
			count, err := s.repos.Lead.PurgeExpired(ctx, 30*24*time.Hour)
			if err != nil {
				return
			}
			if count > 0 {
				s.invalidateAllLeadCachesAfterPurge()
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Minute):
			run()
		}
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				run()
			}
		}
	}()
}

func (s *Server) invalidateAllLeadCachesAfterPurge() {
	if s.cache != nil {
		_ = s.cache.DelPattern(context.Background(), "leads:*")
		_ = s.cache.DelPattern(context.Background(), "leads_paged:*")
		_ = s.cache.DelPattern(context.Background(), "leads_stage:*")
		_ = s.cache.DelPattern(context.Background(), "leads_list:*")
		_ = s.cache.DelPattern(context.Background(), "lead_detail:*")
	}
}

const (
	leadLifecycleArchived = "archived"
	leadLifecycleBlocked  = "blocked"
	leadLifecycleTrash    = "trash"
	leadLifecycleAll      = "all"
)

// normalizeLeadLifecycle keeps the legacy status_filter query parameter
// compatible while making lifecycle the canonical source of truth.
func normalizeLeadLifecycle(lifecycle, statusFilter string) string {
	lifecycle = strings.ToLower(strings.TrimSpace(lifecycle))
	if lifecycle != "" {
		switch lifecycle {
		case domain.LeadStatusOpen, domain.LeadStatusWon, domain.LeadStatusLost,
			leadLifecycleArchived, leadLifecycleBlocked, leadLifecycleTrash, leadLifecycleAll:
			return lifecycle
		default:
			return domain.LeadStatusOpen
		}
	}

	switch strings.ToLower(strings.TrimSpace(statusFilter)) {
	case leadLifecycleArchived:
		return leadLifecycleArchived
	case leadLifecycleBlocked:
		return leadLifecycleBlocked
	case leadLifecycleTrash:
		return leadLifecycleTrash
	case leadLifecycleAll:
		return leadLifecycleAll
	case domain.LeadStatusWon:
		return domain.LeadStatusWon
	case domain.LeadStatusLost:
		return domain.LeadStatusLost
	default:
		return domain.LeadStatusOpen
	}
}

// leadBaseWhereClauses is shared by Kanban, list, stage pagination, and counts.
// A lead is only visible when its parent contact exists in the same account;
// queries using these clauses must join contacts as c by both id and account_id.
func leadBaseWhereClauses(accountPlaceholder string) []string {
	return []string{
		"l.account_id = " + accountPlaceholder,
		"l.contact_id IS NOT NULL",
	}
}

// leadLifecycleWhereClauses defines the canonical lifecycle predicates. The
// do-not-contact state deliberately remains transversal to open/won/lost and
// archived; it is only required when the dedicated blocked group is selected.
func leadLifecycleWhereClauses(lifecycle string) []string {
	lifecycle = normalizeLeadLifecycle(lifecycle, "")
	switch lifecycle {
	case leadLifecycleTrash:
		return []string{"l.deleted_at IS NOT NULL"}
	case domain.LeadStatusWon, domain.LeadStatusLost:
		return []string{"l.deleted_at IS NULL", "l.is_archived = FALSE", "l.status = '" + lifecycle + "'"}
	case leadLifecycleArchived:
		return []string{"l.deleted_at IS NULL", "l.is_archived = TRUE"}
	case leadLifecycleBlocked:
		return []string{"l.deleted_at IS NULL", "COALESCE(c.do_not_contact, FALSE) = TRUE"}
	case leadLifecycleAll:
		return []string{"l.deleted_at IS NULL"}
	default:
		return []string{"l.deleted_at IS NULL", "l.is_archived = FALSE", "l.status = 'open'"}
	}
}

func leadWhereClauses(accountPlaceholder, lifecycle, statusFilter string) []string {
	whereClauses := leadBaseWhereClauses(accountPlaceholder)
	return append(whereClauses, leadLifecycleWhereClauses(normalizeLeadLifecycle(lifecycle, statusFilter))...)
}

func addLeadLifecycleWhere(c *fiber.Ctx, whereClauses *[]string) {
	lifecycle := normalizeLeadLifecycle(c.Query("lifecycle"), c.Query("status_filter", "active"))
	*whereClauses = append(*whereClauses, leadLifecycleWhereClauses(lifecycle)...)
}

// addLeadPipelineWhere keeps pipeline selection consistent across lead views
// and counters. The pipeline belongs to the lead itself; stage_id is not a
// reliable substitute because leads can be temporarily unassigned.
func addLeadPipelineWhere(pipelineID string, whereClauses *[]string, args *[]interface{}, argIdx *int) {
	pipelineID = strings.TrimSpace(pipelineID)
	if pipelineID == "" {
		return
	}
	if pipelineID == "__no_pipeline__" {
		*whereClauses = append(*whereClauses, "l.pipeline_id IS NULL")
		return
	}
	parsed, err := uuid.Parse(pipelineID)
	if err != nil {
		return
	}
	*whereClauses = append(*whereClauses, fmt.Sprintf("l.pipeline_id = $%d", *argIdx))
	*args = append(*args, parsed)
	*argIdx++
}
