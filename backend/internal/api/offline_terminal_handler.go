package api

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
)

const (
	maxOfflineTerminalStorage = int64(5 * 1024 * 1024 * 1024)
	maxOfflineLeaseSeconds    = 24 * 60 * 60
)

var offlineAllowedModules = map[string]json.RawMessage{
	domain.OfflineModuleWhiteboards: json.RawMessage(`{"edit_scene":false,"upload_asset":false}`),
	domain.OfflineModuleTasks:       json.RawMessage(`{"create":true,"edit_simple":false,"complete":true}`),
	domain.OfflineModuleContacts:    json.RawMessage(`{"edit_identity":false,"add_observation":false,"assign_existing_tags":false}`),
	domain.OfflineModulePrograms:    json.RawMessage(`{"attendance":false,"add_participant_observation":false}`),
}

type requestOfflineTerminalRequest struct {
	TerminalID          uuid.UUID                   `json:"terminal_id"`
	DisplayName         string                      `json:"display_name"`
	PublicKeyPEM        string                      `json:"public_key_pem"`
	WindowsSIDHash      string                      `json:"windows_sid_hash"`
	InstallInstanceHash string                      `json:"install_instance_hash"`
	ClientVersion       string                      `json:"client_version"`
	DevicePosture       domain.OfflineDevicePosture `json:"device_posture"`
}

type approveOfflineTerminalRequest struct {
	Grants                []domain.OfflineGrantInput `json:"grants"`
	AcknowledgeDeviceRisk bool                       `json:"acknowledge_device_risk"`
}

type activateOfflineTerminalRequest struct {
	TerminalID          uuid.UUID `json:"terminal_id"`
	InstallInstanceHash string    `json:"install_instance_hash"`
	Signature           string    `json:"signature"`
}

// The authenticated user identity is authoritative. The desktop bridge sends
// only public device metadata; its private key never leaves Windows CNG.
func (s *Server) handleRequestOfflineTerminal(c *fiber.Ctx) error {
	if s.cfg == nil || !s.cfg.OfflineEnabled || !s.cfg.OfflineControlEnabled || !s.cfg.OfflineEnrollmentEnabled {
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"success": false, "error": "offline enrollment is disabled"})
	}
	if available, _, _ := s.offlineInstallerMetadata(); !available {
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"success": false, "error": "offline installer is not published"})
	}
	userID, ok := c.Locals("user_id").(uuid.UUID)
	if !ok || userID == uuid.Nil {
		return c.SendStatus(fiber.StatusUnauthorized)
	}
	var req requestOfflineTerminalRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "invalid enrollment request"})
	}
	req.DisplayName = strings.TrimSpace(req.DisplayName)
	req.ClientVersion = strings.TrimSpace(req.ClientVersion)
	posture, postureValid := domain.NormalizeOfflineDevicePosture(req.DevicePosture)
	if req.TerminalID == uuid.Nil || req.DisplayName == "" || len(req.DisplayName) > 160 || req.PublicKeyPEM == "" || len(req.PublicKeyPEM) > 16*1024 || len(req.WindowsSIDHash) != 64 || len(req.InstallInstanceHash) != 64 || !offlineSemverAtLeast(req.ClientVersion, s.cfg.OfflineMinClientVersion) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "invalid terminal identity or client version"})
	}
	if !postureValid {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "invalid device posture"})
	}
	if _, err := hex.DecodeString(req.WindowsSIDHash); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "invalid Windows identity"})
	}
	if _, err := hex.DecodeString(req.InstallInstanceHash); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "invalid installation identity"})
	}
	publicKeyPEM, err := validateOfflinePublicKey(req.PublicKeyPEM)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	installHash := strings.ToLower(req.InstallInstanceHash)
	if existing, existingErr := s.repos.Offline.EnrollmentRequest(c.Context(), req.TerminalID, userID); existingErr == nil {
		if !constantTimeStringEqual(existing.InstallInstanceHash, installHash) || !constantTimeStringEqual(existing.PublicKeyPEM, publicKeyPEM) {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "error": "terminal identity already exists"})
		}
		if err := s.repos.Offline.RecordDevicePosture(c.Context(), req.TerminalID, posture); err != nil {
			return err
		}
		return c.JSON(fiber.Map{"success": true, "terminal_id": existing.TerminalID, "state": existing.State, "idempotent": true})
	} else if !errors.Is(existingErr, repository.ErrOfflineTerminalNotFound) {
		return existingErr
	}
	terminal, err := s.repos.Offline.RequestTerminal(c.Context(), req.TerminalID, userID, req.DisplayName, strings.ToLower(req.WindowsSIDHash), installHash, req.ClientVersion, publicKeyPEM, posture)
	if errors.Is(err, repository.ErrOfflineTerminalExists) {
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "error": "this user already has an offline terminal request"})
	}
	if err != nil {
		return err
	}
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"success": true, "terminal_id": terminal.ID, "state": terminal.State})
}

func (s *Server) handleUserOfflineEnrollmentStatus(c *fiber.Ctx) error {
	if s.cfg == nil || !s.cfg.OfflineEnabled || !s.cfg.OfflineControlEnabled || !s.cfg.OfflineEnrollmentEnabled {
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"success": false, "error": "offline enrollment is disabled"})
	}
	userID, ok := c.Locals("user_id").(uuid.UUID)
	if !ok || userID == uuid.Nil {
		return c.SendStatus(fiber.StatusUnauthorized)
	}
	terminalID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "invalid terminal id"})
	}
	record, err := s.repos.Offline.EnrollmentRequest(c.Context(), terminalID, userID)
	if errors.Is(err, repository.ErrOfflineTerminalNotFound) {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"success": false, "error": "terminal request not found"})
	}
	if err != nil {
		return err
	}
	response := fiber.Map{"success": true, "terminal_id": terminalID, "display_name": record.DisplayName, "state": record.State}
	if record.State == "approved" || record.State == "active" {
		token, err := s.offlineSignerToken()
		if err != nil {
			return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"success": false, "error": "offline signer is unavailable"})
		}
		keyVersion, publicKey, err := s.offlineSignerKey(c.Context(), token, 0)
		if err != nil {
			return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"success": false, "error": "offline signer is unavailable"})
		}
		accounts, err := s.repos.Offline.ApprovedAccountsForTerminal(c.Context(), terminalID, userID)
		if err != nil {
			return err
		}
		response["lease_key_version"] = keyVersion
		response["lease_public_key_pem"] = publicKey
		response["accounts"] = accounts
	}
	return c.JSON(response)
}

func (s *Server) validateOfflineApprovalGrants(c *fiber.Ctx, userID uuid.UUID, grants []domain.OfflineGrantInput) ([]domain.OfflineGrantInput, error) {
	if len(grants) == 0 || len(grants) > 5 {
		return nil, fiber.NewError(fiber.StatusBadRequest, "between one and five account grants are required")
	}
	seenAccounts := make(map[uuid.UUID]struct{}, len(grants))
	for index := range grants {
		grant := &grants[index]
		if grant.AccountID == uuid.Nil || len(grant.Resources) != 0 || len(grant.Modules) == 0 {
			return nil, fiber.NewError(fiber.StatusBadRequest, "invalid offline account grant")
		}
		if _, duplicate := seenAccounts[grant.AccountID]; duplicate {
			return nil, fiber.NewError(fiber.StatusBadRequest, "duplicate offline account grant")
		}
		seenAccounts[grant.AccountID] = struct{}{}
		grant.MaxOfflineSeconds = maxOfflineLeaseSeconds
		grant.QuotaBytes = maxOfflineTerminalStorage
		actions := make(map[string]json.RawMessage, len(grant.Modules))
		seenModules := make(map[string]struct{}, len(grant.Modules))
		for _, module := range grant.Modules {
			allowedActions, exists := offlineAllowedModules[module]
			if !exists {
				return nil, fiber.NewError(fiber.StatusBadRequest, "unsupported offline module")
			}
			if _, duplicate := seenModules[module]; duplicate {
				return nil, fiber.NewError(fiber.StatusBadRequest, "duplicate offline module")
			}
			seenModules[module] = struct{}{}
			allowed, err := s.repos.Offline.UserHasAccountModule(c.Context(), userID, grant.AccountID, module)
			if err != nil {
				return nil, err
			}
			if !allowed {
				return nil, fiber.NewError(fiber.StatusBadRequest, "the user does not have current access to every requested module")
			}
			actions[module] = allowedActions
		}
		grant.Actions, _ = json.Marshal(actions)
	}
	return grants, nil
}

func (s *Server) handleAdminApproveOfflineTerminal(c *fiber.Ctx) error {
	if s.cfg == nil || !s.cfg.OfflineEnabled || !s.cfg.OfflineControlEnabled || !s.cfg.OfflineEnrollmentEnabled {
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"success": false, "error": "offline enrollment is disabled"})
	}
	terminalID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "invalid terminal id"})
	}
	record, err := s.repos.Offline.RequestedTerminal(c.Context(), terminalID)
	if errors.Is(err, repository.ErrOfflineTerminalNotFound) {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"success": false, "error": "terminal request not found"})
	}
	if err != nil {
		return err
	}
	if record.State != "requested" {
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "error": "terminal is not awaiting approval"})
	}
	var req approveOfflineTerminalRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "invalid approval request"})
	}
	posture := domain.OfflineDevicePosture{BitLocker: record.BitLockerStatus, WindowsHello: record.WindowsHelloStatus}
	if err := validateOfflineRiskAcknowledgement(posture, req.AcknowledgeDeviceRisk); err != nil {
		return err
	}
	grants, err := s.validateOfflineApprovalGrants(c, record.UserID, req.Grants)
	if err != nil {
		return err
	}
	publicKeyPEM, err := validateOfflinePublicKey(record.PublicKeyPEM)
	if err != nil || !constantTimeStringEqual(publicKeyPEM, record.PublicKeyPEM) {
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "error": "stored terminal identity is invalid"})
	}
	actorID := c.Locals("user_id").(uuid.UUID)
	if err := s.repos.Offline.ApproveRequestedTerminal(c.Context(), terminalID, actorID, grants, req.AcknowledgeDeviceRisk); errors.Is(err, repository.ErrOfflineTerminalNotRequested) {
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "error": "terminal request changed during approval"})
	} else if errors.Is(err, repository.ErrOfflineDeviceRiskNotAcknowledged) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Confirma que autorizas el equipo sin todas las protecciones recomendadas."})
	} else if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"success": true, "terminal_id": terminalID, "state": "approved"})
}

func validateOfflineRiskAcknowledgement(posture domain.OfflineDevicePosture, acknowledged bool) error {
	if domain.OfflineDevicePostureRequiresRiskAcknowledgement(posture) && !acknowledged {
		return fiber.NewError(fiber.StatusBadRequest, "Confirma que autorizas el equipo sin todas las protecciones recomendadas.")
	}
	return nil
}

func (s *Server) handleAdminRejectOfflineTerminal(c *fiber.Ctx) error {
	if s.cfg == nil || !s.cfg.OfflineEnabled || !s.cfg.OfflineControlEnabled {
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"success": false, "error": "offline control plane is disabled"})
	}
	terminalID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "invalid terminal id"})
	}
	actorID := c.Locals("user_id").(uuid.UUID)
	if err := s.repos.Offline.RejectRequestedTerminal(c.Context(), terminalID, actorID); errors.Is(err, repository.ErrOfflineTerminalNotFound) {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"success": false, "error": "terminal request not found"})
	} else if errors.Is(err, repository.ErrOfflineTerminalNotRequested) {
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "error": "terminal is not awaiting approval"})
	} else if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"success": true, "terminal_id": terminalID, "state": "rejected"})
}

func (s *Server) handleActivateOfflineTerminal(c *fiber.Ctx) error {
	if s.cfg == nil || !s.cfg.OfflineEnabled || !s.cfg.OfflineControlEnabled || !s.cfg.OfflineEnrollmentEnabled {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"success": false, "error": "not found"})
	}
	var req activateOfflineTerminalRequest
	if err := c.BodyParser(&req); err != nil || req.TerminalID == uuid.Nil || len(req.InstallInstanceHash) != 64 || len(req.Signature) > 512 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "invalid activation request"})
	}
	if _, err := hex.DecodeString(req.InstallInstanceHash); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "invalid installation identity"})
	}
	record, err := s.repos.Offline.RequestedTerminal(c.Context(), req.TerminalID)
	if errors.Is(err, repository.ErrOfflineTerminalNotFound) {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"success": false, "error": "terminal request not found"})
	}
	if err != nil {
		return err
	}
	if record.State != "approved" && record.State != "active" {
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "error": "terminal has not been approved"})
	}
	installHash := strings.ToLower(req.InstallInstanceHash)
	if !constantTimeStringEqual(installHash, strings.ToLower(record.InstallInstanceHash)) {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"success": false, "error": "installation identity mismatch"})
	}
	if !verifyOfflineActivationProof(record.PublicKeyPEM, req.TerminalID, installHash, req.Signature) {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"success": false, "error": "terminal proof is invalid"})
	}
	if _, err := s.repos.Offline.ActivateApprovedTerminal(c.Context(), req.TerminalID, installHash); errors.Is(err, repository.ErrOfflineEnrollmentInvalid) {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"success": false, "error": "installation identity mismatch"})
	} else if errors.Is(err, repository.ErrOfflineTerminalNotActive) {
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "error": "terminal has not been approved"})
	} else if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"success": true, "terminal_id": req.TerminalID, "state": "active"})
}

func verifyOfflineActivationProof(publicKeyPEM string, terminalID uuid.UUID, installInstanceHash, encodedSignature string) bool {
	block, trailing := pem.Decode([]byte(publicKeyPEM))
	if block == nil || len(bytes.TrimSpace(trailing)) != 0 {
		return false
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	publicKey, ok := parsed.(*ecdsa.PublicKey)
	if err != nil || !ok || publicKey.Curve != elliptic.P256() {
		return false
	}
	canonical := strings.Join([]string{"CLARIN-OFFLINE-ACTIVATE", terminalID.String(), strings.ToLower(installInstanceHash)}, "\n")
	digest := sha256.Sum256([]byte(canonical))
	signature, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(encodedSignature))
	return err == nil && ecdsa.VerifyASN1(publicKey, digest[:], signature)
}

func validateOfflinePublicKey(raw string) (string, error) {
	block, trailing := pem.Decode([]byte(strings.TrimSpace(raw)))
	if block == nil || block.Type != "PUBLIC KEY" || len(bytes.TrimSpace(trailing)) != 0 {
		return "", errors.New("terminal public key is invalid")
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	key, ok := parsed.(*ecdsa.PublicKey)
	if err != nil || !ok || key.Curve != elliptic.P256() {
		return "", errors.New("terminal key must be ECDSA P-256")
	}
	der, err := x509.MarshalPKIXPublicKey(key)
	if err != nil {
		return "", err
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})), nil
}

func constantTimeStringEqual(left, right string) bool {
	return len(left) == len(right) && subtle.ConstantTimeCompare([]byte(left), []byte(right)) == 1
}

func (s *Server) handleAdminListOfflineTerminals(c *fiber.Ctx) error {
	terminals, err := s.repos.Offline.ListTerminals(c.Context())
	if err != nil {
		return err
	}
	available, filename, checksum := s.offlineInstallerMetadata()
	enabled := s.cfg != nil && s.cfg.OfflineEnabled && s.cfg.OfflineControlEnabled && s.cfg.OfflineEnrollmentEnabled
	return c.JSON(fiber.Map{"success": true, "terminals": terminals, "enabled": enabled, "installer_available": available, "installer_filename": filename, "installer_sha256": checksum})
}

func (s *Server) handleAdminRevokeOfflineTerminal(c *fiber.Ctx) error {
	if s.cfg == nil || !s.cfg.OfflineEnabled || !s.cfg.OfflineControlEnabled {
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"success": false, "error": "offline control plane is disabled"})
	}
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "invalid terminal id"})
	}
	actorID := c.Locals("user_id").(uuid.UUID)
	controlID := uuid.New()
	payload, err := json.Marshal(fiber.Map{"version": 2, "directive_id": controlID, "directive_type": "wipe", "terminal_id": id, "issued_at": time.Now().UTC()})
	if err != nil {
		return err
	}
	signature, keyVersion, err := s.signOfflinePayload(c.Context(), payload)
	if err != nil {
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"success": false, "error": "terminal revocation signer is unavailable; no partial revocation was applied"})
	}
	payloadHash := sha256.Sum256(payload)
	control := repository.OfflineSignedControlInput{ID: controlID, DirectiveType: "wipe", Payload: payload, PayloadHash: payloadHash[:], Signature: signature, SignerKeyVersion: keyVersion}
	if err := s.repos.Offline.RevokeTerminalWithControl(c.Context(), id, actorID, control); errors.Is(err, repository.ErrOfflineTerminalNotFound) {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"success": false, "error": "terminal not found"})
	} else if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleAdminOfflineAudit(c *fiber.Ctx) error {
	events, err := s.repos.Offline.Audit(c.Context(), 200)
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"success": true, "events": events})
}

func (s *Server) handleOfflineInstaller(c *fiber.Ctx) error {
	if s.cfg == nil || !s.cfg.OfflineEnabled || !s.cfg.OfflineEnrollmentEnabled {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"success": false, "error": "offline installer is not published"})
	}
	if _, ok := c.Locals("user_id").(uuid.UUID); !ok {
		return c.SendStatus(fiber.StatusUnauthorized)
	}
	return sendVerifiedOfflineArtifact(c, s.cfg.OfflineInstallerPath, s.cfg.OfflineInstallerSHA256, "exe")
}

func sendVerifiedOfflineArtifact(c *fiber.Ctx, path, expected, contentType string) error {
	if path == "" || expected == "" {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"success": false, "error": "offline artifact is not published"})
	}
	file, err := os.Open(path)
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"success": false, "error": "offline artifact is not published"})
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		_ = file.Close()
		return err
	}
	if !constantTimeStringEqual(hex.EncodeToString(hash.Sum(nil)), strings.ToLower(expected)) {
		_ = file.Close()
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"success": false, "error": "offline artifact integrity check failed"})
	}
	if _, err := file.Seek(0, 0); err != nil {
		_ = file.Close()
		return err
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return err
	}
	c.Set(fiber.HeaderContentDisposition, fmt.Sprintf(`attachment; filename="%s"`, filepath.Base(path)))
	c.Set(fiber.HeaderCacheControl, "private, no-store, no-cache, max-age=0, must-revalidate, no-transform")
	c.Set(fiber.HeaderPragma, "no-cache")
	c.Set(fiber.HeaderExpires, "0")
	c.Set(fiber.HeaderContentEncoding, "identity")
	c.Set("X-Clarin-SHA256", strings.ToLower(expected))
	c.Type(contentType)
	// fasthttp owns and closes body streams after transmission. Closing the
	// file when this handler returns truncates the response before it is sent.
	return c.SendStream(file, int(info.Size()))
}

func (s *Server) offlineInstallerMetadata() (bool, string, string) {
	if s.cfg == nil || !s.cfg.OfflineEnabled || !s.cfg.OfflineEnrollmentEnabled || s.cfg.OfflineInstallerPath == "" || len(s.cfg.OfflineInstallerSHA256) != 64 {
		return false, "", ""
	}
	info, err := os.Stat(s.cfg.OfflineInstallerPath)
	if err != nil || !info.Mode().IsRegular() {
		return false, "", ""
	}
	return true, filepath.Base(s.cfg.OfflineInstallerPath), strings.ToLower(s.cfg.OfflineInstallerSHA256)
}
