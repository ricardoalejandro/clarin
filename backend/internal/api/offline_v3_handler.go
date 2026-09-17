package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
	"github.com/naperu/clarin/internal/storage"
)

type offlineV3EnrollmentRequest struct {
	ChallengeID            uuid.UUID       `json:"challenge_id"`
	Nonce                  string          `json:"nonce"`
	InstallationID         uuid.UUID       `json:"installation_id"`
	WindowsPrincipalID     uuid.UUID       `json:"windows_principal_id"`
	BrowserProfileID       uuid.UUID       `json:"browser_profile_id"`
	AuthorizationID        uuid.UUID       `json:"authorization_id"`
	DisplayName            string          `json:"display_name"`
	PrincipalDisplayName   string          `json:"principal_display_name"`
	BrowserName            string          `json:"browser_name"`
	ClientVersion          string          `json:"client_version"`
	SIDHash                string          `json:"sid_hash"`
	InstallationSigningJWK json.RawMessage `json:"installation_signing_jwk"`
	ServiceEncryptionJWK   json.RawMessage `json:"service_encryption_jwk"`
	BrowserDPoPJWK         json.RawMessage `json:"browser_dpop_jwk"`
	InstallationSignature  string          `json:"installation_signature"`
	PrincipalSignature     string          `json:"principal_signature"`
	BrowserSignature       string          `json:"browser_signature"`
}

type offlineV3EnrollmentMaterial struct {
	ChallengeID            uuid.UUID       `json:"challenge_id"`
	Nonce                  string          `json:"nonce"`
	InstallationID         uuid.UUID       `json:"installation_id"`
	WindowsPrincipalID     uuid.UUID       `json:"windows_principal_id"`
	BrowserProfileID       uuid.UUID       `json:"browser_profile_id"`
	AuthorizationID        uuid.UUID       `json:"authorization_id"`
	DisplayName            string          `json:"display_name"`
	PrincipalDisplayName   string          `json:"principal_display_name"`
	BrowserName            string          `json:"browser_name"`
	ClientVersion          string          `json:"client_version"`
	SIDHash                string          `json:"sid_hash"`
	InstallationSigningJWK json.RawMessage `json:"installation_signing_jwk"`
	ServiceEncryptionJWK   json.RawMessage `json:"service_encryption_jwk"`
	BrowserDPoPJWK         json.RawMessage `json:"browser_dpop_jwk"`
}

type offlineV3GrantProofRequest struct {
	ChallengeID           uuid.UUID       `json:"challenge_id"`
	Nonce                 string          `json:"nonce"`
	Counter               int64           `json:"counter"`
	SigningJWK            json.RawMessage `json:"signing_jwk,omitempty"`
	EncryptionJWK         json.RawMessage `json:"encryption_jwk,omitempty"`
	InstallationSignature string          `json:"installation_signature"`
	BrowserSignature      string          `json:"browser_signature"`
	GrantSignature        string          `json:"grant_signature"`
}

type offlineV3GrantProofMaterial struct {
	ChallengeID   uuid.UUID       `json:"challenge_id"`
	Nonce         string          `json:"nonce"`
	Counter       int64           `json:"counter"`
	GrantID       uuid.UUID       `json:"grant_id"`
	SigningJWK    json.RawMessage `json:"signing_jwk,omitempty"`
	EncryptionJWK json.RawMessage `json:"encryption_jwk,omitempty"`
}

type offlineV3LeaseClaims struct {
	Issuer                       string   `json:"iss"`
	Audience                     string   `json:"aud"`
	IssuedAt                     int64    `json:"iat"`
	NotBefore                    int64    `json:"nbf"`
	ExpiresAt                    int64    `json:"exp"`
	ID                           string   `json:"jti"`
	Version                      int      `json:"version"`
	InstallationID               string   `json:"installation_id"`
	WindowsPrincipalID           string   `json:"windows_principal_id"`
	BrowserProfileID             string   `json:"browser_profile_id"`
	AuthorizationID              string   `json:"authorization_id"`
	GrantID                      string   `json:"grant_id"`
	UserID                       string   `json:"user_id"`
	AccountID                    string   `json:"account_id"`
	LoginBindingSHA256           string   `json:"login_binding_sha256"`
	CredentialEpoch              int64    `json:"credential_epoch"`
	AuthorityEpoch               int64    `json:"authority_epoch"`
	InstallationRevision         int64    `json:"installation_revision"`
	PrincipalRevision            int64    `json:"principal_revision"`
	BrowserRevision              int64    `json:"browser_revision"`
	AuthorizationRevision        int64    `json:"authorization_revision"`
	GrantRevision                int64    `json:"grant_revision"`
	SelectionRevision            int64    `json:"selection_revision"`
	SelectionDigest              string   `json:"selection_digest"`
	Actions                      []string `json:"actions"`
	MaxStorageBytes              int64    `json:"max_storage_bytes"`
	BrowserKeyThumbprint         string   `json:"browser_key_thumbprint"`
	GrantSigningKeyThumbprint    string   `json:"grant_signing_key_thumbprint"`
	GrantEncryptionKeyThumbprint string   `json:"grant_encryption_key_thumbprint"`
}

type offlineV3ServiceDescriptorClaims struct {
	Issuer                   string          `json:"iss"`
	Audience                 string          `json:"aud"`
	IssuedAt                 int64           `json:"iat"`
	NotBefore                int64           `json:"nbf"`
	ExpiresAt                int64           `json:"exp"`
	ID                       string          `json:"jti"`
	Version                  int             `json:"version"`
	InstallationID           string          `json:"installation_id"`
	WindowsPrincipalID       string          `json:"windows_principal_id"`
	BrowserProfileID         string          `json:"browser_profile_id"`
	ServerOrigin             string          `json:"server_origin"`
	TransportEncryptionKeyID string          `json:"transport_encryption_kid"`
	TransportEncryptionJWK   json.RawMessage `json:"transport_encryption_jwk"`
	ServiceSigningKeyID      string          `json:"service_signing_kid"`
	ServiceSigningJWK        json.RawMessage `json:"service_signing_jwk"`
}

func (s *Server) requireOfflineV3(c *fiber.Ctx) error {
	if s.cfg == nil || !s.cfg.OfflineV3Enabled || s.repos == nil || s.repos.OfflineV3 == nil {
		return offlineV3Error(c, fiber.StatusServiceUnavailable, "offline_v3_disabled")
	}
	return c.Next()
}

func offlineV3Error(c *fiber.Ctx, status int, code string) error {
	c.Set("Cache-Control", "no-store")
	return c.Status(status).JSON(fiber.Map{"error": code})
}

func offlineV3RepositoryError(c *fiber.Ctx, err error) error {
	switch {
	case errors.Is(err, repository.ErrOfflineV3Invalid):
		return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_request")
	case errors.Is(err, repository.ErrOfflineV3NotFound):
		return offlineV3Error(c, fiber.StatusNotFound, "offline_grant_not_found")
	case errors.Is(err, repository.ErrOfflineV3AccessDenied):
		return offlineV3Error(c, fiber.StatusForbidden, "offline_access_denied")
	case errors.Is(err, repository.ErrOfflineV3Conflict), errors.Is(err, repository.ErrOfflineV3KeyExists):
		return offlineV3Error(c, fiber.StatusConflict, "offline_state_conflict")
	case errors.Is(err, repository.ErrOfflineV3DependencyPending):
		return offlineV3Error(c, fiber.StatusConflict, "offline_dependency_pending")
	case errors.Is(err, repository.ErrOfflineV3Replay), errors.Is(err, repository.ErrOfflineV3ReceiptReuse):
		return offlineV3Error(c, fiber.StatusConflict, "offline_replay_rejected")
	default:
		return err
	}
}

func (s *Server) handleOfflineV3Availability(c *fiber.Ctx) error {
	enabled := s.cfg != nil && s.cfg.OfflineV3Enabled && s.repos != nil && s.repos.OfflineV3 != nil
	signerReady := false
	minimumClientVersion := "3.0.0"
	if s.cfg != nil && strings.TrimSpace(s.cfg.OfflineV3MinClientVersion) != "" {
		minimumClientVersion = s.cfg.OfflineV3MinClientVersion
	}
	if enabled {
		_, err := s.offlineV3SignerKeys(c)
		signerReady = err == nil
	}
	c.Set("Cache-Control", "no-store")
	return c.JSON(fiber.Map{"enabled": enabled, "minimum_client_version": minimumClientVersion, "signer_ready": signerReady,
		"protocol_version": domain.OfflineV3ProtocolVersion, "task_writes_enabled": enabled && s.cfg.OfflineV3TaskWrites})
}

func (s *Server) handleOfflineV3Installer(c *fiber.Ctx) error {
	if s.cfg == nil || !s.cfg.OfflineV3Enabled {
		return offlineV3Error(c, fiber.StatusNotFound, "offline_installer_not_published")
	}
	return sendVerifiedOfflineArtifact(c, s.cfg.OfflineInstallerPath, s.cfg.OfflineInstallerSHA256, "exe")
}

func (s *Server) handleOfflineV3EnrollmentChallenge(c *fiber.Ctx) error {
	userID, ok := c.Locals("user_id").(uuid.UUID)
	if !ok || userID == uuid.Nil {
		return offlineV3Error(c, fiber.StatusUnauthorized, "unauthorized")
	}
	challenge, err := s.repos.OfflineV3.CreateUserChallenge(c.Context(), userID, "enrollment")
	if err != nil {
		return offlineV3RepositoryError(c, err)
	}
	return c.JSON(fiber.Map{"challenge_id": challenge.ID, "nonce": challenge.Nonce, "authorization_id": challenge.AuthorizationID,
		"expires_at": challenge.ExpiresAt, "server_time": time.Now().UTC()})
}

func (s *Server) handleOfflineV3EnrollmentRequest(c *fiber.Ctx) error {
	userID, ok := c.Locals("user_id").(uuid.UUID)
	if !ok || userID == uuid.Nil {
		return offlineV3Error(c, fiber.StatusUnauthorized, "unauthorized")
	}
	var request offlineV3EnrollmentRequest
	if err := offlineV3ReadStrictJSON(c, &request, 64<<10); err != nil {
		return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_enrollment")
	}
	material := offlineV3EnrollmentMaterial{ChallengeID: request.ChallengeID, Nonce: request.Nonce, InstallationID: request.InstallationID,
		WindowsPrincipalID: request.WindowsPrincipalID, BrowserProfileID: request.BrowserProfileID, AuthorizationID: request.AuthorizationID,
		DisplayName: strings.TrimSpace(request.DisplayName), PrincipalDisplayName: strings.TrimSpace(request.PrincipalDisplayName),
		BrowserName: strings.TrimSpace(request.BrowserName), ClientVersion: strings.TrimSpace(request.ClientVersion), SIDHash: strings.ToLower(request.SIDHash),
		InstallationSigningJWK: request.InstallationSigningJWK, ServiceEncryptionJWK: request.ServiceEncryptionJWK, BrowserDPoPJWK: request.BrowserDPoPJWK}
	if material.ChallengeID == uuid.Nil || material.InstallationID == uuid.Nil || material.WindowsPrincipalID == uuid.Nil ||
		material.BrowserProfileID == uuid.Nil || material.AuthorizationID == uuid.Nil || len(material.DisplayName) < 1 || len(material.DisplayName) > 160 ||
		len(material.PrincipalDisplayName) > 160 || len(material.BrowserName) > 80 || len(material.ClientVersion) < 1 || len(material.ClientVersion) > 40 ||
		len(material.Nonce) != 43 || len(material.SIDHash) != 64 {
		return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_enrollment")
	}
	if decoded, err := hex.DecodeString(material.SIDHash); err != nil || len(decoded) != sha256.Size {
		return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_enrollment")
	}
	installationKey, installationThumb, err := offlineV3PublicJWK(material.InstallationSigningJWK, "sig", string(jose.ES256))
	if err != nil {
		return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_enrollment")
	}
	_, serviceThumb, err := offlineV3PublicJWK(material.ServiceEncryptionJWK, "enc", string(jose.ECDH_ES_A256KW))
	if err != nil {
		return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_enrollment")
	}
	browserKey, browserThumb, err := offlineV3PublicJWK(material.BrowserDPoPJWK, "sig", string(jose.ES256))
	if err != nil || installationThumb == serviceThumb || installationThumb == browserThumb || serviceThumb == browserThumb {
		return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_enrollment")
	}
	requestHash, err := offlineV3CanonicalHash(material)
	if err != nil {
		return err
	}
	proof := offlineV3ProofClaims{Version: 3, ChallengeID: material.ChallengeID, InstallationID: material.InstallationID,
		WindowsPrincipalID: material.WindowsPrincipalID, BrowserProfileID: material.BrowserProfileID, AuthorizationID: material.AuthorizationID,
		Nonce: material.Nonce, RequestHash: requestHash}
	proof.Purpose = "installation"
	if offlineV3VerifyProof(request.InstallationSignature, offlineV3ProofEnrollment, installationKey, proof) != nil {
		return offlineV3Error(c, fiber.StatusForbidden, "offline_proof_invalid")
	}
	proof.Purpose = "native-principal"
	if offlineV3VerifyProof(request.PrincipalSignature, offlineV3ProofEnrollment, installationKey, proof) != nil {
		return offlineV3Error(c, fiber.StatusForbidden, "offline_proof_invalid")
	}
	proof.Purpose = "browser"
	if offlineV3VerifyProof(request.BrowserSignature, offlineV3ProofEnrollment, browserKey, proof) != nil {
		return offlineV3Error(c, fiber.StatusForbidden, "offline_proof_invalid")
	}
	if err := s.repos.OfflineV3.ConsumeUserChallenge(c.Context(), material.ChallengeID, userID, material.AuthorizationID, "enrollment", material.Nonce); err != nil {
		return offlineV3RepositoryError(c, err)
	}
	result, idempotent, err := s.repos.OfflineV3.RequestEnrollment(c.Context(), repository.OfflineV3EnrollmentInput{
		InstallationID: material.InstallationID, WindowsPrincipalID: material.WindowsPrincipalID, BrowserProfileID: material.BrowserProfileID,
		AuthorizationID: material.AuthorizationID, UserID: userID, DisplayName: material.DisplayName, PrincipalDisplayName: material.PrincipalDisplayName,
		BrowserName: material.BrowserName, ClientVersion: material.ClientVersion, SIDHash: material.SIDHash,
		InstallationSigningJWK: material.InstallationSigningJWK, InstallationKeyThumbprint: installationThumb,
		ServiceEncryptionJWK: material.ServiceEncryptionJWK, ServiceKeyThumbprint: serviceThumb,
		BrowserDPoPJWK: material.BrowserDPoPJWK, BrowserKeyThumbprint: browserThumb, RequestDigest: requestHash,
	})
	if err != nil {
		return offlineV3RepositoryError(c, err)
	}
	return c.Status(fiber.StatusAccepted).JSON(fiber.Map{"request": result, "idempotent": idempotent})
}

func (s *Server) offlineV3SignerKeys(ctx *fiber.Ctx) (*offlineV3SignerKeySet, error) {
	var keys offlineV3SignerKeySet
	if err := s.offlineV3SignerCall(ctx.Context(), http.MethodGet, "/v3/public-keys", nil, &keys); err != nil {
		return nil, err
	}
	if keys.KeyVersion < 3 || strings.TrimSpace(keys.KeyID) == "" || len(keys.Keys) == 0 {
		return nil, errors.New("invalid offline v3 signer key set")
	}
	return &keys, nil
}

func (s *Server) ensureOfflineV3ServiceDescriptor(c *fiber.Ctx, requestID, userID uuid.UUID) (*repository.OfflineV3ServiceDescriptor, error) {
	material, err := s.repos.OfflineV3.ServiceDescriptorMaterial(c.Context(), requestID, userID)
	if err != nil {
		return nil, err
	}
	if current, currentErr := s.repos.OfflineV3.ServiceDescriptorForUser(c.Context(), material.BrowserProfileID, userID); currentErr == nil && current.ExpiresAt.After(time.Now().Add(24*time.Hour)) {
		return current, nil
	}
	signingKey, _, err := offlineV3PublicJWK(material.ServiceSigningJWK, "sig", string(jose.ES256))
	if err != nil {
		return nil, err
	}
	encryptionKey, _, err := offlineV3PublicJWK(material.ServiceEncryptionJWK, "enc", string(jose.ECDH_ES_A256KW))
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC().Truncate(time.Second)
	expiresAt := now.Add(30 * 24 * time.Hour)
	claims := offlineV3ServiceDescriptorClaims{
		Issuer: "clarin-offline-v3", Audience: "clarin-offline-local-service", IssuedAt: now.Unix(), NotBefore: now.Add(-5 * time.Second).Unix(),
		ExpiresAt: expiresAt.Unix(), ID: uuid.NewString(), Version: 3, InstallationID: material.InstallationID.String(),
		WindowsPrincipalID: material.WindowsPrincipalID.String(), BrowserProfileID: material.BrowserProfileID.String(),
		ServerOrigin: s.cfg.OfflineV3ServerOrigin, TransportEncryptionKeyID: encryptionKey.KeyID,
		TransportEncryptionJWK: material.ServiceEncryptionJWK, ServiceSigningKeyID: signingKey.KeyID, ServiceSigningJWK: material.ServiceSigningJWK,
	}
	var signed offlineV3SignerResponse
	if err := s.offlineV3SignerCall(c.Context(), http.MethodPost, "/v3/sign-service-descriptor", claims, &signed); err != nil {
		return nil, err
	}
	material.Token, material.KeyID, material.KeyVersion, material.ExpiresAt = signed.Token, signed.KeyID, signed.KeyVersion, expiresAt
	if err := s.repos.OfflineV3.SaveServiceDescriptor(c.Context(), userID, *material); err != nil {
		return nil, err
	}
	return material, nil
}

func (s *Server) handleOfflineV3EnrollmentStatus(c *fiber.Ctx) error {
	userID, ok := c.Locals("user_id").(uuid.UUID)
	if !ok || userID == uuid.Nil {
		return offlineV3Error(c, fiber.StatusUnauthorized, "unauthorized")
	}
	requestID, err := uuid.Parse(c.Params("id"))
	if err != nil || requestID == uuid.Nil {
		return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_request")
	}
	request, _, err := s.repos.OfflineV3.EnrollmentRequestForUser(c.Context(), requestID, userID, false)
	if err != nil {
		return offlineV3RepositoryError(c, err)
	}
	response := fiber.Map{"request": request}
	if request.State == "approved" {
		descriptor, err := s.ensureOfflineV3ServiceDescriptor(c, requestID, userID)
		if err != nil {
			return offlineV3Error(c, fiber.StatusServiceUnavailable, "offline_signer_unavailable")
		}
		keys, err := s.offlineV3SignerKeys(c)
		if err != nil {
			return offlineV3Error(c, fiber.StatusServiceUnavailable, "offline_signer_unavailable")
		}
		grants, err := s.repos.OfflineV3.ListUserGrants(c.Context(), userID)
		if err != nil {
			return err
		}
		response["grants"] = grants
		response["browser_profile_id"] = descriptor.BrowserProfileID
		response["service_descriptor"] = descriptor.Token
		response["signer_public_keys"] = keys
	}
	return c.JSON(response)
}

type offlineV3ApproveRequest struct {
	Accounts []struct {
		AccountID    uuid.UUID `json:"account_id"`
		Actions      []string  `json:"actions"`
		MaxResources int       `json:"max_resources"`
		QuotaBytes   int64     `json:"quota_bytes"`
	} `json:"accounts"`
}

func (s *Server) handleAdminOfflineV3EnrollmentRequests(c *fiber.Ctx) error {
	items, err := s.repos.OfflineV3.ListEnrollmentRequests(c.Context(), 100)
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"items": items})
}

func (s *Server) handleAdminOfflineV3Approve(c *fiber.Ctx) error {
	requestID, err := uuid.Parse(c.Params("id"))
	if err != nil || requestID == uuid.Nil {
		return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_request")
	}
	var request offlineV3ApproveRequest
	if err := offlineV3ReadStrictJSON(c, &request, 32<<10); err != nil {
		return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_approval")
	}
	approvals := make([]repository.OfflineV3GrantApproval, 0, len(request.Accounts))
	for _, account := range request.Accounts {
		actions := append([]string(nil), account.Actions...)
		sort.Strings(actions)
		approvals = append(approvals, repository.OfflineV3GrantApproval{AccountID: account.AccountID, Actions: actions,
			MaxResources: account.MaxResources, QuotaBytes: account.QuotaBytes})
	}
	actorID, _ := c.Locals("user_id").(uuid.UUID)
	grants, err := s.repos.OfflineV3.ApproveEnrollment(c.Context(), requestID, actorID, approvals)
	if err != nil {
		return offlineV3RepositoryError(c, err)
	}
	return c.JSON(fiber.Map{"grants": grants})
}

func (s *Server) handleAdminOfflineV3Reject(c *fiber.Ctx) error {
	requestID, err := uuid.Parse(c.Params("id"))
	if err != nil || requestID == uuid.Nil {
		return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_request")
	}
	var request struct {
		Note string `json:"note"`
	}
	if err := offlineV3ReadStrictJSON(c, &request, 2048); err != nil || len(request.Note) > 500 {
		return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_rejection")
	}
	actorID, _ := c.Locals("user_id").(uuid.UUID)
	if err := s.repos.OfflineV3.RejectEnrollment(c.Context(), requestID, actorID, strings.TrimSpace(request.Note)); err != nil {
		return offlineV3RepositoryError(c, err)
	}
	return c.JSON(fiber.Map{"state": "rejected"})
}

func (s *Server) handleAdminOfflineV3Grants(c *fiber.Ctx) error {
	items, err := s.repos.OfflineV3.ListAdminGrants(c.Context(), 200)
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"items": items})
}

func (s *Server) applyAdminOfflineV3Control(c *fiber.Ctx, scope string, scopeID uuid.UUID, action string) error {
	if action != "lock" && action != "wipe" {
		return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_control")
	}
	plan, err := s.repos.OfflineV3.PlanAdminControl(c.Context(), scope, scopeID)
	if err != nil {
		return offlineV3RepositoryError(c, err)
	}
	if plan.CurrentState == "revoked" || (action == "lock" && plan.CurrentState == "locked") {
		return offlineV3Error(c, fiber.StatusConflict, "offline_state_conflict")
	}
	reason := "security_lock"
	if action == "wipe" {
		reason = "admin_revoked"
	}
	control, err := s.signOfflineV3Control(c, plan.InstallationID, plan.ScopeID, plan.Scope, action, reason, plan.CurrentRevision+1)
	if err != nil {
		return offlineV3Error(c, fiber.StatusServiceUnavailable, "offline_signer_unavailable")
	}
	control.GrantID, control.AccountID = plan.GrantID, plan.AccountID
	actorID, _ := c.Locals("user_id").(uuid.UUID)
	if err := s.repos.OfflineV3.ApplyAdminControl(c.Context(), *plan, control, actorID); err != nil {
		return offlineV3RepositoryError(c, err)
	}
	return c.JSON(fiber.Map{"control": control, "state": map[bool]string{true: "revoked", false: "locked"}[action == "wipe"]})
}

func (s *Server) handleAdminOfflineV3Control(c *fiber.Ctx) error {
	var request struct {
		Scope          string    `json:"scope"`
		ScopeID        uuid.UUID `json:"scope_id"`
		InstallationID uuid.UUID `json:"installation_id,omitempty"`
		Action         string    `json:"action"`
	}
	if err := offlineV3ReadStrictJSON(c, &request, 2048); err != nil || request.ScopeID == uuid.Nil {
		return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_control")
	}
	if request.Scope == "account" || request.Scope == "user" || request.Scope == "installation_account" || request.Scope == "installation_user" {
		if request.Action != "wipe" {
			return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_control")
		}
		plans, err := s.repos.OfflineV3.PlanAdminGrantControls(c.Context(), request.Scope, request.ScopeID, request.InstallationID)
		if err != nil {
			return offlineV3RepositoryError(c, err)
		}
		controls := make([]domain.OfflineV3Control, 0, len(plans))
		for _, plan := range plans {
			control, err := s.signOfflineV3Control(c, plan.InstallationID, plan.ScopeID, "grant", "wipe", "admin_revoked", plan.CurrentRevision+1)
			if err != nil {
				return offlineV3Error(c, fiber.StatusServiceUnavailable, "offline_signer_unavailable")
			}
			control.GrantID, control.AccountID = plan.GrantID, plan.AccountID
			controls = append(controls, control)
		}
		actorID, _ := c.Locals("user_id").(uuid.UUID)
		if err := s.repos.OfflineV3.ApplyAdminGrantControls(c.Context(), plans, controls, actorID); err != nil {
			return offlineV3RepositoryError(c, err)
		}
		ids := make([]uuid.UUID, 0, len(controls))
		for _, control := range controls {
			ids = append(ids, control.ID)
		}
		return c.JSON(fiber.Map{"state": "revoked", "control_ids": ids, "affected_grants": len(ids)})
	}
	return s.applyAdminOfflineV3Control(c, request.Scope, request.ScopeID, request.Action)
}

func (s *Server) handleAdminOfflineV3RevokeGrant(c *fiber.Ctx) error {
	grantID, err := uuid.Parse(c.Params("id"))
	if err != nil || grantID == uuid.Nil {
		return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_control")
	}
	return s.applyAdminOfflineV3Control(c, "grant", grantID, "wipe")
}

func offlineV3GrantReadyState(item domain.OfflineV3Grant) string {
	if item.State == "revoked" {
		return "revoked"
	}
	if item.State != "active" {
		return "error"
	}
	if !item.KeysReady {
		return "pending"
	}
	if item.LastLeaseExpiresAt == nil {
		return "preparing"
	}
	if item.LastLeaseExpiresAt != nil && item.LastLeaseExpiresAt.Before(time.Now()) {
		return "expired"
	}
	return "available"
}

func (s *Server) handleOfflineV3Grants(c *fiber.Ctx) error {
	userID, ok := c.Locals("user_id").(uuid.UUID)
	if !ok || userID == uuid.Nil {
		return offlineV3Error(c, fiber.StatusUnauthorized, "unauthorized")
	}
	items, err := s.repos.OfflineV3.ListUserGrants(c.Context(), userID)
	if err != nil {
		return err
	}
	for index := range items {
		record, err := s.repos.OfflineV3.GrantForUser(c.Context(), items[index].GrantID, userID)
		if err != nil {
			continue
		}
		effective, err := s.repos.OfflineV3.EffectiveActions(c.Context(), record)
		if err == nil {
			items[index].EffectiveActions = effective
		}
		items[index].State = offlineV3GrantReadyState(items[index])
	}
	keys, err := s.offlineV3SignerKeys(c)
	if err != nil {
		return offlineV3Error(c, fiber.StatusServiceUnavailable, "offline_signer_unavailable")
	}
	return c.JSON(fiber.Map{"grants": items, "signer_public_keys": keys})
}

func (s *Server) handleOfflineV3GrantChallenge(c *fiber.Ctx) error {
	userID, _ := c.Locals("user_id").(uuid.UUID)
	grantID, err := uuid.Parse(c.Params("grantId"))
	if err != nil || grantID == uuid.Nil {
		return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_request")
	}
	var request struct {
		Purpose string `json:"purpose"`
	}
	if err := offlineV3ReadStrictJSON(c, &request, 1024); err != nil || (request.Purpose != "grant_keys" && request.Purpose != "lease") {
		return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_request")
	}
	if _, err := s.repos.OfflineV3.GrantForUser(c.Context(), grantID, userID); err != nil {
		return offlineV3RepositoryError(c, err)
	}
	challenge, err := s.repos.OfflineV3.CreateGrantChallenge(c.Context(), grantID, request.Purpose)
	if err != nil {
		return offlineV3RepositoryError(c, err)
	}
	return c.JSON(fiber.Map{"challenge_id": challenge.ID, "nonce": challenge.Nonce, "purpose": challenge.Purpose,
		"expires_at": challenge.ExpiresAt, "server_time": time.Now().UTC()})
}

func offlineV3RecordUsable(record *repository.OfflineV3AuthRecord, keysRequired bool) bool {
	return record != nil && record.State == "active" && record.InstallationState == "active" && record.PrincipalState == "active" &&
		record.BrowserState == "active" && record.AuthorizationState == "active" && record.UserActive && record.AccountActive &&
		record.MembershipActive && record.CredentialEpoch == record.LastAuthenticatedCredentialEpoch &&
		record.AuthorityEpoch == record.LastAuthenticatedAuthorityEpoch && (!keysRequired || record.KeysReady)
}

func (s *Server) offlineV3EffectiveActions(c *fiber.Ctx, record *repository.OfflineV3AuthRecord) ([]string, error) {
	actions, err := s.repos.OfflineV3.EffectiveActions(c.Context(), record)
	if err != nil {
		return nil, err
	}
	filtered := actions[:0]
	for _, action := range actions {
		if !s.cfg.OfflineV3TaskWrites && (action == domain.OfflineV3ActionTasksCreate || action == domain.OfflineV3ActionTasksComplete) {
			continue
		}
		filtered = append(filtered, action)
	}
	if len(filtered) == 0 {
		return nil, repository.ErrOfflineV3AccessDenied
	}
	return filtered, nil
}

func offlineV3AuthorityClaims(record *repository.OfflineV3AuthRecord, actions []string, audience string, lifetime time.Duration) offlineV3LeaseClaims {
	now := time.Now().UTC().Truncate(time.Second)
	loginDigest := sha256.Sum256([]byte(record.CanonicalLogin))
	return offlineV3LeaseClaims{
		Issuer: "clarin-offline-v3", Audience: audience, IssuedAt: now.Unix(), NotBefore: now.Add(-5 * time.Second).Unix(),
		ExpiresAt: now.Add(lifetime).Unix(), ID: uuid.NewString(), Version: 3, InstallationID: record.InstallationID.String(),
		WindowsPrincipalID: record.WindowsPrincipalID.String(), BrowserProfileID: record.BrowserProfileID.String(),
		AuthorizationID: record.AuthorizationID.String(), GrantID: record.GrantID.String(), UserID: record.UserID.String(), AccountID: record.AccountID.String(),
		LoginBindingSHA256: hex.EncodeToString(loginDigest[:]),
		CredentialEpoch:    record.CredentialEpoch, AuthorityEpoch: record.AuthorityEpoch, InstallationRevision: record.InstallationRevision,
		PrincipalRevision: record.PrincipalRevision, BrowserRevision: record.BrowserRevision, AuthorizationRevision: record.AuthorizationRevision,
		GrantRevision: record.GrantRevision, SelectionRevision: record.SelectionRevision, SelectionDigest: record.SelectionDigest,
		Actions: actions, MaxStorageBytes: record.QuotaBytes, BrowserKeyThumbprint: record.BrowserKeyThumbprint,
		GrantSigningKeyThumbprint: record.GrantSigningThumbprint, GrantEncryptionKeyThumbprint: record.GrantEncryptionThumbprint,
	}
}

func (s *Server) handleOfflineV3GrantBootstrap(c *fiber.Ctx) error {
	userID, _ := c.Locals("user_id").(uuid.UUID)
	grantID, err := uuid.Parse(c.Params("grantId"))
	if err != nil || grantID == uuid.Nil {
		return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_request")
	}
	var request struct {
		Login    string `json:"login"`
		Password string `json:"password"`
	}
	if err := offlineV3ReadStrictJSON(c, &request, 4096); err != nil {
		return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_reauthentication")
	}
	request.Login = strings.TrimSpace(request.Login)
	if len(request.Login) < 1 || len(request.Login) > 255 || len(request.Password) < 1 || len(request.Password) > 1024 {
		return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_reauthentication")
	}
	record, err := s.repos.OfflineV3.GrantForUser(c.Context(), grantID, userID)
	if err != nil || !offlineV3RecordUsable(record, false) {
		if err == nil {
			err = repository.ErrOfflineV3AccessDenied
		}
		return offlineV3RepositoryError(c, err)
	}
	if record.CanonicalLogin == "" || request.Login != record.CanonicalLogin {
		return offlineV3Error(c, fiber.StatusForbidden, "offline_reauthentication_failed")
	}
	if s.services == nil || s.services.Auth == nil {
		return offlineV3Error(c, fiber.StatusServiceUnavailable, "offline_reauthentication_unavailable")
	}
	if err := s.services.Auth.VerifyCurrentPassword(c.Context(), userID, request.Password); err != nil {
		switch {
		case errors.Is(err, service.ErrCurrentPasswordThrottled):
			return offlineV3Error(c, fiber.StatusTooManyRequests, "offline_reauthentication_throttled")
		case errors.Is(err, service.ErrInvalidCurrentPassword):
			return offlineV3Error(c, fiber.StatusForbidden, "offline_reauthentication_failed")
		default:
			return offlineV3Error(c, fiber.StatusServiceUnavailable, "offline_reauthentication_unavailable")
		}
	}
	if err := s.repos.OfflineV3.MarkGrantAuthenticated(c.Context(), grantID, userID, false); err != nil {
		return offlineV3RepositoryError(c, err)
	}
	actions, err := s.offlineV3EffectiveActions(c, record)
	if err != nil {
		return offlineV3RepositoryError(c, err)
	}
	claims := offlineV3AuthorityClaims(record, actions, "clarin-offline-local-service", 10*time.Minute)
	claims.GrantSigningKeyThumbprint, claims.GrantEncryptionKeyThumbprint = "", ""
	var signed offlineV3SignerResponse
	if err := s.offlineV3SignerCall(c.Context(), http.MethodPost, "/v3/sign-grant-bootstrap", claims, &signed); err != nil {
		return offlineV3Error(c, fiber.StatusServiceUnavailable, "offline_signer_unavailable")
	}
	return c.JSON(fiber.Map{"grant_bootstrap": signed.Token, "expires_at": time.Unix(claims.ExpiresAt, 0), "grant": record.OfflineV3Grant})
}

func (s *Server) offlineV3VerifyGrantProofs(request offlineV3GrantProofRequest, record *repository.OfflineV3AuthRecord, typ string,
	grantKey *jose.JSONWebKey) (string, error) {
	material := offlineV3GrantProofMaterial{ChallengeID: request.ChallengeID, Nonce: request.Nonce, Counter: request.Counter,
		GrantID: record.GrantID, SigningJWK: request.SigningJWK, EncryptionJWK: request.EncryptionJWK}
	requestHash, err := offlineV3CanonicalHash(material)
	if err != nil {
		return "", err
	}
	installationKey, _, err := offlineV3PublicJWK(record.InstallationSigningJWK, "sig", string(jose.ES256))
	if err != nil {
		return "", err
	}
	browserKey, _, err := offlineV3PublicJWK(record.BrowserDPoPJWK, "sig", string(jose.ES256))
	if err != nil {
		return "", err
	}
	base := offlineV3ProofClaims{Version: 3, ChallengeID: request.ChallengeID, InstallationID: record.InstallationID,
		WindowsPrincipalID: record.WindowsPrincipalID, BrowserProfileID: record.BrowserProfileID, GrantID: record.GrantID,
		Nonce: request.Nonce, Counter: request.Counter, RequestHash: requestHash}
	base.Purpose = "installation"
	if err := offlineV3VerifyProof(request.InstallationSignature, typ, installationKey, base); err != nil {
		return "", err
	}
	base.Purpose = "browser"
	if err := offlineV3VerifyProof(request.BrowserSignature, typ, browserKey, base); err != nil {
		return "", err
	}
	base.Purpose = "grant"
	if err := offlineV3VerifyProof(request.GrantSignature, typ, grantKey, base); err != nil {
		return "", err
	}
	return requestHash, nil
}

func (s *Server) issueOfflineV3Lease(c *fiber.Ctx, grantID, userID uuid.UUID) (string, time.Time, *repository.OfflineV3AuthRecord, error) {
	if err := s.repos.OfflineV3.MarkLeaseAuthenticated(c.Context(), grantID, userID); err != nil {
		return "", time.Time{}, nil, err
	}
	record, err := s.repos.OfflineV3.GrantForUser(c.Context(), grantID, userID)
	if err != nil || !offlineV3RecordUsable(record, true) {
		if err == nil {
			err = repository.ErrOfflineV3AccessDenied
		}
		return "", time.Time{}, nil, err
	}
	actions, err := s.offlineV3EffectiveActions(c, record)
	if err != nil {
		return "", time.Time{}, nil, err
	}
	record.EffectiveActions = actions
	lifetime := time.Duration(record.MaxOfflineSeconds) * time.Second
	if lifetime > domain.OfflineV3MaxLeaseSeconds*time.Second {
		lifetime = domain.OfflineV3MaxLeaseSeconds * time.Second
	}
	claims := offlineV3AuthorityClaims(record, actions, "clarin-offline-unlock", lifetime)
	var signed offlineV3SignerResponse
	if err := s.offlineV3SignerCall(c.Context(), http.MethodPost, "/v3/sign-lease", claims, &signed); err != nil {
		return "", time.Time{}, nil, err
	}
	issuedAt, expiresAt := time.Unix(claims.IssuedAt, 0).UTC(), time.Unix(claims.ExpiresAt, 0).UTC()
	if err := s.repos.OfflineV3.ConfirmLeaseIssued(c.Context(), record, actions[0], issuedAt, expiresAt); err != nil {
		return "", time.Time{}, nil, err
	}
	return signed.Token, expiresAt, record, nil
}

type offlineV3ActivationSelection struct {
	SelectionID  uuid.UUID `json:"selection_id"`
	Module       string    `json:"module"`
	ResourceType string    `json:"resource_type"`
	ResourceID   uuid.UUID `json:"resource_id"`
	Label        string    `json:"label"`
	Readiness    string    `json:"readiness"`
	HeadVersion  int64     `json:"head_version"`
	ContentHash  string    `json:"content_hash"`
	ItemCount    int       `json:"item_count"`
	ByteSize     int64     `json:"byte_size"`
}

func offlineV3ActivationSelectionItems(items []domain.OfflineV3Selection) []offlineV3ActivationSelection {
	out := make([]offlineV3ActivationSelection, 0, len(items))
	for _, item := range items {
		out = append(out, offlineV3ActivationSelection{SelectionID: item.ID, Module: item.Module, ResourceType: item.ResourceType,
			ResourceID: item.ResourceID, Label: item.Label, Readiness: "preparing", HeadVersion: item.HeadVersion,
			ContentHash: item.ContentHash})
	}
	return out
}

func (s *Server) handleOfflineV3RegisterGrantKeys(c *fiber.Ctx) error {
	userID, _ := c.Locals("user_id").(uuid.UUID)
	grantID, err := uuid.Parse(c.Params("grantId"))
	if err != nil || grantID == uuid.Nil {
		return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_request")
	}
	var request offlineV3GrantProofRequest
	if err := offlineV3ReadStrictJSON(c, &request, 64<<10); err != nil || request.ChallengeID == uuid.Nil || request.Counter < 1 || len(request.Nonce) != 43 {
		return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_grant_keys")
	}
	record, err := s.repos.OfflineV3.GrantForUser(c.Context(), grantID, userID)
	if err != nil || !offlineV3RecordUsable(record, false) {
		if err == nil {
			err = repository.ErrOfflineV3AccessDenied
		}
		return offlineV3RepositoryError(c, err)
	}
	signingKey, signingThumb, err := offlineV3PublicJWK(request.SigningJWK, "sig", string(jose.ES256))
	if err != nil {
		return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_grant_keys")
	}
	_, encryptionThumb, err := offlineV3PublicJWK(request.EncryptionJWK, "enc", string(jose.ECDH_ES_A256KW))
	if err != nil || signingThumb == encryptionThumb || signingThumb == record.BrowserKeyThumbprint || encryptionThumb == record.BrowserKeyThumbprint {
		return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_grant_keys")
	}
	if _, err := s.offlineV3VerifyGrantProofs(request, record, offlineV3ProofGrantKeys, signingKey); err != nil {
		return offlineV3Error(c, fiber.StatusForbidden, "offline_proof_invalid")
	}
	if err := s.repos.OfflineV3.ConsumeGrantChallengeAndCounter(c.Context(), request.ChallengeID, grantID, "grant_keys", request.Nonce, request.Counter); err != nil {
		return offlineV3RepositoryError(c, err)
	}
	transportCapability, err := s.repos.OfflineV3.RegisterGrantKeys(c.Context(), grantID, userID, request.SigningJWK, signingThumb, request.EncryptionJWK, encryptionThumb)
	if err != nil {
		return offlineV3RepositoryError(c, err)
	}
	lease, leaseExpiresAt, record, err := s.issueOfflineV3Lease(c, grantID, userID)
	if err != nil {
		return offlineV3RepositoryError(c, err)
	}
	requestID, err := s.repos.OfflineV3.EnrollmentRequestIDForGrant(c.Context(), grantID, userID)
	if err != nil {
		return offlineV3RepositoryError(c, err)
	}
	descriptor, err := s.ensureOfflineV3ServiceDescriptor(c, requestID, userID)
	if err != nil {
		return offlineV3Error(c, fiber.StatusServiceUnavailable, "offline_signer_unavailable")
	}
	keys, err := s.offlineV3SignerKeys(c)
	if err != nil {
		return offlineV3Error(c, fiber.StatusServiceUnavailable, "offline_signer_unavailable")
	}
	selections, revision, digest, err := s.repos.OfflineV3.ListSelections(c.Context(), grantID, userID)
	if err != nil {
		return offlineV3RepositoryError(c, err)
	}
	if revision != record.SelectionRevision || digest != record.SelectionDigest {
		return offlineV3RepositoryError(c, repository.ErrOfflineV3Conflict)
	}
	return c.JSON(fiber.Map{"lease": lease, "lease_expires_at": leaseExpiresAt, "service_descriptor": descriptor.Token,
		"signer_public_keys": keys, "transport_capability": transportCapability, "selections": offlineV3ActivationSelectionItems(selections),
		"selection_revision": revision, "selection_digest": digest,
		"server_time": time.Now().UTC(), "grant": record.OfflineV3Grant})
}

func (s *Server) handleOfflineV3Lease(c *fiber.Ctx) error {
	userID, _ := c.Locals("user_id").(uuid.UUID)
	grantID, err := uuid.Parse(c.Params("grantId"))
	if err != nil || grantID == uuid.Nil {
		return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_request")
	}
	var request offlineV3GrantProofRequest
	if err := offlineV3ReadStrictJSON(c, &request, 32<<10); err != nil || request.ChallengeID == uuid.Nil || request.Counter < 1 ||
		len(request.Nonce) != 43 || len(request.SigningJWK) != 0 || len(request.EncryptionJWK) != 0 {
		return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_lease")
	}
	record, err := s.repos.OfflineV3.GrantForUser(c.Context(), grantID, userID)
	if err != nil || !offlineV3RecordUsable(record, true) {
		if err == nil {
			err = repository.ErrOfflineV3AccessDenied
		}
		return offlineV3RepositoryError(c, err)
	}
	grantKey, _, err := offlineV3PublicJWK(record.GrantSigningJWK, "sig", string(jose.ES256))
	if err != nil {
		return offlineV3Error(c, fiber.StatusForbidden, "offline_proof_invalid")
	}
	if _, err := s.offlineV3VerifyGrantProofs(request, record, offlineV3ProofLease, grantKey); err != nil {
		return offlineV3Error(c, fiber.StatusForbidden, "offline_proof_invalid")
	}
	if err := s.repos.OfflineV3.ConsumeGrantChallengeAndCounter(c.Context(), request.ChallengeID, grantID, "lease", request.Nonce, request.Counter); err != nil {
		return offlineV3RepositoryError(c, err)
	}
	lease, expiresAt, record, err := s.issueOfflineV3Lease(c, grantID, userID)
	if err != nil {
		if errors.Is(err, repository.ErrOfflineV3AccessDenied) {
			return offlineV3RepositoryError(c, err)
		}
		return offlineV3Error(c, fiber.StatusServiceUnavailable, "offline_signer_unavailable")
	}
	requestID, err := s.repos.OfflineV3.EnrollmentRequestIDForGrant(c.Context(), grantID, userID)
	if err != nil {
		return offlineV3RepositoryError(c, err)
	}
	descriptor, err := s.ensureOfflineV3ServiceDescriptor(c, requestID, userID)
	if err != nil {
		return offlineV3Error(c, fiber.StatusServiceUnavailable, "offline_signer_unavailable")
	}
	keys, err := s.offlineV3SignerKeys(c)
	if err != nil {
		return offlineV3Error(c, fiber.StatusServiceUnavailable, "offline_signer_unavailable")
	}
	selections, revision, digest, err := s.repos.OfflineV3.ListSelections(c.Context(), grantID, userID)
	if err != nil {
		return offlineV3RepositoryError(c, err)
	}
	if revision != record.SelectionRevision || digest != record.SelectionDigest {
		return offlineV3RepositoryError(c, repository.ErrOfflineV3Conflict)
	}
	return c.JSON(fiber.Map{"lease": lease, "expires_at": expiresAt, "lease_expires_at": expiresAt,
		"service_descriptor": descriptor.Token, "signer_public_keys": keys, "selections": offlineV3ActivationSelectionItems(selections),
		"selection_revision": revision, "selection_digest": digest, "server_time": time.Now().UTC(), "grant": record.OfflineV3Grant})
}

func (s *Server) handleOfflineV3ResourceCandidates(c *fiber.Ctx) error {
	userID, _ := c.Locals("user_id").(uuid.UUID)
	grantID, err := uuid.Parse(c.Params("grantId"))
	if err != nil || grantID == uuid.Nil {
		return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_request")
	}
	limit := 50
	if raw := c.Query("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil {
			return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_request")
		}
		limit = parsed
	}
	after := uuid.Nil
	if raw := c.Query("after"); raw != "" {
		if parsed, err := uuid.Parse(raw); err == nil {
			after = parsed
		} else {
			return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_request")
		}
	}
	items, next, err := s.repos.OfflineV3.ListResourceCandidates(c.Context(), grantID, userID, c.Query("module"), c.Query("q"), after, limit)
	if err != nil {
		return offlineV3RepositoryError(c, err)
	}
	response := fiber.Map{"items": items}
	if next != nil {
		response["next_cursor"] = next.String()
	}
	return c.JSON(response)
}

func (s *Server) handleOfflineV3Selections(c *fiber.Ctx) error {
	userID, _ := c.Locals("user_id").(uuid.UUID)
	grantID, err := uuid.Parse(c.Params("grantId"))
	if err != nil || grantID == uuid.Nil {
		return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_request")
	}
	items, revision, digest, err := s.repos.OfflineV3.ListSelections(c.Context(), grantID, userID)
	if err != nil {
		return offlineV3RepositoryError(c, err)
	}
	return c.JSON(fiber.Map{"items": items, "selection_revision": revision, "selection_digest": digest})
}

type offlineV3ControlClaims struct {
	Issuer         string `json:"iss"`
	Audience       string `json:"aud"`
	IssuedAt       int64  `json:"iat"`
	NotBefore      int64  `json:"nbf"`
	ExpiresAt      int64  `json:"exp"`
	ID             string `json:"jti"`
	Version        int    `json:"version"`
	InstallationID string `json:"installation_id"`
	Scope          string `json:"scope"`
	ScopeID        string `json:"scope_id"`
	Revision       int64  `json:"revision"`
	Action         string `json:"action"`
	Reason         string `json:"reason"`
}

func offlineV3ControlClaimsAt(id, installationID, scopeID uuid.UUID, scope, action, reason string, revision int64, now time.Time) offlineV3ControlClaims {
	now = now.UTC().Truncate(time.Second)
	return offlineV3ControlClaims{Issuer: "clarin-offline-v3", Audience: "clarin-offline-control", IssuedAt: now.Unix(),
		NotBefore: now.Add(-5 * time.Second).Unix(), ExpiresAt: now.Add(72 * time.Hour).Unix(), ID: id.String(), Version: 3,
		InstallationID: installationID.String(), Scope: scope, ScopeID: scopeID.String(), Revision: revision, Action: action, Reason: reason}
}

func (s *Server) signOfflineV3ControlWithID(c *fiber.Ctx, id, installationID, scopeID uuid.UUID, scope, action, reason string, revision int64) (domain.OfflineV3Control, error) {
	if id == uuid.Nil {
		return domain.OfflineV3Control{}, repository.ErrOfflineV3Invalid
	}
	now := time.Now().UTC().Truncate(time.Second)
	claims := offlineV3ControlClaimsAt(id, installationID, scopeID, scope, action, reason, revision, now)
	var signed offlineV3SignerResponse
	if err := s.offlineV3SignerCall(c.Context(), http.MethodPost, "/v3/sign-control", claims, &signed); err != nil {
		return domain.OfflineV3Control{}, err
	}
	return domain.OfflineV3Control{ID: id, InstallationID: installationID, Scope: scope, ScopeID: scopeID, Revision: revision,
		Action: action, Reason: reason, Token: signed.Token, KeyID: signed.KeyID, KeyVersion: signed.KeyVersion, CreatedAt: now}, nil
}

func (s *Server) signOfflineV3Control(c *fiber.Ctx, installationID, scopeID uuid.UUID, scope, action, reason string, revision int64) (domain.OfflineV3Control, error) {
	return s.signOfflineV3ControlWithID(c, uuid.New(), installationID, scopeID, scope, action, reason, revision)
}

// Pending controls are durable, but their JWS expiry is intentionally short.
// Re-sign the immutable ID/scope/revision/action at delivery time so a machine
// returning after months offline can still verify and acknowledge its wipe.
func (s *Server) refreshOfflineV3ControlToken(c *fiber.Ctx, control domain.OfflineV3Control) (domain.OfflineV3Control, error) {
	refreshed, err := s.signOfflineV3ControlWithID(c, control.ID, control.InstallationID, control.ScopeID,
		control.Scope, control.Action, control.Reason, control.Revision)
	if err != nil {
		return domain.OfflineV3Control{}, err
	}
	refreshed.GrantID, refreshed.AccountID, refreshed.AcknowledgedAt = control.GrantID, control.AccountID, control.AcknowledgedAt
	return refreshed, nil
}

func (s *Server) ensureOfflineV3InvalidGrantControl(c *fiber.Ctx, record *repository.OfflineV3AuthRecord) (domain.OfflineV3Control, error) {
	if record == nil || record.GrantID == uuid.Nil || record.AccountID == uuid.Nil || record.InstallationID == uuid.Nil {
		return domain.OfflineV3Control{}, repository.ErrOfflineV3Invalid
	}
	action, reason := "wipe", "security_lock"
	switch {
	case !record.UserActive:
		reason = "user_disabled"
	case !record.AccountActive:
		reason = "account_disabled"
	case record.CredentialEpoch != record.LastAuthenticatedCredentialEpoch:
		reason = "credential_changed"
	case record.AuthorityEpoch != record.LastAuthenticatedAuthorityEpoch || !record.MembershipActive:
		reason = "authority_changed"
	case record.State == "locked" || record.InstallationState == "locked" || record.PrincipalState == "locked" ||
		record.BrowserState == "locked" || record.AuthorizationState == "locked":
		action = "lock"
	case record.State == "revoked" || record.InstallationState == "revoked" || record.PrincipalState == "revoked" ||
		record.BrowserState == "revoked" || record.AuthorizationState == "revoked":
		reason = "admin_revoked"
	}
	return s.ensureOfflineV3GrantControl(c, record, action, reason)
}

func (s *Server) ensureOfflineV3GrantControl(c *fiber.Ctx, record *repository.OfflineV3AuthRecord, action, reason string) (domain.OfflineV3Control, error) {
	if record == nil || record.GrantID == uuid.Nil || record.AccountID == uuid.Nil || record.InstallationID == uuid.Nil {
		return domain.OfflineV3Control{}, repository.ErrOfflineV3Invalid
	}
	control, err := s.signOfflineV3Control(c, record.InstallationID, record.GrantID, "grant", action, reason, record.GrantRevision)
	if err != nil {
		return domain.OfflineV3Control{}, err
	}
	grantID, accountID := record.GrantID, record.AccountID
	control.GrantID, control.AccountID = &grantID, &accountID
	return s.repos.OfflineV3.StoreControl(c.Context(), control, nil)
}

func (s *Server) handleOfflineV3ReplaceSelections(c *fiber.Ctx) error {
	userID, _ := c.Locals("user_id").(uuid.UUID)
	grantID, err := uuid.Parse(c.Params("grantId"))
	if err != nil || grantID == uuid.Nil {
		return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_request")
	}
	var request struct {
		SelectionRevision int64                       `json:"selection_revision"`
		Items             []domain.OfflineV3Selection `json:"items"`
	}
	if err := offlineV3ReadStrictJSON(c, &request, 64<<10); err != nil {
		return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_selection")
	}
	plan, err := s.repos.OfflineV3.PlanSelectionReplacement(c.Context(), grantID, userID, request.SelectionRevision, request.Items)
	if err != nil {
		return offlineV3RepositoryError(c, err)
	}
	controls := make([]domain.OfflineV3Control, 0, len(plan.RemovedSelectionIDs))
	for _, selectionID := range plan.RemovedSelectionIDs {
		control, err := s.signOfflineV3Control(c, plan.InstallationID, selectionID, "selection", "wipe", "selection_removed", plan.CurrentRevision+1)
		if err != nil {
			return offlineV3Error(c, fiber.StatusServiceUnavailable, "offline_signer_unavailable")
		}
		grantCopy, accountCopy := grantID, plan.AccountID
		control.GrantID, control.AccountID = &grantCopy, &accountCopy
		controls = append(controls, control)
	}
	revision, digest, err := s.repos.OfflineV3.ReplaceSelections(c.Context(), grantID, userID, request.SelectionRevision, request.Items, controls)
	if err != nil {
		return offlineV3RepositoryError(c, err)
	}
	items, _, _, err := s.repos.OfflineV3.ListSelections(c.Context(), grantID, userID)
	if err != nil {
		return offlineV3RepositoryError(c, err)
	}
	return c.JSON(fiber.Map{"items": items, "selection_revision": revision, "selection_digest": digest})
}

type offlineV3SyncInventory struct {
	SelectionID uuid.UUID `json:"selection_id"`
	HeadVersion int64     `json:"head_version"`
	ContentHash string    `json:"content_hash"`
}

func offlineV3SyncInventoryIndex(items []offlineV3SyncInventory, selections []domain.OfflineV3Selection) (map[uuid.UUID]offlineV3SyncInventory, error) {
	if len(items) != len(selections) || len(items) > domain.OfflineV3MaxResources {
		return nil, repository.ErrOfflineV3Conflict
	}
	selected := make(map[uuid.UUID]struct{}, len(selections))
	for _, item := range selections {
		if item.ID == uuid.Nil {
			return nil, repository.ErrOfflineV3Invalid
		}
		selected[item.ID] = struct{}{}
	}
	indexed := make(map[uuid.UUID]offlineV3SyncInventory, len(items))
	for _, item := range items {
		if item.SelectionID == uuid.Nil || item.HeadVersion < 1 {
			return nil, repository.ErrOfflineV3Invalid
		}
		if item.ContentHash != "" {
			decoded, err := hex.DecodeString(item.ContentHash)
			if err != nil || len(decoded) != sha256.Size || item.ContentHash != strings.ToLower(item.ContentHash) {
				return nil, repository.ErrOfflineV3Invalid
			}
		}
		if _, duplicate := indexed[item.SelectionID]; duplicate {
			return nil, repository.ErrOfflineV3Invalid
		}
		if _, exists := selected[item.SelectionID]; !exists {
			return nil, repository.ErrOfflineV3Conflict
		}
		indexed[item.SelectionID] = item
	}
	return indexed, nil
}

func offlineV3CanonicalInventory(selections []domain.OfflineV3Selection, snapshots []domain.OfflineV3Snapshot) []offlineV3SyncInventory {
	byID := make(map[uuid.UUID]offlineV3SyncInventory, len(selections))
	for _, item := range selections {
		byID[item.ID] = offlineV3SyncInventory{SelectionID: item.ID, HeadVersion: item.HeadVersion, ContentHash: item.ContentHash}
	}
	for _, item := range snapshots {
		byID[item.SelectionID] = offlineV3SyncInventory{SelectionID: item.SelectionID, HeadVersion: item.HeadVersion, ContentHash: item.ContentHash}
	}
	out := make([]offlineV3SyncInventory, 0, len(byID))
	for _, item := range byID {
		out = append(out, item)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].SelectionID.String() < out[j].SelectionID.String() })
	return out
}

func offlineV3ValidateWantedSelections(ids []uuid.UUID, inventory map[uuid.UUID]offlineV3SyncInventory) error {
	seen := make(map[uuid.UUID]struct{}, len(ids))
	for _, id := range ids {
		if id == uuid.Nil {
			return repository.ErrOfflineV3Invalid
		}
		if _, duplicate := seen[id]; duplicate {
			return repository.ErrOfflineV3Invalid
		}
		seen[id] = struct{}{}
		if _, selected := inventory[id]; !selected {
			return repository.ErrOfflineV3Conflict
		}
	}
	return nil
}

type offlineV3SyncRequest struct {
	GrantID                 uuid.UUID                `json:"grant_id"`
	ChallengeID             uuid.UUID                `json:"challenge_id"`
	Nonce                   string                   `json:"nonce"`
	Counter                 int64                    `json:"counter"`
	InstallationID          uuid.UUID                `json:"installation_id"`
	WindowsPrincipalID      uuid.UUID                `json:"windows_principal_id"`
	BrowserProfileID        uuid.UUID                `json:"browser_profile_id"`
	TransportEnvelopes      []string                 `json:"transport_envelopes"`
	Inventory               []offlineV3SyncInventory `json:"inventory"`
	WantSnapshots           []uuid.UUID              `json:"want_snapshots"`
	ControlAcknowledgements []uuid.UUID              `json:"control_acknowledgements,omitempty"`
	UsedStorageBytes        int64                    `json:"used_storage_bytes"`
}

type offlineV3SealedEntry struct {
	EnvelopeID  string `json:"envelope_id"`
	Kind        string `json:"kind"`
	CompactJWE  string `json:"compact_jwe"`
	ContentHash string `json:"content_hash"`
}

type offlineV3DataTuple struct {
	InstallationID     string `json:"installation_id"`
	WindowsPrincipalID string `json:"windows_principal_id"`
	BrowserProfileID   string `json:"browser_profile_id"`
	AuthorizationID    string `json:"authorization_id"`
	GrantID            string `json:"grant_id"`
	UserID             string `json:"user_id"`
	AccountID          string `json:"account_id"`
}

type offlineV3SignedSnapshot struct {
	Issuer            string             `json:"iss"`
	Audience          string             `json:"aud"`
	IssuedAt          int64              `json:"iat"`
	ID                string             `json:"jti"`
	Version           int                `json:"version"`
	Kind              string             `json:"kind"`
	Tuple             offlineV3DataTuple `json:"tuple"`
	SelectionID       string             `json:"selection_id"`
	Module            string             `json:"module"`
	ResourceType      string             `json:"resource_type"`
	ResourceID        string             `json:"resource_id"`
	SelectionRevision int64              `json:"selection_revision"`
	HeadVersion       int64              `json:"head_version"`
	ContentHash       string             `json:"content_hash"`
	Payload           json.RawMessage    `json:"payload"`
	Tombstone         bool               `json:"tombstone,omitempty"`
}

type offlineV3SignedReceipt struct {
	Issuer        string             `json:"iss"`
	Audience      string             `json:"aud"`
	IssuedAt      int64              `json:"iat"`
	ID            string             `json:"jti"`
	Version       int                `json:"version"`
	Kind          string             `json:"kind"`
	Tuple         offlineV3DataTuple `json:"tuple"`
	OperationID   string             `json:"operation_id"`
	RequestHash   string             `json:"request_hash"`
	Status        string             `json:"status"`
	ErrorCode     string             `json:"error_code,omitempty"`
	ResourceID    string             `json:"resource_id,omitempty"`
	ServerVersion int64              `json:"server_version,omitempty"`
	Result        json.RawMessage    `json:"result,omitempty"`
}

func offlineV3TupleForData(record *repository.OfflineV3AuthRecord) offlineV3DataTuple {
	return offlineV3DataTuple{InstallationID: record.InstallationID.String(), WindowsPrincipalID: record.WindowsPrincipalID.String(),
		BrowserProfileID: record.BrowserProfileID.String(), AuthorizationID: record.AuthorizationID.String(), GrantID: record.GrantID.String(),
		UserID: record.UserID.String(), AccountID: record.AccountID.String()}
}

func (s *Server) handleOfflineV3SyncChallenge(c *fiber.Ctx) error {
	var request struct {
		GrantID        uuid.UUID `json:"grant_id"`
		InstallationID uuid.UUID `json:"installation_id"`
	}
	if err := offlineV3ReadStrictJSON(c, &request, 2048); err != nil || request.GrantID == uuid.Nil || request.InstallationID == uuid.Nil {
		return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_sync")
	}
	record, err := s.repos.OfflineV3.AuthenticateTransport(c.Context(), request.GrantID, offlineV3TransportCapability(c))
	if err != nil || record.InstallationID != request.InstallationID {
		return offlineV3Error(c, fiber.StatusForbidden, "offline_transport_denied")
	}
	challenge, err := s.repos.OfflineV3.CreateGrantChallenge(c.Context(), request.GrantID, "sync")
	if err != nil {
		return offlineV3RepositoryError(c, err)
	}
	return c.JSON(fiber.Map{"challenge_id": challenge.ID, "nonce": challenge.Nonce, "expires_at": challenge.ExpiresAt,
		"server_time": time.Now().UTC()})
}

func offlineV3TransportCapability(c *fiber.Ctx) string {
	header := strings.TrimSpace(c.Get("Authorization"))
	const prefix = "OfflineTransport "
	if !strings.HasPrefix(header, prefix) || strings.Contains(strings.TrimSpace(header[len(prefix):]), " ") {
		return ""
	}
	return strings.TrimSpace(header[len(prefix):])
}

func offlineV3VerifyOperationJWS(compact string, record *repository.OfflineV3AuthRecord) (domain.OfflineV3Operation, error) {
	var operation domain.OfflineV3Operation
	if len(compact) < 64 || len(compact) > offlineV3MaxJSONBody || strings.Count(compact, ".") != 2 || strings.TrimSpace(compact) != compact {
		return operation, repository.ErrOfflineV3Invalid
	}
	key, _, err := offlineV3PublicJWK(record.GrantSigningJWK, "sig", string(jose.ES256))
	if err != nil {
		return operation, repository.ErrOfflineV3Invalid
	}
	object, err := jose.ParseSignedCompact(compact, []jose.SignatureAlgorithm{jose.ES256})
	if err != nil || len(object.Signatures) != 1 {
		return operation, repository.ErrOfflineV3Invalid
	}
	header := object.Signatures[0].Header
	headerType := fmt.Sprint(header.ExtraHeaders[jose.HeaderType])
	if header.Algorithm != string(jose.ES256) || header.KeyID != key.KeyID || headerType != offlineV3OperationJWS || header.JSONWebKey != nil {
		return operation, repository.ErrOfflineV3Invalid
	}
	payload, err := object.Verify(key)
	if err != nil || len(payload) > 64<<10 || offlineV3ValidateJSON(payload) != nil {
		return operation, repository.ErrOfflineV3Invalid
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&operation); err != nil {
		return operation, repository.ErrOfflineV3Invalid
	}
	return operation, nil
}

func (s *Server) offlineV3SignAndSealReceipt(c *fiber.Ctx, record *repository.OfflineV3AuthRecord, result domain.OfflineV3OperationResult, requestHash string) (offlineV3SealedEntry, error) {
	now := time.Now().UTC().Truncate(time.Second)
	claims := offlineV3SignedReceipt{Issuer: "clarin-offline-v3", Audience: "clarin-offline-receipt", IssuedAt: now.Unix(),
		ID: uuid.NewString(), Version: 3, Kind: "receipt", Tuple: offlineV3TupleForData(record), OperationID: result.OperationID.String(),
		RequestHash: requestHash, Status: result.Status, ErrorCode: result.ErrorCode, ServerVersion: result.ServerVersion, Result: result.Result}
	if result.ResourceID != uuid.Nil {
		claims.ResourceID = result.ResourceID.String()
	}
	var signed offlineV3SignerResponse
	if err := s.offlineV3SignerCall(c.Context(), http.MethodPost, "/v3/sign-receipt", claims, &signed); err != nil {
		return offlineV3SealedEntry{}, err
	}
	compact, err := offlineV3SealBytes(record.GrantEncryptionJWK, []byte(signed.Token), offlineV3ReceiptJWE, "clarin-offline-receipt+jws")
	if err != nil {
		return offlineV3SealedEntry{}, err
	}
	return offlineV3SealedEntry{EnvelopeID: result.OperationID.String(), Kind: "receipt", CompactJWE: compact, ContentHash: requestHash}, nil
}

func (s *Server) offlineV3SignAndSealSnapshot(c *fiber.Ctx, record *repository.OfflineV3AuthRecord, snapshot domain.OfflineV3Snapshot) (offlineV3SealedEntry, error) {
	normalized, err := json.Marshal(snapshot.Payload)
	if err != nil {
		return offlineV3SealedEntry{}, err
	}
	digest := sha256.Sum256(normalized)
	contentHash := hex.EncodeToString(digest[:])
	if contentHash != snapshot.ContentHash {
		return offlineV3SealedEntry{}, repository.ErrOfflineV3Conflict
	}
	claims := offlineV3SignedSnapshot{Issuer: "clarin-offline-v3", Audience: "clarin-offline-snapshot", IssuedAt: time.Now().UTC().Unix(),
		ID: uuid.NewString(), Version: 3, Kind: "snapshot", Tuple: offlineV3TupleForData(record), SelectionID: snapshot.SelectionID.String(),
		Module: snapshot.Module, ResourceType: snapshot.ResourceType, ResourceID: snapshot.ResourceID.String(),
		SelectionRevision: snapshot.SelectionRevision, HeadVersion: snapshot.HeadVersion, ContentHash: contentHash,
		Payload: json.RawMessage(normalized), Tombstone: snapshot.Tombstone}
	var signed offlineV3SignerResponse
	if err := s.offlineV3SignerCall(c.Context(), http.MethodPost, "/v3/sign-snapshot", claims, &signed); err != nil {
		return offlineV3SealedEntry{}, err
	}
	compact, err := offlineV3SealBytes(record.GrantEncryptionJWK, []byte(signed.Token), offlineV3SnapshotJWE, "clarin-offline-snapshot+jws")
	if err != nil {
		return offlineV3SealedEntry{}, err
	}
	return offlineV3SealedEntry{EnvelopeID: snapshot.SelectionID.String() + ":" + strconv.FormatInt(snapshot.HeadVersion, 10),
		Kind: "snapshot", CompactJWE: compact, ContentHash: contentHash}, nil
}

func (s *Server) handleOfflineV3SyncKeys(c *fiber.Ctx) error {
	var keys offlineV3SignerKeySet
	if err := s.offlineV3SignerCall(c.Context(), http.MethodGet, "/v3/sync-public-keys", nil, &keys); err != nil {
		return offlineV3Error(c, fiber.StatusServiceUnavailable, "offline_signer_unavailable")
	}
	c.Set("Cache-Control", "no-store")
	return c.JSON(keys)
}

func (s *Server) handleOfflineV3Sync(c *fiber.Ctx) error {
	var request offlineV3SyncRequest
	if err := offlineV3ReadStrictJSON(c, &request, offlineV3MaxJSONBody); err != nil || request.GrantID == uuid.Nil || request.ChallengeID == uuid.Nil ||
		request.Counter < 1 || len(request.Nonce) != 43 || len(request.TransportEnvelopes) > 100 || len(request.WantSnapshots) > 4 ||
		len(request.Inventory) > domain.OfflineV3MaxResources || len(request.ControlAcknowledgements) > 100 || request.UsedStorageBytes < 0 {
		return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_sync")
	}
	capability := offlineV3TransportCapability(c)
	record, err := s.repos.OfflineV3.AuthenticateTransport(c.Context(), request.GrantID, capability)
	if err != nil {
		return offlineV3Error(c, fiber.StatusForbidden, "offline_transport_denied")
	}
	if request.InstallationID != record.InstallationID || request.WindowsPrincipalID != record.WindowsPrincipalID || request.BrowserProfileID != record.BrowserProfileID {
		return offlineV3Error(c, fiber.StatusForbidden, "offline_transport_denied")
	}
	requestHash, err := offlineV3CanonicalHash(request)
	if err != nil {
		return err
	}
	installationKey, _, err := offlineV3PublicJWK(record.InstallationSigningJWK, "sig", string(jose.ES256))
	if err != nil {
		return offlineV3Error(c, fiber.StatusForbidden, "offline_transport_denied")
	}
	proof := offlineV3ProofClaims{Version: 3, Purpose: "sync", ChallengeID: request.ChallengeID, Nonce: request.Nonce, Counter: request.Counter,
		InstallationID: record.InstallationID, WindowsPrincipalID: record.WindowsPrincipalID, BrowserProfileID: record.BrowserProfileID,
		GrantID: record.GrantID, RequestHash: requestHash}
	if err := offlineV3VerifyProof(c.Get("X-Clarin-Service-Proof"), offlineV3ProofSync, installationKey, proof); err != nil {
		return offlineV3Error(c, fiber.StatusForbidden, "offline_transport_denied")
	}
	if err := s.repos.OfflineV3.ConsumeGrantChallengeAndCounter(c.Context(), request.ChallengeID, request.GrantID, "sync", request.Nonce, request.Counter); err != nil {
		return offlineV3RepositoryError(c, err)
	}
	if err := s.repos.OfflineV3.AcknowledgeControls(c.Context(), record, request.ControlAcknowledgements); err != nil {
		return offlineV3RepositoryError(c, err)
	}
	usable := offlineV3RecordUsable(record, true)
	syncState := "synchronized"
	var selections []domain.OfflineV3Selection
	var clientInventory map[uuid.UUID]offlineV3SyncInventory
	if usable {
		var revision int64
		var digest string
		selections, revision, digest, err = s.repos.OfflineV3.ListSelections(c.Context(), record.GrantID, record.UserID)
		if errors.Is(err, repository.ErrOfflineV3AccessDenied) {
			usable, syncState = false, "controls_only"
			if _, controlErr := s.ensureOfflineV3GrantControl(c, record, "wipe", "authority_changed"); controlErr != nil {
				return offlineV3Error(c, fiber.StatusServiceUnavailable, "offline_control_unavailable")
			}
		} else if err != nil {
			return offlineV3RepositoryError(c, err)
		} else if revision != record.SelectionRevision || digest != record.SelectionDigest {
			usable, syncState = false, "selection_changed"
		} else {
			clientInventory, err = offlineV3SyncInventoryIndex(request.Inventory, selections)
			if errors.Is(err, repository.ErrOfflineV3Conflict) {
				usable, syncState = false, "selection_changed"
			} else if err != nil {
				return offlineV3RepositoryError(c, err)
			} else if err := offlineV3ValidateWantedSelections(request.WantSnapshots, clientInventory); errors.Is(err, repository.ErrOfflineV3Conflict) {
				usable, syncState = false, "selection_changed"
			} else if err != nil {
				return offlineV3RepositoryError(c, err)
			} else if request.UsedStorageBytes > record.QuotaBytes {
				usable, syncState = false, "quota_exceeded"
			}
		}
	} else {
		syncState = "controls_only"
		if _, err := s.ensureOfflineV3InvalidGrantControl(c, record); err != nil {
			return offlineV3Error(c, fiber.StatusServiceUnavailable, "offline_control_unavailable")
		}
	}
	controls, err := s.repos.OfflineV3.PendingControls(c.Context(), record)
	if err != nil {
		return err
	}
	controlTokens := make([]string, 0, len(controls))
	for _, control := range controls {
		fresh, err := s.refreshOfflineV3ControlToken(c, control)
		if err != nil {
			return offlineV3Error(c, fiber.StatusServiceUnavailable, "offline_control_unavailable")
		}
		controlTokens = append(controlTokens, fresh.Token)
	}
	canonicalInventory := request.Inventory
	if selections != nil {
		canonicalInventory = offlineV3CanonicalInventory(selections, nil)
	}
	response := fiber.Map{"controls": controlTokens, "receipts": []offlineV3SealedEntry{}, "snapshots": []offlineV3SealedEntry{},
		"inventory": canonicalInventory, "server_time": time.Now().UTC(), "state": syncState}
	if !usable || record.CredentialEpoch <= 0 || record.AuthorityEpoch <= 0 {
		return c.JSON(response)
	}
	if len(request.TransportEnvelopes) > 0 && !s.cfg.OfflineV3TaskWrites {
		response["state"] = "writes_disabled"
		return c.JSON(response)
	}
	receipts := make([]offlineV3SealedEntry, 0, len(request.TransportEnvelopes))
	for _, outer := range request.TransportEnvelopes {
		if len(outer) < 64 || len(outer) > offlineV3MaxJSONBody || strings.TrimSpace(outer) != outer {
			return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_operation_envelope")
		}
		outerDigest := sha256.Sum256([]byte(outer))
		outerHash := hex.EncodeToString(outerDigest[:])
		var opened struct {
			Payload    string `json:"payload"`
			KeyID      string `json:"key_id"`
			KeyVersion int    `json:"key_version"`
		}
		if err := s.offlineV3SignerCall(c.Context(), http.MethodPost, "/v3/decrypt-operation", fiber.Map{"compact_jwe": outer}, &opened); err != nil {
			return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_operation_envelope")
		}
		operation, err := offlineV3VerifyOperationJWS(opened.Payload, record)
		if err != nil {
			return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_operation_signature")
		}
		tx, err := s.repos.DB().BeginTx(c.Context(), pgx.TxOptions{IsoLevel: pgx.Serializable})
		if err != nil {
			return err
		}
		result, applyErr := s.repos.OfflineV3.ApplyTaskOperationTx(c.Context(), tx, record, operation, outerHash)
		if applyErr != nil {
			_ = tx.Rollback(c.Context())
			return offlineV3RepositoryError(c, applyErr)
		}
		if err := tx.Commit(c.Context()); err != nil {
			return err
		}
		sealed, err := s.offlineV3SignAndSealReceipt(c, record, result, outerHash)
		if err != nil {
			return offlineV3Error(c, fiber.StatusServiceUnavailable, "offline_signer_unavailable")
		}
		receipts = append(receipts, sealed)
	}
	snapshots := make([]offlineV3SealedEntry, 0, len(request.WantSnapshots))
	var fetchedSnapshots []domain.OfflineV3Snapshot
	if len(request.WantSnapshots) > 0 {
		items, err := s.repos.OfflineV3.FetchSnapshotsV3(c.Context(), record.GrantID, record.SelectionRevision, request.WantSnapshots,
			func(ctx context.Context, accountID uuid.UUID, objectKey string, maxBytes int64) ([]byte, error) {
				if s.storage == nil || !storage.IsAccountWhiteboardObjectKey(accountID, objectKey) {
					return nil, repository.ErrOfflineV3AccessDenied
				}
				return s.storage.GetFileLimited(ctx, objectKey, maxBytes)
			})
		if err != nil {
			return offlineV3RepositoryError(c, err)
		}
		fetchedSnapshots = items
		for _, item := range items {
			local := clientInventory[item.SelectionID]
			if local.HeadVersion == item.HeadVersion && local.ContentHash == item.ContentHash {
				continue
			}
			sealed, err := s.offlineV3SignAndSealSnapshot(c, record, item)
			if err != nil {
				return offlineV3Error(c, fiber.StatusServiceUnavailable, "offline_signer_unavailable")
			}
			snapshots = append(snapshots, sealed)
		}
		if err := s.repos.OfflineV3.ConfirmSnapshotsIssued(c.Context(), record, items); err != nil {
			return offlineV3RepositoryError(c, err)
		}
	}
	if err := s.repos.OfflineV3.MarkSyncComplete(c.Context(), record); err != nil {
		return offlineV3RepositoryError(c, err)
	}
	response["receipts"], response["snapshots"] = receipts, snapshots
	response["inventory"] = offlineV3CanonicalInventory(selections, fetchedSnapshots)
	if len(selections) > 0 && (record.LastLeaseExpiresAt == nil || record.LastLeaseExpiresAt.Before(time.Now().UTC().Add(48*time.Hour))) {
		lease, expiresAt, renewed, err := s.issueOfflineV3Lease(c, record.GrantID, record.UserID)
		if err != nil {
			if errors.Is(err, repository.ErrOfflineV3AccessDenied) || errors.Is(err, repository.ErrOfflineV3Conflict) {
				return offlineV3RepositoryError(c, err)
			}
			return offlineV3Error(c, fiber.StatusServiceUnavailable, "offline_signer_unavailable")
		}
		if renewed.SelectionRevision != record.SelectionRevision || renewed.SelectionDigest != record.SelectionDigest {
			return offlineV3RepositoryError(c, repository.ErrOfflineV3Conflict)
		}
		response["lease"], response["lease_expires_at"] = lease, expiresAt
	}
	return c.JSON(response)
}
