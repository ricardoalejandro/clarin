package repository

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/storage"
)

const (
	offlineV3MaxSnapshotBytes = 8 * 1024 * 1024
	offlineV3MaxSnapshotRows  = 5000
)

var ErrOfflineSnapshotTooLarge = errors.New("offline_resource_too_large")

// OfflineV3AssetLoader reads a private account-owned object with a hard byte
// ceiling. It is injected by the API layer so snapshot authorization and the
// immutable asset closure remain inside the same serializable transaction.
type OfflineV3AssetLoader func(ctx context.Context, accountID uuid.UUID, objectKey string, maxBytes int64) ([]byte, error)

func offlineV3ReadAction(module string) (string, bool) {
	switch module {
	case domain.OfflineModuleTasks:
		return domain.OfflineV3ActionTasksRead, true
	case domain.OfflineModuleContacts:
		return domain.OfflineV3ActionContactsRead, true
	case domain.OfflineModulePrograms:
		return domain.OfflineV3ActionProgramsRead, true
	case domain.OfflineModuleWhiteboards:
		return domain.OfflineV3ActionWhiteboardsRead, true
	default:
		return "", false
	}
}

// FetchSnapshotsV3 linearizes tuple authority, selection revision, actor ACL,
// canonical rows, payload hash and head version in one serializable
// transaction. A concurrent revoke/ACL/data write therefore either precedes
// this snapshot or forces a serialization retry; it cannot produce a mixed
// version/payload pair.
func (r *OfflineV3Repository) FetchSnapshotsV3(ctx context.Context, grantID uuid.UUID, expectedSelectionRevision int64, selectionIDs []uuid.UUID, loadAsset OfflineV3AssetLoader) ([]domain.OfflineV3Snapshot, error) {
	if grantID == uuid.Nil || expectedSelectionRevision < 1 || len(selectionIDs) == 0 || len(selectionIDs) > domain.OfflineV3MaxResources {
		return nil, ErrOfflineV3Invalid
	}
	seenIDs := make(map[uuid.UUID]struct{}, len(selectionIDs))
	for _, id := range selectionIDs {
		if id == uuid.Nil {
			return nil, ErrOfflineV3Invalid
		}
		if _, duplicate := seenIDs[id]; duplicate {
			return nil, ErrOfflineV3Invalid
		}
		seenIDs[id] = struct{}{}
	}
	tx, err := r.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	// Discover only the finite action set without taking a child lock. The
	// grant/authority barrier is the canonical prefix shared with selection
	// replacement and revocation; the exact rows are re-read and locked below.
	discoveryRows, err := tx.Query(ctx, `SELECT module FROM offline_v3_selections
		WHERE grant_id=$1 AND id=ANY($2::uuid[]) ORDER BY module,id`, grantID, selectionIDs)
	if err != nil {
		return nil, err
	}
	actions := map[string]struct{}{}
	discovered := 0
	for discoveryRows.Next() {
		var module string
		if err := discoveryRows.Scan(&module); err != nil {
			discoveryRows.Close()
			return nil, err
		}
		action, valid := offlineV3ReadAction(module)
		if !valid {
			discoveryRows.Close()
			return nil, ErrOfflineV3Invalid
		}
		actions[action] = struct{}{}
		discovered++
	}
	if err := discoveryRows.Err(); err != nil {
		discoveryRows.Close()
		return nil, err
	}
	discoveryRows.Close()
	if discovered != len(selectionIDs) {
		return nil, ErrOfflineV3AccessDenied
	}
	actionOrder := make([]string, 0, len(actions))
	for action := range actions {
		actionOrder = append(actionOrder, action)
	}
	sort.Strings(actionOrder)
	var record *OfflineV3AuthRecord
	for _, action := range actionOrder {
		record, err = r.LockActiveGrantTx(ctx, tx, grantID, action)
		if err != nil {
			return nil, err
		}
	}
	if record == nil || record.SelectionRevision != expectedSelectionRevision {
		return nil, ErrOfflineV3Conflict
	}
	rows, err := tx.Query(ctx, `SELECT id,grant_id,account_id,module,resource_type,resource_id
		FROM offline_v3_selections WHERE grant_id=$1 AND id=ANY($2::uuid[])
		ORDER BY module,resource_id,id FOR SHARE`, grantID, selectionIDs)
	if err != nil {
		return nil, err
	}
	selected := make([]domain.OfflineV3Selection, 0, len(selectionIDs))
	for rows.Next() {
		var item domain.OfflineV3Selection
		if err := rows.Scan(&item.ID, &item.GrantID, &item.AccountID, &item.Module, &item.ResourceType, &item.ResourceID); err != nil {
			rows.Close()
			return nil, err
		}
		selected = append(selected, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if len(selected) != len(selectionIDs) {
		return nil, ErrOfflineV3AccessDenied
	}
	for _, item := range selected {
		action, valid := offlineV3ReadAction(item.Module)
		if !valid {
			return nil, ErrOfflineV3Invalid
		}
		if _, approved := actions[action]; !approved {
			return nil, ErrOfflineV3AccessDenied
		}
		if item.AccountID != record.AccountID || record.SelectionRevision != expectedSelectionRevision {
			return nil, ErrOfflineV3Conflict
		}
		if err := validateOfflineV3ResourceAccess(ctx, tx, record.UserID, record.AccountID, item, domain.TaskAccessView); err != nil {
			return nil, err
		}
	}
	out := make([]domain.OfflineV3Snapshot, 0, len(selected))
	for _, item := range selected {
		payload, tombstone, err := offlineV3SnapshotPayload(ctx, tx, record.AccountID, record.UserID, item, loadAsset)
		if errors.Is(err, pgx.ErrNoRows) {
			payload, tombstone, err = json.RawMessage(`null`), true, nil
		}
		if err != nil {
			return nil, err
		}
		canonical, err := json.Marshal(json.RawMessage(payload))
		if err != nil || len(canonical) > offlineV3MaxSnapshotBytes {
			if err != nil {
				return nil, err
			}
			return nil, fmt.Errorf("%w: offline v3 snapshot exceeds per-resource limit", ErrOfflineSnapshotTooLarge)
		}
		digest := sha256.Sum256(canonical)
		contentHash := hex.EncodeToString(digest[:])
		var headVersion int64
		var previousHash *string
		if err := tx.QueryRow(ctx, `SELECT head_version,content_hash FROM offline_v3_resource_heads
			WHERE selection_id=$1 AND grant_id=$2 AND account_id=$3 FOR UPDATE`, item.ID, grantID, record.AccountID).
			Scan(&headVersion, &previousHash); err != nil {
			return nil, err
		}
		if previousHash != nil && *previousHash != "" && *previousHash != contentHash {
			headVersion++
		}
		if _, err := tx.Exec(ctx, `UPDATE offline_v3_resource_heads SET head_version=$4,content_hash=$5,updated_at=NOW()
			WHERE selection_id=$1 AND grant_id=$2 AND account_id=$3`, item.ID, grantID, record.AccountID, headVersion, contentHash); err != nil {
			return nil, err
		}
		out = append(out, domain.OfflineV3Snapshot{
			ProtocolVersion: domain.OfflineV3ProtocolVersion,
			GrantID:         grantID, UserID: record.UserID, AccountID: record.AccountID,
			SelectionID: item.ID, Module: item.Module, ResourceType: item.ResourceType, ResourceID: item.ResourceID,
			SelectionRevision: record.SelectionRevision, HeadVersion: headVersion, ContentHash: contentHash,
			Payload: json.RawMessage(canonical), Tombstone: tombstone, GeneratedAt: time.Now().UTC(),
		})
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// ConfirmSnapshotsIssued closes the storage/signing race. The API calls it
// after every snapshot has been signed and sealed but before returning bytes to
// the transport. Revocation, ACL/epoch changes, selection replacement, or a
// newer canonical head make the whole response fail closed.
func (r *OfflineV3Repository) ConfirmSnapshotsIssued(ctx context.Context, expected *OfflineV3AuthRecord, snapshots []domain.OfflineV3Snapshot) error {
	if expected == nil || len(snapshots) == 0 || len(snapshots) > domain.OfflineV3MaxResources {
		return ErrOfflineV3Invalid
	}
	actions := map[string]struct{}{}
	for _, snapshot := range snapshots {
		action, ok := offlineV3ReadAction(snapshot.Module)
		if !ok || snapshot.GrantID != expected.GrantID || snapshot.AccountID != expected.AccountID || snapshot.UserID != expected.UserID ||
			snapshot.SelectionRevision != expected.SelectionRevision || snapshot.SelectionID == uuid.Nil || snapshot.ResourceID == uuid.Nil {
			return ErrOfflineV3AccessDenied
		}
		actions[action] = struct{}{}
	}
	actionOrder := make([]string, 0, len(actions))
	for action := range actions {
		actionOrder = append(actionOrder, action)
	}
	sort.Strings(actionOrder)
	tx, err := r.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var current *OfflineV3AuthRecord
	for _, action := range actionOrder {
		current, err = r.LockActiveGrantTx(ctx, tx, expected.GrantID, action)
		if err != nil {
			return err
		}
	}
	if current == nil || current.OfflineV3Tuple != expected.OfflineV3Tuple || current.CredentialEpoch != expected.CredentialEpoch ||
		current.AuthorityEpoch != expected.AuthorityEpoch || current.InstallationRevision != expected.InstallationRevision ||
		current.PrincipalRevision != expected.PrincipalRevision || current.BrowserRevision != expected.BrowserRevision ||
		current.AuthorizationRevision != expected.AuthorizationRevision || current.GrantRevision != expected.GrantRevision ||
		current.SelectionRevision != expected.SelectionRevision || current.SelectionDigest != expected.SelectionDigest ||
		current.BrowserKeyThumbprint != expected.BrowserKeyThumbprint || current.GrantSigningThumbprint != expected.GrantSigningThumbprint ||
		current.GrantEncryptionThumbprint != expected.GrantEncryptionThumbprint {
		return ErrOfflineV3AccessDenied
	}
	for _, snapshot := range snapshots {
		var module, resourceType, contentHash string
		var resourceID uuid.UUID
		var headVersion int64
		if err := tx.QueryRow(ctx, `SELECT selection.module,selection.resource_type,selection.resource_id,head.head_version,COALESCE(head.content_hash,'')
			FROM offline_v3_selections selection JOIN offline_v3_resource_heads head
			  ON head.selection_id=selection.id AND head.grant_id=selection.grant_id AND head.account_id=selection.account_id
			WHERE selection.id=$1 AND selection.grant_id=$2 AND selection.account_id=$3 FOR SHARE OF selection,head`,
			snapshot.SelectionID, expected.GrantID, expected.AccountID).Scan(&module, &resourceType, &resourceID, &headVersion, &contentHash); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrOfflineV3AccessDenied
			}
			return err
		}
		if module != snapshot.Module || resourceType != snapshot.ResourceType || resourceID != snapshot.ResourceID ||
			headVersion != snapshot.HeadVersion || contentHash != snapshot.ContentHash {
			return ErrOfflineV3Conflict
		}
		// Snapshot construction and signing are separated by an external signer
		// call. Re-evaluate the actor's canonical resource ACL at the final
		// delivery barrier so an access revocation committed while the signer was
		// working cannot release an otherwise coherent but newly forbidden
		// snapshot.
		selection := domain.OfflineV3Selection{
			ID:           snapshot.SelectionID,
			GrantID:      snapshot.GrantID,
			AccountID:    snapshot.AccountID,
			Module:       module,
			ResourceType: resourceType,
			ResourceID:   resourceID,
		}
		if err := validateOfflineV3ResourceAccess(ctx, tx, current.UserID, current.AccountID, selection, domain.TaskAccessView); err != nil {
			if errors.Is(err, ErrOfflineV3AccessDenied) {
				return ErrOfflineV3AccessDenied
			}
			return err
		}
	}
	return tx.Commit(ctx)
}

func offlineV3SnapshotPayload(ctx context.Context, tx pgx.Tx, accountID, userID uuid.UUID, item domain.OfflineV3Selection, loadAsset OfflineV3AssetLoader) (json.RawMessage, bool, error) {
	switch item.ResourceType {
	case domain.OfflineResourceTaskList:
		payload, err := offlineV3TaskListSnapshot(ctx, tx, accountID, userID, item.GrantID, item.ResourceID)
		return payload, false, err
	case domain.OfflineResourceContact:
		payload, err := offlineV3ContactSnapshot(ctx, tx, accountID, item.ResourceID)
		return payload, false, err
	case domain.OfflineResourceProgram:
		payload, err := offlineV3ProgramSnapshot(ctx, tx, accountID, item.ResourceID)
		return payload, false, err
	case domain.OfflineResourceWhiteboard:
		payload, err := offlineV3WhiteboardSnapshot(ctx, tx, accountID, item.ResourceID, loadAsset)
		return payload, false, err
	default:
		return nil, false, ErrOfflineV3Invalid
	}
}

type offlineV3TaskDTO struct {
	ID             uuid.UUID  `json:"id"`
	Version        int64      `json:"version"`
	Title          string     `json:"title"`
	Description    string     `json:"description"`
	StartAt        *time.Time `json:"start_at,omitempty"`
	DueAt          *time.Time `json:"due_at,omitempty"`
	DueEndAt       *time.Time `json:"due_end_at,omitempty"`
	IsAllDay       bool       `json:"is_all_day"`
	Priority       string     `json:"priority"`
	StatusID       *uuid.UUID `json:"status_id,omitempty"`
	StatusCategory string     `json:"status_category"`
	ListID         uuid.UUID  `json:"list_id"`
	SortOrder      int        `json:"sort_order"`
	Progress       int        `json:"progress"`
	ParentTaskID   *uuid.UUID `json:"parent_task_id,omitempty"`
	CanComplete    bool       `json:"can_complete"`
	UpdatedAt      time.Time  `json:"updated_at"`
}

func offlineV3TaskListSnapshot(ctx context.Context, tx pgx.Tx, accountID, userID, grantID, listID uuid.UUID) (json.RawMessage, error) {
	var createApproved, completeApproved bool
	if err := tx.QueryRow(ctx, `SELECT
		EXISTS(SELECT 1 FROM offline_v3_grant_actions WHERE grant_id=$1 AND account_id=$2 AND action_code=$3),
		EXISTS(SELECT 1 FROM offline_v3_grant_actions WHERE grant_id=$1 AND account_id=$2 AND action_code=$4)`,
		grantID, accountID, domain.OfflineV3ActionTasksCreate, domain.OfflineV3ActionTasksComplete).Scan(&createApproved, &completeApproved); err != nil {
		return nil, err
	}
	return offlineTaskListSnapshot(ctx, tx, accountID, userID, listID, createApproved, completeApproved)
}

// The projection is transport-independent; callers supply approved actions
// only after applying their own transactional authority boundary.
func offlineTaskListSnapshot(ctx context.Context, tx pgx.Tx, accountID, userID, listID uuid.UUID, createApproved, completeApproved bool) (json.RawMessage, error) {
	var list struct {
		ID              uuid.UUID `json:"id"`
		Name            string    `json:"name"`
		Description     string    `json:"description"`
		Color           string    `json:"color"`
		Icon            string    `json:"icon"`
		EnvironmentID   uuid.UUID `json:"environment_id"`
		EnvironmentName string    `json:"environment_name"`
		WorkflowID      uuid.UUID `json:"workflow_id"`
		WorkflowName    string    `json:"workflow_name"`
		CanCreate       bool      `json:"can_create"`
	}
	if err := tx.QueryRow(ctx, `SELECT list_item.id,list_item.name,COALESCE(list_item.description,''),COALESCE(list_item.color,''),
		COALESCE(list_item.icon,'list'),environment.id,environment.name,workflow.id,workflow.name
		FROM task_lists list_item
		JOIN task_environments environment ON environment.id=list_item.environment_id AND environment.account_id=list_item.account_id
		JOIN task_workflows workflow ON workflow.id=list_item.workflow_id AND workflow.account_id=list_item.account_id
		WHERE list_item.account_id=$1 AND list_item.id=$2 AND list_item.archived_at IS NULL AND list_item.deleted_at IS NULL
		  AND environment.archived_at IS NULL AND environment.deleted_at IS NULL FOR SHARE OF list_item,environment,workflow`, accountID, listID).
		Scan(&list.ID, &list.Name, &list.Description, &list.Color, &list.Icon, &list.EnvironmentID, &list.EnvironmentName, &list.WorkflowID, &list.WorkflowName); err != nil {
		return nil, err
	}
	listAccess, _, err := resolveContainerAccessWith(ctx, tx, accountID, userID, listID, domain.TaskAccessTargetList)
	if err != nil {
		return nil, err
	}
	list.CanCreate = createApproved && TaskAccessAllows(listAccess, domain.TaskAccessEdit)
	statusRows, err := tx.Query(ctx, `SELECT id,name,color,category,sort_order,is_default FROM task_statuses
		WHERE account_id=$1 AND workflow_id=$2 ORDER BY sort_order,id`, accountID, list.WorkflowID)
	if err != nil {
		return nil, err
	}
	type statusDTO struct {
		ID        uuid.UUID `json:"id"`
		Name      string    `json:"name"`
		Color     string    `json:"color"`
		Category  string    `json:"category"`
		SortOrder int       `json:"sort_order"`
		IsDefault bool      `json:"is_default"`
	}
	statuses := make([]statusDTO, 0)
	for statusRows.Next() {
		var status statusDTO
		if err := statusRows.Scan(&status.ID, &status.Name, &status.Color, &status.Category, &status.SortOrder, &status.IsDefault); err != nil {
			statusRows.Close()
			return nil, err
		}
		statuses = append(statuses, status)
	}
	if err := statusRows.Err(); err != nil {
		statusRows.Close()
		return nil, err
	}
	statusRows.Close()
	taskRows, err := tx.Query(ctx, `SELECT task.id,COALESCE(task.version,1),task.title,COALESCE(task.description,''),task.start_at,task.due_at,task.due_end_at,
		COALESCE(task.is_all_day,FALSE),task.priority,task.status_id,
		COALESCE(status.category,CASE task.status WHEN 'completed' THEN 'done' WHEN 'cancelled' THEN 'cancelled' ELSE 'not_started' END),
		task.list_id,COALESCE(task.sort_order,0),
		CASE WHEN COALESCE(status.category,'')='done' THEN 100 ELSE COALESCE(task.progress,0) END,
		task.parent_task_id,($5::boolean AND (`+taskActorAccessRankSQL("task", "list_item", "$3")+`) >= 3
		 AND COALESCE(status.category,CASE task.status WHEN 'completed' THEN 'done' WHEN 'cancelled' THEN 'cancelled' ELSE 'not_started' END)
		 NOT IN ('done','cancelled')),task.updated_at
		FROM tasks task
		JOIN task_lists list_item ON list_item.account_id=task.account_id AND list_item.id=task.list_id
		LEFT JOIN task_statuses status ON status.account_id=task.account_id AND status.id=task.status_id
		WHERE task.account_id=$1 AND task.list_id=$2 AND task.deleted_at IS NULL
		  AND `+taskActorCanViewSQL("task", "list_item", "$3")+`
		ORDER BY (task.parent_task_id IS NOT NULL),task.sort_order,task.id LIMIT $4`, accountID, listID, userID, offlineV3MaxSnapshotRows+1, completeApproved)
	if err != nil {
		return nil, err
	}
	tasks := make([]offlineV3TaskDTO, 0)
	for taskRows.Next() {
		var task offlineV3TaskDTO
		if err := taskRows.Scan(&task.ID, &task.Version, &task.Title, &task.Description, &task.StartAt, &task.DueAt, &task.DueEndAt,
			&task.IsAllDay, &task.Priority, &task.StatusID, &task.StatusCategory, &task.ListID, &task.SortOrder, &task.Progress,
			&task.ParentTaskID, &task.CanComplete, &task.UpdatedAt); err != nil {
			taskRows.Close()
			return nil, err
		}
		tasks = append(tasks, task)
	}
	if err := taskRows.Err(); err != nil {
		taskRows.Close()
		return nil, err
	}
	taskRows.Close()
	if len(tasks) > offlineV3MaxSnapshotRows {
		return nil, fmt.Errorf("%w: offline v3 task selection requires pagination", ErrOfflineSnapshotTooLarge)
	}
	return json.Marshal(map[string]any{"list": list, "statuses": statuses, "tasks": tasks})
}

func offlineV3ContactSnapshot(ctx context.Context, tx pgx.Tx, accountID, contactID uuid.UUID) (json.RawMessage, error) {
	var contact struct {
		ID           uuid.UUID  `json:"id"`
		DisplayName  string     `json:"display_name"`
		Name         *string    `json:"name,omitempty"`
		CustomName   *string    `json:"custom_name,omitempty"`
		LastName     *string    `json:"last_name,omitempty"`
		ShortName    *string    `json:"short_name,omitempty"`
		Phone        *string    `json:"phone,omitempty"`
		Email        *string    `json:"email,omitempty"`
		Company      *string    `json:"company,omitempty"`
		Age          *int       `json:"age,omitempty"`
		DNI          *string    `json:"dni,omitempty"`
		BirthDate    *time.Time `json:"birth_date,omitempty"`
		Address      *string    `json:"address,omitempty"`
		District     *string    `json:"district,omitempty"`
		Occupation   *string    `json:"occupation,omitempty"`
		Notes        *string    `json:"notes,omitempty"`
		DoNotContact bool       `json:"do_not_contact"`
		UpdatedAt    time.Time  `json:"updated_at"`
	}
	if err := tx.QueryRow(ctx, `SELECT id,COALESCE(NULLIF(BTRIM(custom_name),''),NULLIF(BTRIM(name),''),NULLIF(BTRIM(push_name),''),phone,'Contacto'),
		name,custom_name,last_name,short_name,phone,email,company,age,dni,birth_date,address,NULLIF(distrito,''),NULLIF(ocupacion,''),notes,
		COALESCE(do_not_contact,FALSE),updated_at FROM contacts
		WHERE account_id=$1 AND id=$2 AND is_group=FALSE FOR SHARE`, accountID, contactID).Scan(&contact.ID, &contact.DisplayName,
		&contact.Name, &contact.CustomName, &contact.LastName, &contact.ShortName, &contact.Phone, &contact.Email, &contact.Company, &contact.Age, &contact.DNI,
		&contact.BirthDate, &contact.Address, &contact.District, &contact.Occupation, &contact.Notes, &contact.DoNotContact, &contact.UpdatedAt); err != nil {
		return nil, err
	}
	type phoneDTO struct {
		ID    uuid.UUID `json:"id"`
		Phone string    `json:"phone"`
		Label string    `json:"label"`
	}
	phones := make([]phoneDTO, 0)
	rows, err := tx.Query(ctx, `SELECT phone_item.id,phone_item.phone,COALESCE(phone_item.label,'mobile')
		FROM contact_phones phone_item JOIN contacts contact ON contact.id=phone_item.contact_id AND contact.account_id=$1
		WHERE phone_item.contact_id=$2 ORDER BY phone_item.created_at,phone_item.id`, accountID, contactID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var item phoneDTO
		if err := rows.Scan(&item.ID, &item.Phone, &item.Label); err != nil {
			rows.Close()
			return nil, err
		}
		phones = append(phones, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	type tagDTO struct {
		ID    uuid.UUID `json:"id"`
		Name  string    `json:"name"`
		Color string    `json:"color"`
	}
	tags := make([]tagDTO, 0)
	rows, err = tx.Query(ctx, `SELECT tag_item.id,tag_item.name,tag_item.color FROM contact_tags link JOIN tags tag_item ON tag_item.id=link.tag_id AND tag_item.account_id=$1 WHERE link.contact_id=$2 ORDER BY LOWER(tag_item.name),tag_item.id`, accountID, contactID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var item tagDTO
		if err := rows.Scan(&item.ID, &item.Name, &item.Color); err != nil {
			rows.Close()
			return nil, err
		}
		tags = append(tags, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	type observationDTO struct {
		ID        uuid.UUID `json:"id"`
		Type      string    `json:"type"`
		Notes     string    `json:"notes"`
		Author    string    `json:"author"`
		CreatedAt time.Time `json:"created_at"`
	}
	observations := make([]observationDTO, 0)
	rows, err = tx.Query(ctx, `SELECT interaction.id,interaction.type,COALESCE(interaction.notes,''),COALESCE(NULLIF(author.display_name,''),author.username,''),interaction.created_at
		FROM interactions interaction LEFT JOIN users author ON author.id=interaction.created_by
		WHERE interaction.account_id=$1 AND interaction.contact_id=$2 AND interaction.lead_id IS NULL AND interaction.event_id IS NULL
		  AND interaction.participant_id IS NULL AND interaction.program_id IS NULL AND interaction.program_session_id IS NULL
		  AND interaction.program_participant_id IS NULL ORDER BY interaction.created_at,interaction.id LIMIT 1001`, accountID, contactID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var item observationDTO
		if err := rows.Scan(&item.ID, &item.Type, &item.Notes, &item.Author, &item.CreatedAt); err != nil {
			rows.Close()
			return nil, err
		}
		observations = append(observations, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if len(observations) > 1000 {
		return nil, fmt.Errorf("%w: offline v3 contact observations require pagination", ErrOfflineSnapshotTooLarge)
	}
	type fieldDTO struct {
		ID     uuid.UUID       `json:"id"`
		Name   string          `json:"name"`
		Type   string          `json:"type"`
		Text   *string         `json:"text,omitempty"`
		Number *string         `json:"number,omitempty"`
		Date   *time.Time      `json:"date,omitempty"`
		Bool   *bool           `json:"bool,omitempty"`
		JSON   json.RawMessage `json:"json,omitempty"`
	}
	fields := make([]fieldDTO, 0)
	rows, err = tx.Query(ctx, `SELECT definition.id,definition.name,definition.field_type,value.value_text,value.value_number::text,value.value_date,value.value_bool,value.value_json
		FROM custom_field_values value JOIN custom_field_definitions definition ON definition.id=value.field_id AND definition.account_id=$1
		WHERE value.contact_id=$2 ORDER BY definition.sort_order,definition.id`, accountID, contactID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var item fieldDTO
		if err := rows.Scan(&item.ID, &item.Name, &item.Type, &item.Text, &item.Number, &item.Date, &item.Bool, &item.JSON); err != nil {
			rows.Close()
			return nil, err
		}
		fields = append(fields, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	return json.Marshal(map[string]any{"contact": contact, "phones": phones, "tags": tags, "direct_observations": observations, "custom_fields": fields})
}

func offlineV3ProgramSnapshot(ctx context.Context, tx pgx.Tx, accountID, programID uuid.UUID) (json.RawMessage, error) {
	var program struct {
		ID          uuid.UUID `json:"id"`
		Name        string    `json:"name"`
		Description string    `json:"description"`
		Status      string    `json:"status"`
		Color       string    `json:"color"`
		UpdatedAt   time.Time `json:"updated_at"`
	}
	if err := tx.QueryRow(ctx, `SELECT id,name,COALESCE(description,''),status,color,updated_at FROM programs WHERE account_id=$1 AND id=$2 AND COALESCE(type,'course')='course' FOR SHARE`, accountID, programID).Scan(&program.ID, &program.Name, &program.Description, &program.Status, &program.Color, &program.UpdatedAt); err != nil {
		return nil, err
	}
	type participantDTO struct {
		ID          uuid.UUID  `json:"id"`
		ContactID   uuid.UUID  `json:"contact_id"`
		Name        string     `json:"name"`
		Phone       *string    `json:"phone,omitempty"`
		Status      string     `json:"status"`
		EnrolledAt  time.Time  `json:"enrolled_at"`
		DroppedAt   *time.Time `json:"dropped_at,omitempty"`
		CompletedAt *time.Time `json:"completed_at,omitempty"`
		// Version is the exact optimistic-concurrency token consumed by the
		// offline-v5 lifecycle command. Participants have lifecycle dates rather
		// than updated_at, so a zero/inferred client version is unsafe.
		Version int64 `json:"version"`
	}
	active := make([]participantDTO, 0)
	history := make([]participantDTO, 0)
	rows, err := tx.Query(ctx, `SELECT participant.id,participant.contact_id,COALESCE(NULLIF(BTRIM(contact.custom_name),''),NULLIF(BTRIM(contact.name),''),contact.phone,'Contacto'),contact.phone,
		participant.status,participant.enrolled_at,participant.dropped_at,participant.completed_at
		FROM program_participants participant JOIN programs program ON program.id=participant.program_id AND program.account_id=$1
		JOIN contacts contact ON contact.id=participant.contact_id AND contact.account_id=program.account_id
		WHERE participant.program_id=$2 ORDER BY participant.enrolled_at,participant.id LIMIT $3`, accountID, programID, offlineV3MaxSnapshotRows+1)
	if err != nil {
		return nil, err
	}
	count := 0
	for rows.Next() {
		var item participantDTO
		if err := rows.Scan(&item.ID, &item.ContactID, &item.Name, &item.Phone, &item.Status, &item.EnrolledAt, &item.DroppedAt, &item.CompletedAt); err != nil {
			rows.Close()
			return nil, err
		}
		item.Version = item.EnrolledAt.UnixMicro()
		if item.DroppedAt != nil {
			item.Version = item.DroppedAt.UnixMicro()
		} else if item.CompletedAt != nil {
			item.Version = item.CompletedAt.UnixMicro()
		}
		count++
		if item.DroppedAt == nil && item.CompletedAt == nil && item.Status != "dropped" && item.Status != "completed" {
			active = append(active, item)
		} else {
			history = append(history, item)
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if count > offlineV3MaxSnapshotRows {
		return nil, fmt.Errorf("%w: offline v3 program roster requires pagination", ErrOfflineSnapshotTooLarge)
	}
	type sessionDTO struct {
		ID          uuid.UUID `json:"id"`
		Date        time.Time `json:"date"`
		Title       string    `json:"title"`
		Topic       *string   `json:"topic,omitempty"`
		SessionType string    `json:"session_type"`
		StartTime   *string   `json:"start_time,omitempty"`
		EndTime     *string   `json:"end_time,omitempty"`
		Location    *string   `json:"location,omitempty"`
		UpdatedAt   time.Time `json:"updated_at"`
		Version     int64     `json:"version"`
	}
	sessions := make([]sessionDTO, 0)
	rows, err = tx.Query(ctx, `SELECT session.id,session.date,COALESCE(session.title,''),session.topic,session.session_type,session.start_time,session.end_time,session.location,session.updated_at
		FROM program_sessions session WHERE session.account_id=$1 AND session.program_id=$2 ORDER BY session.date,session.id LIMIT $3`, accountID, programID, offlineV3MaxSnapshotRows+1)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var item sessionDTO
		if err := rows.Scan(&item.ID, &item.Date, &item.Title, &item.Topic, &item.SessionType, &item.StartTime, &item.EndTime, &item.Location, &item.UpdatedAt); err != nil {
			rows.Close()
			return nil, err
		}
		item.Version = item.UpdatedAt.UnixMicro()
		sessions = append(sessions, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if len(sessions) > offlineV3MaxSnapshotRows {
		return nil, fmt.Errorf("%w: offline v3 program sessions require pagination", ErrOfflineSnapshotTooLarge)
	}
	type attendanceDTO struct {
		ID            uuid.UUID `json:"id"`
		SessionID     uuid.UUID `json:"session_id"`
		ParticipantID uuid.UUID `json:"participant_id"`
		Status        string    `json:"status"`
		Notes         string    `json:"notes"`
		SessionDate   time.Time `json:"session_date"`
		UpdatedAt     time.Time `json:"updated_at"`
		// Version is keyed by (session_id,participant_id), not the attendance
		// row UUID, because that is the canonical upsert identity.
		Version int64 `json:"version"`
	}
	eligible := make([]attendanceDTO, 0)
	outside := make([]attendanceDTO, 0)
	rows, err = tx.Query(ctx, `SELECT attendance.id,attendance.session_id,attendance.participant_id,attendance.status,COALESCE(attendance.notes,''),session.date,attendance.updated_at,
		(session.date>=participant.enrolled_at AND (participant.dropped_at IS NULL OR session.date<participant.dropped_at) AND (participant.completed_at IS NULL OR session.date<participant.completed_at)) AS eligible
		FROM program_attendance attendance
		JOIN program_sessions session ON session.id=attendance.session_id AND session.account_id=$1 AND session.program_id=$2
		JOIN program_participants participant ON participant.id=attendance.participant_id AND participant.program_id=session.program_id
		JOIN contacts contact ON contact.id=participant.contact_id AND contact.account_id=session.account_id
		ORDER BY session.date,attendance.id LIMIT $3`, accountID, programID, offlineV3MaxSnapshotRows+1)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var item attendanceDTO
		var inWindow bool
		if err := rows.Scan(&item.ID, &item.SessionID, &item.ParticipantID, &item.Status, &item.Notes, &item.SessionDate, &item.UpdatedAt, &inWindow); err != nil {
			rows.Close()
			return nil, err
		}
		item.Version = item.UpdatedAt.UnixMicro()
		if inWindow {
			eligible = append(eligible, item)
		} else {
			outside = append(outside, item)
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if len(eligible)+len(outside) > offlineV3MaxSnapshotRows {
		return nil, fmt.Errorf("%w: offline v3 program attendance requires pagination", ErrOfflineSnapshotTooLarge)
	}
	return json.Marshal(map[string]any{"program": program, "active_roster": active, "historical_participations": history, "sessions": sessions, "eligible_attendance": eligible, "out_of_window_history": outside})
}

func offlineV3WhiteboardSnapshot(ctx context.Context, tx pgx.Tx, accountID, boardID uuid.UUID, loadAsset OfflineV3AssetLoader) (json.RawMessage, error) {
	var board struct {
		ID          uuid.UUID       `json:"id"`
		Name        string          `json:"name"`
		Description string          `json:"description"`
		Scene       json.RawMessage `json:"scene"`
		Schema      string          `json:"scene_schema_version"`
		Editor      string          `json:"editor_version"`
		Sequence    int64           `json:"sequence"`
		Version     int64           `json:"version"`
		UpdatedAt   time.Time       `json:"updated_at"`
	}
	if err := tx.QueryRow(ctx, `SELECT id,name,description,scene_json,scene_schema_version,editor_version,scene_sequence,version,updated_at FROM whiteboards
		WHERE account_id=$1 AND id=$2 AND archived_at IS NULL FOR SHARE`, accountID, boardID).Scan(&board.ID, &board.Name, &board.Description, &board.Scene, &board.Schema, &board.Editor, &board.Sequence, &board.Version, &board.UpdatedAt); err != nil {
		return nil, err
	}
	fileIDs := offlineV3ReferencedWhiteboardFiles(board.Scene)
	type assetDTO struct {
		FileID      string `json:"file_id"`
		ContentHash string `json:"content_hash"`
		ContentType string `json:"content_type"`
		DataBase64  string `json:"data_base64"`
		SizeBytes   int64  `json:"size_bytes"`
	}
	assets := make([]assetDTO, 0)
	if len(fileIDs) > 0 {
		if loadAsset == nil {
			return nil, fmt.Errorf("offline v3 whiteboard asset loader unavailable")
		}
		type storedAsset struct {
			FileID      string
			ContentHash string
			ContentType string
			ObjectKey   string
			SizeBytes   int64
		}
		stored := make([]storedAsset, 0, len(fileIDs))
		rows, err := tx.Query(ctx, `SELECT asset.file_id,media.content_hash,media.content_type,media.object_key,media.size_bytes FROM whiteboard_assets asset
		JOIN media_assets media ON media.id=asset.media_asset_id AND media.account_id=asset.account_id AND media.status='active' AND media.deleted_at IS NULL
		WHERE asset.account_id=$1 AND asset.board_id=$2 AND asset.kind='asset' AND asset.committed_at IS NOT NULL AND asset.file_id=ANY($3::text[])
		ORDER BY asset.file_id FOR SHARE OF asset,media`, accountID, boardID, fileIDs)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var item storedAsset
			if err := rows.Scan(&item.FileID, &item.ContentHash, &item.ContentType, &item.ObjectKey, &item.SizeBytes); err != nil {
				rows.Close()
				return nil, err
			}
			stored = append(stored, item)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
		if len(stored) != len(fileIDs) {
			return nil, fmt.Errorf("offline v3 whiteboard asset closure incomplete")
		}
		remaining := int64(offlineV3MaxSnapshotBytes)
		for _, item := range stored {
			if !storage.IsAccountWhiteboardObjectKey(accountID, item.ObjectKey) {
				return nil, ErrOfflineV3AccessDenied
			}
			contentType := strings.ToLower(strings.TrimSpace(item.ContentType))
			switch contentType {
			case "image/png", "image/jpeg", "image/webp", "image/gif":
			default:
				return nil, fmt.Errorf("offline v3 whiteboard asset type unsupported")
			}
			if item.SizeBytes < 0 || item.SizeBytes > remaining {
				return nil, fmt.Errorf("%w: offline v3 whiteboard asset closure exceeds limit", ErrOfflineSnapshotTooLarge)
			}
			data, err := loadAsset(ctx, accountID, item.ObjectKey, remaining)
			if err != nil || int64(len(data)) != item.SizeBytes {
				return nil, fmt.Errorf("offline v3 whiteboard asset unavailable or corrupt")
			}
			digest := sha256.Sum256(data)
			hash := hex.EncodeToString(digest[:])
			storedHash := strings.TrimPrefix(strings.ToLower(strings.TrimSpace(item.ContentHash)), domain.MediaAssetHashWhiteboardPrefix)
			if hash != storedHash {
				return nil, fmt.Errorf("offline v3 whiteboard asset unavailable or corrupt")
			}
			remaining -= int64(len(data))
			assets = append(assets, assetDTO{FileID: item.FileID, ContentHash: hash, ContentType: contentType,
				DataBase64: base64.StdEncoding.EncodeToString(data), SizeBytes: int64(len(data))})
		}
	}
	return json.Marshal(map[string]any{"whiteboard": board, "referenced_assets": assets})
}

func offlineV3ReferencedWhiteboardFiles(scene json.RawMessage) []string {
	var decoded struct {
		Elements []struct {
			FileID    string `json:"fileId"`
			IsDeleted bool   `json:"isDeleted"`
		} `json:"elements"`
	}
	if json.Unmarshal(scene, &decoded) != nil {
		return []string{}
	}
	seen := map[string]struct{}{}
	for _, element := range decoded.Elements {
		if element.IsDeleted || element.FileID == "" {
			continue
		}
		seen[element.FileID] = struct{}{}
	}
	out := make([]string, 0, len(seen))
	for id := range seen {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}
