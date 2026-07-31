package api

import (
	"context"
	"log"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

// taskHierarchyCounts is intentionally best-effort after a committed task
// mutation. A transient read failure must not turn a successful write into a
// misleading 500 response; clients can still reconcile through /hierarchy.
func (s *Server) taskHierarchyCounts(ctx context.Context, accountID uuid.UUID) *domain.TaskHierarchyCounts {
	counts, err := s.repos.TaskWork.HierarchyCounts(ctx, accountID)
	if err != nil {
		log.Printf("[TASK] Warning: failed to load hierarchy counts for account %s: %v", accountID, err)
		return nil
	}
	return counts
}

func putTaskHierarchyCounts(payload fiber.Map, counts *domain.TaskHierarchyCounts) fiber.Map {
	if counts != nil {
		payload["hierarchy_counts"] = counts
	}
	return payload
}

// putTaskMutationReconciliation keeps the HTTP and WebSocket mutation
// envelopes identical for the fields used to deduplicate the write and apply
// its canonical derived counters. operationID is always a server-validated
// UUID string, even when the client omitted it.
func putTaskMutationReconciliation(payload fiber.Map, operationID uuid.UUID, counts *domain.TaskHierarchyCounts) fiber.Map {
	payload["operation_id"] = operationID.String()
	return putTaskHierarchyCounts(payload, counts)
}
