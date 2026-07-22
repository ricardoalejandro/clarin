package api

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/service"
)

func quickTaskPipelinePredicate(values map[string]any, leadAlias string, args *[]any) string {
	pipeline := strings.TrimSpace(fmt.Sprint(values["pipeline"]))
	if pipeline == "" || pipeline == "<nil>" {
		return ""
	}
	if pipeline == "__no_pipeline__" {
		return " AND " + leadAlias + ".pipeline_id IS NULL"
	}
	if id, err := uuid.Parse(pipeline); err == nil {
		*args = append(*args, id)
		return fmt.Sprintf(" AND %s.pipeline_id=$%d", leadAlias, len(*args))
	}
	*args = append(*args, pipeline)
	return fmt.Sprintf(" AND %s.pipeline_id IN (SELECT id FROM pipelines WHERE account_id=$1 AND LOWER(name)=LOWER($%d))", leadAlias, len(*args))
}

func (s *Server) quickLeadDataQualityScoped(ctx context.Context, accountID uuid.UUID, values map[string]any) (map[string]any, error) {
	args := []any{accountID}
	pipelineWhere := quickTaskPipelinePredicate(values, "l", &args)
	duplicateWhere := quickTaskPipelinePredicate(values, "dl", &args)
	result := map[string]any{"as_of": time.Now().UTC(), "pipeline": strings.TrimSpace(fmt.Sprint(values["pipeline"]))}
	var missingPhone, missingEmail, missingContact, duplicateGroups int
	err := s.repos.DB().QueryRow(ctx, `SELECT
		COUNT(*) FILTER (WHERE NULLIF(BTRIM(CASE WHEN l.contact_id IS NULL THEN COALESCE(l.phone,'') ELSE COALESCE(c.phone,'') END),'') IS NULL),
		COUNT(*) FILTER (WHERE NULLIF(BTRIM(CASE WHEN l.contact_id IS NULL THEN COALESCE(l.email,'') ELSE COALESCE(c.email,'') END),'') IS NULL),
		COUNT(*) FILTER (WHERE l.contact_id IS NULL),
		(SELECT COUNT(*) FROM (
			SELECT regexp_replace(COALESCE(dc.phone,''),'\D','','g') normalized_phone
			FROM leads dl JOIN contacts dc ON dc.id=dl.contact_id AND dc.account_id=dl.account_id
			WHERE dl.account_id=$1 AND dl.deleted_at IS NULL`+duplicateWhere+`
			  AND NULLIF(regexp_replace(COALESCE(dc.phone,''),'\D','','g'),'') IS NOT NULL
			GROUP BY normalized_phone HAVING COUNT(DISTINCT dc.id)>1
		) duplicates)
		FROM leads l LEFT JOIN contacts c ON c.id=l.contact_id AND c.account_id=l.account_id
		WHERE l.account_id=$1 AND l.deleted_at IS NULL`+pipelineWhere, args...).Scan(&missingPhone, &missingEmail, &missingContact, &duplicateGroups)
	result["missing_phone"], result["missing_email"] = missingPhone, missingEmail
	result["missing_contact"], result["duplicate_phone_groups"] = missingContact, duplicateGroups
	return result, err
}

func (s *Server) quickPerformanceOverviewScoped(ctx context.Context, accountID uuid.UUID, values map[string]any) (map[string]any, error) {
	createdFrom, err := parseQuickTaskDate(values["created_from"], false)
	if err != nil {
		return nil, err
	}
	createdTo, err := parseQuickTaskDate(values["created_to"], true)
	if err != nil {
		return nil, err
	}
	result := map[string]any{"as_of": time.Now().UTC(), "created_from": createdFrom, "created_to": createdTo}
	var campaigns, events, programs, surveys int
	err = s.repos.DB().QueryRow(ctx, `SELECT
		(SELECT COUNT(*) FROM campaigns WHERE account_id=$1 AND ($2::timestamptz IS NULL OR created_at >= $2) AND ($3::timestamptz IS NULL OR created_at < $3)),
		(SELECT COUNT(*) FROM events WHERE account_id=$1 AND ($2::timestamptz IS NULL OR created_at >= $2) AND ($3::timestamptz IS NULL OR created_at < $3)),
		(SELECT COUNT(*) FROM programs WHERE account_id=$1 AND ($2::timestamptz IS NULL OR created_at >= $2) AND ($3::timestamptz IS NULL OR created_at < $3)),
		(SELECT COUNT(*) FROM surveys WHERE account_id=$1 AND ($2::timestamptz IS NULL OR created_at >= $2) AND ($3::timestamptz IS NULL OR created_at < $3))`, accountID, createdFrom, createdTo).Scan(&campaigns, &events, &programs, &surveys)
	result["campaigns"], result["events"] = campaigns, events
	result["programs"], result["surveys"] = programs, surveys
	return result, err
}

// quickFollowupPriority applies an explicit operational score. It is kept
// deterministic and read-only so the card does not need a model turn.
func (s *Server) quickFollowupPriority(ctx context.Context, accountID uuid.UUID, values map[string]any) (*service.OperationalLeadQueryResult, error) {
	limit := intValue(values["limit"], 20)
	if limit < 1 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}
	args := []any{accountID}
	pipelineWhere := ""
	if pipeline := strings.TrimSpace(fmt.Sprint(values["pipeline"])); pipeline != "" && pipeline != "<nil>" {
		if pipeline == "__no_pipeline__" {
			pipelineWhere = " AND l.pipeline_id IS NULL"
		} else if id, err := uuid.Parse(pipeline); err == nil {
			args = append(args, id)
			pipelineWhere = fmt.Sprintf(" AND l.pipeline_id=$%d", len(args))
		} else {
			args = append(args, pipeline)
			pipelineWhere = fmt.Sprintf(" AND LOWER(COALESCE(p.name,''))=LOWER($%d)", len(args))
		}
	}
	args = append(args, limit)
	rows, err := s.repos.DB().Query(ctx, `
		SELECT l.id,
		       CASE WHEN l.contact_id IS NULL
		         THEN COALESCE(NULLIF(TRIM(CONCAT_WS(' ',l.name,l.last_name)),''),'')
		         ELSE COALESCE(NULLIF(c.custom_name,''),NULLIF(TRIM(CONCAT_WS(' ',c.name,c.last_name)),''),NULLIF(c.push_name,''),'')
		       END AS name,
		       COALESCE(CASE WHEN l.contact_id IS NULL THEN NULLIF(l.phone,'') ELSE NULLIF(c.phone,'') END,'') AS phone,
		       COALESCE(p.name,'') AS pipeline, COALESCE(ps.name,'') AS stage,
		       COALESCE(task_stats.overdue_count,0) AS overdue_task_count,
		       task_stats.next_due_at,
		       GREATEST(chat_stats.last_message_at, interaction_stats.last_interaction_at) AS last_activity_at,
		       CASE
		         WHEN chat_stats.last_inbound_at IS NOT NULL AND (chat_stats.last_outbound_at IS NULL OR chat_stats.last_inbound_at>chat_stats.last_outbound_at) THEN 'unanswered'
		         WHEN chat_stats.message_count IS NULL OR chat_stats.message_count=0 THEN 'no_messages'
		         ELSE 'has_messages'
		       END AS conversation_state,
		       (CASE WHEN COALESCE(task_stats.overdue_count,0)>0 THEN 100 ELSE 0 END
		        + CASE WHEN chat_stats.last_inbound_at IS NOT NULL AND (chat_stats.last_outbound_at IS NULL OR chat_stats.last_inbound_at>chat_stats.last_outbound_at) THEN 50 ELSE 0 END
		        + CASE WHEN COALESCE(chat_stats.message_count,0)=0 THEN 25 ELSE 0 END
		        + LEAST(30, GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW()-COALESCE(GREATEST(chat_stats.last_message_at,interaction_stats.last_interaction_at),l.created_at)))/86400)))::int
		       ) AS priority_score
		FROM leads l
		LEFT JOIN contacts c ON c.id=l.contact_id AND c.account_id=l.account_id
		LEFT JOIN pipelines p ON p.id=l.pipeline_id AND p.account_id=l.account_id
		LEFT JOIN pipeline_stages ps ON ps.id=l.stage_id AND ps.pipeline_id=l.pipeline_id
		LEFT JOIN LATERAL (
			SELECT COUNT(m.id) AS message_count, MAX(m.timestamp) AS last_message_at,
			       MAX(m.timestamp) FILTER (WHERE NOT m.is_from_me) AS last_inbound_at,
			       MAX(m.timestamp) FILTER (WHERE m.is_from_me) AS last_outbound_at
			FROM chats ch LEFT JOIN messages m ON m.chat_id=ch.id AND m.account_id=l.account_id AND NOT COALESCE(m.is_revoked,false)
			WHERE ch.account_id=l.account_id AND ch.contact_id=l.contact_id
		) chat_stats ON TRUE
		LEFT JOIN LATERAL (
			SELECT MAX(i.created_at) AS last_interaction_at
			FROM interactions i
			WHERE i.account_id=l.account_id AND (i.lead_id=l.id OR i.contact_id=l.contact_id)
		) interaction_stats ON TRUE
		LEFT JOIN LATERAL (
			SELECT COUNT(*) FILTER (WHERE t.status='pending' AND t.due_at<NOW()) AS overdue_count,
			       MIN(t.due_at) FILTER (WHERE t.status='pending') AS next_due_at
			FROM tasks t
			WHERE t.account_id=l.account_id AND (t.lead_id=l.id OR (t.lead_id IS NULL AND t.contact_id=l.contact_id))
		) task_stats ON TRUE
		WHERE l.account_id=$1 AND l.deleted_at IS NULL AND NOT l.is_archived AND l.status='open'
		  AND NOT COALESCE(c.do_not_contact,false)`+pipelineWhere+`
		ORDER BY priority_score DESC,
		         COALESCE(GREATEST(chat_stats.last_message_at,interaction_stats.last_interaction_at),l.created_at) ASC,
		         l.id
		LIMIT $`+fmt.Sprint(len(args)), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	fields := []string{"id", "name", "phone", "pipeline", "stage", "overdue_task_count", "next_task_due_at", "last_activity_at", "conversation_state", "priority_score"}
	items := make([]map[string]any, 0, limit)
	for rows.Next() {
		var id uuid.UUID
		var name, phone, pipeline, stage, conversationState string
		var overdue, priority int
		var nextDueAt, lastActivityAt any
		if err := rows.Scan(&id, &name, &phone, &pipeline, &stage, &overdue, &nextDueAt, &lastActivityAt, &conversationState, &priority); err != nil {
			return nil, err
		}
		items = append(items, map[string]any{
			"id": id, "name": name, "phone": phone, "pipeline": pipeline, "stage": stage,
			"overdue_task_count": overdue, "next_task_due_at": nextDueAt, "last_activity_at": lastActivityAt,
			"conversation_state": conversationState, "priority_score": priority,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return &service.OperationalLeadQueryResult{
		Mode: service.OperationalLeadQueryModeList, Items: items, Returned: len(items), Fields: fields,
	}, nil
}
