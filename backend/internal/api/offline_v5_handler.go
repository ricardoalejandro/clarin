package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
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
	whiteboardcore "github.com/naperu/clarin/internal/whiteboard"
)

func (s *Server) requireOfflineV5(c *fiber.Ctx) error {
	c.Set("Cache-Control", "no-store, private")
	c.Set("X-Clarin-Offline-Protocol", "5")
	if s.cfg == nil || !s.cfg.OfflineV5Enabled || s.repos == nil || s.repos.OfflineV4 == nil || s.repos.OfflineV5 == nil {
		return offlineV3Error(c, fiber.StatusNotFound, "offline_unavailable")
	}
	if !validOfflineV4Origin(s.cfg.OfflineV5ServerOrigin) {
		return offlineV3Error(c, fiber.StatusServiceUnavailable, "offline_origin_unavailable")
	}
	origin := c.Get(fiber.HeaderOrigin)
	if (origin != "" && origin != s.cfg.OfflineV5ServerOrigin) || (c.Method() != http.MethodGet && origin != s.cfg.OfflineV5ServerOrigin) {
		return offlineV3Error(c, fiber.StatusForbidden, "offline_origin_denied")
	}
	return c.Next()
}

func (s *Server) handleOfflineV5Availability(c *fiber.Ctx) error {
	c.Set("Cache-Control", "no-store")
	c.Set("X-Clarin-Offline-Protocol", "5")
	enabled := s.cfg != nil && s.cfg.OfflineV5Enabled
	return c.JSON(fiber.Map{
		"enabled": enabled, "prepare_enabled": enabled && s.cfg.OfflineV5PrepareEnabled,
		"writes_enabled":    enabled && s.cfg.OfflineV5WritesEnabled,
		"blob_sync_enabled": enabled && s.cfg.OfflineV5BlobSyncEnabled,
		"protocol_version":  5, "max_offline_seconds": domain.OfflineV5MaxLeaseSeconds,
		"max_resources": domain.OfflineV5MaxResources,
	})
}

func (s *Server) offlineV5UserGrant(c *fiber.Ctx) (*repository.OfflineV5AuthRecord, error) {
	id, err := uuid.Parse(c.Params("grantId"))
	if err != nil || id == uuid.Nil {
		return nil, repository.ErrOfflineV3Invalid
	}
	userID, _ := c.Locals("user_id").(uuid.UUID)
	record, err := s.repos.OfflineV5.AuthRecord(c.Context(), id)
	if err != nil {
		return nil, err
	}
	if record.UserID != userID {
		return nil, repository.ErrOfflineV3NotFound
	}
	return record, nil
}

func (s *Server) handleOfflineV5LeaseKeys(c *fiber.Ctx) error {
	var keys jose.JSONWebKeySet
	if err := s.offlineV5SignerCall(c.Context(), http.MethodGet, "/v4/public-keys", nil, &keys); err != nil {
		return offlineV3Error(c, fiber.StatusServiceUnavailable, "offline_signer_unavailable")
	}
	return c.JSON(keys)
}

// handleOfflineV5GrantStatus lets a browser profile remove revoked local
// copies before the login screen offers them. It returns only the intersection
// of caller-supplied grant IDs that are still active and never exposes user,
// account or resource metadata. The request is signed by the non-exportable
// browser-profile key, so knowing a profile/grant UUID is insufficient.
func (s *Server) handleOfflineV5GrantStatus(c *fiber.Ctx) error {
	var input struct {
		ChallengeID      uuid.UUID   `json:"challenge_id"`
		Nonce            string      `json:"nonce"`
		BrowserProfileID uuid.UUID   `json:"browser_profile_id"`
		GrantIDs         []uuid.UUID `json:"grant_ids"`
	}
	if offlineV3ReadStrictJSON(c, &input, 16<<10) != nil || input.ChallengeID == uuid.Nil || input.BrowserProfileID == uuid.Nil ||
		len(input.Nonce) != 43 || len(input.GrantIDs) < 1 || len(input.GrantIDs) > 200 {
		return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_status")
	}
	seen := make(map[uuid.UUID]struct{}, len(input.GrantIDs))
	records := make([]*repository.OfflineV4AuthRecord, 0, len(input.GrantIDs))
	var profileKey *jose.JSONWebKey
	for _, grantID := range input.GrantIDs {
		if grantID == uuid.Nil {
			return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_status")
		}
		if _, exists := seen[grantID]; exists {
			continue
		}
		seen[grantID] = struct{}{}
		record, err := s.repos.OfflineV4.AuthRecord(c.Context(), grantID)
		if err != nil || record.BrowserProfileID != input.BrowserProfileID {
			continue
		}
		records = append(records, record)
		if profileKey == nil {
			profileKey, _, err = offlineV3PublicJWK(record.BrowserSigningJWK, "sig", string(jose.ES256))
			if err != nil {
				return offlineV3Error(c, fiber.StatusForbidden, "offline_transport_denied")
			}
		}
	}
	if profileKey == nil {
		return offlineV3Error(c, fiber.StatusForbidden, "offline_transport_denied")
	}
	expected := s.offlineV5ExpectedProof(c, "status", input.ChallengeID, input.BrowserProfileID, uuid.Nil, input.Nonce)
	if verifyOfflineV5Proof(c.Get("X-Clarin-Browser-Proof"), profileKey, expected, c.Body(), time.Now()) != nil {
		return offlineV3Error(c, fiber.StatusForbidden, "offline_proof_denied")
	}
	active := offlineV5ActiveGrantIDs(input.BrowserProfileID, records)
	return c.JSON(fiber.Map{"active_grant_ids": active})
}

func offlineV5ActiveGrantIDs(profileID uuid.UUID, records []*repository.OfflineV4AuthRecord) []uuid.UUID {
	active := make([]uuid.UUID, 0, len(records))
	seen := make(map[uuid.UUID]struct{}, len(records))
	for _, record := range records {
		if record == nil || record.BrowserProfileID != profileID || record.State != "active" || record.GrantID == uuid.Nil {
			continue
		}
		if _, exists := seen[record.GrantID]; exists {
			continue
		}
		seen[record.GrantID] = struct{}{}
		active = append(active, record.GrantID)
	}
	return active
}

func (s *Server) handleOfflineV5EnrollmentChallenge(c *fiber.Ctx) error {
	userID, _ := c.Locals("user_id").(uuid.UUID)
	challenge, err := s.repos.OfflineV5.CreateChallenge(c.Context(), userID, uuid.Nil, "enrollment")
	if err != nil {
		return offlineV4RepositoryError(c, err)
	}
	return c.JSON(challenge)
}

func (s *Server) handleOfflineV5Enrollment(c *fiber.Ctx) error {
	var input struct {
		ChallengeID      uuid.UUID       `json:"challenge_id"`
		Nonce            string          `json:"nonce"`
		BrowserProfileID uuid.UUID       `json:"browser_profile_id"`
		BrowserName      string          `json:"browser_name"`
		DisplayName      string          `json:"display_name"`
		ClientVersion    string          `json:"client_version"`
		SigningJWK       json.RawMessage `json:"signing_jwk"`
	}
	if err := offlineV3ReadStrictJSON(c, &input, 16<<10); err != nil || len(input.ClientVersion) > 40 {
		return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_enrollment")
	}
	key, thumb, err := offlineV3PublicJWK(input.SigningJWK, "sig", string(jose.ES256))
	if err != nil {
		return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_key")
	}
	expected := s.offlineV5ExpectedProof(c, "enrollment", input.ChallengeID, input.BrowserProfileID, uuid.Nil, input.Nonce)
	if verifyOfflineV5Proof(c.Get("X-Clarin-Browser-Proof"), key, expected, c.Body(), time.Now()) != nil {
		return offlineV3Error(c, fiber.StatusForbidden, "offline_proof_denied")
	}
	userID, _ := c.Locals("user_id").(uuid.UUID)
	id, err := s.repos.OfflineV5.RequestEnrollment(c.Context(), repository.OfflineV4EnrollmentInput{
		BrowserProfileID: input.BrowserProfileID, UserID: userID, BrowserName: strings.TrimSpace(input.BrowserName),
		DisplayName: strings.TrimSpace(input.DisplayName), SigningJWK: input.SigningJWK, KeyThumbprint: thumb,
	}, input.ChallengeID, input.Nonce)
	if err != nil {
		return offlineV4RepositoryError(c, err)
	}
	items, err := s.repos.OfflineV4.ListEnrollments(c.Context(), userID, id)
	if err != nil || len(items) != 1 {
		return offlineV3Error(c, fiber.StatusInternalServerError, "offline_enrollment_unavailable")
	}
	return c.JSON(fiber.Map{"request": items[0], "grants": []domain.OfflineV5Grant{}})
}

func (s *Server) handleOfflineV5EnrollmentStatus(c *fiber.Ctx) error {
	userID, _ := c.Locals("user_id").(uuid.UUID)
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_request")
	}
	items, err := s.repos.OfflineV4.ListEnrollments(c.Context(), userID, id)
	if err != nil {
		return offlineV4RepositoryError(c, err)
	}
	if len(items) != 1 {
		return offlineV3Error(c, fiber.StatusNotFound, "offline_not_found")
	}
	grants, err := s.repos.OfflineV5.ListV5Grants(c.Context(), userID, items[0].BrowserProfileID, s.cfg.OfflineV5WritesEnabled)
	if err != nil {
		return offlineV4RepositoryError(c, err)
	}
	return c.JSON(fiber.Map{"request": items[0], "grants": grants})
}

func (s *Server) handleOfflineV5Grants(c *fiber.Ctx) error {
	userID, _ := c.Locals("user_id").(uuid.UUID)
	profileID := uuid.Nil
	var err error
	if c.Query("browser_profile_id") != "" {
		profileID, err = uuid.Parse(c.Query("browser_profile_id"))
		if err != nil {
			return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_profile")
		}
	}
	items, err := s.repos.OfflineV5.ListV5Grants(c.Context(), userID, profileID, s.cfg.OfflineV5WritesEnabled)
	if err != nil {
		return offlineV4RepositoryError(c, err)
	}
	return c.JSON(fiber.Map{"items": items})
}

func (s *Server) handleOfflineV5GrantChallenge(c *fiber.Ctx) error {
	record, err := s.offlineV5UserGrant(c)
	if err != nil {
		return offlineV4RepositoryError(c, err)
	}
	purpose := "keys"
	if strings.HasSuffix(c.Path(), "/prepare/challenge") {
		purpose = "prepare"
	}
	if !s.cfg.OfflineV5PrepareEnabled {
		return offlineV3Error(c, fiber.StatusConflict, "offline_prepare_disabled")
	}
	challenge, err := s.repos.OfflineV5.CreateChallenge(c.Context(), record.UserID, record.GrantID, purpose)
	if err != nil {
		return offlineV4RepositoryError(c, err)
	}
	return c.JSON(challenge)
}

func (s *Server) handleOfflineV5RegisterKey(c *fiber.Ctx) error {
	if !s.cfg.OfflineV5PrepareEnabled {
		return offlineV3Error(c, fiber.StatusConflict, "offline_prepare_disabled")
	}
	record, err := s.offlineV5UserGrant(c)
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
	if err = offlineV3ReadStrictJSON(c, &input, 16<<10); err != nil || input.BrowserProfileID != record.BrowserProfileID ||
		!utf8.ValidString(input.Password) || utf8.RuneCountInString(input.Password) < 10 || len(input.Password) > 72 {
		return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_preparation")
	}
	profileKey, _, err := offlineV3PublicJWK(record.BrowserSigningJWK, "sig", string(jose.ES256))
	if err != nil {
		return offlineV3Error(c, fiber.StatusForbidden, "offline_key_denied")
	}
	grantKey, thumb, err := offlineV3PublicJWK(input.SigningJWK, "sig", string(jose.ES256))
	if err != nil || thumb == record.BrowserKeyThumbprint {
		return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_key")
	}
	expected := s.offlineV5ExpectedProof(c, "keys", input.ChallengeID, record.BrowserProfileID, record.GrantID, input.Nonce)
	if verifyOfflineV5Proof(c.Get("X-Clarin-Browser-Proof"), profileKey, expected, c.Body(), time.Now()) != nil ||
		verifyOfflineV5Proof(c.Get("X-Clarin-Grant-Proof"), grantKey, expected, c.Body(), time.Now()) != nil {
		return offlineV3Error(c, fiber.StatusForbidden, "offline_proof_denied")
	}
	if input.Login != record.Username || s.services == nil || s.services.Auth == nil {
		return offlineV3Error(c, fiber.StatusForbidden, "offline_reauthentication_failed")
	}
	if err = s.services.Auth.VerifyCurrentPassword(c.Context(), record.UserID, input.Password); err != nil {
		if errors.Is(err, service.ErrCurrentPasswordThrottled) {
			return offlineV3Error(c, fiber.StatusTooManyRequests, "offline_reauthentication_throttled")
		}
		if errors.Is(err, service.ErrInvalidCurrentPassword) {
			return offlineV3Error(c, fiber.StatusForbidden, "offline_reauthentication_failed")
		}
		return offlineV3Error(c, fiber.StatusServiceUnavailable, "offline_reauthentication_unavailable")
	}
	if err = s.repos.OfflineV5.RegisterKey(c.Context(), record.GrantID, record.UserID, input.ChallengeID, input.Nonce, input.SigningJWK, thumb); err != nil {
		return offlineV5RepositoryError(c, err)
	}
	return c.JSON(fiber.Map{"status": "registered", "grant_id": record.GrantID})
}

func (s *Server) handleOfflineV5Resources(c *fiber.Ctx) error {
	record, err := s.offlineV5UserGrant(c)
	if err != nil {
		return offlineV4RepositoryError(c, err)
	}
	after := uuid.Nil
	if c.Query("after") != "" {
		after, err = uuid.Parse(c.Query("after"))
		if err != nil {
			return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_cursor")
		}
	}
	limit := 50
	if c.Query("limit") != "" {
		limit, err = strconv.Atoi(c.Query("limit"))
		if err != nil {
			return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_limit")
		}
	}
	if !containsString(record.Modules, c.Query("module")) {
		return offlineV3Error(c, fiber.StatusForbidden, "offline_access_denied")
	}
	items, next, err := s.repos.OfflineV4.ListResourceCandidates(c.Context(), record.GrantID, record.UserID, c.Query("module"), c.Query("q"), after, limit)
	if err != nil {
		return offlineV4RepositoryError(c, err)
	}
	return c.JSON(fiber.Map{"items": items, "next_cursor": next})
}

func containsString(items []string, expected string) bool {
	for _, item := range items {
		if item == expected {
			return true
		}
	}
	return false
}

func (s *Server) handleOfflineV5Selections(c *fiber.Ctx) error {
	record, err := s.offlineV5UserGrant(c)
	if err != nil {
		return offlineV4RepositoryError(c, err)
	}
	if c.Method() == http.MethodPut {
		var input struct {
			SelectionRevision int64                       `json:"selection_revision"`
			Items             []domain.OfflineV3Selection `json:"items"`
		}
		if offlineV3ReadStrictJSON(c, &input, 32<<10) != nil {
			return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_selection")
		}
		for _, item := range input.Items {
			if !containsString(record.Modules, item.Module) {
				return offlineV3Error(c, fiber.StatusForbidden, "offline_access_denied")
			}
		}
		if err = s.repos.OfflineV5.ReplaceSelections(c.Context(), record.GrantID, record.UserID, input.SelectionRevision, input.Items); err != nil {
			if errors.Is(err, repository.ErrOfflineV3Conflict) {
				return offlineV3Error(c, fiber.StatusConflict, "offline_selection_changed")
			}
			return offlineV4RepositoryError(c, err)
		}
	}
	items, current, err := s.repos.OfflineV4.Selections(c.Context(), record.GrantID, record.UserID)
	if err != nil {
		return offlineV4RepositoryError(c, err)
	}
	return c.JSON(fiber.Map{"items": items, "selection_revision": current.SelectionRevision, "selection_digest": current.SelectionDigest})
}

func (s *Server) offlineV5AssetLoader(ctx context.Context, accountID uuid.UUID, key string, maximum int64) ([]byte, error) {
	if s.storage == nil || !storage.IsAccountWhiteboardObjectKey(accountID, key) {
		return nil, repository.ErrOfflineV3AccessDenied
	}
	return s.storage.GetFileLimited(ctx, key, maximum)
}

func (s *Server) signOfflineV5Manifest(ctx context.Context, prepared *repository.OfflineV5PrepareResult) (string, jose.JSONWebKeySet, error) {
	var signed offlineV3SignerResponse
	var keys jose.JSONWebKeySet
	if prepared == nil || prepared.Record == nil || prepared.Manifest.Digest == "" {
		return "", keys, repository.ErrOfflineV3Invalid
	}
	if err := s.offlineV5SignerCall(ctx, http.MethodGet, "/v4/public-keys", nil, &keys); err != nil {
		return "", keys, err
	}
	record := prepared.Record
	loginHash := sha256.Sum256([]byte(record.Username))
	claims := domain.OfflineV4Lease{
		Issuer: "clarin-offline-v4", Audience: s.cfg.OfflineV5ServerOrigin, IssuedAt: prepared.Manifest.IssuedAt.Unix(),
		NotBefore: prepared.Manifest.IssuedAt.Unix(), ExpiresAt: prepared.Manifest.ExpiresAt.Unix(), ID: uuid.NewString(), Version: 4,
		OfflineV4Tuple: record.OfflineV4Tuple, CredentialEpoch: record.CredentialEpoch, AuthorityEpoch: record.AuthorityEpoch,
		GrantRevision: record.Revision, SelectionRevision: prepared.Manifest.SelectionRevision,
		// V5 authority is the signed full-manifest digest. These legacy actions
		// remain read-only and MUST NOT be interpreted as v5 capabilities.
		SelectionDigest: prepared.Manifest.Digest, Actions: repositoryOfflineV5ReadActions(record.Modules),
		MaxStorageBytes: record.QuotaBytes, BrowserKeyThumbprint: record.BrowserKeyThumbprint,
		GrantSigningKeyThumbprint: record.GrantKeyThumbprint, LoginBindingSHA256: hex.EncodeToString(loginHash[:]),
	}
	if err := s.offlineV5SignerCall(ctx, http.MethodPost, "/v4/sign-lease", claims, &signed); err != nil {
		return "", keys, err
	}
	return signed.Token, keys, nil
}

func repositoryOfflineV5ReadActions(modules []string) []string {
	result := make([]string, 0, len(modules))
	for _, module := range modules {
		switch module {
		case domain.OfflineModuleTasks:
			result = append(result, domain.OfflineV5ActionTasksRead)
		case domain.OfflineModuleContacts:
			result = append(result, domain.OfflineV5ActionContactsRead)
		case domain.OfflineModulePrograms:
			result = append(result, domain.OfflineV5ActionProgramsRead)
		case domain.OfflineModuleWhiteboards:
			result = append(result, domain.OfflineV5ActionBoardsRead)
		}
	}
	return result
}

func (s *Server) handleOfflineV5Prepare(c *fiber.Ctx) error {
	record, err := s.offlineV5UserGrant(c)
	if err != nil {
		return offlineV4RepositoryError(c, err)
	}
	if !s.cfg.OfflineV5PrepareEnabled {
		return offlineV3Error(c, fiber.StatusConflict, "offline_prepare_disabled")
	}
	var input struct {
		ChallengeID      uuid.UUID `json:"challenge_id"`
		Nonce            string    `json:"nonce"`
		BrowserProfileID uuid.UUID `json:"browser_profile_id"`
	}
	if offlineV3ReadStrictJSON(c, &input, 4<<10) != nil || input.BrowserProfileID != record.BrowserProfileID {
		return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_preparation")
	}
	profileKey, _, err := offlineV3PublicJWK(record.BrowserSigningJWK, "sig", string(jose.ES256))
	if err != nil {
		return offlineV3Error(c, fiber.StatusForbidden, "offline_transport_denied")
	}
	grantKey, _, err := offlineV3PublicJWK(record.GrantSigningJWK, "sig", string(jose.ES256))
	if err != nil {
		return offlineV3Error(c, fiber.StatusForbidden, "offline_transport_denied")
	}
	expected := s.offlineV5ExpectedProof(c, "prepare", input.ChallengeID, record.BrowserProfileID, record.GrantID, input.Nonce)
	if verifyOfflineV5Proof(c.Get("X-Clarin-Browser-Proof"), profileKey, expected, c.Body(), time.Now()) != nil ||
		verifyOfflineV5Proof(c.Get("X-Clarin-Grant-Proof"), grantKey, expected, c.Body(), time.Now()) != nil {
		return offlineV3Error(c, fiber.StatusForbidden, "offline_proof_denied")
	}
	prepared, err := s.repos.OfflineV5.Prepare(c.Context(), record.GrantID, record.UserID, s.cfg.OfflineV5WritesEnabled,
		s.offlineV5AssetLoader, input.ChallengeID, input.Nonce)
	if err != nil {
		return offlineV4RepositoryError(c, err)
	}
	lease, keys, err := s.signOfflineV5Manifest(c.Context(), prepared)
	if err != nil {
		return offlineV3Error(c, fiber.StatusServiceUnavailable, "offline_signer_unavailable")
	}
	if err := s.repos.OfflineV5.ConfirmManifestIssued(c.Context(), prepared.Record, prepared.Manifest); err != nil {
		return offlineV4RepositoryError(c, err)
	}
	return c.JSON(fiber.Map{"grant": offlineV5GrantResponse(prepared.Record, s.cfg.OfflineV5WritesEnabled),
		"manifest": prepared.Manifest, "lease": lease, "signer_public_keys": keys, "snapshots": prepared.Snapshots,
		"state": "prepared", "server_time": time.Now().UTC()})
}

func offlineV5GrantResponse(record *repository.OfflineV5AuthRecord, writes bool) domain.OfflineV5Grant {
	if record == nil {
		return domain.OfflineV5Grant{Modules: []string{}, Capabilities: []string{}}
	}
	capabilities := make([]string, 0)
	capabilities = repositoryOfflineV5ReadActions(record.Modules)
	if writes && record.WritesEnabled {
		for _, module := range record.Modules {
			switch module {
			case domain.OfflineModuleTasks:
				capabilities = append(capabilities, domain.OfflineV5ActionTasksCreate, domain.OfflineV5ActionTasksUpdate, domain.OfflineV5ActionTasksComplete, domain.OfflineV5ActionTasksReopen, domain.OfflineV5ActionTasksComment)
			case domain.OfflineModuleContacts:
				capabilities = append(capabilities, domain.OfflineV5ActionContactsUpdate, domain.OfflineV5ActionContactsObserve)
			case domain.OfflineModulePrograms:
				capabilities = append(capabilities, domain.OfflineV5ActionProgramsUpdate,
					domain.OfflineV5ActionProgramsParticipantAdd, domain.OfflineV5ActionProgramsParticipantLifecycle,
					domain.OfflineV5ActionProgramsSessionUpsert, domain.OfflineV5ActionProgramsAttendance,
					domain.OfflineV5ActionProgramsObservation, domain.OfflineV5ActionProgramsGoals)
			case domain.OfflineModuleWhiteboards:
				capabilities = append(capabilities, domain.OfflineV5ActionBoardsScene)
			}
		}
	}
	return domain.OfflineV5Grant{OfflineV4Grant: record.OfflineV4Grant, Modules: append([]string(nil), record.Modules...), Capabilities: capabilities, V5Revision: record.V5Revision}
}

func (s *Server) handleOfflineV5SyncChallenge(c *fiber.Ctx) error {
	var input struct {
		GrantID          uuid.UUID `json:"grant_id"`
		BrowserProfileID uuid.UUID `json:"browser_profile_id"`
	}
	if offlineV3ReadStrictJSON(c, &input, 4<<10) != nil {
		return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_challenge")
	}
	record, err := s.repos.OfflineV5.AuthRecord(c.Context(), input.GrantID)
	if err != nil || record.BrowserProfileID != input.BrowserProfileID || record.GrantKeyThumbprint == "" {
		return offlineV3Error(c, fiber.StatusForbidden, "offline_transport_denied")
	}
	challenge, err := s.repos.OfflineV5.CreateChallenge(c.Context(), uuid.Nil, input.GrantID, "sync")
	if err != nil {
		return offlineV4RepositoryError(c, err)
	}
	return c.JSON(challenge)
}

type offlineV5WhiteboardWirePatch struct {
	ExpectedSequence   int64           `json:"expected_sequence"`
	OperationID        uuid.UUID       `json:"operation_id"`
	Scene              json.RawMessage `json:"scene"`
	Patch              json.RawMessage `json:"patch"`
	SceneSchemaVersion string          `json:"scene_schema_version"`
	EditorVersion      string          `json:"editor_version"`
}

func (s *Server) validateOfflineV5WhiteboardOperations(ctx context.Context, record *repository.OfflineV5AuthRecord, operations []domain.OfflineV5Operation) error {
	for index := range operations {
		op := &operations[index]
		if op.Action != domain.OfflineV5ActionBoardsScene {
			continue
		}
		var wire offlineV5WhiteboardWirePatch
		decoder := json.NewDecoder(bytes.NewReader(op.Payload))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&wire) != nil || decoder.Decode(new(any)) != io.EOF || wire.ExpectedSequence != op.BaseVersion || wire.OperationID != op.OperationID || len(wire.Scene) == 0 {
			return repository.ErrOfflineV3Invalid
		}
		canonicalScene, sceneHash, err := service.ValidateAndHashWhiteboardScene(wire.Scene)
		if err != nil {
			return repository.ErrOfflineV3Invalid
		}
		wire.SceneSchemaVersion, err = service.ValidateWhiteboardVersion(wire.SceneSchemaVersion, "excalidraw")
		if err != nil || wire.SceneSchemaVersion != "excalidraw" {
			return repository.ErrOfflineV3Invalid
		}
		wire.EditorVersion = whiteboardEditorVersion
		var patch whiteboardRealtimePatchData
		if len(wire.Patch) > 0 {
			if json.Unmarshal(wire.Patch, &patch) != nil || len(patch.Elements) > whiteboardcore.MaxElementsPerPatch {
				return repository.ErrOfflineV3Invalid
			}
		} else {
			var scene struct {
				Elements []json.RawMessage `json:"elements"`
				AppState json.RawMessage   `json:"appState"`
			}
			if json.Unmarshal(canonicalScene, &scene) != nil || len(scene.Elements) > whiteboardcore.MaxElementsPerPatch {
				return repository.ErrOfflineV3Invalid
			}
			patch.Elements, patch.AppState = scene.Elements, scene.AppState
		}
		if patch.ClientBaseSequence != 0 && patch.ClientBaseSequence != op.BaseVersion {
			return repository.ErrOfflineV3Invalid
		}
		patch.BaseSequence, patch.ClientBaseSequence = op.BaseVersion, op.BaseVersion
		patch.AppState, err = whiteboardcore.SanitizePersistedAppState(patch.AppState)
		if err != nil {
			return repository.ErrOfflineV3Invalid
		}
		canonicalPatch, err := json.Marshal(patch)
		if err != nil {
			return err
		}
		requestHash, err := whiteboardPatchRequestPayloadHash(op.BaseVersion, patch.Elements, patch.AppState)
		if err != nil {
			return err
		}
		current, err := s.repos.Whiteboard.GetScene(ctx, record.AccountID, record.UserID, op.ResourceID, domain.WhiteboardAccessEdit)
		if err != nil {
			return err
		}
		if current.Sequence == op.BaseVersion {
			materialized, _, err := whiteboardcore.MaterializeScenePatch(current.Scene, patch.Elements, patch.AppState)
			if err != nil {
				return repository.ErrOfflineV3Invalid
			}
			_, expectedHash, err := service.ValidateAndHashWhiteboardScene(materialized)
			if err != nil || expectedHash != sceneHash {
				return repository.ErrOfflineV3Invalid
			}
		}
		internal, err := json.Marshal(map[string]any{"scene": canonicalScene, "patch": json.RawMessage(canonicalPatch),
			"scene_schema_version": wire.SceneSchemaVersion, "editor_version": wire.EditorVersion,
			"request_payload_hash": requestHash, "result_scene_hash": sceneHash})
		if err != nil {
			return err
		}
		op.Payload = internal
	}
	return nil
}

func offlineV5SyncBatchWithinLimits(input *repository.OfflineV5SyncInput) bool {
	return input != nil && len(input.Operations) <= offlineMaxOperations && len(input.WantSnapshots) <= domain.OfflineV5MaxResources
}

func (s *Server) handleOfflineV5Sync(c *fiber.Ctx) error {
	var input repository.OfflineV5SyncInput
	if offlineV3ReadStrictJSON(c, &input, 2<<20) != nil || !offlineV5SyncBatchWithinLimits(&input) {
		return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_sync")
	}
	if !s.cfg.OfflineV5PrepareEnabled && len(input.Operations) == 0 {
		return offlineV3Error(c, fiber.StatusConflict, "offline_prepare_disabled")
	}
	record, err := s.repos.OfflineV5.AuthRecord(c.Context(), input.GrantID)
	if err != nil || record.BrowserProfileID != input.BrowserProfileID {
		return offlineV3Error(c, fiber.StatusForbidden, "offline_transport_denied")
	}
	profileKey, _, err := offlineV3PublicJWK(record.BrowserSigningJWK, "sig", string(jose.ES256))
	if err != nil {
		return offlineV3Error(c, fiber.StatusForbidden, "offline_transport_denied")
	}
	grantKey, _, err := offlineV3PublicJWK(record.GrantSigningJWK, "sig", string(jose.ES256))
	if err != nil {
		return offlineV3Error(c, fiber.StatusForbidden, "offline_transport_denied")
	}
	expected := s.offlineV5ExpectedProof(c, "sync", input.ChallengeID, input.BrowserProfileID, input.GrantID, input.Nonce)
	if verifyOfflineV5Proof(c.Get("X-Clarin-Browser-Proof"), profileKey, expected, c.Body(), time.Now()) != nil ||
		verifyOfflineV5Proof(c.Get("X-Clarin-Grant-Proof"), grantKey, expected, c.Body(), time.Now()) != nil {
		return offlineV3Error(c, fiber.StatusForbidden, "offline_proof_denied")
	}
	result, err := s.repos.OfflineV5.SyncWithPolicy(c.Context(), input, record, s.cfg.OfflineV5WritesEnabled,
		!s.cfg.OfflineV5PrepareEnabled,
		func(ctx context.Context, active *repository.OfflineV5AuthRecord, operation *domain.OfflineV5Operation) error {
			batch := []domain.OfflineV5Operation{*operation}
			if err := s.validateOfflineV5WhiteboardOperations(ctx, active, batch); err != nil {
				return err
			}
			*operation = batch[0]
			return nil
		})
	if errors.Is(err, repository.ErrOfflineV5WritesDisabled) {
		if !s.cfg.OfflineV5PrepareEnabled {
			return offlineV3Error(c, fiber.StatusConflict, "offline_prepare_disabled")
		}
		return offlineV3Error(c, fiber.StatusConflict, "offline_writes_disabled")
	}
	if err != nil {
		return offlineV4RepositoryError(c, err)
	}
	// OFFLINE_V5_PREPARE_ENABLED is the global authority-issuance kill switch,
	// not merely a UI toggle. A superseded request may still retrieve already
	// committed receipts so the browser can clear its encrypted outbox, but it
	// must not receive a fresh manifest or extend the offline lease.
	if !s.cfg.OfflineV5PrepareEnabled {
		if !result.RecoveredReceipts {
			return offlineV3Error(c, fiber.StatusConflict, "offline_prepare_disabled")
		}
		return c.JSON(fiber.Map{"receipts": result.Receipts, "renewal_available": false,
			"state": "receipts_recovered", "server_time": time.Now().UTC()})
	}
	prepared, err := s.repos.OfflineV5.RefreshManifest(c.Context(), result.Record.GrantID, result.Record.UserID,
		s.cfg.OfflineV5WritesEnabled, s.offlineV5AssetLoader)
	if err != nil {
		return offlineV4RepositoryError(c, err)
	}
	lease, keys, err := s.signOfflineV5Manifest(c.Context(), prepared)
	if err != nil {
		return offlineV3Error(c, fiber.StatusServiceUnavailable, "offline_signer_unavailable")
	}
	if err := s.repos.OfflineV5.ConfirmManifestIssued(c.Context(), prepared.Record, prepared.Manifest); err != nil {
		return offlineV4RepositoryError(c, err)
	}
	return c.JSON(fiber.Map{"grant": offlineV5GrantResponse(prepared.Record, s.cfg.OfflineV5WritesEnabled),
		"manifest": prepared.Manifest, "lease": lease, "signer_public_keys": keys, "snapshots": prepared.Snapshots,
		"receipts": result.Receipts, "state": "synchronized", "server_time": time.Now().UTC()})
}

func (s *Server) handleAdminOfflineV5Requests(c *fiber.Ctx) error {
	items, err := s.repos.OfflineV4.ListEnrollments(c.Context(), uuid.Nil, uuid.Nil)
	if err != nil {
		return offlineV4RepositoryError(c, err)
	}
	return c.JSON(fiber.Map{"items": items})
}

func (s *Server) handleAdminOfflineV5Approve(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_request")
	}
	var input struct {
		Accounts []repository.OfflineV5GrantApproval `json:"accounts"`
	}
	if offlineV3ReadStrictJSON(c, &input, 32<<10) != nil {
		return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_approval")
	}
	actor, _ := c.Locals("user_id").(uuid.UUID)
	grants, err := s.repos.OfflineV5.Approve(c.Context(), id, actor, input.Accounts)
	if err != nil {
		return offlineV4RepositoryError(c, err)
	}
	return c.JSON(fiber.Map{"grants": grants})
}

func (s *Server) handleAdminOfflineV5Reject(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_request")
	}
	var input struct {
		Note string `json:"note"`
	}
	if offlineV3ReadStrictJSON(c, &input, 4<<10) != nil {
		return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_request")
	}
	actor, _ := c.Locals("user_id").(uuid.UUID)
	if err := s.repos.OfflineV4.Reject(c.Context(), id, actor, input.Note); err != nil {
		return offlineV4RepositoryError(c, err)
	}
	return c.JSON(fiber.Map{"status": "rejected"})
}

func (s *Server) handleAdminOfflineV5Grants(c *fiber.Ctx) error {
	items, err := s.repos.OfflineV5.ListV5Grants(c.Context(), uuid.Nil, uuid.Nil, s.cfg.OfflineV5WritesEnabled)
	if err != nil {
		return offlineV4RepositoryError(c, err)
	}
	return c.JSON(fiber.Map{"items": items})
}

func (s *Server) handleAdminOfflineV5Upgrade(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_grant")
	}
	var input struct {
		Modules      []string `json:"modules"`
		MaxResources *int     `json:"max_resources,omitempty"`
		QuotaBytes   *int64   `json:"quota_bytes,omitempty"`
	}
	if offlineV3ReadStrictJSON(c, &input, 8<<10) != nil {
		return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_approval")
	}
	actor, _ := c.Locals("user_id").(uuid.UUID)
	grant, err := s.repos.OfflineV5.Upgrade(c.Context(), id, actor, input.Modules, input.MaxResources, input.QuotaBytes)
	if err != nil {
		return offlineV4RepositoryError(c, err)
	}
	return c.JSON(fiber.Map{"grant": grant})
}

func (s *Server) handleAdminOfflineV5Revoke(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_grant")
	}
	var input struct {
		Note string `json:"note"`
	}
	if offlineV3ReadStrictJSON(c, &input, 4<<10) != nil || len(input.Note) > 500 {
		return offlineV3Error(c, fiber.StatusBadRequest, "invalid_offline_control")
	}
	actor, _ := c.Locals("user_id").(uuid.UUID)
	count, err := s.repos.OfflineV4.Revoke(c.Context(), actor, id, "grant")
	if err != nil {
		return offlineV4RepositoryError(c, err)
	}
	return c.JSON(fiber.Map{"status": "revoked", "revoked_count": count})
}
