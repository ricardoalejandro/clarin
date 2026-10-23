package repository

import (
	"context"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

// TaskRemovalDestination deliberately omits inaccessible parent breadcrumbs and
// inventory. Choosing a destination never grants access or writes task state.
type TaskRemovalDestination struct {
	ID            uuid.UUID `json:"id"`
	EnvironmentID uuid.UUID `json:"environment_id"`
	Name          string    `json:"name"`
	Icon          string    `json:"icon"`
	Color         string    `json:"color"`
	Lifecycle     string    `json:"lifecycle"`
	SortOrder     int       `json:"-"`
}

func (r *TaskWorkRepository) ListTaskRemovalDestinations(ctx context.Context, accountID, actorID, sourceID uuid.UUID, sourceType string, limit int, cursor *TaskStructurePageCursor, search string) ([]*TaskRemovalDestination, *TaskStructurePageCursor, error) {
	var sourceQuery string
	switch sourceType {
	case domain.TaskAccessTargetFolder:
		sourceQuery = `SELECT source.environment_id,
			(source.archived_at IS NOT NULL OR environment.archived_at IS NOT NULL),FALSE,
			(` + taskActorFolderAccessRankSQL("source", "$3") + `)
			FROM task_folders source JOIN task_environments environment
			ON environment.account_id=source.account_id AND environment.id=source.environment_id
			WHERE source.account_id=$1 AND source.id=$2 AND source.deleted_at IS NULL
			AND environment.deleted_at IS NULL AND (` + environmentActorAccessRankSQL("environment", "$3") + `)>=1`
	case domain.TaskAccessTargetList:
		sourceQuery = `SELECT source.environment_id,
			(source.archived_at IS NOT NULL OR parent.archived_at IS NOT NULL OR environment.archived_at IS NOT NULL),source.is_default,
			(` + taskActorListAccessRankSQL("source", "$3") + `)
			FROM task_lists source JOIN task_environments environment
			ON environment.account_id=source.account_id AND environment.id=source.environment_id
			LEFT JOIN task_folders parent ON parent.account_id=source.account_id AND parent.id=source.folder_id
			WHERE source.account_id=$1 AND source.id=$2 AND source.deleted_at IS NULL
			AND parent.deleted_at IS NULL AND environment.deleted_at IS NULL
			AND (` + environmentActorAccessRankSQL("environment", "$3") + `)>=1`
	default:
		return nil, nil, ErrTaskAccessInvalid
	}
	tx, err := r.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, nil, err
	}
	defer tx.Rollback(ctx)
	var environmentID uuid.UUID
	var archived, isDefault bool
	var rank int
	if err := tx.QueryRow(ctx, sourceQuery, accountID, sourceID, actorID).Scan(&environmentID, &archived, &isDefault, &rank); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil, ErrTaskWorkNotFound
		}
		return nil, nil, err
	}
	if rank < taskAccessRank(domain.TaskAccessView) {
		return nil, nil, ErrTaskWorkNotFound
	}
	if rank < taskAccessRank(domain.TaskAccessFull) {
		return nil, nil, ErrTaskAccessDenied
	}
	if isDefault {
		return nil, nil, ErrDefaultTaskList
	}
	limit = normalizeTaskEnvironmentPage(limit)
	afterOrder, afterID := taskStructureCursorValues(cursor)
	rows, err := tx.Query(ctx, `SELECT destination.id,destination.environment_id,destination.name,
		COALESCE(destination.icon,'list'),COALESCE(destination.color,'#10B981'),destination.sort_order,
		CASE WHEN destination.archived_at IS NOT NULL OR folder.archived_at IS NOT NULL OR environment.archived_at IS NOT NULL
		THEN 'archived' ELSE 'active' END
		FROM task_lists destination JOIN task_environments environment
		ON environment.account_id=destination.account_id AND environment.id=destination.environment_id
		LEFT JOIN task_folders folder ON folder.account_id=destination.account_id AND folder.id=destination.folder_id
		WHERE destination.account_id=$1 AND destination.environment_id=$2
		AND ($4::text<>'list' OR destination.id<>$5::uuid)
		AND destination.deleted_at IS NULL AND folder.deleted_at IS NULL AND environment.deleted_at IS NULL
		AND (destination.archived_at IS NOT NULL OR folder.archived_at IS NOT NULL OR environment.archived_at IS NOT NULL)=$6::boolean
		AND (`+taskActorListAccessRankSQL("destination", "$3")+`)>=3
		AND ($7::text='' OR destination.name ILIKE '%'||$7||'%')
		AND ($8::int IS NULL OR (destination.sort_order,destination.id)>($8,$9::uuid))
		ORDER BY destination.sort_order,destination.id LIMIT $10`, accountID, environmentID, actorID, sourceType, sourceID, archived, strings.TrimSpace(search), afterOrder, afterID, limit+1)
	if err != nil {
		return nil, nil, err
	}
	items := make([]*TaskRemovalDestination, 0, limit+1)
	for rows.Next() {
		item := &TaskRemovalDestination{}
		if err := rows.Scan(&item.ID, &item.EnvironmentID, &item.Name, &item.Icon, &item.Color, &item.SortOrder, &item.Lifecycle); err != nil {
			rows.Close()
			return nil, nil, err
		}
		items = append(items, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	var next *TaskStructurePageCursor
	if len(items) > limit {
		last := items[limit-1]
		next = &TaskStructurePageCursor{SortOrder: last.SortOrder, ID: last.ID}
		items = items[:limit]
	}
	return items, next, tx.Commit(ctx)
}
