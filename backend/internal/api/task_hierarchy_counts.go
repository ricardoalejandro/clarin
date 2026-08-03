package api

import (
	"context"
	"log"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

// taskHierarchyCounts is intentionally best-effort after a committed task
// mutation. The snapshot is always calculated for the requesting actor: a
// global account snapshot would expose private list/folder IDs and counts to a
// user whose only access is a directly shared task. A transient read failure
// must not turn a successful write into a misleading 500 response; clients can
// still reconcile through /hierarchy.
func (s *Server) taskHierarchyCounts(ctx context.Context, accountID, actorID uuid.UUID) *domain.TaskHierarchyCounts {
	counts, err := s.repos.TaskWork.HierarchyCountsForActor(ctx, accountID, actorID, nil)
	if err != nil {
		log.Printf("[TASK] Warning: failed to load hierarchy counts for account %s actor %s: %v", accountID, actorID, err)
		return nil
	}
	return counts
}

// taskRealtimePayload strips actor-scoped derived state from a multi-user
// event. Recipients can have different environment/task grants, so one actor's
// hierarchy snapshot is never safe or canonical for the whole audience. The
// task mutation itself remains in the event and clients reconcile their own
// authorized hierarchy when no snapshot is present.
func taskRealtimePayload(payload fiber.Map) fiber.Map {
	result := make(fiber.Map, len(payload)+1)
	taskIDs := make([]uuid.UUID, 0)
	for key, value := range payload {
		switch key {
		case "hierarchy_counts":
			continue
		case "task":
			if task, ok := value.(*domain.Task); ok && task != nil {
				taskIDs = append(taskIDs, task.ID)
			}
			continue
		case "subtask":
			if task, ok := value.(*domain.Task); ok && task != nil {
				taskIDs = append(taskIDs, task.ID)
			}
			continue
		case "tasks":
			if tasks, ok := value.([]*domain.Task); ok {
				for _, task := range tasks {
					if task != nil {
						taskIDs = append(taskIDs, task.ID)
					}
				}
			}
			continue
		default:
			result[key] = value
		}
	}
	if _, hasTaskID := result["task_id"]; !hasTaskID {
		if len(taskIDs) == 1 {
			result["task_id"] = taskIDs[0]
		} else if len(taskIDs) > 1 {
			result["task_ids"] = taskIDs
		}
	}
	return result
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
