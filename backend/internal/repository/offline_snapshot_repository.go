package repository

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

type OfflineSnapshot struct {
	SelectionID  uuid.UUID       `json:"selection_id,omitempty"`
	Module       string          `json:"module"`
	ResourceType string          `json:"resource_type"`
	ResourceID   uuid.UUID       `json:"resource_id"`
	Version      int64           `json:"version"`
	ContentHash  string          `json:"content_hash"`
	Payload      json.RawMessage `json:"payload"`
	Tombstone    bool            `json:"tombstone,omitempty"`
}

func (r *OfflineRepository) offlineSnapshot(ctx context.Context, accountID uuid.UUID, module, resourceType string, id uuid.UUID) (*OfflineSnapshot, error) {
	snapshot := &OfflineSnapshot{Module: module, ResourceType: resourceType, ResourceID: id}
	var payload []byte
	switch module {
	case domain.OfflineModuleWhiteboards:
		if resourceType != domain.OfflineResourceWhiteboard {
			return nil, ErrOfflineResourceInvalid
		}
		err := r.db.QueryRow(ctx, `SELECT version,jsonb_build_object('id',id,'name',name,'description',description,'scene_json',scene_json,'scene_schema_version',scene_schema_version,'editor_version',editor_version,'scene_sequence',scene_sequence,'version',version,'updated_at',updated_at) FROM whiteboards WHERE account_id=$1 AND id=$2 AND archived_at IS NULL`, accountID, id).Scan(&snapshot.Version, &payload)
		if err != nil {
			return nil, err
		}
	case domain.OfflineModuleContacts:
		if resourceType != domain.OfflineResourceContact {
			return nil, ErrOfflineResourceInvalid
		}
		contact, err := NewContactProfileRepository(r.db).Get(ctx, accountID, id)
		if errors.Is(err, ErrContactProfileNotFound) || (err == nil && contact.IsGroup) {
			return nil, pgx.ErrNoRows
		}
		if err != nil {
			return nil, err
		}
		observations, err := (&InteractionRepository{db: r.db}).GetByContactID(ctx, accountID, id, 200, 0)
		if err != nil {
			return nil, err
		}
		payload, err = json.Marshal(map[string]any{"contact": contact, "observations": observations, "observation_limit": 200})
		if err != nil {
			return nil, err
		}
	case domain.OfflineModulePrograms:
		if resourceType != domain.OfflineResourceProgram {
			return nil, ErrOfflineResourceInvalid
		}
		err := r.db.QueryRow(ctx, `SELECT COALESCE(EXTRACT(EPOCH FROM p.updated_at)::bigint,1),jsonb_build_object('id',p.id,'name',p.name,'description',p.description,'status',p.status,'updated_at',p.updated_at,'sessions',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',ps.id,'date',ps.date,'title',ps.title,'topic',ps.topic,'start_time',ps.start_time,'end_time',ps.end_time) ORDER BY ps.date,ps.id),'[]'::jsonb) FROM program_sessions ps WHERE ps.account_id=p.account_id AND ps.program_id=p.id),'participants',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',pp.id,'contact_id',pp.contact_id,'status',pp.status,'enrolled_at',pp.enrolled_at,'offline_version',pp.offline_version,'contact',jsonb_build_object('name',c.name,'last_name',c.last_name,'phone',c.phone,'email',c.email)) ORDER BY c.name,pp.id),'[]'::jsonb) FROM program_participants pp JOIN contacts c ON c.id=pp.contact_id AND c.account_id=p.account_id WHERE pp.program_id=p.id),'attendance',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',pa.id,'session_id',pa.session_id,'participant_id',pa.participant_id,'status',pa.status,'notes',pa.notes,'offline_version',pa.offline_version,'updated_at',pa.updated_at)),'[]'::jsonb) FROM program_attendance pa JOIN program_sessions ps ON ps.id=pa.session_id AND ps.account_id=p.account_id WHERE ps.program_id=p.id)) FROM programs p WHERE p.account_id=$1 AND p.id=$2`, accountID, id).Scan(&snapshot.Version, &payload)
		if err != nil {
			return nil, err
		}
	default:
		return nil, ErrOfflineResourceInvalid
	}
	snapshot.Payload = payload
	return snapshot, nil
}
