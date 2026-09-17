package repository

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

type OfflineV3AdminGrant struct {
	domain.OfflineV3Grant
	InstallationName   string `json:"installation_name"`
	PrincipalName      string `json:"principal_name"`
	BrowserName        string `json:"browser_name"`
	InstallationState  string `json:"installation_state"`
	PrincipalState     string `json:"principal_state"`
	BrowserState       string `json:"browser_state"`
	AuthorizationState string `json:"authorization_state"`
}

func (r *OfflineV3Repository) ListAdminGrants(ctx context.Context, limit int) ([]OfflineV3AdminGrant, error) {
	if limit < 1 || limit > 200 {
		limit = 100
	}
	rows, err := r.db.Query(ctx, `SELECT grant_item.id,grant_item.installation_id,grant_item.windows_principal_id,grant_item.browser_profile_id,
		grant_item.authorization_id,grant_item.user_id,grant_item.account_id,COALESCE(NULLIF(account_user.display_name,''),account_user.username),account.name,
		grant_item.state,grant_item.max_resources,grant_item.quota_bytes,grant_item.max_offline_seconds,
		account_user.offline_credential_epoch,account_user.offline_authority_epoch+epoch.authority_epoch,
		installation.revision,principal.revision,browser.revision,authz.revision,grant_item.revision,grant_item.selection_revision,grant_item.selection_digest,
		browser.browser_key_thumbprint,COALESCE(grant_key.signing_key_thumbprint,''),COALESCE(grant_key.encryption_key_thumbprint,''),(grant_key.id IS NOT NULL),
		grant_item.created_at,grant_item.updated_at,grant_item.last_lease_expires_at,grant_item.last_sync_at,
		COALESCE((SELECT array_agg(action.action_code ORDER BY action.action_code) FROM offline_v3_grant_actions action
		 WHERE action.grant_id=grant_item.id AND action.account_id=grant_item.account_id),'{}'::text[]),
		installation.display_name,principal.display_name,browser.browser_name,installation.state,principal.state,browser.state,authz.state
		FROM offline_v3_grants grant_item
		JOIN users account_user ON account_user.id=grant_item.user_id
		JOIN accounts account ON account.id=grant_item.account_id
		JOIN offline_v3_membership_epochs epoch ON epoch.user_id=grant_item.user_id AND epoch.account_id=grant_item.account_id
		JOIN offline_v3_installations installation ON installation.id=grant_item.installation_id
		JOIN offline_v3_windows_principals principal ON principal.id=grant_item.windows_principal_id AND principal.installation_id=grant_item.installation_id
		JOIN offline_v3_browser_profiles browser ON browser.id=grant_item.browser_profile_id AND browser.windows_principal_id=grant_item.windows_principal_id
		JOIN offline_v3_authorizations authz ON authz.id=grant_item.authorization_id AND authz.browser_profile_id=grant_item.browser_profile_id
		LEFT JOIN offline_v3_grant_keys grant_key ON grant_key.grant_id=grant_item.id AND grant_key.account_id=grant_item.account_id AND grant_key.state='active'
		ORDER BY grant_item.updated_at DESC,grant_item.id DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]OfflineV3AdminGrant, 0)
	for rows.Next() {
		var item OfflineV3AdminGrant
		if err := rows.Scan(&item.GrantID, &item.InstallationID, &item.WindowsPrincipalID, &item.BrowserProfileID,
			&item.AuthorizationID, &item.UserID, &item.AccountID, &item.UserDisplayName, &item.AccountName, &item.State,
			&item.MaxResources, &item.QuotaBytes, &item.MaxOfflineSeconds, &item.CredentialEpoch, &item.AuthorityEpoch,
			&item.InstallationRevision, &item.PrincipalRevision, &item.BrowserRevision, &item.AuthorizationRevision,
			&item.GrantRevision, &item.SelectionRevision, &item.SelectionDigest, &item.BrowserKeyThumbprint,
			&item.GrantSigningThumbprint, &item.GrantEncryptionThumbprint, &item.KeysReady, &item.CreatedAt, &item.UpdatedAt,
			&item.LastLeaseExpiresAt, &item.LastSyncAt, &item.Actions, &item.InstallationName, &item.PrincipalName, &item.BrowserName,
			&item.InstallationState, &item.PrincipalState, &item.BrowserState, &item.AuthorizationState); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

type OfflineV3AdminControlPlan struct {
	InstallationID  uuid.UUID
	GrantID         *uuid.UUID
	AccountID       *uuid.UUID
	Scope           string
	ScopeID         uuid.UUID
	CurrentRevision int64
	CurrentState    string
}

func (r *OfflineV3Repository) PlanAdminControl(ctx context.Context, scope string, scopeID uuid.UUID) (*OfflineV3AdminControlPlan, error) {
	if scopeID == uuid.Nil {
		return nil, ErrOfflineV3Invalid
	}
	plan := &OfflineV3AdminControlPlan{Scope: scope, ScopeID: scopeID}
	var err error
	switch scope {
	case "installation":
		plan.InstallationID = scopeID
		err = r.db.QueryRow(ctx, `SELECT revision,state FROM offline_v3_installations WHERE id=$1`, scopeID).Scan(&plan.CurrentRevision, &plan.CurrentState)
	case "windows_principal":
		err = r.db.QueryRow(ctx, `SELECT installation_id,revision,state FROM offline_v3_windows_principals WHERE id=$1`, scopeID).
			Scan(&plan.InstallationID, &plan.CurrentRevision, &plan.CurrentState)
	case "browser_profile":
		err = r.db.QueryRow(ctx, `SELECT installation_id,revision,state FROM offline_v3_browser_profiles WHERE id=$1`, scopeID).
			Scan(&plan.InstallationID, &plan.CurrentRevision, &plan.CurrentState)
	case "authorization":
		err = r.db.QueryRow(ctx, `SELECT installation_id,revision,state FROM offline_v3_authorizations WHERE id=$1`, scopeID).
			Scan(&plan.InstallationID, &plan.CurrentRevision, &plan.CurrentState)
	case "grant":
		var grantID, accountID uuid.UUID
		err = r.db.QueryRow(ctx, `SELECT installation_id,id,account_id,revision,state FROM offline_v3_grants WHERE id=$1`, scopeID).
			Scan(&plan.InstallationID, &grantID, &accountID, &plan.CurrentRevision, &plan.CurrentState)
		plan.GrantID, plan.AccountID = &grantID, &accountID
	default:
		return nil, ErrOfflineV3Invalid
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrOfflineV3NotFound
	}
	if err != nil {
		return nil, err
	}
	return plan, nil
}

func offlineV3AdminControlTable(scope string) (string, bool) {
	switch scope {
	case "installation":
		return "offline_v3_installations", true
	case "windows_principal":
		return "offline_v3_windows_principals", true
	case "browser_profile":
		return "offline_v3_browser_profiles", true
	case "authorization":
		return "offline_v3_authorizations", true
	case "grant":
		return "offline_v3_grants", true
	default:
		return "", false
	}
}

func (r *OfflineV3Repository) ApplyAdminControl(ctx context.Context, plan OfflineV3AdminControlPlan, control domain.OfflineV3Control, actorID uuid.UUID) error {
	table, ok := offlineV3AdminControlTable(plan.Scope)
	if !ok || actorID == uuid.Nil || control.ID == uuid.Nil || control.InstallationID != plan.InstallationID ||
		control.Scope != plan.Scope || control.ScopeID != plan.ScopeID || control.Revision != plan.CurrentRevision+1 ||
		(control.Action != "lock" && control.Action != "wipe") || control.Reason != map[bool]string{true: "admin_revoked", false: "security_lock"}[control.Action == "wipe"] ||
		strings.TrimSpace(control.Token) == "" || strings.TrimSpace(control.KeyID) == "" || control.KeyVersion < 3 {
		return ErrOfflineV3Invalid
	}
	if (plan.GrantID == nil) != (plan.AccountID == nil) || (control.GrantID == nil) != (control.AccountID == nil) {
		return ErrOfflineV3Invalid
	}
	if plan.GrantID != nil && (control.GrantID == nil || *control.GrantID != *plan.GrantID || *control.AccountID != *plan.AccountID) {
		return ErrOfflineV3Invalid
	}
	tx, err := r.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	userRows, err := tx.Query(ctx, `SELECT DISTINCT user_id FROM offline_v3_grants WHERE
		($1='installation' AND installation_id=$2) OR ($1='windows_principal' AND windows_principal_id=$2) OR
		($1='browser_profile' AND browser_profile_id=$2) OR ($1='authorization' AND authorization_id=$2) OR
		($1='grant' AND id=$2) ORDER BY user_id`, plan.Scope, plan.ScopeID)
	if err != nil {
		return err
	}
	userIDs := make([]uuid.UUID, 0)
	for userRows.Next() {
		var userID uuid.UUID
		if err := userRows.Scan(&userID); err != nil {
			userRows.Close()
			return err
		}
		userIDs = append(userIDs, userID)
	}
	if err := userRows.Err(); err != nil {
		userRows.Close()
		return err
	}
	userRows.Close()
	sort.Slice(userIDs, func(i, j int) bool { return userIDs[i].String() < userIDs[j].String() })
	for _, userID := range userIDs {
		if err := lockUserAuthorityTx(ctx, tx, userID); err != nil {
			return err
		}
	}
	state := "locked"
	if control.Action == "wipe" {
		state = "revoked"
	}
	query := fmt.Sprintf(`UPDATE %s SET state=$3::varchar,revision=revision+1,updated_at=NOW(),revoked_at=CASE WHEN $3::varchar='revoked' THEN NOW() ELSE revoked_at END
		WHERE id=$1 AND revision=$2 AND state<>'revoked'`, table)
	tag, err := tx.Exec(ctx, query, plan.ScopeID, plan.CurrentRevision, state)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrOfflineV3Conflict
	}
	if _, err := tx.Exec(ctx, `INSERT INTO offline_v3_controls(id,installation_id,grant_id,account_id,scope,scope_id,revision,action,reason,token,key_id,key_version,created_by)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, control.ID, control.InstallationID, control.GrantID,
		control.AccountID, control.Scope, control.ScopeID, control.Revision, control.Action, control.Reason, control.Token,
		control.KeyID, control.KeyVersion, actorID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO offline_v3_audit(installation_id,grant_id,account_id,actor_id,event_type,metadata)
		VALUES($1,$2,$3,$4,'admin_control',jsonb_build_object('scope',$5::text,'scope_id',$6::text,'action',$7::text))`,
		plan.InstallationID, plan.GrantID, plan.AccountID, actorID, plan.Scope, plan.ScopeID.String(), control.Action); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *OfflineV3Repository) PlanAdminGrantControls(ctx context.Context, target string, targetID, installationID uuid.UUID) ([]OfflineV3AdminControlPlan, error) {
	if targetID == uuid.Nil {
		return nil, ErrOfflineV3Invalid
	}
	where := ""
	args := []any{targetID}
	switch target {
	case "account":
		where = "account_id=$1"
	case "user":
		where = "user_id=$1"
	case "installation_account":
		if installationID == uuid.Nil {
			return nil, ErrOfflineV3Invalid
		}
		where, args = "account_id=$1 AND installation_id=$2", append(args, installationID)
	case "installation_user":
		if installationID == uuid.Nil {
			return nil, ErrOfflineV3Invalid
		}
		where, args = "user_id=$1 AND installation_id=$2", append(args, installationID)
	default:
		return nil, ErrOfflineV3Invalid
	}
	rows, err := r.db.Query(ctx, `SELECT installation_id,id,account_id,revision,state FROM offline_v3_grants WHERE `+where+`
		AND state<>'revoked' ORDER BY id LIMIT 1001`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	plans := make([]OfflineV3AdminControlPlan, 0)
	for rows.Next() {
		var plan OfflineV3AdminControlPlan
		var grantID, accountID uuid.UUID
		plan.Scope = "grant"
		if err := rows.Scan(&plan.InstallationID, &grantID, &accountID, &plan.CurrentRevision, &plan.CurrentState); err != nil {
			return nil, err
		}
		plan.ScopeID, plan.GrantID, plan.AccountID = grantID, &grantID, &accountID
		plans = append(plans, plan)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(plans) == 0 {
		return nil, ErrOfflineV3NotFound
	}
	if len(plans) > 1000 {
		return nil, ErrOfflineV3Invalid
	}
	return plans, nil
}

// ApplyAdminGrantControls atomically revokes every grant selected by an
// account/user aggregate plan. All signatures are prepared first; a stale row
// aborts the transaction, preventing a misleading partial global revocation.
func (r *OfflineV3Repository) ApplyAdminGrantControls(ctx context.Context, plans []OfflineV3AdminControlPlan, controls []domain.OfflineV3Control, actorID uuid.UUID) error {
	if actorID == uuid.Nil || len(plans) == 0 || len(plans) != len(controls) || len(plans) > 1000 {
		return ErrOfflineV3Invalid
	}
	userSet := map[uuid.UUID]struct{}{}
	for index, plan := range plans {
		control := controls[index]
		if plan.Scope != "grant" || plan.GrantID == nil || plan.AccountID == nil || control.GrantID == nil || control.AccountID == nil ||
			control.InstallationID != plan.InstallationID || control.Scope != "grant" || control.ScopeID != *plan.GrantID ||
			*control.GrantID != *plan.GrantID || *control.AccountID != *plan.AccountID || control.Revision != plan.CurrentRevision+1 ||
			control.Action != "wipe" || control.Reason != "admin_revoked" || control.ID == uuid.Nil || strings.TrimSpace(control.Token) == "" ||
			strings.TrimSpace(control.KeyID) == "" || control.KeyVersion < 3 {
			return ErrOfflineV3Invalid
		}
		var userID uuid.UUID
		if err := r.db.QueryRow(ctx, `SELECT user_id FROM offline_v3_grants WHERE id=$1 AND account_id=$2`, *plan.GrantID, *plan.AccountID).Scan(&userID); err != nil {
			return err
		}
		userSet[userID] = struct{}{}
	}
	userIDs := make([]uuid.UUID, 0, len(userSet))
	for userID := range userSet {
		userIDs = append(userIDs, userID)
	}
	sort.Slice(userIDs, func(i, j int) bool { return userIDs[i].String() < userIDs[j].String() })
	tx, err := r.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	for _, userID := range userIDs {
		if err := lockUserAuthorityTx(ctx, tx, userID); err != nil {
			return err
		}
	}
	for index, plan := range plans {
		control := controls[index]
		tag, err := tx.Exec(ctx, `UPDATE offline_v3_grants SET state='revoked',revision=revision+1,updated_at=NOW(),revoked_at=NOW()
			WHERE id=$1 AND account_id=$2 AND revision=$3 AND state<>'revoked'`, *plan.GrantID, *plan.AccountID, plan.CurrentRevision)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return ErrOfflineV3Conflict
		}
		if _, err := tx.Exec(ctx, `INSERT INTO offline_v3_controls(id,installation_id,grant_id,account_id,scope,scope_id,revision,action,reason,token,key_id,key_version,created_by)
			VALUES($1,$2,$3,$4,'grant',$3,$5,'wipe','admin_revoked',$6,$7,$8,$9)`, control.ID, control.InstallationID,
			*control.GrantID, *control.AccountID, control.Revision, control.Token, control.KeyID, control.KeyVersion, actorID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO offline_v3_audit(installation_id,grant_id,account_id,actor_id,event_type,metadata)
			VALUES($1,$2::uuid,$3,$4,'admin_control',jsonb_build_object('scope','grant','scope_id',($2::uuid)::text,'action','wipe'))`,
			control.InstallationID, *control.GrantID, *control.AccountID, actorID); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
