package api

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"mime/multipart"
	"net/http"
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

type surveyBrandImage struct {
	data        []byte
	contentType string
	extension   string
	filename    string
	width       int
	height      int
}

func readSurveyBrandImage(file *multipart.FileHeader, slot string) (*surveyBrandImage, error) {
	maxBytes := int64(2 * 1024 * 1024)
	if slot == "background" {
		maxBytes = 6 * 1024 * 1024
	}
	if file == nil || file.Size <= 0 || file.Size > maxBytes {
		return nil, fmt.Errorf("la imagen de %s supera el tamaño permitido", slot)
	}
	source, err := file.Open()
	if err != nil {
		return nil, errors.New("no se pudo leer la imagen")
	}
	defer source.Close()
	data, err := io.ReadAll(io.LimitReader(source, maxBytes+1))
	if err != nil || len(data) == 0 || int64(len(data)) > maxBytes {
		return nil, errors.New("no se pudo validar la imagen")
	}
	contentType := strings.ToLower(strings.TrimSpace(strings.SplitN(http.DetectContentType(data), ";", 2)[0]))
	var width, height int
	var extension string
	switch contentType {
	case "image/jpeg":
		extension = ".jpg"
	case "image/png":
		extension = ".png"
	case "image/webp":
		extension = ".webp"
		var animated bool
		width, height, animated, err = inspectWebP(data)
		if err != nil || animated {
			return nil, errors.New("la imagen WebP debe ser estática y válida")
		}
	default:
		return nil, errors.New("solo se admiten imágenes JPG, PNG o WebP")
	}
	if contentType != "image/webp" {
		config, _, decodeErr := image.DecodeConfig(bytes.NewReader(data))
		if decodeErr != nil {
			return nil, errors.New("la imagen no es válida")
		}
		width, height = config.Width, config.Height
	}
	if width <= 0 || height <= 0 {
		return nil, errors.New("la imagen no tiene dimensiones válidas")
	}
	if slot == "logo" {
		if width > 4096 || height > 4096 {
			return nil, errors.New("el logo no puede superar 4096 px por lado")
		}
	} else if width > 6000 || height > 6000 || (width < 800 && height < 800) || (width < 450 && height < 450) {
		return nil, errors.New("el fondo debe medir entre 800×450 y 6000 px por lado")
	}
	filename := sanitizeSurveyUploadFilename(file.Filename)
	if filename == "" {
		filename = slot + extension
	}
	return &surveyBrandImage{data: data, contentType: contentType, extension: extension, filename: filename, width: width, height: height}, nil
}

func (s *Server) uploadSurveyBrandImage(c *fiber.Ctx, accountID, templateID uuid.UUID, slot string, file *multipart.FileHeader) (*domain.MediaAsset, bool, error) {
	validated, err := readSurveyBrandImage(file, slot)
	if err != nil {
		return nil, false, err
	}
	rawHash := fmt.Sprintf("%x", sha256.Sum256(validated.data))
	existing, contentHash, err := s.findNonStatusMediaAsset(c.Context(), accountID, rawHash)
	if err != nil {
		return nil, false, err
	}
	if existing != nil {
		return existing, false, nil
	}
	if s.storage == nil {
		return nil, false, errors.New("el almacenamiento de imágenes no está disponible")
	}
	if err := s.ensureStorageQuota(c.Context(), accountID, int64(len(validated.data))); err != nil {
		return nil, false, fmt.Errorf("storage quota: %w", err)
	}
	objectKey := fmt.Sprintf("%s/surveys/branding/%s/%s-%s%s", accountID, templateID, contentHash, uuid.NewString(), validated.extension)
	if _, err := s.storage.UploadObject(c.Context(), objectKey, validated.data, validated.contentType); err != nil {
		return nil, false, err
	}
	asset, err := s.repos.MediaAsset.Upsert(c.Context(), repository.MediaAssetUpsert{
		AccountID: accountID, ContentHash: contentHash, ObjectKey: objectKey,
		MediaType: "image", ContentType: validated.contentType, Filename: validated.filename, SizeBytes: int64(len(validated.data)),
	})
	if err != nil {
		_, _ = s.repos.DB().Exec(c.Context(), `
			INSERT INTO storage_objects (account_id,object_key,media_type,content_type,filename,size_bytes,source,status,next_delete_at,updated_at)
			VALUES ($1,$2,'image',$3,$4,$5,'survey_branding','survey_branding_orphan_candidate',NOW()+INTERVAL '7 days',NOW())
			ON CONFLICT (account_id,object_key) DO UPDATE SET status='survey_branding_orphan_candidate',next_delete_at=NOW()+INTERVAL '7 days',updated_at=NOW()
		`, accountID, objectKey, validated.contentType, validated.filename, int64(len(validated.data)))
		return nil, true, err
	}
	if asset.ObjectKey != objectKey {
		_ = s.storage.DeleteFile(c.Context(), objectKey)
		return asset, false, nil
	}
	_, err = s.repos.DB().Exec(c.Context(), `
		INSERT INTO storage_objects (account_id,object_key,media_type,content_type,filename,size_bytes,source,status,updated_at)
		VALUES ($1,$2,'image',$3,$4,$5,'survey_branding','active',NOW())
		ON CONFLICT (account_id,object_key) DO UPDATE SET content_type=EXCLUDED.content_type,filename=EXCLUDED.filename,
			size_bytes=EXCLUDED.size_bytes,source='survey_branding',status='active',next_delete_at=NULL,deleted_at=NULL,updated_at=NOW()
	`, accountID, asset.ObjectKey, asset.ContentType, asset.Filename, asset.SizeBytes)
	if err != nil {
		return nil, true, err
	}
	return asset, true, nil
}

func (s *Server) markSurveyBrandingCandidates(c *fiber.Ctx, accountID uuid.UUID, objectKeys []string) {
	for _, objectKey := range objectKeys {
		_, _ = s.repos.DB().Exec(c.Context(), `UPDATE storage_objects
			SET status='survey_branding_orphan_candidate',next_delete_at=NOW()+INTERVAL '7 days',updated_at=NOW()
			WHERE account_id=$1 AND object_key=$2`, accountID, objectKey)
	}
}

func surveyTemplateError(c *fiber.Ctx, err error) error {
	var nameConflict *repository.SurveyInstanceNameConflictError
	if errors.As(err, &nameConflict) {
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{
			"error":          nameConflict.Error(),
			"code":           "survey_instance_name_conflict",
			"suggested_name": nameConflict.SuggestedName,
		})
	}
	switch {
	case errors.Is(err, repository.ErrSurveyTemplateNotFound), errors.Is(err, repository.ErrSurveyInstanceNotFound):
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Recurso no encontrado"})
	case errors.Is(err, repository.ErrSurveyProgramUnavailable):
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{"error": "Solo se pueden aplicar encuestas a programas activos de clases"})
	case errors.Is(err, repository.ErrSurveyProgramNoParticipants):
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{"error": "Agrega al menos un participante activo antes de crear la encuesta"})
	case errors.Is(err, repository.ErrSurveyTemplateEmpty):
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{"error": "La plantilla necesita al menos una pregunta activa"})
	case errors.Is(err, repository.ErrSurveyMeasurementIncompatible):
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	case strings.Contains(err.Error(), "obligatorio"), strings.Contains(err.Error(), "inválid"),
		strings.Contains(err.Error(), "demasiado"), strings.Contains(err.Error(), "posterior"),
		strings.Contains(err.Error(), "opciones"), strings.Contains(err.Error(), "pregunta"),
		strings.Contains(err.Error(), "archivad"), strings.Contains(err.Error(), "enlace único"),
		strings.Contains(err.Error(), "dimensión"), strings.Contains(err.Error(), "puntaje"),
		strings.Contains(err.Error(), "peso"), strings.Contains(err.Error(), "medición"),
		strings.Contains(err.Error(), "colores"), strings.Contains(err.Error(), "tipografía"),
		strings.Contains(err.Error(), "opacidad"), strings.Contains(err.Error(), "URL de imagen"),
		strings.Contains(err.Error(), "no pertenece"):
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	default:
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "No se pudo completar la operación"})
	}
}

func (s *Server) handleSuggestSurveyInstanceName(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	templateID, err := uuid.Parse(c.Params("templateId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "ID inválido"})
	}
	var programID *uuid.UUID
	if raw := strings.TrimSpace(c.Query("program_id")); raw != "" {
		parsed, parseErr := uuid.Parse(raw)
		if parseErr != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Programa inválido"})
		}
		programID = &parsed
	}
	suggestion, err := s.services.SurveyTemplate.SuggestInstanceName(c.Context(), accountID, templateID, programID, c.Query("name"))
	if err != nil {
		return surveyTemplateError(c, err)
	}
	return c.JSON(suggestion)
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

func (s *Server) handleUpdateSurveyTemplateDesign(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	templateID, err := uuid.Parse(c.Params("templateId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "ID inválido"})
	}
	current, err := s.services.SurveyTemplate.Get(c.Context(), accountID, templateID)
	if err != nil {
		return surveyTemplateError(c, err)
	}
	var branding domain.SurveyBranding
	if err := json.Unmarshal([]byte(c.FormValue("branding")), &branding); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "El diseño enviado no es válido"})
	}
	logoAssetID := current.Branding.LogoMediaAssetID
	backgroundAssetID := current.Branding.BgImageMediaAssetID
	newObjects := make([]string, 0, 2)
	applySlot := func(slot string, assetID **uuid.UUID, targetURL *string) error {
		action := strings.ToLower(strings.TrimSpace(c.FormValue(slot + "_action")))
		if action == "" {
			action = "keep"
		}
		switch action {
		case "keep":
			*assetID = map[string]*uuid.UUID{"logo": current.Branding.LogoMediaAssetID, "background": current.Branding.BgImageMediaAssetID}[slot]
			*targetURL = map[string]string{"logo": current.Branding.LogoURL, "background": current.Branding.BgImageURL}[slot]
		case "remove":
			*assetID = nil
			*targetURL = ""
		case "external":
			*assetID = nil
		case "upload":
			file, fileErr := c.FormFile(slot)
			if fileErr != nil {
				return fmt.Errorf("selecciona una imagen para %s", slot)
			}
			asset, uploaded, uploadErr := s.uploadSurveyBrandImage(c, accountID, templateID, slot, file)
			if uploadErr != nil {
				return uploadErr
			}
			*assetID = &asset.ID
			*targetURL = mediaProxyURLFromObjectKey(asset.ObjectKey)
			if uploaded {
				newObjects = append(newObjects, asset.ObjectKey)
			}
		default:
			return fmt.Errorf("acción de %s inválida", slot)
		}
		return nil
	}
	if err := applySlot("logo", &logoAssetID, &branding.LogoURL); err != nil {
		s.markSurveyBrandingCandidates(c, accountID, newObjects)
		if strings.Contains(err.Error(), "storage quota") {
			return c.Status(fiber.StatusInsufficientStorage).JSON(fiber.Map{"error": "La cuenta alcanzó su límite de almacenamiento", "code": "storage_quota"})
		}
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	}
	if err := applySlot("background", &backgroundAssetID, &branding.BgImageURL); err != nil {
		s.markSurveyBrandingCandidates(c, accountID, newObjects)
		if strings.Contains(err.Error(), "storage quota") {
			return c.Status(fiber.StatusInsufficientStorage).JSON(fiber.Map{"error": "La cuenta alcanzó su límite de almacenamiento", "code": "storage_quota"})
		}
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	}
	updated, err := s.services.SurveyTemplate.UpdateDesign(c.Context(), accountID, templateID, branding, logoAssetID, backgroundAssetID)
	if err != nil {
		s.markSurveyBrandingCandidates(c, accountID, newObjects)
		return surveyTemplateError(c, err)
	}
	return c.JSON(updated)
}

func (s *Server) handleDuplicateSurveyTemplate(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	templateID, err := uuid.Parse(c.Params("templateId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "ID inválido"})
	}
	var req struct {
		Name string `json:"name"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Solicitud inválida"})
	}
	copyTemplate, err := s.services.SurveyTemplate.Duplicate(c.Context(), accountID, templateID, req.Name, &userID)
	if err != nil {
		return surveyTemplateError(c, err)
	}
	return c.Status(fiber.StatusCreated).JSON(copyTemplate)
}

func (s *Server) handleUpdateSurveyTemplateMeasurement(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	templateID, err := uuid.Parse(c.Params("templateId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "ID inválido"})
	}
	var mutation domain.SurveyMeasurementMutation
	if err := c.BodyParser(&mutation); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Solicitud inválida"})
	}
	template, questions, err := s.services.SurveyTemplate.UpdateMeasurement(c.Context(), accountID, templateID, mutation)
	if err != nil {
		return surveyTemplateError(c, err)
	}
	return c.JSON(fiber.Map{"template": template, "questions": questions})
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
	includeArchived, _ := strconv.ParseBool(c.Query("include_archived", "false"))
	instances, err := s.services.SurveyTemplate.ListTemplateInstances(c.Context(), accountID, templateID, includeArchived)
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
	includeArchived, _ := strconv.ParseBool(c.Query("include_archived", "false"))
	instances, err := s.services.SurveyTemplate.ListProgramInstances(c.Context(), accountID, programID, includeArchived)
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

func (s *Server) handleGetProgramSurveyMeasurements(c *fiber.Ctx) error {
	if !s.contactAvatarCallerHasPermission(c, domain.PermSurveys) {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "No tienes permiso para consultar encuestas"})
	}
	accountID := c.Locals("account_id").(uuid.UUID)
	programID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "ID de programa inválido"})
	}
	templateID, err := uuid.Parse(c.Query("template_id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Selecciona una plantilla válida"})
	}
	parseOptionalID := func(raw string) (*uuid.UUID, error) {
		if strings.TrimSpace(raw) == "" {
			return nil, nil
		}
		value, parseErr := uuid.Parse(raw)
		if parseErr != nil {
			return nil, parseErr
		}
		return &value, nil
	}
	baselineID, err := parseOptionalID(c.Query("baseline_id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Aplicación inicial inválida"})
	}
	followupID, err := parseOptionalID(c.Query("followup_id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Aplicación final inválida"})
	}
	series, err := s.services.SurveyTemplate.ProgramMeasurementSeries(
		c.Context(), accountID, programID, templateID, c.Query("signature"), baselineID, followupID,
	)
	if err != nil {
		return surveyTemplateError(c, err)
	}
	return c.JSON(series)
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
