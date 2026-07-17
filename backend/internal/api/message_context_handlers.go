package api

import (
	"context"
	"fmt"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (s *Server) resolveOutboundQuote(ctx context.Context, accountID, deviceID uuid.UUID, chatIDRaw, reference, recipient string) (string, string, string, bool, error) {
	chatID, err := uuid.Parse(strings.TrimSpace(chatIDRaw))
	if err != nil {
		return "", "", "", false, fiber.NewError(fiber.StatusBadRequest, "Selecciona una conversación válida para responder")
	}
	chat, err := s.repos.Chat.GetByID(ctx, chatID)
	if err != nil {
		return "", "", "", false, err
	}
	if chat == nil || chat.AccountID != accountID {
		return "", "", "", false, fiber.NewError(fiber.StatusNotFound, "La conversación ya no está disponible")
	}
	if chat.DeviceID == nil || *chat.DeviceID != deviceID {
		return "", "", "", false, fiber.NewError(fiber.StatusConflict, "La conversación pertenece a otro dispositivo")
	}
	if strings.TrimSpace(recipient) != strings.TrimSpace(chat.JID) {
		return "", "", "", false, fiber.NewError(fiber.StatusBadRequest, "El destinatario no corresponde a la conversación")
	}
	quoted, err := s.repos.Message.GetByReference(ctx, accountID, chatID, strings.TrimSpace(reference))
	if err == pgx.ErrNoRows {
		return "", "", "", false, fiber.NewError(fiber.StatusNotFound, "El mensaje original ya no está disponible")
	}
	if err != nil {
		return "", "", "", false, err
	}
	body := stringValueOrEmpty(quoted.Body)
	if strings.TrimSpace(body) == "" {
		body = stringValueOrEmpty(quoted.MediaFilename)
	}
	if strings.TrimSpace(body) == "" {
		labels := map[string]string{
			"image": "📷 Imagen", "video": "🎥 Video", "audio": "🎵 Audio",
			"document": "📄 Documento", "sticker": "Sticker", "location": "📍 Ubicación",
			"contact": "Contacto", "poll": "Encuesta",
		}
		body = labels[stringValueOrEmpty(quoted.MessageType)]
	}
	if strings.TrimSpace(body) == "" {
		body = "Mensaje citado"
	}
	sender := stringValueOrEmpty(quoted.FromJID)
	if sender == "" {
		sender = stringValueOrEmpty(quoted.FromName)
	}
	if strings.TrimSpace(quoted.MessageID) == "" {
		return "", "", "", false, fmt.Errorf("quoted message has no WhatsApp ID")
	}
	return quoted.MessageID, body, sender, quoted.IsFromMe, nil
}

func (s *Server) handleGetMessageContext(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	chatID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Chat inválido"})
	}
	reference := strings.TrimSpace(c.Params("messageId"))
	if reference == "" || len(reference) > 160 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Mensaje inválido"})
	}
	target, err := s.repos.Message.GetByReference(c.Context(), accountID, chatID, reference)
	if err == pgx.ErrNoRows {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"success": false, "error": "El mensaje original ya no está disponible"})
	}
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudo abrir el mensaje original"})
	}
	offset, err := s.repos.Message.GetHistoryOffset(c.Context(), accountID, chatID, target.ID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudo ubicar el mensaje original"})
	}
	pageOffset := offset - 25
	if pageOffset < 0 {
		pageOffset = 0
	}
	messages, err := s.repos.Message.GetWindowByChatID(c.Context(), accountID, chatID, 60, pageOffset)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudo cargar el contexto del mensaje"})
	}
	return c.JSON(fiber.Map{
		"success":        true,
		"target":         target,
		"messages":       messages,
		"history_offset": offset,
		"page_offset":    pageOffset,
	})
}
