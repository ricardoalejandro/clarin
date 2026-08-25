package api

import (
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
	whiteboardcore "github.com/naperu/clarin/internal/whiteboard"
)

const whiteboardCollabTicketTTL = 45 * time.Second

type whiteboardCollabTicket struct {
	Principal *whiteboardRealtimePrincipal `json:"principal"`
	ExpiresAt time.Time                    `json:"expires_at"`
}

func whiteboardCollabTicketKey(hash string) string {
	return "whiteboard:collab-ticket:v1:" + hash
}

func (s *Server) issueWhiteboardCollabTicket(c *fiber.Ctx, principal *whiteboardRealtimePrincipal) error {
	if s.cache == nil {
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"success": false, "error": "La colaboración no está disponible", "code": "collaboration_unavailable"})
	}
	plain, tokenHash, err := service.NewWhiteboardSecret()
	if err != nil {
		return whiteboardError(c, err)
	}
	now := time.Now().UTC()
	expiresAt := whiteboardCollabTicketExpiresAt(now, principal)
	if !expiresAt.After(now) {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"success": false, "error": "La sesión finalizó"})
	}
	payload, err := json.Marshal(whiteboardCollabTicket{Principal: principal, ExpiresAt: expiresAt})
	if err != nil {
		return whiteboardError(c, err)
	}
	if err := s.cache.Set(c.Context(), whiteboardCollabTicketKey(tokenHash), payload, time.Until(expiresAt)); err != nil {
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"success": false, "error": "La colaboración no está disponible", "code": "collaboration_unavailable"})
	}
	return c.JSON(fiber.Map{"success": true, "ticket": plain, "expires_at": expiresAt})
}

func whiteboardCollabTicketExpiresAt(now time.Time, principal *whiteboardRealtimePrincipal) time.Time {
	expiresAt := now.Add(whiteboardCollabTicketTTL)
	if principal != nil && principal.GuestSession != nil && principal.GuestExpiresAt != nil && principal.GuestExpiresAt.Before(expiresAt) {
		return principal.GuestExpiresAt.UTC()
	}
	return expiresAt
}

func whiteboardCollabAuthorizationUnavailable(c *fiber.Ctx) error {
	return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{
		"success": false, "error": "No se pudo verificar el acceso temporalmente", "code": "authorization_unavailable",
	})
}

func whiteboardGuestTicketResolutionError(guest *domain.WhiteboardGuestContext, expectedLinkID uuid.UUID, err error) error {
	if err != nil {
		if errors.Is(err, repository.ErrWhiteboardSessionUnavailable) {
			return repository.ErrWhiteboardSessionUnavailable
		}
		return service.ErrAuthSessionUnavailable
	}
	if guest == nil || guest.Session == nil || guest.Session.ShareLinkID != expectedLinkID {
		return repository.ErrWhiteboardSessionUnavailable
	}
	return nil
}

func whiteboardCollabTicketAccountID(body []byte, fallback uuid.UUID) (uuid.UUID, error) {
	if fallback == uuid.Nil {
		return uuid.Nil, repository.ErrWhiteboardInvalid
	}
	trimmedBody := strings.TrimSpace(string(body))
	if trimmedBody == "" {
		return fallback, nil
	}
	if !strings.HasPrefix(trimmedBody, "{") {
		return uuid.Nil, repository.ErrWhiteboardInvalid
	}
	var request struct {
		AccountID json.RawMessage `json:"account_id"`
	}
	if err := json.Unmarshal(body, &request); err != nil {
		return uuid.Nil, repository.ErrWhiteboardInvalid
	}
	if len(request.AccountID) == 0 {
		return fallback, nil
	}
	var value string
	if err := json.Unmarshal(request.AccountID, &value); err != nil {
		return uuid.Nil, repository.ErrWhiteboardInvalid
	}
	canonical := strings.ToLower(value)
	accountID, err := uuid.Parse(canonical)
	if err != nil || accountID == uuid.Nil || accountID.String() != canonical {
		return uuid.Nil, repository.ErrWhiteboardInvalid
	}
	return accountID, nil
}

func (s *Server) handleCreateWhiteboardCollabTicket(c *fiber.Ctx) error {
	fallbackAccountID, userID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	claims, ok := c.Locals("claims").(*service.JWTClaims)
	if !ok || claims == nil || strings.TrimSpace(claims.SessionID) == "" {
		return fiber.ErrUnauthorized
	}
	accountID, err := whiteboardCollabTicketAccountID(c.Body(), fallbackAccountID)
	if err != nil {
		return whiteboardError(c, err)
	}
	moduleAllowed, err := s.whiteboardModuleAllowed(c.Context(), userID, accountID)
	if err != nil {
		return whiteboardCollabAuthorizationUnavailable(c)
	}
	if !moduleAllowed {
		return whiteboardError(c, repository.ErrWhiteboardForbidden)
	}
	boardID, err := whiteboardPathID(c, "id")
	if err != nil {
		return whiteboardError(c, err)
	}
	access, err := s.repos.Whiteboard.RequireActiveAccess(c.Context(), accountID, userID, boardID, domain.WhiteboardAccessView)
	if err != nil {
		if !errors.Is(err, repository.ErrWhiteboardNotFound) && !errors.Is(err, repository.ErrWhiteboardForbidden) {
			return whiteboardCollabAuthorizationUnavailable(c)
		}
		return whiteboardError(c, err)
	}
	displayName := "Usuario de Clarin"
	if user, userErr := s.repos.User.GetByID(c.Context(), userID); userErr == nil && user != nil && strings.TrimSpace(user.DisplayName) != "" {
		displayName = strings.TrimSpace(user.DisplayName)
	}
	return s.issueWhiteboardCollabTicket(c, &whiteboardRealtimePrincipal{
		AccountID: accountID, BoardID: boardID, UserID: &userID, SessionID: claims.SessionID,
		Actor: whiteboardcore.RealtimeActor{
			Kind: "user", ID: uuid.New(), UserID: &userID, DisplayName: displayName, Access: access.Level,
		},
	})
}

func (s *Server) handleCreateWhiteboardGuestCollabTicket(c *fiber.Ctx) error {
	linkID, err := whiteboardGuestExpectedLinkID(c)
	if err != nil {
		return whiteboardError(c, err)
	}
	secret, err := whiteboardGuestSecret(c, linkID)
	if err != nil {
		return whiteboardError(c, err)
	}
	tokenHash := service.HashWhiteboardSecret(secret)
	guest, err := s.repos.Whiteboard.ResolveGuestSession(c.Context(), tokenHash, domain.WhiteboardAccessView, time.Now().UTC())
	if resolutionErr := whiteboardGuestTicketResolutionError(guest, linkID, err); resolutionErr != nil {
		if errors.Is(resolutionErr, service.ErrAuthSessionUnavailable) {
			return whiteboardCollabAuthorizationUnavailable(c)
		}
		return whiteboardError(c, resolutionErr)
	}
	guestID := guest.Session.ID
	guestExpiresAt := guest.Session.ExpiresAt
	return s.issueWhiteboardCollabTicket(c, &whiteboardRealtimePrincipal{
		AccountID: guest.Session.AccountID, BoardID: guest.Session.BoardID,
		GuestSession: &guestID, GuestTokenHash: tokenHash, GuestExpiresAt: &guestExpiresAt,
		Actor: whiteboardcore.RealtimeActor{
			Kind: "guest", ID: uuid.New(), GuestID: &guestID,
			DisplayName: guest.Session.DisplayName, Access: guest.Session.AccessLevel,
		},
	})
}

func (s *Server) consumeWhiteboardCollabTicket(c *fiber.Ctx, boardID uuid.UUID) (*whiteboardRealtimePrincipal, error) {
	if s.cache == nil {
		return nil, service.ErrAuthSessionUnavailable
	}
	plain := strings.TrimSpace(c.Query("ticket"))
	if plain == "" || len(plain) > 256 {
		return nil, repository.ErrWhiteboardSessionUnavailable
	}
	payload, err := s.cache.Take(c.Context(), whiteboardCollabTicketKey(service.HashWhiteboardSecret(plain)))
	if err != nil {
		return nil, service.ErrAuthSessionUnavailable
	}
	if len(payload) == 0 {
		return nil, repository.ErrWhiteboardSessionUnavailable
	}
	var ticket whiteboardCollabTicket
	if json.Unmarshal(payload, &ticket) != nil || ticket.Principal == nil || !ticket.ExpiresAt.After(time.Now().UTC()) {
		return nil, repository.ErrWhiteboardSessionUnavailable
	}
	principal := ticket.Principal
	member := principal.UserID != nil && principal.GuestSession == nil && strings.TrimSpace(principal.SessionID) != ""
	guest := principal.GuestSession != nil && principal.UserID == nil && strings.TrimSpace(principal.GuestTokenHash) != ""
	if principal.BoardID != boardID || principal.AccountID == uuid.Nil || (!member && !guest) {
		return nil, repository.ErrWhiteboardSessionUnavailable
	}
	if principal.UserID != nil {
		principal.Actor.UserID = principal.UserID
	}
	if principal.GuestSession != nil {
		principal.Actor.GuestID = principal.GuestSession
	}
	return principal, nil
}
