package api

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
)

type storagePrivateUseAdapter struct{ whiteboards bool }

func (a storagePrivateUseAdapter) Name() string {
	if a.whiteboards {
		return "private_whiteboards"
	}
	return "private_work"
}
func (a storagePrivateUseAdapter) permission() string {
	if a.whiteboards {
		return domain.PermWhiteboards
	}
	return domain.PermTasks
}
func init() {
	storageAdditionalUseAdapters = append(storageAdditionalUseAdapters, storagePrivateUseAdapter{}, storagePrivateUseAdapter{whiteboards: true})
}

func (a storagePrivateUseAdapter) references(ctx context.Context, q storageSelfServiceQuerier, actor storageUseActor, key string) ([]repository.PrivateStorageReference, error) {
	if !storageSelfServiceHasPermission(actor.Claims, a.permission()) {
		return []repository.PrivateStorageReference{}, nil
	}
	var keys []string
	if key != "" {
		keys = []string{key}
	}
	if a.whiteboards {
		return repository.ListWhiteboardStorageReferences(ctx, q, actor.AccountID, actor.UserID, keys)
	}
	return repository.ListTaskStorageReferences(ctx, q, actor.AccountID, actor.UserID, keys)
}
func (a storagePrivateUseAdapter) use(actor storageUseActor, ref repository.PrivateStorageReference) storageSelfServiceUse {
	return storageSelfServiceUse{UseID: storageUseID(actor.AccountID, a.Name(), ref.ID, ref.Kind, ref.ObjectKey), Type: ref.Origin, Label: ref.Label, Href: ref.Href,
		CanRemove: ref.CanRemove, BlockedReason: ref.BlockedReason, Adapter: a.Name(), AccountID: actor.AccountID, ObjectKey: ref.ObjectKey, SourceID: ref.ID, ParentID: ref.ParentID, Slot: ref.Kind,
		ReferenceIDs: []string{a.Name() + "|" + ref.ID.String()}, Fingerprint: storageUseFingerprint([]any{ref.ID, ref.ParentID, ref.ObjectKey, ref.Version, ref.CanRemove})}
}

func (a storagePrivateUseAdapter) AuthorizeRecovery(ctx context.Context, _ *Server, q storageSelfServiceQuerier, actor storageUseActor, snapshot storageUseSnapshot, action string) error {
	if snapshot.AccountID != actor.AccountID || snapshot.Adapter != a.Name() || !storageSelfServiceHasPermission(actor.Claims, a.permission()) {
		return errStorageUseProtected
	}
	mutate := action == "restore" || action == "purge"
	err := repository.AuthorizePrivateStorageRecovery(ctx, q, actor.AccountID, actor.UserID, snapshot.ParentID, a.whiteboards, mutate)
	if err == nil && !a.whiteboards {
		err = repository.AuthorizeTaskStorageRemovalRecovery(ctx, q, actor.AccountID, actor.UserID, snapshot.SourceID, snapshot.ParentID, snapshot.Before)
	}
	if err == nil && a.whiteboards {
		err = repository.AuthorizeWhiteboardStorageRemovalRecovery(actor.UserID, snapshot.SourceID, snapshot.ParentID, snapshot.Before)
	}
	if err != nil && (action == "read" || action == "purge") && domain.HasAccountAdminAuthority(actor.Claims.Role, actor.Claims.IsSuperAdmin) && snapshot.ParentID != uuid.Nil {
		var parentExists bool
		query := `SELECT EXISTS(SELECT 1 FROM tasks WHERE account_id=$1 AND id=$2)`
		if a.whiteboards {
			query = `SELECT EXISTS(SELECT 1 FROM whiteboards WHERE account_id=$1 AND id=$2)`
		}
		if queryErr := q.QueryRow(ctx, query, actor.AccountID, snapshot.ParentID).Scan(&parentExists); queryErr != nil {
			return queryErr
		}
		if !parentExists {
			return nil
		}
	}
	return storagePrivateUseError(err)
}
func (a storagePrivateUseAdapter) List(ctx context.Context, _ *Server, q storageSelfServiceQuerier, actor storageUseActor, key string) ([]storageSelfServiceUse, error) {
	refs, err := a.references(ctx, q, actor, key)
	if err != nil {
		return nil, err
	}
	result := make([]storageSelfServiceUse, 0, len(refs))
	for _, ref := range refs {
		result = append(result, a.use(actor, ref))
	}
	return result, nil
}
func (a storagePrivateUseAdapter) Detach(ctx context.Context, s *Server, tx pgx.Tx, actor storageUseActor, use storageSelfServiceUse) (storageUseSnapshot, error) {
	if use.AccountID != actor.AccountID || use.Adapter != a.Name() {
		return storageUseSnapshot{}, errStorageUseProtected
	}
	refs, err := a.references(ctx, tx, actor, use.ObjectKey)
	if err != nil {
		return storageUseSnapshot{}, err
	}
	var selected *repository.PrivateStorageReference
	for i := range refs {
		if candidate := a.use(actor, refs[i]); candidate.UseID == use.UseID && candidate.Fingerprint == use.Fingerprint {
			selected = &refs[i]
			break
		}
	}
	if selected == nil {
		return storageUseSnapshot{}, errStorageUseChanged
	}
	if !selected.CanRemove {
		return storageUseSnapshot{}, errStorageUseProtected
	}
	marker := uuid.New()
	var backup json.RawMessage
	if a.whiteboards {
		backup, _, err = s.repos.Whiteboard.RemoveStorageReferenceTx(ctx, tx, actor.AccountID, actor.UserID, use.SourceID, marker, selected.Version)
	} else {
		backup, _, err = repository.RemoveTaskStorageReferenceTx(ctx, tx, actor.AccountID, actor.UserID, use.SourceID, marker, marker, selected.Version)
	}
	if err != nil {
		return storageUseSnapshot{}, storagePrivateUseError(err)
	}
	return storageUseSnapshot{Version: 1, Adapter: a.Name(), UseID: use.UseID, AccountID: actor.AccountID, ObjectKey: use.ObjectKey, SourceID: use.SourceID, ParentID: use.ParentID, Slot: use.Slot, Type: use.Type, Label: use.Label, Href: use.Href, Before: backup, After: json.RawMessage(`{}`)}, nil
}
func (a storagePrivateUseAdapter) Restore(ctx context.Context, s *Server, tx pgx.Tx, actor storageUseActor, snapshot storageUseSnapshot) error {
	if snapshot.AccountID != actor.AccountID || snapshot.Adapter != a.Name() || !storageSelfServiceHasPermission(actor.Claims, a.permission()) {
		return errStorageUseProtected
	}
	var err error
	if a.whiteboards {
		_, err = s.repos.Whiteboard.RestoreStorageReferenceTx(ctx, tx, actor.AccountID, actor.UserID, uuid.New(), snapshot.Before)
	} else {
		var marker struct {
			RecoveryID uuid.UUID `json:"recovery_id"`
		}
		if json.Unmarshal(snapshot.Before, &marker) != nil || marker.RecoveryID == uuid.Nil {
			return errStorageUseRestoreConflict
		}
		_, err = repository.RestoreTaskStorageReferenceTx(ctx, tx, actor.AccountID, actor.UserID, marker.RecoveryID, uuid.New(), snapshot.Before)
	}
	return storagePrivateUseError(err)
}

func (a storagePrivateUseAdapter) BeforePurge(ctx context.Context, _ *Server, tx pgx.Tx, actor storageUseActor, snapshot storageUseSnapshot) error {
	if snapshot.AccountID != actor.AccountID || snapshot.Adapter != a.Name() {
		return errStorageUseProtected
	}
	if a.whiteboards {
		return nil
	}
	return storagePrivateUseError(repository.FinalizeTaskStorageRemovalTx(ctx, tx, actor.AccountID, snapshot.Before))
}
func storagePrivateUseError(err error) error {
	if err == nil {
		return nil
	}
	// Resource ACL queries intentionally return not-found for hidden parents.
	// Preserve that denial at the adapter boundary; it is not an unavailable
	// database or evidence that a caller may inspect the original location.
	if errors.Is(err, repository.ErrTaskAccessDenied) || errors.Is(err, repository.ErrWhiteboardForbidden) || errors.Is(err, pgx.ErrNoRows) || errors.Is(err, repository.ErrTaskWorkNotFound) || errors.Is(err, repository.ErrWhiteboardNotFound) {
		return errStorageUseProtected
	}
	if errors.Is(err, repository.ErrWhiteboardConflict) || errors.Is(err, repository.ErrTaskAccessRevisionConflict) {
		return errStorageUseRestoreConflict
	}
	return err
}
func (a storagePrivateUseAdapter) AfterCommit(ctx context.Context, s *Server, actor storageUseActor, snapshots []storageUseSnapshot, action string) {
	if !a.whiteboards {
		s.invalidateTasksCache(actor.AccountID)
	}
	seen := map[uuid.UUID]bool{}
	for _, snapshot := range snapshots {
		if snapshot.Adapter != a.Name() || snapshot.AccountID != actor.AccountID {
			continue
		}
		if a.whiteboards {
			if seen[snapshot.ParentID] {
				continue
			}
			seen[snapshot.ParentID] = true
			scene, err := s.repos.Whiteboard.GetScene(ctx, actor.AccountID, actor.UserID, snapshot.ParentID, domain.WhiteboardAccessView)
			if err == nil {
				s.broadcastWhiteboardMessage(actor.AccountID, snapshot.ParentID, whiteboardSceneSnapshotMessage(scene), uuid.Nil)
			}
		} else {
			event := "attachment_deleted"
			if action == "restore" {
				event = "attachment_added"
			}
			var removed struct {
				Scope string `json:"attachment_scope"`
			}
			_ = json.Unmarshal(snapshot.Before, &removed)
			if removed.Scope == repository.TaskAttachmentScopeCommentDraft {
				continue
			}
			s.broadcastTaskWork(ctx, actor.AccountID, event, fiber.Map{"task_id": snapshot.ParentID, "attachment_id": snapshot.SourceID, "attachment_scope": removed.Scope, "origin": "storage"})
		}
	}
}
