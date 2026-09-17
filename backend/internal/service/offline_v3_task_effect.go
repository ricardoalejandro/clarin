package service

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
)

// ApplyOfflineV3TaskEffect is at-least-once delivery with stable operation and
// event IDs. Durable unique recurrence/reminder contracts make retries safe;
// consumers must still deduplicate WebSocket echoes by canonical task/version.
func (s *TaskService) ApplyOfflineV3TaskEffect(ctx context.Context, effect repository.OfflineV3TaskEffect) error {
	if effect.Origin != "" && effect.Origin != "offline_v3" && effect.Origin != "offline_v4" && effect.Origin != "offline_v5" {
		return errors.New("invalid offline task effect origin")
	}
	if effect.ID == uuid.Nil || effect.GrantID == uuid.Nil || effect.ActorID == uuid.Nil || effect.TaskID == uuid.Nil || effect.AccountID == uuid.Nil || effect.OperationID == uuid.Nil || effect.TaskVersion < 1 ||
		(effect.Action != domain.OfflineV3ActionTasksCreate && effect.Action != domain.OfflineV3ActionTasksComplete &&
			effect.Action != domain.OfflineV5ActionTasksUpdate && effect.Action != domain.OfflineV5ActionTasksReopen &&
			effect.Action != domain.OfflineV5ActionTasksComment) ||
		(effect.Action == domain.OfflineV5ActionTasksComment && (effect.RelatedResourceID == nil || *effect.RelatedResourceID == uuid.Nil)) {
		return errors.New("offline task effect invalid")
	}
	if effect.RecurrenceSeed != nil {
		if effect.Action != domain.OfflineV3ActionTasksComplete || effect.RecurrenceSeed.AccountID != effect.AccountID || effect.RecurrenceSeed.ID != effect.TaskID {
			return errors.New("offline recurrence effect binding invalid")
		}
		if err := s.ensureNextOccurrenceChecked(ctx, effect.RecurrenceSeed); err != nil {
			return err
		}
	}
	canonical, err := s.GetByID(ctx, effect.TaskID, effect.AccountID)
	if errors.Is(err, pgx.ErrNoRows) || errors.Is(err, repository.ErrTaskWorkNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if effect.Action == domain.OfflineV5ActionTasksComment {
		comment, commentErr := s.repos.TaskWork.GetComment(ctx, effect.AccountID, effect.TaskID, *effect.RelatedResourceID)
		if errors.Is(commentErr, pgx.ErrNoRows) || errors.Is(commentErr, repository.ErrTaskWorkNotFound) {
			return nil
		}
		if commentErr != nil {
			return commentErr
		}
		comment.CanEdit, comment.CanDelete = false, false
		s.broadcastTaskACL(ctx, effect.AccountID, effect.TaskID, nil, map[string]interface{}{
			"action": "comment_created", "task_id": effect.TaskID.String(), "comment_id": comment.ID.String(),
			"comment": comment, "operation_id": effect.OperationID.String(), "event_id": effect.ID.String(), "origin": effect.Origin,
		})
		return nil
	}
	if err := s.repos.Task.SyncReminder(ctx, canonical.ID); err != nil {
		return err
	}
	if canonical.DeletedAt != nil {
		return nil
	}
	if s.hub != nil {
		action := offlineV3TaskEffectAction(effect, canonical.Version)
		origin := effect.Origin
		if origin == "" {
			origin = "offline_v3"
		}
		payload := map[string]interface{}{"action": action, "task": canonical, "operation_id": effect.OperationID.String(), "event_id": effect.ID.String(), "origin": origin}
		s.broadcastTaskACL(ctx, effect.AccountID, canonical.ID, nil, payload)
	}
	if canonical.ParentTaskID != nil {
		s.NotifySubtasksUpdated(ctx, canonical.AccountID, *canonical.ParentTaskID)
	}
	return nil
}

func offlineV3TaskEffectAction(effect repository.OfflineV3TaskEffect, canonicalVersion int64) string {
	if canonicalVersion != effect.TaskVersion {
		return "updated"
	}
	if effect.Action == domain.OfflineV3ActionTasksCreate {
		return "created"
	}
	if effect.Action == domain.OfflineV3ActionTasksComplete {
		return "completed"
	}
	return "updated"
}
