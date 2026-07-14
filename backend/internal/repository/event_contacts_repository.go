package repository

import (
	"context"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

type EventWithTagRules struct {
	Event    *domain.Event
	Includes []uuid.UUID
	Excludes []uuid.UUID
}

// GetActiveEventRulesByAccount returns only the active event enrollment rules
// for one account. Contact mutations must never scan or evaluate another
// account's event configuration.
func (r *EventRepository) GetActiveEventRulesByAccount(ctx context.Context, accountID uuid.UUID) ([]EventWithTagRules, error) {
	rows, err := r.db.Query(ctx, `
		SELECT e.id, e.account_id, e.pipeline_id, e.name, e.status, e.tag_formula_mode, e.tag_formula, e.tag_formula_type,
		       array_agg(et.tag_id) FILTER (WHERE et.negate = FALSE) AS include_ids,
		       array_agg(et.tag_id) FILTER (WHERE et.negate = TRUE) AS exclude_ids
		FROM events e
		LEFT JOIN event_tags et ON et.event_id = e.id
		WHERE e.account_id = $1 AND e.status = 'active'
		  AND (et.event_id IS NOT NULL OR (e.tag_formula_type = 'advanced' AND e.tag_formula != ''))
		GROUP BY e.id, e.account_id, e.pipeline_id, e.name, e.status, e.tag_formula_mode, e.tag_formula, e.tag_formula_type
	`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	results := make([]EventWithTagRules, 0)
	for rows.Next() {
		ev := &domain.Event{}
		var includes, excludes []uuid.UUID
		if err := rows.Scan(&ev.ID, &ev.AccountID, &ev.PipelineID, &ev.Name, &ev.Status, &ev.TagFormulaMode, &ev.TagFormula, &ev.TagFormulaType, &includes, &excludes); err != nil {
			return nil, err
		}
		results = append(results, EventWithTagRules{Event: ev, Includes: includes, Excludes: excludes})
	}
	return results, rows.Err()
}

// GetContactIDsByFormulaText executes a contact formula produced by
// formula.BuildSQLForContacts.
func (r *EventRepository) GetContactIDsByFormulaText(ctx context.Context, sql string, args []interface{}) ([]uuid.UUID, error) {
	rows, err := r.db.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// GetContactIDsByTagFormula evaluates the simple include/exclude formula on
// contact_tags. It does not depend on leads or their lifecycle.
func (r *EventRepository) GetContactIDsByTagFormula(ctx context.Context, accountID uuid.UUID, mode string, includes, excludes []uuid.UUID) ([]uuid.UUID, error) {
	if len(includes) == 0 {
		if len(excludes) == 0 {
			return nil, nil
		}
		return r.GetContactIDsByFormulaText(ctx, `
			SELECT c.id FROM contacts c
			WHERE c.account_id=$1 AND c.is_group=FALSE
			  AND NOT EXISTS (SELECT 1 FROM contact_tags ct WHERE ct.contact_id=c.id AND ct.tag_id=ANY($2))
		`, []interface{}{accountID, excludes})
	}
	args := []interface{}{accountID, includes}
	var query string
	if strings.EqualFold(mode, "AND") {
		query = `
			SELECT c.id AS contact_id
			FROM contacts c JOIN contact_tags ct ON ct.contact_id=c.id
			WHERE c.account_id=$1 AND c.is_group=FALSE AND ct.tag_id=ANY($2)
			GROUP BY c.id HAVING COUNT(DISTINCT ct.tag_id)=$3
		`
		args = append(args, len(includes))
	} else {
		query = `
			SELECT DISTINCT c.id AS contact_id
			FROM contacts c JOIN contact_tags ct ON ct.contact_id=c.id
			WHERE c.account_id=$1 AND c.is_group=FALSE AND ct.tag_id=ANY($2)
		`
	}
	if len(excludes) > 0 {
		arg := len(args) + 1
		query = fmt.Sprintf(`SELECT contact_id FROM (%s) matches WHERE contact_id NOT IN (
			SELECT c2.id FROM contacts c2 JOIN contact_tags ct2 ON ct2.contact_id=c2.id
			WHERE c2.account_id=$1 AND ct2.tag_id=ANY($%d)
		)`, query, arg)
		args = append(args, excludes)
	}
	return r.GetContactIDsByFormulaText(ctx, query, args)
}

func (r *EventRepository) GetContactTagNames(ctx context.Context, accountID, contactID uuid.UUID) ([]string, error) {
	rows, err := r.db.Query(ctx, `
		SELECT LOWER(t.name) FROM contact_tags ct JOIN tags t ON t.id=ct.tag_id
		JOIN contacts c ON c.id=ct.contact_id
		WHERE ct.contact_id=$1 AND c.account_id=$2 AND t.account_id=$2
	`, contactID, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var names []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		names = append(names, name)
	}
	return names, rows.Err()
}

func (r *EventRepository) ContactMatchesFormula(ctx context.Context, accountID, contactID uuid.UUID, mode string, includes, excludes []uuid.UUID) (bool, error) {
	if len(excludes) > 0 {
		var excluded bool
		if err := r.db.QueryRow(ctx, `
			SELECT EXISTS(SELECT 1 FROM contacts c JOIN contact_tags ct ON ct.contact_id=c.id
			WHERE c.id=$1 AND c.account_id=$2 AND ct.tag_id=ANY($3))
		`, contactID, accountID, excludes).Scan(&excluded); err != nil {
			return false, err
		}
		if excluded {
			return false, nil
		}
	}
	if len(includes) == 0 {
		return true, nil
	}
	var count int
	if err := r.db.QueryRow(ctx, `
		SELECT COUNT(DISTINCT ct.tag_id) FROM contacts c JOIN contact_tags ct ON ct.contact_id=c.id
		WHERE c.id=$1 AND c.account_id=$2 AND ct.tag_id=ANY($3)
	`, contactID, accountID, includes).Scan(&count); err != nil {
		return false, err
	}
	if strings.EqualFold(mode, "AND") {
		return count == len(includes), nil
	}
	return count > 0, nil
}

func (r *EventRepository) ParticipantExistsForContact(ctx context.Context, eventID, accountID, contactID uuid.UUID) (bool, error) {
	var exists bool
	err := r.db.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM event_participants ep JOIN events e ON e.id=ep.event_id
			WHERE ep.event_id=$1 AND e.account_id=$2 AND ep.contact_id=$3
		)
	`, eventID, accountID, contactID).Scan(&exists)
	return exists, err
}

// BulkAddParticipantsFromContacts adds at most one participant per
// event/contact. A recent lead is recorded only as optional provenance.
func (r *EventRepository) BulkAddParticipantsFromContacts(ctx context.Context, eventID, accountID uuid.UUID, stageID *uuid.UUID, contactIDs []uuid.UUID) (int, error) {
	if len(contactIDs) == 0 {
		return 0, nil
	}
	tag, err := r.db.Exec(ctx, `
		INSERT INTO event_participants (
			id,event_id,lead_id,contact_id,stage_id,name,last_name,short_name,phone,email,age,
			company,dni,birth_date,address,distrito,ocupacion,status,auto_tag_sync,invited_at,created_at,updated_at
		)
		SELECT gen_random_uuid(), e.id, NULL::uuid, c.id, $4,
		       COALESCE(c.custom_name,c.name,c.push_name,c.phone,c.jid), c.last_name, c.short_name, c.phone, c.email, c.age,
		       c.company,c.dni,c.birth_date,c.address,c.distrito,c.ocupacion,
		       'invited',TRUE,NOW(),NOW(),NOW()
		FROM events e
		JOIN contacts c ON c.account_id=e.account_id AND c.id=ANY($3) AND c.is_group=FALSE
		WHERE e.id=$1 AND e.account_id=$2
		  AND ($4::uuid IS NULL OR EXISTS (
			SELECT 1 FROM event_pipeline_stages eps WHERE eps.id=$4 AND eps.pipeline_id=e.pipeline_id
		  ))
		ON CONFLICT (event_id,contact_id) WHERE contact_id IS NOT NULL DO UPDATE SET
			membership_state='active',membership_reason='',membership_source='rule',auto_tag_sync=TRUE,membership_changed_at=NOW(),updated_at=NOW()
	`, eventID, accountID, contactIDs, stageID)
	if err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}
