package repository

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
)

var ErrDefaultTaskList = errors.New("the default task list cannot be archived")

type TaskRepository struct {
	db *pgxpool.Pool
}

func nextTaskCreateSortOrder(count, minOrder, maxOrder int, placement string) int {
	if count == 0 {
		return 1024
	}
	if strings.EqualFold(strings.TrimSpace(placement), "top") {
		return minOrder - 1024
	}
	return maxOrder + 1024
}

// synchronizeTaskStatusCategory keeps the legacy completion columns aligned
// with the workflow status row locked by the same transaction. Handlers may
// have resolved the status just before a concurrent administrator changed its
// category, so the repository remains the final consistency boundary.
func synchronizeTaskStatusCategory(task *domain.Task, category string) {
	previousStatus := task.Status
	actorID := task.CreatedBy
	if task.MutationActor != nil {
		actorID = *task.MutationActor
	}
	switch category {
	case domain.TaskStatusCategoryDone:
		task.Status = domain.TaskStatusCompleted
		task.Progress = 100
		if task.CompletedAt == nil {
			now := time.Now()
			task.CompletedAt = &now
		}
		if task.CompletedBy == nil {
			task.CompletedBy = &actorID
		}
	case domain.TaskStatusCategoryCancelled:
		task.Status = domain.TaskStatusCancelled
		task.CompletedAt = nil
		task.CompletedBy = nil
		if previousStatus == domain.TaskStatusCompleted && task.Progress == 100 {
			task.Progress = 0
		}
	default:
		task.Status = domain.TaskStatusPending
		task.CompletedAt = nil
		task.CompletedBy = nil
		if previousStatus == domain.TaskStatusCompleted && task.Progress == 100 {
			task.Progress = 0
		}
	}
}

const taskSelectFields = `
	t.id, t.account_id, t.created_by, t.assigned_to, t.title, t.description, t.type,
	t.start_at, t.due_at, t.due_end_at, COALESCE(t.is_all_day,FALSE), t.priority, t.status, t.status_id, t.completed_at, t.completed_by,
	t.lead_id, t.event_id, t.program_id, t.contact_id, t.list_id,
	t.parent_task_id,
	COALESCE(t.starred, FALSE) AS starred, COALESCE(t.sort_order, 0) AS sort_order,
	COALESCE(t.progress,0), COALESCE(t.is_milestone,FALSE), t.deleted_at, t.deleted_by, COALESCE(t.version,1),
	t.recurrence_rule, t.recurrence_parent_id, t.reminder_minutes,
	t.notes, t.created_at, t.updated_at,
	COALESCE(ua.display_name, ua.username, '') AS assigned_to_name,
	COALESCE(uc.display_name, uc.username, '') AS created_by_name,
	CASE WHEN l.contact_id IS NULL THEN COALESCE(l.name,'') ELSE COALESCE(lc.custom_name,lc.name,lc.push_name,'') END AS lead_name,
	COALESCE(e.name, '') AS event_name,
	COALESCE(p.name, '') AS program_name,
	COALESCE(ct.custom_name, ct.name, ct.push_name, '') AS contact_name,
	COALESCE(tl.name, '') AS list_name,
	tl.folder_id, COALESCE(tf.name,''),
	ts.workflow_id, COALESCE(ts.name,''), COALESCE(ts.color,''), COALESCE(ts.category,''), COALESCE(ts.sort_order,0), COALESCE(ts.is_default,FALSE),
	COALESCE((SELECT COUNT(*) FROM tasks st WHERE st.parent_task_id = t.id AND st.account_id=t.account_id AND st.deleted_at IS NULL), 0) AS subtask_count,
	COALESCE((SELECT COUNT(*) FROM tasks st JOIN task_statuses child_status ON child_status.id=st.status_id AND child_status.account_id=st.account_id WHERE st.parent_task_id = t.id AND st.account_id=t.account_id AND st.deleted_at IS NULL AND child_status.category='done'), 0) AS subtask_done,
	COALESCE((SELECT COUNT(*) FROM task_comments comment WHERE comment.account_id=t.account_id AND comment.task_id=t.id AND comment.deleted_at IS NULL), 0) AS comment_count,
	COALESCE((SELECT COUNT(*) FROM task_attachments attachment WHERE attachment.account_id=t.account_id AND attachment.task_id=t.id), 0) AS attachment_count
`

const taskJoins = `
	LEFT JOIN users ua ON ua.id = t.assigned_to
	LEFT JOIN users uc ON uc.id = t.created_by
	LEFT JOIN leads l ON l.id=t.lead_id AND l.account_id=t.account_id
	LEFT JOIN contacts lc ON lc.id=l.contact_id AND lc.account_id=t.account_id
	LEFT JOIN events e ON e.id=t.event_id AND e.account_id=t.account_id
	LEFT JOIN programs p ON p.id=t.program_id AND p.account_id=t.account_id
	LEFT JOIN contacts ct ON ct.id=t.contact_id AND ct.account_id=t.account_id
	LEFT JOIN task_lists tl ON tl.id = t.list_id AND tl.account_id=t.account_id
	LEFT JOIN task_folders tf ON tf.id=tl.folder_id AND tf.account_id=t.account_id
	LEFT JOIN task_statuses ts ON ts.id=t.status_id AND ts.account_id=t.account_id
`

func (r *TaskRepository) scanTask(row interface {
	Scan(dest ...interface{}) error
}) (*domain.Task, error) {
	t := &domain.Task{}
	var statusWorkflowID *uuid.UUID
	var statusName, statusColor, statusCategory string
	var statusSortOrder int
	var statusIsDefault bool
	err := row.Scan(
		&t.ID, &t.AccountID, &t.CreatedBy, &t.AssignedTo, &t.Title, &t.Description, &t.Type,
		&t.StartAt, &t.DueAt, &t.DueEndAt, &t.IsAllDay, &t.Priority, &t.Status, &t.StatusID, &t.CompletedAt, &t.CompletedBy,
		&t.LeadID, &t.EventID, &t.ProgramID, &t.ContactID, &t.ListID,
		&t.ParentTaskID,
		&t.Starred, &t.SortOrder,
		&t.Progress, &t.IsMilestone, &t.DeletedAt, &t.DeletedBy, &t.Version,
		&t.RecurrenceRule, &t.RecurrenceParentID, &t.ReminderMinutes,
		&t.Notes, &t.CreatedAt, &t.UpdatedAt,
		&t.AssignedToName, &t.CreatedByName, &t.LeadName, &t.EventName, &t.ProgramName, &t.ContactName,
		&t.ListName, &t.FolderID, &t.FolderName,
		&statusWorkflowID, &statusName, &statusColor, &statusCategory, &statusSortOrder, &statusIsDefault,
		&t.SubtaskCount, &t.SubtaskDone, &t.CommentCount, &t.AttachmentCount,
	)
	if err != nil {
		return t, err
	}
	if t.StatusID != nil && statusWorkflowID != nil {
		t.StatusDetail = &domain.TaskStatus{
			ID: *t.StatusID, AccountID: t.AccountID, WorkflowID: *statusWorkflowID,
			Name: statusName, Color: statusColor, Category: statusCategory,
			SortOrder: statusSortOrder, IsDefault: statusIsDefault,
		}
	}
	return t, nil
}

func (r *TaskRepository) Create(ctx context.Context, t *domain.Task) error {
	t.ID = uuid.New()
	now := time.Now()
	t.CreatedAt = now
	t.UpdatedAt = now
	if t.Status == "" {
		t.Status = domain.TaskStatusPending
	}
	if t.Priority == "" {
		t.Priority = domain.TaskPriorityMedium
	}

	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	// Serialize placement per list. This prevents simultaneous quick creates
	// from receiving the same order while keeping different lists independent.
	if t.ListID != nil {
		if err := tx.QueryRow(ctx, `SELECT id FROM task_lists WHERE account_id=$1 AND id=$2 AND archived_at IS NULL FOR UPDATE`, t.AccountID, *t.ListID).Scan(new(uuid.UUID)); err != nil {
			return err
		}
	} else {
		if err := tx.QueryRow(ctx, `SELECT id FROM accounts WHERE id=$1 FOR UPDATE`, t.AccountID).Scan(new(uuid.UUID)); err != nil {
			return err
		}
	}
	if t.ParentTaskID != nil {
		var parentListID, grandparentID *uuid.UUID
		if err := tx.QueryRow(ctx, `SELECT list_id,parent_task_id FROM tasks
			WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE`, t.AccountID, *t.ParentTaskID).
			Scan(&parentListID, &grandparentID); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrTaskParentArchived
			}
			return err
		}
		if grandparentID != nil || !taskUUIDPointersEqual(parentListID, t.ListID) {
			return ErrTaskWorkNotFound
		}
	}
	if t.ListID != nil && t.StatusID != nil {
		var statusCategory string
		var statusWorkflowID uuid.UUID
		if err := tx.QueryRow(ctx, `SELECT status.category,status.workflow_id FROM task_lists list
			JOIN task_statuses status ON status.account_id=list.account_id AND status.workflow_id=list.workflow_id
			WHERE list.account_id=$1 AND list.id=$2 AND list.archived_at IS NULL AND status.id=$3
			FOR SHARE OF status`, t.AccountID, *t.ListID, *t.StatusID).Scan(&statusCategory, &statusWorkflowID); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrTaskStatusMappingInvalid
			}
			return err
		}
		if err := lockTaskWorkflowStatuses(ctx, tx, t.AccountID, statusWorkflowID); err != nil {
			return err
		}
		synchronizeTaskStatusCategory(t, statusCategory)
	}
	var count int
	var minOrder, maxOrder int
	if err := tx.QueryRow(ctx, `
		SELECT COUNT(*),COALESCE(MIN(sort_order),0),COALESCE(MAX(sort_order),0)
		FROM tasks
		WHERE account_id=$1 AND list_id IS NOT DISTINCT FROM $2::uuid
		  AND parent_task_id IS NOT DISTINCT FROM $3::uuid AND deleted_at IS NULL
	`, t.AccountID, t.ListID, t.ParentTaskID).Scan(&count, &minOrder, &maxOrder); err != nil {
		return err
	}
	if count > 0 && strings.EqualFold(strings.TrimSpace(t.Placement), "top") {
		// A quick create must not rewrite every existing position: remote clients
		// would otherwise retain stale numbers and could render the new card below
		// the former first card. Keep the canonical 1024 gap even across zero;
		// startup migration normalizes non-positive groups without changing order.
	}
	t.SortOrder = nextTaskCreateSortOrder(count, minOrder, maxOrder, t.Placement)

	_, err = tx.Exec(ctx, `
		INSERT INTO tasks (id, account_id, created_by, assigned_to, title, description, type,
			start_at, due_at, due_end_at, is_all_day, priority, status, status_id, completed_at, completed_by,
			lead_id, event_id, program_id, contact_id, list_id, parent_task_id,
			starred, sort_order, progress, is_milestone, recurrence_rule, recurrence_parent_id,
			reminder_minutes, notes, created_at, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32)
	`, t.ID, t.AccountID, t.CreatedBy, t.AssignedTo, t.Title, t.Description, t.Type,
		t.StartAt, t.DueAt, t.DueEndAt, t.IsAllDay, t.Priority, t.Status, t.StatusID,
		t.CompletedAt, t.CompletedBy, t.LeadID, t.EventID, t.ProgramID, t.ContactID, t.ListID, t.ParentTaskID,
		t.Starred, t.SortOrder, t.Progress, t.IsMilestone, t.RecurrenceRule, t.RecurrenceParentID,
		t.ReminderMinutes, t.Notes, t.CreatedAt, t.UpdatedAt,
	)
	if err != nil {
		return err
	}
	if len(t.CollaboratorIDs) > 0 {
		collaboratorActor := t.CreatedBy
		if t.CollaboratorsActor != nil {
			collaboratorActor = *t.CollaboratorsActor
		}
		if _, err := tx.Exec(ctx, `INSERT INTO task_collaborators(account_id,task_id,user_id,created_by)
			SELECT $1,$2,collaborator_id,$3 FROM unnest($4::uuid[]) AS collaborator_id`,
			t.AccountID, t.ID, collaboratorActor, t.CollaboratorIDs); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (r *TaskRepository) Update(ctx context.Context, t *domain.Task) error {
	t.UpdatedAt = time.Now()
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var observedListID, observedParentID *uuid.UUID
	var observedVersion int64
	if err := tx.QueryRow(ctx, `SELECT list_id,parent_task_id,COALESCE(version,1) FROM tasks
		WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL`, t.AccountID, t.ID).Scan(&observedListID, &observedParentID, &observedVersion); err != nil {
		return err
	}
	if observedVersion != t.Version {
		return ErrTaskVersionConflict
	}
	if !taskUUIDPointersEqual(observedParentID, t.ParentTaskID) {
		return ErrTaskWorkNotFound
	}
	listIDs := make([]uuid.UUID, 0, 2)
	if observedListID != nil {
		listIDs = append(listIDs, *observedListID)
	}
	if t.ListID != nil && (observedListID == nil || *t.ListID != *observedListID) {
		listIDs = append(listIDs, *t.ListID)
	}
	if len(listIDs) > 0 {
		rows, err := tx.Query(ctx, `SELECT id,archived_at FROM task_lists
			WHERE account_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE`, t.AccountID, listIDs)
		if err != nil {
			return err
		}
		lockedLists := make(map[uuid.UUID]*time.Time, len(listIDs))
		for rows.Next() {
			var id uuid.UUID
			var archivedAt *time.Time
			if err := rows.Scan(&id, &archivedAt); err != nil {
				rows.Close()
				return err
			}
			lockedLists[id] = archivedAt
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return err
		}
		rows.Close()
		if len(lockedLists) != len(listIDs) {
			return ErrTaskWorkNotFound
		}
		if t.ListID != nil && lockedLists[*t.ListID] != nil {
			return ErrTaskWorkNotFound
		}
	} else if err := tx.QueryRow(ctx, `SELECT id FROM accounts WHERE id=$1 FOR UPDATE`, t.AccountID).Scan(new(uuid.UUID)); err != nil {
		return err
	}
	if observedParentID != nil {
		var parentListID, parentParentID *uuid.UUID
		if err := tx.QueryRow(ctx, `SELECT list_id,parent_task_id FROM tasks
			WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE`, t.AccountID, *observedParentID).
			Scan(&parentListID, &parentParentID); err != nil {
			return ErrTaskParentArchived
		}
		if parentParentID != nil || !taskUUIDPointersEqual(parentListID, t.ListID) {
			return ErrTaskWorkNotFound
		}
	}
	var currentListID, currentParentID *uuid.UUID
	var currentVersion int64
	var currentSortOrder int
	if err := tx.QueryRow(ctx, `SELECT list_id,parent_task_id,COALESCE(version,1),sort_order FROM tasks
		WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE`, t.AccountID, t.ID).
		Scan(&currentListID, &currentParentID, &currentVersion, &currentSortOrder); err != nil {
		return err
	}
	if currentVersion != t.Version || !taskUUIDPointersEqual(observedListID, currentListID) || !taskUUIDPointersEqual(observedParentID, currentParentID) {
		return ErrTaskVersionConflict
	}
	if t.ListID != nil && t.StatusID != nil {
		var statusCategory string
		var statusWorkflowID uuid.UUID
		if err := tx.QueryRow(ctx, `SELECT status.category,status.workflow_id FROM task_lists list
			JOIN task_statuses status ON status.account_id=list.account_id AND status.workflow_id=list.workflow_id
			WHERE list.account_id=$1 AND list.id=$2 AND list.archived_at IS NULL AND status.id=$3
			FOR SHARE OF status`, t.AccountID, *t.ListID, *t.StatusID).Scan(&statusCategory, &statusWorkflowID); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrTaskStatusMappingInvalid
			}
			return err
		}
		if err := lockTaskWorkflowStatuses(ctx, tx, t.AccountID, statusWorkflowID); err != nil {
			return err
		}
		synchronizeTaskStatusCategory(t, statusCategory)
	}
	if !taskUUIDPointersEqual(currentListID, t.ListID) || !taskUUIDPointersEqual(currentParentID, t.ParentTaskID) {
		if err := tx.QueryRow(ctx, `SELECT COALESCE(MAX(sort_order),0)+1024 FROM tasks
			WHERE account_id=$1 AND id<>$2 AND list_id IS NOT DISTINCT FROM $3::uuid
			  AND parent_task_id IS NOT DISTINCT FROM $4::uuid AND deleted_at IS NULL`,
			t.AccountID, t.ID, t.ListID, t.ParentTaskID).Scan(&t.SortOrder); err != nil {
			return err
		}
	} else {
		t.SortOrder = currentSortOrder
	}
	command, err := tx.Exec(ctx, `
		UPDATE tasks SET
			assigned_to=$1, title=$2, description=$3, type=$4,
			start_at=$5, due_at=$6, due_end_at=$7, is_all_day=$8, priority=$9, status=$10, status_id=$11,
			completed_at=$12, completed_by=$13,
			lead_id=$14, event_id=$15, program_id=$16, contact_id=$17,
			list_id=$18, parent_task_id=$19, starred=$20, sort_order=$21, progress=$22,
			is_milestone=$23, recurrence_rule=$24, reminder_minutes=$25, notes=$26,
			updated_at=$27, version=COALESCE(version,1)+1,
			overdue_notified_at=CASE WHEN due_at IS DISTINCT FROM $6 OR status_id IS DISTINCT FROM $11 THEN NULL ELSE overdue_notified_at END
		WHERE id=$28 AND account_id=$29 AND COALESCE(version,1)=$30
	`, t.AssignedTo, t.Title, t.Description, t.Type,
		t.StartAt, t.DueAt, t.DueEndAt, t.IsAllDay, t.Priority, t.Status, t.StatusID,
		t.CompletedAt, t.CompletedBy, t.LeadID, t.EventID, t.ProgramID, t.ContactID,
		t.ListID, t.ParentTaskID, t.Starred, t.SortOrder, t.Progress, t.IsMilestone,
		t.RecurrenceRule, t.ReminderMinutes, t.Notes, t.UpdatedAt,
		t.ID, t.AccountID, t.Version,
	)
	if err != nil {
		return err
	}
	if command.RowsAffected() == 0 {
		return ErrTaskVersionConflict
	}
	if t.CollaboratorsSet {
		if _, err := tx.Exec(ctx, `DELETE FROM task_collaborators WHERE account_id=$1 AND task_id=$2`, t.AccountID, t.ID); err != nil {
			return err
		}
		if len(t.CollaboratorIDs) > 0 {
			collaboratorActor := t.CreatedBy
			if t.CollaboratorsActor != nil {
				collaboratorActor = *t.CollaboratorsActor
			}
			if _, err := tx.Exec(ctx, `INSERT INTO task_collaborators(account_id,task_id,user_id,created_by)
				SELECT $1,$2,collaborator_id,$3 FROM unnest($4::uuid[]) AS collaborator_id`,
				t.AccountID, t.ID, collaboratorActor, t.CollaboratorIDs); err != nil {
				return err
			}
		}
	} else if _, err := tx.Exec(ctx, `DELETE FROM task_collaborators WHERE account_id=$1 AND task_id=$2 AND user_id=$3`, t.AccountID, t.ID, t.AssignedTo); err != nil {
		return err
	}
	if t.ParentTaskID == nil && t.ListID != nil && !taskUUIDPointersEqual(currentListID, t.ListID) {
		var childMappingMissing bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(
			SELECT 1 FROM tasks child
			LEFT JOIN task_statuses current_status ON current_status.account_id=child.account_id AND current_status.id=child.status_id
			JOIN task_lists target_list ON target_list.account_id=child.account_id AND target_list.id=$3
			WHERE child.account_id=$1 AND child.parent_task_id=$2 AND child.deleted_at IS NULL
			  AND NOT EXISTS(
				SELECT 1 FROM task_statuses target
				WHERE target.account_id=target_list.account_id AND target.workflow_id=target_list.workflow_id
				  AND target.category=COALESCE(current_status.category,CASE child.status
					WHEN 'completed' THEN 'done' WHEN 'cancelled' THEN 'cancelled' ELSE 'not_started' END)
			  )
		)`, t.AccountID, t.ID, t.ListID).Scan(&childMappingMissing); err != nil {
			return err
		}
		if childMappingMissing {
			return ErrTaskStatusMappingInvalid
		}
		if _, err := tx.Exec(ctx, `
			UPDATE tasks child SET
				list_id=$3,
				status_id=(
					SELECT target.id
					FROM task_lists target_list
					JOIN task_statuses target ON target.account_id=target_list.account_id AND target.workflow_id=target_list.workflow_id
					LEFT JOIN task_statuses current_status ON current_status.account_id=child.account_id AND current_status.id=child.status_id
					WHERE target_list.account_id=child.account_id AND target_list.id=$3
					  AND target.category=COALESCE(current_status.category,CASE child.status
						WHEN 'completed' THEN 'done' WHEN 'cancelled' THEN 'cancelled' ELSE 'not_started' END)
					ORDER BY target.is_default DESC,target.sort_order LIMIT 1
				),
				updated_at=$4,version=COALESCE(child.version,1)+1
			WHERE child.account_id=$1 AND child.parent_task_id=$2 AND child.deleted_at IS NULL
			  AND child.list_id IS DISTINCT FROM $3
		`, t.AccountID, t.ID, t.ListID, t.UpdatedAt); err != nil {
			return err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	t.Version++
	return nil
}

func (r *TaskRepository) Delete(ctx context.Context, id, accountID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `DELETE FROM tasks WHERE id=$1 AND account_id=$2`, id, accountID)
	return err
}

func (r *TaskRepository) GetByID(ctx context.Context, id, accountID uuid.UUID) (*domain.Task, error) {
	row := r.db.QueryRow(ctx, `
		SELECT `+taskSelectFields+`
		FROM tasks t `+taskJoins+`
		WHERE t.id=$1 AND t.account_id=$2
	`, id, accountID)
	return r.scanTask(row)
}

func (r *TaskRepository) MarkCompleted(ctx context.Context, id, accountID, completedBy uuid.UUID) error {
	now := time.Now()
	command, err := r.db.Exec(ctx, `
		UPDATE tasks SET status='completed',
			status_id=COALESCE((
				SELECT done.id FROM task_statuses current_status
				JOIN task_statuses done ON done.workflow_id=current_status.workflow_id
					AND done.account_id=current_status.account_id AND done.category='done'
				WHERE current_status.id=tasks.status_id AND current_status.account_id=tasks.account_id
				ORDER BY done.sort_order LIMIT 1
			), status_id),
			progress=100, completed_at=$1, completed_by=$2, updated_at=$1, version=COALESCE(version,1)+1
		WHERE id=$3 AND account_id=$4 AND deleted_at IS NULL
	`, now, completedBy, id, accountID)
	if err != nil {
		return err
	}
	if command.RowsAffected() == 0 {
		return ErrTaskWorkNotFound
	}
	return nil
}

func (r *TaskRepository) RecurringOccurrenceExists(ctx context.Context, accountID, rootID uuid.UUID, dueAt time.Time) (bool, error) {
	var exists bool
	err := r.db.QueryRow(ctx, `SELECT EXISTS(
		SELECT 1 FROM tasks
		WHERE account_id=$1 AND recurrence_parent_id=$2 AND due_at=$3
	)`, accountID, rootID, dueAt).Scan(&exists)
	return exists, err
}

func taskFilterValues(raw string) []string {
	seen := map[string]struct{}{}
	values := make([]string, 0)
	for _, part := range strings.Split(raw, ",") {
		value := strings.TrimSpace(part)
		if value == "" {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		values = append(values, value)
	}
	return values
}

func taskFilterUUIDs(raw string) []uuid.UUID {
	values := taskFilterValues(raw)
	result := make([]uuid.UUID, 0, len(values))
	for _, value := range values {
		if id, err := uuid.Parse(value); err == nil {
			result = append(result, id)
		}
	}
	return result
}

func firstTaskFilter(filters map[string]string, keys ...string) string {
	for _, key := range keys {
		if value := strings.TrimSpace(filters[key]); value != "" {
			return value
		}
	}
	return ""
}

func normalizeTaskDateFilter(key, value, operator string) (string, string) {
	parsed, err := time.ParseInLocation("2006-01-02", value, time.FixedZone("America/Lima", -5*60*60))
	if err != nil {
		return value, operator
	}
	if key == "to" || strings.HasSuffix(key, "_to") {
		parsed = parsed.AddDate(0, 0, 1)
		operator = "<"
	}
	return parsed.Format(time.RFC3339), operator
}

// GetByAccount returns tasks for an account with optional filters
func (r *TaskRepository) GetByAccount(ctx context.Context, accountID uuid.UUID, filters map[string]string, limit, offset int) ([]*domain.Task, int, error) {
	where := []string{"t.account_id=$1"}
	if filters["deleted"] == "true" {
		where = append(where, "t.deleted_at IS NOT NULL")
	} else {
		where = append(where, "t.deleted_at IS NULL")
	}
	args := []interface{}{accountID}
	idx := 2

	if raw := firstTaskFilter(filters, "status_ids", "status"); raw != "" {
		ids := make([]uuid.UUID, 0)
		legacy := make([]string, 0)
		overdue := false
		for _, value := range taskFilterValues(raw) {
			if id, err := uuid.Parse(value); err == nil {
				ids = append(ids, id)
			} else if value == "overdue" {
				overdue = true
			} else if value == domain.TaskStatusPending || value == domain.TaskStatusCompleted || value == domain.TaskStatusCancelled {
				legacy = append(legacy, value)
			}
		}
		parts := make([]string, 0, 3)
		if len(ids) > 0 {
			parts = append(parts, fmt.Sprintf("t.status_id=ANY($%d::uuid[])", idx))
			args = append(args, ids)
			idx++
		}
		if len(legacy) > 0 {
			parts = append(parts, fmt.Sprintf("t.status=ANY($%d::text[])", idx))
			args = append(args, legacy)
			idx++
		}
		if overdue {
			parts = append(parts, "(t.due_at < NOW() AND COALESCE(ts.category,'not_started') NOT IN ('done','cancelled'))")
		}
		if len(parts) > 0 {
			where = append(where, "("+strings.Join(parts, " OR ")+")")
		} else {
			where = append(where, "FALSE")
		}
	}
	if v, ok := filters["folder_id"]; ok && v != "" {
		where = append(where, fmt.Sprintf("tl.folder_id=$%d", idx))
		args = append(args, v)
		idx++
	}
	if v, ok := filters["parent_task_id"]; ok && v != "" {
		where = append(where, fmt.Sprintf("t.parent_task_id=$%d", idx))
		args = append(args, v)
		idx++
	} else if filters["include_subtasks"] != "true" {
		where = append(where, "t.parent_task_id IS NULL")
	}
	if raw := firstTaskFilter(filters, "types", "type"); raw != "" {
		values := taskFilterValues(raw)
		if len(values) > 0 {
			where = append(where, fmt.Sprintf("t.type=ANY($%d::text[])", idx))
			args = append(args, values)
			idx++
		}
	}
	if raw := firstTaskFilter(filters, "assigned_to_ids", "assigned_to"); raw != "" {
		values := taskFilterUUIDs(raw)
		if len(values) > 0 {
			where = append(where, fmt.Sprintf("t.assigned_to=ANY($%d::uuid[])", idx))
			args = append(args, values)
			idx++
		} else {
			where = append(where, "FALSE")
		}
	}
	if raw := filters["collaborator_ids"]; strings.TrimSpace(raw) != "" {
		values := taskFilterUUIDs(raw)
		if len(values) > 0 {
			where = append(where, fmt.Sprintf("EXISTS(SELECT 1 FROM task_collaborators collaborator WHERE collaborator.account_id=t.account_id AND collaborator.task_id=t.id AND collaborator.user_id=ANY($%d::uuid[]))", idx))
			args = append(args, values)
			idx++
		} else {
			where = append(where, "FALSE")
		}
	}
	if raw := firstTaskFilter(filters, "priorities", "priority"); raw != "" {
		values := taskFilterValues(raw)
		if len(values) > 0 {
			where = append(where, fmt.Sprintf("t.priority=ANY($%d::text[])", idx))
			args = append(args, values)
			idx++
		}
	}
	if raw := firstTaskFilter(filters, "creator_ids", "created_by"); raw != "" {
		values := taskFilterUUIDs(raw)
		if len(values) > 0 {
			where = append(where, fmt.Sprintf("t.created_by=ANY($%d::uuid[])", idx))
			args = append(args, values)
			idx++
		} else {
			where = append(where, "FALSE")
		}
	}
	if v, ok := filters["lead_id"]; ok && v != "" {
		where = append(where, fmt.Sprintf("t.lead_id=$%d", idx))
		args = append(args, v)
		idx++
	}
	if v, ok := filters["event_id"]; ok && v != "" {
		where = append(where, fmt.Sprintf("t.event_id=$%d", idx))
		args = append(args, v)
		idx++
	}
	if v, ok := filters["program_id"]; ok && v != "" {
		where = append(where, fmt.Sprintf("t.program_id=$%d", idx))
		args = append(args, v)
		idx++
	}
	if v, ok := filters["contact_id"]; ok && v != "" {
		where = append(where, fmt.Sprintf("t.contact_id=$%d", idx))
		args = append(args, v)
		idx++
	}
	if v, ok := filters["list_id"]; ok && v != "" {
		if v == "none" {
			where = append(where, "t.list_id IS NULL")
		} else if strings.Contains(v, ",") {
			parts := strings.Split(v, ",")
			var uuidParts []string
			hasNone := false
			for _, p := range parts {
				p = strings.TrimSpace(p)
				if p == "none" {
					hasNone = true
				} else if _, err := uuid.Parse(p); err == nil {
					uuidParts = append(uuidParts, p)
				}
			}
			if hasNone && len(uuidParts) > 0 {
				where = append(where, fmt.Sprintf("(t.list_id IS NULL OR t.list_id = ANY($%d::uuid[]))", idx))
				args = append(args, "{"+strings.Join(uuidParts, ",")+"}")
				idx++
			} else if hasNone {
				where = append(where, "t.list_id IS NULL")
			} else if len(uuidParts) > 0 {
				where = append(where, fmt.Sprintf("t.list_id = ANY($%d::uuid[])", idx))
				args = append(args, "{"+strings.Join(uuidParts, ",")+"}")
				idx++
			}
		} else {
			where = append(where, fmt.Sprintf("t.list_id=$%d", idx))
			args = append(args, v)
			idx++
		}
	}
	if v, ok := filters["starred"]; ok {
		if strings.EqualFold(v, "true") {
			where = append(where, "t.starred = TRUE")
		} else if strings.EqualFold(v, "false") {
			where = append(where, "t.starred = FALSE")
		}
	}
	if raw := strings.TrimSpace(filters["due"]); raw != "" {
		parts := make([]string, 0)
		localDate := "(NOW() AT TIME ZONE 'America/Lima')::date"
		dueDate := "(t.due_at AT TIME ZONE 'America/Lima')::date"
		for _, bucket := range taskFilterValues(raw) {
			switch bucket {
			case "overdue":
				parts = append(parts, "(t.due_at < NOW() AND COALESCE(ts.category,'not_started') NOT IN ('done','cancelled'))")
			case "today":
				parts = append(parts, dueDate+"="+localDate)
			case "tomorrow":
				parts = append(parts, dueDate+"="+localDate+"+1")
			case "this_week":
				parts = append(parts, "("+dueDate+">="+localDate+" AND "+dueDate+"<"+localDate+"+7)")
			case "next_7_days":
				parts = append(parts, "("+dueDate+">="+localDate+" AND "+dueDate+"<="+localDate+"+7)")
			case "no_date":
				parts = append(parts, "t.due_at IS NULL")
			case "with_date":
				parts = append(parts, "t.due_at IS NOT NULL")
			}
		}
		if len(parts) > 0 {
			where = append(where, "("+strings.Join(parts, " OR ")+")")
		} else {
			where = append(where, "FALSE")
		}
	}
	if v, ok := filters["from"]; ok && v != "" {
		value, operator := normalizeTaskDateFilter("from", v, ">=")
		where = append(where, fmt.Sprintf("t.due_at %s $%d::timestamptz", operator, idx))
		args = append(args, value)
		idx++
	}
	if v, ok := filters["to"]; ok && v != "" {
		value, operator := normalizeTaskDateFilter("to", v, "<=")
		where = append(where, fmt.Sprintf("t.due_at %s $%d::timestamptz", operator, idx))
		args = append(args, value)
		idx++
	}
	for _, dateFilter := range []struct {
		key      string
		column   string
		operator string
	}{
		{key: "created_from", column: "t.created_at", operator: ">="},
		{key: "created_to", column: "t.created_at", operator: "<="},
		{key: "completed_from", column: "t.completed_at", operator: ">="},
		{key: "completed_to", column: "t.completed_at", operator: "<="},
	} {
		if value := strings.TrimSpace(filters[dateFilter.key]); value != "" {
			value, operator := normalizeTaskDateFilter(dateFilter.key, value, dateFilter.operator)
			where = append(where, fmt.Sprintf("%s %s $%d::timestamptz", dateFilter.column, operator, idx))
			args = append(args, value)
			idx++
		}
	}
	for _, presence := range []struct {
		key       string
		predicate string
	}{
		{key: "has_subtasks", predicate: "EXISTS(SELECT 1 FROM tasks child WHERE child.account_id=t.account_id AND child.parent_task_id=t.id AND child.deleted_at IS NULL)"},
		{key: "has_comments", predicate: "EXISTS(SELECT 1 FROM task_comments comment WHERE comment.account_id=t.account_id AND comment.task_id=t.id AND comment.deleted_at IS NULL)"},
		{key: "has_attachments", predicate: "EXISTS(SELECT 1 FROM task_attachments attachment WHERE attachment.account_id=t.account_id AND attachment.task_id=t.id)"},
		{key: "has_dependencies", predicate: "EXISTS(SELECT 1 FROM task_dependencies dependency WHERE dependency.account_id=t.account_id AND (dependency.predecessor_task_id=t.id OR dependency.successor_task_id=t.id))"},
	} {
		if value := strings.ToLower(strings.TrimSpace(filters[presence.key])); value == "true" {
			where = append(where, presence.predicate)
		} else if value == "false" {
			where = append(where, "NOT ("+presence.predicate+")")
		}
	}
	if v, ok := filters["search"]; ok && v != "" {
		where = append(where, fmt.Sprintf("(t.title ILIKE $%d OR t.description ILIKE $%d)", idx, idx))
		args = append(args, "%"+v+"%")
		idx++
	}

	whereClause := strings.Join(where, " AND ")

	// Count
	var total int
	countSQL := fmt.Sprintf("SELECT COUNT(*) FROM tasks t %s WHERE %s", taskJoins, whereClause)
	if err := r.db.QueryRow(ctx, countSQL, args...).Scan(&total); err != nil {
		return nil, 0, err
	}

	// Fetch
	fetchSQL := fmt.Sprintf(`
		SELECT %s
		FROM tasks t %s
		WHERE %s
		ORDER BY
			CASE t.status WHEN 'overdue' THEN 0 WHEN 'pending' THEN 1 WHEN 'completed' THEN 2 WHEN 'cancelled' THEN 3 END,
			t.sort_order ASC,
			t.due_at ASC NULLS LAST,
			t.id ASC
		LIMIT $%d OFFSET $%d
	`, taskSelectFields, taskJoins, whereClause, idx, idx+1)
	args = append(args, limit, offset)

	rows, err := r.db.Query(ctx, fetchSQL, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	var tasks []*domain.Task
	for rows.Next() {
		t, err := r.scanTask(rows)
		if err != nil {
			return nil, 0, err
		}
		tasks = append(tasks, t)
	}
	return tasks, total, nil
}

// GetCalendarRange returns tasks for a date range (for calendar view)
func (r *TaskRepository) GetCalendarRange(ctx context.Context, accountID uuid.UUID, from, to time.Time, assignedTo *uuid.UUID) ([]*domain.Task, error) {
	query := `
		SELECT ` + taskSelectFields + `
		FROM tasks t ` + taskJoins + `
		WHERE t.account_id=$1 AND t.deleted_at IS NULL AND t.due_at >= $2 AND t.due_at <= $3
	`
	args := []interface{}{accountID, from, to}

	if assignedTo != nil {
		query += ` AND t.assigned_to=$4`
		args = append(args, *assignedTo)
	}

	query += ` ORDER BY t.due_at ASC NULLS LAST`

	rows, err := r.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var tasks []*domain.Task
	for rows.Next() {
		t, err := r.scanTask(rows)
		if err != nil {
			return nil, err
		}
		tasks = append(tasks, t)
	}
	return tasks, nil
}

// GetStats returns task status counts for a user/account
func (r *TaskRepository) GetStats(ctx context.Context, accountID, assignedTo uuid.UUID) (map[string]int, error) {
	rows, err := r.db.Query(ctx, `
		SELECT CASE
			WHEN t.due_at < NOW() AND COALESCE(ts.category,'not_started') NOT IN ('done','cancelled') THEN 'overdue'
			WHEN ts.category='done' THEN 'completed'
			WHEN ts.category='cancelled' THEN 'cancelled'
			ELSE 'pending'
		END AS bucket, COUNT(*)
		FROM tasks t
		LEFT JOIN task_statuses ts ON ts.id=t.status_id AND ts.account_id=t.account_id
		WHERE t.account_id=$1 AND t.assigned_to=$2 AND t.deleted_at IS NULL AND t.parent_task_id IS NULL
		GROUP BY bucket
	`, accountID, assignedTo)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	stats := map[string]int{"pending": 0, "completed": 0, "overdue": 0, "cancelled": 0}
	for rows.Next() {
		var status string
		var count int
		if err := rows.Scan(&status, &count); err != nil {
			return nil, err
		}
		stats[status] = count
	}

	// Also count today's tasks
	var todayCount int
	_ = r.db.QueryRow(ctx, `
		SELECT COUNT(*) FROM tasks t
		LEFT JOIN task_statuses ts ON ts.id=t.status_id AND ts.account_id=t.account_id
		WHERE t.account_id=$1 AND t.assigned_to=$2 AND t.deleted_at IS NULL AND t.parent_task_id IS NULL
		AND COALESCE(ts.category,'not_started') NOT IN ('done','cancelled')
		AND t.due_at IS NOT NULL AND t.due_at >= CURRENT_DATE AND t.due_at < CURRENT_DATE + INTERVAL '1 day'
	`, accountID, assignedTo).Scan(&todayCount)
	stats["today"] = todayCount

	return stats, nil
}

// MarkOverdue claims newly overdue tasks for notification. Overdue is a
// computed condition and never overwrites the workflow status chosen by users.
func (r *TaskRepository) MarkOverdue(ctx context.Context) ([]domain.Task, error) {
	rows, err := r.db.Query(ctx, `
		WITH candidates AS (
			SELECT t.id FROM tasks t
			JOIN task_statuses ts ON ts.id=t.status_id AND ts.account_id=t.account_id
			WHERE ts.category NOT IN ('done','cancelled')
			  AND t.deleted_at IS NULL AND t.due_at IS NOT NULL AND t.due_at < NOW()
			  AND t.overdue_notified_at IS NULL
			ORDER BY t.due_at,t.id LIMIT 200 FOR UPDATE OF t SKIP LOCKED
		)
		UPDATE tasks t SET overdue_notified_at=NOW()
		FROM candidates c
		WHERE t.id=c.id
		RETURNING t.id, t.account_id, t.assigned_to, t.title, t.type, t.due_at
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var tasks []domain.Task
	for rows.Next() {
		var t domain.Task
		if err := rows.Scan(&t.ID, &t.AccountID, &t.AssignedTo, &t.Title, &t.Type, &t.DueAt); err != nil {
			return nil, err
		}
		tasks = append(tasks, t)
	}
	return tasks, nil
}

// GetPendingReminders returns reminders that should fire now
func (r *TaskRepository) GetPendingReminders(ctx context.Context) ([]domain.TaskReminder, error) {
	rows, err := r.db.Query(ctx, `
		SELECT tr.id, tr.task_id, tr.account_id, tr.assigned_to, tr.reminder_at, tr.delivered, tr.delivered_at
		FROM task_reminders tr
		WHERE tr.delivered = FALSE AND tr.reminder_at <= NOW()
		LIMIT 100
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var reminders []domain.TaskReminder
	for rows.Next() {
		var r domain.TaskReminder
		if err := rows.Scan(&r.ID, &r.TaskID, &r.AccountID, &r.AssignedTo, &r.ReminderAt, &r.Delivered, &r.DeliveredAt); err != nil {
			return nil, err
		}
		reminders = append(reminders, r)
	}
	return reminders, nil
}

// MarkReminderDelivered sets a reminder as delivered
func (r *TaskRepository) MarkReminderDelivered(ctx context.Context, id uuid.UUID) error {
	_, err := r.db.Exec(ctx, `
		UPDATE task_reminders SET delivered=TRUE, delivered_at=NOW() WHERE id=$1
	`, id)
	return err
}

// CreateReminder creates a task reminder
func (r *TaskRepository) CreateReminder(ctx context.Context, rem *domain.TaskReminder) error {
	rem.ID = uuid.New()
	_, err := r.db.Exec(ctx, `
		INSERT INTO task_reminders (id, task_id, account_id, assigned_to, reminder_at)
		VALUES ($1,$2,$3,$4,$5)
		ON CONFLICT (task_id) DO UPDATE SET id=EXCLUDED.id,account_id=EXCLUDED.account_id,
			assigned_to=EXCLUDED.assigned_to,reminder_at=EXCLUDED.reminder_at,delivered=FALSE,delivered_at=NULL
	`, rem.ID, rem.TaskID, rem.AccountID, rem.AssignedTo, rem.ReminderAt)
	return err
}

// SyncReminder derives the one current reminder from the locked canonical task
// row. It cannot reinsert a stale schedule after a newer task update, and the
// unique task_id contract makes repeated synchronization idempotent.
func (r *TaskRepository) SyncReminder(ctx context.Context, taskID uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var accountID, assignedTo uuid.UUID
	var dueAt, deletedAt *time.Time
	var reminderMinutes *int
	var category string
	if err := tx.QueryRow(ctx, `SELECT task.account_id,task.assigned_to,task.due_at,task.reminder_minutes,
		COALESCE(status.category,CASE task.status WHEN 'completed' THEN 'done' WHEN 'cancelled' THEN 'cancelled' ELSE 'not_started' END),task.deleted_at
		FROM tasks task LEFT JOIN task_statuses status ON status.account_id=task.account_id AND status.id=task.status_id
		WHERE task.id=$1 FOR UPDATE OF task`, taskID).
		Scan(&accountID, &assignedTo, &dueAt, &reminderMinutes, &category, &deletedAt); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM task_reminders WHERE task_id=$1`, taskID); err != nil {
		return err
	}
	if deletedAt == nil && category != domain.TaskStatusCategoryDone && category != domain.TaskStatusCategoryCancelled &&
		dueAt != nil && reminderMinutes != nil && *reminderMinutes > 0 {
		reminderAt := dueAt.Add(-time.Duration(*reminderMinutes) * time.Minute)
		if reminderAt.After(time.Now()) {
			if _, err := tx.Exec(ctx, `INSERT INTO task_reminders(task_id,account_id,assigned_to,reminder_at)
				VALUES($1,$2,$3,$4) ON CONFLICT(task_id) DO UPDATE SET account_id=EXCLUDED.account_id,
				assigned_to=EXCLUDED.assigned_to,reminder_at=EXCLUDED.reminder_at,delivered=FALSE,delivered_at=NULL`,
				taskID, accountID, assignedTo, reminderAt); err != nil {
				return err
			}
		}
	}
	return tx.Commit(ctx)
}

// DeleteRemindersByTask deletes all reminders for a task
func (r *TaskRepository) DeleteRemindersByTask(ctx context.Context, taskID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `DELETE FROM task_reminders WHERE task_id=$1`, taskID)
	return err
}

// GetTaskTitle returns just the title of a task (for reminders)
func (r *TaskRepository) GetTaskTitle(ctx context.Context, taskID uuid.UUID) (string, error) {
	var title string
	err := r.db.QueryRow(ctx, `SELECT title FROM tasks WHERE id=$1`, taskID).Scan(&title)
	return title, err
}

// GetTaskForReminder returns title, type, and due_at for a task (for reminders)
func (r *TaskRepository) GetTaskForReminder(ctx context.Context, taskID uuid.UUID) (string, string, *time.Time, error) {
	var title, taskType string
	var dueAt *time.Time
	err := r.db.QueryRow(ctx, `SELECT title, type, due_at FROM tasks WHERE id=$1 AND deleted_at IS NULL`, taskID).Scan(&title, &taskType, &dueAt)
	return title, taskType, dueAt, err
}

// ─── Subtask methods ──

func (r *TaskRepository) CreateSubtask(ctx context.Context, s *domain.Subtask) error {
	s.ID = uuid.New()
	now := time.Now()
	s.CreatedAt = now
	s.UpdatedAt = now

	// Auto-set sort_order
	var maxOrder int
	_ = r.db.QueryRow(ctx, `SELECT COALESCE(MAX(sort_order), -1) FROM subtasks WHERE task_id=$1`, s.TaskID).Scan(&maxOrder)
	s.SortOrder = maxOrder + 1

	_, err := r.db.Exec(ctx, `
		INSERT INTO subtasks (id, task_id, account_id, title, completed, sort_order, created_at, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
	`, s.ID, s.TaskID, s.AccountID, s.Title, s.Completed, s.SortOrder, s.CreatedAt, s.UpdatedAt)
	return err
}

func (r *TaskRepository) UpdateSubtask(ctx context.Context, s *domain.Subtask) error {
	s.UpdatedAt = time.Now()
	_, err := r.db.Exec(ctx, `
		UPDATE subtasks SET title=$1, completed=$2, completed_at=$3, sort_order=$4, updated_at=$5
		WHERE id=$6 AND account_id=$7
	`, s.Title, s.Completed, s.CompletedAt, s.SortOrder, s.UpdatedAt, s.ID, s.AccountID)
	return err
}

func (r *TaskRepository) DeleteSubtask(ctx context.Context, id, accountID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `DELETE FROM subtasks WHERE id=$1 AND account_id=$2`, id, accountID)
	return err
}

func (r *TaskRepository) ToggleSubtask(ctx context.Context, id, accountID uuid.UUID) (*domain.Subtask, error) {
	sub := &domain.Subtask{}
	now := time.Now()
	err := r.db.QueryRow(ctx, `
		UPDATE subtasks SET
			completed = NOT completed,
			completed_at = CASE WHEN NOT completed THEN $1 ELSE NULL END,
			updated_at = $1
		WHERE id=$2 AND account_id=$3
		RETURNING id, task_id, account_id, title, completed, completed_at, sort_order, created_at, updated_at
	`, now, id, accountID).Scan(
		&sub.ID, &sub.TaskID, &sub.AccountID, &sub.Title, &sub.Completed, &sub.CompletedAt, &sub.SortOrder, &sub.CreatedAt, &sub.UpdatedAt,
	)
	return sub, err
}

func (r *TaskRepository) GetSubtasksByTask(ctx context.Context, taskID uuid.UUID) ([]*domain.Subtask, error) {
	rows, err := r.db.Query(ctx, `
		SELECT id, task_id, account_id, title, completed, completed_at, sort_order, created_at, updated_at
		FROM subtasks WHERE task_id=$1
		ORDER BY sort_order, created_at
	`, taskID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var subs []*domain.Subtask
	for rows.Next() {
		s := &domain.Subtask{}
		if err := rows.Scan(&s.ID, &s.TaskID, &s.AccountID, &s.Title, &s.Completed, &s.CompletedAt, &s.SortOrder, &s.CreatedAt, &s.UpdatedAt); err != nil {
			return nil, err
		}
		subs = append(subs, s)
	}
	return subs, nil
}

// ─── Task List methods ──

func (r *TaskRepository) GetListsByAccount(ctx context.Context, accountID uuid.UUID) ([]*domain.TaskList, error) {
	rows, err := r.db.Query(ctx, `
		SELECT tl.id, tl.account_id, tl.folder_id, tl.workflow_id, COALESCE(tl.workflow_inherited,TRUE), COALESCE(tl.is_default,FALSE), tl.name, COALESCE(tl.description,''), tl.color, COALESCE(tl.icon,CASE WHEN tl.is_default THEN 'inbox' ELSE 'list' END),
			tl.sort_order, tl.created_by, tl.archived_at, tl.created_at, tl.updated_at,
			COALESCE((SELECT COUNT(*) FROM tasks t WHERE t.account_id=tl.account_id AND t.list_id=tl.id AND t.parent_task_id IS NULL AND t.deleted_at IS NULL), 0) AS task_count
		FROM task_lists tl
		WHERE tl.account_id=$1 AND tl.archived_at IS NULL
		ORDER BY tl.sort_order, tl.created_at
	`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var lists []*domain.TaskList
	for rows.Next() {
		l := &domain.TaskList{}
		if err := rows.Scan(&l.ID, &l.AccountID, &l.FolderID, &l.WorkflowID, &l.WorkflowInherited, &l.IsDefault, &l.Name, &l.Description, &l.Color, &l.Icon,
			&l.SortOrder, &l.CreatedBy, &l.ArchivedAt, &l.CreatedAt, &l.UpdatedAt, &l.TaskCount); err != nil {
			return nil, err
		}
		lists = append(lists, l)
	}
	return lists, nil
}

func (r *TaskRepository) CreateList(ctx context.Context, l *domain.TaskList) error {
	l.ID = uuid.New()
	now := time.Now()
	l.CreatedAt = now
	l.UpdatedAt = now
	if strings.TrimSpace(l.Color) == "" {
		l.Color = "#10b981"
	}
	if strings.TrimSpace(l.Icon) == "" {
		l.Icon = "list"
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	var inheritedWorkflowID uuid.UUID
	if l.FolderID != nil {
		if err := tx.QueryRow(ctx, `SELECT workflow_id FROM task_folders
			WHERE account_id=$1 AND id=$2 AND archived_at IS NULL FOR UPDATE`, l.AccountID, *l.FolderID).Scan(&inheritedWorkflowID); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrTaskWorkNotFound
			}
			return err
		}
	}

	if l.WorkflowID == nil {
		l.WorkflowInherited = true
		if l.FolderID != nil {
			workflowID := inheritedWorkflowID
			l.WorkflowID = &workflowID
		} else {
			var workflowID uuid.UUID
			if err := tx.QueryRow(ctx, `SELECT id FROM task_workflows
				WHERE account_id=$1 AND is_default ORDER BY id LIMIT 1 FOR KEY SHARE`, l.AccountID).Scan(&workflowID); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					return ErrTaskWorkNotFound
				}
				return err
			}
			l.WorkflowID = &workflowID
		}
	}
	var lockedWorkflowID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT id FROM task_workflows
		WHERE account_id=$1 AND id=$2 FOR KEY SHARE`, l.AccountID, *l.WorkflowID).Scan(&lockedWorkflowID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrTaskWorkNotFound
		}
		return err
	}
	var maxOrder int
	if err := tx.QueryRow(ctx, `SELECT COALESCE(MAX(sort_order), -1) FROM task_lists WHERE account_id=$1`, l.AccountID).Scan(&maxOrder); err != nil {
		return err
	}
	l.SortOrder = maxOrder + 1
	if _, err := tx.Exec(ctx, `
		INSERT INTO task_lists (id, account_id, folder_id, workflow_id, workflow_inherited, is_default, name, description, color, icon, sort_order, created_by, created_at, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
	`, l.ID, l.AccountID, l.FolderID, l.WorkflowID, l.WorkflowInherited, l.IsDefault, l.Name, l.Description, l.Color, l.Icon, l.SortOrder, l.CreatedBy, l.CreatedAt, l.UpdatedAt); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *TaskRepository) UpdateList(ctx context.Context, id, accountID uuid.UUID, name, color, icon *string, sortOrder *int) error {
	sets := []string{"updated_at=NOW()"}
	args := []interface{}{}
	idx := 1

	if name != nil {
		sets = append(sets, fmt.Sprintf("name=$%d", idx))
		args = append(args, *name)
		idx++
	}
	if color != nil {
		sets = append(sets, fmt.Sprintf("color=$%d", idx))
		args = append(args, *color)
		idx++
	}
	if icon != nil {
		sets = append(sets, fmt.Sprintf("icon=$%d", idx))
		args = append(args, *icon)
		idx++
	}
	if sortOrder != nil {
		sets = append(sets, fmt.Sprintf("sort_order=$%d", idx))
		args = append(args, *sortOrder)
		idx++
	}

	args = append(args, id, accountID)
	query := fmt.Sprintf("UPDATE task_lists SET %s WHERE id=$%d AND account_id=$%d", strings.Join(sets, ", "), idx, idx+1)
	_, err := r.db.Exec(ctx, query, args...)
	return err
}

func (r *TaskRepository) DeleteList(ctx context.Context, id, accountID uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var isDefault bool
	if err := tx.QueryRow(ctx, `SELECT is_default FROM task_lists
		WHERE id=$1 AND account_id=$2 AND archived_at IS NULL FOR UPDATE`, id, accountID).Scan(&isDefault); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrTaskWorkNotFound
		}
		return err
	}
	if isDefault {
		return ErrDefaultTaskList
	}
	var activeTasks int
	if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM tasks WHERE account_id=$1 AND list_id=$2 AND deleted_at IS NULL`, accountID, id).Scan(&activeTasks); err != nil {
		return err
	}
	if activeTasks > 0 {
		return ErrTaskContainerNotEmpty
	}
	if _, err := tx.Exec(ctx, `UPDATE task_lists SET archived_at=NOW(),updated_at=NOW() WHERE id=$1 AND account_id=$2`, id, accountID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *TaskRepository) ToggleStar(ctx context.Context, id, accountID uuid.UUID) (bool, error) {
	var starred bool
	err := r.db.QueryRow(ctx, `
		UPDATE tasks SET starred = NOT COALESCE(starred, FALSE), updated_at=NOW(),version=COALESCE(version,1)+1
		WHERE id=$1 AND account_id=$2 AND deleted_at IS NULL
		RETURNING starred
	`, id, accountID).Scan(&starred)
	return starred, err
}

func (r *TaskRepository) ReorderTasks(ctx context.Context, accountID uuid.UUID, taskIDs []uuid.UUID) error {
	if len(taskIDs) == 0 {
		return ErrTaskOrderInvalid
	}
	seen := make(map[uuid.UUID]struct{}, len(taskIDs))
	for _, id := range taskIDs {
		if _, exists := seen[id]; exists {
			return ErrTaskOrderInvalid
		}
		seen[id] = struct{}{}
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	rows, err := tx.Query(ctx, `SELECT id,list_id,parent_task_id FROM tasks
		WHERE account_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL`, accountID, taskIDs)
	if err != nil {
		return err
	}
	var listID, parentID *uuid.UUID
	loaded := 0
	for rows.Next() {
		var id uuid.UUID
		var candidateList, candidateParent *uuid.UUID
		if err := rows.Scan(&id, &candidateList, &candidateParent); err != nil {
			rows.Close()
			return err
		}
		if loaded == 0 {
			listID, parentID = candidateList, candidateParent
		} else if !taskUUIDPointersEqual(listID, candidateList) || !taskUUIDPointersEqual(parentID, candidateParent) {
			rows.Close()
			return ErrTaskOrderInvalid
		}
		loaded++
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	if loaded != len(taskIDs) {
		return ErrTaskOrderInvalid
	}
	if listID != nil {
		if err := tx.QueryRow(ctx, `SELECT id FROM task_lists WHERE account_id=$1 AND id=$2 FOR UPDATE`, accountID, *listID).Scan(new(uuid.UUID)); err != nil {
			return err
		}
	} else if err := tx.QueryRow(ctx, `SELECT id FROM accounts WHERE id=$1 FOR UPDATE`, accountID).Scan(new(uuid.UUID)); err != nil {
		return err
	}
	rows, err = tx.Query(ctx, `SELECT id FROM tasks WHERE account_id=$1
		AND list_id IS NOT DISTINCT FROM $2::uuid AND parent_task_id IS NOT DISTINCT FROM $3::uuid
		AND deleted_at IS NULL ORDER BY sort_order,id FOR UPDATE`, accountID, listID, parentID)
	if err != nil {
		return err
	}
	locked := make(map[uuid.UUID]struct{}, len(taskIDs))
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		locked[id] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	if len(locked) != len(taskIDs) {
		return ErrTaskOrderInvalid
	}
	for _, id := range taskIDs {
		if _, exists := locked[id]; !exists {
			return ErrTaskOrderInvalid
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE tasks task SET sort_order=(ordered.position::int * 1024)
		FROM unnest($2::uuid[]) WITH ORDINALITY AS ordered(id,position)
		WHERE task.account_id=$1 AND task.id=ordered.id`, accountID, taskIDs); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func taskUUIDPointersEqual(left, right *uuid.UUID) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func (r *TaskRepository) ReorderLists(ctx context.Context, accountID uuid.UUID, listIDs []uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	for i, id := range listIDs {
		_, err := tx.Exec(ctx, `UPDATE task_lists SET sort_order=$1, updated_at=NOW() WHERE id=$2 AND account_id=$3`, i, id, accountID)
		if err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
