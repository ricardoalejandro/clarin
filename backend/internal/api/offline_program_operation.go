package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
)

type offlineProgramAttendancePatch struct {
	SessionID      uuid.UUID `json:"session_id"`
	ParticipantID  uuid.UUID `json:"participant_id"`
	Status         string    `json:"status"`
	ExpectedStatus *string   `json:"expected_status"`
}

func parseOfflineProgramAttendancePatch(raw json.RawMessage) (offlineProgramAttendancePatch, error) {
	var patch offlineProgramAttendancePatch
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&patch); err != nil || patch.SessionID == uuid.Nil || patch.ParticipantID == uuid.Nil {
		return patch, errors.New("invalid attendance patch")
	}
	patch.Status = strings.TrimSpace(patch.Status)
	if patch.ExpectedStatus != nil {
		value := strings.TrimSpace(*patch.ExpectedStatus)
		patch.ExpectedStatus = &value
	}
	return patch, nil
}

func (s *Server) applyOfflineProgramOperation(ctx context.Context, record *repository.OfflineAuthRecordV2, operation domain.OfflineOperation) (domain.OfflineOperationResult, error) {
	result := domain.OfflineOperationResult{OperationID: operation.OperationID, ResourceID: operation.ResourceID}
	if operation.OperationType == "program.add_participant_observation" {
		result.Status, result.ErrorCode = domain.OfflineOperationRejected, "participant_observation_adapter_unavailable"
		return result, nil
	}
	selection, err := s.repos.Offline.SelectionForOperation(ctx, record, operation.SelectionID)
	if errors.Is(err, pgx.ErrNoRows) || selection == nil || selection.Module != domain.OfflineModulePrograms || selection.ResourceType != domain.OfflineResourceProgram || selection.ResourceID != operation.ResourceID {
		result.Status, result.ErrorCode = domain.OfflineOperationRejected, "outside_selection"
		return result, nil
	}
	if err != nil {
		return result, err
	}
	if operation.OperationType != "program.set_attendance" || operation.ResourceType != domain.OfflineResourceProgram || operation.BaseVersion < 1 {
		result.Status, result.ErrorCode = domain.OfflineOperationRejected, "invalid_program_target"
		return result, nil
	}
	patch, err := parseOfflineProgramAttendancePatch(operation.Patch)
	if err != nil {
		result.Status, result.ErrorCode = domain.OfflineOperationRejected, "invalid_patch"
		return result, nil
	}
	var currentStatus string
	err = s.repos.DB().QueryRow(ctx, `SELECT COALESCE(pa.status,'') FROM program_sessions ps JOIN program_participants pp ON pp.program_id=ps.program_id LEFT JOIN program_attendance pa ON pa.session_id=ps.id AND pa.participant_id=pp.id WHERE ps.account_id=$1 AND ps.program_id=$2 AND ps.id=$3 AND pp.id=$4`, record.AccountID, operation.ResourceID, patch.SessionID, patch.ParticipantID).Scan(&currentStatus)
	if errors.Is(err, pgx.ErrNoRows) {
		result.Status, result.ErrorCode = domain.OfflineOperationRejected, "attendance_target_unavailable"
		return result, nil
	}
	if err != nil {
		return result, err
	}
	if currentStatus == patch.Status {
		result.Status, result.ServerVersion = domain.OfflineOperationNoop, selection.HeadVersion
		return result, nil
	}
	if selection.HeadVersion != operation.BaseVersion {
		server, _ := json.Marshal(map[string]any{"session_id": patch.SessionID, "participant_id": patch.ParticipantID, "status": currentStatus})
		conflictID, conflictErr := s.repos.Offline.CreateConflict(ctx, record, operation, selection.HeadVersion, server, []string{"attendance.status"})
		if conflictErr != nil {
			return result, conflictErr
		}
		result.Status, result.ServerVersion, result.ConflictID = domain.OfflineOperationConflict, selection.HeadVersion, &conflictID
		return result, nil
	}
	attendance := &domain.ProgramAttendance{SessionID: patch.SessionID, ParticipantID: patch.ParticipantID, Status: patch.Status, ExpectedStatus: patch.ExpectedStatus}
	if attendance.ExpectedStatus == nil {
		attendance.ExpectedStatus = &currentStatus
	}
	if err := s.services.Program.BatchMarkAttendance(ctx, record.AccountID, record.UserID, operation.ResourceID, patch.SessionID, []*domain.ProgramAttendance{attendance}); err != nil {
		var conflict *repository.ProgramAttendanceConflictError
		if errors.As(err, &conflict) {
			server, _ := json.Marshal(conflict.Conflicts)
			conflictID, conflictErr := s.repos.Offline.CreateConflict(ctx, record, operation, selection.HeadVersion+1, server, []string{"attendance.status"})
			if conflictErr != nil {
				return result, conflictErr
			}
			result.Status, result.ServerVersion, result.ConflictID = domain.OfflineOperationConflict, selection.HeadVersion+1, &conflictID
			return result, nil
		}
		result.Status, result.ErrorCode = domain.OfflineOperationRejected, "attendance_rejected"
		return result, nil
	}
	updated, err := s.repos.Offline.SelectionForOperation(ctx, record, operation.SelectionID)
	if err != nil {
		return result, err
	}
	result.Status, result.ServerVersion = domain.OfflineOperationApplied, updated.HeadVersion
	return result, nil
}
