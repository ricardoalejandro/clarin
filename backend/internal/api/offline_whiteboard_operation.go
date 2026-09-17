package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
)

type offlineWhiteboardScenePatch struct {
	Scene              json.RawMessage `json:"scene"`
	SceneSchemaVersion string          `json:"scene_schema_version,omitempty"`
	EditorVersion      string          `json:"editor_version,omitempty"`
}

func (s *Server) applyOfflineWhiteboardOperation(ctx context.Context, record *repository.OfflineAuthRecordV2, operation domain.OfflineOperation) (domain.OfflineOperationResult, error) {
	result := domain.OfflineOperationResult{OperationID: operation.OperationID, ResourceID: operation.ResourceID}
	if operation.OperationType == "whiteboard.upload_asset" {
		result.Status, result.ErrorCode = domain.OfflineOperationRejected, "asset_upload_adapter_unavailable"
		return result, nil
	}
	selection, err := s.repos.Offline.SelectionForOperation(ctx, record, operation.SelectionID)
	if errors.Is(err, pgx.ErrNoRows) || selection == nil || selection.Module != domain.OfflineModuleWhiteboards || selection.ResourceType != domain.OfflineResourceWhiteboard || selection.ResourceID != operation.ResourceID {
		result.Status, result.ErrorCode = domain.OfflineOperationRejected, "outside_selection"
		return result, nil
	}
	if err != nil {
		return result, err
	}
	if operation.OperationType != "whiteboard.update_scene" || operation.ResourceType != domain.OfflineResourceWhiteboard || operation.BaseVersion < 0 {
		result.Status, result.ErrorCode = domain.OfflineOperationRejected, "invalid_whiteboard_target"
		return result, nil
	}
	var patch offlineWhiteboardScenePatch
	decoder := json.NewDecoder(bytes.NewReader(operation.Patch))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&patch); err != nil || len(patch.Scene) == 0 {
		result.Status, result.ErrorCode = domain.OfflineOperationRejected, "invalid_patch"
		return result, nil
	}
	validated, sceneHash, err := service.ValidateAndHashWhiteboardScene(patch.Scene)
	if err != nil {
		result.Status, result.ErrorCode = domain.OfflineOperationRejected, "invalid_scene"
		return result, nil
	}
	current, err := s.repos.Whiteboard.GetScene(ctx, record.AccountID, record.UserID, operation.ResourceID, domain.WhiteboardAccessEdit)
	if errors.Is(err, repository.ErrWhiteboardForbidden) || errors.Is(err, repository.ErrWhiteboardNotFound) {
		result.Status, result.ErrorCode = domain.OfflineOperationRejected, "access_revoked"
		return result, nil
	}
	if err != nil {
		return result, err
	}
	_, currentHash, _ := service.ValidateAndHashWhiteboardScene(current.Scene)
	if current.Sequence != operation.BaseVersion {
		if currentHash == sceneHash {
			result.Status, result.ServerVersion = domain.OfflineOperationNoop, current.Sequence
			return result, nil
		}
		conflictID, conflictErr := s.repos.Offline.CreateConflict(ctx, record, operation, current.Sequence, current.Scene, []string{"scene"})
		if conflictErr != nil {
			return result, conflictErr
		}
		result.Status, result.ServerVersion, result.ConflictID = domain.OfflineOperationConflict, current.Sequence, &conflictID
		return result, nil
	}
	requestDigest := sha256.Sum256(operation.Patch)
	schemaVersion := current.SceneSchemaVersion
	if patch.SceneSchemaVersion != "" {
		schemaVersion = patch.SceneSchemaVersion
	}
	editorVersion := current.EditorVersion
	if patch.EditorVersion != "" {
		editorVersion = patch.EditorVersion
	}
	write, err := s.repos.Whiteboard.ApplyScenePatch(ctx, record.AccountID, record.UserID, operation.ResourceID, repository.WhiteboardSceneWriteInput{
		ExpectedSequence:   operation.BaseVersion,
		OperationID:        operation.OperationID,
		Scene:              validated,
		Patch:              operation.Patch,
		SceneSchemaVersion: schemaVersion,
		EditorVersion:      editorVersion,
		RequestPayloadHash: hex.EncodeToString(requestDigest[:]),
		ResultSceneHash:    sceneHash,
	})
	var conflict *repository.WhiteboardConflictError
	if errors.As(err, &conflict) || errors.Is(err, repository.ErrWhiteboardConflict) {
		latest, latestErr := s.repos.Whiteboard.GetScene(ctx, record.AccountID, record.UserID, operation.ResourceID, domain.WhiteboardAccessView)
		if latestErr != nil {
			return result, latestErr
		}
		conflictID, conflictErr := s.repos.Offline.CreateConflict(ctx, record, operation, latest.Sequence, latest.Scene, []string{"scene"})
		if conflictErr != nil {
			return result, conflictErr
		}
		result.Status, result.ServerVersion, result.ConflictID = domain.OfflineOperationConflict, latest.Sequence, &conflictID
		return result, nil
	}
	if errors.Is(err, repository.ErrWhiteboardForbidden) || errors.Is(err, repository.ErrWhiteboardNotFound) {
		result.Status, result.ErrorCode = domain.OfflineOperationRejected, "access_revoked"
		return result, nil
	}
	if err != nil {
		return result, err
	}
	result.ServerVersion = write.OperationSequence
	if write.Idempotent {
		result.Status = domain.OfflineOperationNoop
	} else {
		result.Status = domain.OfflineOperationApplied
	}
	return result, nil
}
