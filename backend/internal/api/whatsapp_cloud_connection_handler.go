package api

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/url"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/whatsappcloud"
	"github.com/naperu/clarin/internal/ws"
)

type whatsAppCloudReadiness struct {
	Ready                      bool     `json:"ready"`
	EmbeddedSignupReady        bool     `json:"embedded_signup_ready"`
	AppID                      string   `json:"app_id,omitempty"`
	ConfigurationID            string   `json:"configuration_id,omitempty"`
	GraphVersion               string   `json:"graph_version"`
	WebhookURL                 string   `json:"webhook_url,omitempty"`
	WebhookVerifyConfigured    bool     `json:"webhook_verify_configured"`
	WebhookSignatureConfigured bool     `json:"webhook_signature_configured"`
	TokenEncryptionConfigured  bool     `json:"token_encryption_configured"`
	Missing                    []string `json:"missing"`
}

func (s *Server) cloudReadiness() whatsAppCloudReadiness {
	readiness := whatsAppCloudReadiness{Missing: []string{}}
	if s.cfg == nil {
		readiness.Missing = append(readiness.Missing, "server_config")
		return readiness
	}
	readiness.AppID = strings.TrimSpace(s.cfg.WhatsAppCloudAppID)
	readiness.ConfigurationID = strings.TrimSpace(s.cfg.WhatsAppCloudConfigID)
	readiness.GraphVersion = strings.TrimSpace(s.cfg.WhatsAppCloudGraphVersion)
	readiness.WebhookVerifyConfigured = strings.TrimSpace(s.cfg.WhatsAppCloudVerifyToken) != ""
	readiness.WebhookSignatureConfigured = strings.TrimSpace(s.cfg.WhatsAppCloudAppSecret) != ""
	_, tokenCipherErr := whatsappcloud.NewTokenCipher(s.cfg.WhatsAppCloudTokenEncryptionKey)
	readiness.TokenEncryptionConfigured = tokenCipherErr == nil
	publicURLValid := validWhatsAppCloudPublicURL(s.cfg.PublicURL)
	if base := strings.TrimRight(strings.TrimSpace(s.cfg.PublicURL), "/"); base != "" && publicURLValid {
		readiness.WebhookURL = base + "/api/whatsapp/cloud/webhook"
	}
	checks := []struct {
		name  string
		value string
	}{
		{"WHATSAPP_CLOUD_APP_ID", s.cfg.WhatsAppCloudAppID},
		{"WHATSAPP_CLOUD_APP_SECRET", s.cfg.WhatsAppCloudAppSecret},
		{"WHATSAPP_CLOUD_CONFIG_ID", s.cfg.WhatsAppCloudConfigID},
		{"WHATSAPP_CLOUD_GRAPH_VERSION", s.cfg.WhatsAppCloudGraphVersion},
		{"WHATSAPP_CLOUD_VERIFY_TOKEN", s.cfg.WhatsAppCloudVerifyToken},
		{"WHATSAPP_CLOUD_TOKEN_ENCRYPTION_KEY", s.cfg.WhatsAppCloudTokenEncryptionKey},
		{"PUBLIC_URL", s.cfg.PublicURL},
	}
	for _, check := range checks {
		if strings.TrimSpace(check.value) == "" {
			readiness.Missing = append(readiness.Missing, check.name)
		}
	}
	if strings.TrimSpace(s.cfg.WhatsAppCloudTokenEncryptionKey) != "" && tokenCipherErr != nil {
		readiness.Missing = append(readiness.Missing, "WHATSAPP_CLOUD_TOKEN_ENCRYPTION_KEY (invalid)")
	}
	metaIdentifiersValid := validMetaObjectID(readiness.AppID) && validMetaObjectID(readiness.ConfigurationID)
	if readiness.AppID != "" && !validMetaObjectID(readiness.AppID) {
		readiness.Missing = append(readiness.Missing, "WHATSAPP_CLOUD_APP_ID (invalid)")
	}
	if readiness.ConfigurationID != "" && !validMetaObjectID(readiness.ConfigurationID) {
		readiness.Missing = append(readiness.Missing, "WHATSAPP_CLOUD_CONFIG_ID (invalid)")
	}
	if token := strings.TrimSpace(s.cfg.WhatsAppCloudVerifyToken); token != "" && len(token) < 32 {
		readiness.WebhookVerifyConfigured = false
		readiness.Missing = append(readiness.Missing, "WHATSAPP_CLOUD_VERIFY_TOKEN (must be at least 32 characters)")
	}
	if strings.TrimSpace(s.cfg.PublicURL) != "" && !publicURLValid {
		readiness.Missing = append(readiness.Missing, "PUBLIC_URL (must be a public HTTPS URL)")
	}
	if !validWhatsAppCloudGraphVersion(s.cfg.WhatsAppCloudGraphVersion) {
		readiness.Missing = append(readiness.Missing, "WHATSAPP_CLOUD_GRAPH_VERSION (invalid)")
	}
	if !officialMetaGraphBaseURL(s.cfg.WhatsAppCloudGraphBaseURL) {
		readiness.Missing = append(readiness.Missing, "WHATSAPP_CLOUD_GRAPH_BASE_URL (must be Meta)")
	}
	readiness.EmbeddedSignupReady = metaIdentifiersValid &&
		strings.TrimSpace(s.cfg.WhatsAppCloudAppSecret) != "" && readiness.TokenEncryptionConfigured &&
		validWhatsAppCloudGraphVersion(s.cfg.WhatsAppCloudGraphVersion) && officialMetaGraphBaseURL(s.cfg.WhatsAppCloudGraphBaseURL)
	readiness.Ready = readiness.EmbeddedSignupReady && readiness.WebhookVerifyConfigured && readiness.WebhookURL != ""
	return readiness
}

func validWhatsAppCloudPublicURL(value string) bool {
	parsed, err := url.Parse(strings.TrimSpace(value))
	return err == nil && parsed.Scheme == "https" && parsed.Hostname() != "" &&
		parsed.User == nil && parsed.RawQuery == "" && parsed.Fragment == ""
}

func officialMetaGraphBaseURL(value string) bool {
	parsed, err := url.Parse(strings.TrimRight(strings.TrimSpace(value), "/"))
	return err == nil && parsed.Scheme == "https" && parsed.Hostname() == "graph.facebook.com" &&
		parsed.Port() == "" && (parsed.Path == "" || parsed.Path == "/") &&
		parsed.User == nil && parsed.RawQuery == "" && parsed.Fragment == ""
}

func validWhatsAppCloudGraphVersion(value string) bool {
	value = strings.TrimSpace(value)
	if len(value) < 4 || value[0] != 'v' {
		return false
	}
	parts := strings.Split(value[1:], ".")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return false
	}
	for _, part := range parts {
		for _, character := range part {
			if character < '0' || character > '9' {
				return false
			}
		}
	}
	return true
}

func (s *Server) handleWhatsAppCloudConfiguration(c *fiber.Ctx) error {
	return c.JSON(fiber.Map{"success": true, "configuration": s.cloudReadiness()})
}

func (s *Server) cloudClient() (*whatsappcloud.Client, error) {
	if s.cfg == nil {
		return nil, errors.New("WhatsApp Cloud configuration is unavailable")
	}
	if strings.TrimSpace(s.cfg.WhatsAppCloudAppID) == "" || strings.TrimSpace(s.cfg.WhatsAppCloudAppSecret) == "" {
		return nil, errors.New("Meta App ID/App Secret are not configured")
	}
	if !officialMetaGraphBaseURL(s.cfg.WhatsAppCloudGraphBaseURL) {
		return nil, errors.New("Meta Graph endpoint is not the official direct endpoint")
	}
	if !validWhatsAppCloudGraphVersion(s.cfg.WhatsAppCloudGraphVersion) {
		return nil, errors.New("Meta Graph version is invalid")
	}
	return whatsappcloud.NewClient(
		s.cfg.WhatsAppCloudGraphBaseURL,
		s.cfg.WhatsAppCloudGraphVersion,
		s.cfg.WhatsAppCloudAppID,
		s.cfg.WhatsAppCloudAppSecret,
		nil,
	), nil
}

func (s *Server) cloudTokenCipher() (*whatsappcloud.TokenCipher, error) {
	if s.cfg == nil {
		return nil, errors.New("WhatsApp Cloud configuration is unavailable")
	}
	return whatsappcloud.NewTokenCipher(s.cfg.WhatsAppCloudTokenEncryptionKey)
}

func cloudCredentialAAD(accountID, deviceID uuid.UUID) []byte {
	return []byte("clarin:whatsapp-cloud:" + accountID.String() + ":" + deviceID.String())
}

func validMetaObjectID(value string) bool {
	value = strings.TrimSpace(value)
	if len(value) < 5 || len(value) > 100 {
		return false
	}
	for _, character := range value {
		if character < '0' || character > '9' {
			return false
		}
	}
	return true
}

func (s *Server) handleCompleteWhatsAppEmbeddedSignup(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	var request struct {
		Code          string `json:"code"`
		WABAID        string `json:"waba_id"`
		PhoneNumberID string `json:"phone_number_id"`
		BusinessID    string `json:"business_id,omitempty"`
		Coexistence   bool   `json:"coexistence"`
	}
	if err := c.BodyParser(&request); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
	}
	request.Code = strings.TrimSpace(request.Code)
	request.WABAID = strings.TrimSpace(request.WABAID)
	request.PhoneNumberID = strings.TrimSpace(request.PhoneNumberID)
	if request.Code == "" || !validMetaObjectID(request.WABAID) ||
		(request.PhoneNumberID != "" && !validMetaObjectID(request.PhoneNumberID)) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success": false,
			"error":   "Meta no devolvió un código, WABA o número válidos",
			"code":    "invalid_embedded_signup_result",
		})
	}
	if !request.Coexistence {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success": false,
			"error":   "Este flujo inicial solo admite Coexistence con WhatsApp Business App",
			"code":    "coexistence_required",
		})
	}
	readiness := s.cloudReadiness()
	if !readiness.Ready {
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{
			"success": false,
			"error":   "La conexión directa con Meta todavía no está configurada en el servidor",
			"code":    "cloud_configuration_incomplete",
			"missing": readiness.Missing,
		})
	}
	client, err := s.cloudClient()
	if err != nil {
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	token, err := client.ExchangeCode(c.Context(), request.Code)
	if err != nil {
		return c.Status(fiber.StatusBadGateway).JSON(fiber.Map{"success": false, "error": err.Error(), "code": "meta_code_exchange_failed"})
	}
	phone, err := client.FindCoexistencePhone(c.Context(), token.AccessToken, request.WABAID, request.PhoneNumberID)
	if err != nil {
		return c.Status(fiber.StatusBadGateway).JSON(fiber.Map{"success": false, "error": err.Error(), "code": "meta_coexistence_phone_not_found"})
	}
	request.PhoneNumberID = strings.TrimSpace(phone.ID)
	if !validMetaObjectID(request.PhoneNumberID) {
		return c.Status(fiber.StatusBadGateway).JSON(fiber.Map{"success": false, "error": "Meta no devolvió un phone_number_id válido", "code": "meta_coexistence_phone_not_found"})
	}
	existing, err := s.repos.WhatsAppAPI.GetCloudDeviceByPhoneNumberID(c.Context(), request.PhoneNumberID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "No se pudo verificar el canal"})
	}
	if existing != nil && existing.AccountID != accountID {
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "error": "Este número oficial ya pertenece a otra cuenta de Clarin", "code": "cloud_channel_conflict"})
	}
	if existing == nil {
		if err := s.enforcePlanLimit(c.Context(), accountID, "max_devices", 1); err != nil {
			return c.Status(fiber.StatusPaymentRequired).JSON(fiber.Map{"success": false, "error": err.Error(), "code": "plan_limit_reached", "limit": "max_devices"})
		}
	}
	displayPhone := strings.TrimSpace(phone.DisplayPhoneNumber)
	phoneDigits := normalizeWhatsAppPhone(displayPhone)
	deviceName := strings.TrimSpace(phone.VerifiedName)
	if deviceName == "" {
		deviceName = "WhatsApp API " + displayPhone
	}
	provider := domain.DeviceProviderWhatsAppCloudAPI
	device := &domain.Device{
		AccountID:       accountID,
		Name:            &deviceName,
		Phone:           strPtr(displayPhone),
		Provider:        &provider,
		WABAID:          strPtr(request.WABAID),
		PhoneNumberID:   strPtr(request.PhoneNumberID),
		APIDisplayPhone: strPtr(displayPhone),
	}
	if phoneDigits != "" {
		device.JID = strPtr(phoneDigits + "@s.whatsapp.net")
	}
	if existing != nil {
		device.ID = existing.ID
	}
	device, err = s.repos.WhatsAppAPI.UpsertCloudDevice(c.Context(), device)
	if err != nil {
		if errors.Is(err, repository.ErrCloudChannelOwnedByAnotherAccount) {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "error": "Este número oficial ya pertenece a otra cuenta de Clarin", "code": "cloud_channel_conflict"})
		}
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "No se pudo guardar el canal oficial"})
	}
	cipher, err := s.cloudTokenCipher()
	if err != nil {
		_ = s.repos.WhatsAppAPI.MarkCloudDeviceError(c.Context(), accountID, device.ID, "token_encryption_error")
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	encryptedToken, err := cipher.Seal(token.AccessToken, cloudCredentialAAD(accountID, device.ID))
	if err != nil {
		_ = s.repos.WhatsAppAPI.MarkCloudDeviceError(c.Context(), accountID, device.ID, "token_encryption_error")
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "No se pudo proteger el token de Meta"})
	}
	var expiresAt *time.Time
	if token.ExpiresIn > 0 {
		value := time.Now().Add(time.Duration(token.ExpiresIn) * time.Second)
		expiresAt = &value
	}
	if err := s.repos.WhatsAppAPI.UpsertCloudCredential(c.Context(), &repository.WhatsAppCloudCredential{
		DeviceID:             device.ID,
		AccountID:            accountID,
		AccessTokenEncrypted: encryptedToken,
		TokenExpiresAt:       expiresAt,
		GrantedScopes:        []string{},
	}); err != nil {
		_ = s.repos.WhatsAppAPI.MarkCloudDeviceError(c.Context(), accountID, device.ID, "credential_storage_error")
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "No se pudo guardar la credencial cifrada"})
	}
	if err := client.SubscribeApp(c.Context(), token.AccessToken, request.WABAID); err != nil {
		_ = s.repos.WhatsAppAPI.MarkCloudDeviceError(c.Context(), accountID, device.ID, "subscription_error")
		return c.Status(fiber.StatusBadGateway).JSON(fiber.Map{
			"success": false, "error": err.Error(), "code": "meta_webhook_subscription_failed",
			"device": device, "retry_available": true,
		})
	}
	templateCount, templateErr := s.syncCloudTemplates(c.Context(), accountID, device, token.AccessToken)
	templatesEnabled := templateErr == nil
	if err := s.repos.WhatsAppAPI.ActivateCloudDevice(c.Context(), accountID, device.ID, "subscribed", templatesEnabled); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Meta quedó conectado, pero Clarin no pudo activar el canal"})
	}
	device, _ = s.services.Device.GetByID(c.Context(), device.ID)
	response := fiber.Map{
		"success": true, "device": device, "templates_synced": templateCount,
		"coexistence": true, "billing": "customer_managed",
	}
	if templateErr != nil {
		response["warning"] = "El canal quedó conectado, pero las plantillas todavía no pudieron sincronizarse: " + templateErr.Error()
	}
	return c.Status(fiber.StatusCreated).JSON(response)
}

func (s *Server) loadCloudAccessToken(ctx context.Context, accountID, deviceID uuid.UUID) (string, error) {
	credential, err := s.repos.WhatsAppAPI.GetCloudCredential(ctx, accountID, deviceID)
	if err != nil {
		return "", err
	}
	if credential == nil {
		return "", errors.New("el canal no tiene una credencial de Meta")
	}
	if credential.TokenExpiresAt != nil && !credential.TokenExpiresAt.After(time.Now().Add(time.Minute)) {
		return "", errors.New("la credencial de Meta expiró; vuelve a conectar el número")
	}
	cipher, err := s.cloudTokenCipher()
	if err != nil {
		return "", err
	}
	return cipher.Open(credential.AccessTokenEncrypted, cloudCredentialAAD(accountID, deviceID))
}

func (s *Server) syncCloudTemplates(ctx context.Context, accountID uuid.UUID, device *domain.Device, accessToken string) (int, error) {
	if device == nil || device.WABAID == nil || strings.TrimSpace(*device.WABAID) == "" {
		return 0, errors.New("el canal no tiene WABA")
	}
	client, err := s.cloudClient()
	if err != nil {
		return 0, err
	}
	templates, err := client.ListTemplates(ctx, accessToken, *device.WABAID)
	if err != nil {
		return 0, err
	}
	activeMetaIDs := make([]string, 0, len(templates))
	for _, source := range templates {
		var rejectionReason *string
		if strings.TrimSpace(source.RejectedReason) != "" {
			value := strings.TrimSpace(source.RejectedReason)
			rejectionReason = &value
		}
		metaTemplateID := strings.TrimSpace(source.ID)
		if metaTemplateID == "" {
			return 0, errors.New("Meta returned a template without an ID")
		}
		activeMetaIDs = append(activeMetaIDs, metaTemplateID)
		template := &domain.WhatsAppMessageTemplate{
			AccountID:       accountID,
			DeviceID:        &device.ID,
			Name:            strings.TrimSpace(source.Name),
			Language:        strings.TrimSpace(source.Language),
			Category:        strings.ToUpper(strings.TrimSpace(source.Category)),
			Status:          strings.ToLower(strings.TrimSpace(source.Status)),
			Components:      source.Components,
			MetaTemplateID:  &metaTemplateID,
			RejectionReason: rejectionReason,
		}
		if err := s.repos.WhatsAppAPI.UpsertSyncedTemplate(ctx, template); err != nil {
			return 0, err
		}
	}
	if err := s.repos.WhatsAppAPI.DeleteStaleSyncedTemplates(ctx, accountID, device.ID, activeMetaIDs); err != nil {
		return 0, err
	}
	return len(templates), nil
}

func (s *Server) handleSyncWhatsAppCloudTemplates(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	deviceID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Canal inválido"})
	}
	device, err := s.requireCloudDeviceForAccount(c.Context(), accountID, deviceID)
	if err != nil {
		return cloudDeviceError(c, err)
	}
	token, err := s.loadCloudAccessToken(c.Context(), accountID, deviceID)
	if err != nil {
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "error": err.Error(), "code": "cloud_credential_unavailable"})
	}
	count, err := s.syncCloudTemplates(c.Context(), accountID, device, token)
	if err != nil {
		return c.Status(fiber.StatusBadGateway).JSON(fiber.Map{"success": false, "error": err.Error(), "code": "template_sync_failed"})
	}
	if err := s.repos.WhatsAppAPI.ActivateCloudDevice(c.Context(), accountID, deviceID, "subscribed", true); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Las plantillas se sincronizaron, pero no se pudo actualizar el canal"})
	}
	return c.JSON(fiber.Map{"success": true, "templates_synced": count})
}

func (s *Server) handleRefreshWhatsAppCloudConnection(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	deviceID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Canal inválido"})
	}
	device, err := s.requireCloudDeviceForAccount(c.Context(), accountID, deviceID)
	if err != nil {
		return cloudDeviceError(c, err)
	}
	token, err := s.loadCloudAccessToken(c.Context(), accountID, deviceID)
	if err != nil {
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "error": err.Error(), "code": "cloud_credential_unavailable"})
	}
	client, err := s.cloudClient()
	if err != nil {
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if device.WABAID == nil || device.PhoneNumberID == nil {
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "error": "El canal no tiene WABA o phone_number_id"})
	}
	if _, err := client.FindCoexistencePhone(c.Context(), token, *device.WABAID, *device.PhoneNumberID); err != nil {
		_ = s.repos.WhatsAppAPI.MarkCloudDeviceError(c.Context(), accountID, deviceID, "phone_validation_error")
		return c.Status(fiber.StatusBadGateway).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if err := client.SubscribeApp(c.Context(), token, *device.WABAID); err != nil {
		_ = s.repos.WhatsAppAPI.MarkCloudDeviceError(c.Context(), accountID, deviceID, "subscription_error")
		return c.Status(fiber.StatusBadGateway).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	count, templateErr := s.syncCloudTemplates(c.Context(), accountID, device, token)
	if err := s.repos.WhatsAppAPI.ActivateCloudDevice(c.Context(), accountID, deviceID, "subscribed", templateErr == nil); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "No se pudo activar el canal"})
	}
	device, _ = s.services.Device.GetByID(c.Context(), deviceID)
	response := fiber.Map{"success": true, "device": device, "templates_synced": count}
	if templateErr != nil {
		response["warning"] = templateErr.Error()
	}
	return c.JSON(response)
}

func (s *Server) requireCloudDeviceForAccount(ctx context.Context, accountID, deviceID uuid.UUID) (*domain.Device, error) {
	device, err := s.services.Device.GetByID(ctx, deviceID)
	if err != nil {
		return nil, err
	}
	if device == nil || device.AccountID != accountID || getDeviceProvider(device) != domain.DeviceProviderWhatsAppCloudAPI {
		return nil, fiber.NewError(fiber.StatusNotFound, "Canal de WhatsApp API no encontrado")
	}
	return device, nil
}

func cloudDeviceError(c *fiber.Ctx, err error) error {
	if fiberError, ok := err.(*fiber.Error); ok {
		return c.Status(fiberError.Code).JSON(fiber.Map{"success": false, "error": fiberError.Message})
	}
	return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
}

func (s *Server) handleListChatAPIChannels(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	devices, err := s.services.Device.GetByAccountID(c.Context(), accountID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	channels := make([]*domain.Device, 0)
	for _, device := range devices {
		if getDeviceProvider(device) == domain.DeviceProviderWhatsAppCloudAPI {
			s.applyDeviceRuntimePolicy(device)
			channels = append(channels, device)
		}
	}
	return c.JSON(fiber.Map{"success": true, "channels": channels})
}

func (s *Server) requireChatAPIConversation(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	chatID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Chat inválido"})
	}
	chat, err := s.services.Chat.GetByID(c.Context(), chatID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if chat == nil || chat.AccountID != accountID || chat.DeviceID == nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Chat API no encontrado"})
	}
	device, err := s.requireCloudDeviceForAccount(c.Context(), accountID, *chat.DeviceID)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Chat API no encontrado"})
	}
	c.Locals("chat_api_device", device)
	return c.Next()
}

func (s *Server) handleMarkChatAPIRead(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	chatID, _ := uuid.Parse(c.Params("id"))
	device, _ := c.Locals("chat_api_device").(*domain.Device)
	if device == nil || device.PhoneNumberID == nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Chat API no encontrado"})
	}
	if err := s.services.Chat.MarkAsRead(c.Context(), chatID); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	s.invalidateChatCaches(accountID, &chatID)
	messageID, err := s.repos.WhatsAppAPI.LatestInboundCloudMessageID(c.Context(), accountID, device.ID, chatID)
	if err != nil || messageID == "" {
		return c.JSON(fiber.Map{"success": true})
	}
	token, err := s.loadCloudAccessToken(c.Context(), accountID, device.ID)
	if err != nil {
		return c.JSON(fiber.Map{"success": true, "warning": "El chat se marcó leído en Clarin, pero no se pudo confirmar en Meta"})
	}
	client, err := s.cloudClient()
	if err != nil {
		return c.JSON(fiber.Map{"success": true, "warning": "El chat se marcó leído en Clarin, pero no se pudo confirmar en Meta"})
	}
	if err := client.MarkRead(c.Context(), token, *device.PhoneNumberID, messageID); err != nil {
		return c.JSON(fiber.Map{"success": true, "warning": "El chat se marcó leído en Clarin, pero Meta no confirmó el recibo de lectura"})
	}
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleListChatAPITemplates(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	templates, err := s.repos.WhatsAppAPI.ListTemplates(c.Context(), accountID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	deviceFilter := strings.TrimSpace(c.Query("device_id"))
	approved := make([]*domain.WhatsAppMessageTemplate, 0)
	for _, template := range templates {
		if !strings.EqualFold(template.Status, domain.WhatsAppTemplateStatusApproved) || template.DeviceID == nil ||
			template.MetaTemplateID == nil || strings.TrimSpace(*template.MetaTemplateID) == "" {
			continue
		}
		if deviceFilter != "" && template.DeviceID.String() != deviceFilter {
			continue
		}
		approved = append(approved, template)
	}
	return c.JSON(fiber.Map{"success": true, "templates": approved})
}

func (s *Server) handleSendWhatsAppCloudMessage(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	var request struct {
		ChatID             string          `json:"chat_id"`
		DeviceID           string          `json:"device_id,omitempty"`
		To                 string          `json:"to,omitempty"`
		Type               string          `json:"type"`
		Body               string          `json:"body,omitempty"`
		TemplateID         string          `json:"template_id,omitempty"`
		TemplateComponents json.RawMessage `json:"template_components,omitempty"`
		OptInConfirmed     bool            `json:"opt_in_confirmed,omitempty"`
		OptInSource        string          `json:"opt_in_source,omitempty"`
		OptInNote          string          `json:"opt_in_note,omitempty"`
	}
	if err := c.BodyParser(&request); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
	}
	request.Type = strings.ToLower(strings.TrimSpace(request.Type))
	if request.Type != "text" && request.Type != "template" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "El tipo debe ser text o template"})
	}
	var chat *domain.Chat
	var device *domain.Device
	newConversation := false
	var err error
	if strings.TrimSpace(request.ChatID) != "" {
		chatID, parseErr := uuid.Parse(strings.TrimSpace(request.ChatID))
		if parseErr != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Chat inválido"})
		}
		chat, err = s.services.Chat.GetByID(c.Context(), chatID)
		if err != nil {
			return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
		}
		if chat == nil || chat.AccountID != accountID || chat.DeviceID == nil {
			return c.Status(404).JSON(fiber.Map{"success": false, "error": "Chat API no encontrado"})
		}
		device, err = s.requireCloudDeviceForAccount(c.Context(), accountID, *chat.DeviceID)
		if err != nil {
			return c.Status(404).JSON(fiber.Map{"success": false, "error": "Chat API no encontrado"})
		}
	} else {
		newConversation = true
		if request.Type != "template" {
			return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{"success": false, "error": "Una conversación nueva debe iniciarse con una plantilla aprobada", "code": "template_required"})
		}
		deviceID, parseErr := uuid.Parse(strings.TrimSpace(request.DeviceID))
		if parseErr != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Canal inválido"})
		}
		device, err = s.requireCloudDeviceForAccount(c.Context(), accountID, deviceID)
		if err != nil {
			return cloudDeviceError(c, err)
		}
		phone := normalizeWhatsAppPhone(request.To)
		if !validWhatsAppPhone(phone) {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "El número debe incluir código de país y tener entre 7 y 15 dígitos"})
		}
		request.OptInSource = strings.TrimSpace(request.OptInSource)
		allowedOptInSources := map[string]bool{
			"website_form": true, "in_person": true, "phone_call": true,
			"contract": true, "imported_evidence": true,
		}
		if !request.OptInConfirmed || !allowedOptInSources[request.OptInSource] {
			return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
				"success": false,
				"error":   "Debes confirmar y registrar el origen del consentimiento antes de iniciar una conversación",
				"code":    "whatsapp_opt_in_required",
			})
		}
		if len([]rune(request.OptInNote)) > 500 {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "La evidencia de consentimiento es demasiado larga"})
		}
		chat, err = s.repos.Chat.GetOrCreate(c.Context(), accountID, device.ID, phone+"@s.whatsapp.net", phone)
		if err != nil {
			return c.Status(500).JSON(fiber.Map{"success": false, "error": "No se pudo preparar la conversación"})
		}
	}
	if device.Status == nil || *device.Status != domain.DeviceStatusConnected || !device.APISendingEnabled || device.PhoneNumberID == nil {
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "error": "El canal oficial no está habilitado para enviar", "code": "cloud_channel_not_ready"})
	}
	if err := s.ensureOutboundContactAllowed(c.Context(), accountID, chat.JID); err != nil {
		if apiError, ok := err.(*fiber.Error); ok {
			return c.Status(apiError.Code).JSON(fiber.Map{"success": false, "error": apiError.Message, "code": "do_not_contact"})
		}
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	to := normalizeWhatsAppPhone(chat.JID)
	if newConversation {
		userID, _ := c.Locals("user_id").(uuid.UUID)
		var createdBy *uuid.UUID
		if userID != uuid.Nil {
			createdBy = &userID
		}
		if err := s.repos.WhatsAppAPI.RecordOptIn(c.Context(), accountID, chat.ContactID, to, request.OptInSource, strings.TrimSpace(request.OptInNote), time.Now(), createdBy); err != nil {
			return c.Status(500).JSON(fiber.Map{"success": false, "error": "No se pudo registrar la evidencia de consentimiento"})
		}
	}
	var template *domain.WhatsAppMessageTemplate
	if request.Type == "text" {
		request.Body = strings.TrimSpace(request.Body)
		if request.Body == "" || len([]rune(request.Body)) > 4096 {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "El mensaje debe tener entre 1 y 4096 caracteres"})
		}
		canSend, expiresAt, err := s.repos.WhatsAppAPI.CanSendFreeform(c.Context(), accountID, chat.ID)
		if err != nil {
			return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
		}
		if !canSend {
			return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
				"success": false, "error": "La ventana de 24 horas está cerrada; usa una plantilla aprobada",
				"code": "outside_customer_service_window", "window_expires_at": expiresAt,
			})
		}
	} else {
		if !device.APITemplatesEnabled {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{
				"success": false,
				"error":   "Las plantillas de este canal todavía no están sincronizadas con Meta",
				"code":    "cloud_templates_not_ready",
			})
		}
		activeOptIn, optInErr := s.repos.WhatsAppAPI.HasActiveOptIn(c.Context(), accountID, to)
		if optInErr != nil {
			return c.Status(500).JSON(fiber.Map{"success": false, "error": "No se pudo verificar el consentimiento"})
		}
		if !activeOptIn {
			return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
				"success": false,
				"error":   "No existe un opt-in activo para enviar una plantilla a este contacto",
				"code":    "whatsapp_opt_in_required",
			})
		}
		templateID, parseErr := uuid.Parse(strings.TrimSpace(request.TemplateID))
		if parseErr != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Plantilla inválida"})
		}
		template, err = s.repos.WhatsAppAPI.GetTemplateByID(c.Context(), templateID, accountID)
		if err != nil {
			return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
		}
		if template == nil || template.DeviceID == nil || *template.DeviceID != device.ID ||
			template.MetaTemplateID == nil || strings.TrimSpace(*template.MetaTemplateID) == "" ||
			!strings.EqualFold(template.Status, domain.WhatsAppTemplateStatusApproved) {
			return c.Status(404).JSON(fiber.Map{"success": false, "error": "Plantilla aprobada no encontrada para este canal"})
		}
		if len(request.TemplateComponents) > 32*1024 {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Los parámetros de plantilla son demasiado grandes"})
		}
		if len(request.TemplateComponents) > 0 {
			var components []any
			if err := json.Unmarshal(request.TemplateComponents, &components); err != nil {
				return c.Status(400).JSON(fiber.Map{"success": false, "error": "Los parámetros de plantilla deben ser una lista JSON válida"})
			}
		}
	}
	token, err := s.loadCloudAccessToken(c.Context(), accountID, device.ID)
	if err != nil {
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "error": err.Error(), "code": "cloud_credential_unavailable"})
	}
	client, err := s.cloudClient()
	if err != nil {
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if err := s.checkAbuseLimits(c, "whatsapp_cloud_send_rate_limited", device.ID.String(), []abuseLimit{
		{Key: "abuse:whatsapp-cloud:account:second:" + accountID.String(), Max: 10, Window: time.Second},
		{Key: "abuse:whatsapp-cloud:device:minute:" + device.ID.String(), Max: 200, Window: time.Minute},
	}); err != nil {
		return c.Status(fiber.StatusTooManyRequests).JSON(fiber.Map{"success": false, "error": "Demasiados envíos en poco tiempo", "code": "cloud_send_rate_limited"})
	}
	cloudRequest := whatsappcloud.SendRequest{To: to, Text: request.Body}
	body := request.Body
	var templateName *string
	if template != nil {
		cloudRequest.Template = &whatsappcloud.TemplateMessage{
			Name: template.Name, Language: template.Language, Components: request.TemplateComponents,
		}
		body = "[Plantilla: " + template.Name + "]"
		templateName = &template.Name
	}
	result, err := client.Send(c.Context(), token, *device.PhoneNumberID, cloudRequest)
	if err != nil {
		if errors.Is(err, whatsappcloud.ErrSendOutcomeUnknown) {
			return c.Status(fiber.StatusBadGateway).JSON(fiber.Map{
				"success": false,
				"error":   "Meta no confirmó si el mensaje fue enviado. Verifica la conversación antes de volver a intentarlo.",
				"code":    "meta_send_state_unknown",
			})
		}
		return c.Status(fiber.StatusBadGateway).JSON(fiber.Map{"success": false, "error": err.Error(), "code": "meta_send_failed"})
	}
	now := time.Now()
	provider := domain.DeviceProviderWhatsAppCloudAPI
	status := "sent"
	messageType := domain.MessageTypeText
	message := &domain.Message{
		AccountID: accountID, DeviceID: &device.ID, ChatID: chat.ID, MessageID: result.MessageID,
		FromJID: device.JID, FromName: device.Name, Body: &body, MessageType: &messageType,
		IsFromMe: true, IsRead: true, Status: &status, Provider: &provider,
		TemplateName: templateName, Timestamp: now,
	}
	if err := s.repos.Message.Create(c.Context(), message); err != nil {
		log.Printf("[WHATSAPP_API] Meta sent message but local persistence failed account=%s device=%s message_id=%s: %v", accountID, device.ID, result.MessageID, err)
		return c.Status(fiber.StatusAccepted).JSON(fiber.Map{
			"success": true, "provider_message_id": result.MessageID,
			"warning": "Meta envió el mensaje, pero Clarin no pudo guardarlo todavía. No lo reenvíes.",
		})
	}
	_ = s.repos.Chat.UpdateLastMessage(c.Context(), chat.ID, body, now, false)
	_ = s.repos.WhatsAppAPI.UpdateChatServiceWindow(c.Context(), chat.ID, provider, false, now)
	s.invalidateChatCaches(accountID, &chat.ID)
	if s.hub != nil {
		s.hub.BroadcastToAccountWithPermission(accountID, domain.PermChats, ws.EventNewMessage, map[string]any{"chat_id": chat.ID.String(), "message": message})
		s.hub.BroadcastToAccountWithPermission(accountID, domain.PermChats, ws.EventChatUpdate, map[string]any{"chat_id": chat.ID.String()})
	}
	return c.JSON(fiber.Map{"success": true, "message": message, "chat": chat})
}
