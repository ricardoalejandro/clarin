package repository

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
)

type TaskRepository struct {
	db *pgxpool.Pool
}

const taskSelectFields = `
	t.id, t.account_id, t.created_by, t.assigned_to, t.title, t.description, t.type,
	t.due_at, t.due_end_at, t.priority, t.status, t.completed_at, t.completed_by,
	t.lead_id, t.event_id, t.program_id, t.contact_id, t.list_id,
	COALESCE(t.starred, FALSE) AS starred, COALESCE(t.sort_order, 0) AS sort_order,
	t.recurrence_rule, t.recurrence_parent_id, t.reminder_minutes,
	t.notes, t.created_at, t.updated_at,
	COALESCE(ua.display_name, ua.username, '') AS assigned_to_name,
	COALESCE(uc.display_name, uc.username, '') AS created_by_name,
	COALESCE(lc.custom_name, lc.name, l.name, '') AS lead_name,
	COALESCE(e.name, '') AS event_name,
	COALESCE(p.name, '') AS program_name,
	COALESCE(ct.custom_name, ct.name, ct.push_name, '') AS contact_name,
	COALESCE(tl.name, '') AS list_name,
	COALESCE((SELECT COUNT(*) FROM subtasks st WHERE st.task_id = t.id), 0) AS subtask_count,
	COALESCE((SELECT COUNT(*) FROM subtasks st WHERE st.task_id = t.id AND st.completed = TRUE), 0) AS subtask_done
`

const taskJoins = `
	LEFT JOIN users ua ON ua.id = t.assigned_to
	LEFT JOIN users uc ON uc.id = t.created_by
	LEFT JOIN leads l ON l.id = t.lead_id
	LEFT JOIN contacts lc ON lc.id = l.contact_id
	LEFT JOIN events e ON e.id = t.event_id
	LEFT JOIN programs p ON p.id = t.program_id
	LEFT JOIN contacts ct ON ct.id = t.contact_id
	LEFT JOIN task_lists tl ON tl.id = t.list_id
`

func (r *TaskRepository) scanTask(row interface{ Scan(dest ...interface{}) error }) (*domain.Task, error) {
	t := &domain.Task{}
	err := row.Scan(
		&t.ID, &t.AccountID, &t.CreatedBy, &t.AssignedTo, &t.Title, &t.Description, &t.Type,
		&t.DueAt, &t.DueEndAt, &t.Priority, &t.Status, &t.CompletedAt, &t.CompletedBy,
		&t.LeadID, &t.EventID, &t.ProgramID, &t.ContactID, &t.ListID,
		&t.Starred, &t.SortOrder,
		&t.RecurrenceRule, &t.RecurrenceParentID, &t.ReminderMinutes,
		&t.Notes, &t.CreatedAt, &t.UpdatedAt,
		&t.AssignedToName, &t.CreatedByName, &t.LeadName, &t.EventName, &t.ProgramName, &t.ContactName,
		&t.ListName,
		&t.SubtaskCount, &t.SubtaskDone,
	)
	return t, err
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
			due_at, due_end_at, priority, status, lead_id, event_id, program_id, contact_id, list_id,
			starred, sort_order, recurrence_rule, recurrence_parent_id, reminder_minutes, notes, created_at, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
	`, t.ID, t.AccountID, t.CreatedBy, t.AssignedTo, t.Title, t.Description, t.Type,
		t.DueAt, t.DueEndAt, t.Priority, t.Status, t.LeadID, t.EventID, t.ProgramID, t.ContactID, t.ListID,
		t.Starred, t.SortOrder, t.RecurrenceRule, t.RecurrenceParentID, t.ReminderMinutes, t.Notes, t.CreatedAt, t.UpdatedAt,
	)
	return err
}

func (r *TaskRepository) Update(ctx context.Context, t *domain.Task) error {
	t.UpdatedAt = time.Now()
	_, err := r.db.Exec(ctx, `
		UPDATE tasks SET
			assigned_to=$1, title=$2, description=$3, type=$4,
			due_at=$5, due_end_at=$6, priority=$7, status=$8,
			lead_id=$9, event_id=$10, program_id=$11, contact_id=$12,
			list_id=$13, starred=$14, sort_order=$15, recurrence_rule=$16, reminder_minutes=$17, notes=$18, updated_at=$19
		WHERE id=$20 AND account_id=$21
	`, t.AssignedTo, t.Title, t.Description, t.Type,
		t.DueAt, t.DueEndAt, t.Priority, t.Status,
		t.LeadID, t.EventID, t.ProgramID, t.ContactID,
		t.ListID, t.Starred, t.SortOrder, t.RecurrenceRule, t.ReminderMinutes, t.Notes, t.UpdatedAt,
		t.ID, t.AccountID,
	)
	return err
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
		UPDATE tasks SET status='completed', completed_at=$1, completed_by=$2, updated_at=$1
		WHERE id=$3 AND account_id=$4
	`, now, completedBy, id, accountID)
	return err
}

// GetByAccount returns tasks for an account with optional filters
func (r *TaskRepository) GetByAccount(ctx context.Context, accountID uuid.UUID, filters map[string]string, limit, offset int) ([]*domain.Task, int, error) {
	where := []string{"t.account_id=$1"}
	args := []interface{}{accountID}
	idx := 2

	if v, ok := filters["status"]; ok && v != "" {
		where = append(where, fmt.Sprintf("t.status=$%d", idx))
		args = append(args, v)
		idx++
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
	countSQL := fmt.Sprintf("SELECT COUNT(*) FROM tasks t WHERE %s", whereClause)
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
		WHERE t.account_id=$1 AND t.due_at >= $2 AND t.due_at <= $3
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
		SELECT status, COUNT(*) FROM tasks
		WHERE account_id=$1 AND assigned_to=$2
		GROUP BY status
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
		SELECT COUNT(*) FROM tasks
		WHERE account_id=$1 AND assigned_to=$2 AND status='pending'
		AND due_at IS NOT NULL AND due_at >= CURRENT_DATE AND due_at < CURRENT_DATE + INTERVAL '1 day'
	`, accountID, assignedTo).Scan(&todayCount)
	stats["today"] = todayCount

	return stats, nil
}

// MarkOverdue marks pending tasks past their due date as overdue
func (r *TaskRepository) MarkOverdue(ctx context.Context) ([]domain.Task, error) {
	rows, err := r.db.Query(ctx, `
		UPDATE tasks SET status='overdue', updated_at=NOW()
		WHERE status='pending' AND due_at IS NOT NULL AND due_at < NOW()
		RETURNING id, account_id, assigned_to, title, type, due_at
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
	err := r.db.QueryRow(ctx, `SELECT title, type, due_at FROM tasks WHERE id=$1`, taskID).Scan(&title, &taskType, &dueAt)
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
		SELECT tl.id, tl.account_id, tl.name, tl.color, tl.sort_order, tl.created_by, tl.created_at, tl.updated_at,
			COALESCE((SELECT COUNT(*) FROM tasks t WHERE t.list_id = tl.id AND t.status NOT IN ('completed','cancelled')), 0) AS task_count
		FROM task_lists tl
		WHERE tl.account_id=$1
		ORDER BY tl.sort_order, tl.created_at
	`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var lists []*domain.TaskList
	for rows.Next() {
		l := &domain.TaskList{}
		if err := rows.Scan(&l.ID, &l.AccountID, &l.Name, &l.Color, &l.SortOrder, &l.CreatedBy, &l.CreatedAt, &l.UpdatedAt, &l.TaskCount); err != nil {
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

	var maxOrder int
	_ = r.db.QueryRow(ctx, `SELECT COALESCE(MAX(sort_order), -1) FROM task_lists WHERE account_id=$1`, l.AccountID).Scan(&maxOrder)
	l.SortOrder = maxOrder + 1

	_, err := r.db.Exec(ctx, `
		INSERT INTO task_lists (id, account_id, name, color, sort_order, created_by, created_at, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
	`, l.ID, l.AccountID, l.Name, l.Color, l.SortOrder, l.CreatedBy, l.CreatedAt, l.UpdatedAt)
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
	// Unlink tasks from this list first (set list_id = NULL)
	_, _ = r.db.Exec(ctx, `UPDATE tasks SET list_id=NULL, updated_at=NOW() WHERE list_id=$1 AND account_id=$2`, id, accountID)
	_, err := r.db.Exec(ctx, `DELETE FROM task_lists WHERE id=$1 AND account_id=$2`, id, accountID)
	return err
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
