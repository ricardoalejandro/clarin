package repository

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

type offlineV3TaskCreate struct {
	Title        string     `json:"title"`
	Description  string     `json:"description"`
	ParentTaskID *uuid.UUID `json:"parent_task_id"`
	StartAt      *time.Time `json:"start_at"`
	DueAt        *time.Time `json:"due_at"`
	DueEndAt     *time.Time `json:"due_end_at"`
	IsAllDay     bool       `json:"is_all_day"`
	Priority     string     `json:"priority"`
}

// This DTO deliberately does not embed domain.Task: Contact/Lead/Event/Program
// associations, integration metadata and hidden parent names are not selected
// merely by selecting a task list.
type OfflineV3TaskValue struct {
	ID             uuid.UUID  `json:"id"`
	Version        int64      `json:"version"`
	ListID         *uuid.UUID `json:"list_id"`
	ParentTaskID   *uuid.UUID `json:"parent_task_id"`
	Title          string     `json:"title"`
	Description    string     `json:"description"`
	StartAt        *time.Time `json:"start_at"`
	DueAt          *time.Time `json:"due_at"`
	DueEndAt       *time.Time `json:"due_end_at"`
	IsAllDay       bool       `json:"is_all_day"`
	Priority       string     `json:"priority"`
	StatusID       *uuid.UUID `json:"status_id"`
	StatusCategory string     `json:"status_category"`
	SortOrder      int        `json:"sort_order"`
	Progress       int        `json:"progress"`
	CanComplete    bool       `json:"can_complete"`
}

var ErrOfflineV3DependencyPending = errors.New("offline_dependency_pending")

func OfflineV3TaskProjection(task *domain.Task) OfflineV3TaskValue {
	category := domain.TaskStatusCategoryNotStarted
	if task.StatusDetail != nil && task.StatusDetail.Category != "" {
		category = task.StatusDetail.Category
	} else if task.Status == domain.TaskStatusCompleted {
		category = domain.TaskStatusCategoryDone
	} else if task.Status == domain.TaskStatusCancelled {
		category = domain.TaskStatusCategoryCancelled
	}
	return OfflineV3TaskValue{ID: task.ID, Version: task.Version, ListID: task.ListID, ParentTaskID: task.ParentTaskID, Title: task.Title, Description: task.Description, StartAt: task.StartAt, DueAt: task.DueAt, DueEndAt: task.DueEndAt, IsAllDay: task.IsAllDay, Priority: task.Priority, StatusID: task.StatusID, StatusCategory: category, SortOrder: task.SortOrder, Progress: task.Progress}
}

func parseOfflineV3TaskCreate(raw json.RawMessage) (offlineV3TaskCreate, error) {
	var input offlineV3TaskCreate
	if len(raw) == 0 || len(raw) > 256*1024 || !utf8.Valid(raw) {
		return input, ErrOfflineV3Invalid
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		return input, ErrOfflineV3Invalid
	}
	if decoder.Decode(new(any)) != io.EOF {
		return input, ErrOfflineV3Invalid
	}
	// Exact field names, object shape and no duplicate fields. Case-folding is
	// not a second accepted wire protocol.
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || fields == nil {
		return input, ErrOfflineV3Invalid
	}
	for name := range fields {
		switch name {
		case "title", "description", "parent_task_id", "start_at", "due_at", "due_end_at", "is_all_day", "priority":
		default:
			return input, ErrOfflineV3Invalid
		}
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	_, _ = d.Token()
	seen := map[string]bool{}
	for d.More() {
		token, err := d.Token()
		if err != nil {
			return input, ErrOfflineV3Invalid
		}
		key, ok := token.(string)
		if !ok || seen[key] {
			return input, ErrOfflineV3Invalid
		}
		seen[key] = true
		var value json.RawMessage
		if d.Decode(&value) != nil {
			return input, ErrOfflineV3Invalid
		}
	}
	input.Title = strings.TrimSpace(input.Title)
	if input.Title == "" || utf8.RuneCountInString(input.Title) > 500 || len(input.Description) > 200000 {
		return input, ErrOfflineV3Invalid
	}
	if input.Priority == "" {
		input.Priority = domain.TaskPriorityMedium
	}
	switch input.Priority {
	case "low", "medium", "high", "urgent":
	default:
		return input, ErrOfflineV3Invalid
	}
	if input.StartAt != nil && input.DueAt != nil && input.StartAt.After(*input.DueAt) {
		return input, ErrOfflineV3Invalid
	}
	if input.DueEndAt != nil && (input.DueAt == nil || input.DueEndAt.Before(*input.DueAt)) {
		return input, ErrOfflineV3Invalid
	}
	return input, nil
}

func offlineV3TaskBindingValid(record *OfflineV3AuthRecord, operation domain.OfflineV3Operation, hash string) bool {
	decoded, err := hex.DecodeString(hash)
	return record != nil && err == nil && len(decoded) == 32 && hash == strings.ToLower(hash) && operation.ProtocolVersion == 3 && operation.GrantID == record.GrantID && operation.AccountID == record.AccountID && operation.UserID == record.UserID && operation.BrowserProfileID == record.BrowserProfileID && operation.OperationID != uuid.Nil && operation.ResourceID != uuid.Nil && operation.SelectionID != uuid.Nil && !operation.OccurredAt.IsZero() && operation.OccurredAt.Before(time.Now().Add(5*time.Minute)) && (operation.Action == domain.OfflineV3ActionTasksCreate || operation.Action == domain.OfflineV3ActionTasksComplete)
}

// ApplyTaskOperationTx must be called after verifying the operation signature,
// lease and exact current grant. It rechecks the database boundary under the
// grant lock. All logical results (including conflicts) get one durable receipt.
// The caller must roll back the WHOLE transaction on an error.
func (r *OfflineV3Repository) ApplyTaskOperationTx(ctx context.Context, tx pgx.Tx, record *OfflineV3AuthRecord, operation domain.OfflineV3Operation, requestHash string) (domain.OfflineV3OperationResult, error) {
	result := domain.OfflineV3OperationResult{OperationID: operation.OperationID, ResourceID: operation.ResourceID, Status: "rejected"}
	if !offlineV3TaskBindingValid(record, operation, requestHash) {
		return result, ErrOfflineV3Invalid
	}
	// Parent-to-child locking also serializes absent receipts. Never acquire a
	// child grant before its ancestors: revocation uses the same lock order.
	current, err := r.LockActiveGrantTx(ctx, tx, record.GrantID, domain.OfflineV3ActionTasksRead)
	if err != nil {
		return result, err
	}
	if current.OfflineV3Tuple != record.OfflineV3Tuple || current.CredentialEpoch != record.CredentialEpoch || current.AuthorityEpoch != record.AuthorityEpoch || current.GrantRevision != record.GrantRevision || current.SelectionRevision != record.SelectionRevision {
		return result, ErrOfflineV3AccessDenied
	}
	var storedHash string
	var storedResult json.RawMessage
	err = tx.QueryRow(ctx, `SELECT request_hash,result FROM offline_v3_receipts WHERE grant_id=$1 AND account_id=$2 AND operation_id=$3`, record.GrantID, record.AccountID, operation.OperationID).Scan(&storedHash, &storedResult)
	if err == nil {
		if storedHash != requestHash {
			return result, ErrOfflineV3ReceiptReuse
		}
		if json.Unmarshal(storedResult, &result) != nil {
			return result, ErrOfflineV3Invalid
		}
		return result, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return result, err
	}
	var actionAllowed bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM offline_v3_grant_actions WHERE grant_id=$1 AND account_id=$2 AND action_code=$3)`, record.GrantID, record.AccountID, operation.Action).Scan(&actionAllowed); err != nil {
		return result, err
	}
	if !actionAllowed {
		result.ErrorCode = "action_not_allowed"
		return result, r.storeTaskReceiptTx(ctx, tx, record, operation, requestHash, result, nil)
	}
	var selection domain.OfflineV3Selection
	selection.ID, selection.Module, selection.ResourceType = operation.SelectionID, domain.OfflineModuleTasks, domain.OfflineResourceTaskList
	err = tx.QueryRow(ctx, `SELECT resource_id FROM offline_v3_selections WHERE id=$1 AND grant_id=$2 AND account_id=$3 AND module='tasks' AND resource_type='task_list' FOR SHARE`, operation.SelectionID, record.GrantID, record.AccountID).Scan(&selection.ResourceID)
	if errors.Is(err, pgx.ErrNoRows) {
		result.ErrorCode = "outside_selection"
		return result, r.storeTaskReceiptTx(ctx, tx, record, operation, requestHash, result, nil)
	}
	if err != nil {
		return result, err
	}
	selectionAccess := domain.TaskAccessView
	if operation.Action == domain.OfflineV3ActionTasksCreate {
		selectionAccess = domain.TaskAccessEdit
	}
	if err := validateOfflineV3ResourceAccess(ctx, tx, record.UserID, record.AccountID, selection, selectionAccess); err != nil {
		if errors.Is(err, ErrOfflineV3AccessDenied) {
			result.ErrorCode = "access_revoked"
			return result, r.storeTaskReceiptTx(ctx, tx, record, operation, requestHash, result, nil)
		}
		return result, err
	}
	baseVersion := operation.BaseVersion
	if dependency := operation.DependsOnOperationID; dependency != nil {
		if *dependency == uuid.Nil || *dependency == operation.OperationID || operation.Action != domain.OfflineV3ActionTasksComplete || operation.BaseVersion != 0 {
			result.ErrorCode = "invalid_operation_dependency"
			return result, r.storeTaskReceiptTx(ctx, tx, record, operation, requestHash, result, nil)
		}
		var action, status string
		var resourceID uuid.UUID
		err := tx.QueryRow(ctx, `SELECT action_code,status,resource_id,COALESCE(server_version,0) FROM offline_v3_receipts WHERE grant_id=$1 AND account_id=$2 AND operation_id=$3`, record.GrantID, record.AccountID, *dependency).Scan(&action, &status, &resourceID, &baseVersion)
		if errors.Is(err, pgx.ErrNoRows) {
			return result, ErrOfflineV3DependencyPending
		}
		if err != nil {
			return result, err
		}
		if action != domain.OfflineV3ActionTasksCreate || status != "applied" || resourceID != operation.ResourceID || baseVersion < 1 {
			result.ErrorCode = "operation_dependency_rejected"
			return result, r.storeTaskReceiptTx(ctx, tx, record, operation, requestHash, result, nil)
		}
	}
	var canComplete bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM offline_v3_grant_actions WHERE grant_id=$1 AND account_id=$2 AND action_code=$3)`, record.GrantID, record.AccountID, domain.OfflineV3ActionTasksComplete).Scan(&canComplete); err != nil {
		return result, err
	}
	result, seed, err := applyOfflineTaskMutationTx(ctx, tx, r.db, offlineTaskAuthority{AccountID: record.AccountID, UserID: record.UserID, GrantID: record.GrantID}, operation, selection, baseVersion, canComplete, "offline_v3")
	if err != nil {
		return result, err
	}
	return result, r.storeTaskReceiptTx(ctx, tx, record, operation, requestHash, result, seed)
}

func offlineV3TaskStatusTx(ctx context.Context, tx pgx.Tx, accountID, listID uuid.UUID, category string) (uuid.UUID, error) {
	var id uuid.UUID
	err := tx.QueryRow(ctx, `SELECT status.id FROM task_lists list JOIN task_statuses status ON status.account_id=list.account_id AND status.workflow_id=list.workflow_id WHERE list.account_id=$1 AND list.id=$2 AND list.archived_at IS NULL AND list.deleted_at IS NULL AND status.category=$3 ORDER BY status.is_default DESC,status.sort_order,status.id LIMIT 1`, accountID, listID, category).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return id, ErrTaskStatusMappingInvalid
	}
	return id, err
}

func offlineV3LoadTaskTx(ctx context.Context, tx pgx.Tx, tasks *TaskRepository, accountID, userID, taskID uuid.UUID) (*domain.Task, error) {
	return tasks.scanTask(tx.QueryRow(ctx, `SELECT `+taskSelectFields+` FROM tasks t `+taskJoins+` WHERE t.account_id=$1 AND t.id=$2 AND t.deleted_at IS NULL AND `+taskActorCanViewIncludingArchivedSQL("t", "tl", "$3"), accountID, taskID, userID))
}

type OfflineV3TaskEffect struct {
	Origin      string    `json:"origin,omitempty"`
	ID          uuid.UUID `json:"id"`
	GrantID     uuid.UUID `json:"grant_id"`
	AccountID   uuid.UUID `json:"account_id"`
	OperationID uuid.UUID `json:"operation_id"`
	TaskID      uuid.UUID `json:"task_id"`
	ActorID     uuid.UUID `json:"actor_id"`
	Action      string    `json:"action"`
	TaskVersion int64     `json:"task_version"`
	// RelatedResourceID identifies a child resource created by the mutation
	// (currently an offline-v5 task comment). TaskID always remains the
	// account-scoped task used to authorize the realtime fanout.
	RelatedResourceID *uuid.UUID   `json:"related_resource_id,omitempty"`
	RecurrenceSeed    *domain.Task `json:"recurrence_seed,omitempty"`
}

func (r *OfflineV3Repository) storeTaskReceiptTx(ctx context.Context, tx pgx.Tx, record *OfflineV3AuthRecord, operation domain.OfflineV3Operation, hash string, result domain.OfflineV3OperationResult, seed *domain.Task) error {
	encoded, err := json.Marshal(result)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO offline_v3_receipts(grant_id,account_id,operation_id,request_hash,action_code,resource_id,status,error_code,server_version,result) VALUES($1,$2,$3,$4,$5,$6,$7,NULLIF($8,''),$9,$10::jsonb)`, record.GrantID, record.AccountID, operation.OperationID, hash, operation.Action, operation.ResourceID, result.Status, result.ErrorCode, result.ServerVersion, encoded); err != nil {
		return err
	}
	if result.Status == "conflict" {
		server := result.Result
		if len(server) == 0 {
			server = json.RawMessage(`{}`)
		}
		_, err := tx.Exec(ctx, `INSERT INTO offline_v3_conflicts(grant_id,account_id,operation_id,resource_id,base_version,server_version,client_change,server_value) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`, record.GrantID, record.AccountID, operation.OperationID, operation.ResourceID, operation.BaseVersion, result.ServerVersion, operation.Payload, server)
		return err
	}
	if result.Status != "applied" {
		return nil
	}
	effect := OfflineV3TaskEffect{ID: uuid.New(), GrantID: record.GrantID, AccountID: record.AccountID, OperationID: operation.OperationID, TaskID: operation.ResourceID, ActorID: record.UserID, Action: operation.Action, TaskVersion: result.ServerVersion, RecurrenceSeed: seed}
	payload, err := json.Marshal(effect)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO offline_v3_event_outbox(id,grant_id,account_id,operation_id,event_type,payload) VALUES($1,$2,$3,$4,'task_effect',$5::jsonb)`, effect.ID, record.GrantID, record.AccountID, operation.OperationID, payload)
	return err
}
