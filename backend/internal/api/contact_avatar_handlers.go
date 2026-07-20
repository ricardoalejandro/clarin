package api

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/contactavatar"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
	"github.com/naperu/clarin/internal/whatsapp"
	"github.com/naperu/clarin/internal/ws"
)

const avatarPreviewLifetime = 15 * time.Minute

type contactAvatarContext struct {
	Type string
	ID   uuid.UUID
}

type avatarPreviewClaims struct {
	AccountID uuid.UUID `json:"account_id"`
	ContactID uuid.UUID `json:"contact_id"`
	DeviceID  uuid.UUID `json:"device_id"`
	Hash      string    `json:"hash"`
	ExpiresAt int64     `json:"expires_at"`
}

func (s *Server) registerContactAvatarRoutes(protected fiber.Router) {
	avatars := protected.Group("/contact-avatars")
	avatars.Get("/:id", s.handleGetContactAvatar)
	avatars.Get("/:id/content", s.handleGetContactAvatarContent)
	avatars.Post("/:id/whatsapp-preview", s.handlePreviewContactAvatarFromWhatsApp)
	avatars.Post("/:id/whatsapp-confirm", s.handleConfirmContactAvatarFromWhatsApp)
	avatars.Post("/:id/upload", s.handleUploadContactAvatar)
	avatars.Delete("/:id", s.handleDeleteContactAvatar)

	if s.repos != nil && s.repos.ContactAvatar != nil && s.storage != nil {
		go s.runContactAvatarGC()
	}
}

func (s *Server) runContactAvatarGC() {
	run := func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		for i := 0; i < 4; i++ {
			count, err := s.repos.ContactAvatar.DrainGC(ctx, s.storage, 25)
			if err != nil || count < 25 {
				return
			}
		}
	}
	timer := time.NewTimer(time.Minute)
	defer timer.Stop()
	<-timer.C
	run()
	ticker := time.NewTicker(15 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		run()
	}
}

func parseContactAvatarID(c *fiber.Ctx) (uuid.UUID, error) {
	contactID, err := uuid.Parse(strings.TrimSpace(c.Params("id")))
	if err != nil {
		return uuid.Nil, fiber.NewError(fiber.StatusBadRequest, "Contacto inválido")
	}
	return contactID, nil
}

func parseAvatarContext(contextType, contextID string) (contactAvatarContext, error) {
	contextType = strings.TrimSpace(contextType)
	if contextType == "" {
		contextType = "contact"
	}
	switch contextType {
	case "contact", "lead", "chat", "event_participant", "program_participant":
	default:
		return contactAvatarContext{}, fiber.NewError(fiber.StatusBadRequest, "Contexto de foto inválido")
	}
	id, err := uuid.Parse(strings.TrimSpace(contextID))
	if err != nil {
		return contactAvatarContext{}, fiber.NewError(fiber.StatusBadRequest, "Identificador de contexto inválido")
	}
	return contactAvatarContext{Type: contextType, ID: id}, nil
}

func (s *Server) authorizeContactAvatarContext(c *fiber.Ctx, contactID uuid.UUID, avatarContext contactAvatarContext) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	requiredPermission := map[string]string{
		"contact":             domain.PermContacts,
		"lead":                domain.PermLeads,
		"chat":                domain.PermChats,
		"event_participant":   domain.PermEvents,
		"program_participant": domain.PermPrograms,
	}[avatarContext.Type]
	if !s.contactAvatarCallerHasPermission(c, requiredPermission) {
		return fiber.NewError(fiber.StatusForbidden, "No tienes permiso para modificar esta foto")
	}

	var allowed bool
	var err error
	switch avatarContext.Type {
	case "contact":
		if avatarContext.ID != contactID {
			return fiber.NewError(fiber.StatusNotFound, "Contacto no encontrado")
		}
		err = s.repos.DB().QueryRow(c.Context(), `SELECT EXISTS(SELECT 1 FROM contacts WHERE account_id=$1 AND id=$2)`, accountID, contactID).Scan(&allowed)
	case "lead":
		err = s.repos.DB().QueryRow(c.Context(), `SELECT EXISTS(SELECT 1 FROM leads WHERE account_id=$1 AND id=$2 AND contact_id=$3)`, accountID, avatarContext.ID, contactID).Scan(&allowed)
	case "chat":
		err = s.repos.DB().QueryRow(c.Context(), `SELECT EXISTS(SELECT 1 FROM chats WHERE account_id=$1 AND id=$2 AND contact_id=$3)`, accountID, avatarContext.ID, contactID).Scan(&allowed)
	case "event_participant":
		err = s.repos.DB().QueryRow(c.Context(), `
			SELECT EXISTS(SELECT 1 FROM event_participants ep JOIN events e ON e.id=ep.event_id
			WHERE e.account_id=$1 AND ep.id=$2 AND ep.contact_id=$3)
		`, accountID, avatarContext.ID, contactID).Scan(&allowed)
	case "program_participant":
		err = s.repos.DB().QueryRow(c.Context(), `
			SELECT EXISTS(SELECT 1 FROM program_participants pp JOIN programs p ON p.id=pp.program_id
			WHERE p.account_id=$1 AND pp.id=$2 AND pp.contact_id=$3)
		`, accountID, avatarContext.ID, contactID).Scan(&allowed)
	}
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "No se pudo validar el contexto de la foto")
	}
	if !allowed {
		return fiber.NewError(fiber.StatusNotFound, "Contacto no encontrado en este contexto")
	}
	return nil
}

func (s *Server) contactAvatarCallerHasPermission(c *fiber.Ctx, permission string) bool {
	claims, ok := c.Locals("claims").(*service.JWTClaims)
	if !ok || claims == nil {
		return false
	}
	if claims.IsAdmin || claims.IsSuperAdmin || claims.Role == domain.RoleAdmin || claims.Role == domain.RoleSuperAdmin {
		return true
	}
	for _, candidate := range claims.Permissions {
		if candidate == domain.PermAll || candidate == permission {
			return true
		}
	}
	permissions, err := s.repos.UserAccount.GetUserPermissions(c.Context(), claims.UserID, claims.AccountID)
	if err != nil {
		return false
	}
	for _, candidate := range permissions {
		if candidate == domain.PermAll || candidate == permission {
			return true
		}
	}
	return false
}

func contactAvatarResponse(record *repository.ContactAvatarRecord) fiber.Map {
	if record == nil {
		return fiber.Map{"avatar_url": nil, "source": nil, "revision": 0}
	}
	return fiber.Map{
		"contact_id":           record.ContactID,
		"avatar_url":           record.AvatarURL,
		"source":               record.Source,
		"revision":             record.Revision,
		"updated_at":           record.UpdatedAt,
		"whatsapp_checked_at":  record.WhatsAppCheckedAt,
		"whatsapp_check_error": record.WhatsAppCheckError,
		"automatic_fetch_at":   record.AutomaticFetchAt,
		"content_type":         record.ContentType,
		"size_bytes":           record.SizeBytes,
	}
}

func (s *Server) connectedAvatarDevices(ctx context.Context, accountID uuid.UUID) []fiber.Map {
	if s.pool == nil {
		return []fiber.Map{}
	}
	ids := s.pool.ConnectedAvatarDeviceIDs(accountID)
	result := make([]fiber.Map, 0, len(ids))
	for _, id := range ids {
		device, err := s.services.Device.GetByID(ctx, id)
		if err != nil || device == nil || device.AccountID != accountID || getDeviceProvider(device) != domain.DeviceProviderWhatsAppWeb {
			continue
		}
		result = append(result, fiber.Map{"id": device.ID, "name": device.Name, "phone": device.Phone})
	}
	return result
}

func (s *Server) chooseAvatarDevice(ctx context.Context, accountID uuid.UUID, contactID uuid.UUID, requested string) (uuid.UUID, []fiber.Map, error) {
	devices := s.connectedAvatarDevices(ctx, accountID)
	if requested != "" {
		requestedID, err := uuid.Parse(strings.TrimSpace(requested))
		if err != nil {
			return uuid.Nil, devices, fiber.NewError(fiber.StatusBadRequest, "Dispositivo inválido")
		}
		for _, device := range devices {
			if id, ok := device["id"].(uuid.UUID); ok && id == requestedID {
				return requestedID, devices, nil
			}
		}
		return uuid.Nil, devices, fiber.NewError(fiber.StatusConflict, "El dispositivo está desconectado o no es compatible")
	}
	var preferred *uuid.UUID
	_ = s.repos.DB().QueryRow(ctx, `SELECT device_id FROM contacts WHERE account_id=$1 AND id=$2`, accountID, contactID).Scan(&preferred)
	if preferred != nil {
		for _, device := range devices {
			if id, ok := device["id"].(uuid.UUID); ok && id == *preferred {
				return *preferred, devices, nil
			}
		}
	}
	if len(devices) == 1 {
		if id, ok := devices[0]["id"].(uuid.UUID); ok {
			return id, devices, nil
		}
	}
	if len(devices) == 0 {
		return uuid.Nil, devices, fiber.NewError(fiber.StatusConflict, "No hay dispositivos WhatsApp Web conectados")
	}
	return uuid.Nil, devices, fiber.NewError(fiber.StatusConflict, "Selecciona el dispositivo que consultará la foto")
}

func (s *Server) handleGetContactAvatar(c *fiber.Ctx) error {
	contactID, err := parseContactAvatarID(c)
	if err != nil {
		return err
	}
	avatarContext, err := parseAvatarContext(c.Query("context_type", "contact"), c.Query("context_id", contactID.String()))
	if err != nil {
		return err
	}
	if err := s.authorizeContactAvatarContext(c, contactID, avatarContext); err != nil {
		return err
	}
	accountID := c.Locals("account_id").(uuid.UUID)
	record, err := s.repos.ContactAvatar.Get(c.Context(), accountID, contactID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "No se pudo cargar la foto"})
	}
	return c.JSON(fiber.Map{"success": true, "avatar": contactAvatarResponse(record), "devices": s.connectedAvatarDevices(c.Context(), accountID)})
}

func (s *Server) handlePreviewContactAvatarFromWhatsApp(c *fiber.Ctx) error {
	contactID, err := parseContactAvatarID(c)
	if err != nil {
		return err
	}
	var body struct {
		ContextType string `json:"context_type"`
		ContextID   string `json:"context_id"`
		DeviceID    string `json:"device_id"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
	}
	avatarContext, err := parseAvatarContext(body.ContextType, body.ContextID)
	if err != nil {
		return err
	}
	if err := s.authorizeContactAvatarContext(c, contactID, avatarContext); err != nil {
		return err
	}
	accountID := c.Locals("account_id").(uuid.UUID)
	deviceID, devices, err := s.chooseAvatarDevice(c.Context(), accountID, contactID, body.DeviceID)
	if err != nil {
		if fiberErr, ok := err.(*fiber.Error); ok {
			return c.Status(fiberErr.Code).JSON(fiber.Map{"success": false, "error": fiberErr.Message, "code": "device_selection_required", "devices": devices})
		}
		return err
	}
	contact, err := s.repos.Contact.GetByID(c.Context(), contactID)
	if err != nil || contact == nil || contact.AccountID != accountID {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Contacto no encontrado"})
	}
	raw, err := s.pool.FetchProfilePicture(c.Context(), accountID, deviceID, contact.JID)
	if err != nil {
		code := whatsapp.ProfilePictureErrorCode(err)
		_ = s.repos.ContactAvatar.MarkWhatsAppCheck(c.Context(), accountID, contactID, code)
		if whatsapp.IsProfilePictureEmptyCode(code) {
			return c.JSON(fiber.Map{
				"success":   true,
				"available": false,
				"code":      code,
				"message":   err.Error(),
				"devices":   devices,
			})
		}
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{"success": false, "error": err.Error(), "code": code, "devices": devices})
	}
	normalized, err := contactavatar.Normalize(raw)
	if err != nil {
		_ = s.repos.ContactAvatar.MarkWhatsAppCheck(c.Context(), accountID, contactID, "whatsapp_photo_invalid")
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{"success": false, "error": "La foto de WhatsApp no tiene un formato válido", "code": "whatsapp_photo_invalid"})
	}
	_ = s.repos.ContactAvatar.MarkWhatsAppCheck(c.Context(), accountID, contactID, "")
	claims := avatarPreviewClaims{
		AccountID: accountID, ContactID: contactID, DeviceID: deviceID,
		Hash: fmt.Sprintf("%x", sha256.Sum256(normalized)), ExpiresAt: time.Now().Add(avatarPreviewLifetime).Unix(),
	}
	token, err := s.signAvatarPreview(claims)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "No se pudo preparar la previsualización"})
	}
	return c.JSON(fiber.Map{
		"success":   true,
		"available": true,
		"candidate": fiber.Map{
			"data_url": "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(normalized),
			"token":    token, "device_id": deviceID, "expires_at": time.Unix(claims.ExpiresAt, 0),
		},
	})
}

func (s *Server) handleConfirmContactAvatarFromWhatsApp(c *fiber.Ctx) error {
	contactID, err := parseContactAvatarID(c)
	if err != nil {
		return err
	}
	var body struct {
		ContextType string `json:"context_type"`
		ContextID   string `json:"context_id"`
		Token       string `json:"preview_token"`
		DataURL     string `json:"data_url"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
	}
	avatarContext, err := parseAvatarContext(body.ContextType, body.ContextID)
	if err != nil {
		return err
	}
	if err := s.authorizeContactAvatarContext(c, contactID, avatarContext); err != nil {
		return err
	}
	accountID := c.Locals("account_id").(uuid.UUID)
	claims, err := s.verifyAvatarPreview(body.Token)
	if err != nil || claims.AccountID != accountID || claims.ContactID != contactID || claims.ExpiresAt < time.Now().Unix() {
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "error": "La previsualización expiró. Consulta nuevamente la foto.", "code": "preview_expired"})
	}
	data, err := decodeAvatarDataURL(body.DataURL)
	if err != nil || fmt.Sprintf("%x", sha256.Sum256(data)) != claims.Hash {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "La previsualización fue modificada", "code": "preview_mismatch"})
	}
	normalized, err := contactavatar.Normalize(data)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "La foto no tiene un formato válido"})
	}
	record, err := s.repos.ContactAvatar.Save(c.Context(), s.storage, accountID, contactID, "whatsapp", normalized, repository.SaveContactAvatarOptions{})
	if err != nil {
		return s.contactAvatarSaveError(c, err)
	}
	s.afterContactAvatarChange(accountID, contactID, record, "avatar_updated")
	return c.JSON(fiber.Map{"success": true, "avatar": contactAvatarResponse(record)})
}

func (s *Server) handleUploadContactAvatar(c *fiber.Ctx) error {
	contactID, err := parseContactAvatarID(c)
	if err != nil {
		return err
	}
	avatarContext, err := parseAvatarContext(c.FormValue("context_type"), c.FormValue("context_id"))
	if err != nil {
		return err
	}
	if err := s.authorizeContactAvatarContext(c, contactID, avatarContext); err != nil {
		return err
	}
	file, err := c.FormFile("image")
	if err != nil || file == nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Selecciona una imagen"})
	}
	if file.Size <= 0 || file.Size > contactavatar.MaxInputBytes {
		return c.Status(fiber.StatusRequestEntityTooLarge).JSON(fiber.Map{"success": false, "error": "La imagen debe pesar menos de 8 MB"})
	}
	opened, err := file.Open()
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "No se pudo abrir la imagen"})
	}
	defer opened.Close()
	data, err := io.ReadAll(io.LimitReader(opened, contactavatar.MaxInputBytes+1))
	if err != nil || len(data) > contactavatar.MaxInputBytes {
		return c.Status(fiber.StatusRequestEntityTooLarge).JSON(fiber.Map{"success": false, "error": "La imagen debe pesar menos de 8 MB"})
	}
	normalized, err := contactavatar.Normalize(data)
	if err != nil {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{"success": false, "error": "Usa una imagen JPEG o PNG válida"})
	}
	accountID := c.Locals("account_id").(uuid.UUID)
	record, err := s.repos.ContactAvatar.Save(c.Context(), s.storage, accountID, contactID, "manual", normalized, repository.SaveContactAvatarOptions{})
	if err != nil {
		return s.contactAvatarSaveError(c, err)
	}
	s.afterContactAvatarChange(accountID, contactID, record, "avatar_updated")
	return c.JSON(fiber.Map{"success": true, "avatar": contactAvatarResponse(record)})
}

func (s *Server) handleDeleteContactAvatar(c *fiber.Ctx) error {
	contactID, err := parseContactAvatarID(c)
	if err != nil {
		return err
	}
	avatarContext, err := parseAvatarContext(c.Query("context_type"), c.Query("context_id"))
	if err != nil {
		return err
	}
	if err := s.authorizeContactAvatarContext(c, contactID, avatarContext); err != nil {
		return err
	}
	accountID := c.Locals("account_id").(uuid.UUID)
	record, err := s.repos.ContactAvatar.Remove(c.Context(), accountID, contactID)
	if err == pgx.ErrNoRows {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Contacto no encontrado"})
	}
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "No se pudo quitar la foto"})
	}
	s.afterContactAvatarChange(accountID, contactID, record, "avatar_removed")
	return c.JSON(fiber.Map{"success": true, "avatar": contactAvatarResponse(record)})
}

func (s *Server) handleGetContactAvatarContent(c *fiber.Ctx) error {
	contactID, err := parseContactAvatarID(c)
	if err != nil {
		return err
	}
	accountID := c.Locals("account_id").(uuid.UUID)
	record, err := s.repos.ContactAvatar.Get(c.Context(), accountID, contactID)
	if err != nil || record == nil || record.ObjectKey == nil || strings.TrimSpace(*record.ObjectKey) == "" {
		return c.SendStatus(fiber.StatusNotFound)
	}
	data, err := s.storage.GetFile(c.Context(), *record.ObjectKey)
	if err != nil {
		return c.SendStatus(fiber.StatusNotFound)
	}
	contentType := "image/jpeg"
	if record.ContentType != nil && strings.HasPrefix(*record.ContentType, "image/") {
		contentType = *record.ContentType
	}
	c.Set(fiber.HeaderContentType, contentType)
	c.Set(fiber.HeaderCacheControl, "private, max-age=31536000, immutable")
	c.Set("X-Content-Type-Options", "nosniff")
	return c.Send(data)
}

func (s *Server) contactAvatarSaveError(c *fiber.Ctx, err error) error {
	if errors.Is(err, repository.ErrAvatarStorageLimit) {
		return c.Status(fiber.StatusInsufficientStorage).JSON(fiber.Map{"success": false, "error": "La cuenta alcanzó su límite de almacenamiento", "code": "storage_quota"})
	}
	return c.Status(500).JSON(fiber.Map{"success": false, "error": "No se pudo guardar la foto"})
}

func (s *Server) afterContactAvatarChange(accountID, contactID uuid.UUID, record *repository.ContactAvatarRecord, action string) {
	s.invalidateContactTreeCaches(accountID)
	s.invalidateChatCaches(accountID, nil)
	if s.hub == nil {
		return
	}
	payload := map[string]interface{}{"action": action, "contact_id": contactID, "avatar": contactAvatarResponse(record)}
	s.hub.BroadcastToAccount(accountID, ws.EventContactUpdate, payload)
	s.hub.BroadcastToAccount(accountID, ws.EventChatUpdate, payload)
}

func (s *Server) signAvatarPreview(claims avatarPreviewClaims) (string, error) {
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, []byte(s.cfg.JWTSecret))
	_, _ = mac.Write([]byte(encoded))
	return encoded + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

func (s *Server) verifyAvatarPreview(token string) (avatarPreviewClaims, error) {
	var claims avatarPreviewClaims
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return claims, fmt.Errorf("invalid preview token")
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return claims, err
	}
	mac := hmac.New(sha256.New, []byte(s.cfg.JWTSecret))
	_, _ = mac.Write([]byte(parts[0]))
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return claims, fmt.Errorf("invalid preview signature")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return claims, err
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return claims, err
	}
	return claims, nil
}

func decodeAvatarDataURL(value string) ([]byte, error) {
	const prefix = "data:image/jpeg;base64,"
	if !strings.HasPrefix(value, prefix) {
		return nil, fmt.Errorf("invalid avatar data URL")
	}
	data, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(value, prefix))
	if err != nil || len(data) > contactavatar.MaxInputBytes {
		return nil, fmt.Errorf("invalid avatar data")
	}
	return data, nil
}
