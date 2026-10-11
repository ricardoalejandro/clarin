package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"log"
	"strconv"
	"strings"
	"time"
)

type documentWriteBody struct {
	Name             string          `json:"name"`
	Description      string          `json:"description"`
	CanvasJSON       json.RawMessage `json:"canvas_json"`
	ThumbnailURL     string          `json:"thumbnail_url"`
	PageWidth        float64         `json:"page_width"`
	PageHeight       float64         `json:"page_height"`
	PageOrientation  string          `json:"page_orientation"`
	FieldsUsed       []string        `json:"fields_used"`
	SourceTemplateID *uuid.UUID      `json:"source_template_id,omitempty"`
	ExpectedRevision int64           `json:"expected_revision"`
}

func documentError(c *fiber.Ctx, status int, code, message string) error {
	return c.Status(status).JSON(fiber.Map{"success": false, "code": code, "error": message})
}
func (s *Server) documentFailure(c *fiber.Ctx, err error, id, account uuid.UUID) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return documentError(c, 404, "document_not_found", "La plantilla ya no está disponible.")
	}
	if errors.Is(err, repository.ErrDocumentTemplateConflict) {
		canonical, e := s.services.DocumentTemplate.GetByID(c.Context(), id, account)
		if e != nil {
			return s.documentFailure(c, e, id, account)
		}
		return c.Status(409).JSON(fiber.Map{"success": false, "code": "document_conflict", "error": "La plantilla cambió en otra sesión. Conservamos tus cambios para que puedas revisarlos.", "template": canonical})
	}
	kind := "unavailable"
	var postgres *pgconn.PgError
	if errors.Is(err, context.DeadlineExceeded) {
		kind = "deadline"
	} else if errors.Is(err, context.Canceled) {
		kind = "cancelled"
	} else if errors.As(err, &postgres) {
		kind = "postgres:" + postgres.Code
	}
	log.Printf("[Documents] operation failed category=%s", kind)
	return documentError(c, 500, "document_unavailable", "No se pudo completar la operación. Inténtalo de nuevo.")
}

type documentPageCursor struct {
	Account uuid.UUID `json:"a"`
	Query   string    `json:"q"`
	Before  time.Time `json:"t"`
	ID      uuid.UUID `json:"i"`
}

func (s *Server) handleListDocumentTemplates(c *fiber.Ctx) error {
	account := c.Locals("account_id").(uuid.UUID)
	f := repository.DocumentTemplatePageFilter{Query: strings.TrimSpace(c.Query("q")), Limit: c.QueryInt("limit", 50)}
	if len(f.Query) > 256 {
		return documentError(c, 400, "document_invalid", "La búsqueda es demasiado larga.")
	}
	if raw := c.Query("cursor"); raw != "" {
		if len(raw) > 4096 {
			return documentError(c, 400, "document_invalid_cursor", "Vuelve a cargar las plantillas.")
		}
		var cursor documentPageCursor
		data, err := base64.RawURLEncoding.DecodeString(raw)
		if err != nil || json.Unmarshal(data, &cursor) != nil || cursor.Account != account || cursor.Query != f.Query || cursor.Before.IsZero() || cursor.ID == uuid.Nil {
			return documentError(c, 400, "document_invalid_cursor", "Vuelve a cargar las plantillas.")
		}
		f.Before = &cursor.Before
		f.BeforeID = cursor.ID
	}
	values, total, more, err := s.repos.DocumentTemplate.ListPage(c.Context(), account, f)
	if err != nil {
		return s.documentFailure(c, err, uuid.Nil, account)
	}
	next := ""
	if more && len(values) > 0 {
		last := values[len(values)-1]
		raw, _ := json.Marshal(documentPageCursor{account, f.Query, last.UpdatedAt, last.ID})
		next = base64.RawURLEncoding.EncodeToString(raw)
	}
	return c.JSON(fiber.Map{"success": true, "templates": values, "total": total, "has_more": more, "next_cursor": next})
}
func (s *Server) handleGetDocumentTemplate(c *fiber.Ctx) error {
	account := c.Locals("account_id").(uuid.UUID)
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return documentError(c, 404, "document_not_found", "La plantilla no está disponible.")
	}
	t, err := s.services.DocumentTemplate.GetByID(c.Context(), id, account)
	if err != nil {
		return s.documentFailure(c, err, id, account)
	}
	return c.JSON(fiber.Map{"success": true, "template": t})
}
func (s *Server) writeDocument(c *fiber.Ctx, update bool) error {
	account := c.Locals("account_id").(uuid.UUID)
	user := c.Locals("user_id").(uuid.UUID)
	var body documentWriteBody
	if len(c.Body()) > 3*1024*1024 {
		return documentError(c, 413, "document_too_large", "El archivo de plantilla es demasiado grande.")
	}
	if json.Unmarshal(c.Body(), &body) != nil {
		return documentError(c, 422, "document_invalid", "El archivo de plantilla no es JSON válido.")
	}
	// Bound the design before walking references or issuing authorization queries.
	if body.CanvasJSON != nil {
		if err := domain.ValidateDocumentCanvas(body.CanvasJSON); err != nil {
			return documentError(c, 422, "document_invalid", err.Error())
		}
	}
	// Publication authorization remains an independent write boundary.
	if err := s.authorizeDocumentMediaPayload(c, body); err != nil {
		return mediaPublicationDenied(c, err)
	}
	t := &domain.DocumentTemplate{AccountID: account, Name: body.Name, Description: body.Description, CanvasJSON: body.CanvasJSON, ThumbnailURL: body.ThumbnailURL, PageWidth: body.PageWidth, PageHeight: body.PageHeight, PageOrientation: body.PageOrientation, FieldsUsed: body.FieldsUsed, CreatedBy: &user}
	if !update {
		if t.PageWidth == 0 {
			t.PageWidth = 210
		}
		if t.PageHeight == 0 {
			t.PageHeight = 297
		}
		if t.PageOrientation == "" {
			t.PageOrientation = "portrait"
		}
		if t.CanvasJSON == nil {
			t.CanvasJSON = []byte("{}")
		}
	}
	if err := s.validateDocumentAssets(c, body, update); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return documentError(c, 404, "document_not_found", "La plantilla no está disponible.")
		}
		var invalid *documentAssetValidationError
		if !errors.As(err, &invalid) {
			return s.documentFailure(c, err, uuid.Nil, account)
		}
		return documentError(c, 422, "document_image_invalid", invalid.Error())
	}
	if t.FieldsUsed == nil {
		t.FieldsUsed = []string{}
	}
	if err := domain.ValidateDocumentTemplate(t); err != nil {
		return documentError(c, 422, "document_invalid", err.Error())
	}
	if update {
		id, err := uuid.Parse(c.Params("id"))
		if err != nil {
			return documentError(c, 404, "document_not_found", "La plantilla no está disponible.")
		}
		t.ID = id
		if body.ExpectedRevision < 1 {
			return documentError(c, 428, "document_revision_required", "Recarga la plantilla antes de guardar. Tus cambios siguen disponibles.")
		}
		if err = s.services.DocumentTemplate.Update(c.Context(), t, body.ExpectedRevision); err != nil {
			return s.documentFailure(c, err, id, account)
		}
		return c.JSON(fiber.Map{"success": true, "template": t})
	}
	if err := s.services.DocumentTemplate.Create(c.Context(), t); err != nil {
		return s.documentFailure(c, err, uuid.Nil, account)
	}
	return c.Status(201).JSON(fiber.Map{"success": true, "template": t})
}
func (s *Server) handleCreateDocumentTemplate(c *fiber.Ctx) error { return s.writeDocument(c, false) }
func (s *Server) handleImportDocumentTemplate(c *fiber.Ctx) error { return s.writeDocument(c, false) }
func (s *Server) handleUpdateDocumentTemplate(c *fiber.Ctx) error { return s.writeDocument(c, true) }
func (s *Server) handleDeleteDocumentTemplate(c *fiber.Ctx) error {
	account := c.Locals("account_id").(uuid.UUID)
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return documentError(c, 404, "document_not_found", "La plantilla no está disponible.")
	}
	expected, err := strconv.ParseInt(c.Query("expected_revision"), 10, 64)
	if err != nil || expected < 1 {
		return documentError(c, 428, "document_revision_required", "Recarga la plantilla antes de eliminarla.")
	}
	if err = s.services.DocumentTemplate.Delete(c.Context(), id, account, expected); err != nil {
		return s.documentFailure(c, err, id, account)
	}
	return c.JSON(fiber.Map{"success": true})
}
func (s *Server) handleDuplicateDocumentTemplate(c *fiber.Ctx) error {
	account := c.Locals("account_id").(uuid.UUID)
	user := c.Locals("user_id").(uuid.UUID)
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return documentError(c, 404, "document_not_found", "La plantilla no está disponible.")
	}
	t, err := s.services.DocumentTemplate.Duplicate(c.Context(), id, account, &user)
	if err != nil {
		return s.documentFailure(c, err, id, account)
	}
	return c.Status(201).JSON(fiber.Map{"success": true, "template": t})
}
