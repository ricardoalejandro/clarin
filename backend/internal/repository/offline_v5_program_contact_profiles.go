package repository

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// A Program prepares only the canonical identities its exact roster needs.
// It grants read access to those identities, never Contact mutation authority
// or an implicit copy of the account's contact/history/catalog collections.
func offlineV5ProgramContactProfiles(ctx context.Context, tx pgx.Tx, accountID, programID uuid.UUID) ([]map[string]any, error) {
	rows, err := tx.Query(ctx, `SELECT c.id,jsonb_build_object(
		'id',c.id,'account_id',c.account_id,'name',c.name,'custom_name',c.custom_name,'last_name',c.last_name,
		'short_name',c.short_name,'push_name',c.push_name,'phone',c.phone,'email',c.email,'company',c.company,
		'age',c.age,'dni',c.dni,'birth_date',c.birth_date,'address',c.address,'distrito',c.distrito,
		'ocupacion',c.ocupacion,'notes',c.notes,'do_not_contact',COALESCE(c.do_not_contact,FALSE),'updated_at',c.updated_at)
		FROM contacts c WHERE c.account_id=$1 AND EXISTS (
		 SELECT 1 FROM program_participants participant JOIN programs program
		 ON program.id=participant.program_id AND program.account_id=c.account_id
		 WHERE participant.program_id=$2 AND participant.contact_id=c.id)
		ORDER BY c.id LIMIT $3 FOR SHARE OF c`, accountID, programID, offlineV3MaxSnapshotRows+1)
	if err != nil {
		return nil, err
	}
	profiles := make([]map[string]any, 0)
	byID := make(map[uuid.UUID]map[string]any)
	ids := make([]uuid.UUID, 0)
	for rows.Next() {
		var id uuid.UUID
		var raw json.RawMessage
		if err := rows.Scan(&id, &raw); err != nil {
			rows.Close()
			return nil, err
		}
		contact, err := offlineV5SnapshotObject(raw)
		if err != nil {
			rows.Close()
			return nil, err
		}
		profile := map[string]any{"contact": contact, "phones": []any{}, "tags": []any{}, "custom_fields": []any{},
			"custom_field_definitions": []any{}, "observation_count": 0, "history_prepared": false}
		byID[id] = profile
		profiles = append(profiles, profile)
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	if len(ids) > offlineV3MaxSnapshotRows {
		return nil, ErrOfflineSnapshotTooLarge
	}
	if len(ids) == 0 {
		return profiles, nil
	}

	queries := []struct{ collection, sql string }{
		{"phones", `SELECT p.contact_id,jsonb_build_object('id',p.id,'contact_id',p.contact_id,'phone',p.phone,'label',COALESCE(p.label,'mobile'))
		 FROM contact_phones p JOIN contacts c ON c.id=p.contact_id AND c.account_id=$1
		 WHERE p.contact_id=ANY($2::uuid[]) ORDER BY p.contact_id,p.created_at,p.id LIMIT $3`},
		{"tags", `SELECT link.contact_id,jsonb_build_object('id',tag.id,'name',tag.name,'color',tag.color)
		 FROM contact_tags link JOIN contacts c ON c.id=link.contact_id AND c.account_id=$1
		 JOIN tags tag ON tag.id=link.tag_id AND tag.account_id=c.account_id
		 WHERE link.contact_id=ANY($2::uuid[]) ORDER BY link.contact_id,LOWER(tag.name),tag.id LIMIT $3`},
		{"custom_fields", `SELECT value.contact_id,jsonb_build_object('id',value.id,'contact_id',value.contact_id,
		 'field_id',definition.id,'field_name',definition.name,'field_type',definition.field_type,
		 'value_text',value.value_text,'value_number',value.value_number,'value_date',value.value_date,
		 'value_bool',value.value_bool,'value_json',value.value_json)
		 FROM custom_field_values value JOIN contacts c ON c.id=value.contact_id AND c.account_id=$1
		 JOIN custom_field_definitions definition ON definition.id=value.field_id AND definition.account_id=c.account_id
		 WHERE value.contact_id=ANY($2::uuid[]) ORDER BY value.contact_id,definition.sort_order,definition.id LIMIT $3`},
	}
	for _, query := range queries {
		rows, err := tx.Query(ctx, query.sql, accountID, ids, offlineV3MaxSnapshotRows+1)
		if err != nil {
			return nil, err
		}
		count := 0
		for rows.Next() {
			var id uuid.UUID
			var raw json.RawMessage
			if err := rows.Scan(&id, &raw); err != nil {
				rows.Close()
				return nil, err
			}
			value, err := offlineV5SnapshotObject(raw)
			if err != nil {
				rows.Close()
				return nil, err
			}
			profile := byID[id]
			if profile == nil {
				rows.Close()
				return nil, ErrOfflineV3Invalid
			}
			profile[query.collection] = append(profile[query.collection].([]any), value)
			count++
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
		if count > offlineV3MaxSnapshotRows {
			return nil, fmt.Errorf("%w: program contact %s require pagination", ErrOfflineSnapshotTooLarge, query.collection)
		}
	}
	rows, err = tx.Query(ctx, `SELECT interaction.contact_id,COUNT(*)::int
		FROM interactions interaction JOIN contacts c ON c.id=interaction.contact_id AND c.account_id=$1
		WHERE interaction.account_id=$1 AND interaction.contact_id=ANY($2::uuid[])
		AND interaction.lead_id IS NULL AND interaction.event_id IS NULL AND interaction.participant_id IS NULL
		AND interaction.program_id IS NULL AND interaction.program_session_id IS NULL AND interaction.program_participant_id IS NULL
		GROUP BY interaction.contact_id ORDER BY interaction.contact_id`, accountID, ids)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id uuid.UUID
		var count int
		if err := rows.Scan(&id, &count); err != nil {
			rows.Close()
			return nil, err
		}
		if profile := byID[id]; profile != nil {
			profile["observation_count"] = count
		}
	}
	err = rows.Err()
	rows.Close()
	return profiles, err
}
