package engine

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"time"

	"github.com/naperu/clarin-offline-agent/internal/v3/session"
	"github.com/naperu/clarin-offline-agent/internal/v3/vault"
)

type TaskPage struct {
	Items             []json.RawMessage
	NextCursor        string
	SelectionRevision int64
	HeadVersion       int64
	LastSyncedAt      time.Time
}

func (e *Engine) taskResource(ctx context.Context, access *session.Access, selectionID, taskID string) (*vault.Resource, error) {
	selection, err := e.requireTaskSelection(ctx, access, selectionID)
	if err != nil {
		return nil, err
	}
	grant, err := e.catalog.Grant(ctx, access.Tuple.GrantID)
	if err != nil {
		return nil, err
	}
	store, err := e.vaultFor(grant)
	if err != nil {
		return nil, err
	}
	if local, localErr := store.Resource(ctx, access.Secrets.DEK, "tasks", "task", taskID); localErr == nil {
		if local.SelectionID != selectionID {
			return nil, ErrNotFound
		}
		return local, nil
	}
	closure, err := store.Resource(ctx, access.Secrets.DEK, "tasks", "task_list", selection.ResourceID)
	if err != nil || closure.SelectionID != selectionID {
		return nil, ErrNotFound
	}
	var snapshot struct {
		List     json.RawMessage   `json:"list"`
		Statuses []json.RawMessage `json:"statuses"`
		Tasks    []json.RawMessage `json:"tasks"`
	}
	decoder := json.NewDecoder(bytes.NewReader(closure.Payload))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&snapshot) != nil || ensureEOF(decoder) != nil {
		return nil, errors.New("local task closure corrupt")
	}
	for _, raw := range snapshot.Tasks {
		if rawID(raw) != taskID {
			continue
		}
		return &vault.Resource{SelectionID: selectionID, Module: "tasks", ResourceType: "task", ResourceID: taskID,
			Revision: rawTaskVersion(raw), Payload: append(json.RawMessage(nil), raw...), UpdatedAt: closure.UpdatedAt}, nil
	}
	return nil, ErrNotFound
}

func (e *Engine) taskListAllowsCreate(ctx context.Context, access *session.Access, selectionID string) (bool, error) {
	selection, err := e.requireTaskSelection(ctx, access, selectionID)
	if err != nil {
		return false, err
	}
	resource, err := e.Resource(ctx, access, "tasks", "task_list", selection.ResourceID)
	if err != nil {
		return false, err
	}
	var closure struct {
		List     json.RawMessage   `json:"list"`
		Statuses []json.RawMessage `json:"statuses"`
		Tasks    []json.RawMessage `json:"tasks"`
	}
	decoder := json.NewDecoder(bytes.NewReader(resource.Payload))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&closure) != nil || ensureEOF(decoder) != nil {
		return false, errors.New("local task-list capability corrupt")
	}
	var list struct {
		CanCreate bool `json:"can_create"`
	}
	if json.Unmarshal(closure.List, &list) != nil {
		return false, errors.New("local task-list capability corrupt")
	}
	return list.CanCreate, nil
}

func taskAllowsComplete(raw json.RawMessage) bool {
	var task struct {
		CanComplete bool `json:"can_complete"`
	}
	return json.Unmarshal(raw, &task) == nil && task.CanComplete
}

// TaskPageForSelection expands the authenticated task-list closure and merges
// locally queued/canonical receipt projections by task ID. The latter wins so
// the UI can show an optimistic change without mutating the signed snapshot.
func (e *Engine) TaskPageForSelection(ctx context.Context, access *session.Access, selectionID, afterTaskID string, limit int) (*TaskPage, error) {
	selection, err := e.requireTaskSelection(ctx, access, selectionID)
	if err != nil {
		return nil, err
	}
	if afterTaskID != "" && !canonicalUUID(afterTaskID) {
		return nil, ErrInvalid
	}
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	closure, err := e.Resource(ctx, access, "tasks", "task_list", selection.ResourceID)
	if err != nil {
		return nil, err
	}
	var snapshot struct {
		List     json.RawMessage   `json:"list"`
		Statuses []json.RawMessage `json:"statuses"`
		Tasks    []json.RawMessage `json:"tasks"`
	}
	decoder := json.NewDecoder(bytes.NewReader(closure.Payload))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&snapshot) != nil || ensureEOF(decoder) != nil {
		return nil, errors.New("local task closure corrupt")
	}
	byID := make(map[string]json.RawMessage, len(snapshot.Tasks))
	versions := make(map[string]int64, len(snapshot.Tasks))
	for _, raw := range snapshot.Tasks {
		id := rawID(raw)
		if !canonicalUUID(id) {
			return nil, errors.New("local task projection corrupt")
		}
		byID[id] = append(json.RawMessage(nil), raw...)
		versions[id] = rawTaskVersion(raw)
	}
	grant, err := e.catalog.Grant(ctx, access.Tuple.GrantID)
	if err != nil {
		return nil, err
	}
	store, err := e.vaultFor(grant)
	if err != nil {
		return nil, err
	}
	cursor := ""
	for pages := 0; pages < 20; pages++ {
		rows, next, err := store.ListResourcesForSelection(ctx, access.Secrets.DEK, "tasks", selectionID, cursor, 100)
		if err != nil {
			return nil, err
		}
		for _, row := range rows {
			if row.ResourceType == "task" {
				localVersion, pending := rawTaskState(row.Payload)
				if pending || localVersion >= versions[row.ResourceID] {
					byID[row.ResourceID] = append(json.RawMessage(nil), row.Payload...)
					versions[row.ResourceID] = localVersion
				}
			}
		}
		if next == "" {
			break
		}
		cursor = next
	}
	ids := make([]string, 0, len(byID))
	for id := range byID {
		if strings.Compare(id, afterTaskID) > 0 {
			ids = append(ids, id)
		}
	}
	slices.Sort(ids)
	next := ""
	if len(ids) > limit {
		next = ids[limit-1]
		ids = ids[:limit]
	}
	items := make([]json.RawMessage, 0, len(ids))
	for _, id := range ids {
		items = append(items, publicTaskPayload(byID[id]))
	}
	return &TaskPage{Items: items, NextCursor: next, SelectionRevision: access.Lease.Selection, HeadVersion: selection.HeadVersion, LastSyncedAt: selection.LastSyncedAt}, nil
}

func publicTaskPayload(raw json.RawMessage) json.RawMessage {
	var value map[string]any
	if json.Unmarshal(raw, &value) != nil || value == nil {
		return append(json.RawMessage(nil), raw...)
	}
	delete(value, "local_create_operation_id")
	delete(value, "local_complete_operation_id")
	public, err := json.Marshal(value)
	if err != nil {
		return append(json.RawMessage(nil), raw...)
	}
	return public
}

func rawTaskVersion(raw json.RawMessage) int64 {
	version, _ := rawTaskState(raw)
	return version
}

func rawTaskState(raw json.RawMessage) (int64, bool) {
	var value struct {
		Version           int64  `json:"version"`
		LocalConfirmation string `json:"local_confirmation"`
	}
	_ = json.Unmarshal(raw, &value)
	return value.Version, value.LocalConfirmation == "pending"
}
