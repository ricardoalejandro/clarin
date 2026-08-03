package api

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/storage"
)

const maxTaskAttachmentBytes = int64(50 * 1024 * 1024)

func taskAttachmentUploadScope(raw string) (string, string, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "", "task":
		return repository.TaskAttachmentScopeTask, domain.TaskAccessEdit, nil
	case "comment":
		return repository.TaskAttachmentScopeCommentDraft, domain.TaskAccessComment, nil
	default:
		return "", "", repository.ErrTaskAccessInvalid
	}
}

func taskAttachmentObjectKey(accountID uuid.UUID, contentHash, objectID, extension string) string {
	return storage.PrivateObjectKey(accountID, "tasks", "attachments", contentHash+"-"+objectID+extension)
}

// findTaskAttachmentMediaAsset keeps deduplication inside the Work privacy
// boundary. Reusing chat/survey/status media would either expose a task file
// through a public URL or make the source feature depend on a private object.
func (s *Server) findTaskAttachmentMediaAsset(ctx context.Context, accountID uuid.UUID, rawContentHash string) (*domain.MediaAsset, string, error) {
	contentHash := domain.MediaAssetHashTaskAttachmentPrefix + rawContentHash
	existing, err := s.repos.MediaAsset.GetByHash(ctx, accountID, contentHash)
	if err != nil {
		return nil, contentHash, err
	}
	if existing != nil {
		return existing, contentHash, nil
	}
	// Reuse historical, unprefixed assets only when their object key proves
	// they already belong to the protected Work namespace.
	legacy, err := s.repos.MediaAsset.GetByHash(ctx, accountID, rawContentHash)
	if err != nil {
		return nil, contentHash, err
	}
	if legacy != nil && storage.IsProtectedTaskObjectKey(legacy.ObjectKey) {
		return legacy, rawContentHash, nil
	}
	return nil, contentHash, nil
}

type normalizedTaskAttachment struct {
	Filename    string
	ContentType string
	MediaType   string
	Extension   string
}

func normalizeTaskAttachment(filename, claimedType string, data []byte) (normalizedTaskAttachment, error) {
	filename = strings.TrimSpace(filepath.Base(filename))
	if filename == "" || filename == "." {
		filename = "adjunto"
	}
	if len(data) == 0 {
		return normalizedTaskAttachment{}, fmt.Errorf("el archivo está vacío")
	}
	detected := strings.ToLower(strings.TrimSpace(strings.SplitN(http.DetectContentType(data), ";", 2)[0]))
	claimed := strings.ToLower(strings.TrimSpace(strings.SplitN(claimedType, ";", 2)[0]))
	ext := strings.ToLower(filepath.Ext(filename))
	if len(ext) > 12 || strings.ContainsAny(ext, `/\\`) {
		ext = ""
	}
	if strings.HasPrefix(claimed, "image/") && !strings.HasPrefix(detected, "image/") {
		return normalizedTaskAttachment{}, fmt.Errorf("el contenido no coincide con una imagen válida")
	}
	contentType := detected
	if detected == "application/octet-stream" || detected == "application/zip" {
		switch ext {
		case ".docx":
			contentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
		case ".xlsx":
			contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
		case ".pptx":
			contentType = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
		case ".doc":
			contentType = "application/msword"
		case ".xls":
			contentType = "application/vnd.ms-excel"
		case ".csv":
			contentType = "text/csv"
		}
	}
	if ext == "" {
		ext = extensionForTaskAttachment(contentType)
	}
	mediaType := classifyStorageMediaType(filename, contentType)
	if mediaType == "other" && (strings.HasPrefix(contentType, "application/") || strings.HasPrefix(contentType, "text/")) {
		mediaType = "document"
	}
	return normalizedTaskAttachment{
		Filename:    filename,
		ContentType: contentType,
		MediaType:   mediaType,
		Extension:   ext,
	}, nil
}

func extensionForTaskAttachment(contentType string) string {
	switch contentType {
	case "image/jpeg":
		return ".jpg"
	case "image/png":
		return ".png"
	case "image/gif":
		return ".gif"
	case "image/webp":
		return ".webp"
	case "application/pdf":
		return ".pdf"
	case "text/plain":
		return ".txt"
	default:
		return ".bin"
	}
}

func (s *Server) handleUploadTaskAttachment(c *fiber.Ctx) error {
	if s.storage == nil {
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"success": false, "error": "Storage no está configurado"})
	}
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	operationID := uuid.New()
	if rawOperationID := strings.TrimSpace(c.FormValue("operation_id")); rawOperationID != "" {
		parsedOperationID, parseErr := uuid.Parse(rawOperationID)
		if parseErr != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "operation_id inválido"})
		}
		operationID = parsedOperationID
	}
	taskID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Tarea inválida"})
	}
	uploadScope, requiredAccess, err := taskAttachmentUploadScope(c.FormValue("attachment_context"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Contexto de adjunto inválido"})
	}
	if _, err := s.repos.TaskWork.RequireTaskAccess(c.Context(), accountID, userID, taskID, requiredAccess); err != nil {
		return taskWorkError(c, err)
	}

	header, err := c.FormFile("file")
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Selecciona un archivo"})
	}
	if header.Size <= 0 || header.Size > maxTaskAttachmentBytes {
		return c.Status(fiber.StatusRequestEntityTooLarge).JSON(fiber.Map{"success": false, "error": "El archivo supera el máximo de 50 MB", "code": "task_attachment_too_large"})
	}
	source, err := header.Open()
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "No se pudo leer el archivo"})
	}
	defer source.Close()
	data, err := io.ReadAll(io.LimitReader(source, maxTaskAttachmentBytes+1))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "No se pudo leer el archivo"})
	}
	if int64(len(data)) > maxTaskAttachmentBytes {
		return c.Status(fiber.StatusRequestEntityTooLarge).JSON(fiber.Map{"success": false, "error": "El archivo supera el máximo de 50 MB", "code": "task_attachment_too_large"})
	}
	normalized, err := normalizeTaskAttachment(header.Filename, header.Header.Get("Content-Type"), data)
	if err != nil {
		return c.Status(fiber.StatusUnsupportedMediaType).JSON(fiber.Map{"success": false, "error": err.Error(), "code": "invalid_task_attachment"})
	}

	hash := sha256.Sum256(data)
	rawHash := fmt.Sprintf("%x", hash[:])
	existing, contentHash, err := s.findTaskAttachmentMediaAsset(c.Context(), accountID, rawHash)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudo validar el inventario"})
	}
	if existing == nil {
		if err := s.ensureStorageQuota(c.Context(), accountID, int64(len(data))); err != nil {
			return c.Status(fiber.StatusInsufficientStorage).JSON(fiber.Map{"success": false, "error": "Límite de almacenamiento alcanzado", "code": "storage_limit_reached"})
		}
	}
	objectKey := taskAttachmentObjectKey(accountID, contentHash, uuid.NewString(), normalized.Extension)
	asset, uploadRequired, err := s.repos.TaskWork.ReserveTaskAttachmentAsset(c.Context(), repository.MediaAssetUpsert{
		AccountID: accountID, ContentHash: contentHash, ObjectKey: objectKey,
		MediaType: normalized.MediaType, ContentType: normalized.ContentType,
		Filename: normalized.Filename, SizeBytes: int64(len(data)),
	})
	if err != nil {
		if err == repository.ErrTaskAttachmentUploadInProgress {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "error": "Este archivo ya se está cargando", "code": "task_attachment_upload_in_progress"})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudo reservar el archivo"})
	}
	if uploadRequired {
		if _, err := s.storage.UploadObject(c.Context(), asset.ObjectKey, data, normalized.ContentType); err != nil {
			_ = s.repos.TaskWork.MarkTaskAttachmentUploadFailed(c.Context(), accountID, asset.ID, "storage upload failed")
			return c.Status(fiber.StatusBadGateway).JSON(fiber.Map{"success": false, "error": "No se pudo subir el archivo", "code": "task_attachment_storage_failed"})
		}
	}

	item, changed, err := s.repos.TaskWork.AttachReservedTaskAsset(c.Context(), accountID, taskID, asset.ID, userID, operationID, uploadScope)
	if err != nil {
		if uploadRequired {
			_ = s.repos.TaskWork.MarkTaskAttachmentUploadFailed(c.Context(), accountID, asset.ID, "task attachment failed")
		}
		return taskWorkError(c, err)
	}
	s.invalidateTasksCache(accountID)
	if uploadScope == repository.TaskAttachmentScopeTask && changed {
		s.broadcastTaskWork(c.Context(), accountID, "attachment_added", fiber.Map{"task_id": taskID, "attachment": item, "operation_id": operationID})
	}
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"success": true, "attachment": item, "deduped": !changed,
		"attachment_context": strings.TrimSpace(c.FormValue("attachment_context")), "operation_id": operationID})
}
