package api

import (
	"encoding/json"
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
	expiresAt := time.Now().UTC().Add(whiteboardCollabTicketTTL)
	if !principal.ExpiresAt.IsZero() && principal.ExpiresAt.Before(expiresAt) {
		expiresAt = principal.ExpiresAt
	}
	if !expiresAt.After(time.Now().UTC()) {
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

func (s *Server) handleCreateWhiteboardCollabTicket(c *fiber.Ctx) error {
	accountID, userID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	boardID, err := whiteboardPathID(c, "id")
	if err != nil {
		return whiteboardError(c, err)
	}
	access, err := s.repos.Whiteboard.RequireAccess(c.Context(), accountID, userID, boardID, domain.WhiteboardAccessView)
	if err != nil {
		return whiteboardError(c, err)
	}
	claims, ok := c.Locals("claims").(*service.JWTClaims)
	if !ok || claims == nil {
		return fiber.ErrUnauthorized
	}
	displayName := "Usuario de Clarin"
	if user, userErr := s.repos.User.GetByID(c.Context(), userID); userErr == nil && user != nil && strings.TrimSpace(user.DisplayName) != "" {
		displayName = strings.TrimSpace(user.DisplayName)
	}
	expiresAt := time.Time{}
	if claims.ExpiresAt != nil {
		expiresAt = claims.ExpiresAt.Time
	}
	return s.issueWhiteboardCollabTicket(c, &whiteboardRealtimePrincipal{
		AccountID: accountID, BoardID: boardID, UserID: &userID, Claims: claims, ExpiresAt: expiresAt,
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
	if err != nil || guest.Session.ShareLinkID != linkID {
		return whiteboardError(c, repository.ErrWhiteboardSessionUnavailable)
	}
	guestID := guest.Session.ID
	return s.issueWhiteboardCollabTicket(c, &whiteboardRealtimePrincipal{
		AccountID: guest.Session.AccountID, BoardID: guest.Session.BoardID,
		GuestSession: &guestID, GuestTokenHash: tokenHash, ExpiresAt: guest.Session.ExpiresAt,
		Actor: whiteboardcore.RealtimeActor{
			Kind: "guest", ID: uuid.New(), GuestID: &guestID,
			DisplayName: guest.Session.DisplayName, Access: guest.Session.AccessLevel,
		},
	})
}

func (s *Server) consumeWhiteboardCollabTicket(c *fiber.Ctx, boardID uuid.UUID) (*whiteboardRealtimePrincipal, error) {
	if s.cache == nil {
		return nil, repository.ErrWhiteboardSessionUnavailable
	}
	plain := strings.TrimSpace(c.Query("ticket"))
	if plain == "" || len(plain) > 256 {
		return nil, repository.ErrWhiteboardSessionUnavailable
	}
	payload, err := s.cache.Take(c.Context(), whiteboardCollabTicketKey(service.HashWhiteboardSecret(plain)))
	if err != nil || len(payload) == 0 {
		return nil, repository.ErrWhiteboardSessionUnavailable
	}
	var ticket whiteboardCollabTicket
	if json.Unmarshal(payload, &ticket) != nil || ticket.Principal == nil || !ticket.ExpiresAt.After(time.Now().UTC()) {
		return nil, repository.ErrWhiteboardSessionUnavailable
	}
	principal := ticket.Principal
	if principal.BoardID != boardID || principal.AccountID == uuid.Nil || (principal.UserID == nil && principal.GuestSession == nil) {
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
