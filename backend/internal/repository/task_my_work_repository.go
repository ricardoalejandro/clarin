package repository

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

const (
	taskMyWorkPositionStep = int64(1024)
	TaskMyWorkMaxItems     = 200
)

var (
	ErrTaskMyWorkDateChanged      = errors.New("task my work business date changed")
	ErrTaskMyWorkRevisionConflict = errors.New("task my work revision changed concurrently")
	ErrTaskMyWorkLimitReached     = errors.New("task my work daily limit reached")
	ErrTaskMyWorkInvalid          = errors.New("task my work mutation is invalid")
)

var taskMyWorkLocation = func() *time.Location {
	location, err := time.LoadLocation("America/Lima")
	if err == nil {
		return location
	}
	return time.FixedZone("America/Lima", -5*60*60)
}()

type TaskMyWorkClock struct {
	BusinessDate string    `json:"business_date"`
	Timezone     string    `json:"timezone"`
	ResetAt      time.Time `json:"reset_at"`
	date         time.Time
}

func CurrentTaskMyWorkClock(now time.Time) TaskMyWorkClock {
	local := now.In(taskMyWorkLocation)
	date := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, taskMyWorkLocation)
	return TaskMyWorkClock{
		BusinessDate: date.Format("2006-01-02"),
		Timezone:     "America/Lima",
		ResetAt:      date.AddDate(0, 0, 1),
		date:         date,
	}
}

type TaskMyWorkSummary struct {
	TaskMyWorkClock
	Revision              int64 `json:"revision"`
	FocusCount            int   `json:"focus_count"`
	CompletedCount        int   `json:"completed_count"`
	SuggestionCount       int   `json:"suggestion_count"`
	OverdueSuggestion     int   `json:"overdue_suggestion_count"`
	DueTodaySuggestion    int   `json:"due_today_suggestion_count"`
	PreviousSuggestion    int   `json:"previous_suggestion_count"`
	MaximumDailyTaskCount int   `json:"maximum_daily_task_count"`
}

type TaskMyWorkItem struct {
	Task     *domain.Task `json:"task"`
	Position int64        `json:"position"`
	AddedAt  time.Time    `json:"added_at"`
}

type TaskMyWorkSuggestion struct {
	Task    *domain.Task `json:"task"`
	Reasons []string     `json:"reasons"`
}

type TaskMyWorkFocusCursor struct {
	Position int64
	TaskID   uuid.UUID
}

type TaskMyWorkSuggestionCursor struct {
	ReasonRank   int
	PriorityRank int
	DueNullRank  int
	DueAt        time.Time
	TaskID       uuid.UUID
}

type TaskMyWorkMutationResult struct {
	BusinessDate   string      `json:"business_date"`
	Revision       int64       `json:"revision"`
	OrderedTaskIDs []uuid.UUID `json:"ordered_task_ids"`
	FocusCount     int         `json:"focus_count"`
	CompletedCount int         `json:"completed_count"`
	OperationID    uuid.UUID   `json:"operation_id"`
	Idempotent     bool        `json:"idempotent"`
}

type taskMyWorkCandidate struct {
	ID           uuid.UUID
	Overdue      bool
	DueToday     bool
	Previous     bool
	ReasonRank   int
	PriorityRank int
	DueAt        *time.Time
}

type taskMyWorkPosition struct {
	ID       uuid.UUID
	Position int64
	AddedAt  time.Time
}

func TaskMyWorkTaskIsClosed(task *domain.Task) bool {
	if task == nil {
		return false
	}
	if task.StatusDetail != nil {
		return task.StatusDetail.Category == domain.TaskStatusCategoryDone || task.StatusDetail.Category == domain.TaskStatusCategoryCancelled
	}
	return task.Status == domain.TaskStatusCompleted || task.Status == domain.TaskStatusCancelled
}

func (r *TaskWorkRepository) TaskMyWorkSummary(ctx context.Context, accountID, actorID uuid.UUID, now time.Time) (*TaskMyWorkSummary, error) {
	clock := CurrentTaskMyWorkClock(now)
	summary := &TaskMyWorkSummary{TaskMyWorkClock: clock, MaximumDailyTaskCount: TaskMyWorkMaxItems}
	if err := r.db.QueryRow(ctx, `SELECT COALESCE((SELECT revision FROM task_focus_days
		WHERE account_id=$1 AND user_id=$2 AND focus_date=$3::date),0)`, accountID, actorID, clock.BusinessDate).Scan(&summary.Revision); err != nil {
		return nil, err
	}
	effectiveCategory := taskEffectiveCategorySQL("task", "status_item")
	countSQL := `SELECT
		COUNT(*) FILTER (WHERE ` + effectiveCategory + ` NOT IN ('done','cancelled')),
		COUNT(*) FILTER (WHERE ` + effectiveCategory + ` IN ('done','cancelled'))
	FROM task_focus_items focus_item
	JOIN tasks task ON task.account_id=focus_item.account_id AND task.id=focus_item.task_id AND task.deleted_at IS NULL
	JOIN task_lists list_item ON list_item.account_id=task.account_id AND list_item.id=task.list_id
	LEFT JOIN task_statuses status_item ON status_item.account_id=task.account_id AND status_item.id=task.status_id
	WHERE focus_item.account_id=$1 AND focus_item.user_id=$2 AND focus_item.focus_date=$3::date
	  AND ` + taskActorCanViewSQL("task", "list_item", "$2")
	if err := r.db.QueryRow(ctx, countSQL, accountID, actorID, clock.BusinessDate).Scan(&summary.FocusCount, &summary.CompletedCount); err != nil {
		return nil, err
	}
	if err := r.taskMyWorkSuggestionCounts(ctx, accountID, actorID, clock, summary); err != nil {
		return nil, err
	}
	return summary, nil
}

func (r *TaskWorkRepository) taskMyWorkSuggestionCounts(ctx context.Context, accountID, actorID uuid.UUID, clock TaskMyWorkClock, summary *TaskMyWorkSummary) error {
	query := taskMyWorkSuggestionCTE() + `
	SELECT COUNT(*),COUNT(*) FILTER (WHERE is_overdue),COUNT(*) FILTER (WHERE is_due_today),COUNT(*) FILTER (WHERE is_previous)
	FROM ranked`
	return r.db.QueryRow(ctx, query, accountID, actorID, clock.BusinessDate).Scan(
		&summary.SuggestionCount, &summary.OverdueSuggestion, &summary.DueTodaySuggestion, &summary.PreviousSuggestion,
	)
}

func taskMyWorkSuggestionCTE() string {
	effectiveCategory := taskEffectiveCategorySQL("task", "status_item")
	localDue := "(task.due_at AT TIME ZONE 'America/Lima')::date"
	isOverdue := "(task.assigned_to=$2 AND task.due_at IS NOT NULL AND " + localDue + " < $3::date)"
	isDueToday := "(task.assigned_to=$2 AND task.due_at IS NOT NULL AND " + localDue + " = $3::date)"
	isPrevious := `EXISTS(SELECT 1 FROM task_focus_items previous_item
		WHERE previous_item.account_id=task.account_id AND previous_item.user_id=$2
		  AND previous_item.focus_date=(SELECT focus_date FROM latest_previous) AND previous_item.task_id=task.id)`
	return `WITH latest_previous AS (
		SELECT MAX(focus_date) AS focus_date FROM task_focus_days
		WHERE account_id=$1 AND user_id=$2 AND focus_date < $3::date
	), ranked AS (
		SELECT task.id,task.due_at,` + isOverdue + ` AS is_overdue,` + isDueToday + ` AS is_due_today,` + isPrevious + ` AS is_previous,
			CASE WHEN ` + isOverdue + ` THEN 0 WHEN ` + isDueToday + ` THEN 1 ELSE 2 END AS reason_rank,
			CASE task.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END AS priority_rank,
			CASE WHEN task.due_at IS NULL THEN 1 ELSE 0 END AS due_null_rank
		FROM tasks task
		JOIN task_lists list_item ON list_item.account_id=task.account_id AND list_item.id=task.list_id
		LEFT JOIN task_statuses status_item ON status_item.account_id=task.account_id AND status_item.id=task.status_id
		WHERE task.account_id=$1 AND task.deleted_at IS NULL
		  AND ` + effectiveCategory + ` NOT IN ('done','cancelled')
		  AND ` + taskActorCanViewSQL("task", "list_item", "$2") + `
		  AND NOT EXISTS(SELECT 1 FROM task_focus_items current_item
			WHERE current_item.account_id=task.account_id AND current_item.user_id=$2
			  AND current_item.focus_date=$3::date AND current_item.task_id=task.id)
		  AND (` + isOverdue + ` OR ` + isDueToday + ` OR ` + isPrevious + `)
	)`
}

func (r *TaskWorkRepository) ListTaskMyWorkFocus(ctx context.Context, accountID, actorID uuid.UUID, now time.Time, limit int, cursor *TaskMyWorkFocusCursor) ([]*TaskMyWorkItem, *TaskMyWorkFocusCursor, error) {
	clock := CurrentTaskMyWorkClock(now)
	if limit < 1 {
		limit = 50
	}
	if limit > TaskMyWorkMaxItems {
		limit = TaskMyWorkMaxItems
	}
	args := []any{accountID, actorID, clock.BusinessDate}
	cursorSQL := ""
	if cursor != nil {
		cursorSQL = ` AND (focus_item.position,focus_item.task_id) > ($4::bigint,$5::uuid)`
		args = append(args, cursor.Position, cursor.TaskID)
	}
	args = append(args, limit+1)
	query := `SELECT focus_item.task_id,focus_item.position,focus_item.added_at
	FROM task_focus_items focus_item
	JOIN tasks task ON task.account_id=focus_item.account_id AND task.id=focus_item.task_id AND task.deleted_at IS NULL
	JOIN task_lists list_item ON list_item.account_id=task.account_id AND list_item.id=task.list_id
	WHERE focus_item.account_id=$1 AND focus_item.user_id=$2 AND focus_item.focus_date=$3::date
	  AND ` + taskActorCanViewSQL("task", "list_item", "$2") + cursorSQL + `
	ORDER BY focus_item.position,focus_item.task_id LIMIT $` + fmt.Sprint(len(args))
	rows, err := r.db.Query(ctx, query, args...)
	if err != nil {
		return nil, nil, err
	}
	positions := make([]taskMyWorkPosition, 0, limit+1)
	for rows.Next() {
		var item taskMyWorkPosition
		if err := rows.Scan(&item.ID, &item.Position, &item.AddedAt); err != nil {
			rows.Close()
			return nil, nil, err
		}
		positions = append(positions, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, nil, err
	}
	rows.Close()
	var next *TaskMyWorkFocusCursor
	if len(positions) > limit {
		positions = positions[:limit]
		last := positions[len(positions)-1]
		next = &TaskMyWorkFocusCursor{Position: last.Position, TaskID: last.ID}
	}
	ids := make([]uuid.UUID, 0, len(positions))
	for _, item := range positions {
		ids = append(ids, item.ID)
	}
	tasks, err := r.loadTaskMyWorkTasks(ctx, accountID, actorID, ids)
	if err != nil {
		return nil, nil, err
	}
	items := make([]*TaskMyWorkItem, 0, len(positions))
	for _, position := range positions {
		if task := tasks[position.ID]; task != nil {
			items = append(items, &TaskMyWorkItem{Task: task, Position: position.Position, AddedAt: position.AddedAt})
		}
	}
	return items, next, nil
}

func (r *TaskWorkRepository) ListTaskMyWorkSuggestions(ctx context.Context, accountID, actorID uuid.UUID, now time.Time, limit int, cursor *TaskMyWorkSuggestionCursor) ([]*TaskMyWorkSuggestion, *TaskMyWorkSuggestionCursor, error) {
	clock := CurrentTaskMyWorkClock(now)
	if limit < 1 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	args := []any{accountID, actorID, clock.BusinessDate}
	cursorSQL := ""
	if cursor != nil {
		cursorSQL = ` WHERE (reason_rank,priority_rank,due_null_rank,COALESCE(due_at,'1970-01-01'::timestamptz),id)
			> ($4::int,$5::int,$6::int,$7::timestamptz,$8::uuid)`
		args = append(args, cursor.ReasonRank, cursor.PriorityRank, cursor.DueNullRank, cursor.DueAt, cursor.TaskID)
	}
	args = append(args, limit+1)
	query := taskMyWorkSuggestionCTE() + `
	SELECT id,is_overdue,is_due_today,is_previous,reason_rank,priority_rank,due_at
	FROM ranked` + cursorSQL + `
	ORDER BY reason_rank,priority_rank,due_null_rank,due_at ASC NULLS LAST,id
	LIMIT $` + fmt.Sprint(len(args))
	rows, err := r.db.Query(ctx, query, args...)
	if err != nil {
		return nil, nil, err
	}
	candidates := make([]taskMyWorkCandidate, 0, limit+1)
	for rows.Next() {
		var candidate taskMyWorkCandidate
		if err := rows.Scan(&candidate.ID, &candidate.Overdue, &candidate.DueToday, &candidate.Previous, &candidate.ReasonRank, &candidate.PriorityRank, &candidate.DueAt); err != nil {
			rows.Close()
			return nil, nil, err
		}
		candidates = append(candidates, candidate)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, nil, err
	}
	rows.Close()
	var next *TaskMyWorkSuggestionCursor
	if len(candidates) > limit {
		candidates = candidates[:limit]
		last := candidates[len(candidates)-1]
		dueAt := time.Unix(0, 0).UTC()
		dueNullRank := 1
		if last.DueAt != nil {
			dueAt = last.DueAt.UTC()
			dueNullRank = 0
		}
		next = &TaskMyWorkSuggestionCursor{ReasonRank: last.ReasonRank, PriorityRank: last.PriorityRank, DueNullRank: dueNullRank, DueAt: dueAt, TaskID: last.ID}
	}
	ids := make([]uuid.UUID, 0, len(candidates))
	for _, candidate := range candidates {
		ids = append(ids, candidate.ID)
	}
	tasks, err := r.loadTaskMyWorkTasks(ctx, accountID, actorID, ids)
	if err != nil {
		return nil, nil, err
	}
	result := make([]*TaskMyWorkSuggestion, 0, len(candidates))
	for _, candidate := range candidates {
		task := tasks[candidate.ID]
		if task == nil {
			continue
		}
		reasons := make([]string, 0, 3)
		if candidate.Overdue {
			reasons = append(reasons, "overdue")
		}
		if candidate.DueToday {
			reasons = append(reasons, "due_today")
		}
		if candidate.Previous {
			reasons = append(reasons, "previous_focus")
		}
		result = append(result, &TaskMyWorkSuggestion{Task: task, Reasons: reasons})
	}
	return result, next, nil
}

func (r *TaskWorkRepository) loadTaskMyWorkTasks(ctx context.Context, accountID, actorID uuid.UUID, ids []uuid.UUID) (map[uuid.UUID]*domain.Task, error) {
	result := make(map[uuid.UUID]*domain.Task, len(ids))
	if len(ids) == 0 {
		return result, nil
	}
	query := `SELECT ` + taskSelectFields + ` FROM tasks t ` + taskJoins + `
		WHERE t.account_id=$1 AND t.id=ANY($3::uuid[]) AND t.deleted_at IS NULL
		  AND ` + taskActorCanViewSQL("t", "tl", "$2")
	rows, err := r.db.Query(ctx, query, accountID, actorID, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	scanner := &TaskRepository{}
	for rows.Next() {
		task, err := scanner.scanTask(rows)
		if err != nil {
			return nil, err
		}
		result[task.ID] = task
	}
	return result, rows.Err()
}

func (r *TaskWorkRepository) AddTaskMyWorkItem(ctx context.Context, accountID, actorID, taskID uuid.UUID, businessDate string, expectedRevision int64, operationID uuid.UUID, now time.Time) (*TaskMyWorkMutationResult, error) {
	clock := CurrentTaskMyWorkClock(now)
	if businessDate != clock.BusinessDate || operationID == uuid.Nil {
		if businessDate != clock.BusinessDate {
			return nil, ErrTaskMyWorkDateChanged
		}
		return nil, ErrTaskMyWorkInvalid
	}
	tx, err := r.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	revision, idempotent, err := taskMyWorkLockDay(ctx, tx, accountID, actorID, clock, expectedRevision, operationID)
	if err != nil {
		return nil, err
	}
	if idempotent {
		return taskMyWorkMutationResultTx(ctx, tx, accountID, actorID, clock, revision, operationID, true)
	}
	var closed bool
	query := `SELECT (` + taskEffectiveCategorySQL("task", "status_item") + ` IN ('done','cancelled'))
		FROM tasks task
		JOIN task_lists list_item ON list_item.account_id=task.account_id AND list_item.id=task.list_id
		LEFT JOIN task_statuses status_item ON status_item.account_id=task.account_id AND status_item.id=task.status_id
		WHERE task.account_id=$1 AND task.id=$2 AND task.deleted_at IS NULL
		  AND ` + taskActorCanViewSQL("task", "list_item", "$3")
	if err := tx.QueryRow(ctx, query, accountID, taskID, actorID).Scan(&closed); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrTaskWorkNotFound
		}
		return nil, err
	}
	if closed {
		return nil, ErrTaskMyWorkInvalid
	}
	var itemCount int
	if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM task_focus_items
		WHERE account_id=$1 AND user_id=$2 AND focus_date=$3::date`, accountID, actorID, clock.BusinessDate).Scan(&itemCount); err != nil {
		return nil, err
	}
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM task_focus_items
		WHERE account_id=$1 AND user_id=$2 AND focus_date=$3::date AND task_id=$4)`, accountID, actorID, clock.BusinessDate, taskID).Scan(&exists); err != nil {
		return nil, err
	}
	if !exists && itemCount >= TaskMyWorkMaxItems {
		return nil, ErrTaskMyWorkLimitReached
	}
	changed := false
	if !exists {
		var position int64
		if err := tx.QueryRow(ctx, `SELECT COALESCE(MAX(position),0)+$4::bigint FROM task_focus_items
			WHERE account_id=$1 AND user_id=$2 AND focus_date=$3::date`, accountID, actorID, clock.BusinessDate, taskMyWorkPositionStep).Scan(&position); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO task_focus_items(account_id,user_id,focus_date,task_id,position)
			VALUES($1,$2,$3::date,$4,$5)`, accountID, actorID, clock.BusinessDate, taskID, position); err != nil {
			return nil, err
		}
		changed = true
	}
	if changed {
		revision++
		if _, err := tx.Exec(ctx, `UPDATE task_focus_days SET revision=$4,updated_at=NOW()
			WHERE account_id=$1 AND user_id=$2 AND focus_date=$3::date`, accountID, actorID, clock.BusinessDate, revision); err != nil {
			return nil, err
		}
	}
	if err := taskMyWorkRecordOperation(ctx, tx, accountID, actorID, clock, operationID, "add", revision); err != nil {
		return nil, err
	}
	result, err := taskMyWorkMutationResultTx(ctx, tx, accountID, actorID, clock, revision, operationID, false)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return result, nil
}

func (r *TaskWorkRepository) RemoveTaskMyWorkItem(ctx context.Context, accountID, actorID, taskID uuid.UUID, businessDate string, expectedRevision int64, operationID uuid.UUID, now time.Time) (*TaskMyWorkMutationResult, error) {
	clock := CurrentTaskMyWorkClock(now)
	if businessDate != clock.BusinessDate || operationID == uuid.Nil {
		if businessDate != clock.BusinessDate {
			return nil, ErrTaskMyWorkDateChanged
		}
		return nil, ErrTaskMyWorkInvalid
	}
	tx, err := r.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	revision, idempotent, err := taskMyWorkLockDay(ctx, tx, accountID, actorID, clock, expectedRevision, operationID)
	if err != nil {
		return nil, err
	}
	if idempotent {
		return taskMyWorkMutationResultTx(ctx, tx, accountID, actorID, clock, revision, operationID, true)
	}
	result, err := tx.Exec(ctx, `DELETE FROM task_focus_items
		WHERE account_id=$1 AND user_id=$2 AND focus_date=$3::date AND task_id=$4`, accountID, actorID, clock.BusinessDate, taskID)
	if err != nil {
		return nil, err
	}
	if result.RowsAffected() > 0 {
		revision++
		if _, err := tx.Exec(ctx, `UPDATE task_focus_days SET revision=$4,updated_at=NOW()
			WHERE account_id=$1 AND user_id=$2 AND focus_date=$3::date`, accountID, actorID, clock.BusinessDate, revision); err != nil {
			return nil, err
		}
	}
	if err := taskMyWorkRecordOperation(ctx, tx, accountID, actorID, clock, operationID, "remove", revision); err != nil {
		return nil, err
	}
	mutation, err := taskMyWorkMutationResultTx(ctx, tx, accountID, actorID, clock, revision, operationID, false)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return mutation, nil
}

func (r *TaskWorkRepository) ReorderTaskMyWorkItem(ctx context.Context, accountID, actorID, taskID uuid.UUID, beforeTaskID *uuid.UUID, businessDate string, expectedRevision int64, operationID uuid.UUID, now time.Time) (*TaskMyWorkMutationResult, error) {
	clock := CurrentTaskMyWorkClock(now)
	if businessDate != clock.BusinessDate || operationID == uuid.Nil || (beforeTaskID != nil && *beforeTaskID == taskID) {
		if businessDate != clock.BusinessDate {
			return nil, ErrTaskMyWorkDateChanged
		}
		return nil, ErrTaskMyWorkInvalid
	}
	tx, err := r.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	revision, idempotent, err := taskMyWorkLockDay(ctx, tx, accountID, actorID, clock, expectedRevision, operationID)
	if err != nil {
		return nil, err
	}
	if idempotent {
		return taskMyWorkMutationResultTx(ctx, tx, accountID, actorID, clock, revision, operationID, true)
	}
	rows, err := tx.Query(ctx, `SELECT task_id,position FROM task_focus_items
		WHERE account_id=$1 AND user_id=$2 AND focus_date=$3::date ORDER BY position,task_id FOR UPDATE`, accountID, actorID, clock.BusinessDate)
	if err != nil {
		return nil, err
	}
	positions := make([]taskMyWorkPosition, 0, TaskMyWorkMaxItems)
	for rows.Next() {
		var item taskMyWorkPosition
		if err := rows.Scan(&item.ID, &item.Position); err != nil {
			rows.Close()
			return nil, err
		}
		positions = append(positions, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	desired, changed, err := reorderTaskMyWorkPositions(positions, taskID, beforeTaskID)
	if err != nil {
		return nil, err
	}
	if changed {
		targetIndex := -1
		for index := range desired {
			if desired[index].ID == taskID {
				targetIndex = index
				break
			}
		}
		position, normalize := taskMyWorkMovedPosition(desired, targetIndex)
		if normalize {
			ids := make([]uuid.UUID, len(desired))
			values := make([]int64, len(desired))
			for index := range desired {
				ids[index] = desired[index].ID
				values[index] = int64(index+1) * taskMyWorkPositionStep
			}
			if _, err := tx.Exec(ctx, `UPDATE task_focus_items focus_item SET position=ordered.position
				FROM unnest($4::uuid[],$5::bigint[]) AS ordered(task_id,position)
				WHERE focus_item.account_id=$1 AND focus_item.user_id=$2 AND focus_item.focus_date=$3::date
				  AND focus_item.task_id=ordered.task_id`, accountID, actorID, clock.BusinessDate, ids, values); err != nil {
				return nil, err
			}
		} else if _, err := tx.Exec(ctx, `UPDATE task_focus_items SET position=$5
			WHERE account_id=$1 AND user_id=$2 AND focus_date=$3::date AND task_id=$4`, accountID, actorID, clock.BusinessDate, taskID, position); err != nil {
			return nil, err
		}
		revision++
		if _, err := tx.Exec(ctx, `UPDATE task_focus_days SET revision=$4,updated_at=NOW()
			WHERE account_id=$1 AND user_id=$2 AND focus_date=$3::date`, accountID, actorID, clock.BusinessDate, revision); err != nil {
			return nil, err
		}
	}
	if err := taskMyWorkRecordOperation(ctx, tx, accountID, actorID, clock, operationID, "reorder", revision); err != nil {
		return nil, err
	}
	mutation, err := taskMyWorkMutationResultTx(ctx, tx, accountID, actorID, clock, revision, operationID, false)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return mutation, nil
}

func taskMyWorkLockDay(ctx context.Context, tx pgx.Tx, accountID, actorID uuid.UUID, clock TaskMyWorkClock, expectedRevision int64, operationID uuid.UUID) (int64, bool, error) {
	if expectedRevision < 0 {
		return 0, false, ErrTaskMyWorkInvalid
	}
	if _, err := tx.Exec(ctx, `INSERT INTO task_focus_days(account_id,user_id,focus_date)
		VALUES($1,$2,$3::date) ON CONFLICT (account_id,user_id,focus_date) DO NOTHING`, accountID, actorID, clock.BusinessDate); err != nil {
		return 0, false, err
	}
	var revision int64
	if err := tx.QueryRow(ctx, `SELECT revision FROM task_focus_days
		WHERE account_id=$1 AND user_id=$2 AND focus_date=$3::date FOR UPDATE`, accountID, actorID, clock.BusinessDate).Scan(&revision); err != nil {
		return 0, false, err
	}
	var previousRevision int64
	err := tx.QueryRow(ctx, `SELECT result_revision FROM task_focus_operations
		WHERE account_id=$1 AND user_id=$2 AND focus_date=$3::date AND operation_id=$4`, accountID, actorID, clock.BusinessDate, operationID).Scan(&previousRevision)
	if err == nil {
		return revision, true, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return 0, false, err
	}
	if revision != expectedRevision {
		return revision, false, ErrTaskMyWorkRevisionConflict
	}
	return revision, false, nil
}

func taskMyWorkRecordOperation(ctx context.Context, tx pgx.Tx, accountID, actorID uuid.UUID, clock TaskMyWorkClock, operationID uuid.UUID, action string, revision int64) error {
	_, err := tx.Exec(ctx, `INSERT INTO task_focus_operations(account_id,user_id,focus_date,operation_id,action,result_revision)
		VALUES($1,$2,$3::date,$4,$5,$6)`, accountID, actorID, clock.BusinessDate, operationID, action, revision)
	return err
}

func taskMyWorkMutationResultTx(ctx context.Context, tx pgx.Tx, accountID, actorID uuid.UUID, clock TaskMyWorkClock, revision int64, operationID uuid.UUID, idempotent bool) (*TaskMyWorkMutationResult, error) {
	effectiveCategory := taskEffectiveCategorySQL("task", "status_item")
	query := `SELECT focus_item.task_id,(` + effectiveCategory + ` IN ('done','cancelled'))
	FROM task_focus_items focus_item
	JOIN tasks task ON task.account_id=focus_item.account_id AND task.id=focus_item.task_id AND task.deleted_at IS NULL
	JOIN task_lists list_item ON list_item.account_id=task.account_id AND list_item.id=task.list_id
	LEFT JOIN task_statuses status_item ON status_item.account_id=task.account_id AND status_item.id=task.status_id
	WHERE focus_item.account_id=$1 AND focus_item.user_id=$2 AND focus_item.focus_date=$3::date
	  AND ` + taskActorCanViewSQL("task", "list_item", "$2") + `
	ORDER BY focus_item.position,focus_item.task_id`
	rows, err := tx.Query(ctx, query, accountID, actorID, clock.BusinessDate)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := &TaskMyWorkMutationResult{BusinessDate: clock.BusinessDate, Revision: revision, OperationID: operationID, Idempotent: idempotent, OrderedTaskIDs: []uuid.UUID{}}
	for rows.Next() {
		var taskID uuid.UUID
		var closed bool
		if err := rows.Scan(&taskID, &closed); err != nil {
			return nil, err
		}
		result.OrderedTaskIDs = append(result.OrderedTaskIDs, taskID)
		if closed {
			result.CompletedCount++
		} else {
			result.FocusCount++
		}
	}
	return result, rows.Err()
}

func reorderTaskMyWorkPositions(current []taskMyWorkPosition, taskID uuid.UUID, beforeTaskID *uuid.UUID) ([]taskMyWorkPosition, bool, error) {
	if len(current) == 0 {
		return nil, false, ErrTaskMyWorkInvalid
	}
	movingIndex := -1
	for index := range current {
		if current[index].ID == taskID {
			movingIndex = index
			break
		}
	}
	if movingIndex < 0 {
		return nil, false, ErrTaskWorkNotFound
	}
	moving := current[movingIndex]
	base := append([]taskMyWorkPosition{}, current[:movingIndex]...)
	base = append(base, current[movingIndex+1:]...)
	insertAt := len(base)
	if beforeTaskID != nil {
		insertAt = -1
		for index := range base {
			if base[index].ID == *beforeTaskID {
				insertAt = index
				break
			}
		}
		if insertAt < 0 {
			return nil, false, ErrTaskMyWorkInvalid
		}
	}
	desired := make([]taskMyWorkPosition, 0, len(current))
	desired = append(desired, base[:insertAt]...)
	desired = append(desired, moving)
	desired = append(desired, base[insertAt:]...)
	changed := false
	for index := range current {
		if current[index].ID != desired[index].ID {
			changed = true
			break
		}
	}
	return desired, changed, nil
}

func taskMyWorkMovedPosition(desired []taskMyWorkPosition, index int) (int64, bool) {
	if index < 0 || index >= len(desired) {
		return 0, true
	}
	if len(desired) == 1 {
		return taskMyWorkPositionStep, false
	}
	if index == 0 {
		next := desired[1].Position
		if next > taskMyWorkPositionStep {
			return next - taskMyWorkPositionStep, false
		}
		return 0, true
	}
	if index == len(desired)-1 {
		previous := desired[index-1].Position
		if previous <= math.MaxInt64-taskMyWorkPositionStep {
			return previous + taskMyWorkPositionStep, false
		}
		return 0, true
	}
	previous, next := desired[index-1].Position, desired[index+1].Position
	if next-previous > 1 {
		return previous + (next-previous)/2, false
	}
	return 0, true
}

func sortTaskMyWorkSuggestionsForTest(items []taskMyWorkCandidate) {
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].ReasonRank != items[j].ReasonRank {
			return items[i].ReasonRank < items[j].ReasonRank
		}
		if items[i].PriorityRank != items[j].PriorityRank {
			return items[i].PriorityRank < items[j].PriorityRank
		}
		if (items[i].DueAt == nil) != (items[j].DueAt == nil) {
			return items[i].DueAt != nil
		}
		if items[i].DueAt != nil && !items[i].DueAt.Equal(*items[j].DueAt) {
			return items[i].DueAt.Before(*items[j].DueAt)
		}
		return strings.Compare(items[i].ID.String(), items[j].ID.String()) < 0
	})
}
