package api

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
)

var offlineOperationContract = map[string]map[string]bool{
	domain.OfflineModuleWhiteboards: {
		"whiteboard.update_scene": true,
		"whiteboard.upload_asset": true,
	},
	domain.OfflineModuleTasks: {
		"task.create":        true,
		"task.update_simple": true,
		"task.complete":      true,
	},
	domain.OfflineModuleContacts: {
		"contact.update_identity":      true,
		"contact.add_observation":      true,
		"contact.assign_existing_tags": true,
	},
	domain.OfflineModulePrograms: {
		"program.set_attendance":              true,
		"program.add_participant_observation": true,
	},
}

// applyOfflineOperationsV2 provides durable idempotent receipts and dependency
// semantics. Each module stays fail-closed until its canonical adapter exists;
// no provisional direct SQL path may bypass normal authorization repositories.
func (s *Server) applyOfflineOperationsV2(ctx context.Context, record *repository.OfflineAuthRecordV2, operations []domain.OfflineOperation) ([]domain.OfflineOperationResult, error) {
	results := make([]domain.OfflineOperationResult, 0, len(operations))
	externalDependencies := make([]uuid.UUID, 0)
	batchIDs := make(map[uuid.UUID]struct{}, len(operations))
	for _, operation := range operations {
		batchIDs[operation.OperationID] = struct{}{}
	}
	for _, operation := range operations {
		for _, dependency := range operation.DependsOn {
			if _, inBatch := batchIDs[dependency]; !inBatch {
				externalDependencies = append(externalDependencies, dependency)
			}
		}
	}
	statuses, err := s.repos.Offline.OperationStatuses(ctx, record.AccountID, record.TerminalID, externalDependencies)
	if err != nil {
		return nil, err
	}
	for _, operation := range operations {
		encoded, err := json.Marshal(operation)
		if err != nil {
			return nil, err
		}
		digest := sha256.Sum256(encoded)
		existing, err := s.repos.Offline.ExistingOperationResult(ctx, record.AccountID, record.TerminalID, operation.OperationID, digest[:])
		if errors.Is(err, repository.ErrOfflineOperationIDReuse) {
			return nil, err
		}
		if err != nil {
			return nil, err
		}
		if existing != nil {
			results = append(results, *existing)
			statuses[operation.OperationID] = existing.Status
			continue
		}
		result := domain.OfflineOperationResult{OperationID: operation.OperationID, ResourceID: operation.ResourceID}
		if operation.OperationID == uuid.Nil || operation.ResourceID == uuid.Nil || len(operation.Patch) == 0 || !json.Valid(operation.Patch) {
			result.Status, result.ErrorCode = domain.OfflineOperationRejected, "invalid_operation"
		} else if dependencyFailed(operation.DependsOn, statuses) {
			result.Status, result.ErrorCode = domain.OfflineOperationDependencyFailed, "dependency_failed"
		} else if expectedModule, ok := domain.OfflineModuleForOperationResourceType(operation.ResourceType); !ok || expectedModule != operation.Module || !stringSliceContains(record.Modules, operation.Module) {
			result.Status, result.ErrorCode = domain.OfflineOperationRejected, "outside_grant"
		} else if !offlineOperationContract[operation.Module][strings.TrimSpace(operation.OperationType)] {
			result.Status, result.ErrorCode = domain.OfflineOperationRejected, "operation_not_allowed"
		} else if !s.offlineModuleWriteEnabled(operation.Module) {
			result.Status, result.ErrorCode = domain.OfflineOperationRejected, "module_write_disabled"
		} else if operation.Module == domain.OfflineModuleTasks {
			result, err = s.applyOfflineTaskOperation(ctx, record, operation)
			if err != nil {
				return nil, err
			}
		} else if operation.Module == domain.OfflineModuleWhiteboards {
			result, err = s.applyOfflineWhiteboardOperation(ctx, record, operation)
			if err != nil {
				return nil, err
			}
		} else if operation.Module == domain.OfflineModulePrograms {
			result, err = s.applyOfflineProgramOperation(ctx, record, operation)
			if err != nil {
				return nil, err
			}
		} else {
			// The flag cannot turn an unfinished write path into an unsafe one.
			// Canonical adapters replace this branch module by module.
			result.Status, result.ErrorCode = domain.OfflineOperationRejected, "canonical_write_adapter_unavailable"
		}
		if err := s.repos.Offline.StoreOperationResult(ctx, record, operation, digest[:], result); err != nil {
			return nil, err
		}
		stored, err := s.repos.Offline.ExistingOperationResult(ctx, record.AccountID, record.TerminalID, operation.OperationID, digest[:])
		if err != nil {
			return nil, err
		}
		if stored != nil {
			result = *stored
		}
		results = append(results, result)
		statuses[operation.OperationID] = result.Status
	}
	return results, nil
}

func dependencyFailed(dependencies []uuid.UUID, statuses map[uuid.UUID]string) bool {
	for _, dependency := range dependencies {
		status, ok := statuses[dependency]
		if !ok || (status != domain.OfflineOperationApplied && status != domain.OfflineOperationNoop) {
			return true
		}
	}
	return false
}

func (s *Server) offlineModuleWriteEnabled(module string) bool {
	switch module {
	case domain.OfflineModuleWhiteboards:
		return s.cfg.OfflineWriteWhiteboards
	case domain.OfflineModuleTasks:
		return s.cfg.OfflineWriteTasks
	case domain.OfflineModuleContacts:
		return s.cfg.OfflineWriteContacts
	case domain.OfflineModulePrograms:
		return s.cfg.OfflineWritePrograms
	default:
		return false
	}
}
