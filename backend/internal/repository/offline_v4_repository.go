package repository

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
)

type OfflineV4Repository struct{ db *pgxpool.Pool }

type OfflineV4AuthRecord struct {
	domain.OfflineV4Grant
	BrowserSigningJWK    json.RawMessage
	BrowserKeyThumbprint string
	GrantSigningJWK      json.RawMessage
	GrantKeyThumbprint   string
}

type OfflineV4EnrollmentInput struct {
	BrowserProfileID         uuid.UUID
	UserID                   uuid.UUID
	BrowserName, DisplayName string
	SigningJWK               json.RawMessage
	KeyThumbprint            string
}

const offlineV4GrantColumns = `g.id,g.browser_profile_id,g.user_id,g.account_id,a.name,u.username,
 p.browser_name,p.display_name,g.state,g.actions,g.max_resources,g.quota_bytes,g.max_offline_seconds,
 g.revision,g.selection_revision,g.selection_digest,g.credential_epoch,g.authority_epoch,g.created_at`

func scanOfflineV4Grant(row interface{ Scan(...any) error }) (domain.OfflineV4Grant, error) {
	var g domain.OfflineV4Grant
	var actions []byte
	err := row.Scan(&g.GrantID, &g.BrowserProfileID, &g.UserID, &g.AccountID, &g.AccountName, &g.Username,
		&g.BrowserName, &g.DisplayName, &g.State, &actions, &g.MaxResources, &g.QuotaBytes, &g.MaxOfflineSeconds,
		&g.Revision, &g.SelectionRevision, &g.SelectionDigest, &g.CredentialEpoch, &g.AuthorityEpoch, &g.CreatedAt)
	if err != nil {
		return g, err
	}
	if err = json.Unmarshal(actions, &g.Actions); err != nil {
		return g, err
	}
	return g, nil
}

func (r *OfflineV4Repository) AuthRecord(ctx context.Context, grantID uuid.UUID) (*OfflineV4AuthRecord, error) {
	g, err := scanOfflineV4Grant(r.db.QueryRow(ctx, `SELECT `+offlineV4GrantColumns+` FROM offline_v4_grants g
	 JOIN accounts a ON a.id=g.account_id JOIN users u ON u.id=g.user_id
	 JOIN offline_v4_browser_profiles p ON p.id=g.browser_profile_id WHERE g.id=$1`, grantID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrOfflineV3NotFound
	}
	if err != nil {
		return nil, err
	}
	record := &OfflineV4AuthRecord{OfflineV4Grant: g}
	err = r.db.QueryRow(ctx, `SELECT p.signing_jwk,p.key_thumbprint,COALESCE(k.signing_jwk,'null'::jsonb),COALESCE(k.key_thumbprint,'')
	 FROM offline_v4_browser_profiles p LEFT JOIN offline_v4_grant_keys k ON k.grant_id=$2 AND k.account_id=$3 WHERE p.id=$1`,
		g.BrowserProfileID, g.GrantID, g.AccountID).Scan(&record.BrowserSigningJWK, &record.BrowserKeyThumbprint, &record.GrantSigningJWK, &record.GrantKeyThumbprint)
	return record, err
}

// All reads and commands reacquire live authority in their transaction. A
// signed request alone does not override membership, epochs, ACL or revocation.
func (r *OfflineV4Repository) LockActiveGrantTx(ctx context.Context, tx pgx.Tx, grantID uuid.UUID, action string) (*OfflineV4AuthRecord, error) {
	var userID, accountID, profileID uuid.UUID
	err := tx.QueryRow(ctx, `SELECT user_id,account_id,browser_profile_id FROM offline_v4_grants WHERE id=$1`, grantID).Scan(&userID, &accountID, &profileID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrOfflineV3NotFound
	}
	if err != nil {
		return nil, err
	}
	if err := lockUserAuthorityTx(ctx, tx, userID); err != nil {
		return nil, err
	}
	members, err := lockAccountMembershipsKeyShareTx(ctx, tx, accountID, []uuid.UUID{userID})
	if err != nil {
		return nil, err
	}
	if _, ok := members[userID]; !ok {
		return nil, ErrOfflineV3AccessDenied
	}
	var profileState string
	var profileKey json.RawMessage
	var profileThumb string
	if err := tx.QueryRow(ctx, `SELECT state,signing_jwk,key_thumbprint FROM offline_v4_browser_profiles WHERE id=$1 FOR SHARE`, profileID).Scan(&profileState, &profileKey, &profileThumb); err != nil {
		return nil, err
	}
	g, err := scanOfflineV4Grant(tx.QueryRow(ctx, `SELECT `+offlineV4GrantColumns+` FROM offline_v4_grants g
	 JOIN accounts a ON a.id=g.account_id JOIN users u ON u.id=g.user_id
	 JOIN offline_v4_browser_profiles p ON p.id=g.browser_profile_id WHERE g.id=$1 FOR UPDATE OF g`, grantID))
	if err != nil {
		return nil, err
	}
	var active, accountActive, membershipActive bool
	var credentialEpoch, userEpoch, membershipEpoch int64
	err = tx.QueryRow(ctx, `SELECT u.is_active,COALESCE(a.is_active,TRUE),e.active,u.offline_credential_epoch,u.offline_authority_epoch,e.authority_epoch
	 FROM users u JOIN accounts a ON a.id=$2 JOIN offline_v3_membership_epochs e ON e.user_id=u.id AND e.account_id=a.id
	 WHERE u.id=$1 FOR SHARE OF u,a,e`, userID, accountID).Scan(&active, &accountActive, &membershipActive, &credentialEpoch, &userEpoch, &membershipEpoch)
	if err != nil {
		return nil, err
	}
	if !active || !accountActive || !membershipActive || g.State != "active" || profileState != "active" || g.CredentialEpoch != credentialEpoch || g.AuthorityEpoch != userEpoch+membershipEpoch {
		return nil, ErrOfflineV3AccessDenied
	}
	if action != "" {
		module, valid := offlineV3ModuleForAction(action)
		if !valid || !offlineV4HasAction(g.Actions, action) {
			return nil, ErrOfflineV3AccessDenied
		}
		allowed, err := offlineV3ActorHasModuleWith(ctx, tx, userID, accountID, module)
		if err != nil {
			return nil, err
		}
		if !allowed {
			return nil, ErrOfflineV3AccessDenied
		}
	}
	record := &OfflineV4AuthRecord{OfflineV4Grant: g, BrowserSigningJWK: profileKey, BrowserKeyThumbprint: profileThumb}
	err = tx.QueryRow(ctx, `SELECT signing_jwk,key_thumbprint FROM offline_v4_grant_keys WHERE grant_id=$1 AND account_id=$2`, grantID, accountID).Scan(&record.GrantSigningJWK, &record.GrantKeyThumbprint)
	if errors.Is(err, pgx.ErrNoRows) {
		err = nil
	}
	return record, err
}

func offlineV4HasAction(actions []string, want string) bool {
	for _, a := range actions {
		if a == want {
			return true
		}
	}
	return false
}

func (r *OfflineV4Repository) CreateChallenge(ctx context.Context, userID, grantID uuid.UUID, purpose string) (domain.OfflineV4Challenge, error) {
	result := domain.OfflineV4Challenge{ID: uuid.New(), ExpiresAt: time.Now().UTC().Add(2 * time.Minute)}
	if purpose != "enrollment" && purpose != "keys" && purpose != "sync" {
		return result, ErrOfflineV3Invalid
	}
	if purpose == "enrollment" && userID == uuid.Nil || purpose != "enrollment" && grantID == uuid.Nil {
		return result, ErrOfflineV3Invalid
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return result, err
	}
	result.Nonce = base64.RawURLEncoding.EncodeToString(raw)
	hash := sha256.Sum256([]byte(result.Nonce))
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return result, err
	}
	defer tx.Rollback(ctx)
	// Bound stale challenge storage; issuance is additionally rate limited by API.
	if _, err = tx.Exec(ctx, `DELETE FROM offline_v4_challenges WHERE id IN (SELECT id FROM offline_v4_challenges WHERE expires_at<NOW()-INTERVAL '1 hour' ORDER BY expires_at LIMIT 500)`); err != nil {
		return result, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO offline_v4_challenges(id,user_id,grant_id,purpose,nonce_hash,expires_at) VALUES($1,NULLIF($2::uuid,'00000000-0000-0000-0000-000000000000'::uuid),NULLIF($3::uuid,'00000000-0000-0000-0000-000000000000'::uuid),$4,$5,$6)`, result.ID, userID, grantID, purpose, hash[:], result.ExpiresAt)
	if err != nil {
		return result, err
	}
	return result, tx.Commit(ctx)
}

func consumeOfflineV4Challenge(ctx context.Context, tx pgx.Tx, id, userID, grantID uuid.UUID, purpose, nonce string) error {
	hash := sha256.Sum256([]byte(nonce))
	tag, err := tx.Exec(ctx, `UPDATE offline_v4_challenges SET consumed_at=NOW() WHERE id=$1 AND purpose=$2 AND nonce_hash=$3
	 AND COALESCE(user_id,'00000000-0000-0000-0000-000000000000'::uuid)=$4
	 AND COALESCE(grant_id,'00000000-0000-0000-0000-000000000000'::uuid)=$5 AND consumed_at IS NULL AND expires_at>NOW()`, id, purpose, hash[:], userID, grantID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrOfflineV3Replay
	}
	return nil
}

func (r *OfflineV4Repository) RequestEnrollment(ctx context.Context, input OfflineV4EnrollmentInput, challengeID uuid.UUID, nonce string) (uuid.UUID, error) {
	if input.BrowserProfileID == uuid.Nil || input.UserID == uuid.Nil || len(input.BrowserName) > 80 || len(input.DisplayName) > 160 || input.DisplayName == "" {
		return uuid.Nil, ErrOfflineV3Invalid
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return uuid.Nil, err
	}
	defer tx.Rollback(ctx)
	if err = consumeOfflineV4Challenge(ctx, tx, challengeID, input.UserID, uuid.Nil, "enrollment", nonce); err != nil {
		return uuid.Nil, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO offline_v4_browser_profiles(id,signing_jwk,key_thumbprint,browser_name,display_name) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING`, input.BrowserProfileID, input.SigningJWK, input.KeyThumbprint, input.BrowserName, input.DisplayName)
	if err != nil {
		return uuid.Nil, err
	}
	var thumb, state string
	if err = tx.QueryRow(ctx, `SELECT key_thumbprint,state FROM offline_v4_browser_profiles WHERE id=$1 FOR SHARE`, input.BrowserProfileID).Scan(&thumb, &state); err != nil {
		return uuid.Nil, err
	}
	if thumb != input.KeyThumbprint || state != "active" {
		return uuid.Nil, ErrOfflineV3AccessDenied
	}
	var id uuid.UUID
	err = tx.QueryRow(ctx, `INSERT INTO offline_v4_enrollment_requests(browser_profile_id,user_id) VALUES($1,$2)
	 ON CONFLICT(browser_profile_id,user_id) WHERE state='requested' DO UPDATE SET browser_profile_id=EXCLUDED.browser_profile_id RETURNING id`, input.BrowserProfileID, input.UserID).Scan(&id)
	if err != nil {
		return uuid.Nil, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO offline_v4_audit(browser_profile_id,actor_id,event_type) VALUES($1,$2,'enrollment_requested')`, input.BrowserProfileID, input.UserID); err != nil {
		return uuid.Nil, err
	}
	return id, tx.Commit(ctx)
}

func (r *OfflineV4Repository) ListEnrollments(ctx context.Context, userID uuid.UUID, id uuid.UUID) ([]domain.OfflineV4Enrollment, error) {
	rows, err := r.db.Query(ctx, `SELECT e.id,e.browser_profile_id,e.user_id,u.username,p.browser_name,p.display_name,e.state,e.requested_at,
	 COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'name',a.name) ORDER BY a.name,a.id) FROM user_accounts ua JOIN accounts a ON a.id=ua.account_id WHERE ua.user_id=e.user_id AND COALESCE(a.is_active,TRUE)), '[]'::jsonb)
	 FROM offline_v4_enrollment_requests e JOIN users u ON u.id=e.user_id JOIN offline_v4_browser_profiles p ON p.id=e.browser_profile_id
	 WHERE ($1::uuid='00000000-0000-0000-0000-000000000000'::uuid OR e.user_id=$1) AND ($2::uuid='00000000-0000-0000-0000-000000000000'::uuid OR e.id=$2)
	 ORDER BY e.requested_at DESC,e.id LIMIT 100`, userID, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.OfflineV4Enrollment{}
	for rows.Next() {
		var item domain.OfflineV4Enrollment
		var accounts []byte
		if err = rows.Scan(&item.ID, &item.BrowserProfileID, &item.UserID, &item.Username, &item.BrowserName, &item.DisplayName, &item.State, &item.RequestedAt, &accounts); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(accounts, &item.Accounts); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (r *OfflineV4Repository) ListGrants(ctx context.Context, userID, profileID uuid.UUID) ([]domain.OfflineV4Grant, error) {
	rows, err := r.db.Query(ctx, `SELECT `+offlineV4GrantColumns+` FROM offline_v4_grants g JOIN accounts a ON a.id=g.account_id JOIN users u ON u.id=g.user_id
	 JOIN offline_v4_browser_profiles p ON p.id=g.browser_profile_id WHERE ($1::uuid='00000000-0000-0000-0000-000000000000'::uuid OR g.user_id=$1)
	 AND ($2::uuid='00000000-0000-0000-0000-000000000000'::uuid OR g.browser_profile_id=$2) ORDER BY g.created_at DESC,g.id LIMIT 200`, userID, profileID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.OfflineV4Grant{}
	for rows.Next() {
		g, err := scanOfflineV4Grant(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

func (r *OfflineV4Repository) Approve(ctx context.Context, id, actorID uuid.UUID, approvals []OfflineV3GrantApproval) ([]domain.OfflineV4Grant, error) {
	if len(approvals) < 1 || len(approvals) > 5 {
		return nil, ErrOfflineV3Invalid
	}
	tx, err := r.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var superadmin bool
	if err = tx.QueryRow(ctx, `SELECT is_active AND is_super_admin FROM users WHERE id=$1 FOR SHARE`, actorID).Scan(&superadmin); err != nil {
		return nil, err
	}
	if !superadmin {
		return nil, ErrOfflineV3AccessDenied
	}
	var userID, profileID uuid.UUID
	var state string
	if err = tx.QueryRow(ctx, `SELECT user_id,browser_profile_id,state FROM offline_v4_enrollment_requests WHERE id=$1 FOR UPDATE`, id).Scan(&userID, &profileID, &state); err != nil {
		return nil, err
	}
	if state != "requested" {
		return nil, ErrOfflineV3Conflict
	}
	if err = lockUserAuthorityTx(ctx, tx, userID); err != nil {
		return nil, err
	}
	if err = tx.QueryRow(ctx, `SELECT state FROM offline_v4_browser_profiles WHERE id=$1 FOR SHARE`, profileID).Scan(&state); err != nil {
		return nil, err
	}
	if state != "active" {
		return nil, ErrOfflineV3AccessDenied
	}
	seen := map[uuid.UUID]bool{}
	for _, a := range approvals {
		if a.AccountID == uuid.Nil || seen[a.AccountID] || a.MaxResources < 1 || a.MaxResources > 20 || a.QuotaBytes < 1<<20 || a.QuotaBytes > 5<<30 || len(a.Actions) < 1 {
			return nil, ErrOfflineV3Invalid
		}
		seen[a.AccountID] = true
		var credential, userEpoch, memberEpoch int64
		var active bool
		err = tx.QueryRow(ctx, `SELECT u.offline_credential_epoch,u.offline_authority_epoch,e.authority_epoch,u.is_active AND COALESCE(a.is_active,TRUE) AND e.active
		 FROM users u JOIN user_accounts ua ON ua.user_id=u.id AND ua.account_id=$2 JOIN accounts a ON a.id=ua.account_id
		 JOIN offline_v3_membership_epochs e ON e.user_id=u.id AND e.account_id=a.id WHERE u.id=$1 FOR SHARE OF u,ua,a,e`, userID, a.AccountID).Scan(&credential, &userEpoch, &memberEpoch, &active)
		if err != nil {
			return nil, err
		}
		if !active {
			return nil, ErrOfflineV3AccessDenied
		}
		seenActions := map[string]bool{}
		for _, action := range a.Actions {
			module, valid := offlineV3ModuleForAction(action)
			if !valid || seenActions[action] {
				return nil, ErrOfflineV3Invalid
			}
			seenActions[action] = true
			allowed, err := offlineV3ActorHasModuleWith(ctx, tx, userID, a.AccountID, module)
			if err != nil {
				return nil, err
			}
			if !allowed {
				return nil, ErrOfflineV3AccessDenied
			}
		}
		if (seenActions[domain.OfflineV3ActionTasksCreate] || seenActions[domain.OfflineV3ActionTasksComplete]) && !seenActions[domain.OfflineV3ActionTasksRead] {
			return nil, ErrOfflineV3Invalid
		}
		sort.Strings(a.Actions)
		actions, _ := json.Marshal(a.Actions)
		_, err = tx.Exec(ctx, `INSERT INTO offline_v4_grants(browser_profile_id,user_id,account_id,actions,max_resources,quota_bytes,credential_epoch,authority_epoch,approved_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, profileID, userID, a.AccountID, actions, a.MaxResources, a.QuotaBytes, credential, userEpoch+memberEpoch, actorID)
		if err != nil {
			return nil, err
		}
	}
	if _, err = tx.Exec(ctx, `UPDATE offline_v4_enrollment_requests SET state='approved',decided_by=$2,decided_at=NOW() WHERE id=$1`, id, actorID); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO offline_v4_audit(browser_profile_id,actor_id,event_type,metadata) VALUES($1,$2,'enrollment_approved',jsonb_build_object('request_id',$3::text))`, profileID, actorID, id); err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return r.ListGrants(ctx, userID, profileID)
}

func (r *OfflineV4Repository) Reject(ctx context.Context, id, actorID uuid.UUID, note string) error {
	if len(note) > 500 {
		return ErrOfflineV3Invalid
	}
	tag, err := r.db.Exec(ctx, `WITH rejected AS (UPDATE offline_v4_enrollment_requests SET state='rejected',decided_by=$2,decided_at=NOW(),decision_note=$3
	 WHERE id=$1 AND state='requested' AND EXISTS(SELECT 1 FROM users WHERE id=$2 AND is_active AND is_super_admin) RETURNING browser_profile_id)
	 INSERT INTO offline_v4_audit(browser_profile_id,actor_id,event_type,metadata) SELECT browser_profile_id,$2,'enrollment_rejected',jsonb_build_object('request_id',$1::text) FROM rejected`, id, actorID, note)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrOfflineV3Conflict
	}
	return nil
}

func (r *OfflineV4Repository) RegisterKey(ctx context.Context, grantID, userID, challengeID uuid.UUID, nonce string, key json.RawMessage, thumb string) error {
	tx, err := r.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	record, err := r.LockActiveGrantTx(ctx, tx, grantID, "")
	if err != nil {
		return err
	}
	if record.UserID != userID {
		return ErrOfflineV3NotFound
	}
	if err = consumeOfflineV4Challenge(ctx, tx, challengeID, userID, grantID, "keys", nonce); err != nil {
		return err
	}
	if record.GrantKeyThumbprint != "" && record.GrantKeyThumbprint != thumb {
		return ErrOfflineV3KeyExists
	}
	if _, err = tx.Exec(ctx, `INSERT INTO offline_v4_grant_keys(grant_id,account_id,signing_jwk,key_thumbprint) VALUES($1,$2,$3,$4) ON CONFLICT(grant_id) DO NOTHING`, grantID, record.AccountID, key, thumb); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO offline_v4_audit(browser_profile_id,grant_id,account_id,actor_id,event_type) VALUES($1,$2,$3,$4,'grant_keys_registered')`, record.BrowserProfileID, grantID, record.AccountID, userID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *OfflineV4Repository) Revoke(ctx context.Context, actorID, scopeID uuid.UUID, scope string) (int64, error) {
	column := ""
	switch scope {
	case "browser_profile":
		column = "browser_profile_id"
	case "user":
		column = "user_id"
	case "account":
		column = "account_id"
	case "grant":
		column = "id"
	default:
		return 0, ErrOfflineV3Invalid
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	var allowed bool
	if err = tx.QueryRow(ctx, `SELECT is_active AND is_super_admin FROM users WHERE id=$1 FOR SHARE`, actorID).Scan(&allowed); err != nil {
		return 0, err
	}
	if !allowed {
		return 0, ErrOfflineV3AccessDenied
	}
	if scope == "browser_profile" {
		if _, err = tx.Exec(ctx, `UPDATE offline_v4_browser_profiles SET state='revoked',revision=revision+1 WHERE id=$1`, scopeID); err != nil {
			return 0, err
		}
	}
	tag, err := tx.Exec(ctx, `UPDATE offline_v4_grants SET state='revoked',revision=revision+1,revoked_at=NOW(),updated_at=NOW() WHERE `+column+`=$1 AND state='active'`, scopeID)
	if err != nil {
		return 0, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO offline_v4_audit(actor_id,event_type,metadata) VALUES($1,'authority_revoked',jsonb_build_object('scope',$2::text,'scope_id',$3::text,'grant_count',$4::bigint))`, actorID, scope, scopeID, tag.RowsAffected()); err != nil {
		return 0, err
	}
	return tag.RowsAffected(), tx.Commit(ctx)
}

func offlineV4SelectionDigest(items []domain.OfflineV3Selection) string {
	keys := make([]string, 0, len(items))
	for _, item := range items {
		keys = append(keys, item.Module+":"+item.ResourceType+":"+item.ResourceID.String())
	}
	sort.Strings(keys)
	raw, _ := json.Marshal(keys)
	hash := sha256.Sum256(raw)
	return hex.EncodeToString(hash[:])
}

func offlineV4SelectionShape(item domain.OfflineV3Selection) bool {
	switch item.Module {
	case domain.OfflineModuleTasks:
		return item.ResourceType == domain.OfflineResourceTaskList
	case domain.OfflineModuleContacts:
		return item.ResourceType == domain.OfflineResourceContact
	case domain.OfflineModulePrograms:
		return item.ResourceType == domain.OfflineResourceProgram
	case domain.OfflineModuleWhiteboards:
		return item.ResourceType == domain.OfflineResourceWhiteboard
	}
	return false
}

func offlineV4SelectionsTx(ctx context.Context, tx pgx.Tx, grantID, accountID uuid.UUID) ([]domain.OfflineV3Selection, error) {
	rows, err := tx.Query(ctx, `SELECT id,grant_id,account_id,module,resource_type,resource_id FROM offline_v4_selections WHERE grant_id=$1 AND account_id=$2 ORDER BY module,resource_type,resource_id`, grantID, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []domain.OfflineV3Selection{}
	for rows.Next() {
		var item domain.OfflineV3Selection
		if err = rows.Scan(&item.ID, &item.GrantID, &item.AccountID, &item.Module, &item.ResourceType, &item.ResourceID); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (r *OfflineV4Repository) Selections(ctx context.Context, grantID, userID uuid.UUID) ([]domain.OfflineV3Selection, *OfflineV4AuthRecord, error) {
	tx, err := r.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return nil, nil, err
	}
	defer tx.Rollback(ctx)
	record, err := r.LockActiveGrantTx(ctx, tx, grantID, "")
	if err != nil {
		return nil, nil, err
	}
	if record.UserID != userID {
		return nil, nil, ErrOfflineV3NotFound
	}
	items, err := offlineV4SelectionsTx(ctx, tx, grantID, record.AccountID)
	if err != nil {
		return nil, nil, err
	}
	return items, record, tx.Commit(ctx)
}

func (r *OfflineV4Repository) ReplaceSelections(ctx context.Context, grantID, userID uuid.UUID, revision int64, items []domain.OfflineV3Selection) error {
	tx, err := r.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	record, err := r.LockActiveGrantTx(ctx, tx, grantID, "")
	if err != nil {
		return err
	}
	if record.UserID != userID {
		return ErrOfflineV3NotFound
	}
	if record.SelectionRevision != revision {
		return ErrOfflineV3Conflict
	}
	if len(items) > record.MaxResources {
		return ErrOfflineV3Invalid
	}
	seen := map[string]bool{}
	retained := []uuid.UUID{}
	for _, item := range items {
		key := item.Module + ":" + item.ResourceID.String()
		if item.ResourceID == uuid.Nil || !offlineV4SelectionShape(item) || seen[key] {
			return ErrOfflineV3Invalid
		}
		seen[key] = true
		action, ok := offlineV3ReadAction(item.Module)
		if !ok || !offlineV4HasAction(record.Actions, action) {
			return ErrOfflineV3AccessDenied
		}
		if err = validateOfflineV3ResourceAccess(ctx, tx, userID, record.AccountID, item, domain.TaskAccessView); err != nil {
			return err
		}
		var id uuid.UUID
		err = tx.QueryRow(ctx, `INSERT INTO offline_v4_selections(grant_id,account_id,module,resource_type,resource_id) VALUES($1,$2,$3,$4,$5)
		 ON CONFLICT(grant_id,module,resource_type,resource_id) DO UPDATE SET resource_id=EXCLUDED.resource_id RETURNING id`, grantID, record.AccountID, item.Module, item.ResourceType, item.ResourceID).Scan(&id)
		if err != nil {
			return err
		}
		retained = append(retained, id)
	}
	if _, err = tx.Exec(ctx, `DELETE FROM offline_v4_selections WHERE grant_id=$1 AND account_id=$2 AND NOT(id=ANY($3::uuid[]))`, grantID, record.AccountID, retained); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE offline_v4_grants SET selection_revision=selection_revision+1,selection_digest=$3,updated_at=NOW() WHERE id=$1 AND account_id=$2`, grantID, record.AccountID, offlineV4SelectionDigest(items))
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO offline_v4_audit(browser_profile_id,grant_id,account_id,actor_id,event_type,metadata) VALUES($1,$2,$3,$4,'selection_changed',jsonb_build_object('resource_count',$5::int,'revision',$6::bigint))`, record.BrowserProfileID, grantID, record.AccountID, userID, len(items), record.SelectionRevision+1); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func canonicalOfflineV4Display(value string) string { return strings.TrimSpace(value) }
