package repository

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

// Offline v5 feeds the existing product surfaces. These enrichers deliberately
// add only data that belongs to the selected root (plus the smallest identity
// rows needed to render it). They never copy an account-wide catalog.
func offlineV5EnrichSnapshot(ctx context.Context, tx pgx.Tx, accountID, userID uuid.UUID, selection domain.OfflineV3Selection, payload json.RawMessage, capabilities []domain.OfflineV5Capability) (json.RawMessage, error) {
	has := func(action string) bool {
		for _, capability := range capabilities {
			if capability.Action == action {
				return true
			}
		}
		return false
	}
	switch selection.Module {
	case domain.OfflineModuleTasks:
		return offlineV5EnrichTaskSnapshot(ctx, tx, accountID, userID, selection.ResourceID, payload,
			has(domain.OfflineV5ActionTasksUpdate), has(domain.OfflineV5ActionTasksComment))
	case domain.OfflineModuleContacts:
		return offlineV5EnrichContactSnapshot(ctx, tx, accountID, selection.ResourceID, payload,
			has(domain.OfflineV5ActionContactsUpdate), has(domain.OfflineV5ActionContactsObserve))
	case domain.OfflineModulePrograms:
		return offlineV5EnrichProgramSnapshot(ctx, tx, accountID, selection.ResourceID, payload, has(domain.OfflineV5ActionProgramsUpdate))
	case domain.OfflineModuleWhiteboards:
		return offlineV5EnrichWhiteboardSnapshot(payload, has(domain.OfflineV5ActionBoardsScene))
	default:
		return nil, ErrOfflineV3Invalid
	}
}

func offlineV5SnapshotObject(payload json.RawMessage) (map[string]any, error) {
	var object map[string]any
	if err := json.Unmarshal(payload, &object); err != nil || object == nil {
		if err == nil {
			err = ErrOfflineV3Invalid
		}
		return nil, err
	}
	return object, nil
}

func offlineV5MarshalSnapshot(object map[string]any) (json.RawMessage, error) {
	encoded, err := json.Marshal(object)
	if err != nil {
		return nil, err
	}
	return json.RawMessage(encoded), nil
}

func offlineV5SnapshotTaskIDs(object map[string]any) ([]uuid.UUID, map[uuid.UUID]map[string]any, error) {
	rawTasks, ok := object["tasks"].([]any)
	if !ok {
		return nil, nil, ErrOfflineV3Invalid
	}
	ids := make([]uuid.UUID, 0, len(rawTasks))
	byID := make(map[uuid.UUID]map[string]any, len(rawTasks))
	for _, rawTask := range rawTasks {
		task, ok := rawTask.(map[string]any)
		if !ok {
			return nil, nil, ErrOfflineV3Invalid
		}
		text, _ := task["id"].(string)
		id, err := uuid.Parse(text)
		if err != nil || id == uuid.Nil {
			return nil, nil, ErrOfflineV3Invalid
		}
		ids = append(ids, id)
		byID[id] = task
	}
	return ids, byID, nil
}

func offlineV5EnrichTaskSnapshot(ctx context.Context, tx pgx.Tx, accountID, userID, listID uuid.UUID, payload json.RawMessage, canEdit, canComment bool) (json.RawMessage, error) {
	object, err := offlineV5SnapshotObject(payload)
	if err != nil {
		return nil, err
	}
	taskIDs, tasks, err := offlineV5SnapshotTaskIDs(object)
	if err != nil {
		return nil, err
	}
	object["capabilities"] = map[string]any{"can_view": true, "can_create": canEdit, "can_edit": canEdit,
		"can_comment": canComment, "can_manage_attachments": false, "offline_attachments_available": false}
	object["users"] = []any{}
	object["comments"] = []any{}
	object["activity"] = []any{}
	object["attachments"] = []any{}
	object["dependencies"] = []any{}
	if len(taskIDs) == 0 {
		return offlineV5MarshalSnapshot(object)
	}

	// Add the fields consumed by TaskWorkspace without replacing the v4/v3
	// projection. The same actor visibility expression that selected the task is
	// repeated here so an enrichment can never widen the root.
	rows, err := tx.Query(ctx, `SELECT task.id,task.created_by,task.assigned_to,task.type,task.status,task.completed_at,task.completed_by,
		task.lead_id,task.event_id,task.program_id,task.contact_id,task.starred,COALESCE(task.progress_mode,'manual'),
		COALESCE(task.manual_progress,0),COALESCE(task.is_milestone,FALSE),COALESCE(task.recurrence_rule,''),task.recurrence_parent_id,
		task.reminder_minutes,COALESCE(task.notes,''),task.color,
		COALESCE(task.color,NULLIF(list_item.color,''),'#64748B'),
		CASE WHEN task.color IS NOT NULL THEN 'item' WHEN NULLIF(list_item.color,'') IS NOT NULL THEN 'list' ELSE 'default' END,
		task.created_at,
		(SELECT COUNT(*)::int FROM tasks child WHERE child.account_id=task.account_id AND child.parent_task_id=task.id AND child.deleted_at IS NULL),
		(SELECT COUNT(*)::int FROM task_comments comment WHERE comment.account_id=task.account_id AND comment.task_id=task.id AND comment.deleted_at IS NULL),
		(SELECT COUNT(*)::int FROM task_attachments attachment WHERE attachment.account_id=task.account_id AND attachment.task_id=task.id AND attachment.attachment_scope='task')
		FROM tasks task JOIN task_lists list_item ON list_item.account_id=task.account_id AND list_item.id=task.list_id
		WHERE task.account_id=$1 AND task.list_id=$2 AND task.id=ANY($3::uuid[]) AND task.deleted_at IS NULL
		  AND `+taskActorCanViewSQL("task", "list_item", "$4")+`
		ORDER BY task.id`, accountID, listID, taskIDs, userID)
	if err != nil {
		return nil, err
	}
	userIDs := make(map[uuid.UUID]struct{})
	for rows.Next() {
		var id, createdBy, assignedTo uuid.UUID
		var taskType, status, progressMode, recurrenceRule, notes, resolvedColor, colorSource string
		var color *string
		var completedAt *time.Time
		var completedBy, leadID, eventID, programID, contactID, recurrenceParentID *uuid.UUID
		var starred, milestone bool
		var manualProgress, subtaskCount, commentCount, attachmentCount int
		var reminderMinutes *int
		var createdAt time.Time
		if err := rows.Scan(&id, &createdBy, &assignedTo, &taskType, &status, &completedAt, &completedBy,
			&leadID, &eventID, &programID, &contactID, &starred, &progressMode, &manualProgress, &milestone,
			&recurrenceRule, &recurrenceParentID, &reminderMinutes, &notes, &color, &resolvedColor, &colorSource,
			&createdAt, &subtaskCount, &commentCount, &attachmentCount); err != nil {
			rows.Close()
			return nil, err
		}
		task := tasks[id]
		task["created_by"], task["assigned_to"], task["type"], task["status"] = createdBy, assignedTo, taskType, status
		task["completed_at"], task["completed_by"] = completedAt, completedBy
		task["lead_id"], task["event_id"], task["program_id"], task["contact_id"] = leadID, eventID, programID, contactID
		task["starred"], task["progress_mode"], task["manual_progress"], task["is_milestone"] = starred, progressMode, manualProgress, milestone
		task["recurrence_rule"], task["recurrence_parent_id"], task["reminder_minutes"] = recurrenceRule, recurrenceParentID, reminderMinutes
		task["notes"], task["created_at"] = notes, createdAt
		task["color"], task["resolved_color"], task["color_source"] = color, resolvedColor, colorSource
		task["subtask_count"], task["comment_count"], task["attachment_count"] = subtaskCount, commentCount, attachmentCount
		task["capabilities"] = map[string]any{"can_view": true, "can_edit": canEdit, "can_complete": canEdit,
			"can_comment": canComment, "can_attach": false}
		userIDs[createdBy], userIDs[assignedTo] = struct{}{}, struct{}{}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	type collaboratorDTO struct {
		TaskID      uuid.UUID `json:"task_id"`
		UserID      uuid.UUID `json:"user_id"`
		DisplayName string    `json:"display_name"`
		Username    string    `json:"username"`
		CreatedAt   time.Time `json:"created_at"`
	}
	collaborators := make([]collaboratorDTO, 0)
	rows, err = tx.Query(ctx, `SELECT link.task_id,link.user_id,COALESCE(NULLIF(actor.display_name,''),actor.username),actor.username,link.created_at
		FROM task_collaborators link JOIN users actor ON actor.id=link.user_id
		JOIN user_accounts membership ON membership.account_id=link.account_id AND membership.user_id=link.user_id
		WHERE link.account_id=$1 AND link.task_id=ANY($2::uuid[]) ORDER BY link.task_id,LOWER(actor.username),actor.id
		LIMIT $3`, accountID, taskIDs, offlineV3MaxSnapshotRows+1)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var item collaboratorDTO
		if err := rows.Scan(&item.TaskID, &item.UserID, &item.DisplayName, &item.Username, &item.CreatedAt); err != nil {
			rows.Close()
			return nil, err
		}
		collaborators = append(collaborators, item)
		userIDs[item.UserID] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if len(collaborators) > offlineV3MaxSnapshotRows {
		return nil, fmt.Errorf("%w: task collaborators require pagination", ErrOfflineSnapshotTooLarge)
	}
	groupedCollaborators := make(map[uuid.UUID][]collaboratorDTO)
	for _, item := range collaborators {
		groupedCollaborators[item.TaskID] = append(groupedCollaborators[item.TaskID], item)
	}
	for id, task := range tasks {
		items := groupedCollaborators[id]
		if items == nil {
			items = []collaboratorDTO{}
		}
		task["collaborators"] = items
	}

	userIDList := make([]uuid.UUID, 0, len(userIDs))
	for id := range userIDs {
		if id != uuid.Nil {
			userIDList = append(userIDList, id)
		}
	}
	type userDTO struct {
		ID          uuid.UUID `json:"id"`
		Username    string    `json:"username"`
		DisplayName string    `json:"display_name"`
	}
	users := make([]userDTO, 0, len(userIDList))
	if len(userIDList) > 0 {
		rows, err = tx.Query(ctx, `SELECT actor.id,actor.username,COALESCE(NULLIF(actor.display_name,''),actor.username)
			FROM users actor JOIN user_accounts membership ON membership.user_id=actor.id AND membership.account_id=$1
			WHERE actor.id=ANY($2::uuid[]) ORDER BY LOWER(actor.username),actor.id`, accountID, userIDList)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var item userDTO
			if err := rows.Scan(&item.ID, &item.Username, &item.DisplayName); err != nil {
				rows.Close()
				return nil, err
			}
			users = append(users, item)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
	}
	object["users"] = users

	comments, err := offlineV5TaskComments(ctx, tx, accountID, taskIDs, canComment)
	if err != nil {
		return nil, err
	}
	activity, err := offlineV5TaskActivity(ctx, tx, accountID, taskIDs)
	if err != nil {
		return nil, err
	}
	attachments, err := offlineV5TaskAttachments(ctx, tx, accountID, taskIDs)
	if err != nil {
		return nil, err
	}
	dependencies, err := offlineV5TaskDependencies(ctx, tx, accountID, taskIDs)
	if err != nil {
		return nil, err
	}
	object["comments"], object["activity"], object["attachments"], object["dependencies"] = comments, activity, attachments, dependencies
	return offlineV5MarshalSnapshot(object)
}

func offlineV5TaskComments(ctx context.Context, tx pgx.Tx, accountID uuid.UUID, taskIDs []uuid.UUID, canWrite bool) ([]map[string]any, error) {
	rows, err := tx.Query(ctx, `SELECT comment.id,comment.task_id,comment.author_id,
		COALESCE(NULLIF(author.display_name,''),author.username),comment.body,comment.edited_at,comment.created_at,comment.updated_at
		FROM task_comments comment JOIN users author ON author.id=comment.author_id
		WHERE comment.account_id=$1 AND comment.task_id=ANY($2::uuid[]) AND comment.deleted_at IS NULL
		ORDER BY comment.task_id,comment.created_at,comment.id LIMIT $3`, accountID, taskIDs, offlineV3MaxSnapshotRows+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]map[string]any, 0)
	for rows.Next() {
		var id, taskID, authorID uuid.UUID
		var author, body string
		var editedAt *time.Time
		var createdAt, updatedAt time.Time
		if err := rows.Scan(&id, &taskID, &authorID, &author, &body, &editedAt, &createdAt, &updatedAt); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{"id": id, "task_id": taskID, "author_id": authorID, "author_name": author,
			"body": body, "edited_at": editedAt, "created_at": createdAt, "updated_at": updatedAt,
			"mentions": []any{}, "attachments": []any{}, "can_edit": canWrite, "can_delete": canWrite})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(out) > offlineV3MaxSnapshotRows {
		return nil, fmt.Errorf("%w: task comments require pagination", ErrOfflineSnapshotTooLarge)
	}
	return out, nil
}

func offlineV5TaskActivity(ctx context.Context, tx pgx.Tx, accountID uuid.UUID, taskIDs []uuid.UUID) ([]map[string]any, error) {
	rows, err := tx.Query(ctx, `SELECT activity.id,activity.task_id,activity.actor_id,
		COALESCE(NULLIF(actor.display_name,''),actor.username,''),activity.action,activity.metadata,activity.created_at
		FROM task_activity activity LEFT JOIN users actor ON actor.id=activity.actor_id
		WHERE activity.account_id=$1 AND activity.task_id=ANY($2::uuid[])
		ORDER BY activity.task_id,activity.created_at,activity.id LIMIT $3`, accountID, taskIDs, offlineV3MaxSnapshotRows+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]map[string]any, 0)
	for rows.Next() {
		var id, taskID uuid.UUID
		var actorID *uuid.UUID
		var actor, action string
		var metadata json.RawMessage
		var createdAt time.Time
		if err := rows.Scan(&id, &taskID, &actorID, &actor, &action, &metadata, &createdAt); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{"id": id, "task_id": taskID, "actor_id": actorID, "actor_name": actor,
			"action": action, "metadata": metadata, "created_at": createdAt})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(out) > offlineV3MaxSnapshotRows {
		return nil, fmt.Errorf("%w: task activity requires pagination", ErrOfflineSnapshotTooLarge)
	}
	return out, nil
}

func offlineV5TaskAttachments(ctx context.Context, tx pgx.Tx, accountID uuid.UUID, taskIDs []uuid.UUID) ([]map[string]any, error) {
	rows, err := tx.Query(ctx, `SELECT attachment.id,attachment.task_id,attachment.media_asset_id,media.filename,media.content_type,
		media.media_type,media.size_bytes,media.content_hash,attachment.uploaded_by,attachment.created_at
		FROM task_attachments attachment JOIN media_assets media ON media.account_id=attachment.account_id AND media.id=attachment.media_asset_id
		WHERE attachment.account_id=$1 AND attachment.task_id=ANY($2::uuid[]) AND attachment.attachment_scope='task'
		  AND media.status='active' AND media.deleted_at IS NULL
		ORDER BY attachment.task_id,attachment.created_at,attachment.id LIMIT $3`, accountID, taskIDs, offlineV3MaxSnapshotRows+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]map[string]any, 0)
	for rows.Next() {
		var id, taskID, mediaID uuid.UUID
		var filename, contentType, mediaType, contentHash string
		var size int64
		var uploadedBy *uuid.UUID
		var createdAt time.Time
		if err := rows.Scan(&id, &taskID, &mediaID, &filename, &contentType, &mediaType, &size, &contentHash, &uploadedBy, &createdAt); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{"id": id, "task_id": taskID, "media_asset_id": mediaID, "filename": filename,
			"content_type": contentType, "media_type": mediaType, "size_bytes": size, "content_hash": contentHash,
			"uploaded_by": uploadedBy, "created_at": createdAt, "available_offline": false})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(out) > offlineV3MaxSnapshotRows {
		return nil, fmt.Errorf("%w: task attachments require pagination", ErrOfflineSnapshotTooLarge)
	}
	return out, nil
}

func offlineV5TaskDependencies(ctx context.Context, tx pgx.Tx, accountID uuid.UUID, taskIDs []uuid.UUID) ([]domain.TaskDependency, error) {
	rows, err := tx.Query(ctx, `SELECT dependency.id,dependency.account_id,dependency.predecessor_task_id,dependency.successor_task_id,
		dependency.dependency_type,dependency.lag_minutes,predecessor.title,successor.title,dependency.created_by,dependency.created_at
		FROM task_dependencies dependency
		JOIN tasks predecessor ON predecessor.account_id=dependency.account_id AND predecessor.id=dependency.predecessor_task_id
		JOIN tasks successor ON successor.account_id=dependency.account_id AND successor.id=dependency.successor_task_id
		WHERE dependency.account_id=$1 AND dependency.predecessor_task_id=ANY($2::uuid[]) AND dependency.successor_task_id=ANY($2::uuid[])
		  AND predecessor.deleted_at IS NULL AND successor.deleted_at IS NULL
		ORDER BY dependency.predecessor_task_id,dependency.successor_task_id LIMIT $3`, accountID, taskIDs, offlineV3MaxSnapshotRows+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.TaskDependency, 0)
	for rows.Next() {
		var item domain.TaskDependency
		if err := rows.Scan(&item.ID, &item.AccountID, &item.PredecessorTaskID, &item.SuccessorTaskID, &item.DependencyType,
			&item.LagMinutes, &item.PredecessorTitle, &item.SuccessorTitle, &item.CreatedBy, &item.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(out) > offlineV3MaxSnapshotRows {
		return nil, fmt.Errorf("%w: task dependencies require pagination", ErrOfflineSnapshotTooLarge)
	}
	return out, nil
}

func offlineV5EnrichContactSnapshot(ctx context.Context, tx pgx.Tx, accountID, contactID uuid.UUID, payload json.RawMessage, canEdit, canObserve bool) (json.RawMessage, error) {
	object, err := offlineV5SnapshotObject(payload)
	if err != nil {
		return nil, err
	}
	definitions := make([]domain.CustomFieldDefinition, 0)
	rows, err := tx.Query(ctx, `SELECT DISTINCT definition.id,definition.account_id,definition.name,definition.slug,definition.field_type,
		definition.config,definition.is_required,definition.default_value,definition.sort_order,definition.created_at,definition.updated_at
		FROM custom_field_values value JOIN custom_field_definitions definition
		  ON definition.account_id=$1 AND definition.id=value.field_id
		JOIN contacts contact ON contact.account_id=definition.account_id AND contact.id=value.contact_id
		WHERE value.contact_id=$2 ORDER BY definition.sort_order,definition.id`, accountID, contactID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var item domain.CustomFieldDefinition
		if err := rows.Scan(&item.ID, &item.AccountID, &item.Name, &item.Slug, &item.FieldType, &item.Config,
			&item.IsRequired, &item.DefaultValue, &item.SortOrder, &item.CreatedAt, &item.UpdatedAt); err != nil {
			rows.Close()
			return nil, err
		}
		definitions = append(definitions, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	observationCount := 0
	if observations, ok := object["direct_observations"].([]any); ok {
		observationCount = len(observations)
	}
	object["success"] = true
	object["context"] = map[string]any{"type": "contact", "id": contactID}
	object["available_tags"] = []any{} // account-wide tag catalogs are never cached implicitly
	object["custom_field_definitions"] = definitions
	object["observation_count"] = observationCount
	object["capabilities"] = map[string]any{"can_view": true, "can_edit": canEdit, "can_observe": canObserve,
		"can_create_tags": false, "can_manage_avatar": false}
	return offlineV5MarshalSnapshot(object)
}

func offlineV5EnrichProgramSnapshot(ctx context.Context, tx pgx.Tx, accountID, programID uuid.UUID, payload json.RawMessage, canWrite bool) (json.RawMessage, error) {
	object, err := offlineV5SnapshotObject(payload)
	if err != nil {
		return nil, err
	}
	program, ok := object["program"].(map[string]any)
	if !ok {
		return nil, ErrOfflineV3Invalid
	}
	var startDate, endDate *time.Time
	var startTime, endTime *string
	var scheduleDays []int
	var healthColumns []string
	if err := tx.QueryRow(ctx, `SELECT schedule_start_date,schedule_end_date,COALESCE(schedule_days,'{}'::int[]),
		schedule_start_time,schedule_end_time,COALESCE(health_view_columns,ARRAY['health','attendance','signals']::text[])
		FROM programs WHERE account_id=$1 AND id=$2 AND COALESCE(type,'course')='course' FOR SHARE`, accountID, programID).
		Scan(&startDate, &endDate, &scheduleDays, &startTime, &endTime, &healthColumns); err != nil {
		return nil, err
	}
	program["schedule_start_date"], program["schedule_end_date"], program["schedule_days"] = startDate, endDate, scheduleDays
	program["schedule_start_time"], program["schedule_end_time"], program["health_view_columns"] = startTime, endTime, healthColumns
	program["capabilities"] = map[string]any{"can_view": true, "can_edit": canWrite, "can_manage_participants": canWrite,
		"can_manage_sessions": canWrite, "can_manage_attendance": canWrite, "can_observe": canWrite, "can_manage_goals": canWrite}

	if err := offlineV5EnrichProgramParticipants(ctx, tx, accountID, programID, object); err != nil {
		return nil, err
	}
	goal, err := offlineV5ProgramGoal(ctx, tx, accountID, programID)
	if err != nil {
		return nil, err
	}
	goalBytes, err := json.Marshal(goal)
	if err != nil {
		return nil, err
	}
	var goalView map[string]any
	if json.Unmarshal(goalBytes, &goalView) != nil {
		return nil, ErrOfflineV3Invalid
	}
	goalVersion := int64(0)
	if !goal.UpdatedAt.IsZero() {
		goalVersion = goal.UpdatedAt.UnixMicro()
	}
	goalView["version"] = goalVersion
	object["goals"] = goalView
	academic, err := offlineV5ProgramAcademic(ctx, tx, accountID, programID)
	if err != nil {
		return nil, err
	}
	object["academic_config"] = academic
	sessionTopics, sessionObservations, attendanceObservations, participantNotes, err := offlineV5ProgramContext(ctx, tx, accountID, programID, canWrite)
	if err != nil {
		return nil, err
	}
	object["session_topics"] = sessionTopics
	object["session_observations"] = sessionObservations
	object["attendance_observations"] = attendanceObservations
	object["participant_notes"] = participantNotes
	health, err := offlineV5ProgramHealth(ctx, tx, accountID, programID, goal)
	if err != nil {
		return nil, err
	}
	object["health"] = health
	return offlineV5MarshalSnapshot(object)
}

func offlineV5EnrichProgramParticipants(ctx context.Context, tx pgx.Tx, accountID, programID uuid.UUID, object map[string]any) error {
	byID := make(map[uuid.UUID]map[string]any)
	for _, key := range []string{"active_roster", "historical_participations"} {
		items, _ := object[key].([]any)
		for _, raw := range items {
			item, ok := raw.(map[string]any)
			if !ok {
				return ErrOfflineV3Invalid
			}
			text, _ := item["id"].(string)
			id, err := uuid.Parse(text)
			if err != nil {
				return ErrOfflineV3Invalid
			}
			byID[id] = item
		}
	}
	rows, err := tx.Query(ctx, `SELECT participant.id,COALESCE(participant.drop_reason,''),COALESCE(participant.drop_notes,''),
		COALESCE(participant.transferred_to_level,''),participant.transferred_at,COALESCE(participant.auto_tag_sync,FALSE),
		COALESCE(contact.avatar_url,''),COALESCE(contact.avatar_revision,0),participant.enrolled_at,
		participant.dropped_at,participant.completed_at
		FROM program_participants participant JOIN programs program ON program.id=participant.program_id AND program.account_id=$1
		JOIN contacts contact ON contact.account_id=program.account_id AND contact.id=participant.contact_id
		WHERE participant.program_id=$2 ORDER BY participant.id LIMIT $3`, accountID, programID, offlineV3MaxSnapshotRows+1)
	if err != nil {
		return err
	}
	count := 0
	for rows.Next() {
		var id uuid.UUID
		var reason, notes, level, avatar string
		var transferredAt *time.Time
		var enrolledAt time.Time
		var droppedAt, completedAt *time.Time
		var autoTag bool
		var avatarRevision int64
		if err := rows.Scan(&id, &reason, &notes, &level, &transferredAt, &autoTag, &avatar, &avatarRevision,
			&enrolledAt, &droppedAt, &completedAt); err != nil {
			rows.Close()
			return err
		}
		count++
		if item := byID[id]; item != nil {
			item["drop_reason"], item["drop_notes"] = reason, notes
			item["transferred_to_level"], item["transferred_at"], item["auto_tag_sync"] = level, transferredAt, autoTag
			item["avatar_url"], item["avatar_revision"] = avatar, avatarRevision
			version := enrolledAt.UnixMicro()
			if droppedAt != nil {
				version = droppedAt.UnixMicro()
			} else if completedAt != nil {
				version = completedAt.UnixMicro()
			}
			item["version"] = version
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	if count > offlineV3MaxSnapshotRows || count != len(byID) {
		return fmt.Errorf("%w: program participants changed during snapshot", ErrOfflineSnapshotTooLarge)
	}
	return nil
}

func offlineV5ProgramGoal(ctx context.Context, tx pgx.Tx, accountID, programID uuid.UUID) (*domain.ProgramGoal, error) {
	goal := &domain.ProgramGoal{AccountID: accountID, ProgramID: &programID, AttendanceGoalPercent: 80, TransferGoalPercent: 70}
	var sourceProgramID *uuid.UUID
	err := tx.QueryRow(ctx, `SELECT id,program_id,attendance_goal_percent,transfer_goal_percent,created_at,updated_at
		FROM program_goals WHERE account_id=$1 AND (program_id=$2 OR program_id IS NULL)
		ORDER BY (program_id IS NULL),updated_at DESC,id LIMIT 1`, accountID, programID).
		Scan(&goal.ID, &sourceProgramID, &goal.AttendanceGoalPercent, &goal.TransferGoalPercent, &goal.CreatedAt, &goal.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return goal, nil
	}
	if err != nil {
		return nil, err
	}
	// The consumer receives effective goals for this root. A global fallback is
	// minimum configuration, not authority to read other Programs. It is not
	// the writable program-specific row, so expose base version zero and a
	// stable synthetic ID; the first edit will create the canonical row.
	if sourceProgramID == nil {
		goal.ID = programID
		goal.CreatedAt, goal.UpdatedAt = time.Time{}, time.Time{}
	}
	goal.ProgramID = &programID
	return goal, nil
}

func offlineV5ProgramAcademic(ctx context.Context, tx pgx.Tx, accountID, programID uuid.UUID) (map[string]any, error) {
	type topicDTO struct {
		ID          uuid.UUID `json:"id"`
		CourseID    uuid.UUID `json:"course_id"`
		Title       string    `json:"title"`
		Description *string   `json:"description,omitempty"`
		Status      string    `json:"status"`
		Position    int       `json:"position"`
		UpdatedAt   time.Time `json:"updated_at"`
	}
	type courseDTO struct {
		ID          uuid.UUID  `json:"id"`
		Name        string     `json:"name"`
		Description *string    `json:"description,omitempty"`
		Status      string     `json:"status"`
		Position    int        `json:"position"`
		UpdatedAt   time.Time  `json:"updated_at"`
		Topics      []topicDTO `json:"topics"`
	}
	type instructorDTO struct {
		ContactID      uuid.UUID `json:"contact_id"`
		ContactName    string    `json:"contact_name"`
		ContactPhone   *string   `json:"contact_phone,omitempty"`
		AvatarURL      *string   `json:"avatar_url,omitempty"`
		AvatarRevision int64     `json:"avatar_revision"`
		Position       int       `json:"position"`
	}
	courses := make([]courseDTO, 0)
	rows, err := tx.Query(ctx, `SELECT course.id,course.name,course.description,course.status,link.position,course.updated_at
		FROM program_courses link JOIN courses course ON course.account_id=link.account_id AND course.id=link.course_id
		JOIN programs program ON program.account_id=link.account_id AND program.id=link.program_id
		WHERE link.account_id=$1 AND link.program_id=$2 ORDER BY link.position,course.id LIMIT $3`, accountID, programID, offlineV3MaxSnapshotRows+1)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var item courseDTO
		if err := rows.Scan(&item.ID, &item.Name, &item.Description, &item.Status, &item.Position, &item.UpdatedAt); err != nil {
			rows.Close()
			return nil, err
		}
		item.Topics = []topicDTO{}
		courses = append(courses, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if len(courses) > offlineV3MaxSnapshotRows {
		return nil, fmt.Errorf("%w: program courses require pagination", ErrOfflineSnapshotTooLarge)
	}
	topics := make([]topicDTO, 0)
	rows, err = tx.Query(ctx, `SELECT topic.id,topic.course_id,topic.title,topic.description,topic.status,topic.position,topic.updated_at
		FROM program_courses link JOIN course_topics topic ON topic.account_id=link.account_id AND topic.course_id=link.course_id
		WHERE link.account_id=$1 AND link.program_id=$2 ORDER BY link.position,topic.position,topic.id LIMIT $3`, accountID, programID, offlineV3MaxSnapshotRows+1)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var item topicDTO
		if err := rows.Scan(&item.ID, &item.CourseID, &item.Title, &item.Description, &item.Status, &item.Position, &item.UpdatedAt); err != nil {
			rows.Close()
			return nil, err
		}
		topics = append(topics, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if len(topics) > offlineV3MaxSnapshotRows {
		return nil, fmt.Errorf("%w: program course topics require pagination", ErrOfflineSnapshotTooLarge)
	}
	courseIndex := make(map[uuid.UUID]int, len(courses))
	for index := range courses {
		courseIndex[courses[index].ID] = index
	}
	for _, topic := range topics {
		index, exists := courseIndex[topic.CourseID]
		if !exists {
			return nil, ErrOfflineV3AccessDenied
		}
		courses[index].Topics = append(courses[index].Topics, topic)
	}
	instructors := make([]instructorDTO, 0)
	rows, err = tx.Query(ctx, `SELECT link.contact_id,COALESCE(NULLIF(BTRIM(contact.custom_name),''),NULLIF(BTRIM(contact.name),''),contact.phone,'Contacto'),
		contact.phone,contact.avatar_url,COALESCE(contact.avatar_revision,0),link.position
		FROM program_instructors link JOIN contacts contact ON contact.account_id=link.account_id AND contact.id=link.contact_id
		JOIN programs program ON program.account_id=link.account_id AND program.id=link.program_id
		WHERE link.account_id=$1 AND link.program_id=$2 ORDER BY link.position,link.contact_id LIMIT $3`, accountID, programID, offlineV3MaxSnapshotRows+1)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var item instructorDTO
		if err := rows.Scan(&item.ContactID, &item.ContactName, &item.ContactPhone, &item.AvatarURL, &item.AvatarRevision, &item.Position); err != nil {
			rows.Close()
			return nil, err
		}
		instructors = append(instructors, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if len(instructors) > offlineV3MaxSnapshotRows {
		return nil, fmt.Errorf("%w: program instructors require pagination", ErrOfflineSnapshotTooLarge)
	}
	return map[string]any{"program_id": programID, "courses": courses, "topics": topics, "instructors": instructors}, nil
}

func offlineV5ProgramContext(ctx context.Context, tx pgx.Tx, accountID, programID uuid.UUID, canWrite bool) ([]domain.ProgramSessionTopic, []domain.ProgramSessionObservation, []map[string]any, []domain.ProgramParticipantNote, error) {
	topics := make([]domain.ProgramSessionTopic, 0)
	rows, err := tx.Query(ctx, `SELECT topic.id,topic.session_id,topic.kind,topic.course_id,topic.course_topic_id,
		topic.course_name_snapshot,topic.topic_title_snapshot,topic.position,topic.created_at
		FROM program_session_topics topic JOIN program_sessions session
		  ON session.account_id=topic.account_id AND session.id=topic.session_id
		WHERE topic.account_id=$1 AND session.program_id=$2 ORDER BY topic.session_id,topic.position,topic.id LIMIT $3`,
		accountID, programID, offlineV3MaxSnapshotRows+1)
	if err != nil {
		return nil, nil, nil, nil, err
	}
	for rows.Next() {
		var item domain.ProgramSessionTopic
		if err := rows.Scan(&item.ID, &item.SessionID, &item.Kind, &item.CourseID, &item.CourseTopicID,
			&item.CourseNameSnapshot, &item.TopicTitleSnapshot, &item.Position, &item.CreatedAt); err != nil {
			rows.Close()
			return nil, nil, nil, nil, err
		}
		topics = append(topics, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, nil, nil, nil, err
	}
	rows.Close()
	if len(topics) > offlineV3MaxSnapshotRows {
		return nil, nil, nil, nil, fmt.Errorf("%w: program session topics require pagination", ErrOfflineSnapshotTooLarge)
	}

	observations := make([]domain.ProgramSessionObservation, 0)
	rows, err = tx.Query(ctx, `SELECT observation.id,observation.session_id,observation.notes,observation.created_by,
		NULLIF(COALESCE(NULLIF(author.display_name,''),author.username,''),''),observation.created_at,observation.updated_at,
		observation.updated_by,NULLIF(COALESCE(NULLIF(editor.display_name,''),editor.username,''),''),observation.is_pinned,
		observation.pinned_at,observation.pinned_by
		FROM program_session_observations observation JOIN program_sessions session
		  ON session.account_id=observation.account_id AND session.id=observation.session_id
		LEFT JOIN users author ON author.id=observation.created_by LEFT JOIN users editor ON editor.id=observation.updated_by
		WHERE observation.account_id=$1 AND session.program_id=$2
		ORDER BY observation.session_id,observation.is_pinned DESC,observation.created_at,observation.id LIMIT $3`,
		accountID, programID, offlineV3MaxSnapshotRows+1)
	if err != nil {
		return nil, nil, nil, nil, err
	}
	for rows.Next() {
		var item domain.ProgramSessionObservation
		if err := rows.Scan(&item.ID, &item.SessionID, &item.Notes, &item.CreatedBy, &item.CreatedByName, &item.CreatedAt,
			&item.UpdatedAt, &item.UpdatedBy, &item.UpdatedByName, &item.IsPinned, &item.PinnedAt, &item.PinnedBy); err != nil {
			rows.Close()
			return nil, nil, nil, nil, err
		}
		item.CanEdit, item.CanPin, item.CanDelete = canWrite, canWrite, canWrite
		observations = append(observations, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, nil, nil, nil, err
	}
	rows.Close()
	if len(observations) > offlineV3MaxSnapshotRows {
		return nil, nil, nil, nil, fmt.Errorf("%w: program session observations require pagination", ErrOfflineSnapshotTooLarge)
	}

	attendanceObservations := make([]map[string]any, 0)
	rows, err = tx.Query(ctx, `SELECT interaction.id,interaction.program_session_id,interaction.program_participant_id,interaction.contact_id,
		interaction.notes,interaction.created_by,
		NULLIF(COALESCE(NULLIF(author.display_name,''),author.username,''),''),interaction.created_at,interaction.source_label
		FROM interactions interaction JOIN programs program
		  ON program.account_id=interaction.account_id AND program.id=interaction.program_id
		JOIN program_sessions session ON session.account_id=program.account_id AND session.program_id=program.id
		  AND session.id=interaction.program_session_id
		JOIN program_participants participant ON participant.program_id=program.id AND participant.id=interaction.program_participant_id
		LEFT JOIN users author ON author.id=interaction.created_by
		WHERE interaction.account_id=$1 AND program.id=$2 AND interaction.type='attendance'
		ORDER BY interaction.created_at,interaction.id LIMIT $3`, accountID, programID, offlineV3MaxSnapshotRows+1)
	if err != nil {
		return nil, nil, nil, nil, err
	}
	for rows.Next() {
		var id, sessionID, participantID, contactID uuid.UUID
		var notes, sourceLabel string
		var createdBy *uuid.UUID
		var createdByName *string
		var createdAt time.Time
		if err := rows.Scan(&id, &sessionID, &participantID, &contactID, &notes, &createdBy, &createdByName, &createdAt, &sourceLabel); err != nil {
			rows.Close()
			return nil, nil, nil, nil, err
		}
		attendanceObservations = append(attendanceObservations, map[string]any{"id": id, "session_id": sessionID,
			"participant_id": participantID, "contact_id": contactID, "notes": notes, "created_by": createdBy,
			"created_by_name": createdByName, "created_at": createdAt, "source_label": sourceLabel})
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, nil, nil, nil, err
	}
	rows.Close()
	if len(attendanceObservations) > offlineV3MaxSnapshotRows {
		return nil, nil, nil, nil, fmt.Errorf("%w: program attendance observations require pagination", ErrOfflineSnapshotTooLarge)
	}

	notes := make([]domain.ProgramParticipantNote, 0)
	rows, err = tx.Query(ctx, `SELECT note.id,note.account_id,note.program_id,note.participant_id,note.contact_id,note.session_id,note.type,
		note.note,note.outcome,note.follow_up_at,note.created_by,note.created_at,note.updated_at,
		COALESCE(NULLIF(BTRIM(contact.custom_name),''),NULLIF(BTRIM(contact.name),''),contact.phone,'Contacto'),
		COALESCE(NULLIF(author.display_name,''),author.username,'')
		FROM program_participant_notes note JOIN programs program ON program.account_id=note.account_id AND program.id=note.program_id
		JOIN program_participants participant ON participant.program_id=program.id AND participant.id=note.participant_id
		JOIN contacts contact ON contact.account_id=program.account_id AND contact.id=note.contact_id AND contact.id=participant.contact_id
		LEFT JOIN users author ON author.id=note.created_by
		WHERE note.account_id=$1 AND note.program_id=$2 ORDER BY note.created_at,note.id LIMIT $3`, accountID, programID, offlineV3MaxSnapshotRows+1)
	if err != nil {
		return nil, nil, nil, nil, err
	}
	for rows.Next() {
		var item domain.ProgramParticipantNote
		if err := rows.Scan(&item.ID, &item.AccountID, &item.ProgramID, &item.ParticipantID, &item.ContactID, &item.SessionID,
			&item.Type, &item.Note, &item.Outcome, &item.FollowUpAt, &item.CreatedBy, &item.CreatedAt, &item.UpdatedAt,
			&item.ParticipantName, &item.CreatedByName); err != nil {
			rows.Close()
			return nil, nil, nil, nil, err
		}
		notes = append(notes, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, nil, nil, nil, err
	}
	rows.Close()
	if len(notes) > offlineV3MaxSnapshotRows {
		return nil, nil, nil, nil, fmt.Errorf("%w: program participant notes require pagination", ErrOfflineSnapshotTooLarge)
	}
	return topics, observations, attendanceObservations, notes, nil
}

func offlineV5ProgramHealth(ctx context.Context, tx pgx.Tx, accountID, programID uuid.UUID, goal *domain.ProgramGoal) (*domain.ProgramHealthSummary, error) {
	var sessionCount, recoveryCount, activeCount, completedCount, droppedCount, transferredCount int
	var asOfDate string
	if err := tx.QueryRow(ctx, `SELECT COUNT(*)::int,COUNT(*) FILTER (WHERE session_type='recovery')::int,
		((CURRENT_TIMESTAMP AT TIME ZONE 'America/Lima')::date)::text FROM program_sessions
		WHERE account_id=$1 AND program_id=$2 AND date<=(CURRENT_TIMESTAMP AT TIME ZONE 'America/Lima')::date`, accountID, programID).
		Scan(&sessionCount, &recoveryCount, &asOfDate); err != nil {
		return nil, err
	}
	if err := tx.QueryRow(ctx, `SELECT COUNT(*) FILTER (WHERE participant.status='active')::int,
		COUNT(*) FILTER (WHERE participant.status='completed')::int,COUNT(*) FILTER (WHERE participant.status='dropped')::int,
		COUNT(*) FILTER (WHERE COALESCE(participant.transferred_to_level,'')<>'')::int
		FROM program_participants participant JOIN programs program ON program.id=participant.program_id AND program.account_id=$1
		WHERE participant.program_id=$2`, accountID, programID).Scan(&activeCount, &completedCount, &droppedCount, &transferredCount); err != nil {
		return nil, err
	}
	summary := &domain.ProgramHealthSummary{ProgramID: programID, AsOfDate: asOfDate,
		AttendanceGoalPercent: goal.AttendanceGoalPercent, TransferGoalPercent: goal.TransferGoalPercent,
		ParticipantCount: activeCount, ActiveCount: activeCount, CompletedCount: completedCount, DroppedCount: droppedCount,
		TransferredCount: transferredCount, SessionCount: sessionCount, RecoverySessionCount: recoveryCount,
		Health: "healthy", Reasons: []string{}, Participants: []*domain.ProgramHealthParticipant{}}
	rows, err := tx.Query(ctx, `SELECT participant.id,participant.contact_id,
		COALESCE(NULLIF(BTRIM(contact.custom_name),''),NULLIF(BTRIM(contact.name),''),contact.phone,'Contacto'),contact.phone,
		contact.avatar_url,COALESCE(contact.avatar_revision,0),participant.status,participant.enrolled_at::text,
		COALESCE(participant.transferred_to_level,''),
		COUNT(*) FILTER (WHERE attendance.status='present')::int,COUNT(*) FILTER (WHERE attendance.status='late')::int,
		COUNT(*) FILTER (WHERE attendance.status='absent')::int,COUNT(session.id)::int,
		COUNT(*) FILTER (WHERE attendance.status IN ('present','absent','late'))::int,
		COUNT(*) FILTER (WHERE session.session_type='recovery' AND attendance.status IN ('present','late'))::int,
		COALESCE(note_stats.notes_count,0),note_stats.last_note_at
		FROM program_participants participant JOIN programs program ON program.id=participant.program_id AND program.account_id=$1
		JOIN contacts contact ON contact.id=participant.contact_id AND contact.account_id=program.account_id
		LEFT JOIN program_sessions session ON session.account_id=program.account_id AND session.program_id=program.id
		 AND session.date<=(CURRENT_TIMESTAMP AT TIME ZONE 'America/Lima')::date AND session.date>=participant.enrolled_at
		 AND (participant.dropped_at IS NULL OR session.date<participant.dropped_at)
		 AND (participant.completed_at IS NULL OR session.date<participant.completed_at)
		LEFT JOIN program_attendance attendance ON attendance.session_id=session.id AND attendance.participant_id=participant.id
		LEFT JOIN LATERAL (SELECT COUNT(*)::int notes_count,MAX(entry.created_at) last_note_at FROM (
		 SELECT interaction.created_at FROM interactions interaction WHERE interaction.account_id=program.account_id
		  AND interaction.program_id=program.id AND interaction.program_participant_id=participant.id
		 UNION ALL SELECT note.created_at FROM program_participant_notes note WHERE note.account_id=program.account_id
		  AND note.program_id=program.id AND note.participant_id=participant.id) entry) note_stats ON TRUE
		WHERE participant.program_id=$2 AND participant.status='active'
		GROUP BY participant.id,participant.contact_id,contact.custom_name,contact.name,contact.phone,contact.avatar_url,
		 contact.avatar_revision,participant.status,participant.enrolled_at,participant.transferred_to_level,note_stats.notes_count,note_stats.last_note_at
		ORDER BY COALESCE(NULLIF(BTRIM(contact.custom_name),''),NULLIF(BTRIM(contact.name),''),contact.phone),participant.id
		LIMIT $3`, accountID, programID, offlineV3MaxSnapshotRows+1)
	if err != nil {
		return nil, err
	}
	var totalPresent, totalLate, totalAbsent int
	for rows.Next() {
		item := &domain.ProgramHealthParticipant{Reasons: []string{}}
		if err := rows.Scan(&item.ParticipantID, &item.ContactID, &item.Name, &item.Phone, &item.AvatarURL, &item.AvatarRevision,
			&item.Status, &item.EnrolledAt, &item.TransferredToLevel, &item.Present, &item.Late, &item.Absent,
			&item.EligibleSessions, &item.MarkedSessions, &item.RecoverySessions, &item.NotesCount, &item.LastNoteAt); err != nil {
			rows.Close()
			return nil, err
		}
		item.Pending = item.EligibleSessions - item.MarkedSessions
		if item.Pending < 0 {
			item.Pending = 0
		}
		if item.MarkedSessions > 0 {
			item.AttendanceRate = float64(item.Present+item.Late) / float64(item.MarkedSessions) * 100
		}
		unresolved := item.Absent - item.RecoverySessions
		item.Health = "healthy"
		if unresolved >= 2 {
			item.Health, item.Reasons = "critical", append(item.Reasons, fmt.Sprintf("%d faltas no regularizadas", unresolved))
		} else if unresolved == 1 {
			item.Health, item.Reasons = "watch", append(item.Reasons, "una falta pendiente")
		}
		if item.MarkedSessions > 0 && item.AttendanceRate < float64(goal.AttendanceGoalPercent) && item.Health == "healthy" {
			item.Health, item.Reasons = "watch", append(item.Reasons, "asistencia bajo la meta")
		}
		if len(item.Reasons) == 0 {
			item.Reasons = append(item.Reasons, "sin alertas")
		}
		totalPresent, totalLate, totalAbsent = totalPresent+item.Present, totalLate+item.Late, totalAbsent+item.Absent
		summary.Participants = append(summary.Participants, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if len(summary.Participants) > offlineV3MaxSnapshotRows {
		return nil, fmt.Errorf("%w: program health requires pagination", ErrOfflineSnapshotTooLarge)
	}
	marked := totalPresent + totalLate + totalAbsent
	if marked > 0 {
		summary.AttendanceRate = float64(totalPresent+totalLate) / float64(marked) * 100
	}
	if completedCount > 0 {
		summary.TransferRate = float64(transferredCount) / float64(completedCount) * 100
	}
	for _, item := range summary.Participants {
		if item.Health == "critical" {
			summary.Health = "critical"
			break
		}
		if item.Health == "watch" {
			summary.Health = "watch"
		}
	}
	if summary.AttendanceRate < float64(goal.AttendanceGoalPercent) && marked > 0 {
		summary.Reasons = append(summary.Reasons, "asistencia grupal bajo la meta")
		if summary.Health == "healthy" {
			summary.Health = "watch"
		}
	}
	if len(summary.Reasons) == 0 {
		summary.Reasons = append(summary.Reasons, "grupo estable")
	}
	return summary, nil
}

func offlineV5EnrichWhiteboardSnapshot(payload json.RawMessage, canWrite bool) (json.RawMessage, error) {
	object, err := offlineV5SnapshotObject(payload)
	if err != nil {
		return nil, err
	}
	if _, ok := object["whiteboard"]; !ok {
		return nil, errors.New("offline v5 whiteboard snapshot missing root")
	}
	object["permissions"] = map[string]any{"can_view": true, "can_edit": canWrite, "can_manage_access": false,
		"can_upload_assets": false}
	object["collaboration"] = map[string]any{"available": false, "reason": "offline"}
	object["asset_transport"] = map[string]any{"embedded": false, "local_encrypted": true, "blob_sync_enabled": false}
	return offlineV5MarshalSnapshot(object)
}
