package repository

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"reflect"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/naperu/clarin/internal/domain"
)

var ErrOfflineV5WritesDisabled = errors.New("offline v5 writes disabled")

type OfflineV5SyncInput struct {
	GrantID           uuid.UUID                   `json:"grant_id"`
	BrowserProfileID  uuid.UUID                   `json:"browser_profile_id"`
	ChallengeID       uuid.UUID                   `json:"challenge_id"`
	Nonce             string                      `json:"nonce"`
	ManifestID        uuid.UUID                   `json:"manifest_id"`
	ManifestRevision  int64                       `json:"manifest_revision"`
	SelectionRevision int64                       `json:"selection_revision"`
	Operations        []domain.OfflineV5Operation `json:"operations"`
	WantSnapshots     []uuid.UUID                 `json:"want_snapshots"`
}

type OfflineV5SyncResult struct {
	Record            *OfflineV5AuthRecord
	Receipts          []domain.OfflineV5OperationResult
	RecoveredReceipts bool
}

type offlineV5StoredReceipt struct {
	ManifestID    uuid.UUID
	RequestHash   string
	IntentHash    string
	Action        string
	SelectionID   uuid.UUID
	ResourceID    uuid.UUID
	Status        string
	ServerVersion int64
	Result        json.RawMessage
}

func offlineV5RequestedSnapshotsAllowed(manifest *domain.OfflineV5Manifest, requested []uuid.UUID) bool {
	if manifest == nil || len(requested) > domain.OfflineV5MaxResources {
		return false
	}
	allowed := make(map[uuid.UUID]struct{}, len(manifest.Roots))
	for _, root := range manifest.Roots {
		allowed[root.SelectionID] = struct{}{}
	}
	seen := make(map[uuid.UUID]struct{}, len(requested))
	for _, id := range requested {
		if id == uuid.Nil {
			return false
		}
		if _, duplicate := seen[id]; duplicate {
			return false
		}
		seen[id] = struct{}{}
		if _, exists := allowed[id]; !exists {
			return false
		}
	}
	return true
}

func OfflineV5ActionModule(action string) (string, bool) {
	switch action {
	case domain.OfflineV5ActionTasksRead, domain.OfflineV5ActionTasksCreate, domain.OfflineV5ActionTasksUpdate,
		domain.OfflineV5ActionTasksComplete, domain.OfflineV5ActionTasksReopen, domain.OfflineV5ActionTasksComment:
		return domain.OfflineModuleTasks, true
	case domain.OfflineV5ActionContactsRead, domain.OfflineV5ActionContactsUpdate, domain.OfflineV5ActionContactsObserve:
		return domain.OfflineModuleContacts, true
	case domain.OfflineV5ActionProgramsRead, domain.OfflineV5ActionProgramsUpdate, domain.OfflineV5ActionProgramsParticipantAdd,
		domain.OfflineV5ActionProgramsParticipantLifecycle, domain.OfflineV5ActionProgramsSessionUpsert, domain.OfflineV5ActionProgramsAttendance,
		domain.OfflineV5ActionProgramsObservation, domain.OfflineV5ActionProgramsGoals:
		return domain.OfflineModulePrograms, true
	case domain.OfflineV5ActionBoardsRead, domain.OfflineV5ActionBoardsScene:
		return domain.OfflineModuleWhiteboards, true
	default:
		return "", false
	}
}

func offlineV5MutationAction(action string) bool {
	_, known := OfflineV5ActionModule(action)
	return known && action != domain.OfflineV5ActionTasksRead && action != domain.OfflineV5ActionContactsRead &&
		action != domain.OfflineV5ActionProgramsRead && action != domain.OfflineV5ActionBoardsRead
}

func offlineV5OperationBinding(record *OfflineV5AuthRecord, manifest *domain.OfflineV5Manifest, operation domain.OfflineV5Operation, now time.Time) bool {
	return record != nil && manifest != nil && operation.ProtocolVersion == domain.OfflineV5ProtocolVersion &&
		operation.BrowserProfileID == record.BrowserProfileID && operation.GrantID == record.GrantID &&
		operation.UserID == record.UserID && operation.AccountID == record.AccountID &&
		operation.ManifestID == manifest.ID && operation.ManifestRevision == manifest.Revision &&
		operation.SelectionRevision == record.SelectionRevision && operation.CredentialEpoch == record.CredentialEpoch &&
		operation.AuthorityEpoch == record.AuthorityEpoch && operation.OperationID != uuid.Nil && operation.SelectionID != uuid.Nil &&
		operation.ResourceID != uuid.Nil && operation.BaseVersion >= 0 && !operation.OccurredAt.IsZero() &&
		!operation.OccurredAt.After(now.Add(5*time.Minute)) && offlineV5MutationAction(operation.Action)
}

func offlineV5ReceiptRecoveryBindingsValid(record *OfflineV5AuthRecord, manifest *domain.OfflineV5Manifest, operations []domain.OfflineV5Operation, now time.Time) bool {
	seen := make(map[uuid.UUID]struct{}, len(operations))
	for _, operation := range operations {
		if !offlineV5OperationBinding(record, manifest, operation, now) {
			return false
		}
		if _, duplicate := seen[operation.OperationID]; duplicate {
			return false
		}
		seen[operation.OperationID] = struct{}{}
	}
	// An empty operation set is a signed, challenge-bound manifest refresh. It
	// is safe to recover because this path cannot dispatch canonical commands.
	return true
}

func offlineV5OperationRequestHash(operation domain.OfflineV5Operation) (string, error) {
	raw, err := json.Marshal(operation)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:]), nil
}

func offlineV5OperationIntentHash(operation domain.OfflineV5Operation) (string, error) {
	// The browser rebinds a pending operation only after authenticating a new
	// signed manifest. Keep the logical command immutable while excluding
	// exactly those authority fields that refreshPreparedBundle replaces.
	intent := struct {
		ProtocolVersion      int             `json:"protocol_version"`
		BrowserProfileID     uuid.UUID       `json:"browser_profile_id"`
		GrantID              uuid.UUID       `json:"grant_id"`
		UserID               uuid.UUID       `json:"user_id"`
		AccountID            uuid.UUID       `json:"account_id"`
		SelectionID          uuid.UUID       `json:"selection_id"`
		OperationID          uuid.UUID       `json:"operation_id"`
		DependsOnOperationID *uuid.UUID      `json:"depends_on_operation_id,omitempty"`
		Action               string          `json:"action"`
		ResourceID           uuid.UUID       `json:"resource_id"`
		BaseVersion          int64           `json:"base_version"`
		Base                 json.RawMessage `json:"base,omitempty"`
		Payload              json.RawMessage `json:"payload"`
		OccurredAt           time.Time       `json:"occurred_at"`
	}{operation.ProtocolVersion, operation.BrowserProfileID, operation.GrantID, operation.UserID, operation.AccountID,
		operation.SelectionID, operation.OperationID, operation.DependsOnOperationID, operation.Action, operation.ResourceID,
		operation.BaseVersion, operation.Base, operation.Payload, operation.OccurredAt}
	raw, err := json.Marshal(intent)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:]), nil
}

func offlineV5SyncWritesGate(receiptRecovery bool, operationCount int, globalWrites, grantWrites bool) error {
	if operationCount > 0 && !receiptRecovery && (!globalWrites || !grantWrites) {
		return ErrOfflineV5WritesDisabled
	}
	return nil
}

// offlineV5RecoveredReceipt accepts only the immutable result written for the
// byte-equivalent command under the same manifest. It is not an authorization
// path: callers must first validate the signed manifest tuple and current live
// grant, and no canonical mutation dispatcher is reachable from this helper.
func offlineV5RecoveredReceipt(operation domain.OfflineV5Operation, requestHash string, stored offlineV5StoredReceipt) (domain.OfflineV5OperationResult, error) {
	result := domain.OfflineV5OperationResult{OperationID: operation.OperationID, ResourceID: operation.ResourceID, Status: "rejected"}
	if stored.RequestHash != requestHash {
		return result, ErrOfflineV3ReceiptReuse
	}
	if stored.ManifestID != operation.ManifestID || stored.Action != operation.Action || stored.SelectionID != operation.SelectionID ||
		stored.ResourceID != operation.ResourceID || stored.Status == "" || len(stored.Result) == 0 {
		return result, ErrOfflineV3AccessDenied
	}
	if err := json.Unmarshal(stored.Result, &result); err != nil || result.OperationID != operation.OperationID ||
		result.ResourceID != operation.ResourceID || result.Status != stored.Status || result.ServerVersion != stored.ServerVersion {
		return domain.OfflineV5OperationResult{}, ErrOfflineV3AccessDenied
	}
	return result, nil
}

func offlineV5PendingReceiptCanRebind(operation domain.OfflineV5Operation, intentHash string, stored offlineV5StoredReceipt) error {
	if stored.Status != "pending" || stored.IntentHash == "" || stored.IntentHash != intentHash {
		return ErrOfflineV3ReceiptReuse
	}
	if stored.ManifestID == uuid.Nil || stored.Action != operation.Action || stored.SelectionID != operation.SelectionID ||
		stored.ResourceID != operation.ResourceID || len(stored.Result) == 0 {
		return ErrOfflineV3AccessDenied
	}
	var result domain.OfflineV5OperationResult
	if err := json.Unmarshal(stored.Result, &result); err != nil || result.OperationID != operation.OperationID ||
		result.ResourceID != operation.ResourceID || result.Status != "pending" || result.ErrorCode != "operation_dependency_pending" {
		return ErrOfflineV3AccessDenied
	}
	return nil
}

func offlineV5ReboundTerminalReceipt(operation domain.OfflineV5Operation, intentHash string, stored offlineV5StoredReceipt) (domain.OfflineV5OperationResult, error) {
	result := domain.OfflineV5OperationResult{OperationID: operation.OperationID, ResourceID: operation.ResourceID, Status: "rejected"}
	if stored.Status == "pending" || stored.IntentHash == "" || stored.IntentHash != intentHash {
		return result, ErrOfflineV3ReceiptReuse
	}
	if stored.ManifestID == uuid.Nil || stored.Action != operation.Action || stored.SelectionID != operation.SelectionID ||
		stored.ResourceID != operation.ResourceID || len(stored.Result) == 0 {
		return result, ErrOfflineV3AccessDenied
	}
	if err := json.Unmarshal(stored.Result, &result); err != nil || result.OperationID != operation.OperationID ||
		result.ResourceID != operation.ResourceID || result.Status != stored.Status || result.ServerVersion != stored.ServerVersion {
		return domain.OfflineV5OperationResult{}, ErrOfflineV3AccessDenied
	}
	return result, nil
}

func decodeOfflineV5Object(raw json.RawMessage, maximum int) (map[string]json.RawMessage, error) {
	if len(raw) < 2 || len(raw) > maximum || !utf8.Valid(raw) || !json.Valid(raw) {
		return nil, ErrOfflineV3Invalid
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return nil, ErrOfflineV3Invalid
	}
	out := make(map[string]json.RawMessage)
	for decoder.More() {
		nameToken, err := decoder.Token()
		name, ok := nameToken.(string)
		if err != nil || !ok || name == "" {
			return nil, ErrOfflineV3Invalid
		}
		if _, duplicate := out[name]; duplicate {
			return nil, ErrOfflineV3Invalid
		}
		var value json.RawMessage
		if decoder.Decode(&value) != nil {
			return nil, ErrOfflineV3Invalid
		}
		out[name] = value
	}
	if token, err = decoder.Token(); err != nil || token != json.Delim('}') || decoder.Decode(new(any)) != io.EOF {
		return nil, ErrOfflineV3Invalid
	}
	return out, nil
}

func offlineV5JSONEqual(left, right json.RawMessage) bool {
	var leftValue, rightValue any
	return json.Unmarshal(left, &leftValue) == nil && json.Unmarshal(right, &rightValue) == nil && reflect.DeepEqual(leftValue, rightValue)
}

func offlineV5MarshalMap(values map[string]json.RawMessage) json.RawMessage {
	if len(values) == 0 {
		return json.RawMessage(`{}`)
	}
	raw, _ := json.Marshal(values)
	return raw
}

// offlineV5MergePatch implements the closed three-way merge rule. A field is
// safe when the server still equals the prepared base, or when the desired
// value is already canonical. Same-field divergence is returned for an
// explicit user decision; no field is partially persisted.
func offlineV5MergePatch(baseVersion, currentVersion int64, base, local, current map[string]json.RawMessage) (bool, *domain.OfflineV5Conflict) {
	if baseVersion == currentVersion {
		return false, nil
	}
	fields := make([]string, 0)
	for name, desired := range local {
		serverValue, serverKnown := current[name]
		baseValue, baseKnown := base[name]
		if serverKnown && offlineV5JSONEqual(desired, serverValue) {
			continue
		}
		if !baseKnown || !serverKnown || !offlineV5JSONEqual(baseValue, serverValue) {
			fields = append(fields, name)
		}
	}
	if len(fields) == 0 {
		return true, nil
	}
	sort.Strings(fields)
	return false, &domain.OfflineV5Conflict{Fields: fields, Base: offlineV5MarshalMap(base),
		Local: offlineV5MarshalMap(local), Server: offlineV5MarshalMap(current)}
}

func offlineV5TaskCurrent(task *domain.Task) map[string]json.RawMessage {
	values := map[string]any{
		"title": task.Title, "description": task.Description, "start_at": task.StartAt, "due_at": task.DueAt,
		"due_end_at": task.DueEndAt, "is_all_day": task.IsAllDay, "priority": task.Priority, "starred": task.Starred,
		"progress": task.Progress, "progress_mode": task.ProgressMode, "manual_progress": task.ManualProgress,
		"is_milestone": task.IsMilestone, "notes": task.Notes, "status_id": task.StatusID, "assigned_to": task.AssignedTo,
		"type": task.Type, "color": task.Color,
	}
	out := make(map[string]json.RawMessage, len(values))
	for name, value := range values {
		out[name], _ = json.Marshal(value)
	}
	return out
}

func applyOfflineV5TaskPatch(task *domain.Task, fields map[string]json.RawMessage) error {
	for name, raw := range fields {
		switch name {
		case "title":
			var value string
			if json.Unmarshal(raw, &value) != nil || strings.TrimSpace(value) == "" || utf8.RuneCountInString(strings.TrimSpace(value)) > 500 {
				return ErrOfflineV3Invalid
			}
			task.Title = strings.TrimSpace(value)
		case "description":
			if json.Unmarshal(raw, &task.Description) != nil || len(task.Description) > 200000 {
				return ErrOfflineV3Invalid
			}
		case "start_at":
			if json.Unmarshal(raw, &task.StartAt) != nil {
				return ErrOfflineV3Invalid
			}
		case "due_at":
			if json.Unmarshal(raw, &task.DueAt) != nil {
				return ErrOfflineV3Invalid
			}
		case "due_end_at":
			if json.Unmarshal(raw, &task.DueEndAt) != nil {
				return ErrOfflineV3Invalid
			}
		case "is_all_day":
			if json.Unmarshal(raw, &task.IsAllDay) != nil {
				return ErrOfflineV3Invalid
			}
		case "priority":
			if json.Unmarshal(raw, &task.Priority) != nil || (task.Priority != domain.TaskPriorityLow && task.Priority != domain.TaskPriorityMedium && task.Priority != domain.TaskPriorityHigh && task.Priority != domain.TaskPriorityUrgent) {
				return ErrOfflineV3Invalid
			}
		case "starred":
			if json.Unmarshal(raw, &task.Starred) != nil {
				return ErrOfflineV3Invalid
			}
		case "progress":
			if json.Unmarshal(raw, &task.Progress) != nil || task.Progress < 0 || task.Progress > 100 {
				return ErrOfflineV3Invalid
			}
			task.ManualProgress = task.Progress
		case "manual_progress":
			if json.Unmarshal(raw, &task.ManualProgress) != nil || task.ManualProgress < 0 || task.ManualProgress > 100 {
				return ErrOfflineV3Invalid
			}
			if task.ProgressMode != "automatic" {
				task.Progress = task.ManualProgress
			}
		case "progress_mode":
			if json.Unmarshal(raw, &task.ProgressMode) != nil || (task.ProgressMode != "manual" && task.ProgressMode != "automatic") {
				return ErrOfflineV3Invalid
			}
			if task.ProgressMode == "manual" {
				task.Progress = task.ManualProgress
			}
		case "is_milestone":
			if json.Unmarshal(raw, &task.IsMilestone) != nil {
				return ErrOfflineV3Invalid
			}
		case "notes":
			if json.Unmarshal(raw, &task.Notes) != nil || len(task.Notes) > 200000 {
				return ErrOfflineV3Invalid
			}
		case "status_id":
			var value uuid.UUID
			if json.Unmarshal(raw, &value) != nil || value == uuid.Nil {
				return ErrOfflineV3Invalid
			}
			task.StatusID = &value
		case "assigned_to":
			if json.Unmarshal(raw, &task.AssignedTo) != nil || task.AssignedTo == uuid.Nil {
				return ErrOfflineV3Invalid
			}
		case "type":
			if json.Unmarshal(raw, &task.Type) != nil || (task.Type != domain.TaskTypeCall && task.Type != domain.TaskTypeWhatsApp && task.Type != domain.TaskTypeMeeting && task.Type != domain.TaskTypeReminder) {
				return ErrOfflineV3Invalid
			}
		case "color":
			color, decodeErr := offlineV5DecodeNullable[string](raw)
			if decodeErr != nil || (color != nil && !offlineV5HexColor(*color)) {
				return ErrOfflineV3Invalid
			}
			task.Color = color
		default:
			return ErrOfflineV3Invalid
		}
	}
	if task.StartAt != nil && task.DueAt != nil && task.DueAt.Before(*task.StartAt) {
		return ErrOfflineV3Invalid
	}
	if task.DueEndAt != nil && (task.DueAt == nil || task.DueEndAt.Before(*task.DueAt)) {
		return ErrOfflineV3Invalid
	}
	return nil
}

func offlineV5HexColor(value string) bool {
	if len(value) != 7 || value[0] != '#' {
		return false
	}
	for _, character := range value[1:] {
		if !((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f') || (character >= 'A' && character <= 'F')) {
			return false
		}
	}
	return true
}

func (r *OfflineV5Repository) applyTaskUpdateTx(ctx context.Context, tx pgx.Tx, record *OfflineV5AuthRecord, operation domain.OfflineV5Operation, selection domain.OfflineV3Selection) (domain.OfflineV5OperationResult, *domain.Task, error) {
	result := domain.OfflineV5OperationResult{OperationID: operation.OperationID, ResourceID: operation.ResourceID, Status: "rejected"}
	local, err := decodeOfflineV5Object(operation.Payload, 256<<10)
	if err != nil || len(local) == 0 || operation.BaseVersion < 1 {
		result.ErrorCode = "invalid_task_update"
		return result, nil, nil
	}
	base := map[string]json.RawMessage{}
	if len(operation.Base) > 0 {
		base, err = decodeOfflineV5Object(operation.Base, 256<<10)
		if err != nil {
			result.ErrorCode = "invalid_task_base"
			return result, nil, nil
		}
	}
	tasks := &TaskRepository{db: r.db}
	task, err := offlineV3LoadTaskTx(ctx, tx, tasks, record.AccountID, record.UserID, operation.ResourceID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) || errors.Is(err, ErrTaskWorkNotFound) {
			result.ErrorCode = "access_revoked"
			return result, nil, nil
		}
		return result, nil, err
	}
	if task.ListID == nil || *task.ListID != selection.ResourceID {
		result.ErrorCode = "outside_selection"
		return result, nil, nil
	}
	access, accessErr := resolveTaskAccessWith(ctx, tx, record.AccountID, record.UserID, task.ID)
	if accessErr != nil || !TaskAccessAllows(access.Access, domain.TaskAccessEdit) {
		result.ErrorCode = "access_revoked"
		return result, nil, nil
	}
	merged, conflict := offlineV5MergePatch(operation.BaseVersion, task.Version, base, local, offlineV5TaskCurrent(task))
	if conflict != nil {
		result.Status, result.ErrorCode, result.ServerVersion, result.Conflict = "conflict", "field_conflict", task.Version, conflict
		result.Result, _ = json.Marshal(map[string]any{"task": OfflineV3TaskProjection(task)})
		return result, nil, nil
	}
	if err := applyOfflineV5TaskPatch(task, local); err != nil {
		result.ErrorCode = "invalid_task_update"
		return result, nil, nil
	}
	if _, changesAssignee := local["assigned_to"]; changesAssignee {
		allowed, dependencyErr := offlineV5ManifestHasDependencyTx(ctx, tx, record, operation, "task_user", task.AssignedTo)
		if dependencyErr != nil {
			return result, nil, dependencyErr
		}
		if !allowed {
			result.ErrorCode = "outside_selection"
			return result, nil, nil
		}
	}
	task.MutationActor = &record.UserID
	task.MutationOperationID = &operation.OperationID
	task.CollaboratorsSet = false
	if err := tasks.UpdateTx(ctx, tx, task); err != nil {
		if errors.Is(err, ErrTaskVersionConflict) {
			result.Status, result.ErrorCode = "conflict", "version_conflict"
			return result, nil, nil
		}
		return result, nil, err
	}
	canonical, err := offlineV3LoadTaskTx(ctx, tx, tasks, record.AccountID, record.UserID, task.ID)
	if err != nil {
		return result, nil, err
	}
	result.Status = "applied"
	if merged {
		result.Status = "merged"
	}
	result.ServerVersion = canonical.Version
	result.Result, _ = json.Marshal(map[string]any{"task": OfflineV3TaskProjection(canonical)})
	return result, canonical, nil
}

func (r *OfflineV5Repository) applyTaskReopenTx(ctx context.Context, tx pgx.Tx, record *OfflineV5AuthRecord, operation domain.OfflineV5Operation, selection domain.OfflineV3Selection) (domain.OfflineV5OperationResult, *domain.Task, error) {
	result := domain.OfflineV5OperationResult{OperationID: operation.OperationID, ResourceID: operation.ResourceID, Status: "rejected"}
	if operation.BaseVersion < 1 || strings.TrimSpace(string(operation.Payload)) != "{}" {
		result.ErrorCode = "invalid_task_reopen"
		return result, nil, nil
	}
	tasks := &TaskRepository{db: r.db}
	task, err := offlineV3LoadTaskTx(ctx, tx, tasks, record.AccountID, record.UserID, operation.ResourceID)
	if err != nil {
		result.ErrorCode = "access_revoked"
		return result, nil, nil
	}
	if task.ListID == nil || *task.ListID != selection.ResourceID {
		result.ErrorCode = "outside_selection"
		return result, nil, nil
	}
	access, err := resolveTaskAccessWith(ctx, tx, record.AccountID, record.UserID, task.ID)
	if err != nil || !TaskAccessAllows(access.Access, domain.TaskAccessEdit) {
		result.ErrorCode = "access_revoked"
		return result, nil, nil
	}
	category := ""
	if task.StatusDetail != nil {
		category = task.StatusDetail.Category
	}
	if category != domain.TaskStatusCategoryDone && task.Status != domain.TaskStatusCompleted {
		result.Status = "noop"
		result.ServerVersion = task.Version
		result.Result, _ = json.Marshal(map[string]any{"task": OfflineV3TaskProjection(task)})
		return result, task, nil
	}
	if task.Version != operation.BaseVersion {
		result.Status, result.ErrorCode, result.ServerVersion = "conflict", "version_conflict", task.Version
		result.Result, _ = json.Marshal(map[string]any{"task": OfflineV3TaskProjection(task)})
		return result, nil, nil
	}
	statusID, err := offlineV3TaskStatusTx(ctx, tx, record.AccountID, selection.ResourceID, domain.TaskStatusCategoryNotStarted)
	if err != nil {
		return result, nil, err
	}
	task.StatusID, task.Status, task.CompletedAt, task.CompletedBy = &statusID, domain.TaskStatusPending, nil, nil
	if task.ProgressMode != "automatic" {
		task.Progress = task.ManualProgress
	}
	task.MutationActor, task.MutationOperationID, task.CollaboratorsSet = &record.UserID, &operation.OperationID, false
	if err := tasks.UpdateTx(ctx, tx, task); err != nil {
		return result, nil, err
	}
	canonical, err := offlineV3LoadTaskTx(ctx, tx, tasks, record.AccountID, record.UserID, task.ID)
	if err != nil {
		return result, nil, err
	}
	result.Status, result.ServerVersion = "applied", canonical.Version
	result.Result, _ = json.Marshal(map[string]any{"task": OfflineV3TaskProjection(canonical)})
	return result, canonical, nil
}

func (r *OfflineV5Repository) applyTaskCommentTx(ctx context.Context, tx pgx.Tx, record *OfflineV5AuthRecord, operation domain.OfflineV5Operation, selection domain.OfflineV3Selection) (domain.OfflineV5OperationResult, *domain.Task, error) {
	result := domain.OfflineV5OperationResult{OperationID: operation.OperationID, ResourceID: operation.ResourceID, Status: "rejected"}
	fields, err := decodeOfflineV5Object(operation.Payload, 256<<10)
	if err != nil || operation.BaseVersion != 0 || !offlineV5OnlyFields(fields, "task_id", "body") {
		result.ErrorCode = "invalid_task_comment"
		return result, nil, nil
	}
	taskID, err := offlineV5UUIDField(fields, "task_id")
	var body string
	if err != nil || json.Unmarshal(fields["body"], &body) != nil || operation.ResourceID == uuid.Nil {
		result.ErrorCode = "invalid_task_comment"
		return result, nil, nil
	}
	body = strings.TrimSpace(body)
	if body == "" || utf8.RuneCountInString(body) > 200000 {
		result.ErrorCode = "invalid_task_comment"
		return result, nil, nil
	}
	var listID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT task.list_id FROM tasks task JOIN task_lists list_item
		ON list_item.account_id=task.account_id AND list_item.id=task.list_id
		WHERE task.account_id=$1 AND task.id=$2 AND task.deleted_at IS NULL FOR UPDATE OF task`, record.AccountID, taskID).Scan(&listID); errors.Is(err, pgx.ErrNoRows) {
		result.ErrorCode = "access_revoked"
		return result, nil, nil
	} else if err != nil {
		return result, nil, err
	}
	if listID != selection.ResourceID {
		result.ErrorCode = "outside_selection"
		return result, nil, nil
	}
	access, err := resolveTaskAccessWith(ctx, tx, record.AccountID, record.UserID, taskID)
	if err != nil || !TaskAccessAllows(access.Access, domain.TaskAccessComment) {
		result.ErrorCode = "access_revoked"
		return result, nil, nil
	}
	var createdAt, updatedAt time.Time
	if err := tx.QueryRow(ctx, `INSERT INTO task_comments(id,account_id,task_id,author_id,body,created_at,updated_at)
		VALUES($1,$2,$3,$4,$5,NOW(),NOW()) RETURNING created_at,updated_at`, operation.ResourceID, record.AccountID,
		taskID, record.UserID, body).Scan(&createdAt, &updatedAt); err != nil {
		return result, nil, err
	}
	metadata, _ := json.Marshal(map[string]any{"comment_id": operation.ResourceID, "operation_id": operation.OperationID, "origin": "offline_v5"})
	if _, err := tx.Exec(ctx, `INSERT INTO task_activity(account_id,task_id,actor_id,action,metadata)
		VALUES($1,$2,$3,'commented',$4::jsonb)`, record.AccountID, taskID, record.UserID, metadata); err != nil {
		return result, nil, err
	}
	task, err := offlineV3LoadTaskTx(ctx, tx, &TaskRepository{db: r.db}, record.AccountID, record.UserID, taskID)
	if err != nil {
		return result, nil, err
	}
	result.Status, result.ServerVersion = "applied", updatedAt.UnixMicro()
	result.Result, _ = json.Marshal(map[string]any{"comment": map[string]any{"id": operation.ResourceID, "task_id": taskID,
		"author_id": record.UserID, "author_name": record.Username, "body": body, "created_at": createdAt,
		"updated_at": updatedAt, "mentions": []any{}, "attachments": []any{}, "can_edit": true, "can_delete": true}})
	return result, task, nil
}

func offlineV5ContactCurrent(contact *domain.Contact) map[string]json.RawMessage {
	values := map[string]any{"name": contact.Name, "custom_name": contact.CustomName, "last_name": contact.LastName,
		"short_name": contact.ShortName, "phone": contact.Phone, "email": contact.Email, "company": contact.Company,
		"age": contact.Age, "dni": contact.DNI, "birth_date": contact.BirthDate, "address": contact.Address,
		"distrito": contact.Distrito, "ocupacion": contact.Ocupacion, "notes": contact.Notes}
	out := make(map[string]json.RawMessage, len(values))
	for name, value := range values {
		out[name], _ = json.Marshal(value)
	}
	return out
}

func offlineV5DecodeNullable[T any](raw json.RawMessage) (*T, error) {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, nil
	}
	var value T
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, ErrOfflineV3Invalid
	}
	return &value, nil
}

func offlineV5ContactPatch(fields map[string]json.RawMessage) (ContactProfilePatch, error) {
	patch := ContactProfilePatch{}
	decodeString := func(raw json.RawMessage, maximum int) (*string, error) {
		value, err := offlineV5DecodeNullable[string](raw)
		if err != nil {
			return nil, err
		}
		if value != nil {
			trimmed := strings.TrimSpace(*value)
			if utf8.RuneCountInString(trimmed) > maximum {
				return nil, ErrOfflineV3Invalid
			}
			if trimmed == "" {
				return nil, nil
			}
			value = &trimmed
		}
		return value, nil
	}
	for name, raw := range fields {
		var err error
		switch name {
		case "name":
			patch.NameSet = true
			patch.Name, err = decodeString(raw, 255)
		case "custom_name":
			patch.CustomNameSet = true
			patch.CustomName, err = decodeString(raw, 255)
		case "last_name":
			patch.LastNameSet = true
			patch.LastName, err = decodeString(raw, 255)
		case "short_name":
			patch.ShortNameSet = true
			patch.ShortName, err = decodeString(raw, 100)
		case "phone":
			patch.PhoneSet = true
			patch.Phone, err = decodeString(raw, 50)
		case "email":
			patch.EmailSet = true
			patch.Email, err = decodeString(raw, 255)
		case "company":
			patch.CompanySet = true
			patch.Company, err = decodeString(raw, 255)
		case "age":
			patch.AgeSet = true
			patch.Age, err = offlineV5DecodeNullable[int](raw)
			if err == nil && patch.Age != nil && (*patch.Age < 1 || *patch.Age > 150) {
				err = ErrOfflineV3Invalid
			}
		case "dni":
			patch.DNISet = true
			patch.DNI, err = decodeString(raw, 50)
		case "birth_date":
			patch.BirthDateSet = true
			var encoded *string
			encoded, err = offlineV5DecodeNullable[string](raw)
			if err == nil && encoded != nil {
				var parsed time.Time
				parsed, err = time.Parse("2006-01-02", *encoded)
				if err == nil {
					patch.BirthDate = &parsed
				}
			}
		case "address":
			patch.AddressSet = true
			patch.Address, err = decodeString(raw, 2000)
		case "distrito":
			patch.DistritoSet = true
			patch.Distrito, err = decodeString(raw, 255)
		case "ocupacion":
			patch.OcupacionSet = true
			patch.Ocupacion, err = decodeString(raw, 255)
		case "notes":
			patch.NotesSet = true
			patch.Notes, err = decodeString(raw, 10000)
		case "tag_ids":
			var values []string
			if json.Unmarshal(raw, &values) != nil || len(values) > 200 {
				err = ErrOfflineV3Invalid
				break
			}
			patch.TagIDsSet = true
			seen := make(map[uuid.UUID]struct{}, len(values))
			for _, value := range values {
				id, parseErr := uuid.Parse(strings.TrimSpace(value))
				if parseErr != nil || id == uuid.Nil {
					err = ErrOfflineV3Invalid
					break
				}
				if _, duplicate := seen[id]; !duplicate {
					seen[id] = struct{}{}
					patch.TagIDs = append(patch.TagIDs, id)
				}
			}
		case "extra_phones":
			var values []struct {
				ID    *string `json:"id"`
				Phone string  `json:"phone"`
				Label *string `json:"label"`
			}
			if json.Unmarshal(raw, &values) != nil || len(values) > 50 {
				err = ErrOfflineV3Invalid
				break
			}
			patch.ExtraPhonesSet = true
			for _, value := range values {
				item := ContactProfileExtraPhonePatch{Phone: strings.TrimSpace(value.Phone)}
				if item.Phone == "" || utf8.RuneCountInString(item.Phone) > 50 {
					err = ErrOfflineV3Invalid
					break
				}
				if value.ID != nil {
					id, parseErr := uuid.Parse(strings.TrimSpace(*value.ID))
					if parseErr != nil || id == uuid.Nil {
						err = ErrOfflineV3Invalid
						break
					}
					item.ID = &id
				}
				if value.Label != nil {
					item.Label = strings.TrimSpace(*value.Label)
				}
				patch.ExtraPhones = append(patch.ExtraPhones, item)
			}
		case "custom_field_values":
			var values []struct {
				FieldID     string          `json:"field_id"`
				ValueText   *string         `json:"value_text"`
				ValueNumber *float64        `json:"value_number"`
				ValueDate   *string         `json:"value_date"`
				ValueBool   *bool           `json:"value_bool"`
				ValueJSON   json.RawMessage `json:"value_json"`
			}
			if json.Unmarshal(raw, &values) != nil || len(values) > 200 {
				err = ErrOfflineV3Invalid
				break
			}
			patch.CustomFieldValuesSet = true
			for _, value := range values {
				fieldID, parseErr := uuid.Parse(strings.TrimSpace(value.FieldID))
				if parseErr != nil || fieldID == uuid.Nil {
					err = ErrOfflineV3Invalid
					break
				}
				item := ContactProfileCustomFieldPatch{FieldID: fieldID, ValueText: value.ValueText,
					ValueNumber: value.ValueNumber, ValueBool: value.ValueBool}
				if value.ValueDate != nil {
					parsed, parseErr := time.Parse("2006-01-02", strings.TrimSpace(*value.ValueDate))
					if parseErr != nil {
						err = ErrOfflineV3Invalid
						break
					}
					item.ValueDate = &parsed
				}
				if len(value.ValueJSON) > 0 && !bytes.Equal(bytes.TrimSpace(value.ValueJSON), []byte("null")) {
					if !json.Valid(value.ValueJSON) {
						err = ErrOfflineV3Invalid
						break
					}
					item.ValueJSON = append(json.RawMessage(nil), value.ValueJSON...)
				}
				patch.CustomFieldValues = append(patch.CustomFieldValues, item)
			}
		default:
			return patch, ErrOfflineV3Invalid
		}
		if err != nil {
			return patch, ErrOfflineV3Invalid
		}
	}
	return patch, nil
}

func (r *OfflineV5Repository) applyContactObservationCreateTx(ctx context.Context, tx pgx.Tx, record *OfflineV5AuthRecord, operation domain.OfflineV5Operation, fields map[string]json.RawMessage) (domain.OfflineV5OperationResult, error) {
	result := domain.OfflineV5OperationResult{OperationID: operation.OperationID, ResourceID: operation.ResourceID, Status: "rejected"}
	for name := range fields {
		if name != "_op" && name != "observation_id" && name != "notes" {
			result.ErrorCode = "invalid_contact_observation"
			return result, nil
		}
	}
	var observationID uuid.UUID
	var notes string
	if json.Unmarshal(fields["observation_id"], &observationID) != nil || observationID == uuid.Nil ||
		json.Unmarshal(fields["notes"], &notes) != nil {
		result.ErrorCode = "invalid_contact_observation"
		return result, nil
	}
	notes = strings.TrimSpace(notes)
	if notes == "" || utf8.RuneCountInString(notes) > 10000 {
		result.ErrorCode = "invalid_contact_observation"
		return result, nil
	}
	var interaction domain.Interaction
	interaction.ID = observationID
	err := tx.QueryRow(ctx, `WITH inserted AS (
		INSERT INTO interactions(id,account_id,contact_id,source_label,type,notes,created_by,created_at,updated_at)
		SELECT $1,contact.account_id,contact.id,'Contacto','note',$4,$3,NOW(),NOW()
		FROM contacts contact WHERE contact.account_id=$2 AND contact.id=$5 AND contact.is_group=FALSE
		RETURNING id,account_id,contact_id,source_label,type,notes,created_by,created_at,updated_at,is_pinned
	) SELECT inserted.id,inserted.account_id,inserted.contact_id,inserted.source_label,inserted.type,inserted.notes,
		inserted.created_by,inserted.created_at,inserted.updated_at,inserted.is_pinned FROM inserted`, observationID,
		record.AccountID, record.UserID, notes, operation.ResourceID).Scan(&interaction.ID, &interaction.AccountID,
		&interaction.ContactID, &interaction.SourceLabel, &interaction.Type, &interaction.Notes, &interaction.CreatedBy,
		&interaction.CreatedAt, &interaction.UpdatedAt, &interaction.IsPinned)
	if errors.Is(err, pgx.ErrNoRows) {
		result.ErrorCode = "access_revoked"
		return result, nil
	}
	if err != nil {
		return result, err
	}
	interaction.CanEdit, interaction.CanPin, interaction.CanDelete = true, true, true
	result.Status, result.ServerVersion = "applied", interaction.UpdatedAt.UnixMicro()
	result.Result, _ = json.Marshal(map[string]any{"observation": interaction})
	return result, nil
}

func (r *OfflineV5Repository) applyContactObservationOperationTx(ctx context.Context, tx pgx.Tx, record *OfflineV5AuthRecord, operation domain.OfflineV5Operation, selection domain.OfflineV3Selection) (domain.OfflineV5OperationResult, error) {
	result := domain.OfflineV5OperationResult{OperationID: operation.OperationID, ResourceID: operation.ResourceID, Status: "rejected"}
	if operation.ResourceID != selection.ResourceID || operation.BaseVersion < 0 {
		result.ErrorCode = "outside_selection"
		return result, nil
	}
	fields, err := decodeOfflineV5Object(operation.Payload, 32<<10)
	if err != nil {
		result.ErrorCode = "invalid_contact_observation"
		return result, nil
	}
	return r.applyContactObservationCreateTx(ctx, tx, record, operation, fields)
}

func (r *OfflineV5Repository) applyContactUpdateTx(ctx context.Context, tx pgx.Tx, record *OfflineV5AuthRecord, operation domain.OfflineV5Operation, selection domain.OfflineV3Selection) (domain.OfflineV5OperationResult, error) {
	result := domain.OfflineV5OperationResult{OperationID: operation.OperationID, ResourceID: operation.ResourceID, Status: "rejected"}
	if operation.ResourceID != selection.ResourceID || operation.BaseVersion < 0 {
		result.ErrorCode = "outside_selection"
		return result, nil
	}
	local, err := decodeOfflineV5Object(operation.Payload, 256<<10)
	if err != nil || len(local) == 0 {
		result.ErrorCode = "invalid_contact_update"
		return result, nil
	}
	if rawKind, ok := local["_op"]; ok {
		var kind string
		if json.Unmarshal(rawKind, &kind) != nil || kind != "observation.create" {
			result.ErrorCode = "invalid_contact_update"
			return result, nil
		}
		return r.applyContactObservationCreateTx(ctx, tx, record, operation, local)
	}
	if operation.BaseVersion < 1 {
		result.ErrorCode = "invalid_contact_update"
		return result, nil
	}
	base := map[string]json.RawMessage{}
	if len(operation.Base) > 0 {
		base, err = decodeOfflineV5Object(operation.Base, 256<<10)
		if err != nil {
			result.ErrorCode = "invalid_contact_base"
			return result, nil
		}
	}
	profile := NewContactProfileRepository(r.db)
	contact, err := scanContactProfile(tx.QueryRow(ctx, contactProfileSelect+` FOR UPDATE`, record.AccountID, operation.ResourceID))
	if err != nil {
		if errors.Is(err, ErrContactProfileNotFound) {
			result.ErrorCode = "access_revoked"
			return result, nil
		}
		return result, err
	}
	currentVersion := contact.UpdatedAt.UnixMicro()
	merged, conflict := offlineV5MergePatch(operation.BaseVersion, currentVersion, base, local, offlineV5ContactCurrent(contact))
	if conflict != nil {
		result.Status, result.ErrorCode, result.ServerVersion, result.Conflict = "conflict", "field_conflict", currentVersion, conflict
		result.Result, _ = json.Marshal(map[string]any{"contact": contact})
		return result, nil
	}
	patch, err := offlineV5ContactPatch(local)
	if err != nil {
		result.ErrorCode = "invalid_contact_update"
		return result, nil
	}
	if patch.TagIDsSet {
		for _, id := range patch.TagIDs {
			allowed, dependencyErr := offlineV5ManifestHasDependencyTx(ctx, tx, record, operation, "contact_tag", id)
			if dependencyErr != nil {
				return result, dependencyErr
			}
			if !allowed {
				result.ErrorCode = "outside_selection"
				return result, nil
			}
		}
	}
	if patch.CustomFieldValuesSet {
		for _, item := range patch.CustomFieldValues {
			allowed, dependencyErr := offlineV5ManifestHasDependencyTx(ctx, tx, record, operation, "custom_field", item.FieldID)
			if dependencyErr != nil {
				return result, dependencyErr
			}
			if !allowed {
				result.ErrorCode = "outside_selection"
				return result, nil
			}
		}
	}
	contact, err = profile.UpdateTx(ctx, tx, record.AccountID, operation.ResourceID, patch)
	if err != nil {
		if errors.Is(err, ErrContactIdentityConflict) || errors.Is(err, ErrContactProfileCollectionInvalid) {
			result.ErrorCode = "contact_identity_conflict"
			return result, nil
		}
		return result, err
	}
	result.Status = "applied"
	if merged {
		result.Status = "merged"
	}
	result.ServerVersion = contact.UpdatedAt.UnixMicro()
	result.Result, _ = json.Marshal(map[string]any{"contact": contact})
	return result, nil
}

func offlineV5ProgramCurrent(program *domain.Program) map[string]json.RawMessage {
	values := map[string]any{"name": program.Name, "description": program.Description, "status": program.Status,
		"color": program.Color, "schedule_start_date": program.ScheduleStartDate, "schedule_end_date": program.ScheduleEndDate,
		"schedule_days": program.ScheduleDays, "schedule_start_time": program.ScheduleStartTime,
		"schedule_end_time": program.ScheduleEndTime, "health_view_columns": program.HealthViewColumns}
	out := make(map[string]json.RawMessage, len(values))
	for name, value := range values {
		out[name], _ = json.Marshal(value)
	}
	return out
}

func offlineV5Date(raw json.RawMessage) (*time.Time, error) {
	value, err := offlineV5DecodeNullable[string](raw)
	if err != nil || value == nil {
		return nil, err
	}
	parsed, err := time.Parse("2006-01-02", strings.TrimSpace(*value))
	if err != nil {
		return nil, ErrOfflineV3Invalid
	}
	return &parsed, nil
}

func offlineV5Clock(raw json.RawMessage) (*string, error) {
	value, err := offlineV5DecodeNullable[string](raw)
	if err != nil || value == nil {
		return nil, err
	}
	trimmed := strings.TrimSpace(*value)
	if _, err := time.Parse("15:04", trimmed); err != nil {
		return nil, ErrOfflineV3Invalid
	}
	return &trimmed, nil
}

func loadOfflineV5ProgramTx(ctx context.Context, tx pgx.Tx, accountID, programID uuid.UUID) (*domain.Program, error) {
	program := &domain.Program{}
	err := tx.QueryRow(ctx, `SELECT id,account_id,folder_id,type,name,description,status,color,created_by,created_at,updated_at,
		health_view_columns,schedule_start_date,schedule_end_date,schedule_days,schedule_start_time,schedule_end_time,
		pipeline_id,COALESCE(tag_formula,''),COALESCE(tag_formula_mode,''),COALESCE(tag_formula_type,''),event_date,event_end,location
		FROM programs WHERE account_id=$1 AND id=$2 AND COALESCE(type,'course')='course' FOR UPDATE`, accountID, programID).
		Scan(&program.ID, &program.AccountID, &program.FolderID, &program.Type, &program.Name, &program.Description, &program.Status,
			&program.Color, &program.CreatedBy, &program.CreatedAt, &program.UpdatedAt, &program.HealthViewColumns,
			&program.ScheduleStartDate, &program.ScheduleEndDate, &program.ScheduleDays, &program.ScheduleStartTime,
			&program.ScheduleEndTime, &program.PipelineID, &program.TagFormula, &program.TagFormulaMode, &program.TagFormulaType,
			&program.EventDate, &program.EventEnd, &program.Location)
	return program, err
}

func offlineV5UUIDField(fields map[string]json.RawMessage, name string) (uuid.UUID, error) {
	var id uuid.UUID
	if json.Unmarshal(fields[name], &id) != nil || id == uuid.Nil {
		return uuid.Nil, ErrOfflineV3Invalid
	}
	return id, nil
}

func offlineV5OnlyFields(fields map[string]json.RawMessage, allowed ...string) bool {
	set := make(map[string]struct{}, len(allowed))
	for _, name := range allowed {
		set[name] = struct{}{}
	}
	for name := range fields {
		if _, ok := set[name]; !ok {
			return false
		}
	}
	return true
}

func offlineV5ManifestHasDependencyTx(ctx context.Context, tx pgx.Tx, record *OfflineV5AuthRecord, operation domain.OfflineV5Operation, resourceType string, resourceID uuid.UUID) (bool, error) {
	if record == nil || resourceID == uuid.Nil {
		return false, nil
	}
	var allowed bool
	err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM offline_v5_manifest_dependencies dependency
		WHERE dependency.manifest_id=$1 AND dependency.grant_id=$2 AND dependency.account_id=$3
		AND dependency.root_selection_id=$4 AND dependency.resource_type=$5 AND dependency.resource_id=$6)`,
		operation.ManifestID, record.GrantID, record.AccountID, operation.SelectionID, resourceType, resourceID.String()).Scan(&allowed)
	return allowed, err
}

func (r *OfflineV5Repository) applyProgramParticipantAddTx(ctx context.Context, tx pgx.Tx, record *OfflineV5AuthRecord, operation domain.OfflineV5Operation, selection domain.OfflineV3Selection) (domain.OfflineV5OperationResult, error) {
	result := domain.OfflineV5OperationResult{OperationID: operation.OperationID, ResourceID: operation.ResourceID, Status: "rejected"}
	fields, err := decodeOfflineV5Object(operation.Payload, 16<<10)
	if err != nil || !offlineV5OnlyFields(fields, "program_id", "contact_id") || operation.BaseVersion != 0 {
		result.ErrorCode = "invalid_program_participant"
		return result, nil
	}
	programID, err := offlineV5UUIDField(fields, "program_id")
	if err != nil || programID != selection.ResourceID || operation.ResourceID == uuid.Nil {
		result.ErrorCode = "outside_selection"
		return result, nil
	}
	contactID, err := offlineV5UUIDField(fields, "contact_id")
	if err != nil {
		result.ErrorCode = "invalid_program_participant"
		return result, nil
	}
	var contactSelected bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM offline_v5_manifest_roots root
		WHERE root.manifest_id=$1 AND root.grant_id=$2 AND root.account_id=$3 AND root.module=$4
		AND root.resource_type=$5 AND root.resource_id=$6)`, operation.ManifestID, record.GrantID, record.AccountID,
		domain.OfflineModuleContacts, domain.OfflineResourceContact, contactID).Scan(&contactSelected); err != nil {
		return result, err
	}
	if !contactSelected {
		result.ErrorCode = "outside_selection"
		return result, nil
	}
	participant := domain.ProgramParticipant{ID: operation.ResourceID, ProgramID: programID, ContactID: contactID, Status: "active"}
	err = tx.QueryRow(ctx, `INSERT INTO program_participants(id,program_id,contact_id,status)
		SELECT $1,program.id,contact.id,'active' FROM programs program
		JOIN contacts contact ON contact.account_id=program.account_id AND contact.id=$4 AND contact.is_group=FALSE
		WHERE program.account_id=$2 AND program.id=$3 AND program.status='active' AND COALESCE(program.type,'course')='course'
		ON CONFLICT(program_id,contact_id) DO NOTHING RETURNING enrolled_at`, participant.ID, record.AccountID, programID, contactID).
		Scan(&participant.EnrolledAt)
	if errors.Is(err, pgx.ErrNoRows) {
		var existing domain.ProgramParticipant
		err = tx.QueryRow(ctx, `SELECT participant.id,participant.program_id,participant.contact_id,participant.status,participant.enrolled_at,
			participant.dropped_at,participant.completed_at FROM program_participants participant
			JOIN programs program ON program.id=participant.program_id AND program.account_id=$1
			WHERE participant.program_id=$2 AND participant.contact_id=$3`, record.AccountID, programID, contactID).
			Scan(&existing.ID, &existing.ProgramID, &existing.ContactID, &existing.Status, &existing.EnrolledAt, &existing.DroppedAt, &existing.CompletedAt)
		if err == nil && existing.ID == operation.ResourceID {
			result.Status, result.ServerVersion = "noop", existing.EnrolledAt.UnixMicro()
			result.Result, _ = json.Marshal(map[string]any{"participant": existing})
			return result, nil
		}
		result.ErrorCode = "participant_already_exists"
		return result, nil
	}
	if err != nil {
		return result, err
	}
	result.Status, result.ServerVersion = "applied", participant.EnrolledAt.UnixMicro()
	result.Result, _ = json.Marshal(map[string]any{"participant": participant})
	return result, nil
}

func (r *OfflineV5Repository) applyProgramParticipantLifecycleTx(ctx context.Context, tx pgx.Tx, record *OfflineV5AuthRecord, operation domain.OfflineV5Operation, selection domain.OfflineV3Selection) (domain.OfflineV5OperationResult, error) {
	result := domain.OfflineV5OperationResult{OperationID: operation.OperationID, ResourceID: operation.ResourceID, Status: "rejected"}
	fields, err := decodeOfflineV5Object(operation.Payload, 32<<10)
	if err != nil || !offlineV5OnlyFields(fields, "program_id", "mode", "enrolled_at", "status", "ended_on", "drop_reason", "drop_notes", "transferred_to_level") {
		result.ErrorCode = "invalid_program_participant"
		return result, nil
	}
	programID, err := offlineV5UUIDField(fields, "program_id")
	if err != nil || programID != selection.ResourceID {
		result.ErrorCode = "outside_selection"
		return result, nil
	}
	var mode string
	if json.Unmarshal(fields["mode"], &mode) != nil {
		result.ErrorCode = "invalid_program_participant"
		return result, nil
	}
	var enrolledAt time.Time
	var status string
	var droppedAt, completedAt *time.Time
	err = tx.QueryRow(ctx, `SELECT participant.enrolled_at,participant.status,participant.dropped_at,participant.completed_at
		FROM program_participants participant JOIN programs program ON program.id=participant.program_id AND program.account_id=$1
		WHERE participant.program_id=$2 AND participant.id=$3 FOR UPDATE OF participant`, record.AccountID, programID, operation.ResourceID).
		Scan(&enrolledAt, &status, &droppedAt, &completedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		result.ErrorCode = "access_revoked"
		return result, nil
	}
	if err != nil {
		return result, err
	}
	currentVersion := enrolledAt.UnixMicro()
	if droppedAt != nil {
		currentVersion = droppedAt.UnixMicro()
	} else if completedAt != nil {
		currentVersion = completedAt.UnixMicro()
	}
	if operation.BaseVersion != currentVersion {
		result.Status, result.ErrorCode, result.ServerVersion = "conflict", "version_conflict", currentVersion
		return result, nil
	}
	switch mode {
	case "enrollment_date":
		newDate, parseErr := offlineV5Date(fields["enrolled_at"])
		if parseErr != nil || newDate == nil || newDate.After(time.Now().UTC()) ||
			(droppedAt != nil && newDate.After(*droppedAt)) || (completedAt != nil && newDate.After(*completedAt)) {
			result.ErrorCode = "invalid_enrollment_date"
			return result, nil
		}
		err = tx.QueryRow(ctx, `UPDATE program_participants participant SET enrolled_at=$1::date FROM programs program
			WHERE program.account_id=$2 AND program.id=$3 AND participant.program_id=program.id AND participant.id=$4 RETURNING participant.enrolled_at`,
			*newDate, record.AccountID, programID, operation.ResourceID).Scan(&enrolledAt)
		result.ServerVersion = enrolledAt.UnixMicro()
	case "outcome":
		if status != "active" {
			result.ErrorCode = "participant_already_ended"
			return result, nil
		}
		var nextStatus, endedEncoded, dropReason, dropNotes, transferred string
		if json.Unmarshal(fields["status"], &nextStatus) != nil || (nextStatus != "dropped" && nextStatus != "completed") ||
			json.Unmarshal(fields["ended_on"], &endedEncoded) != nil {
			result.ErrorCode = "invalid_participant_outcome"
			return result, nil
		}
		ended, parseErr := time.Parse("2006-01-02", strings.TrimSpace(endedEncoded))
		if parseErr != nil || ended.Before(time.Date(enrolledAt.Year(), enrolledAt.Month(), enrolledAt.Day(), 0, 0, 0, 0, time.UTC)) || ended.After(time.Now().UTC()) {
			result.ErrorCode = "invalid_participant_outcome"
			return result, nil
		}
		_ = json.Unmarshal(fields["drop_reason"], &dropReason)
		_ = json.Unmarshal(fields["drop_notes"], &dropNotes)
		_ = json.Unmarshal(fields["transferred_to_level"], &transferred)
		if utf8.RuneCountInString(dropReason) > 255 || utf8.RuneCountInString(dropNotes) > 10000 || utf8.RuneCountInString(transferred) > 255 {
			result.ErrorCode = "invalid_participant_outcome"
			return result, nil
		}
		err = tx.QueryRow(ctx, `UPDATE program_participants participant SET status=$1,
			dropped_at=CASE WHEN $1='dropped' THEN $2::date ELSE NULL END,completed_at=CASE WHEN $1='completed' THEN $2::date ELSE NULL END,
			drop_reason=$3,drop_notes=$4,transferred_to_level=$5 FROM programs program
			WHERE program.account_id=$6 AND program.id=$7 AND participant.program_id=program.id AND participant.id=$8
			RETURNING COALESCE(participant.dropped_at,participant.completed_at)`, nextStatus, ended, dropReason, dropNotes, transferred,
			record.AccountID, programID, operation.ResourceID).Scan(&ended)
		result.ServerVersion = ended.UnixMicro()
	default:
		result.ErrorCode = "invalid_program_participant"
		return result, nil
	}
	if err != nil {
		return result, err
	}
	result.Status = "applied"
	result.Result, _ = json.Marshal(map[string]any{"participant_id": operation.ResourceID, "server_version": result.ServerVersion})
	return result, nil
}

func (r *OfflineV5Repository) applyProgramSessionUpsertTx(ctx context.Context, tx pgx.Tx, record *OfflineV5AuthRecord, operation domain.OfflineV5Operation, selection domain.OfflineV3Selection) (domain.OfflineV5OperationResult, error) {
	result := domain.OfflineV5OperationResult{OperationID: operation.OperationID, ResourceID: operation.ResourceID, Status: "rejected"}
	fields, err := decodeOfflineV5Object(operation.Payload, 64<<10)
	if err != nil || !offlineV5OnlyFields(fields, "program_id", "date", "title", "topic", "topics", "session_type", "start_time", "end_time", "location") {
		result.ErrorCode = "invalid_program_session"
		return result, nil
	}
	programID, err := offlineV5UUIDField(fields, "program_id")
	if err != nil || programID != selection.ResourceID {
		result.ErrorCode = "outside_selection"
		return result, nil
	}
	var dateEncoded, title, sessionType string
	var legacyTopic, startTime, endTime, location *string
	if json.Unmarshal(fields["date"], &dateEncoded) != nil || json.Unmarshal(fields["title"], &title) != nil ||
		json.Unmarshal(fields["session_type"], &sessionType) != nil {
		result.ErrorCode = "invalid_program_session"
		return result, nil
	}
	date, err := time.Parse("2006-01-02", strings.TrimSpace(dateEncoded))
	title = strings.TrimSpace(title)
	if err != nil || title == "" || utf8.RuneCountInString(title) > 255 || (sessionType != "regular" && sessionType != "recovery") {
		result.ErrorCode = "invalid_program_session"
		return result, nil
	}
	for name, target := range map[string]**string{"topic": &legacyTopic, "start_time": &startTime, "end_time": &endTime, "location": &location} {
		if raw, ok := fields[name]; ok {
			*target, err = offlineV5DecodeNullable[string](raw)
			if err != nil {
				result.ErrorCode = "invalid_program_session"
				return result, nil
			}
		}
	}
	if startTime != nil {
		value := strings.TrimSpace(*startTime)
		startTime = &value
	}
	if endTime != nil {
		value := strings.TrimSpace(*endTime)
		endTime = &value
	}
	if location != nil {
		value := strings.TrimSpace(*location)
		if value == "" {
			location = nil
		} else {
			location = &value
		}
	}
	if (startTime != nil && !offlineV5ClockString(*startTime)) || (endTime != nil && !offlineV5ClockString(*endTime)) ||
		(location != nil && utf8.RuneCountInString(*location) > 500) {
		result.ErrorCode = "invalid_program_session"
		return result, nil
	}
	if startTime != nil && endTime != nil {
		start, _ := time.Parse("15:04", *startTime)
		end, _ := time.Parse("15:04", *endTime)
		if !end.After(start) {
			result.ErrorCode = "invalid_program_session"
			return result, nil
		}
	}
	requestedTopics := make([]*domain.ProgramSessionTopic, 0)
	if raw, exists := fields["topics"]; exists {
		var wire []struct {
			Kind          string     `json:"kind"`
			CourseTopicID *uuid.UUID `json:"course_topic_id"`
			Title         string     `json:"title"`
		}
		if json.Unmarshal(raw, &wire) != nil || len(wire) < 1 || len(wire) > 50 {
			result.ErrorCode = "invalid_program_session"
			return result, nil
		}
		for position, item := range wire {
			item.Kind, item.Title = strings.TrimSpace(item.Kind), strings.TrimSpace(item.Title)
			if (item.Kind != "course" && item.Kind != "free") || item.Title == "" || utf8.RuneCountInString(item.Title) > 255 ||
				(item.Kind == "course" && (item.CourseTopicID == nil || *item.CourseTopicID == uuid.Nil)) ||
				(item.Kind == "free" && item.CourseTopicID != nil) {
				result.ErrorCode = "invalid_program_session"
				return result, nil
			}
			requestedTopics = append(requestedTopics, &domain.ProgramSessionTopic{Kind: item.Kind, CourseTopicID: item.CourseTopicID,
				TopicTitleSnapshot: item.Title, Position: position})
		}
	} else if legacyTopic != nil {
		value := strings.TrimSpace(*legacyTopic)
		if value == "" || utf8.RuneCountInString(value) > 255 {
			result.ErrorCode = "invalid_program_session"
			return result, nil
		}
		requestedTopics = append(requestedTopics, &domain.ProgramSessionTopic{Kind: "free", TopicTitleSnapshot: value})
	} else {
		result.ErrorCode = "invalid_program_session"
		return result, nil
	}
	session := &domain.ProgramSession{ID: operation.ResourceID, ProgramID: programID, Date: date, Title: title,
		TitleProvided: true, Topics: requestedTopics, SessionType: sessionType, StartTime: startTime, EndTime: endTime, Location: location}
	var createdAt, updatedAt time.Time
	if operation.BaseVersion == 0 {
		var programType string
		err = tx.QueryRow(ctx, `SELECT COALESCE(program.type,'course') FROM programs program
			WHERE program.account_id=$1 AND program.id=$2 AND program.status='active' FOR SHARE`, record.AccountID, programID).Scan(&programType)
		if err == nil && programType != "course" {
			result.ErrorCode = "access_revoked"
			return result, nil
		}
		if err == nil {
			session.Topics, err = resolveSessionTopics(ctx, tx, record.AccountID, programID, session.Topics, nil)
			applyLegacySessionTopic(session)
		}
		if err == nil {
			err = tx.QueryRow(ctx, `INSERT INTO program_sessions(id,account_id,program_id,date,title,topic,course_topic_id,session_type,start_time,end_time,location)
				VALUES($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$10,$11) RETURNING created_at,updated_at`, operation.ResourceID,
				record.AccountID, programID, date, title, session.Topic, session.CourseTopicID, sessionType, startTime, endTime, location).
				Scan(&createdAt, &updatedAt)
		}
	} else {
		var current time.Time
		err = tx.QueryRow(ctx, `SELECT session.updated_at FROM program_sessions session JOIN programs program
			ON program.id=session.program_id AND program.account_id=session.account_id
			WHERE program.account_id=$1 AND program.id=$2 AND session.id=$3 FOR UPDATE OF session`, record.AccountID, programID, operation.ResourceID).Scan(&current)
		if err == nil && current.UnixMicro() != operation.BaseVersion {
			result.Status, result.ErrorCode, result.ServerVersion = "conflict", "version_conflict", current.UnixMicro()
			return result, nil
		}
		if err == nil {
			var existing map[uuid.UUID]*domain.ProgramSessionTopic
			existing, err = loadSessionTopicsForUpdate(ctx, tx, record.AccountID, operation.ResourceID)
			if err == nil {
				session.Topics, err = resolveSessionTopics(ctx, tx, record.AccountID, programID, session.Topics, existing)
				applyLegacySessionTopic(session)
			}
		}
		if err == nil {
			err = tx.QueryRow(ctx, `UPDATE program_sessions SET date=$1::date,title=$2,topic=$3,course_topic_id=$4,session_type=$5,start_time=$6,end_time=$7,location=$8,updated_at=NOW()
				WHERE account_id=$9 AND program_id=$10 AND id=$11 RETURNING created_at,updated_at`, date, title, session.Topic,
				session.CourseTopicID, sessionType, startTime, endTime, location, record.AccountID, programID, operation.ResourceID).Scan(&createdAt, &updatedAt)
		}
	}
	if errors.Is(err, ErrInvalidSessionTopic) {
		result.ErrorCode = "invalid_program_session"
		return result, nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		result.ErrorCode = "access_revoked"
		return result, nil
	}
	if err != nil {
		return result, err
	}
	if err := replaceSessionTopics(ctx, tx, record.AccountID, operation.ResourceID, session.Topics); err != nil {
		if errors.Is(err, ErrInvalidSessionTopic) {
			result.ErrorCode = "invalid_program_session"
			return result, nil
		}
		return result, err
	}
	session.CreatedAt, session.UpdatedAt = createdAt, updatedAt
	result.Status, result.ServerVersion = "applied", updatedAt.UnixMicro()
	result.Result, _ = json.Marshal(map[string]any{"session": session})
	return result, nil
}

func offlineV5ClockString(value string) bool {
	_, err := time.Parse("15:04", strings.TrimSpace(value))
	return err == nil
}

func (r *OfflineV5Repository) applyProgramAttendanceTx(ctx context.Context, tx pgx.Tx, record *OfflineV5AuthRecord, operation domain.OfflineV5Operation, selection domain.OfflineV3Selection) (domain.OfflineV5OperationResult, error) {
	result := domain.OfflineV5OperationResult{OperationID: operation.OperationID, ResourceID: operation.ResourceID, Status: "rejected"}
	fields, err := decodeOfflineV5Object(operation.Payload, 16<<10)
	if err != nil || !offlineV5OnlyFields(fields, "program_id", "session_id", "status") {
		result.ErrorCode = "invalid_program_attendance"
		return result, nil
	}
	programID, err := offlineV5UUIDField(fields, "program_id")
	if err != nil || programID != selection.ResourceID {
		result.ErrorCode = "outside_selection"
		return result, nil
	}
	sessionID, err := offlineV5UUIDField(fields, "session_id")
	var status string
	if err != nil || json.Unmarshal(fields["status"], &status) != nil ||
		(status != "" && status != domain.AttendanceStatusConfirmed && status != domain.AttendanceStatusPresent && status != domain.AttendanceStatusAbsent && status != domain.AttendanceStatusLate) {
		result.ErrorCode = "invalid_program_attendance"
		return result, nil
	}
	var sessionDate, enrolledAt time.Time
	var droppedAt, completedAt *time.Time
	err = tx.QueryRow(ctx, `SELECT session.date,participant.enrolled_at,participant.dropped_at,participant.completed_at
		FROM programs program JOIN program_sessions session ON session.account_id=program.account_id AND session.program_id=program.id
		JOIN program_participants participant ON participant.program_id=program.id AND participant.id=$4
		JOIN contacts contact ON contact.account_id=program.account_id AND contact.id=participant.contact_id
		WHERE program.account_id=$1 AND program.id=$2 AND session.id=$3 FOR UPDATE OF session,participant`,
		record.AccountID, programID, sessionID, operation.ResourceID).Scan(&sessionDate, &enrolledAt, &droppedAt, &completedAt)
	if errors.Is(err, pgx.ErrNoRows) || sessionDate.Before(enrolledAt) || (droppedAt != nil && !sessionDate.Before(*droppedAt)) || (completedAt != nil && !sessionDate.Before(*completedAt)) {
		result.ErrorCode = "participant_outside_session_window"
		return result, nil
	}
	if err != nil {
		return result, err
	}
	var attendanceID *uuid.UUID
	var currentStatus string
	var updatedAt *time.Time
	err = tx.QueryRow(ctx, `SELECT attendance.id,COALESCE(attendance.status,''),attendance.updated_at FROM program_attendance attendance
		WHERE attendance.session_id=$1 AND attendance.participant_id=$2 FOR UPDATE`, sessionID, operation.ResourceID).
		Scan(&attendanceID, &currentStatus, &updatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		err, currentStatus, updatedAt = nil, "", nil
	} else if err != nil {
		return result, err
	}
	currentVersion := int64(0)
	if updatedAt != nil {
		currentVersion = updatedAt.UnixMicro()
	}
	if currentVersion != operation.BaseVersion {
		result.Status, result.ErrorCode, result.ServerVersion = "conflict", "field_conflict", currentVersion
		result.Conflict = &domain.OfflineV5Conflict{Fields: []string{"status"}}
		return result, nil
	}
	if status == "" {
		// Attendance notes are durable history. Clearing a mark may remove an
		// otherwise empty row, but it must retain a NULL-status anchor when the
		// participant/session already has observations.
		var hasObservations bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM interactions interaction
			WHERE interaction.account_id=$1 AND interaction.program_id=$2 AND interaction.program_session_id=$3
			  AND interaction.program_participant_id=$4 AND interaction.type='attendance')`, record.AccountID, programID,
			sessionID, operation.ResourceID).Scan(&hasObservations); err != nil {
			return result, err
		}
		if hasObservations {
			var id uuid.UUID
			var written time.Time
			err = tx.QueryRow(ctx, `INSERT INTO program_attendance(session_id,participant_id,status,notes)
				VALUES($1,$2,'',NULL) ON CONFLICT(session_id,participant_id) DO UPDATE SET status='',notes=NULL,updated_at=NOW()
				RETURNING id,updated_at`, sessionID, operation.ResourceID).Scan(&id, &written)
			result.Status, result.ServerVersion = "applied", written.UnixMicro()
			result.Result, _ = json.Marshal(map[string]any{"attendance": map[string]any{"id": id, "session_id": sessionID,
				"participant_id": operation.ResourceID, "status": "", "updated_at": written}})
		} else {
			_, err = tx.Exec(ctx, `DELETE FROM program_attendance attendance USING program_sessions session,programs program
				WHERE attendance.session_id=$1 AND attendance.participant_id=$2 AND session.id=attendance.session_id
				AND program.id=session.program_id AND program.account_id=$3 AND program.id=$4`, sessionID, operation.ResourceID, record.AccountID, programID)
			result.Status, result.ServerVersion = "applied", 0
		}
	} else {
		var id uuid.UUID
		var written time.Time
		err = tx.QueryRow(ctx, `INSERT INTO program_attendance(session_id,participant_id,status) VALUES($1,$2,$3)
			ON CONFLICT(session_id,participant_id) DO UPDATE SET status=EXCLUDED.status,updated_at=NOW()
			RETURNING id,updated_at`, sessionID, operation.ResourceID, status).Scan(&id, &written)
		result.Status, result.ServerVersion = "applied", written.UnixMicro()
		result.Result, _ = json.Marshal(map[string]any{"attendance": map[string]any{"id": id, "session_id": sessionID,
			"participant_id": operation.ResourceID, "status": status, "updated_at": written}})
	}
	if err != nil {
		return result, err
	}
	return result, nil
}

func (r *OfflineV5Repository) applyProgramObservationTx(ctx context.Context, tx pgx.Tx, record *OfflineV5AuthRecord, operation domain.OfflineV5Operation, selection domain.OfflineV3Selection) (domain.OfflineV5OperationResult, error) {
	result := domain.OfflineV5OperationResult{OperationID: operation.OperationID, ResourceID: operation.ResourceID, Status: "rejected"}
	fields, err := decodeOfflineV5Object(operation.Payload, 32<<10)
	if err != nil || !offlineV5OnlyFields(fields, "program_id", "session_id", "scope", "participant_id", "notes", "type", "outcome", "follow_up_at") || operation.BaseVersion != 0 {
		result.ErrorCode = "invalid_program_observation"
		return result, nil
	}
	programID, err := offlineV5UUIDField(fields, "program_id")
	var scope, notes string
	if err != nil || programID != selection.ResourceID || json.Unmarshal(fields["scope"], &scope) != nil || json.Unmarshal(fields["notes"], &notes) != nil {
		result.ErrorCode = "outside_selection"
		return result, nil
	}
	notes = strings.TrimSpace(notes)
	if notes == "" || utf8.RuneCountInString(notes) > 10000 || operation.ResourceID == uuid.Nil {
		result.ErrorCode = "invalid_program_observation"
		return result, nil
	}
	var created, updated time.Time
	switch scope {
	case "session":
		sessionID, parseErr := offlineV5UUIDField(fields, "session_id")
		if parseErr != nil {
			result.ErrorCode = "invalid_program_observation"
			return result, nil
		}
		err = tx.QueryRow(ctx, `INSERT INTO program_session_observations(id,account_id,session_id,notes,created_by)
			SELECT $1,program.account_id,session.id,$5,$6 FROM programs program
			JOIN program_sessions session ON session.account_id=program.account_id AND session.program_id=program.id
			WHERE program.account_id=$2 AND program.id=$3 AND session.id=$4 RETURNING created_at,updated_at`, operation.ResourceID,
			record.AccountID, programID, sessionID, notes, record.UserID).Scan(&created, &updated)
	case "attendance":
		sessionID, sessionErr := offlineV5UUIDField(fields, "session_id")
		participantID, parseErr := offlineV5UUIDField(fields, "participant_id")
		if sessionErr != nil || parseErr != nil {
			result.ErrorCode = "invalid_program_observation"
			return result, nil
		}
		err = tx.QueryRow(ctx, `INSERT INTO interactions(id,account_id,contact_id,program_id,program_session_id,program_participant_id,
			source_label,type,notes,created_by,created_at,updated_at)
			SELECT $1,program.account_id,participant.contact_id,program.id,session.id,participant.id,
			program.name||' · '||session.title,'attendance',$6,$7,NOW(),NOW() FROM programs program
			JOIN program_sessions session ON session.account_id=program.account_id AND session.program_id=program.id
			JOIN program_participants participant ON participant.program_id=program.id AND participant.id=$5
			JOIN contacts contact ON contact.account_id=program.account_id AND contact.id=participant.contact_id
			WHERE program.account_id=$2 AND program.id=$3 AND session.id=$4 RETURNING created_at,updated_at`, operation.ResourceID,
			record.AccountID, programID, sessionID, participantID, notes, record.UserID).Scan(&created, &updated)
	case "participant":
		participantID, parseErr := offlineV5UUIDField(fields, "participant_id")
		if parseErr != nil {
			result.ErrorCode = "invalid_program_observation"
			return result, nil
		}
		var sessionID *uuid.UUID
		if raw, exists := fields["session_id"]; exists && !bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			parsed, parseErr := offlineV5UUIDField(fields, "session_id")
			if parseErr != nil {
				result.ErrorCode = "invalid_program_observation"
				return result, nil
			}
			sessionID = &parsed
		}
		noteType, outcome := "note", ""
		var followUpAt *time.Time
		if raw, exists := fields["type"]; exists && json.Unmarshal(raw, &noteType) != nil {
			result.ErrorCode = "invalid_program_observation"
			return result, nil
		}
		if raw, exists := fields["outcome"]; exists && json.Unmarshal(raw, &outcome) != nil {
			result.ErrorCode = "invalid_program_observation"
			return result, nil
		}
		if raw, exists := fields["follow_up_at"]; exists && !bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			var encoded string
			if json.Unmarshal(raw, &encoded) != nil {
				result.ErrorCode = "invalid_program_observation"
				return result, nil
			}
			parsed, parseErr := time.Parse(time.RFC3339, strings.TrimSpace(encoded))
			if parseErr != nil {
				result.ErrorCode = "invalid_program_observation"
				return result, nil
			}
			followUpAt = &parsed
		}
		noteType, outcome = strings.TrimSpace(noteType), strings.TrimSpace(outcome)
		if noteType == "" || utf8.RuneCountInString(noteType) > 50 || utf8.RuneCountInString(outcome) > 1000 {
			result.ErrorCode = "invalid_program_observation"
			return result, nil
		}
		var contactID uuid.UUID
		err = tx.QueryRow(ctx, `INSERT INTO program_participant_notes(id,account_id,program_id,participant_id,contact_id,session_id,type,note,outcome,follow_up_at,created_by)
			SELECT $1,program.account_id,program.id,participant.id,participant.contact_id,$5,$6,$7,$8,$9,$10
			FROM programs program JOIN program_participants participant ON participant.program_id=program.id AND participant.id=$4
			JOIN contacts contact ON contact.account_id=program.account_id AND contact.id=participant.contact_id
			WHERE program.account_id=$2 AND program.id=$3 AND ($5::uuid IS NULL OR EXISTS(
			 SELECT 1 FROM program_sessions session WHERE session.account_id=program.account_id AND session.program_id=program.id AND session.id=$5))
			RETURNING contact_id,created_at,updated_at`, operation.ResourceID, record.AccountID, programID, participantID,
			sessionID, noteType, notes, outcome, followUpAt, record.UserID).Scan(&contactID, &created, &updated)
	default:
		result.ErrorCode = "invalid_program_observation"
		return result, nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		result.ErrorCode = "access_revoked"
		return result, nil
	}
	if err != nil {
		return result, err
	}
	result.Status, result.ServerVersion = "applied", updated.UnixMicro()
	result.Result, _ = json.Marshal(map[string]any{"observation_id": operation.ResourceID, "scope": scope,
		"created_at": created, "updated_at": updated})
	return result, nil
}

func (r *OfflineV5Repository) applyProgramGoalsTx(ctx context.Context, tx pgx.Tx, record *OfflineV5AuthRecord, operation domain.OfflineV5Operation, selection domain.OfflineV3Selection) (domain.OfflineV5OperationResult, error) {
	result := domain.OfflineV5OperationResult{OperationID: operation.OperationID, ResourceID: operation.ResourceID, Status: "rejected"}
	fields, err := decodeOfflineV5Object(operation.Payload, 8<<10)
	if err != nil || operation.ResourceID != selection.ResourceID || !offlineV5OnlyFields(fields, "attendance_goal_percent", "transfer_goal_percent") {
		result.ErrorCode = "invalid_program_goals"
		return result, nil
	}
	var attendance, transfer int
	if json.Unmarshal(fields["attendance_goal_percent"], &attendance) != nil || json.Unmarshal(fields["transfer_goal_percent"], &transfer) != nil ||
		attendance < 0 || attendance > 100 || transfer < 0 || transfer > 100 {
		result.ErrorCode = "invalid_program_goals"
		return result, nil
	}
	var id uuid.UUID
	var current *time.Time
	var programExists bool
	if err := tx.QueryRow(ctx, `SELECT TRUE FROM programs WHERE account_id=$1 AND id=$2 AND COALESCE(type,'course')='course' FOR UPDATE`,
		record.AccountID, selection.ResourceID).Scan(&programExists); errors.Is(err, pgx.ErrNoRows) {
		result.ErrorCode = "access_revoked"
		return result, nil
	} else if err != nil {
		return result, err
	}
	err = tx.QueryRow(ctx, `SELECT goal.id,goal.updated_at FROM program_goals goal JOIN programs program
		ON program.account_id=goal.account_id AND program.id=goal.program_id WHERE program.account_id=$1 AND program.id=$2 FOR UPDATE OF goal`,
		record.AccountID, selection.ResourceID).Scan(&id, &current)
	if errors.Is(err, pgx.ErrNoRows) {
		err, id, current = nil, uuid.New(), nil
	} else if err != nil {
		return result, err
	}
	currentVersion := int64(0)
	if current != nil {
		currentVersion = current.UnixMicro()
	}
	if currentVersion != operation.BaseVersion {
		result.Status, result.ErrorCode, result.ServerVersion = "conflict", "field_conflict", currentVersion
		result.Conflict = &domain.OfflineV5Conflict{Fields: []string{"attendance_goal_percent", "transfer_goal_percent"}}
		return result, nil
	}
	var created, updated time.Time
	if current == nil {
		err = tx.QueryRow(ctx, `INSERT INTO program_goals(id,account_id,program_id,attendance_goal_percent,transfer_goal_percent)
			VALUES($1,$2,$3,$4,$5) RETURNING created_at,updated_at`, id, record.AccountID,
			selection.ResourceID, attendance, transfer).Scan(&created, &updated)
	} else {
		err = tx.QueryRow(ctx, `UPDATE program_goals SET attendance_goal_percent=$1,transfer_goal_percent=$2,updated_at=NOW()
			WHERE account_id=$3 AND program_id=$4 AND id=$5 RETURNING created_at,updated_at`, attendance, transfer,
			record.AccountID, selection.ResourceID, id).Scan(&created, &updated)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		result.ErrorCode = "access_revoked"
		return result, nil
	}
	if err != nil {
		return result, err
	}
	result.Status, result.ServerVersion = "applied", updated.UnixMicro()
	result.Result, _ = json.Marshal(map[string]any{"goal": domain.ProgramGoal{ID: id, AccountID: record.AccountID,
		ProgramID: &selection.ResourceID, AttendanceGoalPercent: attendance, TransferGoalPercent: transfer,
		CreatedAt: created, UpdatedAt: updated}})
	return result, nil
}

func (r *OfflineV5Repository) applyProgramUpdateTx(ctx context.Context, tx pgx.Tx, record *OfflineV5AuthRecord, operation domain.OfflineV5Operation, selection domain.OfflineV3Selection) (domain.OfflineV5OperationResult, error) {
	result := domain.OfflineV5OperationResult{OperationID: operation.OperationID, ResourceID: operation.ResourceID, Status: "rejected"}
	if operation.ResourceID != selection.ResourceID || operation.BaseVersion < 1 {
		result.ErrorCode = "outside_selection"
		return result, nil
	}
	local, err := decodeOfflineV5Object(operation.Payload, 64<<10)
	if err != nil || len(local) == 0 {
		result.ErrorCode = "invalid_program_update"
		return result, nil
	}
	base := map[string]json.RawMessage{}
	if len(operation.Base) > 0 {
		base, err = decodeOfflineV5Object(operation.Base, 64<<10)
		if err != nil {
			result.ErrorCode = "invalid_program_base"
			return result, nil
		}
	}
	program, err := loadOfflineV5ProgramTx(ctx, tx, record.AccountID, operation.ResourceID)
	if errors.Is(err, pgx.ErrNoRows) {
		result.ErrorCode = "access_revoked"
		return result, nil
	}
	if err != nil {
		return result, err
	}
	currentVersion := program.UpdatedAt.UnixMicro()
	merged, conflict := offlineV5MergePatch(operation.BaseVersion, currentVersion, base, local, offlineV5ProgramCurrent(program))
	if conflict != nil {
		result.Status, result.ErrorCode, result.ServerVersion, result.Conflict = "conflict", "field_conflict", currentVersion, conflict
		result.Result, _ = json.Marshal(map[string]any{"program": program})
		return result, nil
	}
	for name, raw := range local {
		switch name {
		case "name":
			if json.Unmarshal(raw, &program.Name) != nil || strings.TrimSpace(program.Name) == "" || utf8.RuneCountInString(program.Name) > 200 {
				result.ErrorCode = "invalid_program_update"
				return result, nil
			}
			program.Name = strings.TrimSpace(program.Name)
		case "description":
			if json.Unmarshal(raw, &program.Description) != nil || (program.Description != nil && utf8.RuneCountInString(*program.Description) > 10000) {
				result.ErrorCode = "invalid_program_update"
				return result, nil
			}
		case "status":
			if json.Unmarshal(raw, &program.Status) != nil || (program.Status != "active" && program.Status != "completed" && program.Status != "archived") {
				result.ErrorCode = "invalid_program_update"
				return result, nil
			}
		case "color":
			if json.Unmarshal(raw, &program.Color) != nil || len(program.Color) > 32 {
				result.ErrorCode = "invalid_program_update"
				return result, nil
			}
		case "schedule_start_date":
			program.ScheduleStartDate, err = offlineV5Date(raw)
		case "schedule_end_date":
			program.ScheduleEndDate, err = offlineV5Date(raw)
		case "schedule_days":
			if json.Unmarshal(raw, &program.ScheduleDays) != nil || len(program.ScheduleDays) > 7 {
				err = ErrOfflineV3Invalid
				break
			}
			seen := map[int]struct{}{}
			for _, day := range program.ScheduleDays {
				if day < 0 || day > 6 {
					err = ErrOfflineV3Invalid
					break
				}
				seen[day] = struct{}{}
			}
			if len(seen) != len(program.ScheduleDays) {
				err = ErrOfflineV3Invalid
			}
		case "schedule_start_time":
			program.ScheduleStartTime, err = offlineV5Clock(raw)
		case "schedule_end_time":
			program.ScheduleEndTime, err = offlineV5Clock(raw)
		case "health_view_columns":
			if json.Unmarshal(raw, &program.HealthViewColumns) != nil || len(program.HealthViewColumns) > 5 {
				err = ErrOfflineV3Invalid
				break
			}
			allowed, seen := map[string]bool{"health": true, "attendance": true, "signals": true, "enrolled_at": true, "tenure": true}, map[string]bool{}
			for _, column := range program.HealthViewColumns {
				if !allowed[column] || seen[column] {
					err = ErrOfflineV3Invalid
					break
				}
				seen[column] = true
			}
		default:
			result.ErrorCode = "invalid_program_update"
			return result, nil
		}
		if err != nil {
			result.ErrorCode = "invalid_program_update"
			return result, nil
		}
	}
	if program.ScheduleStartDate != nil && program.ScheduleEndDate != nil && program.ScheduleEndDate.Before(*program.ScheduleStartDate) {
		result.ErrorCode = "invalid_program_update"
		return result, nil
	}
	expected := program.UpdatedAt
	program.ExpectedUpdatedAt = &expected
	if err := (&ProgramRepository{db: r.db}).UpdateTx(ctx, tx, program); err != nil {
		if errors.Is(err, ErrProgramConflict) {
			result.Status, result.ErrorCode = "conflict", "version_conflict"
			return result, nil
		}
		return result, err
	}
	result.Status = "applied"
	if merged {
		result.Status = "merged"
	}
	result.ServerVersion = program.UpdatedAt.UnixMicro()
	result.Result, _ = json.Marshal(map[string]any{"program": program})
	return result, nil
}

type offlineV5WhiteboardPatch struct {
	Scene              json.RawMessage `json:"scene"`
	Patch              json.RawMessage `json:"patch"`
	SceneSchemaVersion string          `json:"scene_schema_version"`
	EditorVersion      string          `json:"editor_version"`
	RequestPayloadHash string          `json:"request_payload_hash"`
	ResultSceneHash    string          `json:"result_scene_hash"`
}

func (r *OfflineV5Repository) applyWhiteboardPatchTx(ctx context.Context, tx pgx.Tx, record *OfflineV5AuthRecord, operation domain.OfflineV5Operation, selection domain.OfflineV3Selection) (domain.OfflineV5OperationResult, error) {
	result := domain.OfflineV5OperationResult{OperationID: operation.OperationID, ResourceID: operation.ResourceID, Status: "rejected"}
	if operation.ResourceID != selection.ResourceID || operation.BaseVersion < 0 {
		result.ErrorCode = "outside_selection"
		return result, nil
	}
	fields, err := decodeOfflineV5Object(operation.Payload, 2<<20)
	if err != nil {
		result.ErrorCode = "invalid_whiteboard_patch"
		return result, nil
	}
	for name := range fields {
		switch name {
		case "scene", "patch", "scene_schema_version", "editor_version", "request_payload_hash", "result_scene_hash":
		default:
			result.ErrorCode = "invalid_whiteboard_patch"
			return result, nil
		}
	}
	var input offlineV5WhiteboardPatch
	if json.Unmarshal(operation.Payload, &input) != nil || len(input.Scene) == 0 || len(input.Patch) == 0 ||
		len(input.RequestPayloadHash) != 64 || len(input.ResultSceneHash) != 64 {
		result.ErrorCode = "invalid_whiteboard_patch"
		return result, nil
	}
	writeResult, err := (&WhiteboardRepository{db: r.db}).ApplyScenePatchTx(ctx, tx, record.AccountID, record.UserID,
		operation.ResourceID, WhiteboardSceneWriteInput{ExpectedSequence: operation.BaseVersion, OperationID: operation.OperationID,
			Scene: input.Scene, Patch: input.Patch, SceneSchemaVersion: input.SceneSchemaVersion, EditorVersion: input.EditorVersion,
			RequestPayloadHash: input.RequestPayloadHash, ResultSceneHash: input.ResultSceneHash})
	if err != nil {
		var conflict *WhiteboardConflictError
		if errors.As(err, &conflict) || errors.Is(err, ErrWhiteboardConflict) {
			result.Status, result.ErrorCode = "conflict", "version_conflict"
			if conflict != nil {
				result.ServerVersion = conflict.CurrentSequence
			}
			return result, nil
		}
		if errors.Is(err, ErrWhiteboardForbidden) || errors.Is(err, ErrWhiteboardNotFound) {
			result.ErrorCode = "access_revoked"
			return result, nil
		}
		if errors.Is(err, ErrWhiteboardInvalid) {
			result.ErrorCode = "invalid_whiteboard_patch"
			return result, nil
		}
		return result, err
	}
	result.Status, result.ServerVersion = "applied", writeResult.Scene.Sequence
	if writeResult.Idempotent {
		result.Status = "noop"
	}
	result.Result, _ = json.Marshal(map[string]any{"scene": writeResult.Scene, "operation_sequence": writeResult.OperationSequence})
	return result, nil
}

func offlineV5ConvertTaskResult(input domain.OfflineV3OperationResult) domain.OfflineV5OperationResult {
	return domain.OfflineV5OperationResult{OperationID: input.OperationID, Status: input.Status, ErrorCode: input.ErrorCode,
		ResourceID: input.ResourceID, ServerVersion: input.ServerVersion, Result: input.Result}
}

func (r *OfflineV5Repository) storeV5ReceiptTx(ctx context.Context, tx pgx.Tx, record *OfflineV5AuthRecord, operation domain.OfflineV5Operation, requestHash string, result domain.OfflineV5OperationResult, effect *OfflineV3TaskEffect) error {
	encoded, err := json.Marshal(result)
	if err != nil {
		return err
	}
	intentHash, err := offlineV5OperationIntentHash(operation)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO offline_v5_receipts(grant_id,account_id,manifest_id,operation_id,request_hash,intent_hash,action_code,selection_id,resource_id,status,error_code,server_version,result)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULLIF($11,''),$12,$13::jsonb)`, record.GrantID, record.AccountID,
		operation.ManifestID, operation.OperationID, requestHash, intentHash, operation.Action, operation.SelectionID, operation.ResourceID,
		result.Status, result.ErrorCode, result.ServerVersion, encoded); err != nil {
		return err
	}
	if effect == nil || (result.Status != "applied" && result.Status != "merged") {
		return nil
	}
	effect.Origin, effect.ID, effect.GrantID, effect.AccountID = "offline_v5", uuid.New(), record.GrantID, record.AccountID
	effect.OperationID, effect.ActorID, effect.Action = operation.OperationID, record.UserID, operation.Action
	payload, err := json.Marshal(effect)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO offline_v4_event_outbox(id,grant_id,account_id,operation_id,event_type,payload)
		VALUES($1,$2,$3,$4,'task_effect',$5::jsonb) ON CONFLICT(grant_id,operation_id,event_type) DO NOTHING`,
		effect.ID, record.GrantID, record.AccountID, operation.OperationID, payload)
	return err
}

func (r *OfflineV5Repository) recoverV5ReceiptsTx(ctx context.Context, tx pgx.Tx, record *OfflineV5AuthRecord, manifest *domain.OfflineV5Manifest, operations []domain.OfflineV5Operation) ([]domain.OfflineV5OperationResult, error) {
	receipts := make([]domain.OfflineV5OperationResult, 0, len(operations))
	now := time.Now().UTC()
	if !offlineV5ReceiptRecoveryBindingsValid(record, manifest, operations, now) {
		return nil, ErrOfflineV3AccessDenied
	}
	for _, operation := range operations {
		requestHash, err := offlineV5OperationRequestHash(operation)
		if err != nil {
			return nil, err
		}
		stored := offlineV5StoredReceipt{ManifestID: manifest.ID}
		err = tx.QueryRow(ctx, `SELECT request_hash,intent_hash,action_code,selection_id,resource_id,status,server_version,result
			FROM offline_v5_receipts
			WHERE grant_id=$1 AND account_id=$2 AND manifest_id=$3 AND operation_id=$4 FOR SHARE`,
			record.GrantID, record.AccountID, manifest.ID, operation.OperationID).
			Scan(&stored.RequestHash, &stored.IntentHash, &stored.Action, &stored.SelectionID, &stored.ResourceID, &stored.Status, &stored.ServerVersion, &stored.Result)
		if errors.Is(err, pgx.ErrNoRows) {
			// A superseded manifest can acknowledge only already committed
			// commands. Missing receipts must never fall through to apply.
			return nil, ErrOfflineV3AccessDenied
		}
		if err != nil {
			return nil, err
		}
		receipt, err := offlineV5RecoveredReceipt(operation, requestHash, stored)
		if err != nil {
			return nil, err
		}
		receipts = append(receipts, receipt)
	}
	return receipts, nil
}

type OfflineV5OperationPreprocessor func(context.Context, *OfflineV5AuthRecord, *domain.OfflineV5Operation) error

func (r *OfflineV5Repository) applyV5OperationTx(ctx context.Context, tx pgx.Tx, record *OfflineV5AuthRecord, manifest *domain.OfflineV5Manifest, operation domain.OfflineV5Operation, preprocess OfflineV5OperationPreprocessor) (domain.OfflineV5OperationResult, error) {
	result := domain.OfflineV5OperationResult{OperationID: operation.OperationID, ResourceID: operation.ResourceID, Status: "rejected"}
	if !offlineV5OperationBinding(record, manifest, operation, time.Now().UTC()) {
		return result, ErrOfflineV3Invalid
	}
	requestHash, err := offlineV5OperationRequestHash(operation)
	if err != nil {
		return result, err
	}
	intentHash, err := offlineV5OperationIntentHash(operation)
	if err != nil {
		return result, err
	}
	stored := offlineV5StoredReceipt{}
	var reboundTerminal *domain.OfflineV5OperationResult
	err = tx.QueryRow(ctx, `SELECT manifest_id,request_hash,intent_hash,action_code,selection_id,resource_id,status,server_version,result
		FROM offline_v5_receipts WHERE grant_id=$1 AND account_id=$2 AND operation_id=$3 FOR UPDATE`,
		record.GrantID, record.AccountID, operation.OperationID).
		Scan(&stored.ManifestID, &stored.RequestHash, &stored.IntentHash, &stored.Action, &stored.SelectionID,
			&stored.ResourceID, &stored.Status, &stored.ServerVersion, &stored.Result)
	if err == nil {
		if stored.Status != "pending" {
			if stored.RequestHash == requestHash {
				return offlineV5RecoveredReceipt(operation, requestHash, stored)
			}
			rebound, reboundErr := offlineV5ReboundTerminalReceipt(operation, intentHash, stored)
			if reboundErr != nil {
				return result, reboundErr
			}
			reboundTerminal = &rebound
			err = pgx.ErrNoRows
		} else {
			if err := offlineV5PendingReceiptCanRebind(operation, intentHash, stored); err != nil {
				return result, err
			}
			// Keep the outer query error as the state-machine sentinel below.
			// A short declaration here would shadow it, leave the outer value nil,
			// and return an empty rejected receipt immediately after deleting the
			// durable pending receipt.
			tag, deleteErr := tx.Exec(ctx, `DELETE FROM offline_v5_receipts
				WHERE grant_id=$1 AND account_id=$2 AND operation_id=$3 AND status='pending' AND intent_hash=$4`,
				record.GrantID, record.AccountID, operation.OperationID, intentHash)
			if deleteErr != nil {
				return result, deleteErr
			}
			if tag.RowsAffected() != 1 {
				return result, ErrOfflineV3Conflict
			}
			// Continue below as a fresh evaluation of the same immutable intent.
			err = pgx.ErrNoRows
		}
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return result, err
	}
	if reboundTerminal == nil && operation.DependsOnOperationID != nil {
		if *operation.DependsOnOperationID == uuid.Nil || *operation.DependsOnOperationID == operation.OperationID {
			result.ErrorCode = "invalid_operation_dependency"
			return result, r.storeV5ReceiptTx(ctx, tx, record, operation, requestHash, result, nil)
		}
		var status string
		err := tx.QueryRow(ctx, `SELECT status FROM offline_v5_receipts WHERE grant_id=$1 AND account_id=$2 AND operation_id=$3`,
			record.GrantID, record.AccountID, *operation.DependsOnOperationID).Scan(&status)
		if errors.Is(err, pgx.ErrNoRows) {
			result.Status, result.ErrorCode = "pending", "operation_dependency_pending"
			return result, r.storeV5ReceiptTx(ctx, tx, record, operation, requestHash, result, nil)
		}
		if err != nil {
			return result, err
		}
		if status == "pending" {
			result.Status, result.ErrorCode = "pending", "operation_dependency_pending"
			return result, r.storeV5ReceiptTx(ctx, tx, record, operation, requestHash, result, nil)
		}
		if status != "applied" && status != "merged" && status != "noop" {
			result.ErrorCode = "operation_dependency_rejected"
			return result, r.storeV5ReceiptTx(ctx, tx, record, operation, requestHash, result, nil)
		}
	}
	module, known := OfflineV5ActionModule(operation.Action)
	if !known || !offlineV5ModuleAllowed(record.Modules, module) || !record.WritesEnabled {
		if reboundTerminal != nil {
			return result, ErrOfflineV3AccessDenied
		}
		result.ErrorCode = "action_not_allowed"
		return result, r.storeV5ReceiptTx(ctx, tx, record, operation, requestHash, result, nil)
	}
	var selection domain.OfflineV3Selection
	err = tx.QueryRow(ctx, `SELECT selection.id,selection.grant_id,selection.account_id,selection.module,selection.resource_type,selection.resource_id
		FROM offline_v4_selections selection
		JOIN offline_v5_manifest_roots root ON root.selection_id=selection.id AND root.grant_id=selection.grant_id AND root.account_id=selection.account_id
		WHERE selection.id=$1 AND selection.grant_id=$2 AND selection.account_id=$3 AND root.manifest_id=$4 FOR SHARE OF selection,root`,
		operation.SelectionID, record.GrantID, record.AccountID, manifest.ID).Scan(&selection.ID, &selection.GrantID,
		&selection.AccountID, &selection.Module, &selection.ResourceType, &selection.ResourceID)
	if errors.Is(err, pgx.ErrNoRows) || selection.Module != module {
		if reboundTerminal != nil {
			return result, ErrOfflineV3AccessDenied
		}
		result.ErrorCode = "outside_selection"
		return result, r.storeV5ReceiptTx(ctx, tx, record, operation, requestHash, result, nil)
	}
	if err != nil {
		return result, err
	}
	var capability bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM offline_v5_manifest_capabilities
		WHERE manifest_id=$1 AND grant_id=$2 AND account_id=$3 AND selection_id=$4 AND action_code=$5)`,
		manifest.ID, record.GrantID, record.AccountID, selection.ID, operation.Action).Scan(&capability); err != nil {
		return result, err
	}
	if !capability {
		if reboundTerminal != nil {
			return result, ErrOfflineV3AccessDenied
		}
		result.ErrorCode = "action_not_allowed"
		return result, r.storeV5ReceiptTx(ctx, tx, record, operation, requestHash, result, nil)
	}
	accessLevel := domain.TaskAccessView
	if operation.Action == domain.OfflineV5ActionTasksComment {
		accessLevel = domain.TaskAccessComment
	} else if module == domain.OfflineModuleTasks || module == domain.OfflineModuleWhiteboards {
		accessLevel = domain.TaskAccessEdit
	}
	if err := validateOfflineV3ResourceAccess(ctx, tx, record.UserID, record.AccountID, selection, accessLevel); err != nil {
		if reboundTerminal != nil {
			return result, ErrOfflineV3AccessDenied
		}
		result.ErrorCode = "access_revoked"
		return result, r.storeV5ReceiptTx(ctx, tx, record, operation, requestHash, result, nil)
	}
	if reboundTerminal != nil {
		// A different tab may have advanced a pending intent while an older
		// delivery recovery was signing. Revalidate the current manifest and
		// live ACL above, then return the terminal receipt without dispatching.
		return *reboundTerminal, nil
	}
	// Parse/materialize expensive module payloads only after the active grant,
	// current manifest, signed capability and live resource ACL are proven.
	// Receipt recovery returns above and must never replay this preprocessing.
	if preprocess != nil {
		if err := preprocess(ctx, record, &operation); err != nil {
			return result, err
		}
	}
	// Isolate every canonical command behind a savepoint. PostgreSQL marks a
	// transaction failed after a constraint error; without this boundary a
	// safely rejected child mutation could neither store its idempotent receipt
	// nor allow independent operations in the same sync batch to continue.
	mutation, err := tx.Begin(ctx)
	if err != nil {
		return result, err
	}
	var taskEffect *OfflineV3TaskEffect
	switch operation.Action {
	case domain.OfflineV5ActionTasksCreate, domain.OfflineV5ActionTasksComplete:
		v3Operation := domain.OfflineV3Operation{ProtocolVersion: 4, GrantID: operation.GrantID, UserID: operation.UserID,
			AccountID: operation.AccountID, BrowserProfileID: operation.BrowserProfileID, OperationID: operation.OperationID,
			Action: operation.Action, SelectionID: operation.SelectionID, ResourceID: operation.ResourceID,
			SelectionRevision: operation.SelectionRevision, CredentialEpoch: operation.CredentialEpoch,
			AuthorityEpoch: operation.AuthorityEpoch, BaseVersion: operation.BaseVersion,
			DependsOnOperationID: operation.DependsOnOperationID, Payload: operation.Payload, OccurredAt: operation.OccurredAt}
		v3Result, seed, err := applyOfflineTaskMutationTx(ctx, mutation, r.db, offlineTaskAuthority{AccountID: record.AccountID,
			UserID: record.UserID, GrantID: record.GrantID}, v3Operation, selection, operation.BaseVersion, true, "offline_v5")
		if err != nil {
			return result, err
		}
		result = offlineV5ConvertTaskResult(v3Result)
		if result.Status == "applied" {
			taskEffect = &OfflineV3TaskEffect{TaskID: operation.ResourceID, TaskVersion: result.ServerVersion, RecurrenceSeed: seed}
		}
	case domain.OfflineV5ActionTasksUpdate:
		var task *domain.Task
		result, task, err = r.applyTaskUpdateTx(ctx, mutation, record, operation, selection)
		if task != nil && (result.Status == "applied" || result.Status == "merged") {
			taskEffect = &OfflineV3TaskEffect{TaskID: task.ID, TaskVersion: task.Version}
		}
	case domain.OfflineV5ActionTasksReopen:
		var task *domain.Task
		result, task, err = r.applyTaskReopenTx(ctx, mutation, record, operation, selection)
		if task != nil && result.Status == "applied" {
			taskEffect = &OfflineV3TaskEffect{TaskID: task.ID, TaskVersion: task.Version}
		}
	case domain.OfflineV5ActionTasksComment:
		var task *domain.Task
		result, task, err = r.applyTaskCommentTx(ctx, mutation, record, operation, selection)
		if task != nil && result.Status == "applied" {
			commentID := operation.ResourceID
			taskEffect = &OfflineV3TaskEffect{TaskID: task.ID, TaskVersion: task.Version, RelatedResourceID: &commentID}
		}
	case domain.OfflineV5ActionContactsUpdate:
		result, err = r.applyContactUpdateTx(ctx, mutation, record, operation, selection)
	case domain.OfflineV5ActionContactsObserve:
		result, err = r.applyContactObservationOperationTx(ctx, mutation, record, operation, selection)
	case domain.OfflineV5ActionProgramsUpdate:
		result, err = r.applyProgramUpdateTx(ctx, mutation, record, operation, selection)
	case domain.OfflineV5ActionProgramsParticipantAdd:
		result, err = r.applyProgramParticipantAddTx(ctx, mutation, record, operation, selection)
	case domain.OfflineV5ActionProgramsParticipantLifecycle:
		result, err = r.applyProgramParticipantLifecycleTx(ctx, mutation, record, operation, selection)
	case domain.OfflineV5ActionProgramsSessionUpsert:
		result, err = r.applyProgramSessionUpsertTx(ctx, mutation, record, operation, selection)
	case domain.OfflineV5ActionProgramsAttendance:
		result, err = r.applyProgramAttendanceTx(ctx, mutation, record, operation, selection)
	case domain.OfflineV5ActionProgramsObservation:
		result, err = r.applyProgramObservationTx(ctx, mutation, record, operation, selection)
	case domain.OfflineV5ActionProgramsGoals:
		result, err = r.applyProgramGoalsTx(ctx, mutation, record, operation, selection)
	case domain.OfflineV5ActionBoardsScene:
		result, err = r.applyWhiteboardPatchTx(ctx, mutation, record, operation, selection)
	default:
		result.ErrorCode = "action_not_allowed"
	}
	if err != nil {
		if rollbackErr := mutation.Rollback(ctx); rollbackErr != nil {
			return result, rollbackErr
		}
		var databaseErr *pgconn.PgError
		if errors.As(err, &databaseErr) && (databaseErr.Code == "23503" || databaseErr.Code == "23514" || databaseErr.Code == "23505") {
			result.Status, result.ErrorCode = "rejected", "canonical_validation_failed"
		} else {
			return result, err
		}
	} else if err := mutation.Commit(ctx); err != nil {
		return result, err
	}
	return result, r.storeV5ReceiptTx(ctx, tx, record, operation, requestHash, result, taskEffect)
}

func (r *OfflineV5Repository) Sync(ctx context.Context, input OfflineV5SyncInput, expected *OfflineV5AuthRecord, writes bool) (*OfflineV5SyncResult, error) {
	return r.sync(ctx, input, expected, writes, false, nil)
}

func (r *OfflineV5Repository) SyncWithPreprocessor(ctx context.Context, input OfflineV5SyncInput, expected *OfflineV5AuthRecord, writes bool, preprocess OfflineV5OperationPreprocessor) (*OfflineV5SyncResult, error) {
	return r.sync(ctx, input, expected, writes, false, preprocess)
}

func (r *OfflineV5Repository) SyncWithPolicy(ctx context.Context, input OfflineV5SyncInput, expected *OfflineV5AuthRecord, writes, forceReceiptOnly bool, preprocess OfflineV5OperationPreprocessor) (*OfflineV5SyncResult, error) {
	return r.sync(ctx, input, expected, writes, forceReceiptOnly, preprocess)
}

func (r *OfflineV5Repository) sync(ctx context.Context, input OfflineV5SyncInput, expected *OfflineV5AuthRecord, writes, forceReceiptOnly bool, preprocess OfflineV5OperationPreprocessor) (*OfflineV5SyncResult, error) {
	if expected == nil || input.GrantID == uuid.Nil || input.BrowserProfileID != expected.BrowserProfileID || input.GrantID != expected.GrantID ||
		input.ManifestID == uuid.Nil || input.ManifestRevision < 1 || len(input.Operations) > 100 || len(input.WantSnapshots) > domain.OfflineV5MaxResources {
		return nil, ErrOfflineV3Invalid
	}
	tx, err := r.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	record, err := r.LockActiveGrantTx(ctx, tx, input.GrantID)
	if err != nil {
		return nil, err
	}
	if record.OfflineV4Tuple != expected.OfflineV4Tuple || record.V5Revision != expected.V5Revision ||
		record.BrowserKeyThumbprint != expected.BrowserKeyThumbprint || record.GrantKeyThumbprint != expected.GrantKeyThumbprint ||
		record.GrantKeyThumbprint == "" || input.SelectionRevision != record.SelectionRevision {
		return nil, ErrOfflineV3AccessDenied
	}
	manifest, err := r.loadManifestTx(ctx, tx, record, input.ManifestID, input.ManifestRevision)
	receiptRecovery := errors.Is(err, errOfflineV5ManifestSuperseded)
	if receiptRecovery {
		manifest, err = r.loadSupersededManifestForReceiptRecoveryTx(ctx, tx, record, input.ManifestID, input.ManifestRevision)
	}
	if err != nil {
		return nil, err
	}
	if !offlineV5RequestedSnapshotsAllowed(manifest, input.WantSnapshots) {
		return nil, ErrOfflineV3AccessDenied
	}
	receiptOnly := receiptRecovery || len(input.Operations) > 0 && (forceReceiptOnly || !writes || !record.WritesEnabled)
	if err = offlineV5SyncWritesGate(receiptOnly, len(input.Operations), writes, record.WritesEnabled); err != nil {
		return nil, err
	}
	if err = consumeOfflineV5Challenge(ctx, tx, input.ChallengeID, uuid.Nil, input.GrantID, "sync", input.Nonce); err != nil {
		return nil, err
	}
	result := &OfflineV5SyncResult{Record: record, Receipts: []domain.OfflineV5OperationResult{}}
	if receiptOnly {
		result.Receipts, err = r.recoverV5ReceiptsTx(ctx, tx, record, manifest, input.Operations)
		if err != nil {
			if !receiptRecovery && errors.Is(err, ErrOfflineV3AccessDenied) {
				return nil, ErrOfflineV5WritesDisabled
			}
			return nil, err
		}
		result.RecoveredReceipts = true
		if _, err = tx.Exec(ctx, `INSERT INTO offline_v5_audit(browser_profile_id,grant_id,account_id,actor_id,event_type,metadata)
			VALUES($1,$2,$3,$4,'sync_delivery_recovered',jsonb_build_object('manifest_id',$5::text,'receipt_count',$6::int))`,
			record.BrowserProfileID, record.GrantID, record.AccountID, record.UserID, manifest.ID, len(result.Receipts)); err != nil {
			return nil, err
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return result, nil
	}
	seen := make(map[uuid.UUID]struct{}, len(input.Operations))
	for _, operation := range input.Operations {
		if _, duplicate := seen[operation.OperationID]; duplicate {
			return nil, ErrOfflineV3Invalid
		}
		seen[operation.OperationID] = struct{}{}
		receipt, err := r.applyV5OperationTx(ctx, tx, record, manifest, operation, preprocess)
		if err != nil {
			return nil, err
		}
		result.Receipts = append(result.Receipts, receipt)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return result, nil
}
