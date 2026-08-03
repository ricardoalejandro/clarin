package repository

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/naperu/clarin/internal/domain"
)

var (
	ErrTaskAccessDenied            = errors.New("task access denied")
	ErrTaskAccessInvalid           = errors.New("task access grant is invalid")
	ErrTaskAccessRevisionConflict  = errors.New("task access revision changed concurrently")
	ErrTaskLastAccessManager       = errors.New("task resource requires an access manager")
	ErrTaskEnvironmentDefault      = errors.New("default task environment cannot be archived")
	ErrTaskEnvironmentNameConflict = errors.New("task environment name already exists")
)

type taskAccessQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
	Query(context.Context, string, ...any) (pgx.Rows, error)
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

type TaskAccessGrantInput struct {
	UserID          uuid.UUID
	AccessLevel     string
	CanManageAccess bool
}

func taskAccessRank(level string) int {
	switch strings.ToLower(strings.TrimSpace(level)) {
	case domain.TaskAccessView:
		return 1
	case domain.TaskAccessComment:
		return 2
	case domain.TaskAccessEdit:
		return 3
	case domain.TaskAccessFull:
		return 4
	default:
		return 0
	}
}

func taskAccessLevelFromRank(rank int) string {
	switch rank {
	case 4:
		return domain.TaskAccessFull
	case 3:
		return domain.TaskAccessEdit
	case 2:
		return domain.TaskAccessComment
	case 1:
		return domain.TaskAccessView
	default:
		return domain.TaskAccessNone
	}
}

func validTaskAccessLevel(level string) bool {
	switch strings.ToLower(strings.TrimSpace(level)) {
	case domain.TaskAccessNone, domain.TaskAccessView, domain.TaskAccessComment, domain.TaskAccessEdit, domain.TaskAccessFull:
		return true
	default:
		return false
	}
}

func buildTaskEffectiveAccess(level string, manage bool, inheritedFrom string) *domain.TaskEffectiveAccess {
	level = strings.ToLower(strings.TrimSpace(level))
	if !validTaskAccessLevel(level) {
		level = domain.TaskAccessNone
	}
	rank := taskAccessRank(level)
	return &domain.TaskEffectiveAccess{
		Level: level, CanView: rank >= 1, CanComment: rank >= 2, CanEdit: rank >= 3,
		CanDelete: rank >= 4, CanManageAccess: rank >= 4 && manage, InheritedFrom: inheritedFrom,
	}
}

func TaskAccessAllows(access *domain.TaskEffectiveAccess, required string) bool {
	return access != nil && taskAccessRank(access.Level) >= taskAccessRank(required)
}

func resolveEnvironmentAccessWith(ctx context.Context, q taskAccessQuerier, accountID, userID, environmentID uuid.UUID) (*domain.TaskEffectiveAccess, bool, error) {
	var visibility, defaultLevel string
	var explicitLevel *string
	var explicitManage *bool
	var admin bool
	err := q.QueryRow(ctx, `
		SELECT environment.visibility,environment.default_access_level,
			(membership.role IN ('admin','super_admin') OR COALESCE(account_user.is_admin,FALSE) OR COALESCE(account_user.is_super_admin,FALSE)) AS is_admin,
			grant_item.access_level,grant_item.can_manage_access
		FROM task_environments environment
		JOIN user_accounts membership ON membership.account_id=environment.account_id AND membership.user_id=$2
		JOIN users account_user ON account_user.id=membership.user_id
		LEFT JOIN task_environment_grants grant_item ON grant_item.account_id=environment.account_id
			AND grant_item.environment_id=environment.id AND grant_item.user_id=membership.user_id
		WHERE environment.account_id=$1 AND environment.id=$3
	`, accountID, userID, environmentID).Scan(&visibility, &defaultLevel, &admin, &explicitLevel, &explicitManage)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, false, ErrTaskWorkNotFound
	}
	if err != nil {
		return nil, false, err
	}
	if admin {
		return buildTaskEffectiveAccess(domain.TaskAccessFull, true, "account_admin"), true, nil
	}
	if explicitLevel != nil {
		manage := explicitManage != nil && *explicitManage
		return buildTaskEffectiveAccess(*explicitLevel, manage, "environment_grant"), false, nil
	}
	if visibility == "account" {
		return buildTaskEffectiveAccess(defaultLevel, false, "environment_default"), false, nil
	}
	return buildTaskEffectiveAccess(domain.TaskAccessNone, false, "environment_private"), false, nil
}

func (r *TaskWorkRepository) ResolveEnvironmentAccess(ctx context.Context, accountID, userID, environmentID uuid.UUID) (*domain.TaskEffectiveAccess, error) {
	access, _, err := resolveEnvironmentAccessWith(ctx, r.db, accountID, userID, environmentID)
	return access, err
}

type taskAccessContext struct {
	EnvironmentID    uuid.UUID
	RootTaskID       uuid.UUID
	AccessMode       string
	EnvironmentLevel string
	EnvironmentView  bool
	Access           *domain.TaskEffectiveAccess
	Admin            bool
}

type taskHierarchyAccessState struct {
	EnvironmentLevel, EnvironmentSource  string
	EnvironmentManage                    bool
	FolderMode, ListMode, TaskMode       string
	FolderLevel, ListLevel, TaskLevel    *string
	FolderManage, ListManage, TaskManage *bool
}

func explicitOrInherited(level *string, manage *bool, mode, inheritedLevel string, inheritedManage bool, grantSource, privateSource, inheritedSource string) (string, bool, string) {
	if level != nil {
		return *level, manage != nil && *manage, grantSource
	}
	if mode == "private" {
		return domain.TaskAccessNone, false, privateSource
	}
	return inheritedLevel, inheritedManage, inheritedSource
}

func resolveTaskHierarchyAccess(state taskHierarchyAccessState) (access *domain.TaskEffectiveAccess, folderVisible, listVisible bool) {
	if taskAccessRank(state.EnvironmentLevel) < taskAccessRank(domain.TaskAccessView) {
		return buildTaskEffectiveAccess(domain.TaskAccessNone, false, "environment_required"), false, false
	}
	folderLevel, folderManage, folderSource := explicitOrInherited(state.FolderLevel, state.FolderManage, state.FolderMode,
		state.EnvironmentLevel, state.EnvironmentManage, "folder_grant", "folder_private", state.EnvironmentSource)
	folderVisible = taskAccessRank(folderLevel) >= taskAccessRank(domain.TaskAccessView)
	listLevel, listManage, listSource := explicitOrInherited(state.ListLevel, state.ListManage, state.ListMode,
		folderLevel, folderManage, "list_grant", "list_private", folderSource)
	listVisible = taskAccessRank(listLevel) >= taskAccessRank(domain.TaskAccessView)
	taskLevel, taskManage, taskSource := explicitOrInherited(state.TaskLevel, state.TaskManage, state.TaskMode,
		listLevel, listManage, "task_grant", "task_private", listSource)
	return buildTaskEffectiveAccess(taskLevel, taskManage, taskSource), folderVisible, listVisible
}

func resolveTaskAccessWith(ctx context.Context, q taskAccessQuerier, accountID, userID, taskID uuid.UUID) (*taskAccessContext, error) {
	return resolveTaskAccessWithState(ctx, q, accountID, userID, taskID, false)
}

func resolveTaskAccessWithState(ctx context.Context, q taskAccessQuerier, accountID, userID, taskID uuid.UUID, includeDeleted bool) (*taskAccessContext, error) {
	var result taskAccessContext
	var visibility, defaultLevel string
	var environmentGrantLevel, folderGrantLevel, listGrantLevel, taskGrantLevel *string
	var environmentGrantManage, folderGrantManage, listGrantManage, taskGrantManage *bool
	var folderMode *string
	var listMode string
	deletedPredicate := " AND task.deleted_at IS NULL AND root.deleted_at IS NULL"
	if includeDeleted {
		deletedPredicate = ""
	}
	err := q.QueryRow(ctx, `
		SELECT environment.id,root.id,COALESCE(root.access_mode,'inherit'),environment.visibility,environment.default_access_level,
			(membership.role IN ('admin','super_admin') OR COALESCE(account_user.is_admin,FALSE) OR COALESCE(account_user.is_super_admin,FALSE)) AS is_admin,
			environment_grant.access_level,environment_grant.can_manage_access,
			folder.access_mode,folder_grant.access_level,folder_grant.can_manage_access,
			COALESCE(list_item.access_mode,'inherit'),list_grant.access_level,list_grant.can_manage_access,
			task_grant.access_level,task_grant.can_manage_access
		FROM tasks task
		JOIN tasks root ON root.account_id=task.account_id AND root.id=COALESCE(task.parent_task_id,task.id)
		JOIN task_lists list_item ON list_item.account_id=task.account_id AND list_item.id=task.list_id
		LEFT JOIN task_folders folder ON folder.account_id=list_item.account_id AND folder.id=list_item.folder_id
		JOIN task_environments environment ON environment.account_id=list_item.account_id AND environment.id=list_item.environment_id
		JOIN user_accounts membership ON membership.account_id=task.account_id AND membership.user_id=$2
		JOIN users account_user ON account_user.id=membership.user_id
		LEFT JOIN task_environment_grants environment_grant ON environment_grant.account_id=environment.account_id
			AND environment_grant.environment_id=environment.id AND environment_grant.user_id=membership.user_id
		LEFT JOIN task_folder_access_grants folder_grant ON folder_grant.account_id=folder.account_id
			AND folder_grant.folder_id=folder.id AND folder_grant.user_id=membership.user_id
		LEFT JOIN task_list_access_grants list_grant ON list_grant.account_id=list_item.account_id
			AND list_grant.list_id=list_item.id AND list_grant.user_id=membership.user_id
		LEFT JOIN task_access_grants task_grant ON task_grant.account_id=root.account_id
			AND task_grant.task_id=root.id AND task_grant.user_id=membership.user_id
		WHERE task.account_id=$1 AND task.id=$3`+deletedPredicate+` AND environment.archived_at IS NULL
	`, accountID, userID, taskID).Scan(&result.EnvironmentID, &result.RootTaskID, &result.AccessMode, &visibility,
		&defaultLevel, &result.Admin, &environmentGrantLevel, &environmentGrantManage,
		&folderMode, &folderGrantLevel, &folderGrantManage, &listMode, &listGrantLevel, &listGrantManage,
		&taskGrantLevel, &taskGrantManage)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrTaskWorkNotFound
	}
	if err != nil {
		return nil, err
	}
	if result.Admin {
		result.EnvironmentLevel = domain.TaskAccessFull
		result.EnvironmentView = true
		result.Access = buildTaskEffectiveAccess(domain.TaskAccessFull, true, "account_admin")
		return &result, nil
	}
	environmentLevel := domain.TaskAccessNone
	environmentManage := false
	environmentSource := "environment_private"
	if environmentGrantLevel != nil {
		environmentLevel = *environmentGrantLevel
		environmentManage = environmentGrantManage != nil && *environmentGrantManage
		environmentSource = "environment_grant"
	} else if visibility == "account" {
		environmentLevel = defaultLevel
		environmentSource = "environment_default"
	}
	result.EnvironmentLevel = environmentLevel
	result.EnvironmentView = taskAccessRank(environmentLevel) >= taskAccessRank(domain.TaskAccessView)
	state := taskHierarchyAccessState{
		EnvironmentLevel: environmentLevel, EnvironmentManage: environmentManage, EnvironmentSource: environmentSource,
		ListMode: listMode, TaskMode: result.AccessMode,
		FolderLevel: folderGrantLevel, FolderManage: folderGrantManage,
		ListLevel: listGrantLevel, ListManage: listGrantManage,
		TaskLevel: taskGrantLevel, TaskManage: taskGrantManage,
	}
	if folderMode != nil {
		state.FolderMode = *folderMode
	}
	result.Access, _, _ = resolveTaskHierarchyAccess(state)
	return &result, nil
}

func (r *TaskWorkRepository) ResolveTaskAccess(ctx context.Context, accountID, userID, taskID uuid.UUID) (*domain.TaskEffectiveAccess, error) {
	result, err := resolveTaskAccessWith(ctx, r.db, accountID, userID, taskID)
	if err != nil {
		return nil, err
	}
	return result.Access, nil
}

func (r *TaskWorkRepository) RequireEnvironmentAccess(ctx context.Context, accountID, userID, environmentID uuid.UUID, required string) (*domain.TaskEffectiveAccess, error) {
	access, err := r.ResolveEnvironmentAccess(ctx, accountID, userID, environmentID)
	if err != nil {
		return nil, err
	}
	if !TaskAccessAllows(access, required) {
		if access == nil || !access.CanView {
			return access, ErrTaskWorkNotFound
		}
		return access, ErrTaskAccessDenied
	}
	return access, nil
}

func requireTaskEnvironmentActive(active bool) error {
	if !active {
		return ErrTaskWorkNotFound
	}
	return nil
}

// RequireActiveEnvironmentAccess is the ordinary Work gate. Environment
// access itself intentionally remains resolvable after archive so the archive
// surface can inspect and restore it, but normal hierarchy reads and mutations
// must treat an archived environment as hidden.
func (r *TaskWorkRepository) RequireActiveEnvironmentAccess(ctx context.Context, accountID, userID, environmentID uuid.UUID, required string) (*domain.TaskEffectiveAccess, error) {
	var active bool
	if err := r.db.QueryRow(ctx, `SELECT archived_at IS NULL FROM task_environments WHERE account_id=$1 AND id=$2`, accountID, environmentID).Scan(&active); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrTaskWorkNotFound
		}
		return nil, err
	}
	if err := requireTaskEnvironmentActive(active); err != nil {
		return nil, err
	}
	return r.RequireEnvironmentAccess(ctx, accountID, userID, environmentID, required)
}

func (r *TaskWorkRepository) RequireTaskAccess(ctx context.Context, accountID, userID, taskID uuid.UUID, required string) (*domain.TaskEffectiveAccess, error) {
	access, err := r.ResolveTaskAccess(ctx, accountID, userID, taskID)
	if err != nil {
		return nil, err
	}
	if !TaskAccessAllows(access, required) {
		if access == nil || !access.CanView {
			return access, ErrTaskWorkNotFound
		}
		return access, ErrTaskAccessDenied
	}
	return access, nil
}

func (r *TaskWorkRepository) DefaultEnvironmentID(ctx context.Context, accountID uuid.UUID) (uuid.UUID, error) {
	var environmentID uuid.UUID
	err := r.db.QueryRow(ctx, `SELECT id FROM task_environments
		WHERE account_id=$1 AND is_default AND archived_at IS NULL`, accountID).Scan(&environmentID)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, ErrTaskWorkNotFound
	}
	return environmentID, err
}

func (r *TaskWorkRepository) containerEnvironmentID(ctx context.Context, accountID, resourceID uuid.UUID, resourceType string) (uuid.UUID, error) {
	query := ""
	switch resourceType {
	case "folder":
		query = `SELECT environment_id FROM task_folders WHERE account_id=$1 AND id=$2`
	case "list":
		query = `SELECT environment_id FROM task_lists WHERE account_id=$1 AND id=$2`
	case "workflow":
		query = `SELECT environment_id FROM task_workflows WHERE account_id=$1 AND id=$2`
	case "status":
		query = `SELECT workflow.environment_id FROM task_statuses status
			JOIN task_workflows workflow ON workflow.account_id=status.account_id AND workflow.id=status.workflow_id
			WHERE status.account_id=$1 AND status.id=$2`
	default:
		return uuid.Nil, ErrTaskAccessInvalid
	}
	var environmentID uuid.UUID
	if err := r.db.QueryRow(ctx, query, accountID, resourceID).Scan(&environmentID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return uuid.Nil, ErrTaskWorkNotFound
		}
		return uuid.Nil, err
	}
	return environmentID, nil
}

func (r *TaskWorkRepository) ContainerEnvironmentID(ctx context.Context, accountID, resourceID uuid.UUID, resourceType string) (uuid.UUID, error) {
	return r.containerEnvironmentID(ctx, accountID, resourceID, resourceType)
}

func resolveContainerAccessWith(ctx context.Context, q taskAccessQuerier, accountID, userID, resourceID uuid.UUID, resourceType string) (*domain.TaskEffectiveAccess, uuid.UUID, error) {
	if resourceType != domain.TaskAccessTargetFolder && resourceType != domain.TaskAccessTargetList {
		return nil, uuid.Nil, ErrTaskAccessInvalid
	}
	query := `SELECT environment.id,
		(membership.role IN ('admin','super_admin') OR COALESCE(account_user.is_admin,FALSE) OR COALESCE(account_user.is_super_admin,FALSE)) AS is_admin,
		environment.visibility,environment.default_access_level,
		environment_grant.access_level,environment_grant.can_manage_access,
		folder.access_mode,folder_grant.access_level,folder_grant.can_manage_access,
		COALESCE(list_item.access_mode,'inherit'),list_grant.access_level,list_grant.can_manage_access
	FROM task_lists list_item
	LEFT JOIN task_folders folder ON folder.account_id=list_item.account_id AND folder.id=list_item.folder_id
	JOIN task_environments environment ON environment.account_id=list_item.account_id AND environment.id=list_item.environment_id AND environment.archived_at IS NULL
	JOIN user_accounts membership ON membership.account_id=environment.account_id AND membership.user_id=$2
	JOIN users account_user ON account_user.id=membership.user_id
	LEFT JOIN task_environment_grants environment_grant ON environment_grant.account_id=environment.account_id AND environment_grant.environment_id=environment.id AND environment_grant.user_id=membership.user_id
	LEFT JOIN task_folder_access_grants folder_grant ON folder_grant.account_id=folder.account_id AND folder_grant.folder_id=folder.id AND folder_grant.user_id=membership.user_id
	LEFT JOIN task_list_access_grants list_grant ON list_grant.account_id=list_item.account_id AND list_grant.list_id=list_item.id AND list_grant.user_id=membership.user_id
	WHERE list_item.account_id=$1 AND list_item.id=$3 AND list_item.archived_at IS NULL`
	if resourceType == domain.TaskAccessTargetFolder {
		query = `SELECT environment.id,
			(membership.role IN ('admin','super_admin') OR COALESCE(account_user.is_admin,FALSE) OR COALESCE(account_user.is_super_admin,FALSE)) AS is_admin,
			environment.visibility,environment.default_access_level,
			environment_grant.access_level,environment_grant.can_manage_access,
			folder.access_mode,folder_grant.access_level,folder_grant.can_manage_access,
			'inherit'::varchar,NULL::varchar,NULL::boolean
		FROM task_folders folder
		JOIN task_environments environment ON environment.account_id=folder.account_id AND environment.id=folder.environment_id AND environment.archived_at IS NULL
		JOIN user_accounts membership ON membership.account_id=environment.account_id AND membership.user_id=$2
		JOIN users account_user ON account_user.id=membership.user_id
		LEFT JOIN task_environment_grants environment_grant ON environment_grant.account_id=environment.account_id AND environment_grant.environment_id=environment.id AND environment_grant.user_id=membership.user_id
		LEFT JOIN task_folder_access_grants folder_grant ON folder_grant.account_id=folder.account_id AND folder_grant.folder_id=folder.id AND folder_grant.user_id=membership.user_id
		WHERE folder.account_id=$1 AND folder.id=$3 AND folder.archived_at IS NULL`
	}
	var environmentID uuid.UUID
	var admin bool
	var visibility, defaultLevel, listMode string
	var folderMode *string
	var environmentGrantLevel, folderGrantLevel, listGrantLevel *string
	var environmentGrantManage, folderGrantManage, listGrantManage *bool
	if err := q.QueryRow(ctx, query, accountID, userID, resourceID).Scan(&environmentID, &admin, &visibility, &defaultLevel,
		&environmentGrantLevel, &environmentGrantManage, &folderMode, &folderGrantLevel, &folderGrantManage,
		&listMode, &listGrantLevel, &listGrantManage); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, uuid.Nil, ErrTaskWorkNotFound
		}
		return nil, uuid.Nil, err
	}
	if admin {
		return buildTaskEffectiveAccess(domain.TaskAccessFull, true, "account_admin"), environmentID, nil
	}
	environmentLevel, environmentManage, environmentSource := domain.TaskAccessNone, false, "environment_private"
	if environmentGrantLevel != nil {
		environmentLevel, environmentManage, environmentSource = *environmentGrantLevel, environmentGrantManage != nil && *environmentGrantManage, "environment_grant"
	} else if visibility == "account" {
		environmentLevel, environmentSource = defaultLevel, "environment_default"
	}
	state := taskHierarchyAccessState{
		EnvironmentLevel: environmentLevel, EnvironmentManage: environmentManage, EnvironmentSource: environmentSource,
		ListMode: listMode, TaskMode: "inherit", FolderLevel: folderGrantLevel, FolderManage: folderGrantManage,
		ListLevel: listGrantLevel, ListManage: listGrantManage,
	}
	if folderMode != nil {
		state.FolderMode = *folderMode
	}
	access, _, _ := resolveTaskHierarchyAccess(state)
	return access, environmentID, nil
}

func (r *TaskWorkRepository) ResolveContainerAccess(ctx context.Context, accountID, userID, resourceID uuid.UUID, resourceType string) (*domain.TaskEffectiveAccess, uuid.UUID, error) {
	return resolveContainerAccessWith(ctx, r.db, accountID, userID, resourceID, resourceType)
}

func (r *TaskWorkRepository) RequireContainerAccess(ctx context.Context, accountID, userID, resourceID uuid.UUID, resourceType, required string) (*domain.TaskEffectiveAccess, error) {
	if resourceType == domain.TaskAccessTargetFolder || resourceType == domain.TaskAccessTargetList {
		access, _, err := resolveContainerAccessWith(ctx, r.db, accountID, userID, resourceID, resourceType)
		if err != nil {
			return nil, err
		}
		if !TaskAccessAllows(access, required) {
			if access == nil || !access.CanView {
				return access, ErrTaskWorkNotFound
			}
			return access, ErrTaskAccessDenied
		}
		return access, nil
	}
	environmentID, err := r.containerEnvironmentID(ctx, accountID, resourceID, resourceType)
	if err != nil {
		return nil, err
	}
	return r.RequireActiveEnvironmentAccess(ctx, accountID, userID, environmentID, required)
}

func (r *TaskWorkRepository) ListAccessGrants(ctx context.Context, accountID uuid.UUID, targetType string, targetID uuid.UUID) ([]*domain.TaskAccessGrant, string, int64, error) {
	table, targetColumn := "task_environment_grants", "environment_id"
	accessMode := "inherit"
	var revision int64
	if targetType == domain.TaskAccessTargetFolder {
		table, targetColumn = "task_folder_access_grants", "folder_id"
		if err := r.db.QueryRow(ctx, `SELECT access_mode,access_revision FROM task_folders WHERE account_id=$1 AND id=$2`, accountID, targetID).Scan(&accessMode, &revision); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, "", 0, ErrTaskWorkNotFound
			}
			return nil, "", 0, err
		}
	} else if targetType == domain.TaskAccessTargetList {
		table, targetColumn = "task_list_access_grants", "list_id"
		if err := r.db.QueryRow(ctx, `SELECT access_mode,access_revision FROM task_lists WHERE account_id=$1 AND id=$2`, accountID, targetID).Scan(&accessMode, &revision); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, "", 0, ErrTaskWorkNotFound
			}
			return nil, "", 0, err
		}
	} else if targetType == domain.TaskAccessTargetTask {
		table, targetColumn = "task_access_grants", "task_id"
		if err := r.db.QueryRow(ctx, `SELECT COALESCE(root.access_mode,'inherit'),COALESCE(root.access_revision,1)
			FROM tasks task JOIN tasks root ON root.account_id=task.account_id AND root.id=COALESCE(task.parent_task_id,task.id)
			WHERE task.account_id=$1 AND task.id=$2`, accountID, targetID).Scan(&accessMode, &revision); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, "", 0, ErrTaskWorkNotFound
			}
			return nil, "", 0, err
		}
	} else if targetType == domain.TaskAccessTargetEnvironment {
		if err := r.db.QueryRow(ctx, `SELECT access_revision FROM task_environments WHERE account_id=$1 AND id=$2`, accountID, targetID).Scan(&revision); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, "", 0, ErrTaskWorkNotFound
			}
			return nil, "", 0, err
		}
	} else {
		return nil, "", 0, ErrTaskAccessInvalid
	}
	rows, err := r.db.Query(ctx, fmt.Sprintf(`SELECT grant_item.user_id,COALESCE(account_user.display_name,''),account_user.username,
		grant_item.access_level,grant_item.can_manage_access,grant_item.created_by,grant_item.created_at,grant_item.updated_at
		FROM %s grant_item JOIN users account_user ON account_user.id=grant_item.user_id
		WHERE grant_item.account_id=$1 AND grant_item.%s=$2
		ORDER BY LOWER(COALESCE(NULLIF(account_user.display_name,''),account_user.username)),grant_item.user_id`, table, targetColumn), accountID, targetID)
	if err != nil {
		return nil, "", 0, err
	}
	defer rows.Close()
	grants := make([]*domain.TaskAccessGrant, 0)
	for rows.Next() {
		grant := &domain.TaskAccessGrant{}
		if err := rows.Scan(&grant.UserID, &grant.DisplayName, &grant.Username, &grant.AccessLevel, &grant.CanManageAccess,
			&grant.CreatedBy, &grant.CreatedAt, &grant.UpdatedAt); err != nil {
			return nil, "", 0, err
		}
		grants = append(grants, grant)
	}
	return grants, accessMode, revision, rows.Err()
}

func accessStateJSON(ctx context.Context, q taskAccessQuerier, accountID uuid.UUID, table, targetColumn string, targetID uuid.UUID, accessMode string) ([]byte, error) {
	var raw []byte
	err := q.QueryRow(ctx, fmt.Sprintf(`SELECT jsonb_build_object(
		'access_mode',$3::text,
		'grants',COALESCE(jsonb_agg(jsonb_build_object(
			'user_id',grant_item.user_id,'access_level',grant_item.access_level,'can_manage_access',grant_item.can_manage_access
		) ORDER BY grant_item.user_id) FILTER (WHERE grant_item.id IS NOT NULL),'[]'::jsonb)
	)::text
	FROM (SELECT 1) singleton
	LEFT JOIN %s grant_item ON grant_item.account_id=$1 AND grant_item.%s=$2`, table, targetColumn), accountID, targetID, accessMode).Scan(&raw)
	return raw, err
}

func normalizeTaskAccessTarget(ctx context.Context, q taskAccessQuerier, accountID, taskID uuid.UUID) (uuid.UUID, uuid.UUID, string, error) {
	var rootID, environmentID uuid.UUID
	var accessMode string
	err := q.QueryRow(ctx, `SELECT root.id,list_item.environment_id,COALESCE(root.access_mode,'inherit')
		FROM tasks task
		JOIN tasks root ON root.account_id=task.account_id AND root.id=COALESCE(task.parent_task_id,task.id)
		JOIN task_lists list_item ON list_item.account_id=root.account_id AND list_item.id=root.list_id
		WHERE task.account_id=$1 AND task.id=$2 FOR UPDATE OF root`, accountID, taskID).Scan(&rootID, &environmentID, &accessMode)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, uuid.Nil, "", ErrTaskWorkNotFound
	}
	return rootID, environmentID, accessMode, err
}

func (r *TaskWorkRepository) CanonicalTaskAccessTarget(ctx context.Context, accountID, taskID uuid.UUID) (uuid.UUID, uuid.UUID, string, error) {
	var rootID, environmentID uuid.UUID
	var accessMode string
	err := r.db.QueryRow(ctx, `SELECT root.id,list_item.environment_id,COALESCE(root.access_mode,'inherit')
		FROM tasks task
		JOIN tasks root ON root.account_id=task.account_id AND root.id=COALESCE(task.parent_task_id,task.id)
		JOIN task_lists list_item ON list_item.account_id=root.account_id AND list_item.id=root.list_id
		WHERE task.account_id=$1 AND task.id=$2`, accountID, taskID).Scan(&rootID, &environmentID, &accessMode)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, uuid.Nil, "", ErrTaskWorkNotFound
	}
	return rootID, environmentID, accessMode, err
}

// ReplaceAccessGrants is the one atomic ACL write. Validation, replacement,
// revision bump and audit are committed together, so a failed request can
// never leave a partially shared resource or an unaudited permission change.
func (r *TaskWorkRepository) ReplaceAccessGrants(ctx context.Context, accountID, actorID uuid.UUID, targetType string, targetID uuid.UUID, accessMode *string, inputs []TaskAccessGrantInput, expectedAccessRevision int64, operationID uuid.UUID) ([]*domain.TaskAccessGrant, string, int64, error) {
	if expectedAccessRevision < 1 {
		return nil, "", 0, ErrTaskAccessInvalid
	}
	if len(inputs) > 500 {
		return nil, "", 0, ErrTaskAccessInvalid
	}
	seen := make(map[uuid.UUID]struct{}, len(inputs))
	managerCount := 0
	for index := range inputs {
		inputs[index].AccessLevel = strings.ToLower(strings.TrimSpace(inputs[index].AccessLevel))
		if !validTaskAccessLevel(inputs[index].AccessLevel) || (inputs[index].CanManageAccess && inputs[index].AccessLevel != domain.TaskAccessFull) {
			return nil, "", 0, ErrTaskAccessInvalid
		}
		if _, duplicate := seen[inputs[index].UserID]; duplicate {
			return nil, "", 0, ErrTaskAccessInvalid
		}
		seen[inputs[index].UserID] = struct{}{}
		if inputs[index].CanManageAccess {
			managerCount++
		}
	}

	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, "", 0, err
	}
	defer tx.Rollback(ctx)

	table, targetColumn := "task_environment_grants", "environment_id"
	currentMode := "inherit"
	previousMode := "inherit"
	environmentID := targetID
	canonicalTargetID := targetID
	privateTarget := false
	var actorAccess *domain.TaskEffectiveAccess
	if targetType == domain.TaskAccessTargetEnvironment {
		var visibility string
		if err := tx.QueryRow(ctx, `SELECT visibility FROM task_environments WHERE account_id=$1 AND id=$2 FOR UPDATE`, accountID, targetID).Scan(&visibility); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, "", 0, ErrTaskWorkNotFound
			}
			return nil, "", 0, err
		}
		privateTarget = visibility == "restricted"
		actorAccess, _, err = resolveEnvironmentAccessWith(ctx, tx, accountID, actorID, targetID)
	} else if targetType == domain.TaskAccessTargetFolder || targetType == domain.TaskAccessTargetList {
		resourceTable, idColumn := "task_folders", "id"
		table, targetColumn = "task_folder_access_grants", "folder_id"
		if targetType == domain.TaskAccessTargetList {
			resourceTable = "task_lists"
			table, targetColumn = "task_list_access_grants", "list_id"
		}
		if err := tx.QueryRow(ctx, fmt.Sprintf(`SELECT environment_id,access_mode FROM %s WHERE account_id=$1 AND %s=$2 FOR UPDATE`, resourceTable, idColumn), accountID, targetID).Scan(&environmentID, &currentMode); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, "", 0, ErrTaskWorkNotFound
			}
			return nil, "", 0, err
		}
		previousMode = currentMode
		actorAccess, _, err = resolveContainerAccessWith(ctx, tx, accountID, actorID, targetID, targetType)
		if accessMode != nil {
			requestedMode := strings.ToLower(strings.TrimSpace(*accessMode))
			if requestedMode != "inherit" && requestedMode != "private" {
				return nil, "", 0, ErrTaskAccessInvalid
			}
			currentMode = requestedMode
		}
		privateTarget = currentMode == "private"
	} else if targetType == domain.TaskAccessTargetTask {
		table, targetColumn = "task_access_grants", "task_id"
		canonicalTargetID, environmentID, currentMode, err = normalizeTaskAccessTarget(ctx, tx, accountID, targetID)
		if err == nil {
			previousMode = currentMode
			var resolved *taskAccessContext
			resolved, err = resolveTaskAccessWith(ctx, tx, accountID, actorID, canonicalTargetID)
			if resolved != nil {
				actorAccess = resolved.Access
			}
		}
		if accessMode != nil {
			requestedMode := strings.ToLower(strings.TrimSpace(*accessMode))
			if requestedMode != "inherit" && requestedMode != "private" {
				return nil, "", 0, ErrTaskAccessInvalid
			}
			currentMode = requestedMode
		}
		privateTarget = currentMode == "private"
	} else {
		return nil, "", 0, ErrTaskAccessInvalid
	}
	if err != nil {
		return nil, "", 0, err
	}
	if actorAccess == nil || !actorAccess.CanManageAccess {
		if actorAccess == nil || !actorAccess.CanView {
			return nil, "", 0, ErrTaskWorkNotFound
		}
		return nil, "", 0, ErrTaskAccessDenied
	}
	var lockedRevision int64
	revisionQuery := `SELECT access_revision FROM task_environments WHERE account_id=$1 AND id=$2 FOR UPDATE`
	revisionTargetID := environmentID
	if targetType == domain.TaskAccessTargetFolder {
		revisionQuery = `SELECT access_revision FROM task_folders WHERE account_id=$1 AND id=$2 FOR UPDATE`
		revisionTargetID = canonicalTargetID
	} else if targetType == domain.TaskAccessTargetList {
		revisionQuery = `SELECT access_revision FROM task_lists WHERE account_id=$1 AND id=$2 FOR UPDATE`
		revisionTargetID = canonicalTargetID
	} else if targetType == domain.TaskAccessTargetTask {
		revisionQuery = `SELECT COALESCE(access_revision,1) FROM tasks WHERE account_id=$1 AND id=$2 AND parent_task_id IS NULL FOR UPDATE`
		revisionTargetID = canonicalTargetID
	}
	if err := tx.QueryRow(ctx, revisionQuery, accountID, revisionTargetID).Scan(&lockedRevision); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, "", 0, ErrTaskWorkNotFound
		}
		return nil, "", 0, err
	}
	if lockedRevision != expectedAccessRevision {
		return nil, "", lockedRevision, ErrTaskAccessRevisionConflict
	}
	if managerCount == 0 && privateTarget {
		return nil, "", 0, ErrTaskLastAccessManager
	}

	if len(inputs) > 0 {
		userIDs := make([]uuid.UUID, 0, len(inputs))
		for _, input := range inputs {
			userIDs = append(userIDs, input.UserID)
		}
		var memberCount int
		if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM user_accounts WHERE account_id=$1 AND user_id=ANY($2::uuid[])`, accountID, userIDs).Scan(&memberCount); err != nil {
			return nil, "", 0, err
		}
		if memberCount != len(userIDs) {
			return nil, "", 0, ErrTaskAccessInvalid
		}
		if targetType != domain.TaskAccessTargetEnvironment {
			// Historical task grants created before the Entorno boundary may still
			// reference a member who no longer sees this Entorno. Keep such grants
			// durable but inactive. Only a newly-added child grant must prove the
			// recipient already has at least Ver on the Entorno.
			existing := make(map[uuid.UUID]struct{}, len(inputs))
			rows, queryErr := tx.Query(ctx, fmt.Sprintf(`SELECT user_id FROM %s WHERE account_id=$1 AND %s=$2`, table, targetColumn), accountID, canonicalTargetID)
			if queryErr != nil {
				return nil, "", 0, queryErr
			}
			for rows.Next() {
				var userID uuid.UUID
				if scanErr := rows.Scan(&userID); scanErr != nil {
					rows.Close()
					return nil, "", 0, scanErr
				}
				existing[userID] = struct{}{}
			}
			if rowsErr := rows.Err(); rowsErr != nil {
				rows.Close()
				return nil, "", 0, rowsErr
			}
			rows.Close()
			newUserIDs := make([]uuid.UUID, 0, len(userIDs))
			for _, userID := range userIDs {
				if _, alreadyGranted := existing[userID]; !alreadyGranted {
					newUserIDs = append(newUserIDs, userID)
				}
			}
			if len(newUserIDs) > 0 {
				var environmentViewerCount int
				if err := tx.QueryRow(ctx, `SELECT COUNT(*)
					FROM user_accounts membership
					JOIN task_environments environment ON environment.account_id=membership.account_id AND environment.id=$3 AND environment.archived_at IS NULL
					WHERE membership.account_id=$1 AND membership.user_id=ANY($2::uuid[])
					  AND (`+environmentActorAccessRankSQL("environment", "membership.user_id")+`) >= 1`, accountID, newUserIDs, environmentID).Scan(&environmentViewerCount); err != nil {
					return nil, "", 0, err
				}
				if environmentViewerCount != len(newUserIDs) {
					return nil, "", 0, ErrTaskAccessInvalid
				}
			}
		}
	}
	beforeState, err := accessStateJSON(ctx, tx, accountID, table, targetColumn, canonicalTargetID, previousMode)
	if err != nil {
		return nil, "", 0, err
	}
	if _, err := tx.Exec(ctx, fmt.Sprintf(`DELETE FROM %s WHERE account_id=$1 AND %s=$2`, table, targetColumn), accountID, canonicalTargetID); err != nil {
		return nil, "", 0, err
	}
	for _, input := range inputs {
		if _, err := tx.Exec(ctx, fmt.Sprintf(`INSERT INTO %s(account_id,%s,user_id,access_level,can_manage_access,created_by)
			VALUES($1,$2,$3,$4,$5,$6)`, table, targetColumn), accountID, canonicalTargetID, input.UserID,
			input.AccessLevel, input.CanManageAccess, actorID); err != nil {
			return nil, "", 0, err
		}
	}
	if targetType == domain.TaskAccessTargetFolder {
		if err := tx.QueryRow(ctx, `UPDATE task_folders SET access_mode=$3,access_revision=access_revision+1,updated_at=NOW()
			WHERE account_id=$1 AND id=$2 RETURNING access_revision`, accountID, canonicalTargetID, currentMode).Scan(&lockedRevision); err != nil {
			return nil, "", 0, err
		}
	} else if targetType == domain.TaskAccessTargetList {
		if err := tx.QueryRow(ctx, `UPDATE task_lists SET access_mode=$3,access_revision=access_revision+1,updated_at=NOW()
			WHERE account_id=$1 AND id=$2 RETURNING access_revision`, accountID, canonicalTargetID, currentMode).Scan(&lockedRevision); err != nil {
			return nil, "", 0, err
		}
	} else if targetType == domain.TaskAccessTargetTask {
		if err := tx.QueryRow(ctx, `UPDATE tasks SET access_mode=$3,access_revision=COALESCE(access_revision,1)+1,
			version=COALESCE(version,1)+1,updated_at=NOW()
			WHERE account_id=$1 AND id=$2 AND parent_task_id IS NULL RETURNING access_revision`, accountID, canonicalTargetID, currentMode).Scan(&lockedRevision); err != nil {
			return nil, "", 0, err
		}
	} else {
		if err := tx.QueryRow(ctx, `UPDATE task_environments SET access_revision=access_revision+1,updated_at=NOW()
			WHERE account_id=$1 AND id=$2 RETURNING access_revision`, accountID, environmentID).Scan(&lockedRevision); err != nil {
			return nil, "", 0, err
		}
	}
	afterState, err := accessStateJSON(ctx, tx, accountID, table, targetColumn, canonicalTargetID, currentMode)
	if err != nil {
		return nil, "", 0, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO task_access_audit(account_id,actor_id,target_type,target_id,action,before_state,after_state,operation_id)
		VALUES($1,$2,$3,$4,'replace_grants',$5::jsonb,$6::jsonb,$7)`, accountID, actorID, targetType, canonicalTargetID,
		beforeState, afterState, operationID); err != nil {
		return nil, "", 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, "", 0, err
	}
	grants, returnedMode, returnedRevision, err := r.ListAccessGrants(ctx, accountID, targetType, canonicalTargetID)
	if err != nil {
		return nil, "", 0, err
	}
	return grants, returnedMode, returnedRevision, nil
}

func taskActorAdminSQL(taskAlias, actorExpression string) string {
	return fmt.Sprintf(`EXISTS(SELECT 1 FROM user_accounts actor_membership JOIN users actor_user ON actor_user.id=actor_membership.user_id
		WHERE actor_membership.account_id=%s.account_id AND actor_membership.user_id=%s
		  AND (actor_membership.role IN ('admin','super_admin') OR COALESCE(actor_user.is_admin,FALSE) OR COALESCE(actor_user.is_super_admin,FALSE)))`, taskAlias, actorExpression)
}

func taskAccessLevelRankSQL(levelExpression string) string {
	return fmt.Sprintf(`CASE COALESCE(%s,'none') WHEN 'full' THEN 4 WHEN 'edit' THEN 3 WHEN 'comment' THEN 2 WHEN 'view' THEN 1 ELSE 0 END`, levelExpression)
}

func taskActorEnvironmentAccessRankByResourceSQL(resourceAlias, actorExpression string) string {
	explicit := fmt.Sprintf(`(SELECT environment_grant.access_level FROM task_environment_grants environment_grant
		WHERE environment_grant.account_id=%s.account_id AND environment_grant.environment_id=%s.environment_id
		  AND environment_grant.user_id=%s)`, resourceAlias, resourceAlias, actorExpression)
	fallback := fmt.Sprintf(`(SELECT CASE WHEN environment.visibility='account' THEN environment.default_access_level ELSE 'none' END
		FROM task_environments environment WHERE environment.account_id=%s.account_id AND environment.id=%s.environment_id)`, resourceAlias, resourceAlias)
	return taskAccessLevelRankSQL("COALESCE(" + explicit + "," + fallback + ")")
}

func taskActorEnvironmentAccessRankSQL(listAlias, actorExpression string) string {
	return taskActorEnvironmentAccessRankByResourceSQL(listAlias, actorExpression)
}

func taskActorFolderAccessRankSQL(folderAlias, actorExpression string) string {
	grant := fmt.Sprintf(`(SELECT folder_grant.access_level FROM task_folder_access_grants folder_grant
		WHERE folder_grant.account_id=%s.account_id AND folder_grant.folder_id=%s.id AND folder_grant.user_id=%s)`, folderAlias, folderAlias, actorExpression)
	environmentRank := taskActorEnvironmentAccessRankByResourceSQL(folderAlias, actorExpression)
	resolved := taskAccessLevelRankSQL(fmt.Sprintf(`CASE WHEN COALESCE(%s.access_mode,'inherit')='private' THEN COALESCE(%s,'none') ELSE COALESCE(%s,
		CASE %s WHEN 4 THEN 'full' WHEN 3 THEN 'edit' WHEN 2 THEN 'comment' WHEN 1 THEN 'view' ELSE 'none' END) END`, folderAlias, grant, grant, environmentRank))
	return fmt.Sprintf(`CASE WHEN %s THEN 4 WHEN %s < 1 THEN 0 ELSE %s END`, taskActorAdminSQL(folderAlias, actorExpression), environmentRank, resolved)
}

func taskActorFolderCanManageSQL(folderAlias, actorExpression string) string {
	environmentRank := taskActorEnvironmentAccessRankByResourceSQL(folderAlias, actorExpression)
	return fmt.Sprintf(`CASE WHEN %s THEN TRUE WHEN %s < 1 THEN FALSE
		WHEN EXISTS(SELECT 1 FROM task_folder_access_grants direct_folder WHERE direct_folder.account_id=%s.account_id AND direct_folder.folder_id=%s.id AND direct_folder.user_id=%s)
		THEN COALESCE((SELECT direct_folder.can_manage_access FROM task_folder_access_grants direct_folder WHERE direct_folder.account_id=%s.account_id AND direct_folder.folder_id=%s.id AND direct_folder.user_id=%s),FALSE)
		WHEN COALESCE(%s.access_mode,'inherit')='private' THEN FALSE
		ELSE COALESCE((SELECT environment_grant.can_manage_access FROM task_environment_grants environment_grant WHERE environment_grant.account_id=%s.account_id AND environment_grant.environment_id=%s.environment_id AND environment_grant.user_id=%s),FALSE) END`,
		taskActorAdminSQL(folderAlias, actorExpression), environmentRank,
		folderAlias, folderAlias, actorExpression, folderAlias, folderAlias, actorExpression, folderAlias,
		folderAlias, folderAlias, actorExpression)
}

func taskActorFolderAccessLevelSQL(listAlias, actorExpression string) string {
	grant := fmt.Sprintf(`(SELECT folder_grant.access_level FROM task_folder_access_grants folder_grant
		WHERE folder_grant.account_id=%s.account_id AND folder_grant.folder_id=%s.folder_id
		  AND folder_grant.user_id=%s)`, listAlias, listAlias, actorExpression)
	mode := fmt.Sprintf(`COALESCE((SELECT folder.access_mode FROM task_folders folder
		WHERE folder.account_id=%s.account_id AND folder.id=%s.folder_id),'inherit')`, listAlias, listAlias)
	environmentLevel := fmt.Sprintf(`CASE %s WHEN 4 THEN 'full' WHEN 3 THEN 'edit' WHEN 2 THEN 'comment' WHEN 1 THEN 'view' ELSE 'none' END`, taskActorEnvironmentAccessRankSQL(listAlias, actorExpression))
	return fmt.Sprintf(`CASE WHEN %s.folder_id IS NULL THEN %s WHEN %s='private' THEN COALESCE(%s,'none') ELSE COALESCE(%s,%s) END`,
		listAlias, environmentLevel, mode, grant, grant, environmentLevel)
}

func taskActorListAccessLevelSQL(listAlias, actorExpression string) string {
	grant := fmt.Sprintf(`(SELECT list_grant.access_level FROM task_list_access_grants list_grant
		WHERE list_grant.account_id=%s.account_id AND list_grant.list_id=%s.id
		  AND list_grant.user_id=%s)`, listAlias, listAlias, actorExpression)
	return fmt.Sprintf(`CASE WHEN COALESCE(%s.access_mode,'inherit')='private' THEN COALESCE(%s,'none') ELSE COALESCE(%s,%s) END`,
		listAlias, grant, grant, taskActorFolderAccessLevelSQL(listAlias, actorExpression))
}

func taskActorListAccessRankSQL(listAlias, actorExpression string) string {
	environmentRank := taskActorEnvironmentAccessRankSQL(listAlias, actorExpression)
	resolved := taskAccessLevelRankSQL(taskActorListAccessLevelSQL(listAlias, actorExpression))
	return fmt.Sprintf(`CASE WHEN %s THEN 4 WHEN %s < 1 THEN 0 ELSE %s END`, taskActorAdminSQL(listAlias, actorExpression), environmentRank, resolved)
}

func taskActorListCanManageSQL(listAlias, actorExpression string) string {
	environmentRank := taskActorEnvironmentAccessRankSQL(listAlias, actorExpression)
	return fmt.Sprintf(`CASE WHEN %s THEN TRUE WHEN %s < 1 THEN FALSE
		WHEN EXISTS(SELECT 1 FROM task_list_access_grants direct_list WHERE direct_list.account_id=%s.account_id AND direct_list.list_id=%s.id AND direct_list.user_id=%s)
		THEN COALESCE((SELECT direct_list.can_manage_access FROM task_list_access_grants direct_list WHERE direct_list.account_id=%s.account_id AND direct_list.list_id=%s.id AND direct_list.user_id=%s),FALSE)
		WHEN COALESCE(%s.access_mode,'inherit')='private' THEN FALSE
		WHEN %s.folder_id IS NOT NULL THEN COALESCE((SELECT direct_folder.can_manage_access FROM task_folder_access_grants direct_folder WHERE direct_folder.account_id=%s.account_id AND direct_folder.folder_id=%s.folder_id AND direct_folder.user_id=%s),
			CASE WHEN COALESCE((SELECT folder.access_mode FROM task_folders folder WHERE folder.account_id=%s.account_id AND folder.id=%s.folder_id),'inherit')='private' THEN FALSE
			ELSE COALESCE((SELECT environment_grant.can_manage_access FROM task_environment_grants environment_grant WHERE environment_grant.account_id=%s.account_id AND environment_grant.environment_id=%s.environment_id AND environment_grant.user_id=%s),FALSE) END)
		ELSE COALESCE((SELECT environment_grant.can_manage_access FROM task_environment_grants environment_grant WHERE environment_grant.account_id=%s.account_id AND environment_grant.environment_id=%s.environment_id AND environment_grant.user_id=%s),FALSE) END`,
		taskActorAdminSQL(listAlias, actorExpression), environmentRank,
		listAlias, listAlias, actorExpression, listAlias, listAlias, actorExpression, listAlias,
		listAlias, listAlias, listAlias, actorExpression, listAlias, listAlias,
		listAlias, listAlias, actorExpression, listAlias, listAlias, actorExpression)
}

func taskActorAccessRankSQL(taskAlias, listAlias, actorExpression string) string {
	taskGrant := fmt.Sprintf(`(SELECT direct_grant.access_level FROM task_access_grants direct_grant
		WHERE direct_grant.account_id=%s.account_id AND direct_grant.task_id=COALESCE(%s.parent_task_id,%s.id)
		  AND direct_grant.user_id=%s)`, taskAlias, taskAlias, taskAlias, actorExpression)
	accessMode := fmt.Sprintf(`COALESCE((SELECT root.access_mode FROM tasks root WHERE root.account_id=%s.account_id AND root.id=COALESCE(%s.parent_task_id,%s.id)),'inherit')`, taskAlias, taskAlias, taskAlias)
	inheritedLevel := fmt.Sprintf(`CASE WHEN %s='private' THEN 'none' ELSE %s END`, accessMode, taskActorListAccessLevelSQL(listAlias, actorExpression))
	resolvedRank := taskAccessLevelRankSQL("COALESCE(" + taskGrant + "," + inheritedLevel + ")")
	return fmt.Sprintf(`CASE WHEN %s THEN 4 WHEN %s < 1 THEN 0 ELSE %s END`, taskActorAdminSQL(taskAlias, actorExpression), taskActorEnvironmentAccessRankSQL(listAlias, actorExpression), resolvedRank)
}

func taskActorCanViewIncludingArchivedSQL(taskAlias, listAlias, actorExpression string) string {
	return "(" + taskActorAccessRankSQL(taskAlias, listAlias, actorExpression) + ") >= 1"
}

func taskActorCanViewSQL(taskAlias, listAlias, actorExpression string) string {
	activeEnvironment := fmt.Sprintf(`EXISTS(SELECT 1 FROM task_environments active_environment
		WHERE active_environment.account_id=%s.account_id AND active_environment.id=%s.environment_id
		  AND active_environment.archived_at IS NULL)`, listAlias, listAlias)
	return activeEnvironment + " AND " + taskActorCanViewIncludingArchivedSQL(taskAlias, listAlias, actorExpression)
}

// TaskActorCanViewSQL exposes the canonical Work visibility predicate to the
// small number of bounded operational queries that live outside repository.
// Callers must join taskAlias to listAlias within the same account and pass a
// parameter expression (never raw user input) as actorExpression.
func TaskActorCanViewSQL(taskAlias, listAlias, actorExpression string) string {
	return taskActorCanViewSQL(taskAlias, listAlias, actorExpression)
}

func taskActorDirectSharedSQL(taskAlias, listAlias, actorExpression string) string {
	directRank := taskAccessLevelRankSQL(fmt.Sprintf(`(SELECT direct_grant.access_level FROM task_access_grants direct_grant
		WHERE direct_grant.account_id=%s.account_id AND direct_grant.task_id=COALESCE(%s.parent_task_id,%s.id)
		  AND direct_grant.user_id=%s)`, taskAlias, taskAlias, taskAlias, actorExpression))
	return fmt.Sprintf(`(%s >= 1 AND %s >= 1)`, directRank, taskActorEnvironmentAccessRankSQL(listAlias, actorExpression))
}

func taskAccessBatchSQL() string {
	return `SELECT task.id,environment.id,COALESCE(root.access_mode,'inherit'),
		(membership.role IN ('admin','super_admin') OR COALESCE(account_user.is_admin,FALSE) OR COALESCE(account_user.is_super_admin,FALSE)) AS is_admin,
		environment.visibility,environment.default_access_level,
		environment_grant.access_level,environment_grant.can_manage_access,
		folder.access_mode,folder_grant.access_level,folder_grant.can_manage_access,
		COALESCE(list_item.access_mode,'inherit'),list_grant.access_level,list_grant.can_manage_access,
		task_grant.access_level,task_grant.can_manage_access
	FROM tasks task
	JOIN tasks root ON root.account_id=task.account_id AND root.id=COALESCE(task.parent_task_id,task.id)
	JOIN task_lists list_item ON list_item.account_id=task.account_id AND list_item.id=task.list_id
	LEFT JOIN task_folders folder ON folder.account_id=list_item.account_id AND folder.id=list_item.folder_id
	JOIN task_environments environment ON environment.account_id=list_item.account_id AND environment.id=list_item.environment_id
	JOIN user_accounts membership ON membership.account_id=task.account_id AND membership.user_id=$3
	JOIN users account_user ON account_user.id=membership.user_id
	LEFT JOIN task_environment_grants environment_grant ON environment_grant.account_id=environment.account_id
		AND environment_grant.environment_id=environment.id AND environment_grant.user_id=membership.user_id
	LEFT JOIN task_folder_access_grants folder_grant ON folder_grant.account_id=folder.account_id
		AND folder_grant.folder_id=folder.id AND folder_grant.user_id=membership.user_id
	LEFT JOIN task_list_access_grants list_grant ON list_grant.account_id=list_item.account_id
		AND list_grant.list_id=list_item.id AND list_grant.user_id=membership.user_id
	LEFT JOIN task_access_grants task_grant ON task_grant.account_id=root.account_id
		AND task_grant.task_id=root.id AND task_grant.user_id=membership.user_id
	WHERE task.account_id=$1 AND task.id=ANY($2::uuid[]) AND environment.archived_at IS NULL
	ORDER BY task.id`
}

func (r *TaskWorkRepository) ApplyTaskAccess(ctx context.Context, accountID, userID uuid.UUID, tasks []*domain.Task) error {
	if len(tasks) == 0 {
		return nil
	}
	ids := make([]uuid.UUID, 0, len(tasks))
	byID := make(map[uuid.UUID]*domain.Task, len(tasks))
	for _, task := range tasks {
		if task != nil {
			ids = append(ids, task.ID)
			byID[task.ID] = task
		}
	}
	rows, err := r.db.Query(ctx, taskAccessBatchSQL(), accountID, ids, userID)
	if err != nil {
		return err
	}
	resolvedIDs := make(map[uuid.UUID]struct{}, len(ids))
	for rows.Next() {
		var id, environmentID uuid.UUID
		var accessMode, visibility, defaultLevel, listMode string
		var folderMode *string
		var admin bool
		var environmentGrantLevel, folderGrantLevel, listGrantLevel, taskGrantLevel *string
		var environmentGrantManage, folderGrantManage, listGrantManage, taskGrantManage *bool
		if err := rows.Scan(&id, &environmentID, &accessMode, &admin, &visibility, &defaultLevel,
			&environmentGrantLevel, &environmentGrantManage,
			&folderMode, &folderGrantLevel, &folderGrantManage,
			&listMode, &listGrantLevel, &listGrantManage,
			&taskGrantLevel, &taskGrantManage); err != nil {
			rows.Close()
			return err
		}
		resolvedIDs[id] = struct{}{}
		task := byID[id]
		if task == nil {
			continue
		}
		environmentLevel := domain.TaskAccessNone
		environmentManage := false
		environmentSource := "environment_private"
		if environmentGrantLevel != nil {
			environmentLevel = *environmentGrantLevel
			environmentManage = environmentGrantManage != nil && *environmentGrantManage
			environmentSource = "environment_grant"
		} else if visibility == "account" {
			environmentLevel = defaultLevel
			environmentSource = "environment_default"
		}
		environmentView := taskAccessRank(environmentLevel) >= taskAccessRank(domain.TaskAccessView)
		folderVisible, listVisible := false, false
		if admin {
			task.SetEffectiveAccess(buildTaskEffectiveAccess(domain.TaskAccessFull, true, "account_admin"))
			environmentView = true
			folderVisible, listVisible = true, true
		} else {
			state := taskHierarchyAccessState{
				EnvironmentLevel: environmentLevel, EnvironmentManage: environmentManage, EnvironmentSource: environmentSource,
				ListMode: listMode, TaskMode: accessMode,
				FolderLevel: folderGrantLevel, FolderManage: folderGrantManage,
				ListLevel: listGrantLevel, ListManage: listGrantManage,
				TaskLevel: taskGrantLevel, TaskManage: taskGrantManage,
			}
			if folderMode != nil {
				state.FolderMode = *folderMode
			}
			access, resolvedFolderVisible, resolvedListVisible := resolveTaskHierarchyAccess(state)
			task.SetEffectiveAccess(access)
			folderVisible, listVisible = resolvedFolderVisible, resolvedListVisible
		}
		task.BreadcrumbsVisible = environmentView && folderVisible && listVisible
		if task.Permissions.CanView && !task.BreadcrumbsVisible {
			if !environmentView {
				task.EnvironmentID = nil
			}
			task.ListID = nil
			task.ListName = ""
			task.FolderID = nil
			task.FolderName = ""
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	for id, task := range byID {
		if _, ok := resolvedIDs[id]; ok {
			continue
		}
		// Missing membership/cross-account rows are explicitly non-visible so a
		// reused domain object can never retain stale permissions.
		task.SetEffectiveAccess(buildTaskEffectiveAccess(domain.TaskAccessNone, false, "not_visible"))
		task.BreadcrumbsVisible = false
		task.EnvironmentID = nil
		task.ListID = nil
		task.ListName = ""
		task.FolderID = nil
		task.FolderName = ""
	}
	return nil
}

func (r *TaskWorkRepository) ApplyFolderAccess(ctx context.Context, accountID, userID uuid.UUID, folders []*domain.TaskFolder) error {
	ids := make([]uuid.UUID, 0, len(folders))
	byID := make(map[uuid.UUID]*domain.TaskFolder, len(folders))
	for _, folder := range folders {
		if folder != nil {
			ids, byID[folder.ID] = append(ids, folder.ID), folder
		}
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := r.db.Query(ctx, `SELECT folder.id,(`+taskActorFolderAccessRankSQL("folder", "$3")+`),(`+taskActorFolderCanManageSQL("folder", "$3")+`)
		FROM task_folders folder JOIN task_environments environment ON environment.account_id=folder.account_id AND environment.id=folder.environment_id AND environment.archived_at IS NULL
		WHERE folder.account_id=$1 AND folder.id=ANY($2::uuid[])`, accountID, ids, userID)
	if err != nil {
		return err
	}
	defer rows.Close()
	seen := make(map[uuid.UUID]struct{}, len(ids))
	for rows.Next() {
		var id uuid.UUID
		var rank int
		var manage bool
		if err := rows.Scan(&id, &rank, &manage); err != nil {
			return err
		}
		seen[id] = struct{}{}
		byID[id].SetEffectiveAccess(buildTaskEffectiveAccess(taskAccessLevelFromRank(rank), manage, "folder_policy"))
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for id, folder := range byID {
		if _, ok := seen[id]; !ok {
			folder.SetEffectiveAccess(buildTaskEffectiveAccess(domain.TaskAccessNone, false, "not_visible"))
		}
	}
	return nil
}

func (r *TaskWorkRepository) ApplyListAccess(ctx context.Context, accountID, userID uuid.UUID, lists []*domain.TaskList) error {
	ids := make([]uuid.UUID, 0, len(lists))
	byID := make(map[uuid.UUID]*domain.TaskList, len(lists))
	for _, list := range lists {
		if list != nil {
			ids, byID[list.ID] = append(ids, list.ID), list
		}
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := r.db.Query(ctx, `SELECT list_item.id,(`+taskActorListAccessRankSQL("list_item", "$3")+`),(`+taskActorListCanManageSQL("list_item", "$3")+`)
		FROM task_lists list_item JOIN task_environments environment ON environment.account_id=list_item.account_id AND environment.id=list_item.environment_id AND environment.archived_at IS NULL
		WHERE list_item.account_id=$1 AND list_item.id=ANY($2::uuid[])`, accountID, ids, userID)
	if err != nil {
		return err
	}
	defer rows.Close()
	seen := make(map[uuid.UUID]struct{}, len(ids))
	for rows.Next() {
		var id uuid.UUID
		var rank int
		var manage bool
		if err := rows.Scan(&id, &rank, &manage); err != nil {
			return err
		}
		seen[id] = struct{}{}
		byID[id].SetEffectiveAccess(buildTaskEffectiveAccess(taskAccessLevelFromRank(rank), manage, "list_policy"))
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for id, list := range byID {
		if _, ok := seen[id]; !ok {
			list.SetEffectiveAccess(buildTaskEffectiveAccess(domain.TaskAccessNone, false, "not_visible"))
		}
	}
	return nil
}

func (r *TaskWorkRepository) TaskViewerUserIDs(ctx context.Context, accountID, taskID uuid.UUID) ([]uuid.UUID, error) {
	rows, err := r.db.Query(ctx, `SELECT membership.user_id
		FROM tasks t
		JOIN task_lists tl ON tl.account_id=t.account_id AND tl.id=t.list_id
		JOIN task_environments environment ON environment.account_id=tl.account_id AND environment.id=tl.environment_id AND environment.archived_at IS NULL
		JOIN user_accounts membership ON membership.account_id=t.account_id
		WHERE t.account_id=$1 AND t.id=$2 AND `+taskActorCanViewSQL("t", "tl", "membership.user_id")+`
		ORDER BY membership.user_id`, accountID, taskID)
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

func (r *TaskWorkRepository) ContainerViewerUserIDs(ctx context.Context, accountID, targetID uuid.UUID, targetType string) ([]uuid.UUID, error) {
	query := ""
	if targetType == domain.TaskAccessTargetFolder {
		query = `SELECT membership.user_id FROM task_folders folder
			JOIN task_environments environment ON environment.account_id=folder.account_id AND environment.id=folder.environment_id AND environment.archived_at IS NULL
			JOIN user_accounts membership ON membership.account_id=folder.account_id
			WHERE folder.account_id=$1 AND folder.id=$2 AND (` + taskActorFolderAccessRankSQL("folder", "membership.user_id") + `) >= 1
			ORDER BY membership.user_id`
	} else if targetType == domain.TaskAccessTargetList {
		query = `SELECT membership.user_id FROM task_lists list_item
			JOIN task_environments environment ON environment.account_id=list_item.account_id AND environment.id=list_item.environment_id AND environment.archived_at IS NULL
			JOIN user_accounts membership ON membership.account_id=list_item.account_id
			WHERE list_item.account_id=$1 AND list_item.id=$2 AND (` + taskActorListAccessRankSQL("list_item", "membership.user_id") + `) >= 1
			ORDER BY membership.user_id`
	} else {
		return nil, ErrTaskAccessInvalid
	}
	rows, err := r.db.Query(ctx, query, accountID, targetID)
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

func marshalTaskAccessState(accessMode string, inputs []TaskAccessGrantInput) []byte {
	payload, _ := json.Marshal(map[string]any{"access_mode": accessMode, "grants": inputs})
	return payload
}
