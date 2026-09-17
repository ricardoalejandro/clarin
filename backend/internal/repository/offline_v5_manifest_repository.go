package repository

import (
	"bytes"
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

type OfflineV5PrepareResult struct {
	Record    *OfflineV5AuthRecord
	Manifest  domain.OfflineV5Manifest
	Snapshots []domain.OfflineV5Snapshot
}

type offlineV5WhiteboardAssetDescriptor struct {
	ID             uuid.UUID `json:"id"`
	RootResourceID uuid.UUID `json:"root_resource_id"`
	FileID         string    `json:"file_id"`
	ContentHash    string    `json:"content_hash"`
	ContentType    string    `json:"content_type"`
	SizeBytes      int64     `json:"size_bytes"`
}

type offlineV5WhiteboardStoredAsset struct {
	offlineV5WhiteboardAssetDescriptor
	ObjectKey string
}

func offlineV5WhiteboardDescriptor(accountID, boardID uuid.UUID, item offlineV5WhiteboardStoredAsset) (offlineV5WhiteboardAssetDescriptor, error) {
	if item.ID == uuid.Nil || item.FileID == "" || !storage.IsAccountWhiteboardObjectKey(accountID, item.ObjectKey) {
		return offlineV5WhiteboardAssetDescriptor{}, ErrOfflineV3AccessDenied
	}
	item.RootResourceID = boardID
	item.ContentType = strings.ToLower(strings.TrimSpace(strings.SplitN(item.ContentType, ";", 2)[0]))
	switch item.ContentType {
	case "image/png", "image/jpeg", "image/webp", "image/gif":
	default:
		return offlineV5WhiteboardAssetDescriptor{}, fmt.Errorf("offline v5 whiteboard asset type unsupported")
	}
	item.ContentHash = strings.TrimPrefix(strings.ToLower(strings.TrimSpace(item.ContentHash)), domain.MediaAssetHashWhiteboardPrefix)
	hashBytes, hashErr := hex.DecodeString(item.ContentHash)
	if hashErr != nil || len(hashBytes) != sha256.Size || item.SizeBytes < 1 {
		return offlineV5WhiteboardAssetDescriptor{}, fmt.Errorf("offline v5 whiteboard asset descriptor invalid")
	}
	return item.offlineV5WhiteboardAssetDescriptor, nil
}

// offlineV5WhiteboardSnapshot keeps binary image data out of the signed JSON.
// The authenticated client downloads each immutable account-owned asset through
// the canonical whiteboard endpoint and verifies this signed descriptor before
// committing any part of the prepared copy.
func offlineV5WhiteboardSnapshot(ctx context.Context, tx pgx.Tx, accountID, boardID uuid.UUID) (json.RawMessage, int64, error) {
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
	if err := tx.QueryRow(ctx, `SELECT id,name,description,scene_json,scene_schema_version,editor_version,scene_sequence,version,updated_at
		FROM whiteboards WHERE account_id=$1 AND id=$2 AND archived_at IS NULL FOR SHARE`, accountID, boardID).
		Scan(&board.ID, &board.Name, &board.Description, &board.Scene, &board.Schema, &board.Editor, &board.Sequence, &board.Version, &board.UpdatedAt); err != nil {
		return nil, 0, err
	}
	fileIDs := offlineV3ReferencedWhiteboardFiles(board.Scene)
	assets := make([]offlineV5WhiteboardAssetDescriptor, 0, len(fileIDs))
	var binaryBytes int64
	if len(fileIDs) > 0 {
		rows, err := tx.Query(ctx, `SELECT link.id,link.file_id,media.content_hash,media.content_type,media.size_bytes,media.object_key
			FROM whiteboard_assets link
			JOIN media_assets media ON media.id=link.media_asset_id AND media.account_id=link.account_id
				AND media.status='active' AND media.deleted_at IS NULL
			WHERE link.account_id=$1 AND link.board_id=$2 AND link.kind='asset'
				AND link.committed_at IS NOT NULL AND link.file_id=ANY($3::text[])
			ORDER BY link.file_id FOR SHARE OF link,media`, accountID, boardID, fileIDs)
		if err != nil {
			return nil, 0, err
		}
		stored := make([]offlineV5WhiteboardStoredAsset, 0, len(fileIDs))
		for rows.Next() {
			var item offlineV5WhiteboardStoredAsset
			if err := rows.Scan(&item.ID, &item.FileID, &item.ContentHash, &item.ContentType, &item.SizeBytes, &item.ObjectKey); err != nil {
				rows.Close()
				return nil, 0, err
			}
			stored = append(stored, item)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, 0, err
		}
		rows.Close()
		if len(stored) != len(fileIDs) {
			return nil, 0, fmt.Errorf("offline v5 whiteboard asset closure incomplete")
		}
		for _, item := range stored {
			descriptor, descriptorErr := offlineV5WhiteboardDescriptor(accountID, boardID, item)
			if descriptorErr != nil {
				return nil, 0, descriptorErr
			}
			if binaryBytes > recordSafeInt64Max-descriptor.SizeBytes {
				return nil, 0, ErrOfflineV4QuotaExceeded
			}
			binaryBytes += descriptor.SizeBytes
			assets = append(assets, descriptor)
		}
	}
	payload, err := json.Marshal(map[string]any{"whiteboard": board, "referenced_assets": assets})
	return payload, binaryBytes, err
}

const recordSafeInt64Max = int64(^uint64(0) >> 1)

func offlineV5ModuleAllowed(modules []string, module string) bool {
	for _, candidate := range modules {
		if candidate == module {
			return true
		}
	}
	return false
}

func offlineV5CapabilityLess(left, right domain.OfflineV5Capability) bool {
	if left.SelectionID != right.SelectionID {
		return left.SelectionID.String() < right.SelectionID.String()
	}
	if left.Action != right.Action {
		return left.Action < right.Action
	}
	return left.ResourceID.String() < right.ResourceID.String()
}

func offlineV5SelectionCapabilities(ctx context.Context, tx pgx.Tx, record *OfflineV5AuthRecord, selection domain.OfflineV3Selection, writes bool) ([]domain.OfflineV5Capability, error) {
	readAction, writeActions := "", []string{}
	switch selection.Module {
	case domain.OfflineModuleTasks:
		readAction = domain.OfflineV5ActionTasksRead
		access, _, err := resolveContainerAccessWith(ctx, tx, record.AccountID, record.UserID, selection.ResourceID, domain.TaskAccessTargetList)
		if err != nil {
			return nil, err
		}
		if TaskAccessAllows(access, domain.TaskAccessComment) {
			writeActions = append(writeActions, domain.OfflineV5ActionTasksComment)
		}
		if TaskAccessAllows(access, domain.TaskAccessEdit) {
			writeActions = append(writeActions, domain.OfflineV5ActionTasksCreate, domain.OfflineV5ActionTasksUpdate, domain.OfflineV5ActionTasksComplete, domain.OfflineV5ActionTasksReopen)
		}
	case domain.OfflineModuleContacts:
		readAction = domain.OfflineV5ActionContactsRead
		writeActions = []string{domain.OfflineV5ActionContactsUpdate, domain.OfflineV5ActionContactsObserve}
	case domain.OfflineModulePrograms:
		readAction = domain.OfflineV5ActionProgramsRead
		writeActions = []string{domain.OfflineV5ActionProgramsUpdate, domain.OfflineV5ActionProgramsParticipantAdd,
			domain.OfflineV5ActionProgramsParticipantLifecycle, domain.OfflineV5ActionProgramsSessionUpsert, domain.OfflineV5ActionProgramsAttendance,
			domain.OfflineV5ActionProgramsObservation, domain.OfflineV5ActionProgramsGoals}
	case domain.OfflineModuleWhiteboards:
		readAction = domain.OfflineV5ActionBoardsRead
		access, err := resolveActiveWhiteboardAccessWith(ctx, tx, record.AccountID, record.UserID, selection.ResourceID)
		if err != nil {
			return nil, err
		}
		if WhiteboardAccessAllows(access, domain.WhiteboardAccessEdit) {
			writeActions = []string{domain.OfflineV5ActionBoardsScene}
		}
	default:
		return nil, ErrOfflineV3Invalid
	}
	actions := []string{readAction}
	if writes && record.WritesEnabled {
		actions = append(actions, writeActions...)
	}
	out := make([]domain.OfflineV5Capability, 0, len(actions))
	for _, action := range actions {
		out = append(out, domain.OfflineV5Capability{Action: action, SelectionID: selection.ID,
			RootResourceID: selection.ResourceID, ResourceType: selection.ResourceType, ResourceID: selection.ResourceID})
	}
	return out, nil
}

func offlineV5DependenciesTx(ctx context.Context, tx pgx.Tx, accountID uuid.UUID, selection domain.OfflineV3Selection) ([]domain.OfflineV5ManifestDependency, error) {
	items := make([]domain.OfflineV5ManifestDependency, 0)
	appendItem := func(resourceType, resourceID, mode string) {
		items = append(items, domain.OfflineV5ManifestDependency{RootSelectionID: selection.ID, Module: selection.Module,
			ResourceType: resourceType, ResourceID: resourceID, Mode: mode})
	}
	var rows pgx.Rows
	var err error
	switch selection.Module {
	case domain.OfflineModuleTasks:
		rows, err = tx.Query(ctx, `SELECT 'task_workflow',workflow.id::text,'read' FROM task_lists list_item
			JOIN task_workflows workflow ON workflow.account_id=list_item.account_id AND workflow.id=list_item.workflow_id
			WHERE list_item.account_id=$1 AND list_item.id=$2
			UNION ALL SELECT 'task_status',status.id::text,'read' FROM task_lists list_item
			JOIN task_statuses status ON status.account_id=list_item.account_id AND status.workflow_id=list_item.workflow_id
			WHERE list_item.account_id=$1 AND list_item.id=$2
			UNION ALL SELECT 'task',task.id::text,'edit' FROM tasks task
			WHERE task.account_id=$1 AND task.list_id=$2 AND task.deleted_at IS NULL
			UNION ALL SELECT 'task_user',task.created_by::text,'read' FROM tasks task
			WHERE task.account_id=$1 AND task.list_id=$2 AND task.deleted_at IS NULL
			UNION ALL SELECT 'task_user',task.assigned_to::text,'read' FROM tasks task
			WHERE task.account_id=$1 AND task.list_id=$2 AND task.deleted_at IS NULL
			UNION ALL SELECT 'task_user',collaborator.user_id::text,'read' FROM task_collaborators collaborator
			JOIN tasks task ON task.account_id=collaborator.account_id AND task.id=collaborator.task_id
			WHERE task.account_id=$1 AND task.list_id=$2 AND task.deleted_at IS NULL`, accountID, selection.ResourceID)
	case domain.OfflineModuleContacts:
		rows, err = tx.Query(ctx, `SELECT 'contact_tag',tag_item.id::text,'read' FROM contact_tags link
			JOIN tags tag_item ON tag_item.id=link.tag_id AND tag_item.account_id=$1 WHERE link.contact_id=$2
			UNION ALL SELECT 'custom_field',definition.id::text,'read' FROM custom_field_values value
			JOIN custom_field_definitions definition ON definition.id=value.field_id AND definition.account_id=$1
			WHERE value.contact_id=$2`, accountID, selection.ResourceID)
	case domain.OfflineModulePrograms:
		rows, err = tx.Query(ctx, `SELECT 'program_participant',participant.id::text,'edit' FROM program_participants participant
			JOIN programs program ON program.id=participant.program_id AND program.account_id=$1 WHERE participant.program_id=$2
			UNION ALL SELECT 'contact',participant.contact_id::text,'read' FROM program_participants participant
			JOIN programs program ON program.id=participant.program_id AND program.account_id=$1 WHERE participant.program_id=$2
			UNION ALL SELECT 'program_session',session.id::text,'edit' FROM program_sessions session
			WHERE session.account_id=$1 AND session.program_id=$2`, accountID, selection.ResourceID)
	case domain.OfflineModuleWhiteboards:
		rows, err = tx.Query(ctx, `SELECT 'whiteboard_asset',asset.file_id,'read' FROM whiteboard_assets asset
			WHERE asset.account_id=$1 AND asset.board_id=$2 AND asset.kind='asset' AND asset.committed_at IS NOT NULL`, accountID, selection.ResourceID)
	default:
		return nil, ErrOfflineV3Invalid
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var resourceType, resourceID, mode string
		if err := rows.Scan(&resourceType, &resourceID, &mode); err != nil {
			return nil, err
		}
		appendItem(resourceType, resourceID, mode)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	deduplicated := items[:0]
	seen := make(map[string]struct{}, len(items))
	for _, item := range items {
		key := item.RootSelectionID.String() + "\x00" + item.Module + "\x00" + item.ResourceType + "\x00" + item.ResourceID
		if _, duplicate := seen[key]; duplicate {
			continue
		}
		seen[key] = struct{}{}
		deduplicated = append(deduplicated, item)
	}
	items = deduplicated
	sort.Slice(items, func(i, j int) bool {
		if items[i].ResourceType != items[j].ResourceType {
			return items[i].ResourceType < items[j].ResourceType
		}
		return items[i].ResourceID < items[j].ResourceID
	})
	return items, nil
}

func offlineV5EntityVersions(payload json.RawMessage, module string) []domain.OfflineV5EntityVersion {
	var root any
	if json.Unmarshal(payload, &root) != nil {
		return []domain.OfflineV5EntityVersion{}
	}
	out := make([]domain.OfflineV5EntityVersion, 0)
	seen := map[string]struct{}{}
	var walk func(any, string)
	walk = func(value any, hint string) {
		switch typed := value.(type) {
		case map[string]any:
			entityType := hint
			id, _ := typed["id"].(string)
			switch hint {
			case "active_roster", "historical_participations":
				entityType = "program_participant"
			case "sessions":
				entityType = "program_session"
			case "eligible_attendance", "out_of_window_history":
				entityType = "program_attendance"
				// Attendance is canonically upserted by this pair. A row UUID does
				// not exist before the first mark and cannot identify its version.
				sessionID, _ := typed["session_id"].(string)
				participantID, _ := typed["participant_id"].(string)
				if sessionID != "" && participantID != "" {
					id = sessionID + ":" + participantID
				}
			case "goals":
				entityType = "program_goal"
			}
			version := int64(0)
			if rawVersion, ok := typed["version"].(float64); ok && rawVersion >= 0 {
				version = int64(rawVersion)
			} else if rawSequence, ok := typed["sequence"].(float64); ok && rawSequence >= 0 {
				version = int64(rawSequence)
			} else if updated, ok := typed["updated_at"].(string); ok {
				if parsed, err := time.Parse(time.RFC3339Nano, updated); err == nil {
					version = parsed.UnixMicro()
				}
			}
			if id != "" {
				key := entityType + ":" + id
				if _, exists := seen[key]; !exists {
					seen[key] = struct{}{}
					out = append(out, domain.OfflineV5EntityVersion{EntityType: entityType, EntityID: id, Version: version})
				}
			}
			for key, nested := range typed {
				nestedHint := key
				if key == "list" || key == "tasks" || key == "contact" || key == "program" || key == "whiteboard" || key == "statuses" || key == "sessions" || key == "eligible_attendance" || key == "active_roster" {
					walk(nested, nestedHint)
				} else if _, object := nested.(map[string]any); object {
					walk(nested, nestedHint)
				} else if _, array := nested.([]any); array {
					walk(nested, nestedHint)
				}
			}
		case []any:
			for _, nested := range typed {
				walk(nested, hint)
			}
		}
	}
	walk(root, module)
	sort.Slice(out, func(i, j int) bool {
		if out[i].EntityType != out[j].EntityType {
			return out[i].EntityType < out[j].EntityType
		}
		return out[i].EntityID < out[j].EntityID
	})
	return out
}

func offlineV5ManifestCanonical(manifest domain.OfflineV5Manifest) ([]byte, string, error) {
	// The signed view deliberately omits the transport-only signature fields.
	// Keeping them as empty strings would create a different object topology in
	// JavaScript and make an otherwise authentic manifest impossible to verify.
	transport, err := json.Marshal(manifest)
	if err != nil {
		return nil, "", err
	}
	var signed map[string]json.RawMessage
	if err := json.Unmarshal(transport, &signed); err != nil {
		return nil, "", err
	}
	delete(signed, "digest")
	delete(signed, "canonical_json")
	raw, err := json.Marshal(signed)
	if err != nil {
		return nil, "", err
	}
	digest := sha256.Sum256(raw)
	return raw, hex.EncodeToString(digest[:]), nil
}

func (r *OfflineV5Repository) prepare(ctx context.Context, grantID, userID uuid.UUID, writes bool, loadAsset OfflineV3AssetLoader, challengeID uuid.UUID, nonce string) (*OfflineV5PrepareResult, error) {
	tx, err := r.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	record, err := r.LockActiveGrantTx(ctx, tx, grantID)
	if err != nil {
		return nil, err
	}
	if record.UserID != userID {
		return nil, ErrOfflineV3NotFound
	}
	if !record.PrepareEnabled || record.GrantKeyThumbprint == "" {
		return nil, ErrOfflineV3AccessDenied
	}
	if challengeID != uuid.Nil {
		if err := consumeOfflineV5Challenge(ctx, tx, challengeID, userID, grantID, "prepare", nonce); err != nil {
			return nil, err
		}
	}
	selections, err := offlineV4SelectionsTx(ctx, tx, grantID, record.AccountID)
	if err != nil {
		return nil, err
	}
	if len(selections) == 0 || len(selections) > record.MaxResources || len(selections) > domain.OfflineV5MaxResources {
		return nil, ErrOfflineV3Invalid
	}
	now := time.Now().UTC()
	manifest := domain.OfflineV5Manifest{ProtocolVersion: domain.OfflineV5ProtocolVersion, ID: uuid.New(), Revision: 1,
		BrowserProfileID: record.BrowserProfileID, GrantID: record.GrantID, UserID: record.UserID, AccountID: record.AccountID,
		Username: record.Username, AccountName: record.AccountName, SelectionRevision: record.SelectionRevision,
		SelectionDigest: record.SelectionDigest, CredentialEpoch: record.CredentialEpoch, AuthorityEpoch: record.AuthorityEpoch,
		GrantRevision: record.Revision, Roots: []domain.OfflineV5ManifestRoot{}, Dependencies: []domain.OfflineV5ManifestDependency{},
		Capabilities: []domain.OfflineV5Capability{}, EntityVersions: []domain.OfflineV5EntityVersion{}, ChunkHashes: []domain.OfflineV5ChunkHash{},
		IssuedAt: now, ExpiresAt: now.Add(time.Duration(record.MaxOfflineSeconds) * time.Second), MaxStorageBytes: record.QuotaBytes}
	if err := tx.QueryRow(ctx, `SELECT COALESCE(MAX(revision),0)+1 FROM offline_v5_manifests WHERE grant_id=$1`, grantID).Scan(&manifest.Revision); err != nil {
		return nil, err
	}
	result := &OfflineV5PrepareResult{Record: record, Manifest: manifest, Snapshots: []domain.OfflineV5Snapshot{}}
	var selectedBytes int64
	for _, selection := range selections {
		if !offlineV5ModuleAllowed(record.Modules, selection.Module) {
			return nil, ErrOfflineV3AccessDenied
		}
		if err := validateOfflineV3ResourceAccess(ctx, tx, record.UserID, record.AccountID, selection, domain.TaskAccessView); err != nil {
			return nil, err
		}
		capabilities, err := offlineV5SelectionCapabilities(ctx, tx, record, selection, writes)
		if err != nil {
			return nil, err
		}
		result.Manifest.Capabilities = append(result.Manifest.Capabilities, capabilities...)
		var payload json.RawMessage
		var binaryBytes int64
		canWrite := writes && record.WritesEnabled && len(capabilities) > 1
		if selection.Module == domain.OfflineModuleTasks {
			payload, err = offlineTaskListSnapshot(ctx, tx, record.AccountID, record.UserID, selection.ResourceID, canWrite, canWrite)
		} else if selection.Module == domain.OfflineModuleWhiteboards {
			payload, binaryBytes, err = offlineV5WhiteboardSnapshot(ctx, tx, record.AccountID, selection.ResourceID)
		} else {
			payload, _, err = offlineV3SnapshotPayload(ctx, tx, record.AccountID, record.UserID, selection, loadAsset)
		}
		if err != nil {
			return nil, err
		}
		payload, err = offlineV5EnrichSnapshot(ctx, tx, record.AccountID, record.UserID, selection, payload, capabilities)
		if err != nil {
			return nil, err
		}
		if len(payload) > offlineV3MaxSnapshotBytes {
			return nil, ErrOfflineSnapshotTooLarge
		}
		resourceBytes := int64(len(payload)) + binaryBytes
		if resourceBytes < int64(len(payload)) || selectedBytes > record.QuotaBytes-resourceBytes {
			return nil, ErrOfflineV4QuotaExceeded
		}
		selectedBytes += resourceBytes
		digest := sha256.Sum256(payload)
		contentHash := hex.EncodeToString(digest[:])
		var headVersion int64
		if err := tx.QueryRow(ctx, `UPDATE offline_v4_selections
			SET head_version=CASE WHEN content_hash IS DISTINCT FROM $4 THEN head_version+1 ELSE head_version END,
			content_hash=$4,byte_size=$5 WHERE id=$1 AND grant_id=$2 AND account_id=$3 RETURNING head_version`,
			selection.ID, grantID, record.AccountID, contentHash, resourceBytes).Scan(&headVersion); err != nil {
			return nil, err
		}
		root := domain.OfflineV5ManifestRoot{SelectionID: selection.ID, Module: selection.Module, ResourceType: selection.ResourceType,
			ResourceID: selection.ResourceID, HeadVersion: headVersion, ContentHash: contentHash}
		result.Manifest.Roots = append(result.Manifest.Roots, root)
		result.Manifest.ChunkHashes = append(result.Manifest.ChunkHashes, domain.OfflineV5ChunkHash{
			SelectionID: selection.ID, HeadVersion: headVersion, ContentHash: contentHash,
		})
		result.Manifest.EntityVersions = append(result.Manifest.EntityVersions, offlineV5EntityVersions(payload, selection.Module)...)
		dependencies, err := offlineV5DependenciesTx(ctx, tx, record.AccountID, selection)
		if err != nil {
			return nil, err
		}
		result.Manifest.Dependencies = append(result.Manifest.Dependencies, dependencies...)
		if len(result.Manifest.Dependencies) > 20000 {
			return nil, ErrOfflineSnapshotTooLarge
		}
		result.Snapshots = append(result.Snapshots, domain.OfflineV5Snapshot{ProtocolVersion: domain.OfflineV5ProtocolVersion,
			ManifestID: manifest.ID, ManifestRevision: manifest.Revision, SelectionID: selection.ID, RootSelectionID: selection.ID,
			RootResourceID: selection.ResourceID, Module: selection.Module, ResourceType: selection.ResourceType,
			ResourceID: selection.ResourceID, HeadVersion: headVersion, ContentHash: contentHash, Payload: payload,
			PayloadJSON: string(payload), GeneratedAt: now})
	}
	sort.Slice(result.Manifest.Roots, func(i, j int) bool {
		return result.Manifest.Roots[i].SelectionID.String() < result.Manifest.Roots[j].SelectionID.String()
	})
	sort.Slice(result.Manifest.Capabilities, func(i, j int) bool {
		return offlineV5CapabilityLess(result.Manifest.Capabilities[i], result.Manifest.Capabilities[j])
	})
	sort.Slice(result.Manifest.Dependencies, func(i, j int) bool {
		left, right := result.Manifest.Dependencies[i], result.Manifest.Dependencies[j]
		if left.RootSelectionID != right.RootSelectionID {
			return left.RootSelectionID.String() < right.RootSelectionID.String()
		}
		if left.ResourceType != right.ResourceType {
			return left.ResourceType < right.ResourceType
		}
		return left.ResourceID < right.ResourceID
	})
	// A dependency can occur below two selected roots. Entity versions are an
	// account-scoped verification index, so keep one deterministic row per
	// entity/version rather than signing traversal order or duplicates.
	sort.Slice(result.Manifest.EntityVersions, func(i, j int) bool {
		left, right := result.Manifest.EntityVersions[i], result.Manifest.EntityVersions[j]
		if left.EntityType != right.EntityType {
			return left.EntityType < right.EntityType
		}
		if left.EntityID != right.EntityID {
			return left.EntityID < right.EntityID
		}
		return left.Version < right.Version
	})
	entityVersions := result.Manifest.EntityVersions[:0]
	for _, item := range result.Manifest.EntityVersions {
		if len(entityVersions) > 0 {
			last := entityVersions[len(entityVersions)-1]
			if last.EntityType == item.EntityType && last.EntityID == item.EntityID && last.Version == item.Version {
				continue
			}
		}
		entityVersions = append(entityVersions, item)
	}
	result.Manifest.EntityVersions = entityVersions
	sort.Slice(result.Manifest.ChunkHashes, func(i, j int) bool {
		return result.Manifest.ChunkHashes[i].SelectionID.String() < result.Manifest.ChunkHashes[j].SelectionID.String()
	})
	sort.Slice(result.Snapshots, func(i, j int) bool {
		return result.Snapshots[i].SelectionID.String() < result.Snapshots[j].SelectionID.String()
	})
	canonical, digest, err := offlineV5ManifestCanonical(result.Manifest)
	if err != nil {
		return nil, err
	}
	result.Manifest.Digest = digest
	result.Manifest.CanonicalJSON = base64.RawURLEncoding.EncodeToString(canonical)
	encodedManifest, err := json.Marshal(result.Manifest)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE offline_v5_manifests SET superseded_at=NOW()
		WHERE grant_id=$1 AND account_id=$2 AND superseded_at IS NULL`, grantID, record.AccountID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO offline_v5_manifests(id,grant_id,account_id,revision,selection_revision,selection_digest,digest,canonical_json,manifest_json,issued_at,expires_at)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`, result.Manifest.ID, grantID, record.AccountID,
		result.Manifest.Revision, record.SelectionRevision, record.SelectionDigest, digest, canonical, encodedManifest, now, result.Manifest.ExpiresAt); err != nil {
		return nil, err
	}
	for _, root := range result.Manifest.Roots {
		if _, err := tx.Exec(ctx, `INSERT INTO offline_v5_manifest_roots(manifest_id,grant_id,account_id,selection_id,module,resource_type,resource_id,head_version,content_hash)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, result.Manifest.ID, grantID, record.AccountID, root.SelectionID,
			root.Module, root.ResourceType, root.ResourceID, root.HeadVersion, root.ContentHash); err != nil {
			return nil, err
		}
	}
	for _, dependency := range result.Manifest.Dependencies {
		if _, err := tx.Exec(ctx, `INSERT INTO offline_v5_manifest_dependencies(manifest_id,grant_id,account_id,root_selection_id,module,resource_type,resource_id,access_mode)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, result.Manifest.ID, grantID, record.AccountID, dependency.RootSelectionID,
			dependency.Module, dependency.ResourceType, dependency.ResourceID, dependency.Mode); err != nil {
			return nil, err
		}
	}
	for _, capability := range result.Manifest.Capabilities {
		if _, err := tx.Exec(ctx, `INSERT INTO offline_v5_manifest_capabilities(manifest_id,grant_id,account_id,action_code,selection_id,root_resource_id,resource_type,resource_id)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, result.Manifest.ID, grantID, record.AccountID, capability.Action,
			capability.SelectionID, capability.RootResourceID, capability.ResourceType, capability.ResourceID); err != nil {
			return nil, err
		}
	}
	if _, err := tx.Exec(ctx, `INSERT INTO offline_v5_audit(browser_profile_id,grant_id,account_id,actor_id,event_type,metadata)
		VALUES($1,$2,$3,$4,'manifest_prepared',jsonb_build_object('manifest_id',$5::text,'digest',$6::text,'resource_count',$7::int))`,
		record.BrowserProfileID, grantID, record.AccountID, userID, result.Manifest.ID, digest, len(result.Manifest.Roots)); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return result, nil
}

// Prepare consumes a one-use dual-key preparation challenge. RefreshManifest
// is reserved for the already dual-key-authenticated sync path; keeping these
// entry points separate prevents a caller from accidentally skipping proof.
func (r *OfflineV5Repository) Prepare(ctx context.Context, grantID, userID uuid.UUID, writes bool, loadAsset OfflineV3AssetLoader, challengeID uuid.UUID, nonce string) (*OfflineV5PrepareResult, error) {
	if challengeID == uuid.Nil || nonce == "" {
		return nil, ErrOfflineV3Invalid
	}
	return r.prepare(ctx, grantID, userID, writes, loadAsset, challengeID, nonce)
}

func (r *OfflineV5Repository) RefreshManifest(ctx context.Context, grantID, userID uuid.UUID, writes bool, loadAsset OfflineV3AssetLoader) (*OfflineV5PrepareResult, error) {
	return r.prepare(ctx, grantID, userID, writes, loadAsset, uuid.Nil, "")
}

var errOfflineV5ManifestSuperseded = errors.New("offline v5 manifest superseded")

func (r *OfflineV5Repository) loadManifestTx(ctx context.Context, tx pgx.Tx, record *OfflineV5AuthRecord, manifestID uuid.UUID, revision int64) (*domain.OfflineV5Manifest, error) {
	return r.loadManifestWithPolicyTx(ctx, tx, record, manifestID, revision, false)
}

// loadSupersededManifestForReceiptRecoveryTx is deliberately private to the
// sync repository. A superseded manifest is never usable as authority for a
// new command; it may only identify immutable receipts written by that exact
// manifest, or authenticate an empty refresh, after response delivery failed.
func (r *OfflineV5Repository) loadSupersededManifestForReceiptRecoveryTx(ctx context.Context, tx pgx.Tx, record *OfflineV5AuthRecord, manifestID uuid.UUID, revision int64) (*domain.OfflineV5Manifest, error) {
	return r.loadManifestWithPolicyTx(ctx, tx, record, manifestID, revision, true)
}

func (r *OfflineV5Repository) loadManifestWithPolicyTx(ctx context.Context, tx pgx.Tx, record *OfflineV5AuthRecord, manifestID uuid.UUID, revision int64, allowSupersededForReceiptRecovery bool) (*domain.OfflineV5Manifest, error) {
	var raw, canonical []byte
	var digest string
	var expiresAt time.Time
	var supersededAt *time.Time
	err := tx.QueryRow(ctx, `SELECT manifest_json,canonical_json,digest,expires_at,superseded_at
		FROM offline_v5_manifests WHERE id=$1 AND grant_id=$2 AND account_id=$3 AND revision=$4 FOR SHARE`,
		manifestID, record.GrantID, record.AccountID, revision).Scan(&raw, &canonical, &digest, &expiresAt, &supersededAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrOfflineV3NotFound
	}
	if err != nil {
		return nil, err
	}
	if !expiresAt.After(time.Now().UTC()) {
		return nil, ErrOfflineV3AccessDenied
	}
	computed := sha256.Sum256(canonical)
	if hex.EncodeToString(computed[:]) != digest {
		return nil, ErrOfflineV3AccessDenied
	}
	var manifest domain.OfflineV5Manifest
	if json.Unmarshal(raw, &manifest) != nil || manifest.Digest != digest || manifest.CanonicalJSON != base64.RawURLEncoding.EncodeToString(canonical) ||
		manifest.GrantID != record.GrantID || manifest.AccountID != record.AccountID || manifest.UserID != record.UserID ||
		manifest.BrowserProfileID != record.BrowserProfileID || manifest.SelectionRevision != record.SelectionRevision ||
		manifest.SelectionDigest != record.SelectionDigest || manifest.CredentialEpoch != record.CredentialEpoch ||
		manifest.AuthorityEpoch != record.AuthorityEpoch || manifest.GrantRevision != record.Revision {
		return nil, ErrOfflineV3AccessDenied
	}
	recomputedCanonical, recomputedDigest, err := offlineV5ManifestCanonical(manifest)
	if err != nil || recomputedDigest != digest || !bytes.Equal(recomputedCanonical, canonical) {
		return nil, ErrOfflineV3AccessDenied
	}
	if supersededAt != nil && !allowSupersededForReceiptRecovery {
		return nil, errOfflineV5ManifestSuperseded
	}
	if supersededAt == nil && allowSupersededForReceiptRecovery {
		// Recovery is intentionally a separate state, not an alternate loader
		// for current manifests. This keeps every ordinary write on the normal
		// capability/ACL path below loadManifestTx.
		return nil, ErrOfflineV3AccessDenied
	}
	return &manifest, nil
}

// ConfirmManifestIssued closes the transaction/signer delivery window. A
// revoke, password/authority epoch change, selection replacement, or ACL
// reduction that commits while the detached signer is working prevents the
// newly signed bytes from leaving the API.
func (r *OfflineV5Repository) ConfirmManifestIssued(ctx context.Context, expected *OfflineV5AuthRecord, expectedManifest domain.OfflineV5Manifest) error {
	if expected == nil || expectedManifest.ID == uuid.Nil || expectedManifest.Digest == "" {
		return ErrOfflineV3Invalid
	}
	tx, err := r.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	current, err := r.LockActiveGrantTx(ctx, tx, expected.GrantID)
	if err != nil {
		return err
	}
	if current.OfflineV4Tuple != expected.OfflineV4Tuple || current.V5Revision != expected.V5Revision ||
		current.SelectionRevision != expected.SelectionRevision || current.SelectionDigest != expected.SelectionDigest ||
		current.CredentialEpoch != expected.CredentialEpoch || current.AuthorityEpoch != expected.AuthorityEpoch ||
		current.Revision != expected.Revision || current.BrowserKeyThumbprint != expected.BrowserKeyThumbprint ||
		current.GrantKeyThumbprint != expected.GrantKeyThumbprint {
		return ErrOfflineV3AccessDenied
	}
	manifest, err := r.loadManifestTx(ctx, tx, current, expectedManifest.ID, expectedManifest.Revision)
	if err != nil {
		return err
	}
	if manifest.Digest != expectedManifest.Digest || manifest.CanonicalJSON != expectedManifest.CanonicalJSON || len(manifest.Roots) != len(expectedManifest.Roots) {
		return ErrOfflineV3AccessDenied
	}
	writesSigned := false
	for _, capability := range manifest.Capabilities {
		if offlineV5MutationAction(capability.Action) {
			writesSigned = true
			break
		}
	}
	for _, root := range manifest.Roots {
		var selection domain.OfflineV3Selection
		err := tx.QueryRow(ctx, `SELECT id,grant_id,account_id,module,resource_type,resource_id FROM offline_v4_selections
			WHERE id=$1 AND grant_id=$2 AND account_id=$3 FOR SHARE`, root.SelectionID, current.GrantID, current.AccountID).
			Scan(&selection.ID, &selection.GrantID, &selection.AccountID, &selection.Module, &selection.ResourceType, &selection.ResourceID)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrOfflineV3AccessDenied
		}
		if err != nil {
			return err
		}
		if selection.Module != root.Module || selection.ResourceType != root.ResourceType || selection.ResourceID != root.ResourceID ||
			!offlineV5ModuleAllowed(current.Modules, selection.Module) {
			return ErrOfflineV3AccessDenied
		}
		if err := validateOfflineV3ResourceAccess(ctx, tx, current.UserID, current.AccountID, selection, domain.TaskAccessView); err != nil {
			return ErrOfflineV3AccessDenied
		}
		recomputed, err := offlineV5SelectionCapabilities(ctx, tx, current, selection, writesSigned)
		if err != nil {
			return err
		}
		signed := make([]domain.OfflineV5Capability, 0, len(recomputed))
		for _, capability := range manifest.Capabilities {
			if capability.SelectionID == selection.ID {
				signed = append(signed, capability)
			}
		}
		sort.Slice(recomputed, func(i, j int) bool { return offlineV5CapabilityLess(recomputed[i], recomputed[j]) })
		sort.Slice(signed, func(i, j int) bool { return offlineV5CapabilityLess(signed[i], signed[j]) })
		if len(recomputed) != len(signed) {
			return ErrOfflineV3AccessDenied
		}
		for index := range recomputed {
			if recomputed[index] != signed[index] {
				return ErrOfflineV3AccessDenied
			}
		}
	}
	return tx.Commit(ctx)
}
