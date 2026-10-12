package repository

import (
	"context"
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

const EventParticipantSelectionTTL = 15 * time.Minute
const EventParticipantReceiptTTL = 30 * 24 * time.Hour
const EventParticipantSelectionTimeout = 45 * time.Second

var (
	ErrEventSelectionInvalid  = errors.New("invalid event selection")
	ErrEventSelectionExpired  = errors.New("event selection expired")
	ErrEventSelectionStale    = errors.New("event selection changed")
	ErrEventSelectionConsumed = errors.New("event selection already consumed")
)

type EventSelectionFilter struct {
	Search     string      `json:"search"`
	TagIDs     []uuid.UUID `json:"tag_ids"`
	HasPhone   *bool       `json:"has_phone,omitempty"`
	Membership string      `json:"membership"`
}
type PrepareEventSelection struct {
	Mode        string               `json:"mode"`
	Filter      EventSelectionFilter `json:"filter"`
	ContactIDs  []uuid.UUID          `json:"contact_ids,omitempty"`
	ExcludedIDs []uuid.UUID          `json:"excluded_ids,omitempty"`
}
type EventContactSelectionResult struct {
	OperationID   uuid.UUID      `json:"operation_id"`
	SelectionID   uuid.UUID      `json:"selection_id"`
	Created       int            `json:"created"`
	Reactivated   int            `json:"reactivated"`
	AlreadyActive int            `json:"already_active"`
	TotalActive   int            `json:"total_active"`
	StageCounts   map[string]int `json:"stage_counts"`
	CompletedAt   time.Time      `json:"completed_at"`
}
type EventParticipantSelection struct {
	ID            uuid.UUID                    `json:"selection_id"`
	ExpiresAt     time.Time                    `json:"expires_at"`
	Selected      int                          `json:"selected"`
	New           int                          `json:"new"`
	Reactivations int                          `json:"reactivations"`
	Result        *EventContactSelectionResult `json:"result,omitempty"`
}
type EventParticipantSelectionRepository struct{ db *pgxpool.Pool }

func NewEventParticipantSelectionRepository(db *pgxpool.Pool) *EventParticipantSelectionRepository {
	return &EventParticipantSelectionRepository{db: db}
}

func normalizeEventSelection(req PrepareEventSelection) (PrepareEventSelection, error) {
	req.Filter.Search = strings.TrimSpace(req.Filter.Search)
	if req.Mode != "ids" && req.Mode != "filtered" || len(req.Filter.Search) > 500 || len(req.ContactIDs) > 500 || len(req.ExcludedIDs) > 5000 || len(req.Filter.TagIDs) > 100 {
		return req, ErrEventSelectionInvalid
	}
	if req.Mode == "ids" && len(req.ContactIDs) == 0 || req.Mode == "filtered" && len(req.ContactIDs) > 0 {
		return req, ErrEventSelectionInvalid
	}
	switch req.Filter.Membership {
	case "", "available", "inactive", "all":
	default:
		return req, ErrEventSelectionInvalid
	}
	req.ContactIDs = uniqueSelectionIDs(req.ContactIDs)
	req.ExcludedIDs = uniqueSelectionIDs(req.ExcludedIDs)
	req.Filter.TagIDs = uniqueSelectionIDs(req.Filter.TagIDs)
	for _, ids := range [][]uuid.UUID{req.ContactIDs, req.ExcludedIDs, req.Filter.TagIDs} {
		for _, id := range ids {
			if id == uuid.Nil {
				return req, ErrEventSelectionInvalid
			}
		}
	}
	return req, nil
}
func uniqueSelectionIDs(ids []uuid.UUID) []uuid.UUID {
	seen := map[uuid.UUID]bool{}
	out := make([]uuid.UUID, 0, len(ids))
	for _, id := range ids {
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].String() < out[j].String() })
	return out
}
func lockEventSelectionAccount(ctx context.Context, tx pgx.Tx, accountID uuid.UUID) error {
	if _, err := tx.Exec(ctx, "SET LOCAL lock_timeout='3s'"); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1::text))`, accountID)
	return err
}
func (r *EventParticipantSelectionRepository) Prepare(ctx context.Context, accountID, actorID, eventID uuid.UUID, req PrepareEventSelection) (*EventParticipantSelection, error) {
	req, err := normalizeEventSelection(req)
	if err != nil {
		return nil, err
	}
	if accountID == uuid.Nil || actorID == uuid.Nil || eventID == uuid.Nil {
		return nil, ErrEventSelectionInvalid
	}
	ctx, cancel := context.WithTimeout(ctx, EventParticipantSelectionTimeout)
	defer cancel()
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(context.Background())
	if err = lockEventSelectionAccount(ctx, tx, accountID); err != nil {
		return nil, err
	}
	state, err := loadEventRuleStateTx(ctx, tx, eventID, accountID, true)
	if err != nil {
		return nil, err
	}
	if state.Status == domain.EventStatusCompleted || state.Status == domain.EventStatusCancelled {
		return nil, ErrEventMembershipFrozen
	}
	// Bound retention work to this account, never scan/delete another tenant.
	if _, err = tx.Exec(ctx, `DELETE FROM event_participant_selections WHERE id IN (SELECT id FROM event_participant_selections WHERE account_id=$1 AND ((result IS NULL AND expires_at<NOW()) OR created_at<NOW()-INTERVAL '30 days') ORDER BY created_at LIMIT 100)`, accountID); err != nil {
		return nil, err
	}
	stageID, err := defaultEventStageTx(ctx, tx, state.PipelineID)
	if err != nil {
		return nil, err
	}
	if req.Mode == "filtered" {
		if _, err = configureEventCandidateBulkPlan(ctx, tx, accountID); err != nil {
			return nil, err
		}
	}
	filter := EventParticipantCandidateFilter{Search: req.Filter.Search, TagIDs: req.Filter.TagIDs, HasPhone: req.Filter.HasPhone}
	// Explicit selections survive search/page changes. Their IDs are their full scope.
	if req.Mode == "ids" {
		filter = EventParticipantCandidateFilter{}
	}
	where, args := eventCandidateWhere(filter, []interface{}{accountID, eventID})
	eligibility, args, err := candidateEligibilityPredicate(state.Config, args, accountID)
	if err != nil {
		return nil, err
	}
	where += " AND (" + eligibility + ") AND ep.membership_state IS DISTINCT FROM 'active'"
	if req.Mode == "filtered" && req.Filter.Membership == "inactive" {
		where += " AND ep.membership_state='inactive'"
	}
	if req.Mode == "ids" {
		args = append(args, req.ContactIDs)
		where += fmt.Sprintf(" AND c.id=ANY($%d::uuid[])", len(args))
	}
	if len(req.ExcludedIDs) > 0 {
		args = append(args, req.ExcludedIDs)
		where += fmt.Sprintf(" AND NOT(c.id=ANY($%d::uuid[]))", len(args))
	}
	payload, _ := json.Marshal(req)
	preview := &EventParticipantSelection{ID: uuid.New(), ExpiresAt: time.Now().UTC().Add(EventParticipantSelectionTTL)}
	if _, err = tx.Exec(ctx, `INSERT INTO event_participant_selections(id,account_id,actor_id,event_id,filter,rule_revision,initial_stage_id,expires_at) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8)`, preview.ID, accountID, actorID, eventID, payload, state.RuleRevision, stageID, preview.ExpiresAt); err != nil {
		return nil, err
	}
	args = append(args, preview.ID)
	if _, err = tx.Exec(ctx, fmt.Sprintf(`INSERT INTO event_participant_selection_items(account_id,selection_id,contact_id,previous_state)
 SELECT $1,$%d,c.id,COALESCE(ep.membership_state,'not_added') FROM contacts c
 LEFT JOIN event_participants ep ON ep.event_id=$2 AND ep.contact_id=c.id WHERE %s`, len(args), where), args...); err != nil {
		return nil, err
	}
	if err = tx.QueryRow(ctx, `SELECT COUNT(*),COUNT(*) FILTER(WHERE previous_state='not_added'),COUNT(*) FILTER(WHERE previous_state='inactive') FROM event_participant_selection_items WHERE account_id=$1 AND selection_id=$2`, accountID, preview.ID).Scan(&preview.Selected, &preview.New, &preview.Reactivations); err != nil {
		return nil, err
	}
	if preview.Selected == 0 {
		return nil, ErrEventSelectionStale
	}
	if req.Mode == "ids" {
		excluded := map[uuid.UUID]bool{}
		for _, id := range req.ExcludedIDs {
			excluded[id] = true
		}
		expected := 0
		for _, id := range req.ContactIDs {
			if !excluded[id] {
				expected++
			}
		}
		if preview.Selected != expected {
			return nil, ErrEventSelectionStale
		}
	}
	if _, err = tx.Exec(ctx, `UPDATE event_participant_selections SET selected_count=$2,new_count=$3,reactivation_count=$4 WHERE id=$1`, preview.ID, preview.Selected, preview.New, preview.Reactivations); err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return preview, nil
}

func (r *EventParticipantSelectionRepository) Get(ctx context.Context, accountID, actorID, eventID, selectionID uuid.UUID) (*EventParticipantSelection, error) {
	item := &EventParticipantSelection{}
	var result []byte
	err := r.db.QueryRow(ctx, `SELECT s.id,s.expires_at,s.selected_count,s.new_count,s.reactivation_count,s.result
 FROM event_participant_selections s JOIN events e ON e.id=s.event_id AND e.account_id=s.account_id
 WHERE s.id=$1 AND s.account_id=$2 AND s.actor_id=$3 AND s.event_id=$4 AND s.created_at>NOW()-INTERVAL '30 days'`, selectionID, accountID, actorID, eventID).Scan(&item.ID, &item.ExpiresAt, &item.Selected, &item.New, &item.Reactivations, &result)
	if err != nil {
		return nil, err
	}
	if len(result) > 0 {
		if err = json.Unmarshal(result, &item.Result); err != nil {
			return nil, err
		}
	}
	if item.Result == nil && time.Now().After(item.ExpiresAt) {
		return nil, ErrEventSelectionExpired
	}
	return item, nil
}

func (r *EventParticipantSelectionRepository) Confirm(ctx context.Context, accountID, actorID, eventID, selectionID, operationID uuid.UUID) (*EventContactSelectionResult, bool, error) {
	if operationID == uuid.Nil {
		return nil, false, ErrEventSelectionInvalid
	}
	ctx, cancel := context.WithTimeout(ctx, EventParticipantSelectionTimeout)
	defer cancel()
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, false, err
	}
	defer tx.Rollback(context.Background())
	if err = lockEventSelectionAccount(ctx, tx, accountID); err != nil {
		return nil, false, err
	}
	var expires time.Time
	var revision int64
	var expected int
	var initialStage *uuid.UUID
	var storedOperation *uuid.UUID
	var receipt []byte
	err = tx.QueryRow(ctx, `SELECT expires_at,rule_revision,selected_count,initial_stage_id,operation_id,result FROM event_participant_selections
 WHERE id=$1 AND account_id=$2 AND actor_id=$3 AND event_id=$4 AND created_at>NOW()-INTERVAL '30 days' FOR UPDATE`, selectionID, accountID, actorID, eventID).Scan(&expires, &revision, &expected, &initialStage, &storedOperation, &receipt)
	if err != nil {
		return nil, false, err
	}
	if len(receipt) > 0 {
		if storedOperation == nil || *storedOperation != operationID {
			return nil, false, ErrEventSelectionConsumed
		}
		var result EventContactSelectionResult
		if err = json.Unmarshal(receipt, &result); err != nil {
			return nil, false, err
		}
		return &result, true, nil
	}
	if !time.Now().Before(expires) {
		return nil, false, ErrEventSelectionExpired
	}
	state, err := loadEventRuleStateTx(ctx, tx, eventID, accountID, true)
	if err != nil {
		return nil, false, err
	}
	if state.Status == domain.EventStatusCompleted || state.Status == domain.EventStatusCancelled {
		return nil, false, ErrEventMembershipFrozen
	}
	stage, err := defaultEventStageTx(ctx, tx, state.PipelineID)
	if err != nil {
		return nil, false, err
	}
	if revision != state.RuleRevision || !sameSelectionStage(initialStage, stage) {
		return nil, false, ErrEventSelectionStale
	}
	// A freshly frozen large audience can still have a one-row planner estimate.
	// Joining that snapshot to the account's contacts with a nested loop scans
	// the same account once per selected contact. Keep mass confirmation linear
	// without changing global settings or waiting for autovacuum statistics.
	if expected > 500 {
		if _, err = tx.Exec(ctx, "SET LOCAL enable_nestloop=off; SET LOCAL plan_cache_mode=force_custom_plan"); err != nil {
			return nil, false, err
		}
	}
	eligibility, args, err := candidateEligibilityPredicate(state.Config, []interface{}{accountID, eventID, selectionID}, accountID)
	if err != nil {
		return nil, false, err
	}
	var valid int
	if err = tx.QueryRow(ctx, `SELECT COUNT(*) FROM event_participant_selection_items si
 JOIN contacts c ON c.id=si.contact_id AND c.account_id=si.account_id AND c.is_group=FALSE
 LEFT JOIN event_participants ep ON ep.event_id=$2 AND ep.contact_id=c.id
 WHERE si.account_id=$1 AND si.selection_id=$3 AND (ep.membership_state='active' OR (`+eligibility+`))`, args...).Scan(&valid); err != nil {
		return nil, false, err
	}
	if valid != expected {
		return nil, false, ErrEventSelectionStale
	}
	result := &EventContactSelectionResult{OperationID: operationID, SelectionID: selectionID, CompletedAt: time.Now().UTC(), StageCounts: map[string]int{}}
	// One set-based statement updates membership and audit. It never changes an
	// already-active participant's provenance or creates a Lead.
	err = tx.QueryRow(ctx, eventSelectionApplySQL, accountID, eventID, selectionID, stage, state.Config.HasRules(), actorID, operationID, state.RuleRevision).Scan(&result.Created, &result.Reactivated)
	if err != nil {
		return nil, false, err
	}
	result.AlreadyActive = expected - result.Created - result.Reactivated
	rows, err := tx.Query(ctx, `SELECT COALESCE(stage_id::text,'unassigned'),COUNT(*) FROM event_participants WHERE event_id=$1 AND membership_state='active' GROUP BY stage_id`, eventID)
	if err != nil {
		return nil, false, err
	}
	for rows.Next() {
		var key string
		var count int
		if err = rows.Scan(&key, &count); err != nil {
			rows.Close()
			return nil, false, err
		}
		result.StageCounts[key] = count
		result.TotalActive += count
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, false, err
	}
	receipt, _ = json.Marshal(result)
	if _, err = tx.Exec(ctx, `UPDATE event_participant_selections SET operation_id=$2,result=$3::jsonb WHERE id=$1`, selectionID, operationID, receipt); err != nil {
		return nil, false, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, false, err
	}
	return result, false, nil
}
func sameSelectionStage(a, b *uuid.UUID) bool {
	return (a == nil && b == nil) || (a != nil && b != nil && *a == *b)
}

const eventSelectionApplySQL = `
WITH selected AS MATERIALIZED (
 SELECT c.id,c.jid,c.custom_name,c.name,c.push_name,c.short_name,c.phone,c.last_name,c.email,c.age,c.company,c.dni,c.birth_date,c.address,c.distrito,c.ocupacion FROM event_participant_selection_items si JOIN contacts c ON c.id=si.contact_id AND c.account_id=si.account_id
 WHERE si.selection_id=$3 AND si.account_id=$1 AND c.is_group=FALSE
), reactivated AS (
 UPDATE event_participants ep SET
 stage_id=COALESCE(ep.stage_id,$4::uuid),
 name=COALESCE(NULLIF(BTRIM(c.custom_name),''),NULLIF(BTRIM(c.name),''),NULLIF(BTRIM(c.push_name),''),NULLIF(BTRIM(c.short_name),''),NULLIF(BTRIM(c.phone),''),c.jid,''),
 last_name=c.last_name,short_name=c.short_name,phone=c.phone,email=c.email,age=c.age,
 company=c.company,dni=c.dni,birth_date=c.birth_date,address=c.address,distrito=c.distrito,ocupacion=c.ocupacion,
 membership_state='active',membership_reason='',membership_source='manual',auto_tag_sync=$5::boolean,
 membership_changed_at=NOW(),updated_at=NOW()
 FROM selected c WHERE ep.event_id=$2 AND ep.contact_id=c.id AND ep.membership_state='inactive'
 RETURNING ep.id,ep.contact_id
), created AS (
 INSERT INTO event_participants(id,event_id,contact_id,stage_id,name,last_name,short_name,phone,email,age,company,dni,birth_date,address,distrito,ocupacion,status,auto_tag_sync,membership_state,membership_reason,membership_source,membership_changed_at,invited_at,created_at,updated_at)
 SELECT gen_random_uuid(),$2,c.id,$4::uuid,
 COALESCE(NULLIF(BTRIM(c.custom_name),''),NULLIF(BTRIM(c.name),''),NULLIF(BTRIM(c.push_name),''),NULLIF(BTRIM(c.short_name),''),NULLIF(BTRIM(c.phone),''),c.jid,''),
 c.last_name,c.short_name,c.phone,c.email,c.age,c.company,c.dni,c.birth_date,c.address,c.distrito,c.ocupacion,'invited',$5::boolean,'active','','manual',NOW(),NOW(),NOW(),NOW()
 FROM selected c WHERE NOT EXISTS(SELECT 1 FROM event_participants ep WHERE ep.event_id=$2 AND ep.contact_id=c.id)
 ON CONFLICT(event_id,contact_id) WHERE contact_id IS NOT NULL DO NOTHING RETURNING id,contact_id
), audited AS (
 INSERT INTO crm_audit_events(account_id,category,action,event_id,participant_id,contact_id,actor_type,actor_user_id,source,correlation_id,rule_revision,before_state,after_state,metadata)
 SELECT $1,'event_membership',change.action,$2,change.id,change.contact_id,'user',$6::uuid,'manual_add',$7::uuid,$8::bigint,
 change.before_state,'{"membership_state":"active","source":"manual"}'::jsonb,jsonb_build_object('selection_id',$3::uuid)
 FROM (
  SELECT id,contact_id,'created'::text AS action,'{}'::jsonb AS before_state FROM created
  UNION ALL SELECT id,contact_id,'reactivated','{"membership_state":"inactive"}'::jsonb FROM reactivated
 ) change RETURNING id
)
SELECT (SELECT COUNT(*) FROM created),(SELECT COUNT(*) FROM reactivated)`
