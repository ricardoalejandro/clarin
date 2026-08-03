package repository

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/naperu/clarin/internal/domain"
)

const taskEnvironmentUpdateSQL = `UPDATE task_environments SET name=$4,description=$5,color=$6,icon=$7,
	visibility=$8::varchar,default_access_level=$9::varchar,
	access_revision=access_revision+CASE WHEN visibility IS DISTINCT FROM $8::varchar OR default_access_level IS DISTINCT FROM $9::varchar THEN 1 ELSE 0 END,
	version=version+1,updated_at=NOW()
	WHERE account_id=$1 AND id=$2 AND version=$3 AND archived_at IS NULL`

func taskEnvironmentWriteError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == "uq_task_environments_active_name" {
		return ErrTaskEnvironmentNameConflict
	}
	return err
}

func environmentActorAdminSQL(environmentAlias, actorExpression string) string {
	return `EXISTS(SELECT 1 FROM user_accounts environment_membership
		JOIN users environment_user ON environment_user.id=environment_membership.user_id
		WHERE environment_membership.account_id=` + environmentAlias + `.account_id
		  AND environment_membership.user_id=` + actorExpression + `
		  AND (environment_membership.role IN ('admin','super_admin') OR COALESCE(environment_user.is_admin,FALSE) OR COALESCE(environment_user.is_super_admin,FALSE)))`
}

func environmentActorAccessRankSQL(environmentAlias, actorExpression string) string {
	explicit := `(SELECT environment_grant.access_level FROM task_environment_grants environment_grant
		WHERE environment_grant.account_id=` + environmentAlias + `.account_id
		  AND environment_grant.environment_id=` + environmentAlias + `.id
		  AND environment_grant.user_id=` + actorExpression + `)`
	fallback := `CASE WHEN ` + environmentAlias + `.visibility='account' THEN ` + environmentAlias + `.default_access_level ELSE 'none' END`
	return `CASE WHEN ` + environmentActorAdminSQL(environmentAlias, actorExpression) + ` THEN 4 ELSE ` + taskAccessLevelRankSQL(`COALESCE(`+explicit+`,`+fallback+`)`) + ` END`
}

// TaskStructurePageCursor is the complete keyset boundary for ordered Work
// structure collections. It carries the values themselves rather than a row
// lookup, so an item archived between pages cannot invalidate the cursor.
type TaskStructurePageCursor struct {
	SortOrder int
	ID        uuid.UUID
}

func taskStructureCursorValues(cursor *TaskStructurePageCursor) (*int, *uuid.UUID) {
	if cursor == nil {
		return nil, nil
	}
	return &cursor.SortOrder, &cursor.ID
}

func (r *TaskWorkRepository) ListEnvironments(ctx context.Context, accountID, userID uuid.UUID, limit int, cursor *TaskStructurePageCursor, search string, includeArchived bool) ([]*domain.TaskEnvironment, *TaskStructurePageCursor, error) {
	if limit < 1 || limit > 200 {
		limit = 50
	}
	search = strings.TrimSpace(search)
	cursorSortOrder, cursorID := taskStructureCursorValues(cursor)
	rows, err := r.db.Query(ctx, `
		SELECT environment.id,environment.account_id,environment.name,environment.description,environment.color,environment.icon,
			environment.sort_order,environment.visibility,environment.default_access_level,environment.is_default,environment.created_by,
			environment.archived_at,environment.version,environment.access_revision,environment.created_at,environment.updated_at,
			COALESCE(counts.folder_count,0),COALESCE(counts.list_count,0),COALESCE(counts.task_count,0),
			(`+environmentActorAccessRankSQL("environment", "$2")+`) AS access_rank,
			CASE WHEN `+environmentActorAdminSQL("environment", "$2")+` THEN TRUE ELSE COALESCE((
				SELECT environment_grant.can_manage_access FROM task_environment_grants environment_grant
				WHERE environment_grant.account_id=environment.account_id AND environment_grant.environment_id=environment.id
				  AND environment_grant.user_id=$2
			),FALSE) END AS can_manage_access,
			CASE WHEN `+environmentActorAdminSQL("environment", "$2")+` THEN 'account_admin'
				WHEN EXISTS(SELECT 1 FROM task_environment_grants environment_grant WHERE environment_grant.account_id=environment.account_id
					AND environment_grant.environment_id=environment.id AND environment_grant.user_id=$2) THEN 'environment_grant'
				WHEN environment.visibility='account' THEN 'environment_default' ELSE 'environment_private' END AS inherited_from
		FROM task_environments environment
		LEFT JOIN LATERAL (
			SELECT
				(SELECT COUNT(*) FROM task_folders folder WHERE folder.account_id=environment.account_id AND folder.environment_id=environment.id AND folder.archived_at IS NULL)::int AS folder_count,
				(SELECT COUNT(*) FROM task_lists list_count WHERE list_count.account_id=environment.account_id AND list_count.environment_id=environment.id AND list_count.archived_at IS NULL)::int AS list_count,
				(SELECT COUNT(*) FROM tasks task
				 JOIN task_lists list_item ON list_item.account_id=task.account_id AND list_item.id=task.list_id
				 WHERE task.account_id=environment.account_id AND list_item.environment_id=environment.id
				   AND task.parent_task_id IS NULL AND task.deleted_at IS NULL
				   AND `+taskActorCanViewIncludingArchivedSQL("task", "list_item", "$2")+`)::int AS task_count
		) counts ON TRUE
		WHERE environment.account_id=$1
		  AND ($3::boolean OR environment.archived_at IS NULL)
		  AND ($4::text='' OR environment.name ILIKE '%' || $4::text || '%' OR environment.description ILIKE '%' || $4::text || '%')
		  AND ($5::int IS NULL OR (environment.sort_order,environment.id) > ($5,$6))
		  AND (`+environmentActorAccessRankSQL("environment", "$2")+`) >= 1
		ORDER BY environment.sort_order,environment.id
		LIMIT $7
	`, accountID, userID, includeArchived, search, cursorSortOrder, cursorID, limit+1)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	items := make([]*domain.TaskEnvironment, 0, limit+1)
	for rows.Next() {
		item := &domain.TaskEnvironment{}
		var accessRank int
		var canManage bool
		var inheritedFrom string
		if err := rows.Scan(&item.ID, &item.AccountID, &item.Name, &item.Description, &item.Color, &item.Icon,
			&item.SortOrder, &item.Visibility, &item.DefaultAccessLevel, &item.IsDefault, &item.CreatedBy, &item.ArchivedAt,
			&item.Version, &item.AccessRevision, &item.CreatedAt, &item.UpdatedAt, &item.FolderCount, &item.ListCount, &item.TaskCount,
			&accessRank, &canManage, &inheritedFrom); err != nil {
			return nil, nil, err
		}
		accessLevel := domain.TaskAccessNone
		switch accessRank {
		case 4:
			accessLevel = domain.TaskAccessFull
		case 3:
			accessLevel = domain.TaskAccessEdit
		case 2:
			accessLevel = domain.TaskAccessComment
		case 1:
			accessLevel = domain.TaskAccessView
		}
		item.SetEffectiveAccess(buildTaskEffectiveAccess(accessLevel, canManage, inheritedFrom))
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	var next *TaskStructurePageCursor
	if len(items) > limit {
		boundary := items[limit-1]
		next = &TaskStructurePageCursor{SortOrder: boundary.SortOrder, ID: boundary.ID}
		items = items[:limit]
	}
	return items, next, nil
}

func (r *TaskWorkRepository) GetEnvironment(ctx context.Context, accountID, userID, environmentID uuid.UUID) (*domain.TaskEnvironment, error) {
	access, err := r.ResolveEnvironmentAccess(ctx, accountID, userID, environmentID)
	if err != nil {
		return nil, err
	}
	if !access.CanView {
		return nil, ErrTaskWorkNotFound
	}
	item := &domain.TaskEnvironment{}
	item.SetEffectiveAccess(access)
	err = r.db.QueryRow(ctx, `SELECT environment.id,environment.account_id,environment.name,environment.description,
		environment.color,environment.icon,environment.sort_order,environment.visibility,environment.default_access_level,
		environment.is_default,environment.created_by,environment.archived_at,environment.version,environment.access_revision,
		environment.created_at,environment.updated_at,
		(SELECT COUNT(*) FROM task_folders folder WHERE folder.account_id=environment.account_id AND folder.environment_id=environment.id AND folder.archived_at IS NULL),
		(SELECT COUNT(*) FROM task_lists list_item WHERE list_item.account_id=environment.account_id AND list_item.environment_id=environment.id AND list_item.archived_at IS NULL),
		(SELECT COUNT(*) FROM tasks task JOIN task_lists list_item ON list_item.account_id=task.account_id AND list_item.id=task.list_id
		 WHERE task.account_id=environment.account_id AND list_item.environment_id=environment.id AND task.parent_task_id IS NULL AND task.deleted_at IS NULL
		   AND `+taskActorCanViewIncludingArchivedSQL("task", "list_item", "$3")+`)
		FROM task_environments environment WHERE environment.account_id=$1 AND environment.id=$2`, accountID, environmentID, userID).
		Scan(&item.ID, &item.AccountID, &item.Name, &item.Description, &item.Color, &item.Icon, &item.SortOrder,
			&item.Visibility, &item.DefaultAccessLevel, &item.IsDefault, &item.CreatedBy, &item.ArchivedAt, &item.Version,
			&item.AccessRevision, &item.CreatedAt, &item.UpdatedAt, &item.FolderCount, &item.ListCount, &item.TaskCount)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrTaskWorkNotFound
	}
	return item, err
}

func (r *TaskWorkRepository) EnvironmentViewerUserIDs(ctx context.Context, accountID, environmentID uuid.UUID) ([]uuid.UUID, error) {
	rows, err := r.db.Query(ctx, `SELECT membership.user_id
		FROM task_environments environment
		JOIN user_accounts membership ON membership.account_id=environment.account_id
		WHERE environment.account_id=$1 AND environment.id=$2
		  AND (`+environmentActorAccessRankSQL("environment", "membership.user_id")+`) >= 1
		ORDER BY membership.user_id`, accountID, environmentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]uuid.UUID, 0)
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		result = append(result, id)
	}
	return result, rows.Err()
}

func (r *TaskWorkRepository) CreateEnvironment(ctx context.Context, environment *domain.TaskEnvironment, creatorID uuid.UUID, operationID *uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := tx.QueryRow(ctx, `SELECT id FROM accounts WHERE id=$1 FOR UPDATE`, environment.AccountID).Scan(new(uuid.UUID)); err != nil {
		return err
	}
	var member bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM user_accounts WHERE account_id=$1 AND user_id=$2)`, environment.AccountID, creatorID).Scan(&member); err != nil {
		return err
	}
	if !member {
		return ErrTaskAccessDenied
	}
	environment.ID = uuid.New()
	environment.CreatedBy = &creatorID
	environment.IsDefault = false
	environment.Version = 1
	environment.AccessRevision = 1
	environment.CreatedAt = time.Now().UTC()
	environment.UpdatedAt = environment.CreatedAt
	// Every newly-created environment starts private. Opening it to the whole
	// account is a separate, deliberate update after the creator exists as its
	// explicit manager.
	environment.Visibility = "restricted"
	environment.DefaultAccessLevel = domain.TaskAccessNone
	if err := tx.QueryRow(ctx, `INSERT INTO task_environments(id,account_id,name,description,color,icon,sort_order,
		visibility,default_access_level,is_default,created_by,version,access_revision,created_at,updated_at)
		SELECT $1,$2,$3,$4,$5,$6,COALESCE(MAX(sort_order)+1024,1024),$7,$8,FALSE,$9,1,1,$10,$10
		FROM task_environments WHERE account_id=$2 RETURNING sort_order`, environment.ID, environment.AccountID, environment.Name,
		environment.Description, environment.Color, environment.Icon, environment.Visibility, environment.DefaultAccessLevel,
		creatorID, environment.CreatedAt).Scan(&environment.SortOrder); err != nil {
		return err
	}
	workflowID := uuid.New()
	if _, err := tx.Exec(ctx, `INSERT INTO task_workflows(id,account_id,environment_id,name,is_default,created_by)
		VALUES($1,$2,$3,'Flujo general',TRUE,$4)`, workflowID, environment.AccountID, environment.ID, creatorID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO task_statuses(account_id,workflow_id,name,color,category,sort_order,is_default)
		VALUES ($1,$2,'Por hacer','#64748B','not_started',0,TRUE),
			($1,$2,'En curso','#3B82F6','active',1,FALSE),
			($1,$2,'Completada','#10B981','done',2,FALSE),
			($1,$2,'Cancelada','#EF4444','cancelled',3,FALSE)`, environment.AccountID, workflowID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO task_lists(account_id,environment_id,workflow_id,workflow_inherited,is_default,
		name,description,color,icon,sort_order,created_by)
		VALUES($1,$2,$3,TRUE,TRUE,'Bandeja general','Tareas sin una lista específica','#10B981','inbox',0,$4)`,
		environment.AccountID, environment.ID, workflowID, creatorID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO task_environment_grants(account_id,environment_id,user_id,access_level,can_manage_access,created_by)
		VALUES($1,$2,$3,'full',TRUE,$3)`, environment.AccountID, environment.ID, creatorID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO task_access_audit(account_id,actor_id,target_type,target_id,action,before_state,after_state,operation_id)
		VALUES($1,$2,'environment',$3,'environment_created','{}'::jsonb,
		jsonb_build_object('visibility',$4::text,'default_access_level',$5::text,'creator_manager',$2::uuid),$6)`,
		environment.AccountID, creatorID, environment.ID, environment.Visibility, environment.DefaultAccessLevel, operationID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *TaskWorkRepository) UpdateEnvironment(ctx context.Context, accountID, actorID uuid.UUID, environment *domain.TaskEnvironment, expectedAccessRevision *int64, operationID *uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var previousVisibility, previousDefaultAccess string
	var previousAccessRevision int64
	if err := tx.QueryRow(ctx, `SELECT visibility,default_access_level,access_revision FROM task_environments
		WHERE account_id=$1 AND id=$2 AND archived_at IS NULL FOR UPDATE`, accountID, environment.ID).
		Scan(&previousVisibility, &previousDefaultAccess, &previousAccessRevision); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrTaskWorkNotFound
		}
		return err
	}
	access, _, err := resolveEnvironmentAccessWith(ctx, tx, accountID, actorID, environment.ID)
	if err != nil {
		return err
	}
	if !TaskAccessAllows(access, domain.TaskAccessFull) {
		return ErrTaskAccessDenied
	}
	privacyChanged := previousVisibility != environment.Visibility || previousDefaultAccess != environment.DefaultAccessLevel
	if privacyChanged {
		if !access.CanManageAccess {
			return ErrTaskAccessDenied
		}
		if expectedAccessRevision == nil || *expectedAccessRevision != previousAccessRevision {
			return ErrTaskAccessRevisionConflict
		}
	}
	if environment.Visibility == "restricted" {
		var managerCount int
		if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM task_environment_grants
			WHERE account_id=$1 AND environment_id=$2 AND access_level='full' AND can_manage_access`, accountID, environment.ID).Scan(&managerCount); err != nil {
			return err
		}
		if managerCount == 0 {
			return ErrTaskLastAccessManager
		}
	}
	command, err := tx.Exec(ctx, taskEnvironmentUpdateSQL, accountID, environment.ID, environment.Version,
		environment.Name, environment.Description, environment.Color, environment.Icon, environment.Visibility, environment.DefaultAccessLevel)
	if err != nil {
		return taskEnvironmentWriteError(err)
	}
	if command.RowsAffected() == 0 {
		return ErrTaskVersionConflict
	}
	if privacyChanged {
		if _, err := tx.Exec(ctx, `INSERT INTO task_access_audit(account_id,actor_id,target_type,target_id,action,before_state,after_state,operation_id)
			VALUES($1,$2,'environment',$3,'environment_policy_updated',
				jsonb_build_object('visibility',$4::text,'default_access_level',$5::text,'access_revision',$6::bigint),
				jsonb_build_object('visibility',$7::text,'default_access_level',$8::text,'access_revision',$6::bigint+1),$9)`,
			accountID, actorID, environment.ID, previousVisibility, previousDefaultAccess, previousAccessRevision,
			environment.Visibility, environment.DefaultAccessLevel, operationID); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (r *TaskWorkRepository) ArchiveEnvironment(ctx context.Context, accountID, actorID, environmentID uuid.UUID, expectedVersion int64) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var isDefault bool
	var version int64
	if err := tx.QueryRow(ctx, `SELECT is_default,version FROM task_environments
		WHERE account_id=$1 AND id=$2 AND archived_at IS NULL FOR UPDATE`, accountID, environmentID).Scan(&isDefault, &version); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrTaskWorkNotFound
		}
		return err
	}
	access, _, err := resolveEnvironmentAccessWith(ctx, tx, accountID, actorID, environmentID)
	if err != nil {
		return err
	}
	if !TaskAccessAllows(access, domain.TaskAccessFull) {
		return ErrTaskAccessDenied
	}
	if isDefault {
		return ErrTaskEnvironmentDefault
	}
	if version != expectedVersion {
		return ErrTaskVersionConflict
	}
	var activeTasks int
	if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM tasks task JOIN task_lists list_item
		ON list_item.account_id=task.account_id AND list_item.id=task.list_id
		WHERE task.account_id=$1 AND list_item.environment_id=$2 AND task.deleted_at IS NULL`, accountID, environmentID).Scan(&activeTasks); err != nil {
		return err
	}
	if activeTasks > 0 {
		return ErrTaskContainerNotEmpty
	}
	if _, err := tx.Exec(ctx, `UPDATE task_environments SET archived_at=NOW(),version=version+1,updated_at=NOW()
		WHERE account_id=$1 AND id=$2`, accountID, environmentID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *TaskWorkRepository) RestoreEnvironment(ctx context.Context, accountID, actorID, environmentID uuid.UUID, expectedVersion int64) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var version int64
	if err := tx.QueryRow(ctx, `SELECT version FROM task_environments
		WHERE account_id=$1 AND id=$2 AND archived_at IS NOT NULL FOR UPDATE`, accountID, environmentID).Scan(&version); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrTaskWorkNotFound
		}
		return err
	}
	access, _, err := resolveEnvironmentAccessWith(ctx, tx, accountID, actorID, environmentID)
	if err != nil {
		return err
	}
	if !TaskAccessAllows(access, domain.TaskAccessFull) {
		return ErrTaskAccessDenied
	}
	if version != expectedVersion {
		return ErrTaskVersionConflict
	}
	command, err := tx.Exec(ctx, `UPDATE task_environments SET archived_at=NULL,version=version+1,updated_at=NOW()
		WHERE account_id=$1 AND id=$2 AND archived_at IS NOT NULL`, accountID, environmentID)
	if err != nil {
		return err
	}
	if command.RowsAffected() == 0 {
		return ErrTaskVersionConflict
	}
	return tx.Commit(ctx)
}
