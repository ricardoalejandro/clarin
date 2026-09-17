package api

import (
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

type offlineResourceCandidate struct {
	ID       uuid.UUID `json:"id"`
	Type     string    `json:"type"`
	Label    string    `json:"label"`
	Subtitle string    `json:"subtitle,omitempty"`
}

// Kept as a named tombstone for older integrations and tests. The route is no
// longer registered: resource choice belongs to the authorized user, never to
// the global superadmin control plane.
func (s *Server) handleAdminOfflineResourceCandidates(c *fiber.Ctx) error {
	return c.Status(fiber.StatusGone).JSON(fiber.Map{"success": false, "error": "resource selection moved to the authorized user's offline settings"})
}
