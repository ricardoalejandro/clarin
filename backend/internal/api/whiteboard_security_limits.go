package api

import (
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
)

const (
	// The public exchange contains only a display name, an optional password and
	// a 32-byte share secret. Keep this far below the application's global 52 MiB
	// upload allowance. Traefik enforces the same value before Fiber allocates the
	// request body; this application guard remains mandatory for direct/internal
	// traffic and configuration drift.
	whiteboardGuestSessionMaxRequestBytes = 16 * 1024

	// A full scene can legitimately reach MaxWhiteboardSceneBytes. The envelope
	// adds UUID/version fields and JSON escaping, but should never gain another
	// unbounded payload alongside the scene.
	whiteboardGuestSnapshotMaxRequestBytes = service.MaxWhiteboardSceneBytes + 128*1024
)

func whiteboardRequestWithinLimit(c *fiber.Ctx, maxBytes int) bool {
	if c == nil || maxBytes <= 0 {
		return false
	}
	if contentLength := c.Request().Header.ContentLength(); contentLength > maxBytes {
		return false
	}
	return len(c.Body()) <= maxBytes
}

func whiteboardRequestTooLarge(c *fiber.Ctx, code string, maxBytes int) error {
	return c.Status(fiber.StatusRequestEntityTooLarge).JSON(fiber.Map{
		"success":   false,
		"error":     "La solicitud supera el tamaño permitido",
		"code":      code,
		"max_bytes": maxBytes,
	})
}

// guardWhiteboardGuestSessionExchange runs before BodyParser. Do not move its
// abuse checks into the handler: invalid JSON, passwords or secrets must still
// consume the public attempt budget.
func (s *Server) guardWhiteboardGuestSessionExchange(c *fiber.Ctx) error {
	if !whiteboardRequestWithinLimit(c, whiteboardGuestSessionMaxRequestBytes) {
		return whiteboardRequestTooLarge(c, "whiteboard_guest_session_payload_too_large", whiteboardGuestSessionMaxRequestBytes)
	}
	linkID, err := uuid.Parse(strings.TrimSpace(c.Params("id")))
	subject := "invalid"
	linkKey := "invalid"
	if err == nil && linkID != uuid.Nil {
		subject = linkID.String()
		linkKey = hashForLog(subject)
	}
	if err := s.checkAbuseLimits(c, "whiteboard_guest_session_rate_limited", subject, []abuseLimit{
		{Key: "abuse:whiteboard-share:ip:minute:" + hashForLog(clientIP(c)), Max: 12, Window: time.Minute},
		{Key: "abuse:whiteboard-share:link:minute:" + linkKey, Max: 30, Window: time.Minute},
		{Key: "abuse:whiteboard-share:link-ip:hour:" + hashForLog(linkKey+":"+clientIP(c)), Max: 40, Window: time.Hour},
	}); err != nil {
		return err
	}
	return c.Next()
}

// guardWhiteboardGuestSnapshotWrite bounds the expensive public full-scene PUT
// and REST PATCH fallback before JSON parsing, reconciliation, compression,
// PostgreSQL locks or MinIO writes. WebSocket patches have separate budgets.
func (s *Server) guardWhiteboardGuestSnapshotWrite(c *fiber.Ctx) error {
	if !whiteboardRequestWithinLimit(c, whiteboardGuestSnapshotMaxRequestBytes) {
		return whiteboardRequestTooLarge(c, "whiteboard_guest_snapshot_payload_too_large", whiteboardGuestSnapshotMaxRequestBytes)
	}
	linkID, err := whiteboardGuestExpectedLinkID(c)
	if err != nil {
		return whiteboardError(c, repository.ErrWhiteboardSessionUnavailable)
	}
	sessionKey := "missing"
	if cookie := strings.TrimSpace(c.Cookies(whiteboardGuestCookieName(linkID))); cookie != "" {
		sessionKey = service.HashWhiteboardSecret(cookie)
	}
	budget := whiteboardGuestSceneWriteRateBudget(c.Method(), len(c.Body()))
	prefix := "whiteboard-guest-snapshot"
	eventType := "whiteboard_guest_snapshot_rate_limited"
	if c.Method() == fiber.MethodPatch {
		prefix = "whiteboard-guest-patch"
		eventType = "whiteboard_guest_patch_rate_limited"
	}
	if err := s.checkAbuseLimits(c, eventType, linkID.String(), []abuseLimit{
		{Key: "abuse:" + prefix + ":ip:minute:" + hashForLog(clientIP(c)), Max: budget.IPPerMinute, Window: time.Minute},
		{Key: "abuse:" + prefix + ":link:minute:" + hashForLog(linkID.String()), Max: budget.LinkPerMinute, Window: time.Minute},
		{Key: "abuse:" + prefix + ":session:minute:" + sessionKey, Max: budget.SessionPerMinute, Window: time.Minute},
		{Key: "abuse:" + prefix + ":link-ip:hour:" + hashForLog(linkID.String()+":"+clientIP(c)), Max: budget.LinkIPPerHour, Window: time.Hour},
	}); err != nil {
		return err
	}
	return c.Next()
}

type whiteboardGuestSceneRateBudget struct {
	IPPerMinute      int64
	LinkPerMinute    int64
	SessionPerMinute int64
	LinkIPPerHour    int64
}

func whiteboardGuestSceneWriteRateBudget(method string, bodyBytes int) whiteboardGuestSceneRateBudget {
	if method != fiber.MethodPatch {
		return whiteboardGuestSceneRateBudget{IPPerMinute: 8, LinkPerMinute: 20, SessionPerMinute: 6, LinkIPPerHour: 30}
	}
	// REST patch fallback may autosave about once every 1.2 seconds when the
	// realtime room is unavailable. Preserve that valid small-scene flow while
	// sharply reducing the request count as each message approaches the 16 MiB
	// canonical scene ceiling.
	switch {
	case bodyBytes > 4*1024*1024:
		return whiteboardGuestSceneRateBudget{IPPerMinute: 12, LinkPerMinute: 30, SessionPerMinute: 6, LinkIPPerHour: 60}
	case bodyBytes > 1024*1024:
		return whiteboardGuestSceneRateBudget{IPPerMinute: 40, LinkPerMinute: 80, SessionPerMinute: 20, LinkIPPerHour: 240}
	default:
		return whiteboardGuestSceneRateBudget{IPPerMinute: 100, LinkPerMinute: 200, SessionPerMinute: 60, LinkIPPerHour: 600}
	}
}

func (s *Server) checkWhiteboardGuestSnapshotPersistenceBudget(c *fiber.Ctx, accountID, boardID uuid.UUID) error {
	if accountID == uuid.Nil || boardID == uuid.Nil {
		return repository.ErrWhiteboardSessionUnavailable
	}
	return s.checkAbuseLimits(c, "whiteboard_guest_snapshot_persistence_rate_limited", boardID.String(), []abuseLimit{
		{Key: "abuse:whiteboard-guest-snapshot:board:minute:" + accountID.String() + ":" + boardID.String(), Max: 30, Window: time.Minute},
		{Key: "abuse:whiteboard-guest-snapshot:account:minute:" + accountID.String(), Max: 120, Window: time.Minute},
	})
}
