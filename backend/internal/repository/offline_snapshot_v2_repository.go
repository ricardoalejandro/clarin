package repository

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

// FetchSelectedSnapshotsV2 returns only resources that belong to the active
// terminal grant. Actor ACL is rechecked by the API immediately before this
// method; task rows are additionally filtered by the canonical actor-aware task
// query so private tasks in a selected list never leak into the projection.
func (r *OfflineRepository) FetchSelectedSnapshotsV2(ctx context.Context, terminalID, accountID, userID uuid.UUID, selectionIDs []uuid.UUID) ([]OfflineSnapshot, error) {
	if len(selectionIDs) == 0 || len(selectionIDs) > 50 {
		return nil, ErrOfflineResourceInvalid
	}
	rows, err := r.db.Query(ctx, `SELECT s.id,s.module,s.resource_type,s.resource_id,h.head_version
		FROM offline_resource_selections s
		JOIN offline_terminal_grants g ON g.id=s.grant_id AND g.account_id=s.account_id
		JOIN offline_resource_heads h ON h.selection_id=s.id
		WHERE g.terminal_id=$1 AND g.account_id=$2 AND g.user_id=$3 AND g.state='active' AND s.id=ANY($4::uuid[])
		ORDER BY s.module,s.resource_id`, terminalID, accountID, userID, selectionIDs)
	if err != nil {
		return nil, err
	}
	type selected struct {
		id, resourceID uuid.UUID
		module, typ    string
		headVersion    int64
	}
	selectedRows := make([]selected, 0, len(selectionIDs))
	for rows.Next() {
		var item selected
		if err := rows.Scan(&item.id, &item.module, &item.typ, &item.resourceID, &item.headVersion); err != nil {
			rows.Close()
			return nil, err
		}
		selectedRows = append(selectedRows, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if len(selectedRows) != len(selectionIDs) {
		return nil, ErrOfflineResourceInvalid
	}
	out := make([]OfflineSnapshot, 0, len(selectedRows))
	for _, item := range selectedRows {
		var snapshot *OfflineSnapshot
		if item.typ == domain.OfflineResourceTaskList {
			snapshot, err = r.offlineTaskListSnapshot(ctx, accountID, userID, item.resourceID)
		} else {
			snapshot, err = r.offlineSnapshot(ctx, accountID, item.module, item.typ, item.resourceID)
		}
		if errors.Is(err, pgx.ErrNoRows) {
			snapshot = &OfflineSnapshot{Module: item.module, ResourceType: item.typ, ResourceID: item.resourceID, Payload: json.RawMessage(`null`), Tombstone: true}
		}
		if err != nil {
			return nil, err
		}
		snapshot.SelectionID = item.id
		snapshot.Version = item.headVersion
		snapshot.Payload, err = canonicalOfflineSnapshotPayload(snapshot.Payload)
		if err != nil {
			return nil, err
		}
		digest := sha256.Sum256(snapshot.Payload)
		snapshot.ContentHash = fmt.Sprintf("%x", digest[:])
		if _, err := r.db.Exec(ctx, `UPDATE offline_resource_heads SET content_hash=$2,updated_at=NOW() WHERE selection_id=$1 AND head_version=$3`, item.id, digest[:], item.headVersion); err != nil {
			return nil, err
		}
		out = append(out, *snapshot)
	}
	return out, nil
}

// json.RawMessage is compacted and HTML-escaped when it is embedded in the
// API response. Hash the idempotent wire representation so Windows verifies
// the exact payload bytes it receives rather than the PostgreSQL JSONB text.
func canonicalOfflineSnapshotPayload(payload json.RawMessage) (json.RawMessage, error) {
	if !json.Valid(payload) {
		return nil, fmt.Errorf("offline snapshot payload is invalid JSON")
	}
	encoded, err := json.Marshal(json.RawMessage(payload))
	if err != nil {
		return nil, err
	}
	return json.RawMessage(encoded), nil
}

func (r *OfflineRepository) offlineTaskListSnapshot(ctx context.Context, accountID, userID, listID uuid.UUID) (*OfflineSnapshot, error) {
	var listPayload struct {
		ID            uuid.UUID  `json:"id"`
		Name          string     `json:"name"`
		Description   string     `json:"description"`
		Color         string     `json:"color"`
		Icon          string     `json:"icon"`
		EnvironmentID uuid.UUID  `json:"environment_id"`
		WorkflowID    *uuid.UUID `json:"workflow_id,omitempty"`
	}
	if err := r.db.QueryRow(ctx, `SELECT id,name,COALESCE(description,''),COALESCE(color,''),COALESCE(icon,''),environment_id,workflow_id FROM task_lists WHERE account_id=$1 AND id=$2 AND archived_at IS NULL AND deleted_at IS NULL`, accountID, listID).
		Scan(&listPayload.ID, &listPayload.Name, &listPayload.Description, &listPayload.Color, &listPayload.Icon, &listPayload.EnvironmentID, &listPayload.WorkflowID); err != nil {
		return nil, err
	}
	taskRepo := &TaskRepository{db: r.db}
	allTasks := make([]*domain.Task, 0)
	var cursor *TaskPageCursor
	for page := 0; page < 100; page++ {
		tasks, _, next, err := taskRepo.GetByAccountForActorCursor(ctx, accountID, userID, map[string]string{"list_id": listID.String()}, 200, cursor)
		if err != nil {
			return nil, err
		}
		allTasks = append(allTasks, tasks...)
		if next == nil {
			break
		}
		cursor = next
		if page == 99 {
			return nil, fmt.Errorf("offline task list exceeds 20000 visible tasks")
		}
	}
	payload, err := json.Marshal(map[string]any{"list": listPayload, "tasks": allTasks})
	if err != nil {
		return nil, err
	}
	return &OfflineSnapshot{Module: domain.OfflineModuleTasks, ResourceType: domain.OfflineResourceTaskList, ResourceID: listID, Payload: payload}, nil
}
