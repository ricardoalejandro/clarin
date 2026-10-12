package repository

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Only durable stage identities can appear in saved logbook filters. Draft
// client IDs and unchanged identities are not structural remaps.
func eventLogbookStageMapping(mapping map[string]string) map[string]string {
	out := map[string]string{}
	for source, destination := range mapping {
		from, fromErr := uuid.Parse(source)
		to, toErr := uuid.Parse(destination)
		if fromErr == nil && toErr == nil && from != to {
			out[from.String()] = to.String()
		}
	}
	return out
}

// saved_filter is the operational audience for a future capture/reopen.
// captured_filter and entry snapshots are historical and never participate.
func remapEventLogbookStageFiltersTx(ctx context.Context, tx pgx.Tx, accountID, eventID uuid.UUID, mapping map[string]string, actorID *uuid.UUID) (int, error) {
	changes := eventLogbookStageMapping(mapping)
	if len(changes) == 0 {
		return 0, nil
	}
	payload, err := json.Marshal(changes)
	if err != nil {
		return 0, err
	}
	var changed int
	err = tx.QueryRow(ctx, `
 WITH mapped_parts AS (
  SELECT l.id,COALESCE($3::jsonb->>LOWER(BTRIM(part.stage_id)),part.stage_id) AS stage_id,part.ordinal
  FROM event_logbooks l
  CROSS JOIN LATERAL unnest(string_to_array(l.saved_filter->>'stage_ids',',')) WITH ORDINALITY AS part(stage_id,ordinal)
  WHERE l.account_id=$1 AND l.event_id=$2 AND jsonb_typeof(l.saved_filter->'stage_ids')='string'
 ), changed_ids AS (
  SELECT id FROM event_logbooks
  WHERE account_id=$1 AND event_id=$2
   AND EXISTS(SELECT 1 FROM unnest(string_to_array(saved_filter->>'stage_ids',',')) AS old(stage_id) WHERE $3::jsonb ? LOWER(BTRIM(old.stage_id)))
 ), unique_parts AS (
  SELECT p.id,p.stage_id,MIN(p.ordinal) AS ordinal FROM mapped_parts p JOIN changed_ids c ON c.id=p.id GROUP BY p.id,p.stage_id
 ), remapped AS (
  SELECT id,string_agg(stage_id,',' ORDER BY ordinal) AS stage_ids FROM unique_parts GROUP BY id
 ), changed AS (
  UPDATE event_logbooks l SET saved_filter=jsonb_set(l.saved_filter,'{stage_ids}',to_jsonb(r.stage_ids)),
   version=l.version+1,updated_at=NOW()
  FROM remapped r WHERE l.id=r.id AND l.account_id=$1 AND l.event_id=$2
   AND l.saved_filter->>'stage_ids' IS DISTINCT FROM r.stage_ids
  RETURNING l.id,l.account_id,l.event_id,l.version
 ), audited AS (
  INSERT INTO event_logbook_actions(account_id,event_id,logbook_id,action,actor_id,version)
  SELECT account_id,event_id,id,'stage_filters_remapped',$4::uuid,version FROM changed RETURNING id
 )
 SELECT COUNT(*) FROM changed
 `, accountID, eventID, payload, actorID).Scan(&changed)
	return changed, err
}
