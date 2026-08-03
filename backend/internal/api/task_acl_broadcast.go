package api

import (
	"context"
	"sort"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/ws"
)

func (s *Server) commonTaskViewerIDs(ctx context.Context, accountID uuid.UUID, taskIDs []uuid.UUID) ([]uuid.UUID, error) {
	if len(taskIDs) == 0 {
		return []uuid.UUID{}, nil
	}
	viewerSets := make([][]uuid.UUID, 0, len(taskIDs))
	for _, taskID := range taskIDs {
		viewers, err := s.repos.TaskWork.TaskViewerUserIDs(ctx, accountID, taskID)
		if err != nil {
			return nil, err
		}
		viewerSets = append(viewerSets, viewers)
	}
	return intersectTaskViewerSets(viewerSets), nil
}

// intersectTaskViewerSets is intentionally independent from WebSocket and
// repository state so the no-leak rule for multi-task payloads is unit tested.
// A dependency or Gantt event may name every endpoint, therefore a union of
// viewers would disclose a private task across environment boundaries.
func intersectTaskViewerSets(viewerSets [][]uuid.UUID) []uuid.UUID {
	if len(viewerSets) == 0 {
		return []uuid.UUID{}
	}
	common := make(map[uuid.UUID]struct{}, len(viewerSets[0]))
	for _, viewerID := range viewerSets[0] {
		common[viewerID] = struct{}{}
	}
	for _, viewers := range viewerSets[1:] {
		current := make(map[uuid.UUID]struct{}, len(viewers))
		for _, viewerID := range viewers {
			current[viewerID] = struct{}{}
		}
		for viewerID := range common {
			if _, visible := current[viewerID]; !visible {
				delete(common, viewerID)
			}
		}
	}
	result := make([]uuid.UUID, 0, len(common))
	for viewerID := range common {
		result = append(result, viewerID)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].String() < result[j].String() })
	return result
}

func (s *Server) broadcastTaskWorkToCommonViewers(ctx context.Context, accountID uuid.UUID, taskIDs []uuid.UUID, action string, payload fiber.Map) {
	if s.hub == nil {
		return
	}
	viewers, err := s.commonTaskViewerIDs(ctx, accountID, taskIDs)
	if err != nil || len(viewers) == 0 {
		return
	}
	realtimePayload := taskRealtimePayload(payload)
	realtimePayload["action"] = action
	s.hub.BroadcastToAccountUsersWithPermission(accountID, viewers, domain.PermTasks, ws.EventTaskUpdate, realtimePayload)
}
