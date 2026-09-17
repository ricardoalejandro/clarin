package api

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
)

const (
	offlineProtocolVersionV2 = 2
	offlineMaxSyncBodyBytes  = 2 * 1024 * 1024
	offlineMaxOperations     = 100
)

type offlineChallengeV2Request struct {
	TerminalID uuid.UUID `json:"terminal_id"`
}

type offlineSyncV2Request struct {
	TerminalID          uuid.UUID                           `json:"terminal_id"`
	AccountID           uuid.UUID                           `json:"account_id"`
	InstallInstanceHash string                              `json:"install_instance_hash"`
	BootIDHash          string                              `json:"boot_id_hash"`
	ClientVersion       string                              `json:"client_version"`
	UsedStorageBytes    int64                               `json:"used_storage_bytes"`
	Inventory           []domain.OfflineClientInventoryItem `json:"inventory"`
	Operations          []domain.OfflineOperation           `json:"operations"`
	DevicePosture       domain.OfflineDevicePosture         `json:"device_posture"`
}

type offlineFetchV2Request struct {
	TerminalID          uuid.UUID   `json:"terminal_id"`
	AccountID           uuid.UUID   `json:"account_id"`
	InstallInstanceHash string      `json:"install_instance_hash"`
	SelectionIDs        []uuid.UUID `json:"selection_ids"`
}

type offlineControlAckV2Request struct {
	TerminalID          uuid.UUID       `json:"terminal_id"`
	AccountID           uuid.UUID       `json:"account_id"`
	InstallInstanceHash string          `json:"install_instance_hash"`
	DirectiveID         uuid.UUID       `json:"directive_id"`
	Acknowledgement     json.RawMessage `json:"acknowledgement"`
}

type offlineLeaseClaimsV2 struct {
	Version                int             `json:"version"`
	TerminalID             uuid.UUID       `json:"terminal_id"`
	UserID                 uuid.UUID       `json:"user_id"`
	AccountID              uuid.UUID       `json:"account_id"`
	BootIDHash             string          `json:"boot_id_hash"`
	Modules                []string        `json:"modules"`
	Actions                json.RawMessage `json:"actions"`
	TerminalPolicyRevision int64           `json:"terminal_policy_revision"`
	GrantPolicyRevision    int64           `json:"grant_policy_revision"`
	SelectionRevision      int64           `json:"selection_revision"`
	MaxStorageBytes        int64           `json:"max_storage_bytes"`
	IssuedAt               time.Time       `json:"issued_at"`
	ExpiresAt              time.Time       `json:"expires_at"`
}

func (s *Server) handleOfflineV1Retired(c *fiber.Ctx) error {
	return c.Status(fiber.StatusUpgradeRequired).JSON(fiber.Map{"success": false, "error": "offline protocol v1 is retired", "required_protocol": offlineProtocolVersionV2})
}

func (s *Server) handleOfflineChallengeV2(c *fiber.Ctx) error {
	if s.cfg == nil || !s.cfg.OfflineEnabled || !s.cfg.OfflineControlEnabled {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"success": false, "error": "not found"})
	}
	if len(c.Body()) > 4096 {
		return c.SendStatus(fiber.StatusRequestEntityTooLarge)
	}
	var req offlineChallengeV2Request
	if err := json.Unmarshal(c.Body(), &req); err != nil || req.TerminalID == uuid.Nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "invalid terminal"})
	}
	challenge, err := s.repos.Offline.CreateChallengeV2(c.Context(), req.TerminalID)
	if errors.Is(err, repository.ErrOfflineTerminalNotFound) {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"success": false, "error": "terminal unavailable"})
	}
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"success": true, "protocol_version": offlineProtocolVersionV2, "challenge_id": challenge.ChallengeID, "nonce": challenge.Nonce, "expires_at": challenge.ExpiresAt, "terminal_state": challenge.State})
}

func (s *Server) handleOfflineSyncV2(c *fiber.Ctx) error {
	if s.cfg == nil || !s.cfg.OfflineEnabled || !s.cfg.OfflineControlEnabled {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"success": false, "error": "not found"})
	}
	if len(c.Body()) > offlineMaxSyncBodyBytes {
		return c.SendStatus(fiber.StatusRequestEntityTooLarge)
	}
	var req offlineSyncV2Request
	if err := json.Unmarshal(c.Body(), &req); err != nil || req.TerminalID == uuid.Nil || req.AccountID == uuid.Nil || len(req.Operations) > offlineMaxOperations {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "invalid sync request"})
	}
	posture, postureValid := domain.NormalizeOfflineDevicePosture(req.DevicePosture)
	if !postureValid {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "invalid device posture"})
	}
	if !validOfflineOperationBatch(req.Operations) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "operation ids must be unique and in-batch dependencies must reference earlier operations"})
	}
	record, challengeID, nonce, counter, err := s.authenticateOfflineV2(c, req.TerminalID, req.AccountID, req.InstallInstanceHash)
	if err != nil {
		return offlineProofError(c, err)
	}
	if err := s.repos.Offline.ConsumeChallengeV2(c.Context(), challengeID, req.TerminalID, req.AccountID, nonce, counter); err != nil {
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "error": "request replayed or out of order"})
	}
	controls, err := s.repos.Offline.PendingControlDirectives(c.Context(), req.TerminalID)
	if err != nil {
		return err
	}
	if record.TerminalState == "revoked" || record.GrantState == "revoked" {
		return c.JSON(fiber.Map{"success": true, "server_time": time.Now().UTC(), "terminal_state": "revoked", "controls": controls, "inventory": []any{}, "fetch_required": []any{}, "operation_results": []any{}})
	}
	if !s.cfg.OfflineSyncReadEnabled {
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"success": false, "error": "offline synchronization is not enabled"})
	}
	if !offlineSemverAtLeast(req.ClientVersion, s.cfg.OfflineMinClientVersion) {
		return c.Status(fiber.StatusUpgradeRequired).JSON(fiber.Map{"success": false, "error": "offline client update required", "minimum_client_version": s.cfg.OfflineMinClientVersion})
	}
	if len(req.BootIDHash) != 64 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "boot identity is required"})
	}
	if err := s.validateOfflineGrantAndSelections(c, record); err != nil {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	results, err := s.applyOfflineOperationsV2(c.Context(), record, req.Operations)
	if errors.Is(err, repository.ErrOfflineOperationIDReuse) {
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "error": "operation id was reused with different content"})
	}
	if err != nil {
		return err
	}
	inventory, err := s.repos.Offline.Inventory(c.Context(), req.TerminalID, req.AccountID)
	if err != nil {
		return err
	}
	fetchRequired := offlineInventoryDiff(inventory, req.Inventory)
	lease, err := s.signOfflineLeaseV2(c.Context(), record, strings.ToLower(req.BootIDHash))
	if err != nil {
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"success": false, "error": "offline lease signer is unavailable"})
	}
	if err := s.repos.Offline.RecordSuccessfulSyncV2(c.Context(), req.TerminalID, strings.TrimSpace(req.ClientVersion), req.UsedStorageBytes, posture); err != nil {
		return err
	}
	return c.JSON(fiber.Map{"success": true, "protocol_version": offlineProtocolVersionV2, "server_time": time.Now().UTC(), "terminal_state": "active", "controls": controls, "inventory": inventory, "fetch_required": fetchRequired, "operation_results": results, "lease": lease, "selection_revision": record.SelectionRevision})
}

func (s *Server) handleOfflineResourceFetchV2(c *fiber.Ctx) error {
	if s.cfg == nil || !s.cfg.OfflineEnabled || !s.cfg.OfflineControlEnabled || !s.cfg.OfflineSyncReadEnabled {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"success": false, "error": "not found"})
	}
	if len(c.Body()) > offlineMaxSyncBodyBytes {
		return c.SendStatus(fiber.StatusRequestEntityTooLarge)
	}
	var req offlineFetchV2Request
	if err := json.Unmarshal(c.Body(), &req); err != nil || req.TerminalID == uuid.Nil || req.AccountID == uuid.Nil || len(req.SelectionIDs) == 0 || len(req.SelectionIDs) > 50 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "invalid resource request"})
	}
	record, challengeID, nonce, counter, err := s.authenticateOfflineV2(c, req.TerminalID, req.AccountID, req.InstallInstanceHash)
	if err != nil {
		return offlineProofError(c, err)
	}
	if err := s.repos.Offline.ConsumeChallengeV2(c.Context(), challengeID, req.TerminalID, req.AccountID, nonce, counter); err != nil {
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "error": "request replayed or out of order"})
	}
	if record.TerminalState != "active" || record.GrantState != "active" {
		controls, controlErr := s.repos.Offline.PendingControlDirectives(c.Context(), req.TerminalID)
		if controlErr != nil {
			return controlErr
		}
		return c.JSON(fiber.Map{"success": true, "terminal_state": "revoked", "controls": controls, "snapshots": []any{}})
	}
	if err := s.validateOfflineGrantAndSelections(c, record); err != nil {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	inventory, err := s.repos.Offline.Inventory(c.Context(), req.TerminalID, req.AccountID)
	if err != nil {
		return err
	}
	requested := make(map[uuid.UUID]bool, len(req.SelectionIDs))
	for _, id := range req.SelectionIDs {
		if requested[id] {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "duplicate selection id"})
		}
		requested[id] = true
	}
	for _, item := range inventory {
		if requested[item.SelectionID] {
			if err := s.validateOfflineInventoryItem(c, record, item); err != nil {
				return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"success": false, "error": "selected resource is no longer accessible"})
			}
		}
	}
	snapshots, err := s.repos.Offline.FetchSelectedSnapshotsV2(c.Context(), req.TerminalID, req.AccountID, record.UserID, req.SelectionIDs)
	if errors.Is(err, repository.ErrOfflineResourceInvalid) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "selection is not part of this grant"})
	}
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"success": true, "terminal_state": "active", "snapshots": snapshots})
}

func (s *Server) handleOfflineControlAckV2(c *fiber.Ctx) error {
	if s.cfg == nil || !s.cfg.OfflineEnabled || !s.cfg.OfflineControlEnabled {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"success": false, "error": "not found"})
	}
	var req offlineControlAckV2Request
	if err := json.Unmarshal(c.Body(), &req); err != nil || req.TerminalID == uuid.Nil || req.AccountID == uuid.Nil || req.DirectiveID == uuid.Nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "invalid acknowledgement"})
	}
	_, challengeID, nonce, counter, err := s.authenticateOfflineV2(c, req.TerminalID, req.AccountID, req.InstallInstanceHash)
	if err != nil {
		return offlineProofError(c, err)
	}
	if err := s.repos.Offline.ConsumeChallengeV2(c.Context(), challengeID, req.TerminalID, req.AccountID, nonce, counter); err != nil {
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "error": "request replayed or out of order"})
	}
	if len(req.Acknowledgement) > 4096 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "acknowledgement is too large"})
	}
	if err := s.repos.Offline.AcknowledgeControl(c.Context(), req.TerminalID, req.DirectiveID, req.Acknowledgement); errors.Is(err, repository.ErrOfflineTerminalNotFound) {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"success": false, "error": "directive not found"})
	} else if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) authenticateOfflineV2(c *fiber.Ctx, terminalID, accountID uuid.UUID, installInstanceHash string) (*repository.OfflineAuthRecordV2, uuid.UUID, string, int64, error) {
	record, err := s.repos.Offline.OfflineAuthV2(c.Context(), terminalID, accountID)
	if err != nil {
		return nil, uuid.Nil, "", 0, err
	}
	if len(installInstanceHash) != 64 || len(record.InstallInstanceHash) != 64 || subtle.ConstantTimeCompare([]byte(strings.ToLower(installInstanceHash)), []byte(strings.ToLower(record.InstallInstanceHash))) != 1 {
		return nil, uuid.Nil, "", 0, errors.New("installation identity mismatch")
	}
	challengeID, err := uuid.Parse(strings.TrimSpace(c.Get("X-Clarin-Challenge-ID")))
	if err != nil {
		return nil, uuid.Nil, "", 0, errors.New("invalid challenge")
	}
	nonce := strings.TrimSpace(c.Get("X-Clarin-Nonce"))
	counter, err := strconv.ParseInt(strings.TrimSpace(c.Get("X-Clarin-Counter")), 10, 64)
	if err != nil || nonce == "" || counter < 1 {
		return nil, uuid.Nil, "", 0, errors.New("invalid request proof")
	}
	if err := s.verifyOfflineRequestV2(c, record, challengeID, nonce, counter); err != nil {
		return nil, uuid.Nil, "", 0, err
	}
	return record, challengeID, nonce, counter, nil
}

func (s *Server) verifyOfflineRequestV2(c *fiber.Ctx, record *repository.OfflineAuthRecordV2, challengeID uuid.UUID, nonce string, counter int64) error {
	block, trailing := pem.Decode([]byte(record.PublicKeyPEM))
	if block == nil || block.Type != "PUBLIC KEY" || len(bytes.TrimSpace(trailing)) != 0 {
		return errors.New("terminal public key is invalid")
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return err
	}
	publicKey, ok := parsed.(*ecdsa.PublicKey)
	if !ok || publicKey.Curve != elliptic.P256() {
		return errors.New("unsupported terminal key")
	}
	contentType := strings.ToLower(strings.TrimSpace(strings.Split(c.Get(fiber.HeaderContentType), ";")[0]))
	if contentType != fiber.MIMEApplicationJSON {
		return errors.New("unsupported content type")
	}
	bodyHash := sha256.Sum256(c.Body())
	canonical := strings.Join([]string{
		"CLARIN-OFFLINE-V2",
		c.Method(),
		c.Path(),
		record.TerminalID.String(),
		record.AccountID.String(),
		challengeID.String(),
		nonce,
		strconv.FormatInt(counter, 10),
		contentType,
		base64.RawURLEncoding.EncodeToString(bodyHash[:]),
	}, "\n")
	digest := sha256.Sum256([]byte(canonical))
	signature, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(c.Get("X-Clarin-Signature")))
	if err != nil || !ecdsa.VerifyASN1(publicKey, digest[:], signature) {
		return errors.New("signature mismatch")
	}
	return nil
}

func (s *Server) validateOfflineGrantAndSelections(c *fiber.Ctx, record *repository.OfflineAuthRecordV2) error {
	for _, module := range record.Modules {
		allowed, err := s.repos.Offline.UserHasAccountModule(c.Context(), record.UserID, record.AccountID, module)
		if err != nil {
			return err
		}
		if !allowed {
			return errors.New("offline grant no longer matches current access")
		}
	}
	inventory, err := s.repos.Offline.Inventory(c.Context(), record.TerminalID, record.AccountID)
	if err != nil {
		return err
	}
	for _, item := range inventory {
		if err := s.validateOfflineInventoryItem(c, record, item); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) validateOfflineInventoryItem(c *fiber.Ctx, record *repository.OfflineAuthRecordV2, item domain.OfflineInventoryItem) error {
	switch item.ResourceType {
	case domain.OfflineResourceWhiteboard:
		_, err := s.repos.Whiteboard.RequireAccess(c.Context(), record.AccountID, record.UserID, item.ResourceID, domain.WhiteboardAccessView)
		return err
	case domain.OfflineResourceTaskList:
		_, err := s.repos.TaskWork.RequireContainerAccess(c.Context(), record.AccountID, record.UserID, item.ResourceID, domain.TaskAccessTargetList, domain.TaskAccessView)
		return err
	case domain.OfflineResourceContact:
		var exists bool
		err := s.repos.DB().QueryRow(c.Context(), `SELECT EXISTS(SELECT 1 FROM contacts WHERE account_id=$1 AND id=$2 AND is_group=FALSE)`, record.AccountID, item.ResourceID).Scan(&exists)
		if err != nil || !exists {
			return errors.New("contact is not accessible")
		}
		return nil
	case domain.OfflineResourceProgram:
		var exists bool
		err := s.repos.DB().QueryRow(c.Context(), `SELECT EXISTS(SELECT 1 FROM programs WHERE account_id=$1 AND id=$2)`, record.AccountID, item.ResourceID).Scan(&exists)
		if err != nil || !exists {
			return errors.New("program is not accessible")
		}
		return nil
	default:
		return errors.New("unsupported resource")
	}
}

func (s *Server) signOfflineLeaseV2(ctx context.Context, record *repository.OfflineAuthRecordV2, bootIDHash string) (fiber.Map, error) {
	now := time.Now().UTC()
	claims := offlineLeaseClaimsV2{Version: offlineProtocolVersionV2, TerminalID: record.TerminalID, UserID: record.UserID, AccountID: record.AccountID, BootIDHash: bootIDHash, Modules: record.Modules, Actions: s.effectiveOfflineActions(record.Modules), TerminalPolicyRevision: record.PolicyRevision, GrantPolicyRevision: record.GrantRevision, SelectionRevision: record.SelectionRevision, MaxStorageBytes: record.MaxStorageBytes, IssuedAt: now, ExpiresAt: now.Add(time.Duration(record.MaxOfflineSeconds) * time.Second)}
	payload, err := json.Marshal(claims)
	if err != nil {
		return nil, err
	}
	signature, keyVersion, err := s.signOfflinePayload(ctx, payload)
	if err != nil {
		return nil, err
	}
	return fiber.Map{"payload": base64.RawURLEncoding.EncodeToString(payload), "signature": signature, "key_version": keyVersion}, nil
}

func (s *Server) effectiveOfflineActions(modules []string) json.RawMessage {
	actions := make(map[string]map[string]bool, len(modules))
	for _, module := range modules {
		switch module {
		case domain.OfflineModuleWhiteboards:
			actions[module] = map[string]bool{"edit_scene": s.cfg.OfflineWriteWhiteboards, "upload_asset": false}
		case domain.OfflineModuleTasks:
			actions[module] = map[string]bool{"create": s.cfg.OfflineWriteTasks, "edit_simple": false, "complete": s.cfg.OfflineWriteTasks}
		case domain.OfflineModuleContacts:
			actions[module] = map[string]bool{"edit_identity": s.cfg.OfflineWriteContacts, "add_observation": s.cfg.OfflineWriteContacts, "assign_existing_tags": s.cfg.OfflineWriteContacts}
		case domain.OfflineModulePrograms:
			actions[module] = map[string]bool{"attendance": s.cfg.OfflineWritePrograms, "add_participant_observation": false}
		}
	}
	encoded, _ := json.Marshal(actions)
	return encoded
}

func offlineInventoryDiff(server []domain.OfflineInventoryItem, client []domain.OfflineClientInventoryItem) []uuid.UUID {
	clientByID := make(map[uuid.UUID]domain.OfflineClientInventoryItem, len(client))
	for _, item := range client {
		if item.SelectionID != uuid.Nil {
			clientByID[item.SelectionID] = item
		}
	}
	out := make([]uuid.UUID, 0)
	for _, item := range server {
		local, ok := clientByID[item.SelectionID]
		if !ok || local.HeadVersion != item.HeadVersion || (item.ContentHash != "" && !strings.EqualFold(local.ContentHash, item.ContentHash)) {
			out = append(out, item.SelectionID)
		}
	}
	return out
}

func validOfflineOperationBatch(operations []domain.OfflineOperation) bool {
	all := make(map[uuid.UUID]bool, len(operations))
	for _, operation := range operations {
		if operation.OperationID == uuid.Nil || all[operation.OperationID] {
			return false
		}
		all[operation.OperationID] = true
	}
	seen := make(map[uuid.UUID]bool, len(operations))
	for _, operation := range operations {
		for _, dependency := range operation.DependsOn {
			if dependency == uuid.Nil || dependency == operation.OperationID || (all[dependency] && !seen[dependency]) {
				return false
			}
		}
		seen[operation.OperationID] = true
	}
	return true
}

func offlineSemverAtLeast(current, minimum string) bool {
	parse := func(raw string) ([3]int, bool) {
		var out [3]int
		raw = strings.TrimPrefix(strings.TrimSpace(raw), "v")
		core := strings.SplitN(raw, "-", 2)[0]
		parts := strings.Split(core, ".")
		if len(parts) != 3 {
			return out, false
		}
		for i, part := range parts {
			value, err := strconv.Atoi(part)
			if err != nil || value < 0 {
				return out, false
			}
			out[i] = value
		}
		return out, true
	}
	got, gotOK := parse(current)
	want, wantOK := parse(minimum)
	if !gotOK || !wantOK {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return got[i] > want[i]
		}
	}
	return true
}

func offlineProofError(c *fiber.Ctx, err error) error {
	status := fiber.StatusUnauthorized
	if errors.Is(err, repository.ErrOfflineTerminalNotFound) {
		status = fiber.StatusNotFound
	}
	return c.Status(status).JSON(fiber.Map{"success": false, "error": "terminal authorization failed"})
}
