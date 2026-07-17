package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"log"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/storage"
	"github.com/naperu/clarin/internal/whatsapp"
	"github.com/naperu/clarin/internal/ws"
)

const (
	maxStatusTextLength      = 700
	maxStatusImageSize       = 16 * 1024 * 1024
	maxStatusVideoSize       = 30 * 1024 * 1024
	maxStatusImageDimension  = 8192
	maxStatusImagePixels     = 40_000_000
	statusPublishTimeout     = 2 * time.Minute
	statusPersistenceTimeout = 15 * time.Second
	statusReconcileTimeout   = 5 * time.Minute
	statusMediaDeleteTimeout = 30 * time.Second
	statusCleanupRunTimeout  = 4 * time.Minute
	statusCleanupInterval    = 5 * time.Minute
	statusCleanupStartDelay  = 15 * time.Second
	statusPendingStaleAfter  = 10 * time.Minute
	statusRevokeTimeout      = 30 * time.Second
)

func (s *Server) ensureWhatsAppStatusFeature(c *fiber.Ctx) error {
	if s.cfg == nil || !s.cfg.WhatsAppStatusEnabled {
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{
			"success": false,
			"error":   "Mis estados está pendiente de validación con un dispositivo real",
			"code":    "whatsapp_status_disabled",
		})
	}
	return nil
}

func (s *Server) handleListOwnWhatsAppStatuses(c *fiber.Ctx) error {
	if err := s.ensureWhatsAppStatusFeature(c); err != nil {
		return err
	}
	accountID := c.Locals("account_id").(uuid.UUID)
	deviceID, err := uuid.Parse(strings.TrimSpace(c.Query("device_id")))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "device_id is required"})
	}
	device, err := s.requireDeviceForAccount(c.Context(), accountID, deviceID)
	if err != nil || getDeviceProvider(device) != domain.DeviceProviderWhatsAppWeb {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Dispositivo no disponible para estados"})
	}

	statuses, err := s.repos.WhatsAppStatus.ListActive(c.Context(), accountID, deviceID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	presentedStatuses := make([]*domain.WhatsAppStatus, 0, len(statuses))
	for _, status := range statuses {
		presentedStatuses = append(presentedStatuses, presentWhatsAppStatus(status))
	}
	privacy := ""
	readReceiptsEnabled := false
	readReceiptsKnown := false
	if deviceCanSendManual(device) {
		if value, privacyErr := s.pool.GetStatusPrivacy(c.Context(), deviceID); privacyErr == nil {
			privacy = value
		}
		if value, receiptErr := s.pool.StatusReadReceiptsEnabled(c.Context(), deviceID); receiptErr == nil {
			readReceiptsEnabled = value
			readReceiptsKnown = true
		}
	}
	scope := "published_from_clarin"
	if s.cfg != nil && s.cfg.WhatsAppStatusSyncEnabled {
		scope = "own"
	}
	return c.JSON(fiber.Map{
		"success":               true,
		"statuses":              presentedStatuses,
		"privacy":               privacy,
		"scope":                 scope,
		"retention_hours":       24,
		"read_receipts_enabled": readReceiptsEnabled,
		"read_receipts_known":   readReceiptsKnown,
	})
}

func presentWhatsAppStatus(status *domain.WhatsAppStatus) *domain.WhatsAppStatus {
	if status == nil {
		return nil
	}
	presented := *status
	if status.MediaURL != nil && strings.TrimSpace(*status.MediaURL) != "" {
		mediaURL := fmt.Sprintf("/api/whatsapp/statuses/%s/media", status.ID)
		presented.MediaURL = &mediaURL
	}
	return &presented
}

func (s *Server) handleGetOwnWhatsAppStatusMedia(c *fiber.Ctx) error {
	c.Set("Cache-Control", "private, no-store, max-age=0")
	c.Set("Vary", "Cookie, Authorization")
	accountID := c.Locals("account_id").(uuid.UUID)
	statusID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Estado inválido"})
	}
	var objectKey, mediaURL, assetStatus string
	var hasAsset bool
	err = s.repos.DB().QueryRow(c.Context(), `
		SELECT COALESCE(ma.object_key,''), COALESCE(ws.media_url,''),
		       COALESCE(ma.status,''), ws.media_asset_id IS NOT NULL
		FROM whatsapp_statuses ws
		LEFT JOIN media_assets ma ON ma.account_id=ws.account_id AND ma.id=ws.media_asset_id
		WHERE ws.account_id=$1 AND ws.id=$2 AND ws.expires_at>NOW()
	`, accountID, statusID).Scan(&objectKey, &mediaURL, &assetStatus, &hasAsset)
	if err == pgx.ErrNoRows {
		return c.Status(fiber.StatusGone).JSON(fiber.Map{"success": false, "error": "El estado expiró"})
	}
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "No se pudo abrir el estado"})
	}
	if hasAsset && assetStatus != "active" {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Media no disponible"})
	}
	if objectKey == "" {
		objectKey = objectKeyFromMediaURL(mediaURL)
	}
	if objectKey == "" || !strings.HasPrefix(objectKey, accountID.String()+"/") {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Media no disponible"})
	}
	return s.serveStorageObject(c, objectKey, "private, no-store, max-age=0")
}

func (s *Server) handleListOwnWhatsAppStatusViewers(c *fiber.Ctx) error {
	if err := s.ensureWhatsAppStatusFeature(c); err != nil {
		return err
	}
	accountID := c.Locals("account_id").(uuid.UUID)
	statusID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Estado inválido"})
	}
	status, err := s.repos.WhatsAppStatus.GetByID(c.Context(), accountID, statusID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudieron cargar las visualizaciones"})
	}
	if status == nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"success": false, "error": "Estado no encontrado"})
	}
	page, parseErr := strconv.Atoi(c.Query("page", "1"))
	if parseErr != nil || page < 1 {
		page = 1
	}
	limit, parseErr := strconv.Atoi(c.Query("limit", "50"))
	if parseErr != nil || limit < 1 || limit > 100 {
		limit = 50
	}
	views, total, err := s.repos.WhatsAppStatus.ListViews(c.Context(), accountID, statusID, limit, (page-1)*limit)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudieron cargar las visualizaciones"})
	}
	readReceiptsEnabled := false
	readReceiptsKnown := false
	if value, receiptErr := s.pool.StatusReadReceiptsEnabled(c.Context(), status.DeviceID); receiptErr == nil {
		readReceiptsEnabled = value
		readReceiptsKnown = true
	}
	return c.JSON(fiber.Map{
		"success": true, "status_id": statusID, "viewers": views,
		"pagination": fiber.Map{
			"page": page, "limit": limit, "total": total, "has_more": page*limit < total,
		},
		"read_receipts_enabled": readReceiptsEnabled,
		"read_receipts_known":   readReceiptsKnown,
	})
}

func (s *Server) handleDeleteOwnWhatsAppStatus(c *fiber.Ctx) error {
	if err := s.ensureWhatsAppStatusFeature(c); err != nil {
		return err
	}
	accountID := c.Locals("account_id").(uuid.UUID)
	statusID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Estado inválido"})
	}
	status, err := s.repos.WhatsAppStatus.GetByID(c.Context(), accountID, statusID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudo eliminar el estado"})
	}
	// Idempotency deliberately does not reveal whether another account owns the
	// supplied UUID.
	if status == nil {
		return c.JSON(fiber.Map{"success": true, "deleted": false, "remote_deleted": false})
	}
	remoteDeleted := false
	if status.WhatsAppMessageID != nil && strings.TrimSpace(*status.WhatsAppMessageID) != "" {
		if _, err := s.requireManualDeviceForAccount(c.Context(), accountID, status.DeviceID); err != nil {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{
				"success": false, "error": "Conecta el dispositivo para borrar también el estado de WhatsApp",
				"code": "status_device_unavailable",
			})
		}
		revokeCtx, cancel := context.WithTimeout(context.Background(), statusRevokeTimeout)
		err := s.pool.RevokeStatus(revokeCtx, status.DeviceID, *status.WhatsAppMessageID)
		cancel()
		if err != nil {
			log.Printf("[WhatsAppStatus] remote revoke failed account=%s device=%s status=%s: %v", accountID, status.DeviceID, status.ID, err)
			return c.Status(fiber.StatusBadGateway).JSON(fiber.Map{
				"success": false, "error": "WhatsApp no confirmó la eliminación. El estado se conserva en Clarin para evitar una confirmación falsa.",
				"code": "status_remote_delete_failed",
			})
		}
		remoteDeleted = true
	}
	deleted, err := s.repos.WhatsAppStatus.DeleteByID(c.Context(), accountID, statusID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"success": false, "error": "WhatsApp confirmó la eliminación, pero Clarin aún debe reconciliarla.",
			"code": "status_local_delete_pending",
		})
	}
	if deleted == nil {
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{
			"success": false, "error": "La publicación todavía está en curso. Espera su confirmación antes de eliminarla.",
			"code": "status_publish_in_progress",
		})
	}
	if deleted != nil {
		s.scheduleDeletedWhatsAppStatusMedia(c.Context(), deleted)
		s.broadcastWhatsAppStatus(accountID, deleted.DeviceID, "deleted", &domain.WhatsAppStatus{
			ID: deleted.ID, AccountID: accountID, DeviceID: deleted.DeviceID, Status: "deleted",
		})
	}
	return c.JSON(fiber.Map{"success": true, "deleted": deleted != nil, "remote_deleted": remoteDeleted})
}

type statusUploadResult struct {
	MediaURL      *string
	MediaMimetype *string
	MediaSize     *int64
	MediaAssetID  *uuid.UUID
}

func statusMediaExtension(kind, mimetype, filename string) string {
	switch mimetype {
	case "image/jpeg":
		return ".jpg"
	case "image/png":
		return ".png"
	case "image/webp":
		return ".webp"
	case "video/mp4":
		return ".mp4"
	}
	if ext := strings.ToLower(filepath.Ext(filename)); ext != "" {
		return ext
	}
	if kind == "video" {
		return ".mp4"
	}
	return ".bin"
}

func (s *Server) storeWhatsAppStatusUpload(c *fiber.Ctx, accountID uuid.UUID, kind string) (*statusUploadResult, error) {
	if s.storage == nil {
		return nil, fiber.NewError(fiber.StatusServiceUnavailable, "Almacenamiento no configurado")
	}
	file, err := c.FormFile("media")
	if err != nil {
		return nil, fiber.NewError(fiber.StatusBadRequest, "Selecciona una imagen o video")
	}
	maxSize := int64(maxStatusImageSize)
	if kind == "video" {
		maxSize = int64(maxStatusVideoSize)
	}
	if file.Size <= 0 || file.Size > maxSize {
		return nil, fiber.NewError(fiber.StatusBadRequest, "El archivo supera el límite permitido")
	}
	source, err := file.Open()
	if err != nil {
		return nil, fiber.NewError(fiber.StatusBadRequest, "No se pudo leer el archivo")
	}
	defer source.Close()
	data, err := io.ReadAll(io.LimitReader(source, maxSize+1))
	if err != nil || int64(len(data)) > maxSize {
		return nil, fiber.NewError(fiber.StatusBadRequest, "No se pudo procesar el archivo")
	}
	if kind == "video" {
		// Reject arbitrary input before handing bytes to FFmpeg. The processed
		// output is validated again below because both boundaries are untrusted.
		if !isValidStatusMP4(data) {
			return nil, fiber.NewError(fiber.StatusUnsupportedMediaType, "El video debe ser un archivo MP4 válido")
		}
		manifest, manifestErr := parseStatusVideoEditManifest(c.FormValue("edit_manifest"))
		if manifestErr != nil {
			return nil, fiber.NewError(fiber.StatusBadRequest, manifestErr.Error())
		}
		var overlay []byte
		if overlayFile, overlayErr := c.FormFile("overlay"); overlayErr == nil && overlayFile != nil {
			if overlayFile.Size <= 0 || overlayFile.Size > maxStatusOverlaySize {
				return nil, fiber.NewError(fiber.StatusBadRequest, "El diseño del video supera el límite permitido")
			}
			overlaySource, openErr := overlayFile.Open()
			if openErr != nil {
				return nil, fiber.NewError(fiber.StatusBadRequest, "No se pudo leer el diseño del video")
			}
			overlay, openErr = io.ReadAll(io.LimitReader(overlaySource, int64(maxStatusOverlaySize)+1))
			_ = overlaySource.Close()
			if openErr != nil || len(overlay) > maxStatusOverlaySize {
				return nil, fiber.NewError(fiber.StatusBadRequest, "No se pudo procesar el diseño del video")
			}
		}
		if manifest != nil || len(overlay) > 0 {
			rendered, renderErr := renderStatusVideo(c.Context(), data, overlay, manifest)
			if renderErr != nil {
				if errors.Is(renderErr, errStatusVideoProcessorBusy) {
					return nil, fiber.NewError(fiber.StatusServiceUnavailable, "El editor de video está ocupado. Inténtalo nuevamente en unos segundos")
				}
				return nil, fiber.NewError(fiber.StatusUnprocessableEntity, renderErr.Error())
			}
			data = rendered
		}
	} else if strings.TrimSpace(c.FormValue("edit_manifest")) != "" {
		return nil, fiber.NewError(fiber.StatusBadRequest, "La edición de video no corresponde a una imagen")
	}
	mimetype := http.DetectContentType(data)
	if kind == "image" && mimetype != "image/jpeg" && mimetype != "image/png" && mimetype != "image/webp" {
		return nil, fiber.NewError(fiber.StatusUnsupportedMediaType, "Formato no compatible para estados")
	}
	if kind == "image" {
		var width, height int
		if mimetype == "image/webp" {
			var animated bool
			width, height, animated, err = inspectWebP(data)
			if err != nil || animated {
				return nil, fiber.NewError(fiber.StatusUnsupportedMediaType, "El WebP debe ser una imagen estática válida")
			}
		} else {
			config, _, decodeErr := image.DecodeConfig(bytes.NewReader(data))
			if decodeErr != nil {
				return nil, fiber.NewError(fiber.StatusUnsupportedMediaType, "La imagen no es válida")
			}
			width, height = config.Width, config.Height
		}
		if width < 1 || height < 1 || width > maxStatusImageDimension || height > maxStatusImageDimension || int64(width)*int64(height) > maxStatusImagePixels {
			return nil, fiber.NewError(fiber.StatusBadRequest, "La imagen supera las dimensiones permitidas")
		}
	}
	if kind == "video" {
		if !isValidStatusMP4(data) {
			return nil, fiber.NewError(fiber.StatusUnsupportedMediaType, "El video debe ser un archivo MP4 válido")
		}
		// DetectContentType may report application/octet-stream for uncommon
		// but structurally valid MP4 brands. WhatsApp expects the canonical MIME.
		mimetype = "video/mp4"
	}
	hash := sha256.Sum256(data)
	rawContentHash := fmt.Sprintf("%x", hash[:])
	contentHash := domain.MediaAssetHashWhatsAppStatusPrefix + rawContentHash
	if existing, lookupErr := s.repos.MediaAsset.GetByHash(c.Context(), accountID, contentHash); lookupErr == nil && existing != nil {
		url := mediaProxyURLFromObjectKey(existing.ObjectKey)
		size := existing.SizeBytes
		contentType := existing.ContentType
		return &statusUploadResult{MediaURL: &url, MediaMimetype: &contentType, MediaSize: &size, MediaAssetID: &existing.ID}, nil
	}
	// Reusing an active object consumes no additional quota. Only reserve
	// capacity when this request will actually upload new bytes.
	if err := s.ensureStorageQuota(c.Context(), accountID, int64(len(data))); err != nil {
		return nil, fiber.NewError(fiber.StatusInsufficientStorage, "Límite de almacenamiento alcanzado")
	}

	extension := statusMediaExtension(kind, mimetype, file.Filename)
	// Candidate keys are unique even for the same hash. The media_assets upsert
	// chooses one canonical object and the loser is removed below. This also
	// prevents a new upload from overwriting an object that the retention worker
	// has already tombstoned and is about to delete.
	objectKey := storage.PrivateObjectKey(accountID, "statuses", rawContentHash+"-"+uuid.NewString()+extension)
	if err := s.repos.WhatsAppStatus.PrepareMediaUpload(c.Context(), accountID, objectKey, kind, mimetype, filepath.Base(file.Filename), int64(len(data)), time.Now()); err != nil {
		return nil, fiber.NewError(fiber.StatusInternalServerError, "No se pudo reservar el archivo")
	}
	if _, err := s.storage.UploadObject(c.Context(), objectKey, data, mimetype); err != nil {
		return nil, fiber.NewError(fiber.StatusInternalServerError, "No se pudo guardar el archivo")
	}
	asset, err := s.repos.MediaAsset.Upsert(c.Context(), repository.MediaAssetUpsert{
		AccountID: accountID, ContentHash: contentHash, ObjectKey: objectKey,
		MediaType: kind, ContentType: mimetype, Filename: filepath.Base(file.Filename), SizeBytes: int64(len(data)),
	})
	if err != nil {
		if deleteErr := s.storage.DeleteFile(c.Context(), objectKey); deleteErr != nil {
			log.Printf("[WhatsAppStatus] failed to remove untracked upload %s: %v", objectKey, deleteErr)
		}
		return nil, err
	}
	// Another upload with the same hash may have won between GetByHash and
	// Upsert. The active asset is authoritative; discard this request's extra
	// object and return the canonical metadata instead of splitting URL/asset.
	if asset.ObjectKey != objectKey {
		if deleteErr := s.storage.DeleteFile(c.Context(), objectKey); deleteErr != nil {
			log.Printf("[WhatsAppStatus] failed to remove concurrent duplicate object %s: %v", objectKey, deleteErr)
		}
		url := mediaProxyURLFromObjectKey(asset.ObjectKey)
		size := asset.SizeBytes
		contentType := asset.ContentType
		return &statusUploadResult{MediaURL: &url, MediaMimetype: &contentType, MediaSize: &size, MediaAssetID: &asset.ID}, nil
	}
	_, _ = s.repos.DB().Exec(c.Context(), `
		INSERT INTO storage_objects (account_id, object_key, media_type, content_type, filename, size_bytes, source, status, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,'whatsapp_status','active',NOW())
		ON CONFLICT (account_id, object_key) DO UPDATE SET
			status='active', deleted_at=NULL, size_bytes=EXCLUDED.size_bytes,
			content_type=EXCLUDED.content_type, updated_at=NOW()
	`, accountID, objectKey, kind, mimetype, filepath.Base(file.Filename), int64(len(data)))
	url := mediaProxyURLFromObjectKey(asset.ObjectKey)
	size := asset.SizeBytes
	contentType := asset.ContentType
	return &statusUploadResult{MediaURL: &url, MediaMimetype: &contentType, MediaSize: &size, MediaAssetID: &asset.ID}, nil
}

func parseStatusColor(value string) *int64 {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	parsed, err := strconv.ParseInt(value, 0, 64)
	if err != nil || parsed < 0 || parsed > int64(^uint32(0)) {
		return nil
	}
	return &parsed
}

func parseStatusFont(value string) *int {
	parsed, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || parsed < 0 || parsed > 10 {
		return nil
	}
	return &parsed
}

func (s *Server) handlePublishOwnWhatsAppStatus(c *fiber.Ctx) error {
	if err := s.ensureWhatsAppStatusFeature(c); err != nil {
		return err
	}
	accountID := c.Locals("account_id").(uuid.UUID)
	deviceID, err := uuid.Parse(strings.TrimSpace(c.FormValue("device_id")))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Selecciona un dispositivo"})
	}
	if _, err := s.requireManualDeviceForAccount(c.Context(), accountID, deviceID); err != nil {
		return c.Status(409).JSON(fiber.Map{"success": false, "error": "El dispositivo no está disponible para publicar estados"})
	}
	kind := strings.ToLower(strings.TrimSpace(c.FormValue("kind")))
	if kind != "text" && kind != "image" && kind != "video" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Tipo de estado no compatible"})
	}
	text := strings.TrimSpace(c.FormValue("text"))
	caption := strings.TrimSpace(c.FormValue("caption"))
	if len([]rune(text)) > maxStatusTextLength || len([]rune(caption)) > maxStatusTextLength {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "El texto es demasiado largo"})
	}
	if kind == "text" && text == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Escribe el contenido del estado"})
	}

	var upload *statusUploadResult
	if kind != "text" {
		upload, err = s.storeWhatsAppStatusUpload(c, accountID, kind)
		if err != nil {
			if fiberErr, ok := err.(*fiber.Error); ok {
				return c.Status(fiberErr.Code).JSON(fiber.Map{"success": false, "error": fiberErr.Message})
			}
			return c.Status(500).JSON(fiber.Map{"success": false, "error": "No se pudo guardar el archivo"})
		}
	}

	now := time.Now()
	status := &domain.WhatsAppStatus{
		AccountID: accountID, DeviceID: deviceID, Source: "clarin", Kind: kind,
		Status: "pending", ExpiresAt: now.Add(24 * time.Hour),
		BackgroundARGB: parseStatusColor(c.FormValue("background_argb")),
		FontStyle:      parseStatusFont(c.FormValue("font_style")),
	}
	if text != "" {
		status.Text = &text
	}
	if caption != "" {
		status.Caption = &caption
	}
	if upload != nil {
		status.MediaURL, status.MediaMimetype, status.MediaSize, status.MediaAssetID = upload.MediaURL, upload.MediaMimetype, upload.MediaSize, upload.MediaAssetID
	}
	if err := s.repos.WhatsAppStatus.Create(c.Context(), status); err != nil {
		if upload != nil && upload.MediaAssetID != nil {
			cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), statusPersistenceTimeout)
			defer cleanupCancel()
			_ = s.repos.WhatsAppStatus.MarkMediaAssetOrphanedIfUnused(cleanupCtx, accountID, *upload.MediaAssetID)
		}
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "No se pudo preparar el estado"})
	}

	publishCtx, publishCancel := context.WithTimeout(context.Background(), statusPublishTimeout)
	defer publishCancel()
	result, publishErr := s.pool.PublishStatus(publishCtx, deviceID, whatsapp.StatusPublishRequest{
		Kind: kind, Text: text, Caption: caption, MediaURL: stringValueOrEmpty(status.MediaURL),
		BackgroundARGB: uint32Value(status.BackgroundARGB), FontStyle: int32Value(status.FontStyle),
	})
	if publishErr != nil {
		log.Printf("[WhatsAppStatus] publish failed account=%s device=%s: %v", accountID, deviceID, publishErr)
		message := "No se pudo publicar el estado. Puedes reintentarlo."
		persistCtx, persistCancel := context.WithTimeout(context.Background(), statusPersistenceTimeout)
		defer persistCancel()
		_ = s.repos.WhatsAppStatus.MarkFailed(persistCtx, accountID, status.ID, message)
		status.Status = "failed"
		status.ErrorMessage = &message
		s.broadcastWhatsAppStatus(accountID, deviceID, "failed", status)
		return c.Status(fiber.StatusBadGateway).JSON(fiber.Map{"success": false, "error": message, "status": presentWhatsAppStatus(status)})
	}
	persistCtx, persistCancel := context.WithTimeout(context.Background(), statusPersistenceTimeout)
	defer persistCancel()
	status.Status = "sent"
	status.ErrorMessage = nil
	status.WhatsAppMessageID = &result.MessageID
	status.Privacy = &result.Privacy
	status.SentAt = &result.SentAt
	status.ExpiresAt = result.SentAt.Add(24 * time.Hour)
	if err := s.markWhatsAppStatusSentWithRetry(persistCtx, accountID, status.ID, result); err != nil {
		log.Printf("[WhatsAppStatus] published status pending local reconciliation account=%s device=%s status=%s: %v", accountID, deviceID, status.ID, err)
		s.reconcilePublishedWhatsAppStatus(accountID, deviceID, status.ID, *result)
		s.broadcastWhatsAppStatus(accountID, deviceID, "sent", status)
		return c.Status(fiber.StatusCreated).JSON(fiber.Map{
			"success": true, "status": presentWhatsAppStatus(status),
			"warning": "WhatsApp publicó el estado; la confirmación local sigue reintentándose.",
		})
	}
	if persisted, getErr := s.repos.WhatsAppStatus.GetByID(persistCtx, accountID, status.ID); getErr == nil && persisted != nil {
		status = persisted
	}
	s.broadcastWhatsAppStatus(accountID, deviceID, "sent", status)
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"success": true, "status": presentWhatsAppStatus(status)})
}

func uint32Value(value *int64) uint32 {
	if value == nil {
		return 0
	}
	return uint32(*value)
}

func int32Value(value *int) int32 {
	if value == nil {
		return 0
	}
	return int32(*value)
}

func (s *Server) markWhatsAppStatusSentWithRetry(ctx context.Context, accountID, statusID uuid.UUID, result *whatsapp.StatusPublishResult) error {
	var lastErr error
	delay := 150 * time.Millisecond
	for {
		lastErr = s.repos.WhatsAppStatus.MarkSent(ctx, accountID, statusID, result.MessageID, result.Privacy, result.SentAt)
		if lastErr == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("persist published status: %w", lastErr)
		case <-time.After(delay):
			if delay < 2*time.Second {
				delay *= 2
			}
		}
	}
}

func (s *Server) reconcilePublishedWhatsAppStatus(accountID, deviceID, statusID uuid.UUID, result whatsapp.StatusPublishResult) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), statusReconcileTimeout)
		defer cancel()
		if err := s.markWhatsAppStatusSentWithRetry(ctx, accountID, statusID, &result); err != nil {
			log.Printf("[WhatsAppStatus] published status could not be reconciled account=%s device=%s status=%s: %v", accountID, deviceID, statusID, err)
			return
		}
		if persisted, err := s.repos.WhatsAppStatus.GetByID(ctx, accountID, statusID); err == nil && persisted != nil {
			s.broadcastWhatsAppStatus(accountID, deviceID, "sent", persisted)
		}
	}()
}

func (s *Server) handleRetryOwnWhatsAppStatus(c *fiber.Ctx) error {
	if err := s.ensureWhatsAppStatusFeature(c); err != nil {
		return err
	}
	accountID := c.Locals("account_id").(uuid.UUID)
	statusID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Estado inválido"})
	}
	status, err := s.repos.WhatsAppStatus.GetByID(c.Context(), accountID, statusID)
	if err != nil || status == nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Estado no encontrado"})
	}
	if _, err := s.requireManualDeviceForAccount(c.Context(), accountID, status.DeviceID); err != nil {
		return c.Status(409).JSON(fiber.Map{"success": false, "error": "El dispositivo no está disponible"})
	}
	if err := s.repos.WhatsAppStatus.MarkPending(c.Context(), accountID, statusID); err != nil {
		return c.Status(409).JSON(fiber.Map{"success": false, "error": "Este estado ya no se puede reintentar"})
	}
	status.Status = "pending"
	status.ErrorMessage = nil
	s.broadcastWhatsAppStatus(accountID, status.DeviceID, "pending", status)
	publishCtx, publishCancel := context.WithTimeout(context.Background(), statusPublishTimeout)
	defer publishCancel()
	result, publishErr := s.pool.PublishStatus(publishCtx, status.DeviceID, whatsapp.StatusPublishRequest{
		Kind: status.Kind, Text: stringValueOrEmpty(status.Text), Caption: stringValueOrEmpty(status.Caption),
		MediaURL: stringValueOrEmpty(status.MediaURL), BackgroundARGB: uint32Value(status.BackgroundARGB), FontStyle: int32Value(status.FontStyle),
	})
	if publishErr != nil {
		log.Printf("[WhatsAppStatus] retry failed account=%s device=%s: %v", accountID, status.DeviceID, publishErr)
		message := "No se pudo publicar el estado. Puedes reintentarlo."
		persistCtx, persistCancel := context.WithTimeout(context.Background(), statusPersistenceTimeout)
		defer persistCancel()
		if markErr := s.repos.WhatsAppStatus.MarkFailed(persistCtx, accountID, statusID, message); markErr != nil {
			log.Printf("[WhatsAppStatus] failed to persist retry error account=%s device=%s: %v", accountID, status.DeviceID, markErr)
		}
		status.Status = "failed"
		status.ErrorMessage = &message
		s.broadcastWhatsAppStatus(accountID, status.DeviceID, "failed", status)
		return c.Status(fiber.StatusBadGateway).JSON(fiber.Map{"success": false, "error": message})
	}
	persistCtx, persistCancel := context.WithTimeout(context.Background(), statusPersistenceTimeout)
	defer persistCancel()
	status.Status = "sent"
	status.ErrorMessage = nil
	status.WhatsAppMessageID = &result.MessageID
	status.Privacy = &result.Privacy
	status.SentAt = &result.SentAt
	status.ExpiresAt = result.SentAt.Add(24 * time.Hour)
	if err := s.markWhatsAppStatusSentWithRetry(persistCtx, accountID, statusID, result); err != nil {
		log.Printf("[WhatsAppStatus] retried status pending local reconciliation account=%s device=%s status=%s: %v", accountID, status.DeviceID, statusID, err)
		s.reconcilePublishedWhatsAppStatus(accountID, status.DeviceID, statusID, *result)
		s.broadcastWhatsAppStatus(accountID, status.DeviceID, "sent", status)
		return c.JSON(fiber.Map{
			"success": true, "status": presentWhatsAppStatus(status),
			"warning": "WhatsApp publicó el estado; la confirmación local sigue reintentándose.",
		})
	}
	if persisted, getErr := s.repos.WhatsAppStatus.GetByID(persistCtx, accountID, statusID); getErr == nil && persisted != nil {
		status = persisted
	}
	s.broadcastWhatsAppStatus(accountID, status.DeviceID, "sent", status)
	return c.JSON(fiber.Map{"success": true, "status": presentWhatsAppStatus(status)})
}

func (s *Server) broadcastWhatsAppStatus(accountID, deviceID uuid.UUID, action string, status *domain.WhatsAppStatus) {
	if s.hub == nil {
		return
	}
	s.hub.BroadcastToAccountWithPermission(accountID, domain.PermChats, ws.EventWhatsAppStatus, fiber.Map{
		"action": action, "device_id": deviceID, "status": presentWhatsAppStatus(status),
	})
}

func (s *Server) scheduleDeletedWhatsAppStatusMedia(ctx context.Context, item *repository.ExpiredWhatsAppStatusMedia) {
	if item == nil {
		return
	}
	if item.MediaAssetID != nil {
		if _, err := s.repos.WhatsAppStatus.ScheduleMediaCleanup(ctx, item.AccountID, *item.MediaAssetID, time.Now()); err != nil {
			log.Printf("[WhatsAppStatus] deleted status media cleanup scheduling failed for account %s: %v", item.AccountID, err)
		}
	}
	// URL-only legacy objects are normally queued inside the metadata deletion
	// transaction. This second idempotent call also covers historical URLs whose
	// shape can only be recognized by the configured storage provider.
	if item.MediaAssetID == nil && strings.TrimSpace(item.MediaURL) != "" {
		objectKey := objectKeyFromMediaURL(item.MediaURL)
		if objectKey == "" && s.storage != nil {
			if extracted, err := s.storage.ExtractObjectKey(item.MediaURL); err == nil {
				objectKey = strings.TrimPrefix(extracted, "/")
			}
		}
		if _, err := s.repos.WhatsAppStatus.ScheduleLegacyObjectCleanup(ctx, item.AccountID, objectKey, time.Now()); err != nil {
			log.Printf("[WhatsAppStatus] deleted legacy status cleanup scheduling failed for account %s: %v", item.AccountID, err)
		}
	}
}

// runWhatsAppStatusCleanup removes status metadata after 24 hours and advances
// the durable media GC. Object-store I/O happens only after a short database
// claim transaction has committed, and finalization is guarded by a token.
func (s *Server) runWhatsAppStatusCleanup(ctx context.Context) {
	cleanupAt := time.Now()
	stale, staleErr := s.repos.WhatsAppStatus.DeleteStalePending(ctx, cleanupAt.Add(-statusPendingStaleAfter))
	if staleErr != nil {
		log.Printf("[WhatsAppStatus] stale pending cleanup query failed: %v", staleErr)
	} else {
		for index := range stale {
			item := &stale[index]
			scheduleCtx := ctx
			s.scheduleDeletedWhatsAppStatusMedia(scheduleCtx, item)
			s.broadcastWhatsAppStatus(item.AccountID, item.DeviceID, "deleted", &domain.WhatsAppStatus{
				ID: item.ID, AccountID: item.AccountID, DeviceID: item.DeviceID, Status: "deleted",
			})
		}
	}
	expired, err := s.repos.WhatsAppStatus.DeleteExpired(ctx, cleanupAt)
	if err != nil {
		log.Printf("[WhatsAppStatus] cleanup query failed: %v", err)
		return
	}
	for _, item := range expired {
		s.broadcastWhatsAppStatus(item.AccountID, item.DeviceID, "expired", &domain.WhatsAppStatus{
			ID: item.ID, AccountID: item.AccountID, DeviceID: item.DeviceID, Status: "expired",
		})
		staged := false
		if item.MediaAssetID != nil {
			var scheduleErr error
			staged, scheduleErr = s.repos.WhatsAppStatus.ScheduleMediaCleanup(ctx, item.AccountID, *item.MediaAssetID, cleanupAt)
			if scheduleErr != nil {
				log.Printf("[WhatsAppStatus] cleanup scheduling failed for account %s: %v", item.AccountID, scheduleErr)
			}
		}
		if item.MediaAssetID == nil && !staged && strings.TrimSpace(item.MediaURL) != "" {
			objectKey := objectKeyFromMediaURL(item.MediaURL)
			if objectKey == "" && s.storage != nil {
				if extracted, extractErr := s.storage.ExtractObjectKey(item.MediaURL); extractErr == nil {
					objectKey = strings.TrimPrefix(extracted, "/")
				}
			}
			if _, scheduleErr := s.repos.WhatsAppStatus.ScheduleLegacyObjectCleanup(ctx, item.AccountID, objectKey, cleanupAt); scheduleErr != nil {
				log.Printf("[WhatsAppStatus] legacy URL cleanup scheduling failed for account %s: %v", item.AccountID, scheduleErr)
			}
		}
	}
	if err := s.repos.WhatsAppStatus.ScheduleUnreferencedStatusMedia(ctx, cleanupAt, 500); err != nil {
		log.Printf("[WhatsAppStatus] cleanup reconciliation failed: %v", err)
	}
	if s.storage == nil {
		return
	}
	for {
		if ctx.Err() != nil {
			return
		}
		item, claimErr := s.repos.WhatsAppStatus.ClaimPendingMediaCleanup(ctx, time.Now())
		if claimErr != nil {
			log.Printf("[WhatsAppStatus] media cleanup claim failed: %v", claimErr)
			return
		}
		if item == nil {
			return
		}
		// Defense in depth: the repository validates and tokenizes the same
		// account-scoped key, but never let a corrupted queue item reach MinIO.
		if !storage.IsAccountStatusObjectKey(item.AccountID, item.ObjectKey) {
			log.Printf("[WhatsAppStatus] rejected unsafe media cleanup key for account %s", item.AccountID)
			return
		}
		deleteCtx, cancel := context.WithTimeout(ctx, statusMediaDeleteTimeout)
		deleteErr := s.storage.DeleteFile(deleteCtx, item.ObjectKey)
		cancel()
		if finalizeErr := s.repos.WhatsAppStatus.FinalizeMediaCleanup(ctx, *item, deleteErr, time.Now()); finalizeErr != nil {
			log.Printf("[WhatsAppStatus] media cleanup finalize failed for account %s: %v", item.AccountID, finalizeErr)
		}
		if deleteErr != nil {
			log.Printf("[WhatsAppStatus] media cleanup storage delete failed for account %s: %v", item.AccountID, deleteErr)
		}
	}
}
