package repository

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

var ErrLeadsDisabled = errors.New("El módulo Leads está desactivado para esta cuenta")
var ErrLeadAutomationDisabled = errors.New("Los automatismos comerciales están pausados para esta cuenta")
var ErrLeadPolicyConflict = errors.New("La configuración de Leads cambió; vuelve a revisarla")

type leadPolicyQueryer interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}
type leadPolicyContextKey struct{}
type leadPolicyLeaseKey struct{}
type leadPolicyLease struct {
	AccountID uuid.UUID
	Policy    domain.LeadPolicy
}
type leadPolicyExpectation struct {
	Version    int64
	OccurredAt time.Time
	Automatic  bool
}

func WithLeadPolicyVersion(ctx context.Context, version int64) context.Context {
	return context.WithValue(ctx, leadPolicyContextKey{}, leadPolicyExpectation{Version: version})
}
func WithLeadAutomationPolicy(ctx context.Context, version int64, occurredAt time.Time) context.Context {
	return context.WithValue(ctx, leadPolicyContextKey{}, leadPolicyExpectation{Version: version, OccurredAt: occurredAt, Automatic: true})
}

func readLeadPolicy(ctx context.Context, q leadPolicyQueryer, accountID uuid.UUID, lock bool) (*domain.LeadPolicy, error) {
	query := `SELECT leads_enabled,lead_automation_enabled,leads_policy_version,lead_automation_enabled_since FROM accounts WHERE id=$1`
	if lock {
		query += ` FOR SHARE`
	}
	p := &domain.LeadPolicy{}
	err := q.QueryRow(ctx, query, accountID).Scan(&p.LeadsEnabled, &p.LeadAutomationEnabled, &p.Version, &p.AutomationEnabledSince)
	return p, err
}
func (r *AccountRepository) GetLeadPolicy(ctx context.Context, accountID uuid.UUID) (*domain.LeadPolicy, error) {
	return readLeadPolicy(ctx, r.db, accountID, false)
}
func (r *AccountRepository) RequireLeadsEnabled(ctx context.Context, accountID uuid.UUID) error {
	p, err := r.GetLeadPolicy(ctx, accountID)
	if err != nil {
		return err
	}
	return validateLeadPolicy(ctx, *p)
}

// CaptureLeadAutomationContext binds the source activity before an asynchronous
// dispatch. An existing expectation is validated, never relabelled as new work.
func (r *AccountRepository) CaptureLeadAutomationContext(ctx context.Context, accountID uuid.UUID, occurredAt time.Time) (context.Context, error) {
	p, err := r.GetLeadPolicy(ctx, accountID)
	if err != nil {
		return ctx, err
	}
	if err = validateLeadPolicy(ctx, *p); err != nil {
		return ctx, err
	}
	if !p.AllowsAutomaticEvent(p.Version, occurredAt) {
		return ctx, ErrLeadAutomationDisabled
	}
	if _, ok := ctx.Value(leadPolicyContextKey{}).(leadPolicyExpectation); ok {
		return ctx, nil
	}
	return WithLeadAutomationPolicy(ctx, p.Version, occurredAt), nil
}

// AcquireLeadMutation serializes a short local mutation against policy updates.
// Never retain this lease while waiting for a provider, user or background job.
func (r *AccountRepository) AcquireLeadMutation(ctx context.Context, accountID uuid.UUID) (context.Context, func(), error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return ctx, nil, err
	}
	p, err := readLeadPolicy(ctx, tx, accountID, true)
	if err == nil {
		err = validateLeadPolicy(ctx, *p)
	}
	if err != nil {
		_ = tx.Rollback(context.Background())
		return ctx, nil, err
	}
	return context.WithValue(ctx, leadPolicyLeaseKey{}, leadPolicyLease{AccountID: accountID, Policy: *p}), func() { _ = tx.Rollback(context.Background()) }, nil
}
func validateLeadPolicy(ctx context.Context, p domain.LeadPolicy) error {
	if !p.LeadsEnabled {
		return ErrLeadsDisabled
	}
	if version, ok := ctx.Value("clarin.leads_policy_version").(int64); ok && version != p.Version {
		return ErrLeadPolicyConflict
	}
	if version, ok := ctx.Value("clarin.lead_automation_version").(int64); ok && (!p.AutomationEnabled() || version != p.Version) {
		return ErrLeadAutomationDisabled
	}
	if expected, ok := ctx.Value(leadPolicyContextKey{}).(leadPolicyExpectation); ok {
		if expected.Version != p.Version {
			return ErrLeadPolicyConflict
		}
		if expected.Automatic && !p.AllowsAutomaticEvent(expected.Version, expected.OccurredAt) {
			return ErrLeadAutomationDisabled
		}
	}
	return nil
}

func (r *TagRepository) AddContactTagByName(ctx context.Context, accountID, contactID uuid.UUID, name string) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var valid bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM contacts WHERE id=$1 AND account_id=$2)`, contactID, accountID).Scan(&valid); err != nil {
		return err
	}
	if !valid {
		return pgx.ErrNoRows
	}
	var tagID uuid.UUID
	err = tx.QueryRow(ctx, `INSERT INTO tags(account_id,name,color) VALUES($1,$2,'#6366f1') ON CONFLICT(account_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id`, accountID, name).Scan(&tagID)
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO contact_tags(contact_id,tag_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, contactID, tagID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *TagRepository) mutateLeadTag(ctx context.Context, leadID, tagID uuid.UUID, assign bool) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var accountID, contactID uuid.UUID
	if err = tx.QueryRow(ctx, `SELECT account_id,contact_id FROM leads WHERE id=$1 AND deleted_at IS NULL`, leadID).Scan(&accountID, &contactID); err != nil {
		return err
	}
	if err = requireLeadPolicyTx(ctx, tx, accountID); err != nil {
		return err
	}
	if assign {
		_, err = tx.Exec(ctx, `INSERT INTO contact_tags(contact_id,tag_id) SELECT $1,id FROM tags WHERE id=$2 AND account_id=$3 ON CONFLICT DO NOTHING`, contactID, tagID, accountID)
	} else {
		_, err = tx.Exec(ctx, `DELETE FROM contact_tags ct USING tags t WHERE ct.contact_id=$1 AND ct.tag_id=$2 AND t.id=ct.tag_id AND t.account_id=$3`, contactID, tagID, accountID)
	}
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func requireLeadPolicyTx(ctx context.Context, tx pgx.Tx, accountID uuid.UUID) error {
	if lease, ok := ctx.Value(leadPolicyLeaseKey{}).(leadPolicyLease); ok && lease.AccountID == accountID {
		return validateLeadPolicy(ctx, lease.Policy)
	}
	p, err := readLeadPolicy(ctx, tx, accountID, true)
	if err != nil {
		return err
	}
	return validateLeadPolicy(ctx, *p)
}

// Structural pipeline writes also change the account's incoming stage. Acquire
// their final lock mode up front instead of upgrading competing shared locks.
func requireLeadPolicyForAccountUpdateTx(ctx context.Context, tx pgx.Tx, accountID uuid.UUID) error {
	p := domain.LeadPolicy{}
	err := tx.QueryRow(ctx, `SELECT leads_enabled,lead_automation_enabled,leads_policy_version,lead_automation_enabled_since FROM accounts WHERE id=$1 FOR UPDATE`, accountID).Scan(&p.LeadsEnabled, &p.LeadAutomationEnabled, &p.Version, &p.AutomationEnabledSince)
	if err != nil {
		return err
	}
	return validateLeadPolicy(ctx, p)
}

func (r *AccountRepository) UpdateLeadPolicy(ctx context.Context, accountID, actorID uuid.UUID, expectedVersion int64, leadsEnabled, automationEnabled bool) (*domain.LeadPolicy, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	previous := &domain.LeadPolicy{}
	err = tx.QueryRow(ctx, `SELECT leads_enabled,lead_automation_enabled,leads_policy_version,lead_automation_enabled_since FROM accounts WHERE id=$1 FOR UPDATE`, accountID).Scan(&previous.LeadsEnabled, &previous.LeadAutomationEnabled, &previous.Version, &previous.AutomationEnabledSince)
	if err != nil {
		return nil, err
	}
	if previous.Version != expectedVersion {
		return previous, ErrLeadPolicyConflict
	}
	if previous.LeadsEnabled == leadsEnabled && previous.LeadAutomationEnabled == automationEnabled {
		return previous, tx.Commit(ctx)
	}
	next := *previous
	next.LeadsEnabled = leadsEnabled
	next.LeadAutomationEnabled = automationEnabled
	next.Version++
	if !previous.AutomationEnabled() && next.AutomationEnabled() {
		now := time.Now().UTC()
		next.AutomationEnabledSince = &now
	}
	_, err = tx.Exec(ctx, `UPDATE accounts SET leads_enabled=$2,lead_automation_enabled=$3,leads_policy_version=$4,lead_automation_enabled_since=$5,updated_at=NOW() WHERE id=$1`, accountID, next.LeadsEnabled, next.LeadAutomationEnabled, next.Version, next.AutomationEnabledSince)
	if err != nil {
		return nil, err
	}
	before, _ := json.Marshal(previous)
	after, _ := json.Marshal(next)
	_, err = tx.Exec(ctx, `INSERT INTO account_lead_policy_audit(account_id,actor_id,previous_policy,next_policy) VALUES($1,$2,$3,$4)`, accountID, actorID, before, after)
	if err != nil {
		return nil, err
	}
	// Preserve executions as cancelled history; a stale worker cannot revive them.
	if !next.AutomationEnabled() {
		_, err = tx.Exec(ctx, `UPDATE automation_executions SET status='failed',error_message='lead_policy_paused',completed_at=NOW(),resume_at=NULL
		 WHERE account_id=$1 AND status IN ('pending','running','paused') AND
		 (lead_id IS NOT NULL OR EXISTS (
		   SELECT 1 FROM jsonb_array_elements(COALESCE(config_snapshot->'nodes','[]'::jsonb)) AS node
		   WHERE node->'data'->>'nodeType' IN ('send_whatsapp','change_stage','assign_tag','remove_tag','condition','lead_created','lead_stage_changed','tag_assigned','tag_removed')
		 ))`, accountID)
		if err != nil {
			return nil, err
		}
	}
	if !next.LeadsEnabled {
		_, err = tx.Exec(ctx, `UPDATE lead_intelligence_report_runs SET status='cancelled',phase='cancelled',cancel_requested=TRUE,completed_at=NOW(),heartbeat_at=NULL,updated_at=NOW() WHERE account_id=$1 AND status IN ('queued','running')`, accountID)
		if err != nil {
			return nil, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &next, nil
}

// EnsureAutomaticLead serializes only this Contact's create-if-missing decision.
// Multiple legitimate manually created opportunities remain supported.
func (r *LeadRepository) EnsureAutomaticLead(ctx context.Context, lead *domain.Lead, version int64, occurredAt time.Time) (bool, error) {
	ctx = WithLeadAutomationPolicy(ctx, version, occurredAt)
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	if err = requireLeadPolicyTx(ctx, tx, lead.AccountID); err != nil {
		return false, err
	}
	if lead.ContactID == nil {
		return false, errors.New("lead contact_id is required")
	}
	var contact uuid.UUID
	if err = tx.QueryRow(ctx, `SELECT id FROM contacts WHERE id=$1 AND account_id=$2 AND is_group=FALSE FOR UPDATE`, *lead.ContactID, lead.AccountID).Scan(&contact); err != nil {
		return false, err
	}
	var existing uuid.UUID
	err = tx.QueryRow(ctx, `SELECT id FROM leads WHERE account_id=$1 AND contact_id=$2 AND deleted_at IS NULL ORDER BY created_at,id LIMIT 1`, lead.AccountID, contact).Scan(&existing)
	if err == nil {
		lead.ID = existing
		return false, tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return false, err
	}
	if err = r.createLeadWith(ctx, tx, lead); err != nil {
		return false, err
	}
	return true, tx.Commit(ctx)
}

func (r *LeadRepository) mutateLeadFlags(ctx context.Context, ids []uuid.UUID, flag string, enabled bool, reason string) error {
	if len(ids) == 0 {
		return nil
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `SELECT DISTINCT account_id FROM leads WHERE id=ANY($1) ORDER BY account_id`, ids)
	if err != nil {
		return err
	}
	var accounts []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		accounts = append(accounts, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if len(accounts) == 0 {
		return pgx.ErrNoRows
	}
	if len(accounts) != 1 {
		return errors.New("lead mutation must belong to one account")
	}
	if err = requireLeadPolicyTx(ctx, tx, accounts[0]); err != nil {
		return err
	}
	query := `UPDATE leads SET is_archived=$3,archived_at=CASE WHEN $3 THEN NOW() ELSE NULL END,archive_reason=CASE WHEN $3 THEN $4 ELSE '' END,updated_at=NOW() WHERE account_id=$1 AND id=ANY($2)`
	if flag == "blocked" {
		query = `UPDATE leads SET is_blocked=$3,blocked_at=CASE WHEN $3 THEN NOW() ELSE NULL END,block_reason=CASE WHEN $3 THEN $4 ELSE '' END,updated_at=NOW() WHERE account_id=$1 AND id=ANY($2)`
	}
	if _, err = tx.Exec(ctx, query, accounts[0], ids, enabled, reason); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *LeadRepository) ArchiveActiveForAccount(ctx context.Context, accountID uuid.UUID, ids []uuid.UUID, archive bool, reason string) (int64, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	if err = requireLeadPolicyTx(ctx, tx, accountID); err != nil {
		return 0, err
	}
	tag, err := tx.Exec(ctx, `UPDATE leads SET is_archived=$3,archived_at=CASE WHEN $3 THEN NOW() ELSE NULL END,archive_reason=CASE WHEN $3 THEN $4 ELSE '' END,updated_at=NOW() WHERE account_id=$1 AND id=ANY($2) AND deleted_at IS NULL`, accountID, ids, archive, reason)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), tx.Commit(ctx)
}
