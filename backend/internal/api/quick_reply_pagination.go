package api

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
)

const (
	quickReplyDefaultPageSize     = 50
	quickReplyMaximumPageSize     = 200
	quickReplyMaximumQueryRunes   = 200
	quickReplyMaximumCursorLength = 2048
)

var errInvalidQuickReplyListFilter = errors.New("invalid quick reply list filter")

type quickReplyCursorPayload struct {
	Version  int       `json:"v"`
	Shortcut string    `json:"shortcut"`
	ID       uuid.UUID `json:"id"`
	Query    string    `json:"query,omitempty"`
	Kind     string    `json:"kind"`
}

func parseQuickReplyListFilter(c *fiber.Ctx) (repository.QuickReplyListFilter, error) {
	query := strings.TrimSpace(c.Query("query"))
	if utf8.RuneCountInString(query) > quickReplyMaximumQueryRunes {
		return repository.QuickReplyListFilter{}, errInvalidQuickReplyListFilter
	}

	kind := strings.ToLower(strings.TrimSpace(c.Query("kind", "all")))
	if kind != "all" && kind != "text" && kind != "media" {
		return repository.QuickReplyListFilter{}, errInvalidQuickReplyListFilter
	}

	limit := quickReplyDefaultPageSize
	if rawLimit := strings.TrimSpace(c.Query("limit")); rawLimit != "" {
		parsed, err := strconv.Atoi(rawLimit)
		if err != nil || parsed <= 0 || parsed > quickReplyMaximumPageSize {
			return repository.QuickReplyListFilter{}, errInvalidQuickReplyListFilter
		}
		limit = parsed
	}

	filter := repository.QuickReplyListFilter{Search: query, Kind: kind, Limit: limit}
	rawCursor := strings.TrimSpace(c.Query("cursor"))
	if rawCursor == "" {
		return filter, nil
	}
	if len(rawCursor) > quickReplyMaximumCursorLength {
		return repository.QuickReplyListFilter{}, errInvalidQuickReplyListFilter
	}

	cursor, err := decodeQuickReplyCursor(rawCursor)
	if err != nil || cursor.Query != query || cursor.Kind != kind {
		return repository.QuickReplyListFilter{}, errInvalidQuickReplyListFilter
	}
	filter.AfterShortcut = cursor.Shortcut
	filter.AfterID = cursor.ID
	return filter, nil
}

func encodeQuickReplyCursor(reply *domain.QuickReply, filter repository.QuickReplyListFilter) string {
	if reply == nil || reply.ID == uuid.Nil || strings.TrimSpace(reply.Shortcut) == "" {
		return ""
	}
	payload, err := json.Marshal(quickReplyCursorPayload{
		Version:  1,
		Shortcut: strings.ToLower(strings.TrimSpace(reply.Shortcut)),
		ID:       reply.ID,
		Query:    strings.TrimSpace(filter.Search),
		Kind:     strings.ToLower(strings.TrimSpace(filter.Kind)),
	})
	if err != nil {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(payload)
}

func decodeQuickReplyCursor(raw string) (quickReplyCursorPayload, error) {
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return quickReplyCursorPayload{}, errInvalidQuickReplyListFilter
	}
	var cursor quickReplyCursorPayload
	if err := json.Unmarshal(decoded, &cursor); err != nil {
		return quickReplyCursorPayload{}, errInvalidQuickReplyListFilter
	}
	if cursor.Version != 1 || cursor.ID == uuid.Nil || strings.TrimSpace(cursor.Shortcut) == "" {
		return quickReplyCursorPayload{}, errInvalidQuickReplyListFilter
	}
	if cursor.Kind != "all" && cursor.Kind != "text" && cursor.Kind != "media" {
		return quickReplyCursorPayload{}, errInvalidQuickReplyListFilter
	}
	return cursor, nil
}
