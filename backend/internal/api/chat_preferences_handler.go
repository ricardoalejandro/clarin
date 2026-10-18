package api

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/url"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

func (s *Server) handleSetChatPin(c *fiber.Ctx) error {
	accountID, ok := c.Locals("account_id").(uuid.UUID)
	if !ok {
		return fiber.ErrUnauthorized
	}
	userID, ok := c.Locals("user_id").(uuid.UUID)
	if !ok {
		return fiber.ErrUnauthorized
	}
	chatID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return fiber.ErrBadRequest
	}
	var body struct {
		Pinned *bool `json:"pinned"`
	}
	if err = c.BodyParser(&body); err != nil || body.Pinned == nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Indica si deseas fijar o desfijar la conversación."})
	}
	item, err := s.repos.Chat.SetUserPin(c.Context(), accountID, userID, chatID, *body.Pinned)
	if err == pgx.ErrNoRows {
		return fiber.ErrNotFound
	}
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "No se pudo guardar la fijación. Intenta de nuevo."})
	}
	s.invalidateChatsCache(accountID)
	if s.hub != nil {
		s.hub.BroadcastToAccountUsersWithPermission(accountID, []uuid.UUID{userID}, domain.PermChats, "chat_pin_updated", item)
	}
	return c.JSON(fiber.Map{"success": true, "chat_id": item.ChatID, "is_pinned": item.IsPinned, "pinned_at": item.PinnedAt, "pin_version": item.PinVersion})
}

// The account/actor and complete request filters bind a cursor to one view.
func chatCursorScope(accountID, userID uuid.UUID, rawQuery string) string {
	query, _ := url.ParseQuery(rawQuery)
	query.Del("cursor")
	query.Del("offset")
	query.Del("limit")
	hash := sha256.Sum256([]byte(accountID.String() + ":" + userID.String() + ":" + query.Encode()))
	return hex.EncodeToString(hash[:16])
}

func decodeChatListCursor(raw, scope string) (*domain.ChatListCursor, error) {
	if len(raw) > 2048 {
		return nil, fiber.ErrBadRequest
	}
	data, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return nil, fiber.ErrBadRequest
	}
	var cursor domain.ChatListCursor
	if err = json.Unmarshal(data, &cursor); err != nil || cursor.ID == uuid.Nil || cursor.Scope != scope || (cursor.Pinned && cursor.SortAt == nil) {
		return nil, fiber.ErrBadRequest
	}
	return &cursor, nil
}

func encodeChatListCursor(chat *domain.Chat, scope string) string {
	at := chat.LastMessageAt
	if chat.IsPinned {
		at = chat.PinnedAt
	}
	data, _ := json.Marshal(domain.ChatListCursor{Pinned: chat.IsPinned, SortAt: at, ID: chat.ID, Scope: scope})
	return base64.RawURLEncoding.EncodeToString(data)
}
