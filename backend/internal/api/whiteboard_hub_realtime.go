package api

import (
	"context"
	"log"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	whiteboardcore "github.com/naperu/clarin/internal/whiteboard"
	"github.com/naperu/clarin/internal/ws"
)

const (
	whiteboardHubChangedAction     = "whiteboard_hub_changed"
	whiteboardWorkHubRevokedAction = "whiteboard_work_hub_revoked"
)

func whiteboardHubControlPayload(action string) fiber.Map {
	// Hub invalidations intentionally carry no resource identifier, name,
	// breadcrumb, lifecycle, count or actor. Each recipient must obtain its own
	// account- and actor-authorized canonical snapshot over HTTP.
	return fiber.Map{"action": action}
}

func (s *Server) broadcastWhiteboardHubControlLocal(accountID uuid.UUID, action string) {
	if s == nil || s.hub == nil || accountID == uuid.Nil {
		return
	}
	s.hub.BroadcastToAccountWithPermission(
		accountID,
		domain.PermWhiteboards,
		ws.EventTaskUpdate,
		whiteboardHubControlPayload(action),
	)
}

func (s *Server) publishWhiteboardHubControl(accountID uuid.UUID, workRevoked bool) {
	if s == nil || accountID == uuid.Nil || s.cache == nil || s.whiteboardInstanceID == uuid.Nil {
		return
	}
	envelope := whiteboardcore.FanoutEnvelope{
		InstanceID: s.whiteboardInstanceID,
		AccountID:  accountID,
	}
	if workRevoked {
		envelope.WorkHubRevoked = true
	} else {
		envelope.WhiteboardHubChanged = true
	}
	payload, err := envelope.Encode()
	if err != nil {
		log.Printf("[WHITEBOARD HUB] invalidation encode failed: %v", err)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := s.cache.Publish(ctx, whiteboardcore.RedisFanoutChannel, payload); err != nil {
		log.Printf("[WHITEBOARD HUB] invalidation publish failed: %v", err)
	}
}

func (s *Server) notifyWhiteboardHubChanged(accountID uuid.UUID) {
	s.broadcastWhiteboardHubControlLocal(accountID, whiteboardHubChangedAction)
	s.publishWhiteboardHubControl(accountID, false)
}

func (s *Server) notifyWhiteboardWorkHubRevoked(accountID uuid.UUID) {
	s.broadcastWhiteboardHubControlLocal(accountID, whiteboardWorkHubRevokedAction)
	s.publishWhiteboardHubControl(accountID, true)
}
