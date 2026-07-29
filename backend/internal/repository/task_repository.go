package repository

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
)

var ErrDefaultTaskList = errors.New("the default task list cannot be archived")

type TaskRepository struct {
	db *pgxpool.Pool
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
	COALESCE((SELECT COUNT(*) FROM tasks st JOIN task_statuses child_status ON child_status.id=st.status_id AND child_status.account_id=st.account_id WHERE st.parent_task_id = t.id AND st.account_id=t.account_id AND st.deleted_at IS NULL AND child_status.category='done'), 0) AS subtask_done
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
		&t.SubtaskCount, &t.SubtaskDone,
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

	_, err := r.db.Exec(ctx, `
		INSERT INTO tasks (id, account_id, created_by, assigned_to, title, description, type,
			start_at, due_at, due_end_at, is_all_day, priority, status, status_id,
			lead_id, event_id, program_id, contact_id, list_id, parent_task_id,
			starred, sort_order, progress, is_milestone, recurrence_rule, recurrence_parent_id,
			reminder_minutes, notes, created_at, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)
	`, t.ID, t.AccountID, t.CreatedBy, t.AssignedTo, t.Title, t.Description, t.Type,
		t.StartAt, t.DueAt, t.DueEndAt, t.IsAllDay, t.Priority, t.Status, t.StatusID,
		t.LeadID, t.EventID, t.ProgramID, t.ContactID, t.ListID, t.ParentTaskID,
		t.Starred, t.SortOrder, t.Progress, t.IsMilestone, t.RecurrenceRule, t.RecurrenceParentID,
		t.ReminderMinutes, t.Notes, t.CreatedAt, t.UpdatedAt,
	)
	return err
}

func (r *TaskRepository) Update(ctx context.Context, t *domain.Task) error {
	t.UpdatedAt = time.Now()
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	command, err := tx.Exec(ctx, `
		UPDATE tasks SET
			assigned_to=$1, title=$2, description=$3, type=$4,
			start_at=$5, due_at=$6, due_end_at=$7, is_all_day=$8, priority=$9, status=$10, status_id=$11,
			lead_id=$12, event_id=$13, program_id=$14, contact_id=$15,
			list_id=$16, parent_task_id=$17, starred=$18, sort_order=$19, progress=$20,
			is_milestone=$21, recurrence_rule=$22, reminder_minutes=$23, notes=$24,
			updated_at=$25, version=COALESCE(version,1)+1,
			overdue_notified_at=CASE WHEN due_at IS DISTINCT FROM $6 OR status_id IS DISTINCT FROM $11 THEN NULL ELSE overdue_notified_at END
		WHERE id=$26 AND account_id=$27 AND COALESCE(version,1)=$28
	`, t.AssignedTo, t.Title, t.Description, t.Type,
		t.StartAt, t.DueAt, t.DueEndAt, t.IsAllDay, t.Priority, t.Status, t.StatusID,
		t.LeadID, t.EventID, t.ProgramID, t.ContactID,
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
	if _, err := tx.Exec(ctx, `DELETE FROM task_collaborators WHERE account_id=$1 AND task_id=$2 AND user_id=$3`, t.AccountID, t.ID, t.AssignedTo); err != nil {
		return err
	}
	if t.ParentTaskID == nil && t.ListID != nil {
		if _, err := tx.Exec(ctx, `
			UPDATE tasks child SET
				list_id=$3,
				status_id=COALESCE((
					SELECT target.id
					FROM task_statuses current_status
					JOIN task_lists target_list ON target_list.account_id=child.account_id AND target_list.id=$3
					JOIN task_statuses target ON target.account_id=target_list.account_id AND target.workflow_id=target_list.workflow_id AND target.category=current_status.category
					WHERE current_status.account_id=child.account_id AND current_status.id=child.status_id
					ORDER BY target.is_default DESC,target.sort_order LIMIT 1
				),(
					SELECT target.id FROM task_lists target_list
					JOIN task_statuses target ON target.account_id=target_list.account_id AND target.workflow_id=target_list.workflow_id
					WHERE target_list.account_id=child.account_id AND target_list.id=$3
					ORDER BY target.is_default DESC,target.sort_order LIMIT 1
				)),
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
	_, err := r.db.Exec(ctx, `
		UPDATE tasks SET status='completed',
			status_id=COALESCE((
				SELECT done.id FROM task_statuses current_status
				JOIN task_statuses done ON done.workflow_id=current_status.workflow_id
					AND done.account_id=current_status.account_id AND done.category='done'
				WHERE current_status.id=tasks.status_id AND current_status.account_id=tasks.account_id
				ORDER BY done.sort_order LIMIT 1
			), status_id),
			progress=100, completed_at=$1, completed_by=$2, updated_at=$1, version=COALESCE(version,1)+1
		WHERE id=$3 AND account_id=$4
	`, now, completedBy, id, accountID)
	return err
}

func (r *TaskRepository) RecurringOccurrenceExists(ctx context.Context, accountID, rootID uuid.UUID, dueAt time.Time) (bool, error) {
	var exists bool
	err := r.db.QueryRow(ctx, `SELECT EXISTS(
		SELECT 1 FROM tasks
		WHERE account_id=$1 AND recurrence_parent_id=$2 AND due_at=$3
	)`, accountID, rootID, dueAt).Scan(&exists)
	return exists, err
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

	if v, ok := filters["status"]; ok && v != "" {
		if _, err := uuid.Parse(v); err == nil {
			where = append(where, fmt.Sprintf("t.status_id=$%d", idx))
		} else if v == "overdue" {
			where = append(where, "t.due_at < NOW() AND COALESCE(ts.category,'not_started') NOT IN ('done','cancelled')")
			v = ""
		} else {
			where = append(where, fmt.Sprintf("t.status=$%d", idx))
		}
		if v != "" {
			args = append(args, v)
			idx++
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
	if v, ok := filters["type"]; ok && v != "" {
		where = append(where, fmt.Sprintf("t.type=$%d", idx))
		args = append(args, v)
		idx++
	}
	if v, ok := filters["assigned_to"]; ok && v != "" {
		where = append(where, fmt.Sprintf("t.assigned_to=$%d", idx))
		args = append(args, v)
		idx++
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
	if v, ok := filters["starred"]; ok && v == "true" {
		where = append(where, "t.starred = TRUE")
	}
	if v, ok := filters["from"]; ok && v != "" {
		where = append(where, fmt.Sprintf("t.due_at >= $%d", idx))
		args = append(args, v)
		idx++
	}
	if v, ok := filters["to"]; ok && v != "" {
		where = append(where, fmt.Sprintf("t.due_at <= $%d", idx))
		args = append(args, v)
		idx++
	}
	if v, ok := filters["search"]; ok && v != "" {
		where = append(where, fmt.Sprintf("t.title ILIKE $%d", idx))
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
			t.due_at ASC NULLS LAST
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
	`, rem.ID, rem.TaskID, rem.AccountID, rem.AssignedTo, rem.ReminderAt)
	return err
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
		SELECT tl.id, tl.account_id, tl.folder_id, tl.workflow_id, COALESCE(tl.workflow_inherited,TRUE), COALESCE(tl.is_default,FALSE), tl.name, COALESCE(tl.description,''), tl.color,
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
		if err := rows.Scan(&l.ID, &l.AccountID, &l.FolderID, &l.WorkflowID, &l.WorkflowInherited, &l.IsDefault, &l.Name, &l.Description, &l.Color,
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

	var maxOrder int
	_ = r.db.QueryRow(ctx, `SELECT COALESCE(MAX(sort_order), -1) FROM task_lists WHERE account_id=$1`, l.AccountID).Scan(&maxOrder)
	l.SortOrder = maxOrder + 1
	if l.FolderID != nil {
		var valid bool
		if err := r.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM task_folders WHERE account_id=$1 AND id=$2 AND archived_at IS NULL)`, l.AccountID, l.FolderID).Scan(&valid); err != nil || !valid {
			if err != nil {
				return err
			}
			return ErrTaskWorkNotFound
		}
	}

	if l.WorkflowID == nil {
		l.WorkflowInherited = true
		var workflowID uuid.UUID
		if l.FolderID != nil {
			if err := r.db.QueryRow(ctx, `SELECT workflow_id FROM task_folders WHERE account_id=$1 AND id=$2`, l.AccountID, l.FolderID).Scan(&workflowID); err != nil {
				return err
			}
		} else if err := r.db.QueryRow(ctx, `SELECT id FROM task_workflows WHERE account_id=$1 AND is_default LIMIT 1`, l.AccountID).Scan(&workflowID); err != nil {
			return err
		}
		l.WorkflowID = &workflowID
	}
	var validWorkflow bool
	if err := r.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM task_workflows WHERE account_id=$1 AND id=$2)`, l.AccountID, l.WorkflowID).Scan(&validWorkflow); err != nil || !validWorkflow {
		if err != nil {
			return err
		}
		return ErrTaskWorkNotFound
	}
	_, err := r.db.Exec(ctx, `
		INSERT INTO task_lists (id, account_id, folder_id, workflow_id, workflow_inherited, is_default, name, description, color, sort_order, created_by, created_at, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
	`, l.ID, l.AccountID, l.FolderID, l.WorkflowID, l.WorkflowInherited, l.IsDefault, l.Name, l.Description, l.Color, l.SortOrder, l.CreatedBy, l.CreatedAt, l.UpdatedAt)
	return err
}

func (r *TaskRepository) UpdateList(ctx context.Context, id, accountID uuid.UUID, name, color *string, sortOrder *int) error {
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
	// Lists are archived so their tasks, history and reporting context remain
	// intact. A future restore can simply clear archived_at.
	result, err := r.db.Exec(ctx, `UPDATE task_lists SET archived_at=NOW(), updated_at=NOW() WHERE id=$1 AND account_id=$2 AND NOT is_default`, id, accountID)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		var isDefault bool
		if err := r.db.QueryRow(ctx, `SELECT is_default FROM task_lists WHERE id=$1 AND account_id=$2`, id, accountID).Scan(&isDefault); err != nil {
			return err
		}
		if isDefault {
			return ErrDefaultTaskList
		}
	}
	return nil
}

func (r *TaskRepository) ToggleStar(ctx context.Context, id, accountID uuid.UUID) (bool, error) {
	var starred bool
	err := r.db.QueryRow(ctx, `
		UPDATE tasks SET starred = NOT COALESCE(starred, FALSE), updated_at=NOW()
		WHERE id=$1 AND account_id=$2
		RETURNING starred
	`, id, accountID).Scan(&starred)
	return starred, err
}

func (r *TaskRepository) ReorderTasks(ctx context.Context, accountID uuid.UUID, taskIDs []uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	for i, id := range taskIDs {
		_, err := tx.Exec(ctx, `UPDATE tasks SET sort_order=$1, updated_at=NOW() WHERE id=$2 AND account_id=$3`, i, id, accountID)
		if err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
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
