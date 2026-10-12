package repository

import (
	"context"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"strings"
)

// Whitelisted server ordering is applied before pagination; IDs break ties.
func eventListOrder(filter domain.EventFilter) string {
	field := "COALESCE(event_date, created_at)"
	switch filter.SortBy {
	case "name":
		field = "LOWER(name)"
	case "status":
		field = "status"
	case "participants":
		field = "(SELECT COUNT(*) FROM event_participants p WHERE p.event_id=events.id AND p.membership_state='active')"
	case "formula":
		field = "(CASE WHEN tag_formula_type='advanced' THEN CASE WHEN BTRIM(tag_formula)<>'' THEN 1 ELSE 0 END ELSE CASE WHEN EXISTS(SELECT 1 FROM event_tags t WHERE t.event_id=events.id) THEN 1 ELSE 0 END END)"
	}
	direction := " DESC"
	if strings.EqualFold(filter.SortDirection, "asc") {
		direction = " ASC"
	}
	return " ORDER BY " + field + direction + ", id" + direction
}

// Two bounded set queries replace per-event lookups. Never key identity by name.
func (r *EventRepository) hydrateEventSummaries(ctx context.Context, accountID uuid.UUID, events []*domain.Event) error {
	if len(events) == 0 {
		return nil
	}
	ids := make([]uuid.UUID, 0, len(events))
	byID := make(map[uuid.UUID]*domain.Event, len(events))
	for _, e := range events {
		ids = append(ids, e.ID)
		byID[e.ID] = e
		e.ParticipantCounts = map[string]int{}
		e.StageCounts = map[string]int{}
		e.StageSummary = []domain.EventStageSummary{}
		e.TotalParticipants = 0
	}
	rows, err := r.db.Query(ctx, `SELECT p.event_id,p.status,COUNT(*) FROM event_participants p JOIN events e ON e.id=p.event_id WHERE e.account_id=$1 AND e.id=ANY($2) AND p.membership_state='active' GROUP BY p.event_id,p.status`, accountID, ids)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id uuid.UUID
		var status string
		var count int
		if err = rows.Scan(&id, &status, &count); err != nil {
			rows.Close()
			return err
		}
		e := byID[id]
		e.ParticipantCounts[status] = count
		e.TotalParticipants += count
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	rows, err = r.db.Query(ctx, `
 WITH counts AS (SELECT p.event_id,p.stage_id,COUNT(*)::int AS count FROM event_participants p JOIN events e ON e.id=p.event_id WHERE e.account_id=$1 AND e.id=ANY($2) AND p.membership_state='active' GROUP BY p.event_id,p.stage_id)
 SELECT e.id,s.id,s.name,COALESCE(s.color,'#94a3b8'),COALESCE(s.position,0),COALESCE(c.count,0) FROM events e JOIN event_pipeline_stages s ON s.pipeline_id=e.pipeline_id LEFT JOIN counts c ON c.event_id=e.id AND c.stage_id=s.id WHERE e.account_id=$1 AND e.id=ANY($2)
 UNION ALL
 SELECT e.id,NULL::uuid,'Sin etapa','#94a3b8',2147483647,COALESCE(SUM(c.count),0)::int FROM events e LEFT JOIN counts c ON c.event_id=e.id AND (c.stage_id IS NULL OR NOT EXISTS(SELECT 1 FROM event_pipeline_stages s WHERE s.id=c.stage_id AND s.pipeline_id=e.pipeline_id)) WHERE e.account_id=$1 AND e.id=ANY($2) GROUP BY e.id
 ORDER BY 1,5,2`, accountID, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		var stage domain.EventStageSummary
		if err = rows.Scan(&id, &stage.ID, &stage.Name, &stage.Color, &stage.Position, &stage.Count); err != nil {
			return err
		}
		e := byID[id]
		e.StageSummary = append(e.StageSummary, stage)
		e.StageCounts[stage.Name] += stage.Count
	}
	return rows.Err()
}
