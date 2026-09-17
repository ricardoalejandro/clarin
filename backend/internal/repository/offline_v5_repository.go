package repository

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
)

type OfflineV5Repository struct{ db *pgxpool.Pool }

type OfflineV5AuthRecord struct {
	*OfflineV4AuthRecord
	Modules         []string
	V5Revision      int64
	PrepareEnabled  bool
	WritesEnabled   bool
	BlobSyncEnabled bool
}

type OfflineV5GrantApproval struct {
	AccountID    uuid.UUID `json:"account_id"`
	Modules      []string  `json:"modules"`
	MaxResources int       `json:"max_resources"`
	QuotaBytes   int64     `json:"quota_bytes"`
}

func offlineV5Module(module string) bool {
	switch module {
	case domain.OfflineModuleTasks, domain.OfflineModuleContacts, domain.OfflineModulePrograms, domain.OfflineModuleWhiteboards:
		return true
	default:
		return false
	}
}

func normalizeOfflineV5Modules(modules []string) ([]string, error) {
	if len(modules) == 0 || len(modules) > 4 {
		return nil, ErrOfflineV3Invalid
	}
	seen := make(map[string]struct{}, len(modules))
	out := make([]string, 0, len(modules))
	for _, module := range modules {
		if !offlineV5Module(module) {
			return nil, ErrOfflineV3Invalid
		}
		if _, duplicate := seen[module]; duplicate {
			return nil, ErrOfflineV3Invalid
		}
		seen[module] = struct{}{}
		out = append(out, module)
	}
	sort.Strings(out)
	return out, nil
}

func offlineV5EligibleTarget(active, _ bool) bool {
	// A superadmin may need the same emergency account access as any other
	// active user. The grant never carries platform-wide administration: its
	// authority remains bounded to one approved account, the closed v5 module
	// capability registry and the exact selected resources.
	return active
}

func offlineV5ReadActions(modules []string) []string {
	out := make([]string, 0, len(modules))
	for _, module := range modules {
		if action, ok := offlineV3ReadAction(module); ok {
			out = append(out, action)
		}
	}
	sort.Strings(out)
	return out
}

type offlineV5KeyRegistrationMode string

const (
	offlineV5KeyRegister offlineV5KeyRegistrationMode = "register"
	offlineV5KeyReuse    offlineV5KeyRegistrationMode = "reuse"
	offlineV5KeyRecover  offlineV5KeyRegistrationMode = "recover"
)

func offlineV5KeyRegistrationDecision(currentThumbprint, nextThumbprint string, manifestCount int) (offlineV5KeyRegistrationMode, error) {
	if currentThumbprint == "" {
		return offlineV5KeyRegister, nil
	}
	if currentThumbprint == nextThumbprint {
		return offlineV5KeyReuse, nil
	}
	if manifestCount == 0 {
		return offlineV5KeyRecover, nil
	}
	return "", ErrOfflineV3KeyExists
}

func offlineV5SelectionsForModules(items []domain.OfflineV3Selection, modules []string) []domain.OfflineV3Selection {
	retained := make([]domain.OfflineV3Selection, 0, len(items))
	for _, item := range items {
		if offlineV5ModuleAllowed(modules, item.Module) {
			retained = append(retained, item)
		}
	}
	return retained
}

func offlineV5PotentialCapabilities(modules []string, writes bool) []string {
	out := make([]string, 0, 11)
	for _, module := range modules {
		switch module {
		case domain.OfflineModuleTasks:
			out = append(out, domain.OfflineV5ActionTasksRead)
			if writes {
				out = append(out, domain.OfflineV5ActionTasksCreate, domain.OfflineV5ActionTasksUpdate, domain.OfflineV5ActionTasksComplete, domain.OfflineV5ActionTasksReopen, domain.OfflineV5ActionTasksComment)
			}
		case domain.OfflineModuleContacts:
			out = append(out, domain.OfflineV5ActionContactsRead)
			if writes {
				out = append(out, domain.OfflineV5ActionContactsUpdate, domain.OfflineV5ActionContactsObserve)
			}
		case domain.OfflineModulePrograms:
			out = append(out, domain.OfflineV5ActionProgramsRead)
			if writes {
				out = append(out, domain.OfflineV5ActionProgramsUpdate, domain.OfflineV5ActionProgramsParticipantAdd,
					domain.OfflineV5ActionProgramsParticipantLifecycle, domain.OfflineV5ActionProgramsSessionUpsert, domain.OfflineV5ActionProgramsAttendance,
					domain.OfflineV5ActionProgramsObservation, domain.OfflineV5ActionProgramsGoals)
			}
		case domain.OfflineModuleWhiteboards:
			out = append(out, domain.OfflineV5ActionBoardsRead)
			if writes {
				out = append(out, domain.OfflineV5ActionBoardsScene)
			}
		}
	}
	sort.Strings(out)
	return out
}

func (r *OfflineV5Repository) AuthRecord(ctx context.Context, grantID uuid.UUID) (*OfflineV5AuthRecord, error) {
	v4 := &OfflineV4Repository{db: r.db}
	record, err := v4.AuthRecord(ctx, grantID)
	if err != nil {
		return nil, err
	}
	var raw []byte
	v5 := &OfflineV5AuthRecord{OfflineV4AuthRecord: record}
	err = r.db.QueryRow(ctx, `SELECT policy.modules,policy.revision,policy.prepare_enabled,policy.writes_enabled,policy.blob_sync_enabled
		FROM offline_v5_grant_policies policy JOIN users target ON target.id=$3
		WHERE policy.grant_id=$1 AND policy.account_id=$2 AND target.is_active=TRUE`,
		grantID, record.AccountID, record.UserID).
		Scan(&raw, &v5.V5Revision, &v5.PrepareEnabled, &v5.WritesEnabled, &v5.BlobSyncEnabled)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrOfflineV3NotFound
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(raw, &v5.Modules); err != nil {
		return nil, err
	}
	return v5, nil
}

func (r *OfflineV5Repository) LockActiveGrantTx(ctx context.Context, tx pgx.Tx, grantID uuid.UUID) (*OfflineV5AuthRecord, error) {
	v4 := &OfflineV4Repository{db: r.db}
	record, err := v4.LockActiveGrantTx(ctx, tx, grantID, "")
	if err != nil {
		return nil, err
	}
	var raw []byte
	v5 := &OfflineV5AuthRecord{OfflineV4AuthRecord: record}
	err = tx.QueryRow(ctx, `SELECT policy.modules,policy.revision,policy.prepare_enabled,policy.writes_enabled,policy.blob_sync_enabled
		FROM offline_v5_grant_policies policy JOIN users target ON target.id=$3
		WHERE policy.grant_id=$1 AND policy.account_id=$2 AND target.is_active=TRUE
		FOR SHARE OF policy,target`, grantID, record.AccountID, record.UserID).
		Scan(&raw, &v5.V5Revision, &v5.PrepareEnabled, &v5.WritesEnabled, &v5.BlobSyncEnabled)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrOfflineV3AccessDenied
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(raw, &v5.Modules); err != nil {
		return nil, err
	}
	return v5, nil
}

func offlineV5GrantView(record *OfflineV5AuthRecord, writes bool) domain.OfflineV5Grant {
	return domain.OfflineV5Grant{
		OfflineV4Grant: record.OfflineV4Grant,
		Modules:        append([]string(nil), record.Modules...),
		Capabilities:   offlineV5PotentialCapabilities(record.Modules, writes && record.WritesEnabled),
		V5Revision:     record.V5Revision,
	}
}

// listGrantsV5 is kept separate from the shared v4 scanner because pgx rows
// cannot be partially scanned when policy columns are appended.
func (r *OfflineV5Repository) listGrantsV5(ctx context.Context, userID, profileID uuid.UUID, writes bool) ([]domain.OfflineV5Grant, error) {
	rows, err := r.db.Query(ctx, `SELECT `+offlineV4GrantColumns+`,policy.modules,policy.revision,policy.writes_enabled
		FROM offline_v4_grants g JOIN accounts a ON a.id=g.account_id JOIN users u ON u.id=g.user_id
		JOIN offline_v4_browser_profiles p ON p.id=g.browser_profile_id
		JOIN offline_v5_grant_policies policy ON policy.grant_id=g.id AND policy.account_id=g.account_id
		WHERE ($1::uuid='00000000-0000-0000-0000-000000000000'::uuid OR g.user_id=$1)
		AND ($2::uuid='00000000-0000-0000-0000-000000000000'::uuid OR g.browser_profile_id=$2)
		AND u.is_active=TRUE
		ORDER BY g.created_at DESC,g.id LIMIT 200`, userID, profileID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.OfflineV5Grant, 0)
	for rows.Next() {
		var g domain.OfflineV4Grant
		var actions, modules []byte
		var v5Revision int64
		var policyWrites bool
		if err := rows.Scan(&g.GrantID, &g.BrowserProfileID, &g.UserID, &g.AccountID, &g.AccountName, &g.Username,
			&g.BrowserName, &g.DisplayName, &g.State, &actions, &g.MaxResources, &g.QuotaBytes, &g.MaxOfflineSeconds,
			&g.Revision, &g.SelectionRevision, &g.SelectionDigest, &g.CredentialEpoch, &g.AuthorityEpoch, &g.CreatedAt,
			&modules, &v5Revision, &policyWrites); err != nil {
			return nil, err
		}
		var moduleNames []string
		if err := json.Unmarshal(actions, &g.Actions); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(modules, &moduleNames); err != nil {
			return nil, err
		}
		out = append(out, domain.OfflineV5Grant{OfflineV4Grant: g, Modules: moduleNames,
			Capabilities: offlineV5PotentialCapabilities(moduleNames, writes && policyWrites), V5Revision: v5Revision})
	}
	return out, rows.Err()
}

// ListV5Grants is the public, fully-scanned v5 grant list.
func (r *OfflineV5Repository) ListV5Grants(ctx context.Context, userID, profileID uuid.UUID, writes bool) ([]domain.OfflineV5Grant, error) {
	return r.listGrantsV5(ctx, userID, profileID, writes)
}

func (r *OfflineV5Repository) CreateChallenge(ctx context.Context, userID, grantID uuid.UUID, purpose string) (domain.OfflineV4Challenge, error) {
	result := domain.OfflineV4Challenge{ID: uuid.New(), ExpiresAt: time.Now().UTC().Add(2 * time.Minute)}
	if purpose != "enrollment" && purpose != "keys" && purpose != "prepare" && purpose != "sync" && purpose != "blob" {
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
	if _, err = tx.Exec(ctx, `DELETE FROM offline_v5_challenges WHERE id IN
		(SELECT id FROM offline_v5_challenges WHERE expires_at<NOW()-INTERVAL '1 hour' ORDER BY expires_at LIMIT 500)`); err != nil {
		return result, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO offline_v5_challenges(id,user_id,grant_id,purpose,nonce_hash,expires_at)
		VALUES($1,NULLIF($2::uuid,'00000000-0000-0000-0000-000000000000'::uuid),NULLIF($3::uuid,'00000000-0000-0000-0000-000000000000'::uuid),$4,$5,$6)`,
		result.ID, userID, grantID, purpose, hash[:], result.ExpiresAt); err != nil {
		return result, err
	}
	return result, tx.Commit(ctx)
}

func consumeOfflineV5Challenge(ctx context.Context, tx pgx.Tx, id, userID, grantID uuid.UUID, purpose, nonce string) error {
	hash := sha256.Sum256([]byte(nonce))
	tag, err := tx.Exec(ctx, `UPDATE offline_v5_challenges SET consumed_at=NOW()
		WHERE id=$1 AND purpose=$2 AND nonce_hash=$3
		AND COALESCE(user_id,'00000000-0000-0000-0000-000000000000'::uuid)=$4
		AND COALESCE(grant_id,'00000000-0000-0000-0000-000000000000'::uuid)=$5
		AND consumed_at IS NULL AND expires_at>NOW()`, id, purpose, hash[:], userID, grantID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrOfflineV3Replay
	}
	return nil
}

func (r *OfflineV5Repository) RequestEnrollment(ctx context.Context, input OfflineV4EnrollmentInput, challengeID uuid.UUID, nonce string) (uuid.UUID, error) {
	if input.BrowserProfileID == uuid.Nil || input.UserID == uuid.Nil || len(input.BrowserName) > 80 || len(input.DisplayName) > 160 || input.DisplayName == "" {
		return uuid.Nil, ErrOfflineV3Invalid
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return uuid.Nil, err
	}
	defer tx.Rollback(ctx)
	var targetActive, targetSuperadmin bool
	if err = tx.QueryRow(ctx, `SELECT is_active,is_super_admin FROM users WHERE id=$1 FOR SHARE`, input.UserID).
		Scan(&targetActive, &targetSuperadmin); err != nil {
		return uuid.Nil, err
	}
	if !offlineV5EligibleTarget(targetActive, targetSuperadmin) {
		return uuid.Nil, ErrOfflineV3AccessDenied
	}
	if err = consumeOfflineV5Challenge(ctx, tx, challengeID, input.UserID, uuid.Nil, "enrollment", nonce); err != nil {
		return uuid.Nil, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO offline_v4_browser_profiles(id,signing_jwk,key_thumbprint,browser_name,display_name)
		VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING`, input.BrowserProfileID, input.SigningJWK,
		input.KeyThumbprint, input.BrowserName, input.DisplayName); err != nil {
		return uuid.Nil, err
	}
	var thumbprint, state string
	if err = tx.QueryRow(ctx, `SELECT key_thumbprint,state FROM offline_v4_browser_profiles WHERE id=$1 FOR SHARE`, input.BrowserProfileID).
		Scan(&thumbprint, &state); err != nil {
		return uuid.Nil, err
	}
	if thumbprint != input.KeyThumbprint || state != "active" {
		return uuid.Nil, ErrOfflineV3AccessDenied
	}
	var requestID uuid.UUID
	if err = tx.QueryRow(ctx, `INSERT INTO offline_v4_enrollment_requests(browser_profile_id,user_id) VALUES($1,$2)
		ON CONFLICT(browser_profile_id,user_id) WHERE state='requested'
		DO UPDATE SET browser_profile_id=EXCLUDED.browser_profile_id RETURNING id`, input.BrowserProfileID, input.UserID).Scan(&requestID); err != nil {
		return uuid.Nil, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO offline_v5_audit(browser_profile_id,actor_id,event_type)
		VALUES($1,$2,'enrollment_requested')`, input.BrowserProfileID, input.UserID); err != nil {
		return uuid.Nil, err
	}
	return requestID, tx.Commit(ctx)
}

func (r *OfflineV5Repository) RegisterKey(ctx context.Context, grantID, userID, challengeID uuid.UUID, nonce string, key json.RawMessage, thumbprint string) error {
	tx, err := r.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	record, err := r.LockActiveGrantTx(ctx, tx, grantID)
	if err != nil {
		return err
	}
	if record.UserID != userID {
		return ErrOfflineV3NotFound
	}
	if err = consumeOfflineV5Challenge(ctx, tx, challengeID, userID, grantID, "keys", nonce); err != nil {
		return err
	}
	manifestCount := 0
	if record.GrantKeyThumbprint != "" && record.GrantKeyThumbprint != thumbprint {
		if err = tx.QueryRow(ctx, `SELECT COUNT(*) FROM offline_v5_manifests
			WHERE grant_id=$1 AND account_id=$2`, grantID, record.AccountID).Scan(&manifestCount); err != nil {
			return err
		}
	}
	mode, err := offlineV5KeyRegistrationDecision(record.GrantKeyThumbprint, thumbprint, manifestCount)
	if err != nil {
		return err
	}
	eventType := "grant_keys_registered"
	switch mode {
	case offlineV5KeyRegister:
		if _, err = tx.Exec(ctx, `INSERT INTO offline_v4_grant_keys(grant_id,account_id,signing_jwk,key_thumbprint)
			VALUES($1,$2,$3,$4)`, grantID, record.AccountID, key, thumbprint); err != nil {
			return err
		}
	case offlineV5KeyReuse:
		// A lost HTTP response or failed preparation must be safely retryable with
		// the exact key already protected by the local preparing vault.
		eventType = "grant_keys_reused"
	case offlineV5KeyRecover:
		// No manifest means no offline operation could have been signed by the old
		// key. Replacing it repairs grants stranded between /keys and /prepare
		// without invalidating a prepared copy or pending changes.
		if _, err = tx.Exec(ctx, `UPDATE offline_v4_grant_keys
			SET signing_jwk=$3,key_thumbprint=$4,created_at=NOW()
			WHERE grant_id=$1 AND account_id=$2`, grantID, record.AccountID, key, thumbprint); err != nil {
			return err
		}
		eventType = "grant_keys_recovered"
	}
	if _, err = tx.Exec(ctx, `INSERT INTO offline_v5_audit(browser_profile_id,grant_id,account_id,actor_id,event_type)
		VALUES($1,$2,$3,$4,$5)`, record.BrowserProfileID, grantID, record.AccountID, userID, eventType); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func validateOfflineV5ApprovalLimits(maxResources int, quota int64) error {
	if maxResources == 0 {
		maxResources = domain.OfflineV5MaxResources
	}
	if quota == 0 {
		quota = 512 << 20
	}
	if maxResources < 1 || maxResources > domain.OfflineV5MaxResources || quota < 1<<20 || quota > 5<<30 {
		return ErrOfflineV3Invalid
	}
	return nil
}

func (r *OfflineV5Repository) Approve(ctx context.Context, requestID, actorID uuid.UUID, approvals []OfflineV5GrantApproval) ([]domain.OfflineV5Grant, error) {
	if len(approvals) == 0 || len(approvals) > 5 {
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
	var targetActive, targetSuperadmin bool
	if err = tx.QueryRow(ctx, `SELECT request.user_id,request.browser_profile_id,request.state,target.is_active,target.is_super_admin
		FROM offline_v4_enrollment_requests request JOIN users target ON target.id=request.user_id
		WHERE request.id=$1 FOR UPDATE OF request`, requestID).
		Scan(&userID, &profileID, &state, &targetActive, &targetSuperadmin); errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrOfflineV3NotFound
	} else if err != nil {
		return nil, err
	}
	if state == "approved" {
		// The request ID is the idempotency boundary. A response can be lost after
		// commit, so a retry must return the canonical grants instead of turning a
		// completed approval into a user-visible conflict.
		if rollbackErr := tx.Rollback(ctx); rollbackErr != nil && !errors.Is(rollbackErr, pgx.ErrTxClosed) {
			return nil, rollbackErr
		}
		return r.ListV5Grants(ctx, userID, profileID, true)
	}
	if state != "requested" {
		return nil, ErrOfflineV3Conflict
	}
	if !offlineV5EligibleTarget(targetActive, targetSuperadmin) {
		return nil, ErrOfflineV3AccessDenied
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
	seenAccounts := map[uuid.UUID]struct{}{}
	for index := range approvals {
		approval := &approvals[index]
		if approval.MaxResources == 0 {
			approval.MaxResources = domain.OfflineV5MaxResources
		}
		if approval.QuotaBytes == 0 {
			approval.QuotaBytes = 512 << 20
		}
		modules, normalizeErr := normalizeOfflineV5Modules(approval.Modules)
		if normalizeErr != nil || validateOfflineV5ApprovalLimits(approval.MaxResources, approval.QuotaBytes) != nil || approval.AccountID == uuid.Nil {
			return nil, ErrOfflineV3Invalid
		}
		if _, duplicate := seenAccounts[approval.AccountID]; duplicate {
			return nil, ErrOfflineV3Invalid
		}
		seenAccounts[approval.AccountID] = struct{}{}
		var credentialEpoch, userEpoch, membershipEpoch int64
		var active bool
		if err = tx.QueryRow(ctx, `SELECT u.offline_credential_epoch,u.offline_authority_epoch,e.authority_epoch,
			u.is_active AND COALESCE(a.is_active,TRUE) AND e.active
			FROM users u JOIN user_accounts ua ON ua.user_id=u.id AND ua.account_id=$2
			JOIN accounts a ON a.id=ua.account_id
			JOIN offline_v3_membership_epochs e ON e.user_id=u.id AND e.account_id=a.id
			WHERE u.id=$1 FOR SHARE OF u,ua,a,e`, userID, approval.AccountID).
			Scan(&credentialEpoch, &userEpoch, &membershipEpoch, &active); err != nil {
			return nil, err
		}
		if !active {
			return nil, ErrOfflineV3AccessDenied
		}
		for _, module := range modules {
			allowed, moduleErr := offlineV3ActorHasModuleWith(ctx, tx, userID, approval.AccountID, module)
			if moduleErr != nil {
				return nil, moduleErr
			}
			if !allowed {
				return nil, ErrOfflineV3AccessDenied
			}
		}
		actionsJSON, _ := json.Marshal(offlineV5ReadActions(modules))
		modulesJSON, _ := json.Marshal(modules)
		var grantID uuid.UUID
		existingGrant := true
		err = tx.QueryRow(ctx, `SELECT id FROM offline_v4_grants
			WHERE browser_profile_id=$1 AND user_id=$2 AND account_id=$3 AND state='active' FOR UPDATE`,
			profileID, userID, approval.AccountID).Scan(&grantID)
		if errors.Is(err, pgx.ErrNoRows) {
			existingGrant = false
			err = tx.QueryRow(ctx, `INSERT INTO offline_v4_grants(browser_profile_id,user_id,account_id,actions,max_resources,quota_bytes,credential_epoch,authority_epoch,approved_by)
				VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, profileID, userID, approval.AccountID, actionsJSON,
				approval.MaxResources, approval.QuotaBytes, credentialEpoch, userEpoch+membershipEpoch, actorID).Scan(&grantID)
		}
		if err != nil {
			return nil, err
		}
		if existingGrant {
			selections, selectionErr := offlineV4SelectionsTx(ctx, tx, grantID, approval.AccountID)
			if selectionErr != nil {
				return nil, selectionErr
			}
			retained := offlineV5SelectionsForModules(selections, modules)
			if len(retained) > approval.MaxResources {
				return nil, ErrOfflineV3Invalid
			}
			if len(retained) != len(selections) {
				if _, err = tx.Exec(ctx, `DELETE FROM offline_v4_selections
					WHERE grant_id=$1 AND account_id=$2 AND NOT(module=ANY($3::text[]))`, grantID, approval.AccountID, modules); err != nil {
					return nil, err
				}
				if _, err = tx.Exec(ctx, `UPDATE offline_v4_grants
					SET selection_revision=selection_revision+1,selection_digest=$3
					WHERE id=$1 AND account_id=$2`, grantID, approval.AccountID, offlineV4SelectionDigest(retained)); err != nil {
					return nil, err
				}
			}
			if _, err = tx.Exec(ctx, `UPDATE offline_v4_grants
				SET actions=$3,max_resources=$4,quota_bytes=$5,credential_epoch=$6,authority_epoch=$7,
					revision=revision+1,updated_at=NOW(),approved_by=$8
				WHERE id=$1 AND account_id=$2`, grantID, approval.AccountID, actionsJSON, approval.MaxResources,
				approval.QuotaBytes, credentialEpoch, userEpoch+membershipEpoch, actorID); err != nil {
				return nil, err
			}
			if _, err = tx.Exec(ctx, `UPDATE offline_v5_manifests SET superseded_at=NOW()
				WHERE grant_id=$1 AND account_id=$2 AND superseded_at IS NULL`, grantID, approval.AccountID); err != nil {
				return nil, err
			}
			if _, err = tx.Exec(ctx, `INSERT INTO offline_v5_audit(browser_profile_id,grant_id,account_id,actor_id,event_type,metadata)
				VALUES($1,$2,$3,$4,'grant_upgraded',jsonb_build_object('modules',$5::jsonb,'retained_resources',$6::int,'removed_resources',$7::int))`,
				profileID, grantID, approval.AccountID, actorID, modulesJSON, len(retained), len(selections)-len(retained)); err != nil {
				return nil, err
			}
		}
		if _, err = tx.Exec(ctx, `INSERT INTO offline_v5_grant_policies(grant_id,account_id,modules,prepare_enabled,writes_enabled,approved_by)
			VALUES($1,$2,$3,TRUE,TRUE,$4)
			ON CONFLICT(grant_id) DO UPDATE SET modules=EXCLUDED.modules,revision=offline_v5_grant_policies.revision+1,
			prepare_enabled=TRUE,writes_enabled=TRUE,updated_at=NOW(),approved_by=EXCLUDED.approved_by`,
			grantID, approval.AccountID, modulesJSON, actorID); err != nil {
			return nil, err
		}
	}
	if _, err = tx.Exec(ctx, `UPDATE offline_v4_enrollment_requests SET state='approved',decided_by=$2,decided_at=NOW() WHERE id=$1`, requestID, actorID); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO offline_v5_audit(browser_profile_id,actor_id,event_type,metadata)
		VALUES($1,$2,'enrollment_approved',jsonb_build_object('request_id',$3::text))`, profileID, actorID, requestID); err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return r.ListV5Grants(ctx, userID, profileID, true)
}

func (r *OfflineV5Repository) Upgrade(ctx context.Context, grantID, actorID uuid.UUID, modules []string, maxResources *int, quotaBytes *int64) (*domain.OfflineV5Grant, error) {
	modules, err := normalizeOfflineV5Modules(modules)
	if err != nil {
		return nil, err
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
	record, err := r.LockActiveGrantTx(ctx, tx, grantID)
	if err != nil {
		return nil, err
	}
	for _, module := range modules {
		allowed, moduleErr := offlineV3ActorHasModuleWith(ctx, tx, record.UserID, record.AccountID, module)
		if moduleErr != nil {
			return nil, moduleErr
		}
		if !allowed {
			return nil, ErrOfflineV3AccessDenied
		}
	}
	resources, quota := record.MaxResources, record.QuotaBytes
	if maxResources != nil {
		resources = *maxResources
	}
	if quotaBytes != nil {
		quota = *quotaBytes
	}
	if err = validateOfflineV5ApprovalLimits(resources, quota); err != nil {
		return nil, err
	}
	actionsJSON, _ := json.Marshal(offlineV5ReadActions(modules))
	modulesJSON, _ := json.Marshal(modules)
	if _, err = tx.Exec(ctx, `UPDATE offline_v4_grants SET actions=$3,max_resources=$4,quota_bytes=$5,revision=revision+1,updated_at=NOW()
		WHERE id=$1 AND account_id=$2`, grantID, record.AccountID, actionsJSON, resources, quota); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO offline_v5_grant_policies(grant_id,account_id,modules,prepare_enabled,writes_enabled,approved_by)
		VALUES($1,$2,$3,TRUE,TRUE,$4)
		ON CONFLICT(grant_id) DO UPDATE SET modules=EXCLUDED.modules,revision=offline_v5_grant_policies.revision+1,
		prepare_enabled=TRUE,writes_enabled=TRUE,updated_at=NOW(),approved_by=EXCLUDED.approved_by`, grantID, record.AccountID, modulesJSON, actorID); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `UPDATE offline_v5_manifests SET superseded_at=NOW() WHERE grant_id=$1 AND account_id=$2 AND superseded_at IS NULL`, grantID, record.AccountID); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO offline_v5_audit(browser_profile_id,grant_id,account_id,actor_id,event_type,metadata)
		VALUES($1,$2,$3,$4,'grant_upgraded',jsonb_build_object('modules',$5::jsonb))`, record.BrowserProfileID, grantID, record.AccountID, actorID, modulesJSON); err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	items, err := r.ListV5Grants(ctx, record.UserID, record.BrowserProfileID, true)
	if err != nil {
		return nil, err
	}
	for index := range items {
		if items[index].GrantID == grantID {
			return &items[index], nil
		}
	}
	return nil, ErrOfflineV3NotFound
}

func (r *OfflineV5Repository) ReplaceSelections(ctx context.Context, grantID, userID uuid.UUID, revision int64, items []domain.OfflineV3Selection) error {
	v4 := &OfflineV4Repository{db: r.db}
	if err := v4.ReplaceSelections(ctx, grantID, userID, revision, items); err != nil {
		return err
	}
	_, err := r.db.Exec(ctx, `UPDATE offline_v5_manifests SET superseded_at=NOW()
		WHERE grant_id=$1 AND superseded_at IS NULL`, grantID)
	return err
}
