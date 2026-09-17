package repository

import (
	"context"
	cryptorand "crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
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
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
)

var (
	ErrOfflineV3NotFound     = errors.New("offline v3 identity not found")
	ErrOfflineV3Conflict     = errors.New("offline v3 identity conflict")
	ErrOfflineV3AccessDenied = errors.New("offline v3 access denied")
	ErrOfflineV3Replay       = errors.New("offline v3 request replayed or out of order")
	ErrOfflineV3Invalid      = errors.New("offline v3 request invalid")
	ErrOfflineV3KeyExists    = errors.New("offline v3 grant keys already registered")
	ErrOfflineV3ReceiptReuse = errors.New("offline v3 operation id reused")
)

const offlineV3ChallengeTTL = 90 * time.Second

type OfflineV3Repository struct {
	db *pgxpool.Pool
}

type OfflineV3Challenge struct {
	ID              uuid.UUID `json:"challenge_id"`
	Nonce           string    `json:"nonce"`
	Purpose         string    `json:"purpose"`
	AuthorizationID uuid.UUID `json:"authorization_id,omitempty"`
	ExpiresAt       time.Time `json:"expires_at"`
}

type OfflineV3EnrollmentInput struct {
	InstallationID            uuid.UUID
	WindowsPrincipalID        uuid.UUID
	BrowserProfileID          uuid.UUID
	AuthorizationID           uuid.UUID
	UserID                    uuid.UUID
	DisplayName               string
	PrincipalDisplayName      string
	BrowserName               string
	ClientVersion             string
	SIDHash                   string
	InstallationSigningJWK    json.RawMessage
	InstallationKeyThumbprint string
	ServiceEncryptionJWK      json.RawMessage
	ServiceKeyThumbprint      string
	BrowserDPoPJWK            json.RawMessage
	BrowserKeyThumbprint      string
	RequestDigest             string
}

type OfflineV3GrantApproval struct {
	AccountID    uuid.UUID
	Actions      []string
	MaxResources int
	QuotaBytes   int64
}

type OfflineV3ServiceDescriptor struct {
	InstallationID       uuid.UUID
	WindowsPrincipalID   uuid.UUID
	BrowserProfileID     uuid.UUID
	ServiceSigningJWK    json.RawMessage
	ServiceEncryptionJWK json.RawMessage
	Token                string
	KeyID                string
	KeyVersion           int
	ExpiresAt            time.Time
}

type OfflineV3AuthRecord struct {
	domain.OfflineV3Grant
	CanonicalLogin                   string
	InstallationSigningJWK           json.RawMessage
	ServiceEncryptionJWK             json.RawMessage
	BrowserDPoPJWK                   json.RawMessage
	GrantSigningJWK                  json.RawMessage
	GrantEncryptionJWK               json.RawMessage
	GrantKeyVersion                  int
	LastAuthenticatedCredentialEpoch int64
	LastAuthenticatedAuthorityEpoch  int64
	UserActive                       bool
	AccountActive                    bool
	MembershipActive                 bool
	InstallationState                string
	PrincipalState                   string
	BrowserState                     string
	AuthorizationState               string
}

// LockActiveGrantTx is the final authority barrier for every snapshot and
// operation. Preflight records are intentionally insufficient: this method
// locks the tuple parent-to-child, re-reads live authority, requires the exact
// stored action and keeps every decision inside the caller's transaction.
func (r *OfflineV3Repository) LockActiveGrantTx(ctx context.Context, tx pgx.Tx, grantID uuid.UUID, requiredAction string) (*OfflineV3AuthRecord, error) {
	module, valid := offlineV3ModuleForAction(requiredAction)
	if grantID == uuid.Nil || !valid {
		return nil, ErrOfflineV3Invalid
	}
	record, err := r.lockActiveGrantAuthorityTx(ctx, tx, grantID)
	if err != nil {
		return nil, err
	}
	var actionAllowed bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM offline_v3_grant_actions
		WHERE grant_id=$1 AND account_id=$2 AND action_code=$3)`, record.GrantID, record.AccountID, requiredAction).Scan(&actionAllowed); err != nil {
		return nil, err
	}
	if !actionAllowed {
		return nil, ErrOfflineV3AccessDenied
	}
	moduleAllowed, err := offlineV3ActorHasModuleWith(ctx, tx, record.UserID, record.AccountID, module)
	if err != nil {
		return nil, err
	}
	if !moduleAllowed {
		return nil, ErrOfflineV3AccessDenied
	}
	record.Actions = []string{requiredAction}
	return record, nil
}

// lockActiveGrantAuthorityTx is the common parent-to-child authority barrier
// for operations that do not themselves imply one module action (for example,
// replacing the selection with an empty set). Callers must still enforce every
// exact action needed by the concrete resource operation.
func (r *OfflineV3Repository) lockActiveGrantAuthorityTx(ctx context.Context, tx pgx.Tx, grantID uuid.UUID) (*OfflineV3AuthRecord, error) {
	if grantID == uuid.Nil {
		return nil, ErrOfflineV3Invalid
	}
	record := &OfflineV3AuthRecord{}
	if err := tx.QueryRow(ctx, `SELECT installation_id,windows_principal_id,browser_profile_id,authorization_id,user_id,account_id
		FROM offline_v3_grants WHERE id=$1`, grantID).Scan(&record.InstallationID, &record.WindowsPrincipalID,
		&record.BrowserProfileID, &record.AuthorizationID, &record.UserID, &record.AccountID); errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrOfflineV3NotFound
	} else if err != nil {
		return nil, err
	}
	record.GrantID = grantID
	// Global authority mutations acquire this per-user advisory before touching
	// users/user_accounts. Taking the same prefix here prevents a grant lock ->
	// user row inversion with password, role, membership, and activation changes.
	if err := lockUserAuthorityTx(ctx, tx, record.UserID); err != nil {
		return nil, err
	}
	lockedMemberships, err := lockAccountMembershipsKeyShareTx(ctx, tx, record.AccountID, []uuid.UUID{record.UserID})
	if err != nil {
		return nil, err
	}
	if _, activeMembership := lockedMemberships[record.UserID]; !activeMembership {
		return nil, ErrOfflineV3AccessDenied
	}
	var installationState, principalState, browserState, authorizationState string
	if err := tx.QueryRow(ctx, `SELECT state,revision,installation_signing_jwk,service_encryption_jwk
		FROM offline_v3_installations WHERE id=$1 FOR SHARE`, record.InstallationID).
		Scan(&installationState, &record.InstallationRevision, &record.InstallationSigningJWK, &record.ServiceEncryptionJWK); err != nil {
		return nil, err
	}
	if err := tx.QueryRow(ctx, `SELECT state,revision FROM offline_v3_windows_principals
		WHERE id=$1 AND installation_id=$2 FOR SHARE`, record.WindowsPrincipalID, record.InstallationID).
		Scan(&principalState, &record.PrincipalRevision); err != nil {
		return nil, err
	}
	if err := tx.QueryRow(ctx, `SELECT state,revision,browser_key_thumbprint,browser_dpop_jwk FROM offline_v3_browser_profiles
		WHERE id=$1 AND installation_id=$2 AND windows_principal_id=$3 FOR SHARE`, record.BrowserProfileID, record.InstallationID, record.WindowsPrincipalID).
		Scan(&browserState, &record.BrowserRevision, &record.BrowserKeyThumbprint, &record.BrowserDPoPJWK); err != nil {
		return nil, err
	}
	if err := tx.QueryRow(ctx, `SELECT state,revision FROM offline_v3_authorizations
		WHERE id=$1 AND installation_id=$2 AND windows_principal_id=$3 AND browser_profile_id=$4 AND user_id=$5 FOR SHARE`,
		record.AuthorizationID, record.InstallationID, record.WindowsPrincipalID, record.BrowserProfileID, record.UserID).
		Scan(&authorizationState, &record.AuthorizationRevision); err != nil {
		return nil, err
	}
	var lastCredentialEpoch, lastAuthorityEpoch int64
	if err := tx.QueryRow(ctx, `SELECT state,revision,selection_revision,selection_digest,max_resources,quota_bytes,max_offline_seconds,
		last_authenticated_credential_epoch,last_authenticated_authority_epoch,created_at,updated_at
		FROM offline_v3_grants WHERE id=$1 AND account_id=$2 FOR UPDATE`, record.GrantID, record.AccountID).
		Scan(&record.State, &record.GrantRevision, &record.SelectionRevision, &record.SelectionDigest, &record.MaxResources,
			&record.QuotaBytes, &record.MaxOfflineSeconds, &lastCredentialEpoch, &lastAuthorityEpoch, &record.CreatedAt, &record.UpdatedAt); err != nil {
		return nil, err
	}
	var userAuthorityEpoch, membershipAuthorityEpoch int64
	if err := tx.QueryRow(ctx, `SELECT account_user.username,account_user.is_active,account_user.offline_credential_epoch,account_user.offline_authority_epoch,
		COALESCE(account.is_active,TRUE),epoch.active,epoch.authority_epoch,account.name
		FROM users account_user
		JOIN accounts account ON account.id=$2
		JOIN offline_v3_membership_epochs epoch ON epoch.user_id=account_user.id AND epoch.account_id=account.id
		WHERE account_user.id=$1 FOR SHARE OF account_user,account,epoch`, record.UserID, record.AccountID).
		Scan(&record.CanonicalLogin, &record.UserActive, &record.CredentialEpoch, &userAuthorityEpoch, &record.AccountActive, &record.MembershipActive,
			&membershipAuthorityEpoch, &record.AccountName); err != nil {
		return nil, err
	}
	record.AuthorityEpoch = userAuthorityEpoch + membershipAuthorityEpoch
	if installationState != "active" || principalState != "active" || browserState != "active" || authorizationState != "active" ||
		record.State != "active" || !record.UserActive || !record.AccountActive || !record.MembershipActive ||
		record.CredentialEpoch != lastCredentialEpoch || record.AuthorityEpoch != lastAuthorityEpoch {
		return nil, ErrOfflineV3AccessDenied
	}
	if err := tx.QueryRow(ctx, `SELECT key_version,signing_jwk,signing_key_thumbprint,encryption_jwk,encryption_key_thumbprint
		FROM offline_v3_grant_keys WHERE grant_id=$1 AND account_id=$2 AND state='active' FOR SHARE`, record.GrantID, record.AccountID).
		Scan(&record.GrantKeyVersion, &record.GrantSigningJWK, &record.GrantSigningThumbprint,
			&record.GrantEncryptionJWK, &record.GrantEncryptionThumbprint); errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrOfflineV3AccessDenied
	} else if err != nil {
		return nil, err
	}
	record.KeysReady = true
	return record, nil
}

func (r *OfflineV3Repository) CreateUserChallenge(ctx context.Context, userID uuid.UUID, purpose string) (*OfflineV3Challenge, error) {
	if userID == uuid.Nil || purpose != "enrollment" {
		return nil, ErrOfflineV3Invalid
	}
	authorizationID := uuid.New()
	return r.createChallenge(ctx, purpose, &userID, &authorizationID, nil, nil)
}

func (r *OfflineV3Repository) CreateGrantChallenge(ctx context.Context, grantID uuid.UUID, purpose string) (*OfflineV3Challenge, error) {
	if grantID == uuid.Nil || (purpose != "grant_keys" && purpose != "lease" && purpose != "sync" && purpose != "control_ack") {
		return nil, ErrOfflineV3Invalid
	}
	var accountID uuid.UUID
	if err := r.db.QueryRow(ctx, `SELECT account_id FROM offline_v3_grants WHERE id=$1`, grantID).Scan(&accountID); errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrOfflineV3NotFound
	} else if err != nil {
		return nil, err
	}
	return r.createChallenge(ctx, purpose, nil, nil, &grantID, &accountID)
}

func (r *OfflineV3Repository) createChallenge(ctx context.Context, purpose string, userID, authorizationID, grantID, accountID *uuid.UUID) (*OfflineV3Challenge, error) {
	raw := make([]byte, 32)
	if _, err := cryptorand.Read(raw); err != nil {
		return nil, err
	}
	nonce := base64.RawURLEncoding.EncodeToString(raw)
	digest := sha256.Sum256([]byte(nonce))
	challenge := &OfflineV3Challenge{ID: uuid.New(), Nonce: nonce, Purpose: purpose, ExpiresAt: time.Now().UTC().Add(offlineV3ChallengeTTL)}
	if authorizationID != nil {
		challenge.AuthorizationID = *authorizationID
	}
	_, err := r.db.Exec(ctx, `INSERT INTO offline_v3_challenges(id,purpose,user_id,authorization_id,grant_id,account_id,nonce_hash,expires_at)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, challenge.ID, purpose, userID, authorizationID, grantID, accountID, digest[:], challenge.ExpiresAt)
	if err != nil {
		return nil, err
	}
	return challenge, nil
}

func (r *OfflineV3Repository) ConsumeUserChallenge(ctx context.Context, id, userID, authorizationID uuid.UUID, purpose, nonce string) error {
	if id == uuid.Nil || userID == uuid.Nil || authorizationID == uuid.Nil || nonce == "" {
		return ErrOfflineV3Replay
	}
	digest := sha256.Sum256([]byte(nonce))
	tag, err := r.db.Exec(ctx, `UPDATE offline_v3_challenges SET consumed_at=NOW()
		WHERE id=$1 AND user_id=$2 AND authorization_id=$3 AND purpose=$4 AND nonce_hash=$5 AND consumed_at IS NULL AND expires_at>NOW()`, id, userID, authorizationID, purpose, digest[:])
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrOfflineV3Replay
	}
	return nil
}

// ConsumeGrantChallengeAndCounter consumes the nonce and advances the
// grant-scoped counter atomically.  A failed/out-of-order request consumes
// neither, so clients can obtain a fresh challenge without repairing state.
func (r *OfflineV3Repository) ConsumeGrantChallengeAndCounter(ctx context.Context, id, grantID uuid.UUID, purpose, nonce string, counter int64) error {
	if id == uuid.Nil || grantID == uuid.Nil || nonce == "" || counter < 1 {
		return ErrOfflineV3Replay
	}
	digest := sha256.Sum256([]byte(nonce))
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var accountID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT account_id FROM offline_v3_grants WHERE id=$1 FOR SHARE`, grantID).Scan(&accountID); errors.Is(err, pgx.ErrNoRows) {
		return ErrOfflineV3NotFound
	} else if err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `UPDATE offline_v3_challenges SET consumed_at=NOW()
		WHERE id=$1 AND grant_id=$2 AND account_id=$3 AND purpose=$4 AND nonce_hash=$5
		  AND consumed_at IS NULL AND expires_at>NOW()`, id, grantID, accountID, purpose, digest[:])
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrOfflineV3Replay
	}
	var accepted int64
	err = tx.QueryRow(ctx, `INSERT INTO offline_v3_counters(grant_id,account_id,last_counter)
		VALUES($1,$2,$3)
		ON CONFLICT(grant_id) DO UPDATE SET last_counter=EXCLUDED.last_counter,updated_at=NOW()
		WHERE offline_v3_counters.account_id=EXCLUDED.account_id AND offline_v3_counters.last_counter<EXCLUDED.last_counter
		RETURNING last_counter`, grantID, accountID, counter).Scan(&accepted)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrOfflineV3Replay
	}
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func offlineV3SameJSON(left []byte, right json.RawMessage) bool {
	var a, b any
	if json.Unmarshal(left, &a) != nil || json.Unmarshal(right, &b) != nil {
		return false
	}
	aa, _ := json.Marshal(a)
	bb, _ := json.Marshal(b)
	return string(aa) == string(bb)
}

func (r *OfflineV3Repository) RequestEnrollment(ctx context.Context, input OfflineV3EnrollmentInput) (*domain.OfflineV3EnrollmentRequest, bool, error) {
	tx, err := r.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return nil, false, err
	}
	defer tx.Rollback(ctx)

	var installationKey, serviceKey []byte
	var installationState string
	err = tx.QueryRow(ctx, `SELECT installation_signing_jwk,service_encryption_jwk,state FROM offline_v3_installations WHERE id=$1 FOR UPDATE`, input.InstallationID).Scan(&installationKey, &serviceKey, &installationState)
	if errors.Is(err, pgx.ErrNoRows) {
		_, err = tx.Exec(ctx, `INSERT INTO offline_v3_installations(id,display_name,client_version,installation_signing_jwk,installation_key_thumbprint,service_encryption_jwk,service_key_thumbprint)
			VALUES($1,$2,$3,$4,$5,$6,$7)`, input.InstallationID, input.DisplayName, input.ClientVersion,
			input.InstallationSigningJWK, input.InstallationKeyThumbprint, input.ServiceEncryptionJWK, input.ServiceKeyThumbprint)
	} else if err == nil && (!offlineV3SameJSON(installationKey, input.InstallationSigningJWK) || !offlineV3SameJSON(serviceKey, input.ServiceEncryptionJWK)) {
		return nil, false, ErrOfflineV3Conflict
	} else if err == nil && installationState != "requested" && installationState != "active" {
		return nil, false, ErrOfflineV3AccessDenied
	}
	if err != nil {
		return nil, false, err
	}

	var sidHash, principalState string
	err = tx.QueryRow(ctx, `SELECT sid_hash,state FROM offline_v3_windows_principals WHERE id=$1 AND installation_id=$2 FOR UPDATE`, input.WindowsPrincipalID, input.InstallationID).Scan(&sidHash, &principalState)
	if errors.Is(err, pgx.ErrNoRows) {
		_, err = tx.Exec(ctx, `INSERT INTO offline_v3_windows_principals(id,installation_id,sid_hash,display_name)
			VALUES($1,$2,$3,$4)`, input.WindowsPrincipalID, input.InstallationID, input.SIDHash, input.PrincipalDisplayName)
	} else if err == nil && !strings.EqualFold(sidHash, input.SIDHash) {
		return nil, false, ErrOfflineV3Conflict
	} else if err == nil && principalState != "requested" && principalState != "active" {
		return nil, false, ErrOfflineV3AccessDenied
	}
	if err != nil {
		return nil, false, err
	}

	var browserKey []byte
	var browserState string
	err = tx.QueryRow(ctx, `SELECT browser_dpop_jwk,state FROM offline_v3_browser_profiles
		WHERE id=$1 AND installation_id=$2 AND windows_principal_id=$3 FOR UPDATE`, input.BrowserProfileID, input.InstallationID, input.WindowsPrincipalID).Scan(&browserKey, &browserState)
	if errors.Is(err, pgx.ErrNoRows) {
		_, err = tx.Exec(ctx, `INSERT INTO offline_v3_browser_profiles(id,installation_id,windows_principal_id,browser_dpop_jwk,browser_key_thumbprint,browser_name)
			VALUES($1,$2,$3,$4,$5,$6)`, input.BrowserProfileID, input.InstallationID, input.WindowsPrincipalID, input.BrowserDPoPJWK, input.BrowserKeyThumbprint, input.BrowserName)
	} else if err == nil && !offlineV3SameJSON(browserKey, input.BrowserDPoPJWK) {
		return nil, false, ErrOfflineV3Conflict
	} else if err == nil && browserState != "requested" && browserState != "active" {
		return nil, false, ErrOfflineV3AccessDenied
	}
	if err != nil {
		return nil, false, err
	}

	// A browser retry may carry a fresh challenge/authorization ID after an
	// HTTP timeout or reload. Return the already pending request only after all
	// three device keys above have been proven to match; never create two
	// undecided authorizations for the same browser/user pair.
	var pendingRequestID uuid.UUID
	err = tx.QueryRow(ctx, `SELECT request.id FROM offline_v3_authorizations authz
		JOIN offline_v3_enrollment_requests request ON request.authorization_id=authz.id
		WHERE authz.browser_profile_id=$1 AND authz.user_id=$2 AND authz.state='requested' AND request.state='requested'
		ORDER BY request.requested_at DESC,request.id DESC LIMIT 1 FOR UPDATE OF authz,request`, input.BrowserProfileID, input.UserID).Scan(&pendingRequestID)
	if err == nil {
		if err := tx.Commit(ctx); err != nil {
			return nil, false, err
		}
		return r.EnrollmentRequestForUser(ctx, pendingRequestID, input.UserID, true)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, false, err
	}

	var authorizationUser uuid.UUID
	err = tx.QueryRow(ctx, `SELECT user_id FROM offline_v3_authorizations
		WHERE id=$1 AND installation_id=$2 AND windows_principal_id=$3 AND browser_profile_id=$4 FOR UPDATE`,
		input.AuthorizationID, input.InstallationID, input.WindowsPrincipalID, input.BrowserProfileID).Scan(&authorizationUser)
	if errors.Is(err, pgx.ErrNoRows) {
		_, err = tx.Exec(ctx, `INSERT INTO offline_v3_authorizations(id,installation_id,windows_principal_id,browser_profile_id,user_id)
			VALUES($1,$2,$3,$4,$5)`, input.AuthorizationID, input.InstallationID, input.WindowsPrincipalID, input.BrowserProfileID, input.UserID)
	} else if err == nil && authorizationUser != input.UserID {
		return nil, false, ErrOfflineV3Conflict
	}
	if err != nil {
		return nil, false, err
	}

	var requestID uuid.UUID
	var requestState, requestDigest string
	var requestedAt time.Time
	err = tx.QueryRow(ctx, `SELECT id,state,request_digest,requested_at FROM offline_v3_enrollment_requests
		WHERE authorization_id=$1 FOR UPDATE`, input.AuthorizationID).Scan(&requestID, &requestState, &requestDigest, &requestedAt)
	idempotent := err == nil
	if errors.Is(err, pgx.ErrNoRows) {
		requestID = uuid.New()
		err = tx.QueryRow(ctx, `INSERT INTO offline_v3_enrollment_requests(id,installation_id,windows_principal_id,browser_profile_id,authorization_id,user_id,request_digest)
			VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING state,requested_at`, requestID, input.InstallationID, input.WindowsPrincipalID,
			input.BrowserProfileID, input.AuthorizationID, input.UserID, input.RequestDigest).Scan(&requestState, &requestedAt)
	} else if err == nil && !strings.EqualFold(requestDigest, input.RequestDigest) {
		return nil, false, ErrOfflineV3Conflict
	}
	if err != nil {
		return nil, false, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO offline_v3_audit(installation_id,authorization_id,actor_id,event_type,metadata)
		VALUES($1,$2,$3,'enrollment_requested',jsonb_build_object('request_id',$4::text,'idempotent',$5::boolean))`, input.InstallationID, input.AuthorizationID, input.UserID, requestID, idempotent); err != nil {
		return nil, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, false, err
	}
	return r.EnrollmentRequestForUser(ctx, requestID, input.UserID, idempotent)
}

func (r *OfflineV3Repository) EnrollmentRequestForUser(ctx context.Context, requestID, userID uuid.UUID, idempotent bool) (*domain.OfflineV3EnrollmentRequest, bool, error) {
	item := &domain.OfflineV3EnrollmentRequest{}
	err := r.db.QueryRow(ctx, `SELECT request.id,request.installation_id,request.windows_principal_id,request.browser_profile_id,
		request.authorization_id,request.user_id,COALESCE(NULLIF(account_user.display_name,''),account_user.username),installation.display_name,
		principal.display_name,installation.installation_key_thumbprint,installation.service_key_thumbprint,browser.browser_key_thumbprint,
		installation.client_version,request.state,request.requested_at,request.decided_at,request.decided_by
		FROM offline_v3_enrollment_requests request
		JOIN offline_v3_installations installation ON installation.id=request.installation_id
		JOIN offline_v3_windows_principals principal ON principal.id=request.windows_principal_id AND principal.installation_id=request.installation_id
		JOIN offline_v3_browser_profiles browser ON browser.id=request.browser_profile_id AND browser.windows_principal_id=request.windows_principal_id
		JOIN users account_user ON account_user.id=request.user_id
		WHERE request.id=$1 AND request.user_id=$2`, requestID, userID).Scan(
		&item.ID, &item.InstallationID, &item.WindowsPrincipalID, &item.BrowserProfileID, &item.AuthorizationID, &item.UserID,
		&item.UserDisplayName, &item.DisplayName, &item.PrincipalDisplayName, &item.InstallationKeyThumbprint, &item.ServiceKeyThumbprint,
		&item.BrowserKeyThumbprint, &item.ClientVersion, &item.State, &item.RequestedAt, &item.DecidedAt, &item.DecidedBy)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, false, ErrOfflineV3NotFound
	}
	return item, idempotent, err
}

func (r *OfflineV3Repository) ListEnrollmentRequests(ctx context.Context, limit int) ([]domain.OfflineV3EnrollmentRequest, error) {
	if limit < 1 || limit > 200 {
		limit = 100
	}
	rows, err := r.db.Query(ctx, `SELECT request.id,request.installation_id,request.windows_principal_id,request.browser_profile_id,
		request.authorization_id,request.user_id,COALESCE(NULLIF(account_user.display_name,''),account_user.username),installation.display_name,
		principal.display_name,installation.installation_key_thumbprint,installation.service_key_thumbprint,browser.browser_key_thumbprint,
		installation.client_version,request.state,request.requested_at,request.decided_at,request.decided_by
		FROM offline_v3_enrollment_requests request
		JOIN offline_v3_installations installation ON installation.id=request.installation_id
		JOIN offline_v3_windows_principals principal ON principal.id=request.windows_principal_id AND principal.installation_id=request.installation_id
		JOIN offline_v3_browser_profiles browser ON browser.id=request.browser_profile_id AND browser.windows_principal_id=request.windows_principal_id
		JOIN users account_user ON account_user.id=request.user_id
		ORDER BY (request.state='requested') DESC,request.requested_at DESC,request.id DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.OfflineV3EnrollmentRequest, 0)
	for rows.Next() {
		var item domain.OfflineV3EnrollmentRequest
		if err := rows.Scan(&item.ID, &item.InstallationID, &item.WindowsPrincipalID, &item.BrowserProfileID,
			&item.AuthorizationID, &item.UserID, &item.UserDisplayName, &item.DisplayName, &item.PrincipalDisplayName,
			&item.InstallationKeyThumbprint, &item.ServiceKeyThumbprint, &item.BrowserKeyThumbprint, &item.ClientVersion,
			&item.State, &item.RequestedAt, &item.DecidedAt, &item.DecidedBy); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func offlineV3ModuleForAction(action string) (string, bool) {
	module, ok := domain.OfflineV3ActionModule[action]
	return module, ok
}

func offlineV3ActorHasModuleWith(ctx context.Context, q taskAccessQuerier, userID, accountID uuid.UUID, module string) (bool, error) {
	var allowed bool
	err := q.QueryRow(ctx, `SELECT EXISTS(
		SELECT 1 FROM user_accounts membership
		JOIN users account_user ON account_user.id=membership.user_id
		JOIN accounts account ON account.id=membership.account_id
		LEFT JOIN roles role_item ON role_item.id=membership.role_id
		WHERE membership.user_id=$1 AND membership.account_id=$2 AND account_user.is_active=TRUE
		  AND COALESCE(account.is_active,TRUE)=TRUE
		  AND (account_user.is_super_admin=TRUE OR membership.role IN ('admin','owner','super_admin')
		       OR $3=ANY(COALESCE(role_item.permissions,'{}'::text[]))
		       OR '*'=ANY(COALESCE(role_item.permissions,'{}'::text[]))))`, userID, accountID, module).Scan(&allowed)
	return allowed, err
}

func (r *OfflineV3Repository) ApproveEnrollment(ctx context.Context, requestID, actorID uuid.UUID, approvals []OfflineV3GrantApproval) ([]domain.OfflineV3Grant, error) {
	if len(approvals) == 0 || len(approvals) > domain.OfflineV3MaxAccounts {
		return nil, ErrOfflineV3Invalid
	}
	tx, err := r.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var installationID, principalID, browserID, authorizationID, userID uuid.UUID
	var state string
	if err := tx.QueryRow(ctx, `SELECT installation_id,windows_principal_id,browser_profile_id,authorization_id,user_id,state
		FROM offline_v3_enrollment_requests WHERE id=$1 FOR UPDATE`, requestID).Scan(&installationID, &principalID, &browserID, &authorizationID, &userID, &state); errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrOfflineV3NotFound
	} else if err != nil {
		return nil, err
	}
	if state != "requested" {
		return nil, ErrOfflineV3Conflict
	}
	var installationState, principalState, browserState, authorizationState string
	if err := tx.QueryRow(ctx, `SELECT installation.state,principal.state,browser.state,authz.state
		FROM offline_v3_installations installation
		JOIN offline_v3_windows_principals principal ON principal.id=$2 AND principal.installation_id=installation.id
		JOIN offline_v3_browser_profiles browser ON browser.id=$3 AND browser.installation_id=installation.id AND browser.windows_principal_id=principal.id
		JOIN offline_v3_authorizations authz ON authz.id=$4 AND authz.installation_id=installation.id
		 AND authz.windows_principal_id=principal.id AND authz.browser_profile_id=browser.id AND authz.user_id=$5
		WHERE installation.id=$1 FOR UPDATE OF installation,principal,browser,authz`, installationID, principalID, browserID, authorizationID, userID).
		Scan(&installationState, &principalState, &browserState, &authorizationState); errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrOfflineV3NotFound
	} else if err != nil {
		return nil, err
	}
	if (installationState != "requested" && installationState != "active") ||
		(principalState != "requested" && principalState != "active") ||
		(browserState != "requested" && browserState != "active") || authorizationState != "requested" {
		return nil, ErrOfflineV3AccessDenied
	}
	seenAccounts := make(map[uuid.UUID]struct{}, len(approvals))
	totalQuota := int64(0)
	for _, approval := range approvals {
		if approval.AccountID == uuid.Nil || approval.MaxResources < 1 || approval.MaxResources > domain.OfflineV3MaxResources || approval.QuotaBytes < 1<<20 || len(approval.Actions) == 0 {
			return nil, ErrOfflineV3Invalid
		}
		if _, duplicate := seenAccounts[approval.AccountID]; duplicate {
			return nil, ErrOfflineV3Invalid
		}
		seenAccounts[approval.AccountID] = struct{}{}
		var liveGrantExists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM offline_v3_grants
			WHERE installation_id=$1 AND windows_principal_id=$2 AND browser_profile_id=$3
			  AND user_id=$4 AND account_id=$5 AND state IN ('active','locked'))`, installationID, principalID,
			browserID, userID, approval.AccountID).Scan(&liveGrantExists); err != nil {
			return nil, err
		}
		if liveGrantExists {
			return nil, ErrOfflineV3Conflict
		}
		totalQuota += approval.QuotaBytes
		if totalQuota > 5*1024*1024*1024 {
			return nil, ErrOfflineV3Invalid
		}
		seenActions := map[string]struct{}{}
		for _, action := range approval.Actions {
			module, valid := offlineV3ModuleForAction(action)
			if !valid {
				return nil, ErrOfflineV3Invalid
			}
			if _, duplicate := seenActions[action]; duplicate {
				return nil, ErrOfflineV3Invalid
			}
			seenActions[action] = struct{}{}
			allowed, err := offlineV3ActorHasModuleWith(ctx, tx, userID, approval.AccountID, module)
			if err != nil {
				return nil, fmt.Errorf("offline v3 approve module authority: %w", err)
			}
			if !allowed {
				return nil, ErrOfflineV3AccessDenied
			}
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE offline_v3_installations SET state='active',revision=revision+1,updated_at=NOW() WHERE id=$1 AND state='requested'`, installationID); err != nil {
		return nil, fmt.Errorf("offline v3 approve installation: %w", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE offline_v3_windows_principals SET state='active',revision=revision+1,updated_at=NOW() WHERE id=$1 AND installation_id=$2 AND state='requested'`, principalID, installationID); err != nil {
		return nil, fmt.Errorf("offline v3 approve principal: %w", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE offline_v3_browser_profiles SET state='active',revision=revision+1,updated_at=NOW() WHERE id=$1 AND windows_principal_id=$2 AND state='requested'`, browserID, principalID); err != nil {
		return nil, fmt.Errorf("offline v3 approve browser: %w", err)
	}
	if tag, err := tx.Exec(ctx, `UPDATE offline_v3_authorizations SET state='active',revision=revision+1,updated_at=NOW() WHERE id=$1 AND user_id=$2 AND state='requested'`, authorizationID, userID); err != nil {
		return nil, fmt.Errorf("offline v3 approve authorization: %w", err)
	} else if tag.RowsAffected() != 1 {
		return nil, ErrOfflineV3Conflict
	}
	for _, approval := range approvals {
		var credentialEpoch, userAuthorityEpoch, membershipEpoch int64
		var membershipActive bool
		if err := tx.QueryRow(ctx, `SELECT account_user.offline_credential_epoch,account_user.offline_authority_epoch,
			epoch.authority_epoch,epoch.active FROM users account_user
			JOIN offline_v3_membership_epochs epoch ON epoch.user_id=account_user.id AND epoch.account_id=$2
			WHERE account_user.id=$1 AND account_user.is_active FOR SHARE OF account_user,epoch`, userID, approval.AccountID).
			Scan(&credentialEpoch, &userAuthorityEpoch, &membershipEpoch, &membershipActive); err != nil || !membershipActive {
			if err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return nil, fmt.Errorf("offline v3 approve epochs: %w", err)
			}
			return nil, ErrOfflineV3AccessDenied
		}
		authorityEpoch := userAuthorityEpoch + membershipEpoch
		var grantID uuid.UUID
		if err := tx.QueryRow(ctx, `INSERT INTO offline_v3_grants(authorization_id,installation_id,windows_principal_id,browser_profile_id,user_id,account_id,
			max_resources,quota_bytes,last_authenticated_credential_epoch,last_authenticated_authority_epoch,created_by)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`, authorizationID, installationID, principalID, browserID,
			userID, approval.AccountID, approval.MaxResources, approval.QuotaBytes, credentialEpoch, authorityEpoch, actorID).Scan(&grantID); err != nil {
			return nil, fmt.Errorf("offline v3 approve grant: %w", err)
		}
		for _, action := range approval.Actions {
			if _, err := tx.Exec(ctx, `INSERT INTO offline_v3_grant_actions(grant_id,account_id,action_code) VALUES($1,$2,$3)`, grantID, approval.AccountID, action); err != nil {
				return nil, fmt.Errorf("offline v3 approve action: %w", err)
			}
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE offline_v3_enrollment_requests SET state='approved',decided_at=NOW(),decided_by=$2 WHERE id=$1`, requestID, actorID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO offline_v3_audit(installation_id,authorization_id,actor_id,event_type,metadata)
		VALUES($1,$2,$3,'enrollment_approved',jsonb_build_object('request_id',$4::text,'account_count',$5::int))`, installationID, authorizationID, actorID, requestID, len(approvals)); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return r.ListUserGrants(ctx, userID)
}

func (r *OfflineV3Repository) RejectEnrollment(ctx context.Context, requestID, actorID uuid.UUID, note string) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var installationID, authorizationID uuid.UUID
	err = tx.QueryRow(ctx, `UPDATE offline_v3_enrollment_requests SET state='rejected',decided_at=NOW(),decided_by=$2,decision_note=$3
		WHERE id=$1 AND state='requested' RETURNING installation_id,authorization_id`, requestID, actorID, note).Scan(&installationID, &authorizationID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrOfflineV3Conflict
	}
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE offline_v3_authorizations SET state='revoked',revision=revision+1,revoked_at=NOW(),updated_at=NOW() WHERE id=$1`, authorizationID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO offline_v3_audit(installation_id,authorization_id,actor_id,event_type,metadata)
		VALUES($1,$2,$3,'enrollment_rejected',jsonb_build_object('request_id',$4::text))`, installationID, authorizationID, actorID, requestID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *OfflineV3Repository) ListUserGrants(ctx context.Context, userID uuid.UUID) ([]domain.OfflineV3Grant, error) {
	rows, err := r.db.Query(ctx, `SELECT grant_item.id,grant_item.installation_id,grant_item.windows_principal_id,grant_item.browser_profile_id,
		grant_item.authorization_id,grant_item.user_id,grant_item.account_id,COALESCE(NULLIF(account_user.display_name,''),account_user.username),account.name,grant_item.state,grant_item.max_resources,
		grant_item.quota_bytes,grant_item.max_offline_seconds,account_user.offline_credential_epoch,
		account_user.offline_authority_epoch+epoch.authority_epoch,installation.revision,principal.revision,browser.revision,
		authz.revision,grant_item.revision,grant_item.selection_revision,grant_item.selection_digest,browser.browser_key_thumbprint,
		COALESCE(grant_keys.signing_key_thumbprint,''),COALESCE(grant_keys.encryption_key_thumbprint,''),(grant_keys.id IS NOT NULL),
		grant_item.created_at,grant_item.updated_at,grant_item.last_lease_expires_at,grant_item.last_sync_at,
		COALESCE(array_agg(action.action_code ORDER BY action.action_code) FILTER(WHERE action.action_code IS NOT NULL),'{}'::text[])
		FROM offline_v3_grants grant_item
		JOIN accounts account ON account.id=grant_item.account_id
		JOIN users account_user ON account_user.id=grant_item.user_id
		JOIN offline_v3_membership_epochs epoch ON epoch.user_id=grant_item.user_id AND epoch.account_id=grant_item.account_id
		JOIN offline_v3_installations installation ON installation.id=grant_item.installation_id
		JOIN offline_v3_windows_principals principal ON principal.id=grant_item.windows_principal_id
		JOIN offline_v3_browser_profiles browser ON browser.id=grant_item.browser_profile_id
		JOIN offline_v3_authorizations authz ON authz.id=grant_item.authorization_id
		LEFT JOIN offline_v3_grant_keys grant_keys ON grant_keys.grant_id=grant_item.id AND grant_keys.account_id=grant_item.account_id AND grant_keys.state='active'
		LEFT JOIN offline_v3_grant_actions action ON action.grant_id=grant_item.id AND action.account_id=grant_item.account_id
		WHERE grant_item.user_id=$1
		GROUP BY grant_item.id,account.name,account_user.display_name,account_user.username,account_user.offline_credential_epoch,account_user.offline_authority_epoch,epoch.authority_epoch,
			installation.revision,principal.revision,browser.revision,authz.revision,browser.browser_key_thumbprint,
			grant_keys.id,grant_keys.signing_key_thumbprint,grant_keys.encryption_key_thumbprint
		ORDER BY account.name,grant_item.created_at,grant_item.id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.OfflineV3Grant, 0)
	for rows.Next() {
		var item domain.OfflineV3Grant
		if err := rows.Scan(&item.GrantID, &item.InstallationID, &item.WindowsPrincipalID, &item.BrowserProfileID,
			&item.AuthorizationID, &item.UserID, &item.AccountID, &item.UserDisplayName, &item.AccountName, &item.State, &item.MaxResources,
			&item.QuotaBytes, &item.MaxOfflineSeconds, &item.CredentialEpoch, &item.AuthorityEpoch, &item.InstallationRevision,
			&item.PrincipalRevision, &item.BrowserRevision, &item.AuthorizationRevision, &item.GrantRevision,
			&item.SelectionRevision, &item.SelectionDigest, &item.BrowserKeyThumbprint, &item.GrantSigningThumbprint,
			&item.GrantEncryptionThumbprint, &item.KeysReady, &item.CreatedAt, &item.UpdatedAt, &item.LastLeaseExpiresAt, &item.LastSyncAt, &item.Actions); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (r *OfflineV3Repository) GrantForUser(ctx context.Context, grantID, userID uuid.UUID) (*OfflineV3AuthRecord, error) {
	return r.authRecord(ctx, grantID, &userID)
}

func (r *OfflineV3Repository) AuthRecord(ctx context.Context, grantID uuid.UUID) (*OfflineV3AuthRecord, error) {
	return r.authRecord(ctx, grantID, nil)
}

func (r *OfflineV3Repository) authRecord(ctx context.Context, grantID uuid.UUID, expectedUserID *uuid.UUID) (*OfflineV3AuthRecord, error) {
	item := &OfflineV3AuthRecord{}
	var actions []string
	query := `SELECT grant_item.id,grant_item.installation_id,grant_item.windows_principal_id,grant_item.browser_profile_id,
		grant_item.authorization_id,grant_item.user_id,grant_item.account_id,COALESCE(NULLIF(account_user.display_name,''),account_user.username),account_user.username,account.name,grant_item.state,grant_item.max_resources,
		grant_item.quota_bytes,grant_item.max_offline_seconds,account_user.offline_credential_epoch,
		account_user.offline_authority_epoch+epoch.authority_epoch,grant_item.last_authenticated_credential_epoch,
		grant_item.last_authenticated_authority_epoch,installation.revision,principal.revision,browser.revision,
		authz.revision,grant_item.revision,grant_item.selection_revision,grant_item.selection_digest,browser.browser_key_thumbprint,
		COALESCE(grant_keys.signing_key_thumbprint,''),COALESCE(grant_keys.encryption_key_thumbprint,''),(grant_keys.id IS NOT NULL),
		grant_item.created_at,grant_item.updated_at,grant_item.last_lease_expires_at,grant_item.last_sync_at,
		installation.installation_signing_jwk,installation.service_encryption_jwk,browser.browser_dpop_jwk,
		COALESCE(grant_keys.signing_jwk,'{}'::jsonb),COALESCE(grant_keys.encryption_jwk,'{}'::jsonb),COALESCE(grant_keys.key_version,0),
		account_user.is_active,COALESCE(account.is_active,TRUE),epoch.active,
		installation.state,principal.state,browser.state,authz.state,
		COALESCE(array_agg(action.action_code ORDER BY action.action_code) FILTER(WHERE action.action_code IS NOT NULL),'{}'::text[])
		FROM offline_v3_grants grant_item
		JOIN accounts account ON account.id=grant_item.account_id
		JOIN users account_user ON account_user.id=grant_item.user_id
		JOIN offline_v3_membership_epochs epoch ON epoch.user_id=grant_item.user_id AND epoch.account_id=grant_item.account_id
		JOIN offline_v3_installations installation ON installation.id=grant_item.installation_id
		JOIN offline_v3_windows_principals principal ON principal.id=grant_item.windows_principal_id AND principal.installation_id=grant_item.installation_id
		JOIN offline_v3_browser_profiles browser ON browser.id=grant_item.browser_profile_id AND browser.windows_principal_id=grant_item.windows_principal_id
		JOIN offline_v3_authorizations authz ON authz.id=grant_item.authorization_id AND authz.browser_profile_id=grant_item.browser_profile_id
		LEFT JOIN offline_v3_grant_keys grant_keys ON grant_keys.grant_id=grant_item.id AND grant_keys.account_id=grant_item.account_id AND grant_keys.state='active'
		LEFT JOIN offline_v3_grant_actions action ON action.grant_id=grant_item.id AND action.account_id=grant_item.account_id
		WHERE grant_item.id=$1`
	args := []any{grantID}
	if expectedUserID != nil {
		query += ` AND grant_item.user_id=$2`
		args = append(args, *expectedUserID)
	}
	query += ` GROUP BY grant_item.id,account.name,account_user.display_name,account_user.username,account_user.offline_credential_epoch,account_user.offline_authority_epoch,
		epoch.authority_epoch,epoch.active,installation.revision,principal.revision,browser.revision,authz.revision,
		browser.browser_key_thumbprint,installation.installation_signing_jwk,installation.service_encryption_jwk,browser.browser_dpop_jwk,
		grant_keys.id,grant_keys.signing_key_thumbprint,grant_keys.encryption_key_thumbprint,grant_keys.signing_jwk,grant_keys.encryption_jwk,grant_keys.key_version,
		account_user.is_active,account.is_active,installation.state,principal.state,browser.state,authz.state`
	err := r.db.QueryRow(ctx, query, args...).Scan(&item.GrantID, &item.InstallationID, &item.WindowsPrincipalID, &item.BrowserProfileID,
		&item.AuthorizationID, &item.UserID, &item.AccountID, &item.UserDisplayName, &item.CanonicalLogin, &item.AccountName, &item.State, &item.MaxResources,
		&item.QuotaBytes, &item.MaxOfflineSeconds, &item.CredentialEpoch, &item.AuthorityEpoch,
		&item.LastAuthenticatedCredentialEpoch, &item.LastAuthenticatedAuthorityEpoch, &item.InstallationRevision,
		&item.PrincipalRevision, &item.BrowserRevision, &item.AuthorizationRevision, &item.GrantRevision,
		&item.SelectionRevision, &item.SelectionDigest, &item.BrowserKeyThumbprint, &item.GrantSigningThumbprint,
		&item.GrantEncryptionThumbprint, &item.KeysReady, &item.CreatedAt, &item.UpdatedAt, &item.LastLeaseExpiresAt, &item.LastSyncAt, &item.InstallationSigningJWK,
		&item.ServiceEncryptionJWK, &item.BrowserDPoPJWK, &item.GrantSigningJWK, &item.GrantEncryptionJWK,
		&item.GrantKeyVersion, &item.UserActive, &item.AccountActive, &item.MembershipActive, &item.InstallationState,
		&item.PrincipalState, &item.BrowserState, &item.AuthorizationState, &actions)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrOfflineV3NotFound
	}
	item.Actions = actions
	return item, err
}

// RegisterGrantKeys binds independent per-grant data keys and returns a
// one-time transport capability. Only its SHA-256 digest is persisted. A
// byte-identical retry rotates the capability safely; different keys never
// replace an established grant identity.
func (r *OfflineV3Repository) RegisterGrantKeys(ctx context.Context, grantID, userID uuid.UUID, signingJWK json.RawMessage, signingThumbprint string, encryptionJWK json.RawMessage, encryptionThumbprint string) (string, error) {
	tx, err := r.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	var accountID uuid.UUID
	var state string
	if err := tx.QueryRow(ctx, `SELECT account_id,state FROM offline_v3_grants WHERE id=$1 AND user_id=$2 FOR UPDATE`, grantID, userID).Scan(&accountID, &state); errors.Is(err, pgx.ErrNoRows) {
		return "", ErrOfflineV3NotFound
	} else if err != nil {
		return "", err
	}
	if state != "active" {
		return "", ErrOfflineV3AccessDenied
	}
	var existingSigning, existingEncryption json.RawMessage
	var existingSigningThumbprint, existingEncryptionThumbprint string
	err = tx.QueryRow(ctx, `SELECT signing_jwk,signing_key_thumbprint,encryption_jwk,encryption_key_thumbprint
		FROM offline_v3_grant_keys WHERE grant_id=$1 AND account_id=$2 AND state='active' FOR UPDATE`, grantID, accountID).
		Scan(&existingSigning, &existingSigningThumbprint, &existingEncryption, &existingEncryptionThumbprint)
	newKeys := errors.Is(err, pgx.ErrNoRows)
	if err != nil && !newKeys {
		return "", err
	}
	if !newKeys && (!offlineV3SameJSON(existingSigning, signingJWK) || !offlineV3SameJSON(existingEncryption, encryptionJWK) ||
		existingSigningThumbprint != signingThumbprint || existingEncryptionThumbprint != encryptionThumbprint) {
		return "", ErrOfflineV3KeyExists
	}
	if newKeys {
		if _, err := tx.Exec(ctx, `INSERT INTO offline_v3_grant_keys(grant_id,account_id,signing_jwk,signing_key_thumbprint,encryption_jwk,encryption_key_thumbprint)
			VALUES($1,$2,$3,$4,$5,$6)`, grantID, accountID, signingJWK, signingThumbprint, encryptionJWK, encryptionThumbprint); err != nil {
			return "", err
		}
		if _, err := tx.Exec(ctx, `UPDATE offline_v3_grants SET revision=revision+1,updated_at=NOW() WHERE id=$1`, grantID); err != nil {
			return "", err
		}
	}
	rawCapability := make([]byte, 32)
	if _, err := cryptorand.Read(rawCapability); err != nil {
		return "", err
	}
	capability := "ov3_" + base64.RawURLEncoding.EncodeToString(rawCapability)
	capabilityHash := sha256.Sum256([]byte(capability))
	if _, err := tx.Exec(ctx, `INSERT INTO offline_v3_transport_credentials(grant_id,account_id,secret_hash)
		VALUES($1,$2,$3) ON CONFLICT(grant_id) DO UPDATE SET secret_hash=EXCLUDED.secret_hash,state='active',
		revision=offline_v3_transport_credentials.revision+1,rotated_at=NOW(),revoked_at=NULL`, grantID, accountID, capabilityHash[:]); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO offline_v3_audit(installation_id,authorization_id,grant_id,account_id,actor_id,event_type)
		SELECT installation_id,authorization_id,id,account_id,$2,'grant_keys_registered' FROM offline_v3_grants WHERE id=$1`, grantID, userID); err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return capability, nil
}

func (r *OfflineV3Repository) AuthenticateTransport(ctx context.Context, grantID uuid.UUID, capability string) (*OfflineV3AuthRecord, error) {
	if grantID == uuid.Nil || len(capability) != 47 || !strings.HasPrefix(capability, "ov3_") {
		return nil, ErrOfflineV3AccessDenied
	}
	want := sha256.Sum256([]byte(capability))
	var stored []byte
	if err := r.db.QueryRow(ctx, `SELECT secret_hash FROM offline_v3_transport_credentials
		WHERE grant_id=$1 AND state='active'`, grantID).Scan(&stored); errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrOfflineV3AccessDenied
	} else if err != nil {
		return nil, err
	}
	if len(stored) != sha256.Size || subtle.ConstantTimeCompare(stored, want[:]) != 1 {
		return nil, ErrOfflineV3AccessDenied
	}
	record, err := r.AuthRecord(ctx, grantID)
	if err != nil {
		return nil, err
	}
	tag, err := r.db.Exec(ctx, `UPDATE offline_v3_transport_credentials SET last_used_at=NOW()
		WHERE grant_id=$1 AND state='active' AND secret_hash=$2`, grantID, want[:])
	if err != nil {
		return nil, err
	}
	// A concurrent recovery rotates the one-time-delivered capability. Do not
	// let a request that read the old digest before that rotation proceed.
	if tag.RowsAffected() != 1 {
		return nil, ErrOfflineV3AccessDenied
	}
	return record, nil
}

func (r *OfflineV3Repository) MarkLeaseAuthenticated(ctx context.Context, grantID, userID uuid.UUID) error {
	return r.MarkGrantAuthenticated(ctx, grantID, userID, true)
}

func (r *OfflineV3Repository) MarkGrantAuthenticated(ctx context.Context, grantID, userID uuid.UUID, requireKeys bool) error {
	var valid bool
	err := r.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1
		FROM users account_user,offline_v3_membership_epochs epoch,accounts account,
			offline_v3_grants grant_item,offline_v3_installations installation,offline_v3_windows_principals principal,
			offline_v3_browser_profiles browser,offline_v3_authorizations authz
		WHERE grant_item.id=$1 AND grant_item.user_id=$2 AND grant_item.state='active'
		  AND account_user.id=grant_item.user_id AND account_user.is_active
		  AND epoch.user_id=grant_item.user_id AND epoch.account_id=grant_item.account_id AND epoch.active
		  AND grant_item.last_authenticated_credential_epoch=account_user.offline_credential_epoch
		  AND grant_item.last_authenticated_authority_epoch=account_user.offline_authority_epoch+epoch.authority_epoch
		  AND account.id=grant_item.account_id AND COALESCE(account.is_active,TRUE)
		  AND installation.id=grant_item.installation_id AND installation.state='active'
		  AND principal.id=grant_item.windows_principal_id AND principal.state='active'
		  AND browser.id=grant_item.browser_profile_id AND browser.state='active'
		  AND authz.id=grant_item.authorization_id AND authz.state='active'
		  AND (NOT $3::boolean OR EXISTS(SELECT 1 FROM offline_v3_grant_keys grant_key WHERE grant_key.grant_id=grant_item.id AND grant_key.state='active')))`, grantID, userID, requireKeys).Scan(&valid)
	if err != nil {
		return err
	}
	if !valid {
		return ErrOfflineV3AccessDenied
	}
	return nil
}

func (r *OfflineV3Repository) EnrollmentRequestIDForGrant(ctx context.Context, grantID, userID uuid.UUID) (uuid.UUID, error) {
	var requestID uuid.UUID
	err := r.db.QueryRow(ctx, `SELECT request.id FROM offline_v3_grants grant_item
		JOIN offline_v3_enrollment_requests request ON request.authorization_id=grant_item.authorization_id AND request.user_id=grant_item.user_id
		WHERE grant_item.id=$1 AND grant_item.user_id=$2 AND request.state='approved'`, grantID, userID).Scan(&requestID)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, ErrOfflineV3NotFound
	}
	return requestID, err
}

func (r *OfflineV3Repository) HasStoredAction(ctx context.Context, grantID, accountID uuid.UUID, action string) (bool, error) {
	var allowed bool
	err := r.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM offline_v3_grant_actions WHERE grant_id=$1 AND account_id=$2 AND action_code=$3)`, grantID, accountID, action).Scan(&allowed)
	return allowed, err
}

func offlineV3SelectionDigest(items []domain.OfflineV3Selection) string {
	parts := make([]string, 0, len(items))
	for _, item := range items {
		parts = append(parts, item.Module+"\x00"+item.ResourceType+"\x00"+item.ResourceID.String())
	}
	sort.Strings(parts)
	digest := sha256.Sum256([]byte(strings.Join(parts, "\n")))
	return hex.EncodeToString(digest[:])
}

type OfflineV3SelectionReplacementPlan struct {
	InstallationID      uuid.UUID
	AccountID           uuid.UUID
	CurrentRevision     int64
	RemovedSelectionIDs []uuid.UUID
}

// PlanSelectionReplacement reveals only opaque selection IDs. The signed wipe
// directives produced from this plan are revalidated against the exact set and
// revision by ReplaceSelections, so a concurrent replacement fails closed.
func (r *OfflineV3Repository) PlanSelectionReplacement(ctx context.Context, grantID, userID uuid.UUID, expectedRevision int64, selections []domain.OfflineV3Selection) (*OfflineV3SelectionReplacementPlan, error) {
	var plan OfflineV3SelectionReplacementPlan
	if err := r.db.QueryRow(ctx, `SELECT installation_id,account_id,selection_revision FROM offline_v3_grants
		WHERE id=$1 AND user_id=$2 AND state='active'`, grantID, userID).Scan(&plan.InstallationID, &plan.AccountID, &plan.CurrentRevision); errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrOfflineV3NotFound
	} else if err != nil {
		return nil, err
	}
	if expectedRevision != plan.CurrentRevision {
		return &plan, ErrOfflineV3Conflict
	}
	requested := make(map[string]struct{}, len(selections))
	for _, item := range selections {
		requested[item.Module+":"+item.ResourceType+":"+item.ResourceID.String()] = struct{}{}
	}
	rows, err := r.db.Query(ctx, `SELECT id,module,resource_type,resource_id FROM offline_v3_selections
		WHERE grant_id=$1 AND account_id=$2 ORDER BY id`, grantID, plan.AccountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, resourceID uuid.UUID
		var module, resourceType string
		if err := rows.Scan(&id, &module, &resourceType, &resourceID); err != nil {
			return nil, err
		}
		if _, keep := requested[module+":"+resourceType+":"+resourceID.String()]; !keep {
			plan.RemovedSelectionIDs = append(plan.RemovedSelectionIDs, id)
		}
	}
	return &plan, rows.Err()
}

func (r *OfflineV3Repository) ReplaceSelections(ctx context.Context, grantID, userID uuid.UUID, expectedRevision int64, selections []domain.OfflineV3Selection, removalControls []domain.OfflineV3Control) (int64, string, error) {
	if expectedRevision < 1 || len(selections) > domain.OfflineV3MaxResources {
		return 0, "", ErrOfflineV3Invalid
	}
	tx, err := r.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return 0, "", err
	}
	defer tx.Rollback(ctx)
	record, err := r.lockActiveGrantAuthorityTx(ctx, tx, grantID)
	if err != nil {
		return 0, "", err
	}
	if record.UserID != userID {
		return 0, "", ErrOfflineV3NotFound
	}
	accountID, installationID := record.AccountID, record.InstallationID
	maxResources, currentRevision := record.MaxResources, record.SelectionRevision
	if currentRevision != expectedRevision {
		return currentRevision, "", ErrOfflineV3Conflict
	}
	if len(selections) > maxResources {
		return 0, "", ErrOfflineV3Invalid
	}
	seen := make(map[string]struct{}, len(selections))
	for _, item := range selections {
		expectedModule, ok := domain.OfflineModuleForResourceType(item.ResourceType)
		if !ok || expectedModule != item.Module || item.ResourceID == uuid.Nil {
			return 0, "", ErrOfflineV3Invalid
		}
		action := item.Module + ".read"
		if item.Module == domain.OfflineModuleWhiteboards {
			action = domain.OfflineV3ActionWhiteboardsRead
		}
		var stored bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM offline_v3_grant_actions WHERE grant_id=$1 AND account_id=$2 AND action_code=$3)`, grantID, accountID, action).Scan(&stored); err != nil {
			return 0, "", err
		}
		if !stored {
			return 0, "", ErrOfflineV3AccessDenied
		}
		key := item.Module + ":" + item.ResourceType + ":" + item.ResourceID.String()
		if _, duplicate := seen[key]; duplicate {
			return 0, "", ErrOfflineV3Invalid
		}
		seen[key] = struct{}{}
		if err := validateOfflineV3ResourceAccess(ctx, tx, userID, accountID, item, domain.TaskAccessView); err != nil {
			return 0, "", err
		}
	}
	digest := offlineV3SelectionDigest(selections)
	type existingSelection struct {
		id                   uuid.UUID
		module, resourceType string
		resourceID           uuid.UUID
	}
	existingRows, err := tx.Query(ctx, `SELECT id,module,resource_type,resource_id FROM offline_v3_selections
		WHERE grant_id=$1 AND account_id=$2 ORDER BY id FOR UPDATE`, grantID, accountID)
	if err != nil {
		return 0, "", err
	}
	existing := make(map[string]existingSelection)
	for existingRows.Next() {
		var item existingSelection
		if err := existingRows.Scan(&item.id, &item.module, &item.resourceType, &item.resourceID); err != nil {
			existingRows.Close()
			return 0, "", err
		}
		existing[item.module+":"+item.resourceType+":"+item.resourceID.String()] = item
	}
	if err := existingRows.Err(); err != nil {
		existingRows.Close()
		return 0, "", err
	}
	existingRows.Close()
	removed := make([]uuid.UUID, 0)
	for key, item := range existing {
		if _, keep := seen[key]; !keep {
			removed = append(removed, item.id)
		}
	}
	sort.Slice(removed, func(i, j int) bool { return removed[i].String() < removed[j].String() })
	controlsBySelection := make(map[uuid.UUID]domain.OfflineV3Control, len(removalControls))
	for _, control := range removalControls {
		if control.ID == uuid.Nil || control.InstallationID != installationID || control.GrantID == nil || *control.GrantID != grantID ||
			control.AccountID == nil || *control.AccountID != accountID || control.Scope != "selection" || control.ScopeID == uuid.Nil ||
			control.Revision != currentRevision+1 || control.Action != "wipe" || control.Reason != "selection_removed" ||
			strings.TrimSpace(control.Token) == "" || strings.TrimSpace(control.KeyID) == "" || control.KeyVersion < 3 {
			return 0, "", ErrOfflineV3Invalid
		}
		if _, duplicate := controlsBySelection[control.ScopeID]; duplicate {
			return 0, "", ErrOfflineV3Invalid
		}
		controlsBySelection[control.ScopeID] = control
	}
	if len(controlsBySelection) != len(removed) {
		return 0, "", ErrOfflineV3Invalid
	}
	for _, selectionID := range removed {
		control, ok := controlsBySelection[selectionID]
		if !ok {
			return 0, "", ErrOfflineV3Invalid
		}
		if _, err := tx.Exec(ctx, `INSERT INTO offline_v3_controls(id,installation_id,grant_id,account_id,scope,scope_id,revision,action,reason,token,key_id,key_version,created_by)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, control.ID, installationID, grantID, accountID,
			control.Scope, control.ScopeID, control.Revision, control.Action, control.Reason, control.Token, control.KeyID, control.KeyVersion, userID); err != nil {
			return 0, "", err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM offline_v3_selections WHERE id=$1 AND grant_id=$2 AND account_id=$3`, selectionID, grantID, accountID); err != nil {
			return 0, "", err
		}
	}
	for _, item := range selections {
		key := item.Module + ":" + item.ResourceType + ":" + item.ResourceID.String()
		if _, retained := existing[key]; retained {
			continue
		}
		var selectionID uuid.UUID
		if err := tx.QueryRow(ctx, `INSERT INTO offline_v3_selections(grant_id,account_id,module,resource_type,resource_id)
			VALUES($1,$2,$3,$4,$5) RETURNING id`, grantID, accountID, item.Module, item.ResourceType, item.ResourceID).Scan(&selectionID); err != nil {
			return 0, "", err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO offline_v3_resource_heads(selection_id,grant_id,account_id) VALUES($1,$2,$3)`, selectionID, grantID, accountID); err != nil {
			return 0, "", err
		}
	}
	changed := len(removed) > 0 || len(existing) != len(selections)
	if !changed {
		if err := tx.Commit(ctx); err != nil {
			return 0, "", err
		}
		return currentRevision, digest, nil
	}
	var revision int64
	if err := tx.QueryRow(ctx, `UPDATE offline_v3_grants SET selection_revision=selection_revision+1,selection_digest=$2,revision=revision+1,updated_at=NOW()
		WHERE id=$1 RETURNING selection_revision`, grantID, digest).Scan(&revision); err != nil {
		return 0, "", err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO offline_v3_audit(installation_id,authorization_id,grant_id,account_id,actor_id,event_type,metadata)
		SELECT installation_id,authorization_id,id,account_id,$2,'selection_replaced',jsonb_build_object('count',$3::int,'revision',$4::bigint)
		FROM offline_v3_grants WHERE id=$1`, grantID, userID, len(selections), revision); err != nil {
		return 0, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, "", err
	}
	return revision, digest, nil
}

func (r *OfflineV3Repository) ListSelections(ctx context.Context, grantID, userID uuid.UUID) ([]domain.OfflineV3Selection, int64, string, error) {
	tx, err := r.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return nil, 0, "", err
	}
	defer tx.Rollback(ctx)
	record, err := r.lockActiveGrantAuthorityTx(ctx, tx, grantID)
	if err != nil {
		return nil, 0, "", err
	}
	if record.UserID != userID {
		return nil, 0, "", ErrOfflineV3NotFound
	}
	accountID, revision, digest := record.AccountID, record.SelectionRevision, record.SelectionDigest
	bareRows, err := tx.Query(ctx, `SELECT id,grant_id,account_id,module,resource_type,resource_id FROM offline_v3_selections
		WHERE grant_id=$1 AND account_id=$2 ORDER BY module,resource_id FOR SHARE`, grantID, accountID)
	if err != nil {
		return nil, 0, "", err
	}
	bare := make([]domain.OfflineV3Selection, 0)
	for bareRows.Next() {
		var item domain.OfflineV3Selection
		if err := bareRows.Scan(&item.ID, &item.GrantID, &item.AccountID, &item.Module, &item.ResourceType, &item.ResourceID); err != nil {
			bareRows.Close()
			return nil, 0, "", err
		}
		bare = append(bare, item)
	}
	if err := bareRows.Err(); err != nil {
		bareRows.Close()
		return nil, 0, "", err
	}
	bareRows.Close()
	for _, item := range bare {
		action, valid := offlineV3ReadAction(item.Module)
		if !valid {
			return nil, 0, "", ErrOfflineV3Invalid
		}
		var actionAllowed bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM offline_v3_grant_actions
			WHERE grant_id=$1 AND account_id=$2 AND action_code=$3)`, grantID, accountID, action).Scan(&actionAllowed); err != nil {
			return nil, 0, "", err
		}
		if !actionAllowed {
			return nil, 0, "", ErrOfflineV3AccessDenied
		}
		if err := validateOfflineV3ResourceAccess(ctx, tx, userID, accountID, item, domain.TaskAccessView); err != nil {
			return nil, 0, "", ErrOfflineV3AccessDenied
		}
	}
	rows, err := tx.Query(ctx, `SELECT selection.id,selection.grant_id,selection.account_id,selection.module,selection.resource_type,selection.resource_id,
		CASE selection.resource_type
		 WHEN 'task_list' THEN COALESCE((SELECT name FROM task_lists WHERE account_id=selection.account_id AND id=selection.resource_id),'No disponible')
		 WHEN 'contact' THEN COALESCE((SELECT COALESCE(NULLIF(BTRIM(custom_name),''),NULLIF(BTRIM(name),''),phone,'Contacto') FROM contacts WHERE account_id=selection.account_id AND id=selection.resource_id),'No disponible')
		 WHEN 'program' THEN COALESCE((SELECT name FROM programs WHERE account_id=selection.account_id AND id=selection.resource_id),'No disponible')
		 WHEN 'whiteboard' THEN COALESCE((SELECT name FROM whiteboards WHERE account_id=selection.account_id AND id=selection.resource_id),'No disponible') END,
		head.head_version,COALESCE(head.content_hash,''),selection.updated_at
		FROM offline_v3_selections selection
		JOIN offline_v3_resource_heads head ON head.selection_id=selection.id AND head.grant_id=selection.grant_id AND head.account_id=selection.account_id
		JOIN offline_v3_grants grant_item ON grant_item.id=selection.grant_id AND grant_item.account_id=selection.account_id
		WHERE selection.grant_id=$1 AND grant_item.user_id=$2 ORDER BY selection.module,selection.resource_id`, grantID, userID)
	if err != nil {
		return nil, 0, "", err
	}
	defer rows.Close()
	out := make([]domain.OfflineV3Selection, 0)
	for rows.Next() {
		var item domain.OfflineV3Selection
		if err := rows.Scan(&item.ID, &item.GrantID, &item.AccountID, &item.Module, &item.ResourceType, &item.ResourceID,
			&item.Label, &item.HeadVersion, &item.ContentHash, &item.UpdatedAt); err != nil {
			return nil, 0, "", err
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, 0, "", err
	}
	return out, revision, digest, nil
}

func validateOfflineV3ResourceAccess(ctx context.Context, tx pgx.Tx, userID, accountID uuid.UUID, item domain.OfflineV3Selection, requiredTaskAccess string) error {
	allowed, err := offlineV3ActorHasModuleWith(ctx, tx, userID, accountID, item.Module)
	if err != nil {
		return err
	}
	if !allowed {
		return ErrOfflineV3AccessDenied
	}
	switch item.ResourceType {
	case domain.OfflineResourceTaskList:
		access, _, err := resolveContainerAccessWith(ctx, tx, accountID, userID, item.ResourceID, domain.TaskAccessTargetList)
		if err != nil || !TaskAccessAllows(access, requiredTaskAccess) {
			if err != nil && !errors.Is(err, ErrTaskWorkNotFound) {
				return err
			}
			return ErrOfflineV3AccessDenied
		}
		return nil
	case domain.OfflineResourceWhiteboard:
		// Offline snapshots only include active boards. The ordinary history
		// resolver deliberately permits archive reads, so it is not sufficient
		// for preparing or renewing an offline selection (including Work views).
		access, err := resolveActiveWhiteboardAccessWith(ctx, tx, accountID, userID, item.ResourceID)
		if errors.Is(err, ErrWhiteboardNotFound) || errors.Is(err, ErrWhiteboardForbidden) {
			return ErrOfflineV3AccessDenied
		}
		if err != nil {
			return err
		}
		if !WhiteboardAccessAllows(access, domain.WhiteboardAccessView) {
			return ErrOfflineV3AccessDenied
		}
		return nil
	case domain.OfflineResourceContact:
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM contacts WHERE account_id=$1 AND id=$2 AND is_group=FALSE)`, accountID, item.ResourceID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return ErrOfflineV3AccessDenied
		}
		return nil
	case domain.OfflineResourceProgram:
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM programs WHERE account_id=$1 AND id=$2 AND COALESCE(type,'course')='course')`, accountID, item.ResourceID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return ErrOfflineV3AccessDenied
		}
		return nil
	default:
		return ErrOfflineV3Invalid
	}
}

func (r *OfflineV3Repository) EffectiveActions(ctx context.Context, record *OfflineV3AuthRecord) ([]string, error) {
	if record == nil || record.GrantID == uuid.Nil {
		return nil, ErrOfflineV3Invalid
	}
	effective := make([]string, 0, len(record.Actions))
	for _, action := range record.Actions {
		module, ok := offlineV3ModuleForAction(action)
		if !ok {
			continue
		}
		allowed, err := offlineV3ActorHasModuleWith(ctx, r.db, record.UserID, record.AccountID, module)
		if err != nil {
			return nil, err
		}
		if allowed {
			effective = append(effective, action)
		}
	}
	sort.Strings(effective)
	return effective, nil
}

// ServiceDescriptorMaterial is read only through the authenticated user/request
// binding. The signing service, not the browser, supplies the trusted origin.
func (r *OfflineV3Repository) ServiceDescriptorMaterial(ctx context.Context, requestID, userID uuid.UUID) (*OfflineV3ServiceDescriptor, error) {
	item := &OfflineV3ServiceDescriptor{}
	err := r.db.QueryRow(ctx, `SELECT request.installation_id,request.windows_principal_id,request.browser_profile_id,
		installation.installation_signing_jwk,installation.service_encryption_jwk
		FROM offline_v3_enrollment_requests request
		JOIN offline_v3_installations installation ON installation.id=request.installation_id
		WHERE request.id=$1 AND request.user_id=$2 AND request.state='approved'`, requestID, userID).
		Scan(&item.InstallationID, &item.WindowsPrincipalID, &item.BrowserProfileID, &item.ServiceSigningJWK, &item.ServiceEncryptionJWK)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrOfflineV3NotFound
	}
	return item, err
}

func (r *OfflineV3Repository) SaveServiceDescriptor(ctx context.Context, userID uuid.UUID, item OfflineV3ServiceDescriptor) error {
	if userID == uuid.Nil || item.InstallationID == uuid.Nil || item.WindowsPrincipalID == uuid.Nil || item.BrowserProfileID == uuid.Nil ||
		strings.TrimSpace(item.Token) == "" || strings.TrimSpace(item.KeyID) == "" || item.KeyVersion < 3 || item.ExpiresAt.Before(time.Now()) {
		return ErrOfflineV3Invalid
	}
	tag, err := r.db.Exec(ctx, `INSERT INTO offline_v3_service_descriptors(browser_profile_id,installation_id,windows_principal_id,token,key_id,key_version,expires_at)
		SELECT browser.id,browser.installation_id,browser.windows_principal_id,$5,$6,$7,$8
		FROM offline_v3_browser_profiles browser
		JOIN offline_v3_authorizations authz ON authz.browser_profile_id=browser.id
		WHERE browser.id=$1 AND browser.installation_id=$2 AND browser.windows_principal_id=$3 AND authz.user_id=$4
		ON CONFLICT(browser_profile_id) DO UPDATE SET token=EXCLUDED.token,key_id=EXCLUDED.key_id,key_version=EXCLUDED.key_version,
			expires_at=EXCLUDED.expires_at,updated_at=NOW()
		WHERE offline_v3_service_descriptors.installation_id=EXCLUDED.installation_id
		  AND offline_v3_service_descriptors.windows_principal_id=EXCLUDED.windows_principal_id`, item.BrowserProfileID,
		item.InstallationID, item.WindowsPrincipalID, userID, item.Token, item.KeyID, item.KeyVersion, item.ExpiresAt)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrOfflineV3AccessDenied
	}
	return nil
}

func (r *OfflineV3Repository) ServiceDescriptorForUser(ctx context.Context, browserProfileID, userID uuid.UUID) (*OfflineV3ServiceDescriptor, error) {
	item := &OfflineV3ServiceDescriptor{BrowserProfileID: browserProfileID}
	err := r.db.QueryRow(ctx, `SELECT descriptor.installation_id,descriptor.windows_principal_id,descriptor.token,
		descriptor.key_id,descriptor.key_version,descriptor.expires_at
		FROM offline_v3_service_descriptors descriptor
		WHERE descriptor.browser_profile_id=$1 AND EXISTS(SELECT 1 FROM offline_v3_authorizations authz
		 WHERE authz.browser_profile_id=descriptor.browser_profile_id AND authz.user_id=$2 AND authz.state='active')`, browserProfileID, userID).
		Scan(&item.InstallationID, &item.WindowsPrincipalID, &item.Token, &item.KeyID, &item.KeyVersion, &item.ExpiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrOfflineV3NotFound
	}
	return item, err
}

// ConfirmLeaseIssued closes the signer race: a token is returned only if the
// full tuple, epochs, keys, selection, and revisions are still current after
// signing. A concurrent revoke/password/authority change makes this fail.
func (r *OfflineV3Repository) ConfirmLeaseIssued(ctx context.Context, expected *OfflineV3AuthRecord, requiredAction string, issuedAt, expiresAt time.Time) error {
	if expected == nil || expiresAt.After(issuedAt.Add(domain.OfflineV3MaxLeaseSeconds*time.Second)) {
		return ErrOfflineV3Invalid
	}
	tx, err := r.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	current, err := r.LockActiveGrantTx(ctx, tx, expected.GrantID, requiredAction)
	if err != nil {
		return err
	}
	if current.OfflineV3Tuple != expected.OfflineV3Tuple || current.CredentialEpoch != expected.CredentialEpoch ||
		current.AuthorityEpoch != expected.AuthorityEpoch || current.InstallationRevision != expected.InstallationRevision ||
		current.PrincipalRevision != expected.PrincipalRevision || current.BrowserRevision != expected.BrowserRevision ||
		current.AuthorizationRevision != expected.AuthorizationRevision || current.GrantRevision != expected.GrantRevision ||
		current.SelectionRevision != expected.SelectionRevision || current.SelectionDigest != expected.SelectionDigest ||
		current.BrowserKeyThumbprint != expected.BrowserKeyThumbprint || current.GrantSigningThumbprint != expected.GrantSigningThumbprint ||
		current.GrantEncryptionThumbprint != expected.GrantEncryptionThumbprint {
		return ErrOfflineV3AccessDenied
	}
	if _, err := tx.Exec(ctx, `UPDATE offline_v3_grants SET last_lease_issued_at=$2,last_lease_expires_at=$3,updated_at=NOW()
		WHERE id=$1`, expected.GrantID, issuedAt, expiresAt); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *OfflineV3Repository) MarkSyncComplete(ctx context.Context, expected *OfflineV3AuthRecord) error {
	if expected == nil {
		return ErrOfflineV3Invalid
	}
	tx, err := r.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	current, err := r.lockActiveGrantAuthorityTx(ctx, tx, expected.GrantID)
	if err != nil {
		return err
	}
	if current.OfflineV3Tuple != expected.OfflineV3Tuple || current.CredentialEpoch != expected.CredentialEpoch ||
		current.AuthorityEpoch != expected.AuthorityEpoch || current.InstallationRevision != expected.InstallationRevision ||
		current.PrincipalRevision != expected.PrincipalRevision || current.BrowserRevision != expected.BrowserRevision ||
		current.AuthorizationRevision != expected.AuthorizationRevision || current.GrantRevision != expected.GrantRevision ||
		current.SelectionRevision != expected.SelectionRevision || current.SelectionDigest != expected.SelectionDigest ||
		current.BrowserKeyThumbprint != expected.BrowserKeyThumbprint || current.GrantSigningThumbprint != expected.GrantSigningThumbprint ||
		current.GrantEncryptionThumbprint != expected.GrantEncryptionThumbprint {
		return ErrOfflineV3AccessDenied
	}
	if _, err := tx.Exec(ctx, `UPDATE offline_v3_grants SET last_sync_at=NOW(),updated_at=NOW()
		WHERE id=$1 AND account_id=$2`, expected.GrantID, expected.AccountID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *OfflineV3Repository) PendingControls(ctx context.Context, record *OfflineV3AuthRecord) ([]domain.OfflineV3Control, error) {
	if record == nil {
		return nil, ErrOfflineV3Invalid
	}
	rows, err := r.db.Query(ctx, `SELECT control.id,control.installation_id,control.grant_id,control.account_id,control.scope,
		control.scope_id,control.revision,control.action,control.reason,control.token,control.key_id,control.key_version,
		control.created_at,control.acknowledged_at
		FROM offline_v3_controls control
		WHERE control.installation_id=$1 AND control.acknowledged_at IS NULL AND (
			(control.scope='installation' AND control.scope_id=$1) OR
			(control.scope='windows_principal' AND control.scope_id=$2) OR
			(control.scope='browser_profile' AND control.scope_id=$3) OR
			(control.scope='authorization' AND control.scope_id=$4) OR
			(control.scope='grant' AND control.scope_id=$5) OR
			(control.scope='selection' AND control.grant_id=$5 AND control.account_id=$6))
		ORDER BY control.created_at,control.id LIMIT 100`, record.InstallationID, record.WindowsPrincipalID, record.BrowserProfileID,
		record.AuthorizationID, record.GrantID, record.AccountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.OfflineV3Control, 0)
	for rows.Next() {
		var item domain.OfflineV3Control
		if err := rows.Scan(&item.ID, &item.InstallationID, &item.GrantID, &item.AccountID, &item.Scope, &item.ScopeID,
			&item.Revision, &item.Action, &item.Reason, &item.Token, &item.KeyID, &item.KeyVersion, &item.CreatedAt,
			&item.AcknowledgedAt); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (r *OfflineV3Repository) AcknowledgeControls(ctx context.Context, record *OfflineV3AuthRecord, ids []uuid.UUID) error {
	if record == nil || len(ids) > 100 {
		return ErrOfflineV3Invalid
	}
	seen := make(map[uuid.UUID]struct{}, len(ids))
	for _, id := range ids {
		if id == uuid.Nil {
			return ErrOfflineV3Invalid
		}
		if _, duplicate := seen[id]; duplicate {
			return ErrOfflineV3Invalid
		}
		seen[id] = struct{}{}
	}
	if len(ids) == 0 {
		return nil
	}
	tx, err := r.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	_, err = tx.Exec(ctx, `UPDATE offline_v3_controls control SET acknowledged_at=NOW(),acknowledgement=jsonb_build_object('transport','v3')
		WHERE control.id=ANY($1::uuid[]) AND control.acknowledged_at IS NULL AND control.installation_id=$2 AND (
			(control.scope='installation' AND control.scope_id=$2) OR
			(control.scope='windows_principal' AND control.scope_id=$3) OR
			(control.scope='browser_profile' AND control.scope_id=$4) OR
			(control.scope='authorization' AND control.scope_id=$5) OR
			(control.scope='grant' AND control.scope_id=$6) OR
			(control.scope='selection' AND control.grant_id=$6 AND control.account_id=$7))`, ids, record.InstallationID,
		record.WindowsPrincipalID, record.BrowserProfileID, record.AuthorizationID, record.GrantID, record.AccountID)
	if err != nil {
		return err
	}
	var matched int
	if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM offline_v3_controls control
		WHERE control.id=ANY($1::uuid[]) AND control.installation_id=$2 AND (
			(control.scope='installation' AND control.scope_id=$2) OR
			(control.scope='windows_principal' AND control.scope_id=$3) OR
			(control.scope='browser_profile' AND control.scope_id=$4) OR
			(control.scope='authorization' AND control.scope_id=$5) OR
			(control.scope='grant' AND control.scope_id=$6) OR
			(control.scope='selection' AND control.grant_id=$6 AND control.account_id=$7))`, ids, record.InstallationID,
		record.WindowsPrincipalID, record.BrowserProfileID, record.AuthorizationID, record.GrantID, record.AccountID).Scan(&matched); err != nil {
		return err
	}
	if matched != len(ids) {
		return ErrOfflineV3AccessDenied
	}
	return tx.Commit(ctx)
}

// StoreControl persists a signed control without replacing an earlier token
// for the same monotonic scope revision. It returns the durable row so callers
// acknowledge exactly the JTI that can later be matched by the backend.
func (r *OfflineV3Repository) StoreControl(ctx context.Context, input domain.OfflineV3Control, actorID *uuid.UUID) (domain.OfflineV3Control, error) {
	if input.ID == uuid.Nil || input.InstallationID == uuid.Nil || input.ScopeID == uuid.Nil || input.Revision < 1 ||
		(input.Action != "lock" && input.Action != "wipe") || strings.TrimSpace(input.Token) == "" ||
		strings.TrimSpace(input.KeyID) == "" || input.KeyVersion < domain.OfflineV3ProtocolVersion {
		return domain.OfflineV3Control{}, ErrOfflineV3Invalid
	}
	if input.Scope != "installation" && input.Scope != "windows_principal" && input.Scope != "browser_profile" &&
		input.Scope != "authorization" && input.Scope != "grant" && input.Scope != "selection" {
		return domain.OfflineV3Control{}, ErrOfflineV3Invalid
	}
	if input.Reason != "admin_revoked" && input.Reason != "credential_changed" && input.Reason != "authority_changed" &&
		input.Reason != "account_disabled" && input.Reason != "user_disabled" && input.Reason != "selection_removed" && input.Reason != "security_lock" {
		return domain.OfflineV3Control{}, ErrOfflineV3Invalid
	}
	if (input.GrantID == nil) != (input.AccountID == nil) {
		return domain.OfflineV3Control{}, ErrOfflineV3Invalid
	}
	if input.Scope == "grant" {
		if input.GrantID == nil || input.AccountID == nil || *input.GrantID != input.ScopeID {
			return domain.OfflineV3Control{}, ErrOfflineV3Invalid
		}
		var installationID uuid.UUID
		if err := r.db.QueryRow(ctx, `SELECT installation_id FROM offline_v3_grants WHERE id=$1 AND account_id=$2`, *input.GrantID, *input.AccountID).Scan(&installationID); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return domain.OfflineV3Control{}, ErrOfflineV3NotFound
			}
			return domain.OfflineV3Control{}, err
		}
		if installationID != input.InstallationID {
			return domain.OfflineV3Control{}, ErrOfflineV3AccessDenied
		}
	}
	var createdBy any
	if actorID != nil && *actorID != uuid.Nil {
		createdBy = *actorID
	}
	_, err := r.db.Exec(ctx, `INSERT INTO offline_v3_controls(id,installation_id,grant_id,account_id,scope,scope_id,revision,action,reason,token,key_id,key_version,created_by)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
		ON CONFLICT(installation_id,scope,scope_id,revision,action) DO NOTHING`, input.ID, input.InstallationID,
		input.GrantID, input.AccountID, input.Scope, input.ScopeID, input.Revision, input.Action, input.Reason, input.Token,
		input.KeyID, input.KeyVersion, createdBy)
	if err != nil {
		return domain.OfflineV3Control{}, err
	}
	var output domain.OfflineV3Control
	err = r.db.QueryRow(ctx, `SELECT id,installation_id,grant_id,account_id,scope,scope_id,revision,action,reason,token,key_id,key_version,created_at,acknowledged_at
		FROM offline_v3_controls WHERE installation_id=$1 AND scope=$2 AND scope_id=$3 AND revision=$4 AND action=$5`,
		input.InstallationID, input.Scope, input.ScopeID, input.Revision, input.Action).Scan(&output.ID, &output.InstallationID,
		&output.GrantID, &output.AccountID, &output.Scope, &output.ScopeID, &output.Revision, &output.Action, &output.Reason,
		&output.Token, &output.KeyID, &output.KeyVersion, &output.CreatedAt, &output.AcknowledgedAt)
	return output, err
}

func (r *OfflineV3Repository) Cleanup(ctx context.Context) error {
	_, err := r.db.Exec(ctx, `DELETE FROM offline_v3_challenges WHERE expires_at<NOW()-INTERVAL '5 minutes' OR consumed_at IS NOT NULL`)
	return err
}
