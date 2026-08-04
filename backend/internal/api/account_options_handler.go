package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
)

const (
	// The active account is pinned first, followed by up to eight other recent accounts.
	myAccountRecentLimit = 9
	myAccountSearchLimit = 50
)

var errInvalidAccountOptionsPage = errors.New("invalid account options page")

type myAccountCursor struct {
	Name string    `json:"name"`
	ID   uuid.UUID `json:"id"`
}

func decodeMyAccountCursor(raw string) (*repository.UserAccountSearchCursor, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	payload, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return nil, errInvalidAccountOptionsPage
	}
	var cursor myAccountCursor
	if err := json.Unmarshal(payload, &cursor); err != nil || cursor.ID == uuid.Nil || strings.TrimSpace(cursor.Name) == "" {
		return nil, errInvalidAccountOptionsPage
	}
	return &repository.UserAccountSearchCursor{Name: cursor.Name, ID: cursor.ID}, nil
}

func encodeMyAccountCursor(item *domain.UserAccount) string {
	payload, _ := json.Marshal(myAccountCursor{Name: strings.ToLower(item.AccountName), ID: item.AccountID})
	return base64.RawURLEncoding.EncodeToString(payload)
}

func parseMyAccountLimit(raw string) (int, error) {
	if strings.TrimSpace(raw) == "" {
		return myAccountSearchLimit, nil
	}
	limit, err := strconv.Atoi(raw)
	if err != nil || limit < 1 || limit > myAccountSearchLimit {
		return 0, errInvalidAccountOptionsPage
	}
	return limit, nil
}

func myAccountOption(item *domain.UserAccount) fiber.Map {
	return fiber.Map{
		"account_id":       item.AccountID,
		"account_name":     item.AccountName,
		"account_slug":     item.AccountSlug,
		"role":             item.Role,
		"is_default":       item.IsDefault,
		"last_selected_at": item.LastSelectedAt,
	}
}

func (s *Server) listMyAccountOptions(ctx context.Context, userID, activeAccountID uuid.UUID, query, rawCursor, rawLimit string) (fiber.Map, error) {
	total, err := s.repos.UserAccount.CountByUserID(ctx, userID)
	if err != nil {
		return nil, err
	}
	query = strings.TrimSpace(query)
	if len([]rune(query)) > 160 {
		return nil, errInvalidAccountOptionsPage
	}
	if query == "" {
		if strings.TrimSpace(rawCursor) != "" {
			return nil, errInvalidAccountOptionsPage
		}
		items, listErr := s.repos.UserAccount.ListRecentForUser(ctx, userID, activeAccountID, myAccountRecentLimit)
		if listErr != nil {
			return nil, listErr
		}
		options := make([]fiber.Map, 0, len(items))
		for _, item := range items {
			options = append(options, myAccountOption(item))
		}
		return fiber.Map{"success": true, "accounts": options, "total": total, "has_more": false, "next_cursor": ""}, nil
	}

	limit, err := parseMyAccountLimit(rawLimit)
	if err != nil {
		return nil, err
	}
	cursor, err := decodeMyAccountCursor(rawCursor)
	if err != nil {
		return nil, err
	}
	items, err := s.repos.UserAccount.SearchForUser(ctx, userID, query, limit+1, cursor)
	if err != nil {
		return nil, err
	}
	hasMore := len(items) > limit
	if hasMore {
		items = items[:limit]
	}
	nextCursor := ""
	if hasMore && len(items) > 0 {
		nextCursor = encodeMyAccountCursor(items[len(items)-1])
	}
	options := make([]fiber.Map, 0, len(items))
	for _, item := range items {
		options = append(options, myAccountOption(item))
	}
	return fiber.Map{"success": true, "accounts": options, "total": total, "has_more": hasMore, "next_cursor": nextCursor}, nil
}
