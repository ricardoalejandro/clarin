package repository

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/formula"
)

var (
	ErrEventRuleVersionConflict = errors.New("event rule version conflict")
	ErrEventRulePreviewStale    = errors.New("event rule preview is stale")
	ErrEventMembershipFrozen    = errors.New("event membership is frozen")
	ErrEventMembershipAuditOnly = errors.New("event membership policy is audit only")
	ErrEventStatusConflict      = errors.New("event status conflict")
	ErrEventParticipantInactive = errors.New("event participant is missing or inactive")
	ErrEventStageMismatch       = errors.New("event stage does not belong to event pipeline")
)

type EventRuleConfig struct {
	FormulaType string      `json:"tag_formula_type"`
	FormulaMode string      `json:"formula_mode"`
	Formula     string      `json:"tag_formula"`
	Includes    []uuid.UUID `json:"include_tag_ids"`
	Excludes    []uuid.UUID `json:"exclude_tag_ids"`
}

func (c EventRuleConfig) HasRules() bool {
	if strings.EqualFold(c.FormulaType, "advanced") {
		return strings.TrimSpace(c.Formula) != ""
	}
	return len(c.Includes) > 0 || len(c.Excludes) > 0
}

type EventMembershipImpact struct {
	Created      int    `json:"created"`
	Activated    int    `json:"activated"`
	Deactivated  int    `json:"deactivated"`
	Unchanged    int    `json:"unchanged"`
	Matched      int    `json:"matched"`
	ActiveNow    int    `json:"active_now"`
	BroadRule    bool   `json:"broad_rule"`
	HasRules     bool   `json:"has_rules"`
	RuleRevision int64  `json:"rule_revision"`
	Fingerprint  string `json:"fingerprint"`
	PolicyMode   string `json:"policy_mode"`
	Applied      bool   `json:"applied"`
}

type EventMembershipAuditEntry struct {
	ID            uuid.UUID       `json:"id"`
	Action        string          `json:"action"`
	ParticipantID *uuid.UUID      `json:"participant_id,omitempty"`
	ContactID     *uuid.UUID      `json:"contact_id,omitempty"`
	ActorType     string          `json:"actor_type"`
	ActorUserID   *uuid.UUID      `json:"actor_user_id,omitempty"`
	Source        string          `json:"source"`
	RuleRevision  int64           `json:"rule_revision"`
	BeforeState   json.RawMessage `json:"before_state"`
	AfterState    json.RawMessage `json:"after_state"`
	Metadata      json.RawMessage `json:"metadata"`
	CreatedAt     string          `json:"created_at"`
}

func shouldApplyActivationRules(policyMode string, config EventRuleConfig) bool {
	return policyMode == "strict" && normalizeRuleConfig(config).HasRules()
}

// ActivateEventAndReconcile updates draft -> active and applies its initial
// rule membership in the same transaction. In audit_only accounts activation
// still succeeds, but the calculated impact remains unapplied by design.
func (r *EventRepository) ActivateEventAndReconcile(ctx context.Context, event *domain.Event, actor *uuid.UUID) (EventMembershipImpact, error) {
	if event == nil {
		return EventMembershipImpact{}, fmt.Errorf("event is required")
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return EventMembershipImpact{}, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1::text))`, event.AccountID); err != nil {
		return EventMembershipImpact{}, err
	}

	var currentStatus string
	var revision int64
	var config EventRuleConfig
	if err := tx.QueryRow(ctx, `
		SELECT status,rule_revision,tag_formula_type,tag_formula_mode,tag_formula
		FROM events WHERE id=$1 AND account_id=$2 FOR UPDATE
	`, event.ID, event.AccountID).Scan(&currentStatus, &revision, &config.FormulaType, &config.FormulaMode, &config.Formula); err != nil {
		return EventMembershipImpact{}, err
	}
	if currentStatus != domain.EventStatusDraft {
		return EventMembershipImpact{}, ErrEventStatusConflict
	}

	rows, err := tx.Query(ctx, `SELECT tag_id,negate FROM event_tags WHERE event_id=$1`, event.ID)
	if err != nil {
		return EventMembershipImpact{}, err
	}
	for rows.Next() {
		var tagID uuid.UUID
		var negate bool
		if err := rows.Scan(&tagID, &negate); err != nil {
			rows.Close()
			return EventMembershipImpact{}, err
		}
		if negate {
			config.Excludes = append(config.Excludes, tagID)
		} else {
			config.Includes = append(config.Includes, tagID)
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return EventMembershipImpact{}, err
	}
	rows.Close()
	config = normalizeRuleConfig(config)

	event.Status = domain.EventStatusActive
	event.UpdatedAt = time.Now()
	result, err := tx.Exec(ctx, `
		UPDATE events SET name=$1,description=$2,event_date=$3,event_end=$4,location=$5,status='active',color=$6,pipeline_id=$7,updated_at=$8
		WHERE id=$9 AND account_id=$10 AND status='draft'
	`, event.Name, event.Description, event.EventDate, event.EventEnd, event.Location, event.Color, event.PipelineID, event.UpdatedAt, event.ID, event.AccountID)
	if err != nil {
		return EventMembershipImpact{}, err
	}
	if result.RowsAffected() != 1 {
		return EventMembershipImpact{}, ErrEventStatusConflict
	}

	var policyMode string
	if err := tx.QueryRow(ctx, `SELECT COALESCE((SELECT mode FROM event_membership_policy_state WHERE account_id=$1),'audit_only')`, event.AccountID).Scan(&policyMode); err != nil {
		return EventMembershipImpact{}, err
	}
	matched := make([]uuid.UUID, 0)
	if config.HasRules() {
		matched, err = queryMatchedContactIDs(ctx, tx, event.AccountID, config)
		if err != nil {
			return EventMembershipImpact{}, err
		}
	}

	var impact EventMembershipImpact
	if shouldApplyActivationRules(policyMode, config) {
		stageID, stageErr := defaultEventStageTx(ctx, tx, event.PipelineID)
		if stageErr != nil {
			return EventMembershipImpact{}, stageErr
		}
		impact, err = applyMatchedMembership(ctx, tx, event.AccountID, event.ID, stageID, config, matched, revision, "event_activated", actor)
	} else {
		impact, err = membershipImpact(ctx, tx, event.ID, config, matched)
	}
	if err != nil {
		return EventMembershipImpact{}, err
	}
	impact.PolicyMode = policyMode
	impact.RuleRevision = revision
	impact.Fingerprint = membershipFingerprint(revision, config, matched)
	if err := tx.Commit(ctx); err != nil {
		return EventMembershipImpact{}, err
	}
	return impact, nil
}

func normalizeRuleConfig(cfg EventRuleConfig) EventRuleConfig {
	cfg.FormulaType = strings.ToLower(strings.TrimSpace(cfg.FormulaType))
	if cfg.FormulaType == "" {
		cfg.FormulaType = "simple"
	}
	cfg.FormulaMode = strings.ToUpper(strings.TrimSpace(cfg.FormulaMode))
	if cfg.FormulaMode == "" {
		cfg.FormulaMode = "OR"
	}
	cfg.Formula = strings.TrimSpace(cfg.Formula)
	sort.Slice(cfg.Includes, func(i, j int) bool { return cfg.Includes[i].String() < cfg.Includes[j].String() })
	sort.Slice(cfg.Excludes, func(i, j int) bool { return cfg.Excludes[i].String() < cfg.Excludes[j].String() })
	if cfg.FormulaType == "advanced" {
		cfg.Includes = nil
		cfg.Excludes = nil
	}
	return cfg
}

func (r *EventRepository) GetMembershipPolicy(ctx context.Context, accountID uuid.UUID) (string, error) {
	if _, err := r.db.Exec(ctx, `INSERT INTO event_membership_policy_state (account_id) VALUES ($1) ON CONFLICT DO NOTHING`, accountID); err != nil {
		return "", err
	}
	var mode string
	err := r.db.QueryRow(ctx, `SELECT mode FROM event_membership_policy_state WHERE account_id=$1`, accountID).Scan(&mode)
	return mode, err
}

func (r *EventRepository) SetMembershipPolicy(ctx context.Context, accountID uuid.UUID, mode string, actor *uuid.UUID) error {
	if mode != "audit_only" && mode != "strict" {
		return fmt.Errorf("invalid membership policy mode")
	}
	_, err := r.db.Exec(ctx, `
		INSERT INTO event_membership_policy_state (account_id,mode,audited_at,enabled_at,enabled_by,updated_at)
		VALUES ($1,$2,CASE WHEN $2='audit_only' THEN NOW() ELSE NULL END,CASE WHEN $2='strict' THEN NOW() ELSE NULL END,$3,NOW())
		ON CONFLICT (account_id) DO UPDATE SET mode=EXCLUDED.mode,
			audited_at=COALESCE(event_membership_policy_state.audited_at,EXCLUDED.audited_at),
			enabled_at=EXCLUDED.enabled_at,enabled_by=EXCLUDED.enabled_by,updated_at=NOW()
	`, accountID, mode, actor)
	return err
}

func queryMatchedContactIDs(ctx context.Context, q pgx.Tx, accountID uuid.UUID, cfg EventRuleConfig) ([]uuid.UUID, error) {
	cfg = normalizeRuleConfig(cfg)
	if !cfg.HasRules() {
		return nil, nil
	}
	var rows pgx.Rows
	var err error
	if cfg.FormulaType == "advanced" {
		ast, parseErr := formula.Parse(cfg.Formula)
		if parseErr != nil {
			return nil, parseErr
		}
		sql, args, buildErr := formula.BuildSQLForContacts(ast, accountID)
		if buildErr != nil {
			return nil, buildErr
		}
		rows, err = q.Query(ctx, sql, args...)
	} else if len(cfg.Includes) == 0 {
		rows, err = q.Query(ctx, `
			SELECT c.id FROM contacts c
			WHERE c.account_id=$1 AND c.is_group=FALSE
			  AND NOT EXISTS (SELECT 1 FROM contact_tags ct WHERE ct.contact_id=c.id AND ct.tag_id=ANY($2))
		`, accountID, cfg.Excludes)
	} else if cfg.FormulaMode == "AND" {
		rows, err = q.Query(ctx, `
			SELECT c.id FROM contacts c JOIN contact_tags ct ON ct.contact_id=c.id
			WHERE c.account_id=$1 AND c.is_group=FALSE AND ct.tag_id=ANY($2)
			  AND NOT EXISTS (SELECT 1 FROM contact_tags excluded WHERE excluded.contact_id=c.id AND excluded.tag_id=ANY($3))
			GROUP BY c.id HAVING COUNT(DISTINCT ct.tag_id)=$4
		`, accountID, cfg.Includes, cfg.Excludes, len(cfg.Includes))
	} else {
		rows, err = q.Query(ctx, `
			SELECT DISTINCT c.id FROM contacts c JOIN contact_tags ct ON ct.contact_id=c.id
			WHERE c.account_id=$1 AND c.is_group=FALSE AND ct.tag_id=ANY($2)
			  AND NOT EXISTS (SELECT 1 FROM contact_tags excluded WHERE excluded.contact_id=c.id AND excluded.tag_id=ANY($3))
		`, accountID, cfg.Includes, cfg.Excludes)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := make([]uuid.UUID, 0)
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func membershipFingerprint(revision int64, cfg EventRuleConfig, matched []uuid.UUID) string {
	cfg = normalizeRuleConfig(cfg)
	ids := make([]string, len(matched))
	for i, id := range matched {
		ids[i] = id.String()
	}
	sort.Strings(ids)
	payload, _ := json.Marshal(struct {
		Revision int64           `json:"revision"`
		Config   EventRuleConfig `json:"config"`
		Matched  []string        `json:"matched"`
	}{revision, cfg, ids})
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

func membershipImpact(ctx context.Context, q pgx.Tx, eventID uuid.UUID, cfg EventRuleConfig, matched []uuid.UUID) (EventMembershipImpact, error) {
	impact := EventMembershipImpact{Matched: len(matched), HasRules: cfg.HasRules(), BroadRule: cfg.HasRules() && ((cfg.FormulaType == "simple" && len(cfg.Includes) == 0) || (cfg.FormulaType == "advanced" && strings.Contains(strings.ToUpper(cfg.Formula), "NOT")))}
	if err := q.QueryRow(ctx, `SELECT COUNT(*) FROM event_participants WHERE event_id=$1 AND membership_state='active'`, eventID).Scan(&impact.ActiveNow); err != nil {
		return impact, err
	}
	if !cfg.HasRules() {
		impact.Unchanged = impact.ActiveNow
		return impact, nil
	}
	if err := q.QueryRow(ctx, `
		SELECT
			COUNT(*) FILTER (WHERE ep.id IS NULL),
			COUNT(*) FILTER (WHERE ep.membership_state='inactive'),
			COUNT(*) FILTER (WHERE ep.membership_state='active')
		FROM unnest($2::uuid[]) matched(contact_id)
		LEFT JOIN event_participants ep ON ep.event_id=$1 AND ep.contact_id=matched.contact_id
	`, eventID, matched).Scan(&impact.Created, &impact.Activated, &impact.Unchanged); err != nil {
		return impact, err
	}
	if err := q.QueryRow(ctx, `
		SELECT COUNT(*) FROM event_participants
		WHERE event_id=$1 AND membership_state='active'
		  AND (contact_id IS NULL OR NOT (contact_id=ANY($2::uuid[])))
	`, eventID, matched).Scan(&impact.Deactivated); err != nil {
		return impact, err
	}
	return impact, nil
}

func insertMembershipAudit(ctx context.Context, tx pgx.Tx, accountID, eventID, participantID uuid.UUID, contactID *uuid.UUID, action, source string, revision int64, actor *uuid.UUID, before, after, metadata string, correlationID uuid.UUID) error {
	actorType := "system"
	if actor != nil {
		actorType = "user"
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO crm_audit_events (account_id,category,action,event_id,participant_id,contact_id,actor_type,actor_user_id,source,correlation_id,rule_revision,before_state,after_state,metadata)
		VALUES ($1,'event_membership',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb)
	`, accountID, action, eventID, participantID, contactID, actorType, actor, source, correlationID, revision, before, after, metadata)
	return err
}

type membershipChange struct {
	participantID uuid.UUID
	contactID     *uuid.UUID
}

// pgx does not allow another statement on the same transaction while a Rows
// result is still open. Materialize RETURNING rows first, close them, and only
// then write the corresponding audit records.
func collectMembershipChanges(rows pgx.Rows) ([]membershipChange, error) {
	defer rows.Close()
	changes := make([]membershipChange, 0)
	for rows.Next() {
		var change membershipChange
		if err := rows.Scan(&change.participantID, &change.contactID); err != nil {
			return nil, err
		}
		changes = append(changes, change)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return changes, nil
}

func applyMatchedMembership(ctx context.Context, tx pgx.Tx, accountID, eventID uuid.UUID, stageID *uuid.UUID, cfg EventRuleConfig, matched []uuid.UUID, revision int64, source string, actor *uuid.UUID) (EventMembershipImpact, error) {
	impact, err := membershipImpact(ctx, tx, eventID, cfg, matched)
	if err != nil || !cfg.HasRules() {
		return impact, err
	}
	metadataBytes, _ := json.Marshal(map[string]interface{}{"rule": normalizeRuleConfig(cfg)})
	metadata := string(metadataBytes)
	correlationID := uuid.New()

	rows, err := tx.Query(ctx, `
		UPDATE event_participants SET membership_state='inactive',membership_reason='rule_ineligible',membership_changed_at=NOW(),updated_at=NOW()
		WHERE event_id=$1 AND membership_state='active'
		  AND (contact_id IS NULL OR NOT (contact_id=ANY($2::uuid[])))
		RETURNING id,contact_id
	`, eventID, matched)
	if err != nil {
		return impact, err
	}
	deactivated, err := collectMembershipChanges(rows)
	if err != nil {
		return impact, err
	}
	for _, change := range deactivated {
		if err := insertMembershipAudit(ctx, tx, accountID, eventID, change.participantID, change.contactID, "deactivated", source, revision, actor, `{"membership_state":"active"}`, `{"membership_state":"inactive","reason":"rule_ineligible"}`, metadata, correlationID); err != nil {
			return impact, err
		}
	}

	rows, err = tx.Query(ctx, `
		UPDATE event_participants SET membership_state='active',membership_reason='',membership_source='rule',auto_tag_sync=TRUE,membership_changed_at=NOW(),updated_at=NOW()
		WHERE event_id=$1 AND membership_state='inactive' AND contact_id=ANY($2::uuid[])
		RETURNING id,contact_id
	`, eventID, matched)
	if err != nil {
		return impact, err
	}
	reactivated, err := collectMembershipChanges(rows)
	if err != nil {
		return impact, err
	}
	for _, change := range reactivated {
		if err := insertMembershipAudit(ctx, tx, accountID, eventID, change.participantID, change.contactID, "reactivated", source, revision, actor, `{"membership_state":"inactive"}`, `{"membership_state":"active"}`, metadata, correlationID); err != nil {
			return impact, err
		}
	}

	rows, err = tx.Query(ctx, `
		INSERT INTO event_participants (id,event_id,contact_id,stage_id,name,last_name,short_name,phone,email,age,company,dni,birth_date,address,distrito,ocupacion,status,auto_tag_sync,membership_state,membership_reason,membership_source,membership_changed_at,invited_at,created_at,updated_at)
		SELECT gen_random_uuid(),$1,c.id,$4,COALESCE(c.custom_name,c.name,c.push_name,c.phone,c.jid),c.last_name,c.short_name,c.phone,c.email,c.age,c.company,c.dni,c.birth_date,c.address,c.distrito,c.ocupacion,'invited',TRUE,'active','','rule',NOW(),NOW(),NOW(),NOW()
		FROM contacts c WHERE c.account_id=$2 AND c.is_group=FALSE AND c.id=ANY($3::uuid[])
		ON CONFLICT (event_id,contact_id) WHERE contact_id IS NOT NULL DO NOTHING
		RETURNING id,contact_id
	`, eventID, accountID, matched, stageID)
	if err != nil {
		return impact, err
	}
	created, err := collectMembershipChanges(rows)
	if err != nil {
		return impact, err
	}
	for _, change := range created {
		if err := insertMembershipAudit(ctx, tx, accountID, eventID, change.participantID, change.contactID, "created", source, revision, actor, `{}`, `{"membership_state":"active","source":"rule"}`, metadata, correlationID); err != nil {
			return impact, err
		}
	}
	impact.Applied = true
	return impact, nil
}

func (r *EventRepository) PreviewEventRule(ctx context.Context, eventID, accountID uuid.UUID, cfg EventRuleConfig) (EventMembershipImpact, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return EventMembershipImpact{}, err
	}
	defer tx.Rollback(ctx)
	var revision int64
	if err := tx.QueryRow(ctx, `SELECT rule_revision FROM events WHERE id=$1 AND account_id=$2`, eventID, accountID).Scan(&revision); err != nil {
		return EventMembershipImpact{}, err
	}
	cfg = normalizeRuleConfig(cfg)
	matched, err := queryMatchedContactIDs(ctx, tx, accountID, cfg)
	if err != nil {
		return EventMembershipImpact{}, err
	}
	impact, err := membershipImpact(ctx, tx, eventID, cfg, matched)
	if err != nil {
		return EventMembershipImpact{}, err
	}
	impact.RuleRevision = revision
	impact.Fingerprint = membershipFingerprint(revision, cfg, matched)
	if err := tx.QueryRow(ctx, `SELECT COALESCE((SELECT mode FROM event_membership_policy_state WHERE account_id=$1),'audit_only')`, accountID).Scan(&impact.PolicyMode); err != nil {
		return EventMembershipImpact{}, err
	}
	return impact, tx.Commit(ctx)
}

func (r *EventRepository) SaveEventRule(ctx context.Context, eventID, accountID uuid.UUID, cfg EventRuleConfig, expectedRevision int64, previewFingerprint string, actor *uuid.UUID) (EventMembershipImpact, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return EventMembershipImpact{}, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1::text))`, accountID); err != nil {
		return EventMembershipImpact{}, err
	}
	var currentRevision int64
	var status string
	var pipelineID *uuid.UUID
	var oldType, oldMode, oldFormula string
	if err := tx.QueryRow(ctx, `SELECT rule_revision,status,pipeline_id,tag_formula_type,tag_formula_mode,tag_formula FROM events WHERE id=$1 AND account_id=$2 FOR UPDATE`, eventID, accountID).Scan(&currentRevision, &status, &pipelineID, &oldType, &oldMode, &oldFormula); err != nil {
		return EventMembershipImpact{}, err
	}
	if status == "completed" || status == "cancelled" {
		return EventMembershipImpact{}, ErrEventMembershipFrozen
	}
	if currentRevision != expectedRevision {
		return EventMembershipImpact{}, ErrEventRuleVersionConflict
	}
	cfg = normalizeRuleConfig(cfg)
	matched, err := queryMatchedContactIDs(ctx, tx, accountID, cfg)
	if err != nil {
		return EventMembershipImpact{}, err
	}
	impact, err := membershipImpact(ctx, tx, eventID, cfg, matched)
	if err != nil {
		return EventMembershipImpact{}, err
	}
	impact.RuleRevision = currentRevision
	impact.Fingerprint = membershipFingerprint(currentRevision, cfg, matched)
	if previewFingerprint == "" || impact.Fingerprint != previewFingerprint {
		return EventMembershipImpact{}, ErrEventRulePreviewStale
	}
	if _, err := tx.Exec(ctx, `UPDATE events SET tag_formula_type=$1,tag_formula_mode=$2,tag_formula=$3,rule_revision=rule_revision+1,updated_at=NOW() WHERE id=$4 AND account_id=$5`, cfg.FormulaType, cfg.FormulaMode, cfg.Formula, eventID, accountID); err != nil {
		return EventMembershipImpact{}, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM event_tags WHERE event_id=$1`, eventID); err != nil {
		return EventMembershipImpact{}, err
	}
	for _, id := range cfg.Includes {
		if _, err := tx.Exec(ctx, `INSERT INTO event_tags(event_id,tag_id,negate) VALUES($1,$2,FALSE)`, eventID, id); err != nil {
			return EventMembershipImpact{}, err
		}
	}
	for _, id := range cfg.Excludes {
		if _, err := tx.Exec(ctx, `INSERT INTO event_tags(event_id,tag_id,negate) VALUES($1,$2,TRUE)`, eventID, id); err != nil {
			return EventMembershipImpact{}, err
		}
	}
	newRevision := currentRevision + 1
	impact.RuleRevision = newRevision
	if err := tx.QueryRow(ctx, `SELECT COALESCE((SELECT mode FROM event_membership_policy_state WHERE account_id=$1),'audit_only')`, accountID).Scan(&impact.PolicyMode); err != nil {
		return EventMembershipImpact{}, err
	}
	if status == "active" && impact.PolicyMode == "strict" && cfg.HasRules() {
		var stageID *uuid.UUID
		if pipelineID != nil {
			var defaultStageID uuid.UUID
			if err := tx.QueryRow(ctx, `SELECT id FROM event_pipeline_stages WHERE pipeline_id=$1 ORDER BY position,created_at,id LIMIT 1`, *pipelineID).Scan(&defaultStageID); err == nil {
				stageID = &defaultStageID
			} else if err != pgx.ErrNoRows {
				return EventMembershipImpact{}, err
			}
		}
		impact, err = applyMatchedMembership(ctx, tx, accountID, eventID, stageID, cfg, matched, newRevision, "rule_change", actor)
		if err != nil {
			return EventMembershipImpact{}, err
		}
		impact.RuleRevision = newRevision
		impact.PolicyMode = "strict"
		impact.Fingerprint = membershipFingerprint(currentRevision, cfg, matched)
	}
	oldState, _ := json.Marshal(map[string]interface{}{"tag_formula_type": oldType, "formula_mode": oldMode, "tag_formula": oldFormula, "rule_revision": currentRevision})
	newState, _ := json.Marshal(map[string]interface{}{"tag_formula_type": cfg.FormulaType, "formula_mode": cfg.FormulaMode, "tag_formula": cfg.Formula, "include_tag_ids": cfg.Includes, "exclude_tag_ids": cfg.Excludes, "rule_revision": newRevision})
	actorType := "system"
	if actor != nil {
		actorType = "user"
	}
	if _, err := tx.Exec(ctx, `INSERT INTO crm_audit_events(account_id,category,action,event_id,actor_type,actor_user_id,source,rule_revision,before_state,after_state) VALUES($1,'event_rule','updated',$2,$3,$4,'event_rule_api',$5,$6::jsonb,$7::jsonb)`, accountID, eventID, actorType, actor, newRevision, string(oldState), string(newState)); err != nil {
		return EventMembershipImpact{}, err
	}
	return impact, tx.Commit(ctx)
}

func (r *EventRepository) ReconcileCurrentEvent(ctx context.Context, eventID, accountID uuid.UUID, apply bool, enableStrict bool, source string, actor *uuid.UUID) (EventMembershipImpact, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return EventMembershipImpact{}, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1::text))`, accountID); err != nil {
		return EventMembershipImpact{}, err
	}
	var cfg EventRuleConfig
	var revision int64
	var status string
	var pipelineID *uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT tag_formula_type,tag_formula_mode,tag_formula,rule_revision,status,pipeline_id FROM events WHERE id=$1 AND account_id=$2 FOR UPDATE`, eventID, accountID).Scan(&cfg.FormulaType, &cfg.FormulaMode, &cfg.Formula, &revision, &status, &pipelineID); err != nil {
		return EventMembershipImpact{}, err
	}
	rows, err := tx.Query(ctx, `SELECT tag_id,negate FROM event_tags WHERE event_id=$1`, eventID)
	if err != nil {
		return EventMembershipImpact{}, err
	}
	for rows.Next() {
		var id uuid.UUID
		var negate bool
		if err := rows.Scan(&id, &negate); err != nil {
			rows.Close()
			return EventMembershipImpact{}, err
		}
		if negate {
			cfg.Excludes = append(cfg.Excludes, id)
		} else {
			cfg.Includes = append(cfg.Includes, id)
		}
	}
	rows.Close()
	cfg = normalizeRuleConfig(cfg)
	matched, err := queryMatchedContactIDs(ctx, tx, accountID, cfg)
	if err != nil {
		return EventMembershipImpact{}, err
	}
	impact, err := membershipImpact(ctx, tx, eventID, cfg, matched)
	if err != nil {
		return EventMembershipImpact{}, err
	}
	impact.RuleRevision = revision
	impact.Fingerprint = membershipFingerprint(revision, cfg, matched)
	if err := tx.QueryRow(ctx, `SELECT COALESCE((SELECT mode FROM event_membership_policy_state WHERE account_id=$1),'audit_only')`, accountID).Scan(&impact.PolicyMode); err != nil {
		return EventMembershipImpact{}, err
	}
	if apply {
		if status == "completed" || status == "cancelled" {
			return EventMembershipImpact{}, ErrEventMembershipFrozen
		}
		if enableStrict {
			if _, err := tx.Exec(ctx, `INSERT INTO event_membership_policy_state(account_id,mode,audited_at,enabled_at,enabled_by,updated_at) VALUES($1,'strict',NOW(),NOW(),$2,NOW()) ON CONFLICT(account_id) DO UPDATE SET mode='strict',audited_at=COALESCE(event_membership_policy_state.audited_at,NOW()),enabled_at=NOW(),enabled_by=$2,updated_at=NOW()`, accountID, actor); err != nil {
				return EventMembershipImpact{}, err
			}
			impact.PolicyMode = "strict"
		}
		if impact.PolicyMode != "strict" {
			return EventMembershipImpact{}, ErrEventMembershipAuditOnly
		}
		if cfg.HasRules() {
			var stageID *uuid.UUID
			if pipelineID != nil {
				var defaultStageID uuid.UUID
				if err := tx.QueryRow(ctx, `SELECT id FROM event_pipeline_stages WHERE pipeline_id=$1 ORDER BY position,created_at,id LIMIT 1`, *pipelineID).Scan(&defaultStageID); err == nil {
					stageID = &defaultStageID
				} else if err != pgx.ErrNoRows {
					return EventMembershipImpact{}, err
				}
			}
			impact, err = applyMatchedMembership(ctx, tx, accountID, eventID, stageID, cfg, matched, revision, source, actor)
			if err != nil {
				return EventMembershipImpact{}, err
			}
			impact.RuleRevision = revision
			impact.PolicyMode = "strict"
			impact.Fingerprint = membershipFingerprint(revision, cfg, matched)
		}
	}
	return impact, tx.Commit(ctx)
}

func contactMatchesEventRuleTx(ctx context.Context, tx pgx.Tx, eventID, accountID, contactID uuid.UUID) (hasRules, matches bool, err error) {
	var cfg EventRuleConfig
	var status string
	if err := tx.QueryRow(ctx, `SELECT tag_formula_type,tag_formula_mode,tag_formula,status FROM events WHERE id=$1 AND account_id=$2`, eventID, accountID).Scan(&cfg.FormulaType, &cfg.FormulaMode, &cfg.Formula, &status); err != nil {
		return false, false, err
	}
	if status == "completed" || status == "cancelled" {
		return false, false, ErrEventMembershipFrozen
	}
	rows, err := tx.Query(ctx, `SELECT tag_id,negate FROM event_tags WHERE event_id=$1`, eventID)
	if err != nil {
		return false, false, err
	}
	for rows.Next() {
		var id uuid.UUID
		var negate bool
		if err := rows.Scan(&id, &negate); err != nil {
			rows.Close()
			return false, false, err
		}
		if negate {
			cfg.Excludes = append(cfg.Excludes, id)
		} else {
			cfg.Includes = append(cfg.Includes, id)
		}
	}
	rows.Close()
	cfg = normalizeRuleConfig(cfg)
	if !cfg.HasRules() {
		return false, true, nil
	}
	matchedIDs, err := queryMatchedContactIDs(ctx, tx, accountID, cfg)
	if err != nil {
		return true, false, err
	}
	for _, id := range matchedIDs {
		if id == contactID {
			return true, true, nil
		}
	}
	return true, false, nil
}

func (r *EventRepository) ContactMatchesEventRule(ctx context.Context, eventID, accountID, contactID uuid.UUID) (hasRules, matches bool, err error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return false, false, err
	}
	defer tx.Rollback(ctx)
	return contactMatchesEventRuleTx(ctx, tx, eventID, accountID, contactID)
}

func (r *EventRepository) SoftRemoveParticipant(ctx context.Context, accountID, eventID, participantID uuid.UUID, actor *uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1::text))`, accountID); err != nil {
		return err
	}
	var eventStatus string
	if err := tx.QueryRow(ctx, `SELECT status FROM events WHERE id=$1 AND account_id=$2 FOR UPDATE`, eventID, accountID).Scan(&eventStatus); err != nil {
		return err
	}
	if eventStatus == domain.EventStatusCompleted || eventStatus == domain.EventStatusCancelled {
		return ErrEventMembershipFrozen
	}
	var contactID *uuid.UUID
	var state string
	if err := tx.QueryRow(ctx, `SELECT contact_id,membership_state FROM event_participants WHERE id=$1 AND event_id=$2 FOR UPDATE`, participantID, eventID).Scan(&contactID, &state); err != nil {
		return err
	}
	if state == "inactive" {
		return tx.Commit(ctx)
	}
	hasRules, matches := false, true
	if contactID != nil {
		hasRules, matches, err = contactMatchesEventRuleTx(ctx, tx, eventID, accountID, *contactID)
		if err != nil {
			return err
		}
	}
	if hasRules && matches {
		return fmt.Errorf("event rule managed")
	}
	if _, err := tx.Exec(ctx, `UPDATE event_participants SET membership_state='inactive',membership_reason='manual_removed',membership_changed_at=NOW(),updated_at=NOW() WHERE id=$1`, participantID); err != nil {
		return err
	}
	if err := insertMembershipAudit(ctx, tx, accountID, eventID, participantID, contactID, "deactivated", "manual_remove", 0, actor, `{"membership_state":"active"}`, `{"membership_state":"inactive","reason":"manual_removed"}`, `{}`, uuid.New()); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *EventRepository) GetMembershipHistory(ctx context.Context, eventID, accountID uuid.UUID, limit, offset int) ([]EventMembershipAuditEntry, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := r.db.Query(ctx, `SELECT a.id,a.action,a.participant_id,a.contact_id,a.actor_type,a.actor_user_id,a.source,a.rule_revision,a.before_state,a.after_state,a.metadata,a.created_at::text FROM crm_audit_events a JOIN events e ON e.id=a.event_id WHERE a.event_id=$1 AND e.account_id=$2 AND a.category='event_membership' ORDER BY a.created_at DESC,a.id DESC LIMIT $3 OFFSET $4`, eventID, accountID, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	entries := make([]EventMembershipAuditEntry, 0)
	for rows.Next() {
		var e EventMembershipAuditEntry
		if err := rows.Scan(&e.ID, &e.Action, &e.ParticipantID, &e.ContactID, &e.ActorType, &e.ActorUserID, &e.Source, &e.RuleRevision, &e.BeforeState, &e.AfterState, &e.Metadata, &e.CreatedAt); err != nil {
			return nil, err
		}
		entries = append(entries, e)
	}
	return entries, rows.Err()
}

func (r *EventRepository) RecordManualMembership(ctx context.Context, accountID, eventID, participantID uuid.UUID, actor *uuid.UUID) error {
	actorType := "system"
	if actor != nil {
		actorType = "user"
	}
	_, err := r.db.Exec(ctx, `
		INSERT INTO crm_audit_events(account_id,category,action,event_id,participant_id,contact_id,actor_type,actor_user_id,source,before_state,after_state)
		SELECT $1,'event_membership','created_or_reactivated',$2,ep.id,ep.contact_id,$4,$5,'manual_add','{}'::jsonb,'{"membership_state":"active","source":"manual"}'::jsonb
		FROM event_participants ep JOIN events e ON e.id=ep.event_id
		WHERE ep.id=$3 AND ep.event_id=$2 AND e.account_id=$1
	`, accountID, eventID, participantID, actorType, actor)
	return err
}
