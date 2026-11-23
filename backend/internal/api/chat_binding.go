package api

import (
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"strconv"
	"strings"
)

type chatBindingError struct{}

func (*chatBindingError) Error() string {
	return "La conexión de esta conversación cambió. Revisa el dispositivo y prepara nuevamente el envío."
}

// The client captures these headers when preparing a mutation. Resolving an old
// URL is allowed; silently changing the sender of a prepared operation is not.
func preparedChatMatches(chat *domain.Chat, accountID, deviceID uuid.UUID, recipient string, revision int64) bool {
	return chat != nil && chat.AccountID == accountID && chat.DeviceID != nil && *chat.DeviceID == deviceID && chat.JID == strings.TrimSpace(recipient) && chat.BindingRevision == revision && (!domain.IsGroupJID(chat.JID) || (chat.BindingState == "verified_continuity" && chat.WhatsAppOwnerID != nil))
}
func (s *Server) validatePreparedChat(c *fiber.Ctx, accountID, deviceID uuid.UUID, recipient string) error {
	rawID, rawRevision := c.Get("X-Chat-ID"), c.Get("X-Chat-Binding-Revision")
	if rawID == "" && rawRevision == "" {
		return nil
	}
	id, err := uuid.Parse(rawID)
	if err != nil {
		return &chatBindingError{}
	}
	revision, err := strconv.ParseInt(rawRevision, 10, 64)
	if err != nil || revision < 0 {
		return &chatBindingError{}
	}
	chat, err := s.repos.Chat.GetByID(c.Context(), id)
	if err != nil {
		return &chatBindingError{}
	}
	if !preparedChatMatches(chat, accountID, deviceID, recipient, revision) {
		return &chatBindingError{}
	}
	return nil
}
