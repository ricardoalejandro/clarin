package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
	"github.com/naperu/clarin/internal/storage"
)

func (s *Server) requireOfflineV4(c *fiber.Ctx) error {
	c.Set("Cache-Control", "no-store, private")
	c.Set("X-Clarin-Offline-Protocol", "4")
	if s.cfg == nil || !s.cfg.OfflineV4Enabled || s.repos == nil || s.repos.OfflineV4 == nil {
		return offlineV3Error(c, 404, "offline_unavailable")
	}
	if !validOfflineV4Origin(s.cfg.OfflineV4ServerOrigin) {
		return offlineV3Error(c, 503, "offline_origin_unavailable")
	}
	origin := c.Get("Origin")
	if origin != "" && origin != s.cfg.OfflineV4ServerOrigin || c.Method() != http.MethodGet && origin != s.cfg.OfflineV4ServerOrigin {
		return offlineV3Error(c, 403, "offline_origin_denied")
	}
	return c.Next()
}

func (s *Server) handleOfflineV4Availability(c *fiber.Ctx) error {
	c.Set("Cache-Control", "no-store")
	c.Set("X-Clarin-Offline-Protocol", "4")
	enabled := s.cfg != nil && s.cfg.OfflineV4Enabled
	return c.JSON(fiber.Map{"enabled": enabled, "task_writes_enabled": enabled && s.cfg.OfflineV4TaskWrites, "protocol_version": 4, "max_offline_seconds": 86400})
}

func (s *Server) handleOfflineV4LeaseKeys(c *fiber.Ctx) error {
	var keys jose.JSONWebKeySet
	if err := s.offlineV4SignerCall(c.Context(), http.MethodGet, "/v4/public-keys", nil, &keys); err != nil {
		return offlineV3Error(c, 503, "offline_signer_unavailable")
	}
	return c.JSON(keys)
}

func (s *Server) handleOfflineV4EnrollmentChallenge(c *fiber.Ctx) error {
	userID, _ := c.Locals("user_id").(uuid.UUID)
	challenge, err := s.repos.OfflineV4.CreateChallenge(c.Context(), userID, uuid.Nil, "enrollment")
	if err != nil {
		return offlineV4RepositoryError(c, err)
	}
	return c.JSON(challenge)
}

func (s *Server) handleOfflineV4Enrollment(c *fiber.Ctx) error {
	var input struct {
		ChallengeID      uuid.UUID       `json:"challenge_id"`
		Nonce            string          `json:"nonce"`
		BrowserProfileID uuid.UUID       `json:"browser_profile_id"`
		BrowserName      string          `json:"browser_name"`
		DisplayName      string          `json:"display_name"`
		ClientVersion    string          `json:"client_version"`
		SigningJWK       json.RawMessage `json:"signing_jwk"`
	}
	if err := offlineV3ReadStrictJSON(c, &input, 16384); err != nil || len(input.ClientVersion) > 40 {
		return offlineV3Error(c, 400, "invalid_offline_enrollment")
	}
	key, thumb, err := offlineV3PublicJWK(input.SigningJWK, "sig", string(jose.ES256))
	if err != nil {
		return offlineV3Error(c, 400, "invalid_offline_key")
	}
	expected := s.offlineV4ExpectedProof(c, "enrollment", input.ChallengeID, input.BrowserProfileID, uuid.Nil, input.Nonce)
	if err = verifyOfflineV4Proof(c.Get("X-Clarin-Browser-Proof"), key, expected, c.Body(), time.Now()); err != nil {
		return offlineV3Error(c, 403, "offline_proof_denied")
	}
	userID, _ := c.Locals("user_id").(uuid.UUID)
	id, err := s.repos.OfflineV4.RequestEnrollment(c.Context(), repository.OfflineV4EnrollmentInput{BrowserProfileID: input.BrowserProfileID, UserID: userID, BrowserName: strings.TrimSpace(input.BrowserName), DisplayName: strings.TrimSpace(input.DisplayName), SigningJWK: input.SigningJWK, KeyThumbprint: thumb}, input.ChallengeID, input.Nonce)
	if err != nil {
		return offlineV4RepositoryError(c, err)
	}
	items, err := s.repos.OfflineV4.ListEnrollments(c.Context(), userID, id)
	if err != nil || len(items) != 1 {
		return offlineV3Error(c, 500, "offline_enrollment_unavailable")
	}
	return c.JSON(fiber.Map{"request": items[0], "grants": []domain.OfflineV4Grant{}})
}

func (s *Server) handleOfflineV4EnrollmentStatus(c *fiber.Ctx) error {
	userID, _ := c.Locals("user_id").(uuid.UUID)
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return offlineV3Error(c, 400, "invalid_offline_request")
	}
	items, err := s.repos.OfflineV4.ListEnrollments(c.Context(), userID, id)
	if err != nil {
		return offlineV4RepositoryError(c, err)
	}
	if len(items) != 1 {
		return offlineV3Error(c, 404, "offline_not_found")
	}
	grants, err := s.repos.OfflineV4.ListGrants(c.Context(), userID, items[0].BrowserProfileID)
	if err != nil {
		return offlineV4RepositoryError(c, err)
	}
	return c.JSON(fiber.Map{"request": items[0], "grants": grants})
}

func (s *Server) handleOfflineV4Grants(c *fiber.Ctx) error {
	userID, _ := c.Locals("user_id").(uuid.UUID)
	var profileID uuid.UUID
	if c.Query("browser_profile_id") != "" {
		var err error
		profileID, err = uuid.Parse(c.Query("browser_profile_id"))
		if err != nil {
			return offlineV3Error(c, 400, "invalid_offline_profile")
		}
	}
	items, err := s.repos.OfflineV4.ListGrants(c.Context(), userID, profileID)
	if err != nil {
		return offlineV4RepositoryError(c, err)
	}
	return c.JSON(fiber.Map{"items": items})
}

func (s *Server) offlineV4UserGrant(c *fiber.Ctx) (*repository.OfflineV4AuthRecord, error) {
	id, err := uuid.Parse(c.Params("grantId"))
	if err != nil || id == uuid.Nil {
		return nil, repository.ErrOfflineV3Invalid
	}
	userID, _ := c.Locals("user_id").(uuid.UUID)
	record, err := s.repos.OfflineV4.AuthRecord(c.Context(), id)
	if err != nil {
		return nil, err
	}
	if record.UserID != userID {
		return nil, repository.ErrOfflineV3NotFound
	}
	return record, nil
}

func (s *Server) handleOfflineV4GrantChallenge(c *fiber.Ctx) error {
	record, err := s.offlineV4UserGrant(c)
	if err != nil {
		return offlineV4RepositoryError(c, err)
	}
	challenge, err := s.repos.OfflineV4.CreateChallenge(c.Context(), record.UserID, record.GrantID, "keys")
	if err != nil {
		return offlineV4RepositoryError(c, err)
	}
	return c.JSON(challenge)
}

func (s *Server) handleOfflineV4RegisterKey(c *fiber.Ctx) error {
	record, err := s.offlineV4UserGrant(c)
	if err != nil {
		return offlineV4RepositoryError(c, err)
	}
	var input struct {
		ChallengeID      uuid.UUID       `json:"challenge_id"`
		Nonce            string          `json:"nonce"`
		BrowserProfileID uuid.UUID       `json:"browser_profile_id"`
		SigningJWK       json.RawMessage `json:"signing_jwk"`
		Login            string          `json:"login"`
		Password         string          `json:"password"`
	}
	if err = offlineV3ReadStrictJSON(c, &input, 16384); err != nil || input.BrowserProfileID != record.BrowserProfileID || utf8.RuneCountInString(input.Password) < 12 || len(input.Password) > 1024 {
		return offlineV3Error(c, 400, "invalid_offline_preparation")
	}
	profileKey, _, err := offlineV3PublicJWK(record.BrowserSigningJWK, "sig", string(jose.ES256))
	if err != nil {
		return offlineV3Error(c, 403, "offline_key_denied")
	}
	grantKey, thumb, err := offlineV3PublicJWK(input.SigningJWK, "sig", string(jose.ES256))
	if err != nil || thumb == record.BrowserKeyThumbprint {
		return offlineV3Error(c, 400, "invalid_offline_key")
	}
	expected := s.offlineV4ExpectedProof(c, "keys", input.ChallengeID, record.BrowserProfileID, record.GrantID, input.Nonce)
	if verifyOfflineV4Proof(c.Get("X-Clarin-Browser-Proof"), profileKey, expected, c.Body(), time.Now()) != nil || verifyOfflineV4Proof(c.Get("X-Clarin-Grant-Proof"), grantKey, expected, c.Body(), time.Now()) != nil {
		return offlineV3Error(c, 403, "offline_proof_denied")
	}
	if input.Login != record.Username {
		return offlineV3Error(c, 403, "offline_reauthentication_failed")
	}
	if s.services == nil || s.services.Auth == nil {
		return offlineV3Error(c, 503, "offline_reauthentication_unavailable")
	}
	if err = s.services.Auth.VerifyCurrentPassword(c.Context(), record.UserID, input.Password); err != nil {
		if errors.Is(err, service.ErrCurrentPasswordThrottled) {
			return offlineV3Error(c, 429, "offline_reauthentication_throttled")
		}
		if errors.Is(err, service.ErrInvalidCurrentPassword) {
			return offlineV3Error(c, 403, "offline_reauthentication_failed")
		}
		return offlineV3Error(c, 503, "offline_reauthentication_unavailable")
	}
	// Password remains request-local and is never passed to persistence or logs.
	if err = s.repos.OfflineV4.RegisterKey(c.Context(), record.GrantID, record.UserID, input.ChallengeID, input.Nonce, input.SigningJWK, thumb); err != nil {
		return offlineV4RepositoryError(c, err)
	}
	return c.JSON(fiber.Map{"status": "registered", "grant_id": record.GrantID})
}

func (s *Server) handleOfflineV4Resources(c *fiber.Ctx) error {
	record, err := s.offlineV4UserGrant(c)
	if err != nil {
		return offlineV4RepositoryError(c, err)
	}
	var after uuid.UUID
	if c.Query("after") != "" {
		after, err = uuid.Parse(c.Query("after"))
		if err != nil {
			return offlineV3Error(c, 400, "invalid_offline_cursor")
		}
	}
	limit := 50
	if c.Query("limit") != "" {
		limit, err = strconv.Atoi(c.Query("limit"))
		if err != nil {
			return offlineV3Error(c, 400, "invalid_offline_limit")
		}
	}
	items, next, err := s.repos.OfflineV4.ListResourceCandidates(c.Context(), record.GrantID, record.UserID, c.Query("module"), c.Query("q"), after, limit)
	if err != nil {
		return offlineV4RepositoryError(c, err)
	}
	return c.JSON(fiber.Map{"items": items, "next_cursor": next})
}

func (s *Server) handleOfflineV4Selections(c *fiber.Ctx) error {
	record, err := s.offlineV4UserGrant(c)
	if err != nil {
		return offlineV4RepositoryError(c, err)
	}
	if c.Method() == http.MethodPut {
		var input struct {
			SelectionRevision int64                       `json:"selection_revision"`
			Items             []domain.OfflineV3Selection `json:"items"`
		}
		if offlineV3ReadStrictJSON(c, &input, 32768) != nil {
			return offlineV3Error(c, 400, "invalid_offline_selection")
		}
		if err = s.repos.OfflineV4.ReplaceSelections(c.Context(), record.GrantID, record.UserID, input.SelectionRevision, input.Items); err != nil {
			return offlineV4RepositoryError(c, err)
		}
	}
	items, current, err := s.repos.OfflineV4.Selections(c.Context(), record.GrantID, record.UserID)
	if err != nil {
		return offlineV4RepositoryError(c, err)
	}
	return c.JSON(fiber.Map{"items": items, "selection_revision": current.SelectionRevision, "selection_digest": current.SelectionDigest})
}

func (s *Server) handleOfflineV4SyncChallenge(c *fiber.Ctx) error {
	var input struct {
		GrantID          uuid.UUID `json:"grant_id"`
		BrowserProfileID uuid.UUID `json:"browser_profile_id"`
	}
	if offlineV3ReadStrictJSON(c, &input, 4096) != nil {
		return offlineV3Error(c, 400, "invalid_offline_challenge")
	}
	record, err := s.repos.OfflineV4.AuthRecord(c.Context(), input.GrantID)
	if err != nil || record.BrowserProfileID != input.BrowserProfileID || record.GrantKeyThumbprint == "" {
		return offlineV3Error(c, 403, "offline_transport_denied")
	}
	challenge, err := s.repos.OfflineV4.CreateChallenge(c.Context(), uuid.Nil, input.GrantID, "sync")
	if err != nil {
		return offlineV4RepositoryError(c, err)
	}
	return c.JSON(challenge)
}

func (s *Server) handleOfflineV4Sync(c *fiber.Ctx) error {
	var input repository.OfflineV4SyncInput
	if offlineV3ReadStrictJSON(c, &input, 2<<20) != nil {
		return offlineV3Error(c, 400, "invalid_offline_sync")
	}
	record, err := s.repos.OfflineV4.AuthRecord(c.Context(), input.GrantID)
	if err != nil || record.BrowserProfileID != input.BrowserProfileID {
		return offlineV3Error(c, 403, "offline_transport_denied")
	}
	profileKey, _, err := offlineV3PublicJWK(record.BrowserSigningJWK, "sig", string(jose.ES256))
	if err != nil {
		return offlineV3Error(c, 403, "offline_transport_denied")
	}
	grantKey, _, err := offlineV3PublicJWK(record.GrantSigningJWK, "sig", string(jose.ES256))
	if err != nil {
		return offlineV3Error(c, 403, "offline_transport_denied")
	}
	expected := s.offlineV4ExpectedProof(c, "sync", input.ChallengeID, input.BrowserProfileID, input.GrantID, input.Nonce)
	if verifyOfflineV4Proof(c.Get("X-Clarin-Browser-Proof"), profileKey, expected, c.Body(), time.Now()) != nil || verifyOfflineV4Proof(c.Get("X-Clarin-Grant-Proof"), grantKey, expected, c.Body(), time.Now()) != nil {
		return offlineV3Error(c, 403, "offline_proof_denied")
	}
	if len(input.Operations) > 0 && !s.cfg.OfflineV4TaskWrites {
		return offlineV3Error(c, 409, "offline_writes_disabled")
	}
	var signed offlineV3SignerResponse
	var keys jose.JSONWebKeySet
	if err = s.offlineV4SignerCall(c.Context(), http.MethodGet, "/v4/public-keys", nil, &keys); err != nil {
		return offlineV3Error(c, 503, "offline_signer_unavailable")
	}
	var signingErr error
	result, err := s.repos.OfflineV4.Sync(c.Context(), input, record, s.cfg.OfflineV4TaskWrites, func(ctx context.Context, accountID uuid.UUID, key string, max int64) ([]byte, error) {
		if s.storage == nil || !storage.IsAccountWhiteboardObjectKey(accountID, key) {
			return nil, repository.ErrOfflineV3AccessDenied
		}
		return s.storage.GetFileLimited(ctx, key, max)
	}, func(ctx context.Context, current *repository.OfflineV4AuthRecord) error {
		now := time.Now().UTC()
		loginHash := sha256.Sum256([]byte(current.Username))
		claims := domain.OfflineV4Lease{Issuer: "clarin-offline-v4", Audience: s.cfg.OfflineV4ServerOrigin, IssuedAt: now.Unix(), NotBefore: now.Unix(), ExpiresAt: now.Add(time.Duration(current.MaxOfflineSeconds) * time.Second).Unix(), ID: uuid.NewString(), Version: 4, OfflineV4Tuple: current.OfflineV4Tuple, CredentialEpoch: current.CredentialEpoch, AuthorityEpoch: current.AuthorityEpoch, GrantRevision: current.Revision, SelectionRevision: current.SelectionRevision, SelectionDigest: current.SelectionDigest, Actions: offlineV4EffectiveActions(current.Actions, s.cfg.OfflineV4TaskWrites), MaxStorageBytes: current.QuotaBytes, BrowserKeyThumbprint: current.BrowserKeyThumbprint, GrantSigningKeyThumbprint: current.GrantKeyThumbprint, LoginBindingSHA256: hex.EncodeToString(loginHash[:])}
		signingErr = s.offlineV4SignerCall(ctx, http.MethodPost, "/v4/sign-lease", claims, &signed)
		return signingErr
	})
	if err != nil {
		if signingErr != nil {
			return offlineV3Error(c, 503, "offline_signer_unavailable")
		}
		return offlineV4RepositoryError(c, err)
	}
	current := result.Record
	now := time.Now().UTC()
	return c.JSON(fiber.Map{"grant": current.OfflineV4Grant, "lease": signed.Token, "signer_public_keys": keys, "snapshots": result.Snapshots, "receipts": result.Receipts, "state": "synchronized", "server_time": now})
}

func (s *Server) handleAdminOfflineV4Requests(c *fiber.Ctx) error {
	items, err := s.repos.OfflineV4.ListEnrollments(c.Context(), uuid.Nil, uuid.Nil)
	if err != nil {
		return offlineV4RepositoryError(c, err)
	}
	return c.JSON(fiber.Map{"items": items})
}

func (s *Server) handleAdminOfflineV4Approve(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return offlineV3Error(c, 400, "invalid_offline_request")
	}
	var input offlineV3ApproveRequest
	if offlineV3ReadStrictJSON(c, &input, 32768) != nil {
		return offlineV3Error(c, 400, "invalid_offline_approval")
	}
	approvals := []repository.OfflineV3GrantApproval{}
	for _, a := range input.Accounts {
		approvals = append(approvals, repository.OfflineV3GrantApproval{AccountID: a.AccountID, Actions: a.Actions, MaxResources: a.MaxResources, QuotaBytes: a.QuotaBytes})
	}
	actor, _ := c.Locals("user_id").(uuid.UUID)
	grants, err := s.repos.OfflineV4.Approve(c.Context(), id, actor, approvals)
	if err != nil {
		return offlineV4RepositoryError(c, err)
	}
	return c.JSON(fiber.Map{"grants": grants})
}

func (s *Server) handleAdminOfflineV4Reject(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return offlineV3Error(c, 400, "invalid_offline_request")
	}
	var input struct {
		Note string `json:"note"`
	}
	if offlineV3ReadStrictJSON(c, &input, 4096) != nil {
		return offlineV3Error(c, 400, "invalid_offline_request")
	}
	actor, _ := c.Locals("user_id").(uuid.UUID)
	if err = s.repos.OfflineV4.Reject(c.Context(), id, actor, input.Note); err != nil {
		return offlineV4RepositoryError(c, err)
	}
	return c.JSON(fiber.Map{"status": "rejected"})
}

func (s *Server) handleAdminOfflineV4Grants(c *fiber.Ctx) error {
	items, err := s.repos.OfflineV4.ListGrants(c.Context(), uuid.Nil, uuid.Nil)
	if err != nil {
		return offlineV4RepositoryError(c, err)
	}
	return c.JSON(fiber.Map{"items": items})
}

func (s *Server) handleAdminOfflineV4Revoke(c *fiber.Ctx) error {
	var input struct {
		Scope   string    `json:"scope"`
		ScopeID uuid.UUID `json:"scope_id"`
		Action  string    `json:"action"`
		Note    string    `json:"note"`
	}
	if offlineV3ReadStrictJSON(c, &input, 4096) != nil {
		return offlineV3Error(c, 400, "invalid_offline_control")
	}
	if c.Params("id") != "" {
		var err error
		input.ScopeID, err = uuid.Parse(c.Params("id"))
		if err != nil {
			return offlineV3Error(c, 400, "invalid_offline_grant")
		}
		input.Scope = "grant"
		input.Action = "revoke"
	}
	if input.ScopeID == uuid.Nil || input.Action != "revoke" || len(input.Note) > 500 {
		return offlineV3Error(c, 400, "invalid_offline_control")
	}
	actor, _ := c.Locals("user_id").(uuid.UUID)
	count, err := s.repos.OfflineV4.Revoke(c.Context(), actor, input.ScopeID, input.Scope)
	if err != nil {
		return offlineV4RepositoryError(c, err)
	}
	return c.JSON(fiber.Map{"status": "revoked", "revoked_count": count})
}
