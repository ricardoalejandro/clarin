package api

import (
	"encoding/json"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

// ─── Document Template Handlers ──────────────────────────────────────────────

func (s *Server) handleListDocumentTemplates(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)

	templates, err := s.services.DocumentTemplate.List(c.Context(), accountID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if templates == nil {
		templates = []*domain.DocumentTemplate{}
	}
	return c.JSON(fiber.Map{"success": true, "templates": templates})
}

func (s *Server) handleGetDocumentTemplate(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "invalid id"})
	}

	t, err := s.services.DocumentTemplate.GetByID(c.Context(), id, accountID)
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"success": false, "error": "template not found"})
	}
	return c.JSON(fiber.Map{"success": true, "template": t})
}

func (s *Server) handleCreateDocumentTemplate(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)

	var body struct {
		Name            string          `json:"name"`
		Description     string          `json:"description"`
		CanvasJSON      json.RawMessage `json:"canvas_json"`
		ThumbnailURL    string          `json:"thumbnail_url"`
		PageWidth       float64         `json:"page_width"`
		PageHeight      float64         `json:"page_height"`
		PageOrientation string          `json:"page_orientation"`
		FieldsUsed      []string        `json:"fields_used"`
	}
	if err := json.Unmarshal(c.Body(), &body); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "invalid body"})
	}

	t := &domain.DocumentTemplate{
		AccountID:       accountID,
		Name:            body.Name,
		Description:     body.Description,
		CanvasJSON:      body.CanvasJSON,
		ThumbnailURL:    body.ThumbnailURL,
		PageWidth:       body.PageWidth,
		PageHeight:      body.PageHeight,
		PageOrientation: body.PageOrientation,
		FieldsUsed:      body.FieldsUsed,
		CreatedBy:       &userID,
	}

	if err := s.services.DocumentTemplate.Create(c.Context(), t); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"success": true, "template": t})
}

func (s *Server) handleUpdateDocumentTemplate(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "invalid id"})
	}

	var body struct {
		Name            string          `json:"name"`
		Description     string          `json:"description"`
		CanvasJSON      json.RawMessage `json:"canvas_json"`
		ThumbnailURL    string          `json:"thumbnail_url"`
		PageWidth       float64         `json:"page_width"`
		PageHeight      float64         `json:"page_height"`
		PageOrientation string          `json:"page_orientation"`
		FieldsUsed      []string        `json:"fields_used"`
	}
	if err := json.Unmarshal(c.Body(), &body); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "invalid body"})
	}

	t := &domain.DocumentTemplate{
		ID:              id,
		AccountID:       accountID,
		Name:            body.Name,
		Description:     body.Description,
		CanvasJSON:      body.CanvasJSON,
		ThumbnailURL:    body.ThumbnailURL,
		PageWidth:       body.PageWidth,
		PageHeight:      body.PageHeight,
		PageOrientation: body.PageOrientation,
		FieldsUsed:      body.FieldsUsed,
	}

	if err := s.services.DocumentTemplate.Update(c.Context(), t); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true, "template": t})
}

func (s *Server) handleDeleteDocumentTemplate(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "invalid id"})
	}

	if err := s.services.DocumentTemplate.Delete(c.Context(), id, accountID); err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleDuplicateDocumentTemplate(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "invalid id"})
	}

	t, err := s.services.DocumentTemplate.Duplicate(c.Context(), id, accountID, &userID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"success": true, "template": t})
}

func (s *Server) handleImportDocumentTemplate(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)

	var body struct {
		Name            string          `json:"name"`
		Description     string          `json:"description"`
		CanvasJSON      json.RawMessage `json:"canvas_json"`
		PageWidth       float64         `json:"page_width"`
		PageHeight      float64         `json:"page_height"`
		PageOrientation string          `json:"page_orientation"`
		FieldsUsed      []string        `json:"fields_used"`
	}
	if err := json.Unmarshal(c.Body(), &body); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "invalid JSON"})
	}

	t := &domain.DocumentTemplate{
		AccountID:       accountID,
		Name:            body.Name,
		Description:     body.Description,
		CanvasJSON:      body.CanvasJSON,
		PageWidth:       body.PageWidth,
		PageHeight:      body.PageHeight,
		PageOrientation: body.PageOrientation,
		FieldsUsed:      body.FieldsUsed,
		CreatedBy:       &userID,
	}

	if err := s.services.DocumentTemplate.Create(c.Context(), t); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"success": true, "template": t})
}
