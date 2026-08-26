package repository

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

// lockActiveWhiteboardTenantTx is the creation-side serialization gate. New
// boards do not yet have a row that an account/subscription transition can
// lock, so creators take a shared authority lock before inserting anything.
// Account deactivation and Subscription.Upsert take the conflicting row lock
// before advancing existing board/view revisions, giving one canonical order.
func lockActiveWhiteboardTenantTx(ctx context.Context, tx pgx.Tx, accountID uuid.UUID) error {
	var lockedAccountID uuid.UUID
	err := tx.QueryRow(ctx, `SELECT account.id FROM accounts account
		WHERE account.id=$1 AND COALESCE(account.is_active,TRUE)
		FOR SHARE`, accountID).Scan(&lockedAccountID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrWhiteboardNotFound
	}
	if err != nil {
		return err
	}

	// Use a second statement instead of a combined join lock. PostgreSQL's
	// join plan does not provide a durable cross-table row-lock order, while
	// subscription transitions explicitly use account -> subscription.
	var lockedSubscriptionAccountID uuid.UUID
	err = tx.QueryRow(ctx, `SELECT account_subscription.account_id
		FROM subscriptions account_subscription
		WHERE account_subscription.account_id=$1
		AND (
			(account_subscription.status='active' AND (account_subscription.current_period_end IS NULL OR account_subscription.current_period_end>=CURRENT_TIMESTAMP)) OR
			(account_subscription.status='trialing' AND (account_subscription.trial_ends_at IS NULL OR account_subscription.trial_ends_at>=CURRENT_TIMESTAMP)) OR
			(account_subscription.status='grace' AND (account_subscription.grace_ends_at IS NULL OR account_subscription.grace_ends_at>=CURRENT_TIMESTAMP))
		) FOR SHARE`, accountID).Scan(&lockedSubscriptionAccountID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrWhiteboardNotFound
	}
	return err
}

// requireActiveWhiteboardTenantWith is the post-resource-lock variant. It does
// not acquire authority-row locks (which would invert the global
// authority->view->board order); a fresh READ COMMITTED statement is enough
// because every authority transition waits on the already-held board/view.
func requireActiveWhiteboardTenantWith(ctx context.Context, q whiteboardQuerier, accountID uuid.UUID) error {
	var allowed bool
	err := q.QueryRow(ctx, `SELECT EXISTS(
		SELECT 1 FROM accounts account
		JOIN subscriptions account_subscription ON account_subscription.account_id=account.id
		WHERE account.id=$1 AND COALESCE(account.is_active,TRUE)
		AND (
			(account_subscription.status='active' AND (account_subscription.current_period_end IS NULL OR account_subscription.current_period_end>=CURRENT_TIMESTAMP)) OR
			(account_subscription.status='trialing' AND (account_subscription.trial_ends_at IS NULL OR account_subscription.trial_ends_at>=CURRENT_TIMESTAMP)) OR
			(account_subscription.status='grace' AND (account_subscription.grace_ends_at IS NULL OR account_subscription.grace_ends_at>=CURRENT_TIMESTAMP))
		))`, accountID).Scan(&allowed)
	if err != nil {
		return err
	}
	if !allowed {
		return ErrWhiteboardNotFound
	}
	return nil
}

// whiteboardActorAccessQuery resolves standalone and Work-origin authorization
// from the same account-scoped row. A contextual board deliberately ignores
// whiteboards.created_by, access_mode and direct grants; its sole authority is
// the owning Work container plus both module permissions.
const whiteboardActorAccessQuery = `
	SELECT board.created_by,board.access_mode,board.archived_at,
		grant_item.access_level,grant_item.can_manage_access,
		membership.user_id IS NOT NULL,COALESCE(membership.role,''),COALESCE(role_item.permissions,'{}'::text[]),
		COALESCE(account_user.is_super_admin,FALSE),
		work_view.id,work_view.environment_id,work_view.folder_id,work_view.list_id,work_view.deleted_at,
		environment.id,COALESCE(environment.name,''),COALESCE(environment.visibility,''),
		COALESCE(environment.default_access_level,'none'),environment.archived_at,environment.deleted_at,
		environment_grant.access_level,environment_grant.can_manage_access,
		folder.id,COALESCE(folder.name,''),folder.access_mode,folder.archived_at,folder.deleted_at,
		folder_grant.access_level,folder_grant.can_manage_access,
		list_item.id,COALESCE(list_item.name,''),list_item.access_mode,list_item.archived_at,list_item.deleted_at,
		list_grant.access_level,list_grant.can_manage_access
	FROM whiteboards board
	JOIN accounts tenant_account ON tenant_account.id=board.account_id
		AND COALESCE(tenant_account.is_active,TRUE)
	JOIN subscriptions tenant_subscription ON tenant_subscription.account_id=board.account_id
		AND (
			(tenant_subscription.status='active' AND (tenant_subscription.current_period_end IS NULL OR tenant_subscription.current_period_end>=CURRENT_TIMESTAMP)) OR
			(tenant_subscription.status='trialing' AND (tenant_subscription.trial_ends_at IS NULL OR tenant_subscription.trial_ends_at>=CURRENT_TIMESTAMP)) OR
			(tenant_subscription.status='grace' AND (tenant_subscription.grace_ends_at IS NULL OR tenant_subscription.grace_ends_at>=CURRENT_TIMESTAMP))
		)
	JOIN users account_user ON account_user.id=$2 AND account_user.is_active
	LEFT JOIN user_accounts membership ON membership.account_id=board.account_id AND membership.user_id=$2
	LEFT JOIN roles role_item ON role_item.id=membership.role_id
	LEFT JOIN whiteboard_grants grant_item ON grant_item.account_id=board.account_id
		AND grant_item.board_id=board.id AND grant_item.user_id=$2
	LEFT JOIN task_location_whiteboard_views work_binding ON work_binding.account_id=board.account_id
		AND work_binding.whiteboard_id=board.id
	LEFT JOIN task_location_views work_view ON work_view.account_id=work_binding.account_id
		AND work_view.id=work_binding.task_view_id AND work_view.view_type='whiteboard'
	LEFT JOIN task_environments environment ON environment.account_id=work_view.account_id
		AND environment.id=work_view.environment_id
	LEFT JOIN task_environment_grants environment_grant ON environment_grant.account_id=environment.account_id
		AND environment_grant.environment_id=environment.id AND environment_grant.user_id=$2
	LEFT JOIN task_lists list_item ON list_item.account_id=work_view.account_id AND list_item.id=work_view.list_id
	LEFT JOIN task_folders folder ON folder.account_id=work_view.account_id
		AND folder.id=COALESCE(work_view.folder_id,list_item.folder_id)
	LEFT JOIN task_folder_access_grants folder_grant ON folder_grant.account_id=folder.account_id
		AND folder_grant.folder_id=folder.id AND folder_grant.user_id=$2
	LEFT JOIN task_list_access_grants list_grant ON list_grant.account_id=list_item.account_id
		AND list_grant.list_id=list_item.id AND list_grant.user_id=$2
	WHERE board.account_id=$1 AND board.id=$3
		AND (membership.user_id IS NOT NULL OR account_user.account_id=$1)`

// whiteboardHubAccessCTE performs the same Work inheritance in one bounded
// query for Hub lists/counts. Keeping this actor-aware projection in SQL avoids
// an N+1 authorization pass and, importantly, never materializes an
// inaccessible parent breadcrumb in Go.
const whiteboardHubAccessCTE = `WITH hub_base AS (
	SELECT ` + whiteboardSelectColumns + `,
		COALESCE(board_folder.name,'') AS folder_name,
		COALESCE(NULLIF(creator.display_name,''),creator.username,'') AS owner_name,
		COALESCE(NULLIF(updater.display_name,''),updater.username,'') AS updated_by_name,
		work_view.id AS task_view_id,work_view.environment_id AS work_environment_id,
		work_view.folder_id AS view_folder_id,work_view.list_id AS view_list_id,work_view.deleted_at AS view_deleted_at,
		environment.id AS resolved_environment_id,COALESCE(environment.name,'') AS environment_name,
		environment.archived_at AS environment_archived_at,environment.deleted_at AS environment_deleted_at,
		work_folder.id AS work_folder_id,COALESCE(work_folder.name,'') AS work_folder_name,
		work_folder.archived_at AS work_folder_archived_at,work_folder.deleted_at AS work_folder_deleted_at,
		work_list.id AS work_list_id,COALESCE(work_list.name,'') AS work_list_name,
		work_list.archived_at AS work_list_archived_at,work_list.deleted_at AS work_list_deleted_at,
		work_identity.work_admin,work_identity.has_work_modules,
		CASE
			WHEN COALESCE(account_user.is_super_admin,FALSE) OR COALESCE(membership.role,'') IN ('admin','super_admin') THEN 'manage'
			WHEN board.created_by=$2 THEN 'manage'
			WHEN board_grant.access_level IS NOT NULL THEN board_grant.access_level
			WHEN board.access_mode='account' THEN 'view'
			ELSE 'none'
		END AS standalone_level,
		CASE
			WHEN COALESCE(account_user.is_super_admin,FALSE) OR COALESCE(membership.role,'') IN ('admin','super_admin') THEN TRUE
			WHEN board.created_by=$2 THEN TRUE
			ELSE COALESCE(board_grant.can_manage_access,FALSE)
		END AS standalone_manage,
		CASE
			WHEN COALESCE(account_user.is_super_admin,FALSE) OR COALESCE(membership.role,'') IN ('admin','super_admin') THEN 'account_admin'
			WHEN board.created_by=$2 THEN 'creator'
			WHEN board_grant.access_level IS NOT NULL THEN 'direct_grant'
			WHEN board.access_mode='account' THEN 'account_visibility'
			ELSE 'private'
		END AS standalone_source,
		CASE
			WHEN work_identity.work_admin THEN 'full'
			WHEN environment_grant.access_level IS NOT NULL THEN environment_grant.access_level
			WHEN environment.visibility='account' THEN environment.default_access_level
			ELSE 'none'
		END AS environment_level,
		CASE
			WHEN work_identity.work_admin THEN TRUE
			WHEN environment_grant.access_level IS NOT NULL THEN COALESCE(environment_grant.can_manage_access,FALSE)
			ELSE FALSE
		END AS environment_manage,
		CASE
			WHEN work_identity.work_admin THEN 'account_admin'
			WHEN environment_grant.access_level IS NOT NULL THEN 'environment_grant'
			WHEN environment.visibility='account' THEN 'environment_default'
			ELSE 'environment_private'
		END AS environment_source,
		work_folder.access_mode AS work_folder_mode,folder_grant.access_level AS work_folder_grant_level,
		folder_grant.can_manage_access AS work_folder_grant_manage,
		work_list.access_mode AS work_list_mode,list_grant.access_level AS work_list_grant_level,
		list_grant.can_manage_access AS work_list_grant_manage
	FROM whiteboards board
	JOIN accounts tenant_account ON tenant_account.id=board.account_id
		AND COALESCE(tenant_account.is_active,TRUE)
	JOIN subscriptions tenant_subscription ON tenant_subscription.account_id=board.account_id
		AND (
			(tenant_subscription.status='active' AND (tenant_subscription.current_period_end IS NULL OR tenant_subscription.current_period_end>=CURRENT_TIMESTAMP)) OR
			(tenant_subscription.status='trialing' AND (tenant_subscription.trial_ends_at IS NULL OR tenant_subscription.trial_ends_at>=CURRENT_TIMESTAMP)) OR
			(tenant_subscription.status='grace' AND (tenant_subscription.grace_ends_at IS NULL OR tenant_subscription.grace_ends_at>=CURRENT_TIMESTAMP))
		)
	JOIN users account_user ON account_user.id=$2 AND account_user.is_active
	LEFT JOIN user_accounts membership ON membership.account_id=board.account_id AND membership.user_id=$2
	LEFT JOIN roles role_item ON role_item.id=membership.role_id
	LEFT JOIN LATERAL (SELECT COALESCE(role_item.permissions,'{}'::text[]) AS permissions) domain_permission ON TRUE
	LEFT JOIN LATERAL (SELECT
		(membership.user_id IS NOT NULL AND (
			COALESCE(account_user.is_super_admin,FALSE)
			OR COALESCE(membership.role,'') IN ('admin','super_admin')
		)) AS work_admin,
		(membership.user_id IS NOT NULL AND (
			COALESCE(account_user.is_super_admin,FALSE)
			OR COALESCE(membership.role,'') IN ('admin','super_admin') OR
			((domain_permission.permissions @> ARRAY['tasks']::text[] OR domain_permission.permissions @> ARRAY['*']::text[])
			AND (domain_permission.permissions @> ARRAY['whiteboards']::text[] OR domain_permission.permissions @> ARRAY['*']::text[]))
		)) AS has_work_modules
	) work_identity ON TRUE
	LEFT JOIN whiteboard_grants board_grant ON board_grant.account_id=board.account_id
		AND board_grant.board_id=board.id AND board_grant.user_id=$2
	LEFT JOIN whiteboard_folders board_folder ON board_folder.account_id=board.account_id AND board_folder.id=board.folder_id
	LEFT JOIN users creator ON creator.id=board.created_by
	LEFT JOIN users updater ON updater.id=board.updated_by
	LEFT JOIN task_location_whiteboard_views work_binding ON work_binding.account_id=board.account_id
		AND work_binding.whiteboard_id=board.id
	LEFT JOIN task_location_views work_view ON work_view.account_id=work_binding.account_id
		AND work_view.id=work_binding.task_view_id AND work_view.view_type='whiteboard'
	LEFT JOIN task_environments environment ON environment.account_id=work_view.account_id
		AND environment.id=work_view.environment_id
	LEFT JOIN task_environment_grants environment_grant ON environment_grant.account_id=environment.account_id
		AND environment_grant.environment_id=environment.id AND environment_grant.user_id=$2
	LEFT JOIN task_lists work_list ON work_list.account_id=work_view.account_id AND work_list.id=work_view.list_id
	LEFT JOIN task_folders work_folder ON work_folder.account_id=work_view.account_id
		AND work_folder.id=COALESCE(work_view.folder_id,work_list.folder_id)
	LEFT JOIN task_folder_access_grants folder_grant ON folder_grant.account_id=work_folder.account_id
		AND folder_grant.folder_id=work_folder.id AND folder_grant.user_id=$2
	LEFT JOIN task_list_access_grants list_grant ON list_grant.account_id=work_list.account_id
		AND list_grant.list_id=work_list.id AND list_grant.user_id=$2
	WHERE board.account_id=$1 AND (membership.user_id IS NOT NULL OR account_user.account_id=$1)
), hub_folder_access AS (
	SELECT hub_base.*,
		CASE
			WHEN task_view_id IS NULL THEN 'none'
			WHEN work_admin THEN 'full'
			WHEN environment_level NOT IN ('view','comment','edit','full') THEN 'none'
			WHEN work_folder_id IS NULL THEN environment_level
			WHEN work_folder_grant_level IS NOT NULL THEN work_folder_grant_level
			WHEN COALESCE(work_folder_mode,'inherit')='private' THEN 'none'
			ELSE environment_level
		END AS work_folder_level,
		CASE
			WHEN task_view_id IS NULL THEN FALSE
			WHEN work_admin THEN TRUE
			WHEN environment_level NOT IN ('view','comment','edit','full') THEN FALSE
			WHEN work_folder_id IS NULL THEN environment_manage
			WHEN work_folder_grant_level IS NOT NULL THEN COALESCE(work_folder_grant_manage,FALSE)
			WHEN COALESCE(work_folder_mode,'inherit')='private' THEN FALSE
			ELSE environment_manage
		END AS work_folder_manage,
		CASE
			WHEN work_admin THEN 'account_admin'
			WHEN environment_level NOT IN ('view','comment','edit','full') THEN 'environment_required'
			WHEN work_folder_id IS NULL THEN environment_source
			WHEN work_folder_grant_level IS NOT NULL THEN 'folder_grant'
			WHEN COALESCE(work_folder_mode,'inherit')='private' THEN 'folder_private'
			ELSE environment_source
		END AS work_folder_source
	FROM hub_base
), hub_list_access AS (
	SELECT hub_folder_access.*,
		CASE
			WHEN task_view_id IS NULL THEN 'none'
			WHEN work_admin THEN 'full'
			WHEN environment_level NOT IN ('view','comment','edit','full') THEN 'none'
			WHEN work_list_id IS NULL THEN work_folder_level
			WHEN work_list_grant_level IS NOT NULL THEN work_list_grant_level
			WHEN COALESCE(work_list_mode,'inherit')='private' THEN 'none'
			ELSE work_folder_level
		END AS work_target_level,
		CASE
			WHEN task_view_id IS NULL THEN FALSE
			WHEN work_admin THEN TRUE
			WHEN environment_level NOT IN ('view','comment','edit','full') THEN FALSE
			WHEN work_list_id IS NULL THEN work_folder_manage
			WHEN work_list_grant_level IS NOT NULL THEN COALESCE(work_list_grant_manage,FALSE)
			WHEN COALESCE(work_list_mode,'inherit')='private' THEN FALSE
			ELSE work_folder_manage
		END AS work_target_manage,
		CASE
			WHEN work_admin THEN 'account_admin'
			WHEN environment_level NOT IN ('view','comment','edit','full') THEN 'environment_required'
			WHEN work_list_id IS NULL THEN work_folder_source
			WHEN work_list_grant_level IS NOT NULL THEN 'list_grant'
			WHEN COALESCE(work_list_mode,'inherit')='private' THEN 'list_private'
			ELSE work_folder_source
		END AS work_target_source,
		(work_folder_id IS NULL OR work_folder_level IN ('view','comment','edit','full')) AS work_folder_visible
	FROM hub_folder_access
), visible AS (
	SELECT hub_list_access.*,
		CASE
			WHEN task_view_id IS NULL THEN standalone_level
			WHEN NOT has_work_modules OR resolved_environment_id IS NULL
				OR (view_folder_id IS NULL)=(view_list_id IS NULL)
				OR (view_folder_id IS NOT NULL AND work_folder_id IS NULL)
				OR (view_list_id IS NOT NULL AND work_list_id IS NULL)
				OR environment_deleted_at IS NOT NULL OR work_folder_deleted_at IS NOT NULL OR work_list_deleted_at IS NOT NULL
				OR work_target_level='none' THEN 'none'
			WHEN environment_archived_at IS NOT NULL OR work_folder_archived_at IS NOT NULL OR work_list_archived_at IS NOT NULL THEN 'view'
			WHEN work_target_level='full' THEN 'manage'
			ELSE work_target_level
		END AS effective_level,
		CASE WHEN task_view_id IS NULL THEN standalone_manage ELSE FALSE END AS can_manage,
		CASE WHEN task_view_id IS NULL THEN standalone_source ELSE 'work_'||work_target_source END AS access_source,
		CASE WHEN task_view_id IS NULL THEN 'standalone' ELSE 'work' END AS origin,
		CASE
			WHEN task_view_id IS NULL THEN ''
			WHEN view_deleted_at IS NOT NULL OR archived_at IS NOT NULL THEN 'trash'
			WHEN environment_archived_at IS NOT NULL OR work_folder_archived_at IS NOT NULL OR work_list_archived_at IS NOT NULL THEN 'location_archived'
			ELSE 'active'
		END AS work_lifecycle,
		CASE
			WHEN task_view_id IS NULL OR view_deleted_at IS NULL OR archived_at IS NULL THEN FALSE
			WHEN NOT has_work_modules OR resolved_environment_id IS NULL
				OR (view_folder_id IS NULL)=(view_list_id IS NULL)
				OR (view_folder_id IS NOT NULL AND work_folder_id IS NULL)
				OR (view_list_id IS NOT NULL AND work_list_id IS NULL)
				OR environment_deleted_at IS NOT NULL OR work_folder_deleted_at IS NOT NULL OR work_list_deleted_at IS NOT NULL
				THEN FALSE
			ELSE work_target_level='full'
		END AS work_can_restore
	FROM hub_list_access
) `

type whiteboardActorAccessState struct {
	CreatedBy       *uuid.UUID
	AccessMode      string
	BoardArchivedAt *time.Time
	GrantLevel      *string
	GrantManage     *bool
	Membership      bool
	MembershipRole  string
	Permissions     []string
	UserSuperAdmin  bool

	TaskViewID        *uuid.UUID
	EnvironmentID     *uuid.UUID
	ViewFolderID      *uuid.UUID
	ViewListID        *uuid.UUID
	ViewDeletedAt     *time.Time
	EnvironmentName   string
	EnvironmentMode   string
	EnvironmentLevel  string
	EnvironmentArch   *time.Time
	EnvironmentTrash  *time.Time
	EnvironmentGrant  *string
	EnvironmentManage *bool

	FolderID     *uuid.UUID
	FolderName   string
	FolderMode   *string
	FolderArch   *time.Time
	FolderTrash  *time.Time
	FolderGrant  *string
	FolderManage *bool
	ListID       *uuid.UUID
	ListName     string
	ListMode     *string
	ListArch     *time.Time
	ListTrash    *time.Time
	ListGrant    *string
	ListManage   *bool
}

func scanWhiteboardActorAccessState(row pgx.Row) (*whiteboardActorAccessState, error) {
	state := &whiteboardActorAccessState{}
	var environmentID *uuid.UUID
	err := row.Scan(
		&state.CreatedBy, &state.AccessMode, &state.BoardArchivedAt,
		&state.GrantLevel, &state.GrantManage,
		&state.Membership, &state.MembershipRole, &state.Permissions,
		&state.UserSuperAdmin,
		&state.TaskViewID, &state.EnvironmentID, &state.ViewFolderID, &state.ViewListID, &state.ViewDeletedAt,
		&environmentID, &state.EnvironmentName, &state.EnvironmentMode, &state.EnvironmentLevel,
		&state.EnvironmentArch, &state.EnvironmentTrash, &state.EnvironmentGrant, &state.EnvironmentManage,
		&state.FolderID, &state.FolderName, &state.FolderMode, &state.FolderArch, &state.FolderTrash,
		&state.FolderGrant, &state.FolderManage,
		&state.ListID, &state.ListName, &state.ListMode, &state.ListArch, &state.ListTrash,
		&state.ListGrant, &state.ListManage,
	)
	if err == nil && state.TaskViewID != nil && (environmentID == nil || state.EnvironmentID == nil || *environmentID != *state.EnvironmentID) {
		return nil, ErrWhiteboardNotFound
	}
	return state, err
}

func whiteboardPermissionSetAllows(permissions []string, permission string) bool {
	for _, item := range permissions {
		if item == domain.PermAll || item == permission {
			return true
		}
	}
	return false
}

func whiteboardTaskLevel(level string) string {
	switch strings.ToLower(strings.TrimSpace(level)) {
	case domain.TaskAccessFull:
		return domain.WhiteboardAccessManage
	case domain.TaskAccessEdit:
		return domain.WhiteboardAccessEdit
	case domain.TaskAccessComment:
		return domain.WhiteboardAccessComment
	case domain.TaskAccessView:
		return domain.WhiteboardAccessView
	default:
		return domain.WhiteboardAccessNone
	}
}

func whiteboardWorkBreadcrumb(state *whiteboardActorAccessState, folderVisible bool) *domain.WhiteboardWorkLocation {
	if state == nil || state.TaskViewID == nil || state.EnvironmentID == nil {
		return nil
	}
	location := &domain.WhiteboardWorkLocation{
		TaskViewID: *state.TaskViewID, EnvironmentID: *state.EnvironmentID,
		Breadcrumb: make([]domain.WhiteboardWorkBreadcrumbItem, 0, 3),
		Lifecycle:  domain.WhiteboardWorkLifecycleActive,
	}
	location.Breadcrumb = append(location.Breadcrumb, domain.WhiteboardWorkBreadcrumbItem{
		Type: domain.TaskAccessTargetEnvironment, ID: *state.EnvironmentID, Name: state.EnvironmentName,
	})
	if state.ViewListID != nil && state.ListID != nil {
		location.ScopeType, location.ScopeID, location.ScopeName = domain.TaskAccessTargetList, *state.ListID, state.ListName
		if folderVisible && state.FolderID != nil {
			location.Breadcrumb = append(location.Breadcrumb, domain.WhiteboardWorkBreadcrumbItem{
				Type: domain.TaskAccessTargetFolder, ID: *state.FolderID, Name: state.FolderName,
			})
		}
		location.Breadcrumb = append(location.Breadcrumb, domain.WhiteboardWorkBreadcrumbItem{
			Type: domain.TaskAccessTargetList, ID: *state.ListID, Name: state.ListName,
		})
	} else if state.ViewFolderID != nil && state.FolderID != nil {
		location.ScopeType, location.ScopeID, location.ScopeName = domain.TaskAccessTargetFolder, *state.FolderID, state.FolderName
		location.Breadcrumb = append(location.Breadcrumb, domain.WhiteboardWorkBreadcrumbItem{
			Type: domain.TaskAccessTargetFolder, ID: *state.FolderID, Name: state.FolderName,
		})
	}
	if state.ViewDeletedAt != nil || state.BoardArchivedAt != nil {
		location.Lifecycle = domain.WhiteboardWorkLifecycleTrash
	} else if state.EnvironmentArch != nil || state.FolderArch != nil || state.ListArch != nil {
		location.Lifecycle = domain.WhiteboardWorkLifecycleArchived
	}
	return location
}

func resolveWhiteboardActorAccessWith(ctx context.Context, q whiteboardQuerier, accountID, userID, boardID uuid.UUID) (*domain.WhiteboardEffectiveAccess, *domain.WhiteboardWorkLocation, error) {
	return resolveWhiteboardActorAccessWithOptions(ctx, q, accountID, userID, boardID, true)
}

func resolveWhiteboardActorAccessWithOptions(ctx context.Context, q whiteboardQuerier, accountID, userID, boardID uuid.UUID, capArchived bool) (*domain.WhiteboardEffectiveAccess, *domain.WhiteboardWorkLocation, error) {
	state, err := scanWhiteboardActorAccessState(q.QueryRow(ctx, whiteboardActorAccessQuery, accountID, userID, boardID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, ErrWhiteboardNotFound
	}
	if err != nil {
		return nil, nil, err
	}
	return resolveWhiteboardActorAccessState(state, userID, capArchived)
}

// resolveWhiteboardActorAccessState is the deterministic policy core shared by
// the database resolver and its exhaustive permission-matrix tests. Keeping
// every creator/grant/module/container precedence rule here prevents an API or
// Hub caller from growing a subtly different Work ACL interpretation.
func resolveWhiteboardActorAccessState(state *whiteboardActorAccessState, userID uuid.UUID, capArchived bool) (*domain.WhiteboardEffectiveAccess, *domain.WhiteboardWorkLocation, error) {
	if state == nil {
		return nil, nil, ErrWhiteboardNotFound
	}
	if state.TaskViewID == nil {
		admin := domain.HasAccountAdminAuthority(state.MembershipRole, state.UserSuperAdmin)
		level, manage, source := domain.WhiteboardAccessNone, false, "private"
		switch {
		case admin:
			level, manage, source = domain.WhiteboardAccessManage, true, "account_admin"
		case state.CreatedBy != nil && *state.CreatedBy == userID:
			level, manage, source = domain.WhiteboardAccessManage, true, "creator"
		case state.GrantLevel != nil:
			level, manage, source = *state.GrantLevel, state.GrantManage != nil && *state.GrantManage, "direct_grant"
		case state.AccessMode == domain.WhiteboardAccessAccount:
			level, source = domain.WhiteboardAccessView, "account_visibility"
		}
		return BuildWhiteboardEffectiveAccess(level, manage, source), nil, nil
	}

	// Contextual boards require a real membership and both product modules.
	admin := state.Membership && domain.HasAccountAdminAuthority(state.MembershipRole, state.UserSuperAdmin)
	if !state.Membership || (!admin && (!whiteboardPermissionSetAllows(state.Permissions, domain.PermTasks) ||
		!whiteboardPermissionSetAllows(state.Permissions, domain.PermWhiteboards))) {
		return BuildWhiteboardEffectiveAccess(domain.WhiteboardAccessNone, false, "work_modules_required"), nil, nil
	}
	if state.EnvironmentID == nil || (state.ViewFolderID == nil) == (state.ViewListID == nil) ||
		(state.ViewFolderID != nil && state.FolderID == nil) || (state.ViewListID != nil && state.ListID == nil) {
		return nil, nil, ErrWhiteboardNotFound
	}
	if state.EnvironmentTrash != nil || state.FolderTrash != nil || state.ListTrash != nil {
		return nil, nil, ErrWhiteboardNotFound
	}

	var taskAccess *domain.TaskEffectiveAccess
	folderVisible := true
	if admin {
		taskAccess = buildTaskEffectiveAccess(domain.TaskAccessFull, true, "account_admin")
	} else {
		environmentLevel, environmentManage, environmentSource := domain.TaskAccessNone, false, "environment_private"
		if state.EnvironmentGrant != nil {
			environmentLevel = *state.EnvironmentGrant
			environmentManage = state.EnvironmentManage != nil && *state.EnvironmentManage
			environmentSource = "environment_grant"
		} else if state.EnvironmentMode == "account" {
			environmentLevel, environmentSource = state.EnvironmentLevel, "environment_default"
		}
		listMode := "inherit"
		if state.ListMode != nil {
			listMode = *state.ListMode
		}
		accessState := taskHierarchyAccessState{
			EnvironmentLevel: environmentLevel, EnvironmentManage: environmentManage, EnvironmentSource: environmentSource,
			ListMode: listMode, TaskMode: "inherit", FolderLevel: state.FolderGrant, FolderManage: state.FolderManage,
			ListLevel: state.ListGrant, ListManage: state.ListManage,
		}
		if state.FolderMode != nil {
			accessState.FolderMode = *state.FolderMode
		}
		taskAccess, folderVisible, _ = resolveTaskHierarchyAccess(accessState)
	}
	location := whiteboardWorkBreadcrumb(state, folderVisible)
	if taskAccess == nil || !taskAccess.CanView {
		return BuildWhiteboardEffectiveAccess(domain.WhiteboardAccessNone, false, "work_container"), location, nil
	}
	if capArchived && location != nil && location.Lifecycle == domain.WhiteboardWorkLifecycleArchived {
		return BuildWhiteboardEffectiveAccess(domain.WhiteboardAccessView, false, "work_archive"), location, nil
	}
	// Work governs structure, so generic whiteboard access management remains
	// disabled even for Administrar. CanDelete still follows the cumulative
	// manage level and is used by the contextual lifecycle endpoints.
	return BuildWhiteboardEffectiveAccess(whiteboardTaskLevel(taskAccess.Level), false, "work_"+taskAccess.InheritedFrom), location, nil
}

func resolveWhiteboardAccessWith(ctx context.Context, q whiteboardQuerier, accountID, userID, boardID uuid.UUID) (*domain.WhiteboardEffectiveAccess, error) {
	access, _, err := resolveWhiteboardActorAccessWith(ctx, q, accountID, userID, boardID)
	return access, err
}

func resolveActiveWhiteboardAccessWith(ctx context.Context, q whiteboardQuerier, accountID, userID, boardID uuid.UUID) (*domain.WhiteboardEffectiveAccess, error) {
	access, location, err := resolveWhiteboardActorAccessWith(ctx, q, accountID, userID, boardID)
	if err != nil {
		return nil, err
	}
	if location != nil && location.Lifecycle != domain.WhiteboardWorkLifecycleActive {
		return nil, ErrWhiteboardNotFound
	}
	var archived bool
	if err := q.QueryRow(ctx, `SELECT archived_at IS NOT NULL FROM whiteboards WHERE account_id=$1 AND id=$2`, accountID, boardID).Scan(&archived); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrWhiteboardNotFound
		}
		return nil, err
	}
	if archived {
		return nil, ErrWhiteboardNotFound
	}
	return access, nil
}

func whiteboardIsWorkOriginWith(ctx context.Context, q whiteboardQuerier, accountID, boardID uuid.UUID) (bool, error) {
	var contextual bool
	err := q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM task_location_whiteboard_views
		WHERE account_id=$1 AND whiteboard_id=$2)`, accountID, boardID).Scan(&contextual)
	return contextual, err
}

func requireStandaloneWhiteboardWith(ctx context.Context, q whiteboardQuerier, accountID, boardID uuid.UUID) error {
	contextual, err := whiteboardIsWorkOriginWith(ctx, q, accountID, boardID)
	if err != nil {
		return err
	}
	if contextual {
		return ErrWhiteboardInheritsWorkAccess
	}
	return nil
}

// IsWorkOrigin is intentionally authorization-neutral. A request-facing caller
// must first prove canonical Ver access (or resolve an actor-bound capability)
// before using its result. Authentication or possession of a stale ticket alone
// is not sufficient, because the boolean would otherwise become an origin and
// resource-existence oracle.
func (r *WhiteboardRepository) IsWorkOrigin(ctx context.Context, accountID, boardID uuid.UUID) (bool, error) {
	return whiteboardIsWorkOriginWith(ctx, r.db, accountID, boardID)
}

// ResolveWorkWhiteboardAccess exposes the canonical contextual resolver to
// location-view CRUD without duplicating Work ACL semantics. Standalone boards
// deliberately resolve as not found at this boundary.
func (r *WhiteboardRepository) ResolveWorkWhiteboardAccess(ctx context.Context, accountID, actorID, boardID uuid.UUID, required string, active bool) (*domain.WhiteboardEffectiveAccess, *domain.WhiteboardWorkLocation, error) {
	if !validWhiteboardAccessLevel(required, false) {
		return nil, nil, ErrWhiteboardInvalid
	}
	access, location, err := resolveWhiteboardActorAccessWith(ctx, r.db, accountID, actorID, boardID)
	if err != nil {
		return nil, nil, err
	}
	if location == nil {
		return nil, nil, ErrWhiteboardNotFound
	}
	if active && location.Lifecycle != domain.WhiteboardWorkLifecycleActive {
		return nil, nil, ErrWhiteboardNotFound
	}
	if access == nil || !access.CanView {
		return nil, nil, ErrWhiteboardNotFound
	}
	if !WhiteboardAccessAllows(access, required) {
		return access, location, ErrWhiteboardForbidden
	}
	return access, location, nil
}

// requireWorkWhiteboardAccessTx is the transaction-safe equivalent used when
// a contextual lifecycle mutation has already locked its location view.
func requireWorkWhiteboardAccessTx(ctx context.Context, tx pgx.Tx, accountID, actorID, boardID uuid.UUID, required string, active bool) (*domain.WhiteboardEffectiveAccess, *domain.WhiteboardWorkLocation, error) {
	if !validWhiteboardAccessLevel(required, false) {
		return nil, nil, ErrWhiteboardInvalid
	}
	access, location, err := resolveWhiteboardActorAccessWith(ctx, tx, accountID, actorID, boardID)
	if err != nil {
		return nil, nil, err
	}
	if location == nil {
		return nil, nil, ErrWhiteboardNotFound
	}
	if active && location.Lifecycle != domain.WhiteboardWorkLifecycleActive {
		return nil, nil, ErrWhiteboardNotFound
	}
	if access == nil || !access.CanView {
		return nil, nil, ErrWhiteboardNotFound
	}
	if !WhiteboardAccessAllows(access, required) {
		return access, location, ErrWhiteboardForbidden
	}
	return access, location, nil
}

func requireWorkWhiteboardLifecycleAccessTx(ctx context.Context, tx pgx.Tx, accountID, actorID, boardID uuid.UUID, required string) (*domain.WhiteboardEffectiveAccess, *domain.WhiteboardWorkLocation, error) {
	if !validWhiteboardAccessLevel(required, false) {
		return nil, nil, ErrWhiteboardInvalid
	}
	access, location, err := resolveWhiteboardActorAccessWithOptions(ctx, tx, accountID, actorID, boardID, false)
	if err != nil {
		return nil, nil, err
	}
	if location == nil {
		return nil, nil, ErrWhiteboardNotFound
	}
	if access == nil || !access.CanView {
		return nil, nil, ErrWhiteboardNotFound
	}
	if !WhiteboardAccessAllows(access, required) {
		return access, location, ErrWhiteboardForbidden
	}
	return access, location, nil
}
