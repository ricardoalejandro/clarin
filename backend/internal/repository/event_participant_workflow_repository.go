package repository

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/formula"
)

const (
	CandidateMembershipNotAdded = "not_added"
	CandidateMembershipActive   = "active"
	CandidateMembershipInactive = "inactive"

	CandidateEligibilityEligible       = "eligible"
	CandidateEligibilityRuleIneligible = "rule_ineligible"
	CandidateEligibilityEventFrozen    = "event_frozen"

	ParticipantAddCreated       = "created"
	ParticipantAddReactivated   = "reactivated"
	ParticipantAddAlreadyActive = "already_active"
	ParticipantAddRejected      = "rejected"
)

type EventParticipantCandidatePage struct {
	Candidates  []*domain.EventParticipantCandidate `json:"candidates"`
	Total       int                                 `json:"total"`
	Limit       int                                 `json:"limit"`
	Offset      int                                 `json:"offset"`
	HasMore     bool                                `json:"has_more"`
	HasRules    bool                                `json:"has_rules"`
	EventStatus string                              `json:"event_status"`
	Counts      EventParticipantCandidateCounts     `json:"counts"`
}

type EventParticipantCandidateCounts struct {
	Matches       int `json:"matches"`
	Available     int `json:"available"`
	AlreadyActive int `json:"already_active"`
	Inactive      int `json:"inactive"`
	Ineligible    int `json:"ineligible"`
}

type EventParticipantCandidateFilter struct {
	Search   string
	TagIDs   []uuid.UUID
	HasPhone *bool
	Limit    int
	Offset   int
}

type EventParticipantAddResult struct {
	ContactID     *uuid.UUID `json:"contact_id,omitempty"`
	ParticipantID *uuid.UUID `json:"participant_id,omitempty"`
	Outcome       string     `json:"outcome"`
	Code          string     `json:"code,omitempty"`
	Error         string     `json:"error,omitempty"`
}

type EventParticipantAddSummary struct {
	Created       int                          `json:"created"`
	Reactivated   int                          `json:"reactivated"`
	AlreadyActive int                          `json:"already_active"`
	Rejected      int                          `json:"rejected"`
	Results       []*EventParticipantAddResult `json:"results"`
}

func (s EventParticipantAddSummary) Changed() int {
	return s.Created + s.Reactivated
}

func strictAddAutoTagSync(config EventRuleConfig) bool {
	return config.HasRules()
}

func targetedRuleReconciliationEnabled(policyMode string) bool {
	return policyMode == "strict"
}

type ContactMembershipImpact struct {
	EventID     uuid.UUID `json:"event_id"`
	Created     int       `json:"created"`
	Reactivated int       `json:"reactivated"`
	Deactivated int       `json:"deactivated"`
}

type eventRuleState struct {
	Status       string
	PipelineID   *uuid.UUID
	RuleRevision int64
	Config       EventRuleConfig
}

type contactRuleFacts struct {
	TagIDs   map[uuid.UUID]struct{}
	TagNames []string
}

type eventParticipantContactSnapshot struct {
	ID        uuid.UUID
	Name      string
	LastName  *string
	ShortName *string
	Phone     *string
	Email     *string
	Age       *int
	Company   *string
	DNI       *string
	BirthDate *time.Time
	Address   *string
	Distrito  *string
	Ocupacion *string
	IsGroup   bool
}

type existingEventParticipant struct {
	ID              uuid.UUID
	MembershipState string
	StageID         *uuid.UUID
}

func appendAlreadyActiveNoOp(summary *EventParticipantAddSummary, participant *domain.EventParticipant, contactID uuid.UUID, row existingEventParticipant) bool {
	if row.MembershipState != CandidateMembershipActive {
		return false
	}
	participant.ID = row.ID
	participant.StageID = row.StageID
	participant.MembershipState = CandidateMembershipActive
	summary.AlreadyActive++
	summary.Results = append(summary.Results, &EventParticipantAddResult{ContactID: &contactID, ParticipantID: &row.ID, Outcome: ParticipantAddAlreadyActive})
	return true
}

func loadEventRuleStateTx(ctx context.Context, tx pgx.Tx, eventID, accountID uuid.UUID, lock bool) (eventRuleState, error) {
	var state eventRuleState
	query := `SELECT status,pipeline_id,rule_revision,tag_formula_type,tag_formula_mode,tag_formula FROM events WHERE id=$1 AND account_id=$2`
	if lock {
		query += ` FOR UPDATE`
	}
	if err := tx.QueryRow(ctx, query, eventID, accountID).Scan(
		&state.Status, &state.PipelineID, &state.RuleRevision,
		&state.Config.FormulaType, &state.Config.FormulaMode, &state.Config.Formula,
	); err != nil {
		return state, err
	}
	rows, err := tx.Query(ctx, `SELECT tag_id,negate FROM event_tags WHERE event_id=$1`, eventID)
	if err != nil {
		return state, err
	}
	defer rows.Close()
	for rows.Next() {
		var tagID uuid.UUID
		var negate bool
		if err := rows.Scan(&tagID, &negate); err != nil {
			return state, err
		}
		if negate {
			state.Config.Excludes = append(state.Config.Excludes, tagID)
		} else {
			state.Config.Includes = append(state.Config.Includes, tagID)
		}
	}
	if err := rows.Err(); err != nil {
		return state, err
	}
	state.Config = normalizeRuleConfig(state.Config)
	return state, nil
}

func loadContactRuleFactsTx(ctx context.Context, tx pgx.Tx, accountID uuid.UUID, contactIDs []uuid.UUID) (map[uuid.UUID]contactRuleFacts, error) {
	facts := make(map[uuid.UUID]contactRuleFacts, len(contactIDs))
	for _, contactID := range contactIDs {
		facts[contactID] = contactRuleFacts{TagIDs: make(map[uuid.UUID]struct{})}
	}
	if len(contactIDs) == 0 {
		return facts, nil
	}
	rows, err := tx.Query(ctx, `
		SELECT ct.contact_id,ct.tag_id,LOWER(t.name)
		FROM contacts c
		JOIN contact_tags ct ON ct.contact_id=c.id
		JOIN tags t ON t.id=ct.tag_id AND t.account_id=c.account_id
		WHERE c.account_id=$1 AND c.id=ANY($2::uuid[])
	`, accountID, contactIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var contactID, tagID uuid.UUID
		var tagName string
		if err := rows.Scan(&contactID, &tagID, &tagName); err != nil {
			return nil, err
		}
		fact := facts[contactID]
		if fact.TagIDs == nil {
			fact.TagIDs = make(map[uuid.UUID]struct{})
		}
		fact.TagIDs[tagID] = struct{}{}
		fact.TagNames = append(fact.TagNames, tagName)
		facts[contactID] = fact
	}
	return facts, rows.Err()
}

func contactMatchesRuleFacts(cfg EventRuleConfig, facts contactRuleFacts) (bool, error) {
	cfg = normalizeRuleConfig(cfg)
	if !cfg.HasRules() {
		return true, nil
	}
	if cfg.FormulaType == "advanced" {
		ast, err := formula.Parse(cfg.Formula)
		if err != nil {
			return false, err
		}
		return formula.Evaluate(ast, facts.TagNames), nil
	}
	for _, tagID := range cfg.Excludes {
		if _, excluded := facts.TagIDs[tagID]; excluded {
			return false, nil
		}
	}
	if len(cfg.Includes) == 0 {
		return true, nil
	}
	if cfg.FormulaMode == "AND" {
		for _, tagID := range cfg.Includes {
			if _, matched := facts.TagIDs[tagID]; !matched {
				return false, nil
			}
		}
		return true, nil
	}
	for _, tagID := range cfg.Includes {
		if _, matched := facts.TagIDs[tagID]; matched {
			return true, nil
		}
	}
	return false, nil
}

func candidateSearchTerms(search string) (rawPattern, rawDigitsPattern, normalizedDigitsPattern string) {
	search = strings.TrimSpace(search)
	if search == "" {
		return "", "", ""
	}
	rawPattern = "%" + search + "%"
	rawDigits := phoneFromJID(search)
	normalizedDigits := normalizeAliasValue("phone", search)
	if rawDigits != "" {
		rawDigitsPattern = "%" + rawDigits + "%"
	}
	if normalizedDigits != "" {
		normalizedDigitsPattern = "%" + normalizedDigits + "%"
	}
	return rawPattern, rawDigitsPattern, normalizedDigitsPattern
}

// candidateEligibilityPredicate keeps rule evaluation in PostgreSQL. This
// avoids materializing every filtered Contact and all of its tags in Go merely
// to calculate authoritative counters when the selector opens.
func candidateEligibilityPredicate(config EventRuleConfig, args []interface{}, accountID uuid.UUID) (string, []interface{}, error) {
	config = normalizeRuleConfig(config)
	if !config.HasRules() {
		return "TRUE", args, nil
	}
	if config.FormulaType == "advanced" {
		ast, err := formula.Parse(config.Formula)
		if err != nil {
			return "", nil, err
		}
		innerSQL, innerArgs, err := formula.BuildSQLForContacts(ast, accountID)
		if err != nil {
			return "", nil, err
		}
		innerSQL = formula.RemapSQLParams(innerSQL, len(innerArgs), len(args)+1)
		return fmt.Sprintf("c.id IN (%s)", innerSQL), append(args, innerArgs...), nil
	}

	predicates := make([]string, 0, 2)
	if len(config.Excludes) > 0 {
		arg := len(args) + 1
		predicates = append(predicates, fmt.Sprintf(`NOT EXISTS (
			SELECT 1 FROM contact_tags excluded
			JOIN tags excluded_tag ON excluded_tag.id=excluded.tag_id AND excluded_tag.account_id=$1
			WHERE excluded.contact_id=c.id AND excluded.tag_id=ANY($%d::uuid[])
		)`, arg))
		args = append(args, config.Excludes)
	}
	if len(config.Includes) > 0 {
		arg := len(args) + 1
		if config.FormulaMode == "AND" {
			predicates = append(predicates, fmt.Sprintf(`(
				SELECT COUNT(DISTINCT included.tag_id) FROM contact_tags included
				JOIN tags included_tag ON included_tag.id=included.tag_id AND included_tag.account_id=$1
				WHERE included.contact_id=c.id AND included.tag_id=ANY($%d::uuid[])
			)=%d`, arg, len(config.Includes)))
		} else {
			predicates = append(predicates, fmt.Sprintf(`EXISTS (
				SELECT 1 FROM contact_tags included
				JOIN tags included_tag ON included_tag.id=included.tag_id AND included_tag.account_id=$1
				WHERE included.contact_id=c.id AND included.tag_id=ANY($%d::uuid[])
			)`, arg))
		}
		args = append(args, config.Includes)
	}
	return "(" + strings.Join(predicates, " AND ") + ")", args, nil
}

func classifyParticipantCandidate(eventStatus string, hasRules, matches bool, persistedState *string) (membershipStatus, eligibility string, canAdd bool) {
	membershipStatus = CandidateMembershipNotAdded
	if persistedState != nil && *persistedState == CandidateMembershipActive {
		membershipStatus = CandidateMembershipActive
	} else if persistedState != nil {
		membershipStatus = CandidateMembershipInactive
	}
	if eventStatus == domain.EventStatusCompleted || eventStatus == domain.EventStatusCancelled {
		return membershipStatus, CandidateEligibilityEventFrozen, false
	}
	if hasRules && !matches {
		return membershipStatus, CandidateEligibilityRuleIneligible, false
	}
	return membershipStatus, CandidateEligibilityEligible, membershipStatus != CandidateMembershipActive
}

// ListParticipantCandidates returns account Contacts with event membership and
// rule eligibility attached. Existing participants are intentionally retained.
func (r *EventRepository) ListParticipantCandidates(ctx context.Context, accountID, eventID uuid.UUID, filter EventParticipantCandidateFilter) (EventParticipantCandidatePage, error) {
	if filter.Limit <= 0 || filter.Limit > 200 {
		filter.Limit = 50
	}
	if filter.Offset < 0 {
		filter.Offset = 0
	}
	page := EventParticipantCandidatePage{Candidates: make([]*domain.EventParticipantCandidate, 0), Limit: filter.Limit, Offset: filter.Offset}
	tx, err := r.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return page, err
	}
	defer tx.Rollback(ctx)
	state, err := loadEventRuleStateTx(ctx, tx, eventID, accountID, false)
	if err != nil {
		return page, err
	}
	page.EventStatus = state.Status
	page.HasRules = state.Config.HasRules()

	args := []interface{}{accountID, eventID}
	where := `c.account_id=$1 AND c.is_group=FALSE`
	rawPattern, rawDigitsPattern, normalizedDigitsPattern := candidateSearchTerms(filter.Search)
	if rawPattern != "" {
		rawArg, rawDigitsArg, normalizedDigitsArg := len(args)+1, len(args)+2, len(args)+3
		where += fmt.Sprintf(` AND (
			COALESCE(c.custom_name,c.name,c.push_name,'') ILIKE $%d
			OR COALESCE(c.last_name,'') ILIKE $%d
			OR COALESCE(c.email,'') ILIKE $%d
			OR c.jid ILIKE $%d
			OR ($%d<>'' AND (
				REGEXP_REPLACE(COALESCE(c.phone,''),'[^0-9]','','g') LIKE $%d
				OR (LOWER(c.jid) ~ '^[0-9]+(:[0-9]+)?@(s[.]whatsapp[.]net|c[.]us)$'
					AND REGEXP_REPLACE(SPLIT_PART(c.jid,'@',1),'[^0-9]','','g') LIKE $%d)
				OR EXISTS (SELECT 1 FROM contact_phones cp WHERE cp.contact_id=c.id AND REGEXP_REPLACE(cp.phone,'[^0-9]','','g') LIKE $%d)
				OR EXISTS (
					SELECT 1 FROM contact_aliases ca
					WHERE ca.account_id=$1 AND ca.contact_id=c.id
					  AND ((LOWER(ca.alias_type)='phone' AND REGEXP_REPLACE(ca.normalized_value,'[^0-9]','','g') LIKE $%d)
					       OR (LOWER(ca.alias_type)='jid' AND LOWER(ca.normalized_value) ~ '^[0-9]+(:[0-9]+)?@(s[.]whatsapp[.]net|c[.]us)$'
					           AND REGEXP_REPLACE(SPLIT_PART(ca.normalized_value,'@',1),'[^0-9]','','g') LIKE $%d))
				)
			))
			OR ($%d<>'' AND (
				REGEXP_REPLACE(COALESCE(c.phone,''),'[^0-9]','','g') LIKE $%d
				OR (LOWER(c.jid) ~ '^[0-9]+(:[0-9]+)?@(s[.]whatsapp[.]net|c[.]us)$'
					AND REGEXP_REPLACE(SPLIT_PART(c.jid,'@',1),'[^0-9]','','g') LIKE $%d)
				OR EXISTS (SELECT 1 FROM contact_phones cp WHERE cp.contact_id=c.id AND REGEXP_REPLACE(cp.phone,'[^0-9]','','g') LIKE $%d)
				OR EXISTS (
					SELECT 1 FROM contact_aliases ca
					WHERE ca.account_id=$1 AND ca.contact_id=c.id
					  AND ((LOWER(ca.alias_type)='phone' AND REGEXP_REPLACE(ca.normalized_value,'[^0-9]','','g') LIKE $%d)
					       OR (LOWER(ca.alias_type)='jid' AND LOWER(ca.normalized_value) ~ '^[0-9]+(:[0-9]+)?@(s[.]whatsapp[.]net|c[.]us)$'
					           AND REGEXP_REPLACE(SPLIT_PART(ca.normalized_value,'@',1),'[^0-9]','','g') LIKE $%d))
				)
			))
		)`, rawArg, rawArg, rawArg, rawArg,
			rawDigitsArg, rawDigitsArg, rawDigitsArg, rawDigitsArg, rawDigitsArg, rawDigitsArg,
			normalizedDigitsArg, normalizedDigitsArg, normalizedDigitsArg, normalizedDigitsArg, normalizedDigitsArg, normalizedDigitsArg)
		args = append(args, rawPattern, rawDigitsPattern, normalizedDigitsPattern)
	}
	if len(filter.TagIDs) > 0 {
		tagArg := len(args) + 1
		where += fmt.Sprintf(` AND EXISTS (
			SELECT 1 FROM contact_tags ct JOIN tags t ON t.id=ct.tag_id AND t.account_id=$1
			WHERE ct.contact_id=c.id AND ct.tag_id=ANY($%d::uuid[])
		)`, tagArg)
		args = append(args, filter.TagIDs)
	}
	if filter.HasPhone != nil {
		if *filter.HasPhone {
			where += ` AND (NULLIF(REGEXP_REPLACE(COALESCE(c.phone,''),'[^0-9]','','g'),'') IS NOT NULL
				OR (LOWER(c.jid) ~ '^[0-9]+(:[0-9]+)?@(s[.]whatsapp[.]net|c[.]us)$'
					AND NULLIF(REGEXP_REPLACE(SPLIT_PART(c.jid,'@',1),'[^0-9]','','g'),'') IS NOT NULL)
				OR EXISTS (SELECT 1 FROM contact_phones cp WHERE cp.contact_id=c.id AND NULLIF(REGEXP_REPLACE(cp.phone,'[^0-9]','','g'),'') IS NOT NULL)
				OR EXISTS (
					SELECT 1 FROM contact_aliases ca
					WHERE ca.account_id=$1 AND ca.contact_id=c.id
					  AND ((LOWER(ca.alias_type)='phone' AND NULLIF(REGEXP_REPLACE(ca.normalized_value,'[^0-9]','','g'),'') IS NOT NULL)
					       OR (LOWER(ca.alias_type)='jid' AND LOWER(ca.normalized_value) ~ '^[0-9]+(:[0-9]+)?@(s[.]whatsapp[.]net|c[.]us)$'))
				))`
		} else {
			where += ` AND NULLIF(REGEXP_REPLACE(COALESCE(c.phone,''),'[^0-9]','','g'),'') IS NULL
				AND NOT (LOWER(c.jid) ~ '^[0-9]+(:[0-9]+)?@(s[.]whatsapp[.]net|c[.]us)$')
				AND NOT EXISTS (SELECT 1 FROM contact_phones cp WHERE cp.contact_id=c.id AND NULLIF(REGEXP_REPLACE(cp.phone,'[^0-9]','','g'),'') IS NOT NULL)
				AND NOT EXISTS (
					SELECT 1 FROM contact_aliases ca
					WHERE ca.account_id=$1 AND ca.contact_id=c.id
					  AND ((LOWER(ca.alias_type)='phone' AND NULLIF(REGEXP_REPLACE(ca.normalized_value,'[^0-9]','','g'),'') IS NOT NULL)
					       OR (LOWER(ca.alias_type)='jid' AND LOWER(ca.normalized_value) ~ '^[0-9]+(:[0-9]+)?@(s[.]whatsapp[.]net|c[.]us)$'))
				)`
		}
	}

	eligibilitySQL, args, err := candidateEligibilityPredicate(state.Config, args, accountID)
	if err != nil {
		return page, err
	}
	// Counters remain authoritative, but PostgreSQL aggregates them without
	// sending every Contact/tag tuple to the application. The no-rule path uses
	// the constant TRUE predicate and is therefore a single filtered scan.
	err = tx.QueryRow(ctx, fmt.Sprintf(`
		WITH classified AS (
			SELECT ep.membership_state,(%s) AS eligible
			FROM contacts c
			LEFT JOIN event_participants ep ON ep.event_id=$2 AND ep.contact_id=c.id
			WHERE %s
		)
		SELECT COUNT(*),
		       COUNT(*) FILTER (WHERE eligible AND membership_state IS DISTINCT FROM 'active'),
		       COUNT(*) FILTER (WHERE membership_state='active'),
		       COUNT(*) FILTER (WHERE membership_state='inactive'),
		       COUNT(*) FILTER (WHERE NOT eligible)
		FROM classified
	`, eligibilitySQL, where), args...).Scan(
		&page.Total, &page.Counts.Available, &page.Counts.AlreadyActive, &page.Counts.Inactive, &page.Counts.Ineligible,
	)
	if err != nil {
		return page, err
	}
	page.Counts.Matches = page.Total
	if state.Status == domain.EventStatusCompleted || state.Status == domain.EventStatusCancelled {
		page.Counts.Available = 0
		page.Counts.Ineligible = 0
	}

	limitArg, offsetArg := len(args)+1, len(args)+2
	dataArgs := append(append([]interface{}{}, args...), filter.Limit, filter.Offset)
	rows, err := tx.Query(ctx, fmt.Sprintf(`
		SELECT c.id,c.account_id,c.jid,c.phone,c.name,c.last_name,c.short_name,c.custom_name,c.push_name,c.email,c.company,
		       c.is_group,c.do_not_contact,c.created_at,c.updated_at,
		       (%s) AS matches_rule,
		       ep.id,ep.membership_state,ep.stage_id,eps.name,eps.color,ep.membership_source,ep.membership_reason
		FROM contacts c
		LEFT JOIN event_participants ep ON ep.event_id=$2 AND ep.contact_id=c.id
		LEFT JOIN event_pipeline_stages eps ON eps.id=ep.stage_id
		WHERE %s
		ORDER BY COALESCE(NULLIF(BTRIM(c.custom_name),''),NULLIF(BTRIM(c.name),''),NULLIF(BTRIM(c.push_name),''),c.phone,c.jid),c.id
		LIMIT $%d OFFSET $%d
	`, eligibilitySQL, where, limitArg, offsetArg), dataArgs...)
	if err != nil {
		return page, err
	}
	contactsByID := make(map[uuid.UUID]*domain.Contact, filter.Limit)
	pageContactIDs := make([]uuid.UUID, 0, filter.Limit)
	for rows.Next() {
		contact := &domain.Contact{}
		candidate := &domain.EventParticipantCandidate{Contact: contact}
		var membershipState *string
		var matchesRule bool
		if err := rows.Scan(
			&contact.ID, &contact.AccountID, &contact.JID, &contact.Phone, &contact.Name, &contact.LastName, &contact.ShortName,
			&contact.CustomName, &contact.PushName, &contact.Email, &contact.Company, &contact.IsGroup, &contact.DoNotContact,
			&contact.CreatedAt, &contact.UpdatedAt,
			&matchesRule,
			&candidate.ParticipantID, &membershipState, &candidate.StageID, &candidate.StageName, &candidate.StageColor,
			&candidate.MembershipSource, &candidate.MembershipReason,
		); err != nil {
			return page, err
		}
		candidate.RuleMatch = matchesRule
		candidate.MembershipStatus, candidate.Eligibility, candidate.CanAdd = classifyParticipantCandidate(state.Status, page.HasRules, matchesRule, membershipState)
		page.Candidates = append(page.Candidates, candidate)
		contactsByID[contact.ID] = contact
		pageContactIDs = append(pageContactIDs, contact.ID)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return page, err
	}
	rows.Close()

	// Load relations only for the visible page. Both joins re-assert account
	// ownership so an invalid relation can never expose another account's data.
	if len(pageContactIDs) > 0 {
		tagRows, queryErr := tx.Query(ctx, `
			SELECT ct.contact_id,t.id,t.account_id,t.name,t.color,t.created_at,t.updated_at
			FROM contact_tags ct
			JOIN contacts owned ON owned.id=ct.contact_id AND owned.account_id=$1
			JOIN tags t ON t.id=ct.tag_id AND t.account_id=owned.account_id
			WHERE ct.contact_id=ANY($2::uuid[])
			ORDER BY ct.contact_id,t.name,t.id
		`, accountID, pageContactIDs)
		if queryErr != nil {
			return page, queryErr
		}
		for tagRows.Next() {
			var contactID uuid.UUID
			tag := &domain.Tag{}
			if err := tagRows.Scan(&contactID, &tag.ID, &tag.AccountID, &tag.Name, &tag.Color, &tag.CreatedAt, &tag.UpdatedAt); err != nil {
				tagRows.Close()
				return page, err
			}
			contactsByID[contactID].StructuredTags = append(contactsByID[contactID].StructuredTags, tag)
		}
		if err := tagRows.Err(); err != nil {
			tagRows.Close()
			return page, err
		}
		tagRows.Close()

		phoneRows, queryErr := tx.Query(ctx, `
			SELECT cp.id,cp.contact_id,cp.phone,COALESCE(cp.label,'mobile'),cp.created_at
			FROM contact_phones cp
			JOIN contacts owned ON owned.id=cp.contact_id AND owned.account_id=$1
			WHERE cp.contact_id=ANY($2::uuid[])
			ORDER BY cp.contact_id,cp.created_at,cp.id
		`, accountID, pageContactIDs)
		if queryErr != nil {
			return page, queryErr
		}
		for phoneRows.Next() {
			phone := domain.ContactPhone{}
			if err := phoneRows.Scan(&phone.ID, &phone.ContactID, &phone.Phone, &phone.Label, &phone.CreatedAt); err != nil {
				phoneRows.Close()
				return page, err
			}
			contactsByID[phone.ContactID].ExtraPhones = append(contactsByID[phone.ContactID].ExtraPhones, phone)
		}
		if err := phoneRows.Err(); err != nil {
			phoneRows.Close()
			return page, err
		}
		phoneRows.Close()
	}
	page.HasMore = filter.Offset+len(page.Candidates) < page.Total
	return page, tx.Commit(ctx)
}

func loadParticipantContactSnapshotsTx(ctx context.Context, tx pgx.Tx, accountID uuid.UUID, contactIDs []uuid.UUID) (map[uuid.UUID]eventParticipantContactSnapshot, error) {
	result := make(map[uuid.UUID]eventParticipantContactSnapshot, len(contactIDs))
	if len(contactIDs) == 0 {
		return result, nil
	}
	rows, err := tx.Query(ctx, `
		SELECT c.id,COALESCE(NULLIF(BTRIM(c.custom_name),''),NULLIF(BTRIM(c.name),''),NULLIF(BTRIM(c.push_name),''),NULLIF(BTRIM(c.phone),''),c.jid),
		       c.last_name,c.short_name,c.phone,c.email,c.age,c.company,c.dni,c.birth_date,c.address,c.distrito,c.ocupacion,c.is_group
		FROM contacts c WHERE c.account_id=$1 AND c.id=ANY($2::uuid[])
	`, accountID, contactIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var snapshot eventParticipantContactSnapshot
		if err := rows.Scan(&snapshot.ID, &snapshot.Name, &snapshot.LastName, &snapshot.ShortName, &snapshot.Phone, &snapshot.Email, &snapshot.Age,
			&snapshot.Company, &snapshot.DNI, &snapshot.BirthDate, &snapshot.Address, &snapshot.Distrito, &snapshot.Ocupacion, &snapshot.IsGroup); err != nil {
			return nil, err
		}
		result[snapshot.ID] = snapshot
	}
	return result, rows.Err()
}

func defaultEventStageTx(ctx context.Context, tx pgx.Tx, pipelineID *uuid.UUID) (*uuid.UUID, error) {
	if pipelineID == nil {
		return nil, nil
	}
	var stageID uuid.UUID
	err := tx.QueryRow(ctx, `SELECT id FROM event_pipeline_stages WHERE pipeline_id=$1 ORDER BY position,created_at,id LIMIT 1`, *pipelineID).Scan(&stageID)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &stageID, nil
}

func applySnapshotToParticipant(p *domain.EventParticipant, eventID uuid.UUID, snapshot eventParticipantContactSnapshot, stageID *uuid.UUID) {
	p.EventID = eventID
	p.ContactID = &snapshot.ID
	p.LeadID = nil
	p.StageID = stageID
	p.Name = snapshot.Name
	p.LastName = snapshot.LastName
	p.ShortName = snapshot.ShortName
	p.Phone = snapshot.Phone
	p.Email = snapshot.Email
	p.Age = snapshot.Age
	p.Company = snapshot.Company
	p.DNI = snapshot.DNI
	p.BirthDate = snapshot.BirthDate
	p.Address = snapshot.Address
	p.Distrito = snapshot.Distrito
	p.Ocupacion = snapshot.Ocupacion
}

func addRejected(summary *EventParticipantAddSummary, contactID *uuid.UUID, code, message string) {
	summary.Rejected++
	summary.Results = append(summary.Results, &EventParticipantAddResult{
		ContactID: contactID,
		Outcome:   ParticipantAddRejected,
		Code:      code,
		Error:     message,
	})
}

// ensureManualEventContactTx resolves or creates the Contact parent for legacy
// manual event entry. It runs after the event row is locked by AddStrict, so
// Contact creation and membership either commit together or both roll back.
func ensureManualEventContactTx(ctx context.Context, tx pgx.Tx, accountID uuid.UUID, participant *domain.EventParticipant) (uuid.UUID, error) {
	if participant == nil || strings.TrimSpace(participant.Name) == "" {
		return uuid.Nil, fmt.Errorf("manual event contact requires a name")
	}
	phone := ""
	if participant.Phone != nil {
		phone = normalizeAliasValue("phone", *participant.Phone)
	}
	jid := ""
	if phone != "" {
		jid = phone + "@s.whatsapp.net"
	}

	var contactID uuid.UUID
	if phone != "" {
		err := tx.QueryRow(ctx, `
			SELECT c.id
			FROM contacts c
			WHERE c.account_id=$1 AND c.is_group=FALSE AND (
				LOWER(BTRIM(c.jid))=$2
				OR CASE
					WHEN LENGTH(REGEXP_REPLACE(COALESCE(c.phone,''),'[^0-9]','','g'))=9
					 AND REGEXP_REPLACE(COALESCE(c.phone,''),'[^0-9]','','g') LIKE '9%'
					THEN '51'||REGEXP_REPLACE(COALESCE(c.phone,''),'[^0-9]','','g')
					ELSE REGEXP_REPLACE(COALESCE(c.phone,''),'[^0-9]','','g')
				END=$3
				OR EXISTS (
					SELECT 1 FROM contact_aliases ca
					WHERE ca.account_id=$1 AND ca.contact_id=c.id
					  AND ((ca.alias_type='jid' AND ca.normalized_value=$2)
					    OR (ca.alias_type='phone' AND ca.normalized_value=$3))
				)
			)
			ORDER BY CASE WHEN LOWER(BTRIM(c.jid))=$2 THEN 0 ELSE 1 END,c.created_at,c.id
			LIMIT 1
		`, accountID, strings.ToLower(jid), phone).Scan(&contactID)
		if err != nil && err != pgx.ErrNoRows {
			return uuid.Nil, err
		}
	}

	if contactID == uuid.Nil && participant.Email != nil && strings.TrimSpace(*participant.Email) != "" {
		rows, err := tx.Query(ctx, `SELECT id FROM contacts WHERE account_id=$1 AND is_group=FALSE AND LOWER(BTRIM(email))=LOWER(BTRIM($2)) ORDER BY id LIMIT 2`, accountID, *participant.Email)
		if err != nil {
			return uuid.Nil, err
		}
		matches := make([]uuid.UUID, 0, 2)
		for rows.Next() {
			var id uuid.UUID
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return uuid.Nil, err
			}
			matches = append(matches, id)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return uuid.Nil, err
		}
		rows.Close()
		if len(matches) == 1 {
			contactID = matches[0]
		}
	}

	if contactID == uuid.Nil {
		if jid == "" {
			jid = "event_" + uuid.NewString() + "@clarin.local"
		}
		if err := tx.QueryRow(ctx, `
			INSERT INTO contacts(account_id,jid,phone,name,last_name,short_name,email,age,source,is_group)
			VALUES($1,$2,NULLIF($3,''),$4,$5,$6,$7,$8,'event',FALSE)
			ON CONFLICT(account_id,jid) DO UPDATE SET jid=EXCLUDED.jid
			RETURNING id
		`, accountID, jid, phone, participant.Name, participant.LastName, participant.ShortName, participant.Email, participant.Age).Scan(&contactID); err != nil {
			return uuid.Nil, err
		}
	}

	// Preserve durable outbound suppression for contacts recreated from a
	// previously blocked phone/JID while remaining inside the atomic add.
	if _, err := tx.Exec(ctx, `
		UPDATE contacts c SET
			do_not_contact=TRUE,
			do_not_contact_at=COALESCE(c.do_not_contact_at,(
				SELECT cs.created_at FROM contact_suppressions cs
				WHERE cs.account_id=$1 AND cs.active=TRUE
				  AND cs.normalized_value IN (LOWER(BTRIM(c.jid)),REGEXP_REPLACE(COALESCE(c.phone,''),'[^0-9]','','g'))
				ORDER BY cs.updated_at DESC,cs.created_at DESC LIMIT 1
			),NOW()),
			do_not_contact_reason=COALESCE(NULLIF(c.do_not_contact_reason,''),NULLIF((
				SELECT cs.reason FROM contact_suppressions cs
				WHERE cs.account_id=$1 AND cs.active=TRUE
				  AND cs.normalized_value IN (LOWER(BTRIM(c.jid)),REGEXP_REPLACE(COALESCE(c.phone,''),'[^0-9]','','g'))
				ORDER BY cs.updated_at DESC,cs.created_at DESC LIMIT 1
			),''),'Supresión histórica por identidad'),
			updated_at=NOW()
		WHERE c.id=$2 AND c.account_id=$1 AND c.do_not_contact=FALSE
		  AND EXISTS (
			SELECT 1 FROM contact_suppressions cs
			WHERE cs.account_id=$1 AND cs.active=TRUE
			  AND cs.normalized_value IN (LOWER(BTRIM(c.jid)),REGEXP_REPLACE(COALESCE(c.phone,''),'[^0-9]','','g'))
		  )
	`, accountID, contactID); err != nil {
		return uuid.Nil, err
	}
	return contactID, nil
}

// AddStrict adds/reactivates a batch in one transaction. Rejected contacts are
// explicit results; valid changes either all commit or all roll back. Active
// participants are true no-ops and never change provenance or audit history.
func (r *ParticipantRepository) AddStrict(ctx context.Context, accountID, eventID uuid.UUID, participants []*domain.EventParticipant, actor *uuid.UUID) (EventParticipantAddSummary, error) {
	summary := EventParticipantAddSummary{Results: make([]*EventParticipantAddResult, 0, len(participants))}
	if len(participants) == 0 {
		return summary, nil
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return summary, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1::text))`, accountID); err != nil {
		return summary, err
	}
	state, err := loadEventRuleStateTx(ctx, tx, eventID, accountID, true)
	if err != nil {
		return summary, err
	}
	if state.Status == domain.EventStatusCompleted || state.Status == domain.EventStatusCancelled {
		return summary, ErrEventMembershipFrozen
	}
	if !state.Config.HasRules() {
		for _, participant := range participants {
			if participant == nil || participant.ContactID != nil {
				continue
			}
			contactID, ensureErr := ensureManualEventContactTx(ctx, tx, accountID, participant)
			if ensureErr != nil {
				return summary, ensureErr
			}
			participant.ContactID = &contactID
		}
	}

	contactIDs := make([]uuid.UUID, 0, len(participants))
	seenForQuery := make(map[uuid.UUID]struct{}, len(participants))
	for _, participant := range participants {
		if participant.ContactID == nil {
			continue
		}
		if _, exists := seenForQuery[*participant.ContactID]; exists {
			continue
		}
		seenForQuery[*participant.ContactID] = struct{}{}
		contactIDs = append(contactIDs, *participant.ContactID)
	}
	snapshots, err := loadParticipantContactSnapshotsTx(ctx, tx, accountID, contactIDs)
	if err != nil {
		return summary, err
	}
	existing := make(map[uuid.UUID]existingEventParticipant, len(contactIDs))
	if len(contactIDs) > 0 {
		rows, queryErr := tx.Query(ctx, `SELECT id,contact_id,membership_state,stage_id FROM event_participants WHERE event_id=$1 AND contact_id=ANY($2::uuid[]) FOR UPDATE`, eventID, contactIDs)
		if queryErr != nil {
			return summary, queryErr
		}
		for rows.Next() {
			var row existingEventParticipant
			var contactID uuid.UUID
			if err := rows.Scan(&row.ID, &contactID, &row.MembershipState, &row.StageID); err != nil {
				rows.Close()
				return summary, err
			}
			existing[contactID] = row
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return summary, err
		}
		rows.Close()
	}

	// Active memberships are true no-ops. Only contacts that may be created or
	// reactivated need tag facts/default-stage/rule evaluation.
	contactIDsToEvaluate := make([]uuid.UUID, 0, len(contactIDs))
	needsEvaluation := make(map[uuid.UUID]struct{}, len(contactIDs))
	for _, contactID := range contactIDs {
		snapshot, validContact := snapshots[contactID]
		if !validContact || snapshot.IsGroup {
			continue
		}
		if row, exists := existing[contactID]; exists && row.MembershipState == CandidateMembershipActive {
			continue
		}
		contactIDsToEvaluate = append(contactIDsToEvaluate, contactID)
		needsEvaluation[contactID] = struct{}{}
	}
	facts, err := loadContactRuleFactsTx(ctx, tx, accountID, contactIDsToEvaluate)
	if err != nil {
		return summary, err
	}
	var defaultStageID *uuid.UUID
	if len(contactIDsToEvaluate) > 0 {
		defaultStageID, err = defaultEventStageTx(ctx, tx, state.PipelineID)
		if err != nil {
			return summary, err
		}
	}

	validStages := make(map[uuid.UUID]struct{})
	requestedStageIDs := make([]uuid.UUID, 0)
	for _, participant := range participants {
		if participant.ContactID == nil || participant.StageID == nil {
			continue
		}
		if _, evaluate := needsEvaluation[*participant.ContactID]; evaluate {
			requestedStageIDs = append(requestedStageIDs, *participant.StageID)
		}
	}
	if len(requestedStageIDs) > 0 && state.PipelineID != nil {
		rows, queryErr := tx.Query(ctx, `SELECT id FROM event_pipeline_stages WHERE pipeline_id=$1 AND id=ANY($2::uuid[])`, *state.PipelineID, requestedStageIDs)
		if queryErr != nil {
			return summary, queryErr
		}
		for rows.Next() {
			var stageID uuid.UUID
			if err := rows.Scan(&stageID); err != nil {
				rows.Close()
				return summary, err
			}
			validStages[stageID] = struct{}{}
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return summary, err
		}
		rows.Close()
	}

	processed := make(map[uuid.UUID]struct{}, len(participants))
	autoTagSync := strictAddAutoTagSync(state.Config)
	metadataBytes, _ := json.Marshal(map[string]interface{}{"has_rules": state.Config.HasRules()})
	metadata := string(metadataBytes)
	correlationID := uuid.New()
	now := time.Now()
	for _, participant := range participants {
		if participant.ContactID == nil {
			addRejected(&summary, nil, "CONTACT_REQUIRED", "El participante necesita un contacto")
			continue
		}
		contactID := *participant.ContactID
		if _, duplicate := processed[contactID]; duplicate {
			addRejected(&summary, &contactID, "DUPLICATE_CONTACT", "El contacto está repetido en la solicitud")
			continue
		}
		processed[contactID] = struct{}{}
		snapshot, exists := snapshots[contactID]
		if !exists || snapshot.IsGroup {
			addRejected(&summary, &contactID, "CONTACT_NOT_FOUND", "El contacto no pertenece a la cuenta")
			continue
		}
		row, alreadyExists := existing[contactID]
		if alreadyExists && appendAlreadyActiveNoOp(&summary, participant, contactID, row) {
			continue
		}
		matches, matchErr := contactMatchesRuleFacts(state.Config, facts[contactID])
		if matchErr != nil {
			return summary, matchErr
		}
		if state.Config.HasRules() && !matches {
			addRejected(&summary, &contactID, "EVENT_RULE_NOT_MATCHED", "El contacto no cumple las reglas del evento")
			continue
		}
		stageID := participant.StageID
		if stageID != nil {
			if _, valid := validStages[*stageID]; !valid {
				addRejected(&summary, &contactID, "EVENT_STAGE_INVALID", "La etapa no pertenece al evento")
				continue
			}
		} else {
			stageID = defaultStageID
		}
		applySnapshotToParticipant(participant, eventID, snapshot, stageID)
		if alreadyExists {
			chosenStageID := row.StageID
			if chosenStageID == nil {
				chosenStageID = stageID
			}
			if _, err := tx.Exec(ctx, `
				UPDATE event_participants SET
					stage_id=$1,name=$2,last_name=$3,short_name=$4,phone=$5,email=$6,age=$7,company=$8,dni=$9,birth_date=$10,address=$11,distrito=$12,ocupacion=$13,
					membership_state='active',membership_reason='',membership_source='manual',auto_tag_sync=$14,membership_changed_at=NOW(),updated_at=NOW()
				WHERE id=$15 AND event_id=$16 AND membership_state='inactive'
			`, chosenStageID, snapshot.Name, snapshot.LastName, snapshot.ShortName, snapshot.Phone, snapshot.Email, snapshot.Age, snapshot.Company, snapshot.DNI,
				snapshot.BirthDate, snapshot.Address, snapshot.Distrito, snapshot.Ocupacion, autoTagSync, row.ID, eventID); err != nil {
				return summary, err
			}
			if err := insertMembershipAudit(ctx, tx, accountID, eventID, row.ID, &contactID, "reactivated", "manual_add", state.RuleRevision, actor,
				`{"membership_state":"inactive"}`, `{"membership_state":"active","source":"manual"}`, metadata, correlationID); err != nil {
				return summary, err
			}
			participant.ID = row.ID
			participant.StageID = chosenStageID
			participant.MembershipState = CandidateMembershipActive
			participant.MembershipSource = "manual"
			participant.MembershipChangedAt = &now
			summary.Reactivated++
			summary.Results = append(summary.Results, &EventParticipantAddResult{ContactID: &contactID, ParticipantID: &row.ID, Outcome: ParticipantAddReactivated})
			continue
		}
		participant.ID = uuid.New()
		status := participant.Status
		if status == "" {
			status = domain.ParticipantStatusInvited
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO event_participants (
				id,event_id,contact_id,lead_id,stage_id,name,last_name,short_name,phone,email,age,company,dni,birth_date,address,distrito,ocupacion,
				status,notes,next_action,next_action_date,auto_tag_sync,membership_state,membership_reason,membership_source,membership_changed_at,invited_at,created_at,updated_at
			) VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,'active','','manual',NOW(),NOW(),NOW(),NOW())
		`, participant.ID, eventID, contactID, stageID, snapshot.Name, snapshot.LastName, snapshot.ShortName, snapshot.Phone, snapshot.Email, snapshot.Age,
			snapshot.Company, snapshot.DNI, snapshot.BirthDate, snapshot.Address, snapshot.Distrito, snapshot.Ocupacion, status, participant.Notes, participant.NextAction, participant.NextActionDate, autoTagSync); err != nil {
			return summary, err
		}
		if err := insertMembershipAudit(ctx, tx, accountID, eventID, participant.ID, &contactID, "created", "manual_add", state.RuleRevision, actor,
			`{}`, `{"membership_state":"active","source":"manual"}`, metadata, correlationID); err != nil {
			return summary, err
		}
		participant.Status = status
		participant.AutoTagSync = autoTagSync
		participant.MembershipState = CandidateMembershipActive
		participant.MembershipSource = "manual"
		participant.MembershipChangedAt = &now
		participant.InvitedAt = &now
		participant.CreatedAt = now
		participant.UpdatedAt = now
		summary.Created++
		summary.Results = append(summary.Results, &EventParticipantAddResult{ContactID: &contactID, ParticipantID: &participant.ID, Outcome: ParticipantAddCreated})
	}
	if err := tx.Commit(ctx); err != nil {
		return summary, err
	}
	return summary, nil
}

// GetForEvent returns one participant only when all three scope identifiers
// match. It is the authoritative lookup for participant subroutes.
func (r *ParticipantRepository) GetForEvent(ctx context.Context, accountID, eventID, participantID uuid.UUID) (*domain.EventParticipant, error) {
	p := &domain.EventParticipant{}
	err := r.db.QueryRow(ctx, `
		SELECT ep.id,ep.event_id,ep.contact_id,ep.lead_id,ep.stage_id,
		       COALESCE(NULLIF(BTRIM(c.custom_name),''),NULLIF(BTRIM(c.name),''),NULLIF(BTRIM(c.push_name),''),ep.name),
		       COALESCE(c.last_name,ep.last_name),COALESCE(c.short_name,ep.short_name),COALESCE(c.phone,ep.phone),COALESCE(c.email,ep.email),COALESCE(c.age,ep.age),
		       COALESCE(c.company,ep.company),COALESCE(c.dni,ep.dni),COALESCE(c.birth_date,ep.birth_date),COALESCE(c.address,ep.address),COALESCE(c.distrito,ep.distrito),COALESCE(c.ocupacion,ep.ocupacion),
		       ep.status,ep.notes,ep.next_action,ep.next_action_date,ep.invited_at,ep.confirmed_at,ep.attended_at,
		       ep.auto_tag_sync,ep.membership_state,ep.membership_reason,ep.membership_source,ep.membership_changed_at,ep.created_at,ep.updated_at,
		       eps.name,eps.color,COALESCE(c.do_not_contact,FALSE)
		FROM event_participants ep
		JOIN events e ON e.id=ep.event_id AND e.account_id=$1
		LEFT JOIN contacts c ON c.id=ep.contact_id AND c.account_id=e.account_id
		LEFT JOIN event_pipeline_stages eps ON eps.id=ep.stage_id AND eps.pipeline_id=e.pipeline_id
		WHERE ep.id=$3 AND ep.event_id=$2
	`, accountID, eventID, participantID).Scan(
		&p.ID, &p.EventID, &p.ContactID, &p.LeadID, &p.StageID, &p.Name, &p.LastName, &p.ShortName, &p.Phone, &p.Email, &p.Age,
		&p.Company, &p.DNI, &p.BirthDate, &p.Address, &p.Distrito, &p.Ocupacion,
		&p.Status, &p.Notes, &p.NextAction, &p.NextActionDate, &p.InvitedAt, &p.ConfirmedAt, &p.AttendedAt,
		&p.AutoTagSync, &p.MembershipState, &p.MembershipReason, &p.MembershipSource, &p.MembershipChangedAt, &p.CreatedAt, &p.UpdatedAt,
		&p.StageName, &p.StageColor, &p.IsBlocked,
	)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	return p, err
}

// EnrichRelatedLeads loads Contact opportunities in one account-scoped batch.
func (r *ParticipantRepository) EnrichRelatedLeads(ctx context.Context, accountID uuid.UUID, participants []*domain.EventParticipant) error {
	contactIDs := make([]uuid.UUID, 0, len(participants))
	seen := make(map[uuid.UUID]struct{}, len(participants))
	for _, participant := range participants {
		emptyLeads := make([]*domain.EventParticipantRelatedLead, 0)
		activeLeadCount := 0
		participant.RelatedLeads = &emptyLeads
		participant.ActiveLeadCount = &activeLeadCount
		if participant.ContactID == nil {
			continue
		}
		if _, ok := seen[*participant.ContactID]; ok {
			continue
		}
		seen[*participant.ContactID] = struct{}{}
		contactIDs = append(contactIDs, *participant.ContactID)
	}
	if len(contactIDs) == 0 {
		return nil
	}
	rows, err := r.db.Query(ctx, `
		SELECT l.contact_id,l.id,l.title,COALESCE(l.status,'open'),l.pipeline_id,p.name,l.stage_id,ps.name,ps.color,l.is_archived,l.updated_at
		FROM leads l
		JOIN contacts c ON c.id=l.contact_id AND c.account_id=l.account_id
		LEFT JOIN pipelines p ON p.id=l.pipeline_id AND p.account_id=l.account_id
		LEFT JOIN pipeline_stages ps ON ps.id=l.stage_id AND ps.pipeline_id=l.pipeline_id
		WHERE l.account_id=$1 AND l.contact_id=ANY($2::uuid[]) AND l.deleted_at IS NULL
		ORDER BY l.contact_id,
		         CASE WHEN COALESCE(l.status,'open')='open' AND l.is_archived=FALSE THEN 0 ELSE 1 END,
		         l.updated_at DESC,l.id DESC
	`, accountID, contactIDs)
	if err != nil {
		return err
	}
	defer rows.Close()
	byContact := make(map[uuid.UUID][]*domain.EventParticipantRelatedLead, len(contactIDs))
	for rows.Next() {
		var contactID uuid.UUID
		lead := &domain.EventParticipantRelatedLead{}
		if err := rows.Scan(&contactID, &lead.ID, &lead.Title, &lead.Status, &lead.PipelineID, &lead.PipelineName, &lead.StageID, &lead.StageName, &lead.StageColor, &lead.IsArchived, &lead.UpdatedAt); err != nil {
			return err
		}
		byContact[contactID] = append(byContact[contactID], lead)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, participant := range participants {
		if participant.ContactID == nil {
			continue
		}
		relatedLeads := byContact[*participant.ContactID]
		if relatedLeads == nil {
			relatedLeads = make([]*domain.EventParticipantRelatedLead, 0)
		}
		activeLeadCount := 0
		for _, lead := range relatedLeads {
			if lead.Status == domain.LeadStatusOpen && !lead.IsArchived {
				activeLeadCount++
				if participant.LeadPipelineID == nil && participant.LeadStageID == nil {
					participant.LeadPipelineID = lead.PipelineID
					participant.LeadPipelineName = lead.PipelineName
					participant.LeadStageID = lead.StageID
					participant.LeadStageName = lead.StageName
					participant.LeadStageColor = lead.StageColor
				}
			}
		}
		participant.RelatedLeads = &relatedLeads
		participant.ActiveLeadCount = &activeLeadCount
	}
	return nil
}

// ReconcileContactMembership evaluates only one Contact against active event
// rules. It replaces the previous full-account scan on every tag mutation.
func (r *EventRepository) ReconcileContactMembership(ctx context.Context, accountID, contactID uuid.UUID, source string) ([]ContactMembershipImpact, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1::text))`, accountID); err != nil {
		return nil, err
	}
	var policyMode string
	if err := tx.QueryRow(ctx, `SELECT COALESCE((SELECT mode FROM event_membership_policy_state WHERE account_id=$1),'audit_only')`, accountID).Scan(&policyMode); err != nil {
		return nil, err
	}
	if !targetedRuleReconciliationEnabled(policyMode) {
		return []ContactMembershipImpact{}, tx.Commit(ctx)
	}
	snapshots, err := loadParticipantContactSnapshotsTx(ctx, tx, accountID, []uuid.UUID{contactID})
	if err != nil {
		return nil, err
	}
	snapshot, exists := snapshots[contactID]
	if !exists || snapshot.IsGroup {
		return []ContactMembershipImpact{}, tx.Commit(ctx)
	}
	factsByContact, err := loadContactRuleFactsTx(ctx, tx, accountID, []uuid.UUID{contactID})
	if err != nil {
		return nil, err
	}
	facts := factsByContact[contactID]
	rows, err := tx.Query(ctx, `
		SELECT e.id,e.pipeline_id,e.rule_revision,e.tag_formula_type,e.tag_formula_mode,e.tag_formula,
		       COALESCE(array_agg(et.tag_id) FILTER (WHERE et.negate=FALSE),'{}'::uuid[]),
		       COALESCE(array_agg(et.tag_id) FILTER (WHERE et.negate=TRUE),'{}'::uuid[])
		FROM events e
		LEFT JOIN event_tags et ON et.event_id=e.id
		WHERE e.account_id=$1 AND e.status='active'
		  AND (et.event_id IS NOT NULL OR (e.tag_formula_type='advanced' AND NULLIF(BTRIM(e.tag_formula),'') IS NOT NULL))
		GROUP BY e.id,e.pipeline_id,e.rule_revision,e.tag_formula_type,e.tag_formula_mode,e.tag_formula
		ORDER BY e.id
	`, accountID)
	if err != nil {
		return nil, err
	}
	type ruleRow struct {
		eventID    uuid.UUID
		pipelineID *uuid.UUID
		revision   int64
		config     EventRuleConfig
	}
	rules := make([]ruleRow, 0)
	for rows.Next() {
		var rule ruleRow
		if err := rows.Scan(&rule.eventID, &rule.pipelineID, &rule.revision, &rule.config.FormulaType, &rule.config.FormulaMode, &rule.config.Formula, &rule.config.Includes, &rule.config.Excludes); err != nil {
			rows.Close()
			return nil, err
		}
		rule.config = normalizeRuleConfig(rule.config)
		rules = append(rules, rule)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	impacts := make([]ContactMembershipImpact, 0)
	correlationID := uuid.New()
	for _, rule := range rules {
		matches, matchErr := contactMatchesRuleFacts(rule.config, facts)
		if matchErr != nil {
			return nil, matchErr
		}
		var existingID uuid.UUID
		var membershipState string
		existingErr := tx.QueryRow(ctx, `SELECT id,membership_state FROM event_participants WHERE event_id=$1 AND contact_id=$2 FOR UPDATE`, rule.eventID, contactID).Scan(&existingID, &membershipState)
		if existingErr != nil && existingErr != pgx.ErrNoRows {
			return nil, existingErr
		}
		impact := ContactMembershipImpact{EventID: rule.eventID}
		metadataBytes, _ := json.Marshal(map[string]interface{}{"rule": rule.config})
		metadata := string(metadataBytes)
		if matches && existingErr == pgx.ErrNoRows {
			stageID, stageErr := defaultEventStageTx(ctx, tx, rule.pipelineID)
			if stageErr != nil {
				return nil, stageErr
			}
			participantID := uuid.New()
			if _, err := tx.Exec(ctx, `
				INSERT INTO event_participants (id,event_id,contact_id,stage_id,name,last_name,short_name,phone,email,age,company,dni,birth_date,address,distrito,ocupacion,status,auto_tag_sync,membership_state,membership_reason,membership_source,membership_changed_at,invited_at,created_at,updated_at)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'invited',TRUE,'active','','rule',NOW(),NOW(),NOW(),NOW())
			`, participantID, rule.eventID, contactID, stageID, snapshot.Name, snapshot.LastName, snapshot.ShortName, snapshot.Phone, snapshot.Email, snapshot.Age,
				snapshot.Company, snapshot.DNI, snapshot.BirthDate, snapshot.Address, snapshot.Distrito, snapshot.Ocupacion); err != nil {
				return nil, err
			}
			if err := insertMembershipAudit(ctx, tx, accountID, rule.eventID, participantID, &contactID, "created", source, rule.revision, nil, `{}`, `{"membership_state":"active","source":"rule"}`, metadata, correlationID); err != nil {
				return nil, err
			}
			impact.Created = 1
		} else if matches && membershipState == CandidateMembershipInactive {
			if _, err := tx.Exec(ctx, `UPDATE event_participants SET membership_state='active',membership_reason='',membership_source='rule',auto_tag_sync=TRUE,membership_changed_at=NOW(),updated_at=NOW() WHERE id=$1 AND event_id=$2`, existingID, rule.eventID); err != nil {
				return nil, err
			}
			if err := insertMembershipAudit(ctx, tx, accountID, rule.eventID, existingID, &contactID, "reactivated", source, rule.revision, nil, `{"membership_state":"inactive"}`, `{"membership_state":"active","source":"rule"}`, metadata, correlationID); err != nil {
				return nil, err
			}
			impact.Reactivated = 1
		} else if !matches && existingErr == nil && membershipState == CandidateMembershipActive {
			if _, err := tx.Exec(ctx, `UPDATE event_participants SET membership_state='inactive',membership_reason='rule_ineligible',membership_changed_at=NOW(),updated_at=NOW() WHERE id=$1 AND event_id=$2`, existingID, rule.eventID); err != nil {
				return nil, err
			}
			if err := insertMembershipAudit(ctx, tx, accountID, rule.eventID, existingID, &contactID, "deactivated", source, rule.revision, nil, `{"membership_state":"active"}`, `{"membership_state":"inactive","reason":"rule_ineligible"}`, metadata, correlationID); err != nil {
				return nil, err
			}
			impact.Deactivated = 1
		}
		if impact.Created+impact.Reactivated+impact.Deactivated > 0 {
			impacts = append(impacts, impact)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return impacts, nil
}

func (i ContactMembershipImpact) String() string {
	return fmt.Sprintf("event=%s created=%d reactivated=%d deactivated=%d", i.EventID, i.Created, i.Reactivated, i.Deactivated)
}
