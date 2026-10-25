package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"go.mau.fi/whatsmeow/types"
)

// The production implementation is ChatService. Tests may replace only the
// external transport while exercising real authorization and durable receipts.
type forwardBatchTransport interface {
	NewWhatsAppMessageID(uuid.UUID) (string, error)
	ShareMessageWithID(context.Context, uuid.UUID, string, *domain.Message, string, string, string) (*domain.Message, error)
}

// Only focused tests inject readiness while replacing the external transport.
// The normal server always validates the live device through its canonical service.
func (s *Server) forwardingDevice(ctx context.Context, accountID, deviceID uuid.UUID) (*domain.Device, error) {
	if s.forwardDeviceCheck != nil {
		return s.forwardDeviceCheck(ctx, accountID, deviceID)
	}
	return s.requireManualDeviceForAccount(ctx, accountID, deviceID)
}

// Native forwarding remains gated until the provider round trip is verified.
// Existing durable receipts remain readable independently of this send capability.
func (s *Server) forwardingEnabled(deviceID uuid.UUID) bool {
	if s.forwardCapabilityCheck != nil {
		return s.forwardCapabilityCheck(deviceID)
	}
	return s.pool != nil && s.pool.NativeForwardingEnabledForDevice(deviceID)
}

func forwardTypedFailureRetry(code string) bool {
	switch code {
	case "forward_source_changed", "forward_destination_changed", "forward_source_invalid", "recipient_invalid", "forward_content_unavailable", "forward_capability_unverified", "forwarding_source_unknown", "forwarding_score_unknown", "forward_type_unsupported", "forward_audio_kind_unknown", "share_mode_invalid", "share_variant_invalid":
		return false
	default:
		return true
	}
}

func (s *Server) forwardingTransport() forwardBatchTransport {
	if s.forwardTransport != nil {
		return s.forwardTransport
	}
	return s.services.Chat
}

type forwardBatchRequest struct {
	SourceChatID       uuid.UUID   `json:"source_chat_id"`
	SourceMessageID    uuid.UUID   `json:"source_message_id"`
	DeviceID           uuid.UUID   `json:"device_id"`
	DestinationChatIDs []uuid.UUID `json:"destination_chat_ids"`
	ClientOperationID  uuid.UUID   `json:"client_operation_id"`
	Mode               string      `json:"mode,omitempty"`
	ContentVariant     string      `json:"content_variant,omitempty"`
}

type forwardBatchError struct {
	status  int
	code    string
	message string
}

func (e *forwardBatchError) Error() string { return e.message }
func forwardFailure(status int, code, message string) error {
	return &forwardBatchError{status, code, message}
}
func writeForwardError(c *fiber.Ctx, err error) error {
	var known *forwardBatchError
	if errors.As(err, &known) {
		return c.Status(known.status).JSON(fiber.Map{"success": false, "code": known.code, "error": known.message})
	}
	return c.Status(500).JSON(fiber.Map{"success": false, "code": "forward_internal_error", "error": "No se pudo preparar el reenvío. Puedes comprobar su estado sin enviar otra copia."})
}
func forwardReceipt(c *fiber.Ctx, op *repository.ForwardOperation) error {
	return c.JSON(struct {
		Success bool `json:"success"`
		*repository.ForwardOperation
	}{true, op})
}
func canonicalForwardRequest(req forwardBatchRequest) (forwardBatchRequest, string, error) {
	var err error
	req.Mode, err = domain.NormalizeMessageSharingMode(req.Mode)
	if err != nil {
		return req, "", forwardFailure(422, "share_mode_invalid", "Selecciona Copiar o Reenviar para compartir este mensaje.")
	}
	req.ContentVariant, err = domain.NormalizeMessageContentVariant(req.ContentVariant)
	if err != nil || (req.ContentVariant == domain.MessageContentAudioDocument && req.Mode != domain.MessageSharingCopy) {
		return req, "", forwardFailure(422, "share_variant_invalid", "Enviar un audio como archivo requiere el modo Copiar.")
	}

	if req.SourceChatID == uuid.Nil || req.SourceMessageID == uuid.Nil || req.DeviceID == uuid.Nil || req.ClientOperationID == uuid.Nil {
		return req, "", forwardFailure(400, "forward_invalid_request", "Selecciona el mensaje, dispositivo y destinos del reenvío.")
	}
	if len(req.DestinationChatIDs) < 1 || len(req.DestinationChatIDs) > 5 {
		return req, "", forwardFailure(422, "forward_destination_limit", "Puedes seleccionar de uno a cinco chats.")
	}
	seen := map[uuid.UUID]bool{}
	for _, id := range req.DestinationChatIDs {
		if id == uuid.Nil || seen[id] {
			return req, "", forwardFailure(422, "forward_duplicate_destination", "Los destinos deben ser chats distintos.")
		}
		seen[id] = true
	}
	req.DestinationChatIDs = append([]uuid.UUID{}, req.DestinationChatIDs...)
	sort.Slice(req.DestinationChatIDs, func(i, j int) bool { return req.DestinationChatIDs[i].String() < req.DestinationChatIDs[j].String() })
	// Default requests retain the exact pre-sharing hash, including field order.
	// Explicit native/original and omitted defaults identify the same operation.
	hashRequest := req
	if req.Mode == domain.MessageSharingNative && req.ContentVariant == domain.MessageContentOriginal {
		hashRequest.Mode, hashRequest.ContentVariant = "", ""
	}
	raw, _ := json.Marshal(hashRequest)
	hash := sha256.Sum256(raw)
	return req, hex.EncodeToString(hash[:]), nil
}

func validateForwardSource(message *domain.Message) error {
	return validateMessageSharingSource(message, domain.MessageSharingNative, domain.MessageContentOriginal)
}

func validateMessageSharingSource(message *domain.Message, mode, variant string) error {
	if message == nil {
		return forwardFailure(404, "forward_source_not_found", "El mensaje original ya no está disponible.")
	}
	if message.IsRevoked || message.IsViewOnce || message.MediaDeleted {
		return forwardFailure(422, "forward_source_unavailable", "Este mensaje no se puede reenviar.")
	}
	if message.Provider != nil && *message.Provider != "" && *message.Provider != domain.DeviceProviderWhatsAppWeb {
		return forwardFailure(422, "forward_provider_unsupported", "El reenvío nativo está disponible para WhatsApp Web.")
	}
	if mode == domain.MessageSharingNative {
		if _, err := domain.NextForwarding(*message); err != nil {
			var typed *domain.ForwardSendError
			if errors.As(err, &typed) {
				return forwardFailure(409, typed.Code, typed.Error())
			}
			return err
		}
	}
	kind := "text"
	if message.MessageType != nil {
		kind = *message.MessageType
	}
	if variant == domain.MessageContentAudioDocument && (mode != domain.MessageSharingCopy || kind != "audio") {
		return forwardFailure(422, "share_variant_invalid", "La opción Enviar como archivo solo está disponible para copiar un audio.")
	}
	switch kind {
	case "text":
		if message.Body == nil || strings.TrimSpace(*message.Body) == "" {
			return forwardFailure(422, "forward_source_unavailable", "El mensaje no tiene texto disponible.")
		}
	case "image", "video", "gif", "audio", "document", "sticker":
		if message.MediaURL == nil || strings.TrimSpace(*message.MediaURL) == "" || message.MediaRecoverable || message.MediaUnavailableReason != "" {
			return forwardFailure(422, "forward_media_unavailable", "Recupera el archivo original antes de reenviarlo.")
		}
		if message.MediaSize != nil && *message.MediaSize > 64<<20 {
			return forwardFailure(422, "forward_media_too_large", "Este archivo supera el límite de 64 MB de Clarin.")
		}
		if kind == "audio" && message.AudioPTT == nil && !(mode == domain.MessageSharingCopy && variant == domain.MessageContentAudioDocument) {
			return forwardFailure(409, "forward_audio_kind_unknown", "Sincroniza este audio para conservar si es una nota de voz o un archivo.")
		}
	default:
		return forwardFailure(422, "forward_type_unsupported", "Este tipo de mensaje todavía no admite reenvío nativo en Clarin.")
	}
	return nil
}

func validateForwardDestinationLimits(source *domain.Message, chats []*domain.Chat) error {
	groups := 0
	for _, chat := range chats {
		if domain.IsGroupJID(chat.JID) {
			groups++
		}
	}
	limits := domain.EffectiveMessageSharingLimits(source)
	if len(chats) > limits.MaxChats {
		return forwardFailure(422, "forward_frequent_limit", "Un mensaje reenviado muchas veces solo se puede reenviar a un chat por vez.")
	}
	if groups > limits.MaxGroups {
		return forwardFailure(422, "forward_group_limit", "Un mensaje que ya fue reenviado solo se puede compartir con un grupo por vez.")
	}
	return nil
}

func (s *Server) validateForwardTarget(ctx context.Context, accountID, deviceID uuid.UUID, target *domain.Chat) (context.Context, error) {
	if target == nil || target.AccountID != accountID || target.DeviceID == nil || *target.DeviceID != deviceID || target.ContactID == nil {
		return ctx, forwardFailure(404, "forward_destination_not_found", "Uno de los destinos ya no está disponible en este dispositivo.")
	}
	if _, err := s.forwardingDevice(ctx, accountID, deviceID); err != nil {
		return ctx, forwardFailure(409, "forward_device_unavailable", "El dispositivo no está conectado o ya no permite este envío.")
	}
	jid, err := types.ParseJID(target.JID)
	if err != nil || jid.User == "" || (jid.Server != types.DefaultUserServer && jid.Server != types.HiddenUserServer && jid.Server != types.GroupServer) {
		return ctx, forwardFailure(422, "forward_destination_invalid", "El destino no tiene una identidad válida de WhatsApp.")
	}
	if domain.IsGroupJID(target.JID) {
		prepared, err := s.pool.PrepareGroupSend(ctx, accountID, deviceID, target.ID, target.JID, nil, true)
		if err != nil {
			return ctx, forwardFailure(409, "forward_group_unavailable", "No se pudo confirmar el permiso para enviar al grupo. Actualízalo y reintenta.")
		}
		return prepared, nil
	}
	if err := s.ensureOutboundContactAllowed(ctx, accountID, target.JID); err != nil {
		var blocked *fiber.Error
		if errors.As(err, &blocked) {
			return ctx, forwardFailure(blocked.Code, "do_not_contact", "No se permite enviar mensajes a este contacto.")
		}
		return ctx, forwardFailure(503, "forward_destination_unavailable", "No se pudo comprobar el destino. Reintenta cuando vuelva la conexión.")
	}
	return ctx, nil
}

func (s *Server) handleForwardBatch(c *fiber.Ctx) error {
	var req forwardBatchRequest
	if c.BodyParser(&req) != nil {
		return writeForwardError(c, forwardFailure(400, "forward_invalid_request", "Solicitud de reenvío inválida."))
	}
	return s.runForwardBatch(c, req)
}

func (s *Server) runForwardBatch(c *fiber.Ctx, req forwardBatchRequest) error {
	accountID, ok := c.Locals("account_id").(uuid.UUID)
	if !ok {
		return fiber.ErrUnauthorized
	}
	userID, ok := c.Locals("user_id").(uuid.UUID)
	if !ok {
		return fiber.ErrUnauthorized
	}
	req, hash, err := canonicalForwardRequest(req)
	if err != nil {
		return writeForwardError(c, err)
	}
	existing, err := s.repos.Message.GetForwardOperation(c.Context(), accountID, userID, req.ClientOperationID)
	if err == nil {
		if existing.RequestHash != hash {
			return writeForwardError(c, forwardFailure(409, "forward_operation_conflict", "Este reenvío ya se preparó con otros datos."))
		}
		return forwardReceipt(c, existing)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return writeForwardError(c, err)
	}
	device, err := s.forwardingDevice(c.Context(), accountID, req.DeviceID)
	if err != nil || device == nil || getDeviceProvider(device) != domain.DeviceProviderWhatsAppWeb {
		var hidden *fiber.Error
		if errors.As(err, &hidden) && hidden.Code == fiber.StatusNotFound {
			return writeForwardError(c, forwardFailure(404, "forward_device_not_found", "El dispositivo ya no está disponible para esta cuenta."))
		}
		return writeForwardError(c, forwardFailure(409, "forward_device_unavailable", "Selecciona un dispositivo conectado de WhatsApp Web."))
	}
	if req.Mode == domain.MessageSharingNative && !s.forwardingEnabled(req.DeviceID) {
		return writeForwardError(c, forwardFailure(503, "forward_capability_unverified", "El reenvío nativo está pendiente de verificación con este dispositivo. Los mensajes y resultados anteriores siguen disponibles."))
	}
	sourceChat, err := s.repos.Chat.GetByID(c.Context(), req.SourceChatID)
	if err != nil || sourceChat == nil || sourceChat.AccountID != accountID || sourceChat.DeviceID == nil || *sourceChat.DeviceID != req.DeviceID {
		return writeForwardError(c, forwardFailure(404, "forward_source_not_found", "El mensaje original no pertenece al dispositivo seleccionado."))
	}
	if domain.IsGroupJID(sourceChat.JID) && !s.pool.GroupsEnabledForAccount(accountID) {
		return writeForwardError(c, forwardFailure(404, "forward_source_not_found", "El mensaje original ya no está disponible."))
	}
	source, err := s.repos.Message.GetByReference(c.Context(), accountID, req.SourceChatID, req.SourceMessageID.String())
	if err != nil || source.ID != req.SourceMessageID || source.DeviceID == nil || *source.DeviceID != req.DeviceID {
		return writeForwardError(c, forwardFailure(404, "forward_source_not_found", "El mensaje original ya no está disponible."))
	}
	if err = validateMessageSharingSource(source, req.Mode, req.ContentVariant); err != nil {
		return writeForwardError(c, err)
	}
	targets := make([]*domain.Chat, 0, len(req.DestinationChatIDs))
	for _, id := range req.DestinationChatIDs {
		target, getErr := s.repos.Chat.GetByID(c.Context(), id)
		if getErr != nil {
			return writeForwardError(c, forwardFailure(404, "forward_destination_not_found", "Uno de los destinos ya no está disponible."))
		}
		if _, err = s.validateForwardTarget(c.Context(), accountID, req.DeviceID, target); err != nil {
			return writeForwardError(c, err)
		}
		targets = append(targets, target)
	}
	if err = validateForwardDestinationLimits(source, targets); err != nil {
		return writeForwardError(c, err)
	}
	actor, err := s.repos.User.GetByID(c.Context(), userID)
	if err != nil || actor == nil {
		return fiber.ErrUnauthorized
	}
	name := actor.DisplayName
	if name == "" {
		name = actor.Username
	}
	limits, limitErr := domain.MessageSharingOutputLimits(source, req.Mode)
	if limitErr != nil {
		return writeForwardError(c, forwardFailure(409, "forward_source_changed", "El mensaje cambió. Prepara nuevamente el envío."))
	}
	op := &repository.ForwardOperation{Mode: req.Mode, ContentVariant: req.ContentVariant, SharingLimits: &limits, ID: req.ClientOperationID, AccountID: accountID, UserID: userID, DeviceID: req.DeviceID, SourceChatID: req.SourceChatID, SourceMessageID: req.SourceMessageID, RequestHash: hash, SourceFingerprint: domain.MessageForwardFingerprint(source), Forwarding: source.Forwarding.Normalize(), Results: []repository.ForwardTarget{}}
	for _, target := range targets {
		providerID, reserveErr := s.forwardingTransport().NewWhatsAppMessageID(req.DeviceID)
		if reserveErr != nil {
			return writeForwardError(c, forwardFailure(503, "forward_device_unavailable", "WhatsApp no pudo preparar el reenvío. Revisa la conexión."))
		}
		op.Results = append(op.Results, repository.ForwardTarget{ChatID: target.ID, JID: target.JID, ProviderMessageID: providerID, State: "pending"})
	}
	created, err := s.repos.Message.CreateForwardOperation(c.Context(), op)
	if errors.Is(err, repository.ErrForwardOperationConflict) {
		return writeForwardError(c, forwardFailure(409, "forward_operation_conflict", "Esta operación ya tiene otro contenido."))
	}
	if errors.Is(err, repository.ErrForwardSourceChanged) || errors.Is(err, pgx.ErrNoRows) {
		return writeForwardError(c, forwardFailure(409, "forward_source_changed", "El mensaje o los destinos cambiaron. Prepara otra vez el reenvío."))
	}
	if err != nil {
		return writeForwardError(c, err)
	}
	if created {
		for _, target := range op.Results {
			claim, claimErr := s.repos.Message.ClaimForwardTarget(c.Context(), accountID, op.ID, target.ChatID)
			if claimErr != nil {
				return writeForwardError(c, claimErr)
			}
			if !claim {
				continue
			}
			state, code, safeError, canRetry := "failed", "forward_preflight_failed", "No se inició el envío. Revisa el mensaje y el destino.", true
			freshSource, sourceErr := s.repos.Message.GetByReference(c.Context(), accountID, op.SourceChatID, op.SourceMessageID.String())
			freshTarget, targetErr := s.repos.Chat.GetByID(c.Context(), target.ChatID)
			if sourceErr == nil && targetErr == nil && domain.MessageForwardFingerprint(freshSource) == op.SourceFingerprint {
				sendCtx, validationErr := s.validateForwardTarget(c.Context(), accountID, op.DeviceID, freshTarget)
				if validationErr == nil && freshTarget.JID == target.JID {
					sendCtx, cancel := context.WithTimeout(sendCtx, 90*time.Second)
					sendCtx = domain.WithMessageSendContext(sendCtx, domain.MessageSendContext{AccountID: accountID, ChatID: target.ChatID, Sender: domain.MessageSender{UserID: &userID, Name: name, Origin: "manual"}, DeferAttention: true, OperationID: &op.ID})
					message, sendErr := s.forwardingTransport().ShareMessageWithID(sendCtx, op.DeviceID, target.JID, freshSource, target.ProviderMessageID, op.Mode, op.ContentVariant)
					cancel()
					if sendErr == nil && message != nil {
						state, code, safeError, canRetry = "sent", "", "", false
						s.invalidateChatCaches(accountID, &target.ChatID)
					} else {
						state, code, safeError, canRetry = "uncertain", "forward_outcome_pending", "WhatsApp aún no confirmó este envío. Comprueba su estado; no se enviará otra copia.", false
						var typed *domain.ForwardSendError
						if errors.As(sendErr, &typed) && !typed.OutcomeUnknown {
							state, code, safeError, canRetry = "failed", typed.Code, "El envío no llegó a iniciarse. Revisa la conexión y el archivo antes de reintentar.", forwardTypedFailureRetry(typed.Code)
							if !canRetry {
								safeError = "El mensaje cambió o no tiene la información necesaria. Prepara un nuevo reenvío."
							}
						}
					}
				} else if validationErr == nil {
					code, safeError, canRetry = "forward_destination_changed", "El destino cambió. Cierra y vuelve a preparar el reenvío.", false
				} else if validationErr != nil {
					var typed *forwardBatchError
					if errors.As(validationErr, &typed) {
						code, safeError = typed.code, typed.message
					}
				}
			} else {
				code, safeError, canRetry = "forward_source_changed", "El mensaje o el destino cambió. Prepara un nuevo reenvío.", false
			}
			finishCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			finishErr := s.repos.Message.FinishForwardTarget(finishCtx, accountID, op.ID, target.ChatID, state, code, safeError, canRetry)
			cancel()
			if finishErr != nil {
				return writeForwardError(c, finishErr)
			}
		}
	}
	receipt, err := s.repos.Message.GetForwardOperation(c.Context(), accountID, userID, op.ID)
	if err != nil {
		return writeForwardError(c, err)
	}
	return forwardReceipt(c, receipt)
}

func (s *Server) handleGetForwardBatch(c *fiber.Ctx) error {
	accountID, ok := c.Locals("account_id").(uuid.UUID)
	if !ok {
		return fiber.ErrUnauthorized
	}
	userID, ok := c.Locals("user_id").(uuid.UUID)
	if !ok {
		return fiber.ErrUnauthorized
	}
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return fiber.ErrBadRequest
	}
	op, err := s.repos.Message.GetForwardOperation(c.Context(), accountID, userID, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return fiber.ErrNotFound
	}
	if err != nil {
		return writeForwardError(c, err)
	}
	return forwardReceipt(c, op)
}
