package repository

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
)

var (
	ErrTaskLocationViewNotFound = errors.New("task location view not found")
	ErrTaskLocationViewInvalid  = errors.New("task location view input is invalid")
	ErrTaskLocationViewConflict = errors.New("task location view changed concurrently")
	ErrTaskLocationViewDisabled = errors.New("task location views are disabled")
	ErrTaskLocationViewParent   = errors.New("task location view parent is unavailable")
)

type TaskLocationViewRepository struct {
	db *pgxpool.Pool
}

type TaskLocationViewListOptions struct {
	ScopeType       string
	ScopeID         uuid.UUID
	AfterSortOrder  *int64
	AfterID         *uuid.UUID
	Limit           int
	IncludeArchived bool
}

type TaskLocationViewCreateInput struct {
	ViewID              uuid.UUID
	BoardID             uuid.UUID
	AccountID           uuid.UUID
	ActorID             uuid.UUID
	ScopeType           string
	ScopeID             uuid.UUID
	Name                string
	Scene               json.RawMessage
	SceneSchemaVersion  string
	EditorVersion       string
	OperationID         uuid.UUID
	RequestPayloadHash  string
	ResultSceneHash     string
	SnapshotObjectKey   string
	SnapshotContentHash string
	SnapshotSizeBytes   int64
}

type TaskLocationViewUpdateInput struct {
	Name               string
	ExpectedVersion    int64
	OperationID        uuid.UUID
	RequestPayloadHash string
}

type TaskLocationViewMutationInput struct {
	ExpectedVersion    int64
	OperationID        uuid.UUID
	RequestPayloadHash string
}

type taskLocationViewScanner interface {
	Scan(dest ...any) error
}

type taskLocationViewMutationState struct {
	ScopeType       string
	ScopeID         uuid.UUID
	BoardID         uuid.UUID
	Version         int64
	DeletedAt       *time.Time
	BoardArchivedAt *time.Time
}

func readTaskLocationViewMutationState(ctx context.Context, q taskAccessQuerier, accountID, viewID uuid.UUID, lock bool) (*taskLocationViewMutationState, error) {
	state := &taskLocationViewMutationState{}
	viewQuery := `SELECT CASE WHEN view_item.folder_id IS NOT NULL THEN 'folder' ELSE 'list' END,
		COALESCE(view_item.folder_id,view_item.list_id),binding.whiteboard_id,view_item.version,view_item.deleted_at
		FROM task_location_views view_item JOIN task_location_whiteboard_views binding
		ON binding.account_id=view_item.account_id AND binding.task_view_id=view_item.id
		WHERE view_item.account_id=$1 AND view_item.id=$2`
	if lock {
		// Lifecycle and access transactions lock the Work parent first. Lock the
		// contextual row next and the whiteboard last so checkpoint, Trash and
		// parent transitions cannot form an inverse lock cycle.
		viewQuery += ` FOR UPDATE OF view_item`
	}
	if err := q.QueryRow(ctx, viewQuery, accountID, viewID).Scan(&state.ScopeType, &state.ScopeID, &state.BoardID,
		&state.Version, &state.DeletedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrTaskLocationViewNotFound
		}
		return nil, err
	}
	boardQuery := `SELECT archived_at FROM whiteboards WHERE account_id=$1 AND id=$2`
	if lock {
		boardQuery += ` FOR UPDATE`
	}
	if err := q.QueryRow(ctx, boardQuery, accountID, state.BoardID).Scan(&state.BoardArchivedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrTaskLocationViewNotFound
		}
		return nil, err
	}
	return state, nil
}

const taskLocationViewSelect = `
	view_item.id,view_item.account_id,view_item.environment_id,view_item.folder_id,view_item.list_id,
	view_item.view_type,view_item.sort_order,view_item.version,view_item.access_revision,
	view_item.created_by,view_item.deleted_at,view_item.created_at,view_item.updated_at,
	environment.name,COALESCE(location_folder.name,location_list.name,''),
	list_parent.id,list_parent.name,
	(environment.archived_at IS NOT NULL OR location_folder.archived_at IS NOT NULL OR
	 location_list.archived_at IS NOT NULL OR list_parent.archived_at IS NOT NULL) AS location_archived,
	(environment.deleted_at IS NOT NULL OR location_folder.deleted_at IS NOT NULL OR
	 location_list.deleted_at IS NOT NULL OR list_parent.deleted_at IS NOT NULL) AS location_deleted,
	board.id,board.account_id,board.folder_id,board.name,board.description,
	board.scene_schema_version,board.editor_version,board.scene_sequence,board.version,
	board.access_mode,board.access_revision,board.thumbnail_media_asset_id,
	(SELECT thumbnail_link.id FROM whiteboard_assets thumbnail_link
	 WHERE thumbnail_link.account_id=board.account_id AND thumbnail_link.board_id=board.id
	 AND thumbnail_link.kind='thumbnail' LIMIT 1) AS thumbnail_asset_id,
	board.created_by,board.updated_by,board.archived_at,board.created_at,board.updated_at`

const taskLocationViewFrom = `
	FROM task_location_views view_item
	JOIN task_location_whiteboard_views binding ON binding.account_id=view_item.account_id AND binding.task_view_id=view_item.id
	JOIN whiteboards board ON board.account_id=binding.account_id AND board.id=binding.whiteboard_id
	JOIN task_environments environment ON environment.account_id=view_item.account_id AND environment.id=view_item.environment_id
	LEFT JOIN task_folders location_folder ON location_folder.account_id=view_item.account_id
		AND location_folder.environment_id=view_item.environment_id AND location_folder.id=view_item.folder_id
	LEFT JOIN task_lists location_list ON location_list.account_id=view_item.account_id
		AND location_list.environment_id=view_item.environment_id AND location_list.id=view_item.list_id
	LEFT JOIN task_folders list_parent ON list_parent.account_id=location_list.account_id
		AND list_parent.environment_id=location_list.environment_id AND list_parent.id=location_list.folder_id`

func scanTaskLocationView(scanner taskLocationViewScanner) (*domain.TaskLocationView, error) {
	item := &domain.TaskLocationView{}
	board := &domain.Whiteboard{}
	var folderID, listID, listParentID *uuid.UUID
	var environmentName, scopeName string
	var listParentName *string
	var locationArchived, locationDeleted bool
	if err := scanner.Scan(
		&item.ID, &item.AccountID, &item.EnvironmentID, &folderID, &listID,
		&item.Type, &item.SortOrder, &item.Version, &item.AccessRevision,
		&item.CreatedBy, &item.DeletedAt, &item.CreatedAt, &item.UpdatedAt,
		&environmentName, &scopeName, &listParentID, &listParentName,
		&locationArchived, &locationDeleted,
		&board.ID, &board.AccountID, &board.FolderID, &board.Name, &board.Description,
		&board.SceneSchemaVersion, &board.EditorVersion, &board.SceneSequence, &board.Version,
		&board.AccessMode, &board.AccessRevision, &board.ThumbnailMediaAssetID,
		&board.ThumbnailAssetID, &board.CreatedBy, &board.UpdatedBy, &board.ArchivedAt,
		&board.CreatedAt, &board.UpdatedAt,
	); err != nil {
		return nil, err
	}

	scopeType := domain.TaskAccessTargetFolder
	scopeID := uuid.Nil
	if folderID != nil {
		scopeID = *folderID
	} else if listID != nil {
		scopeType = domain.TaskAccessTargetList
		scopeID = *listID
	} else {
		return nil, ErrTaskLocationViewInvalid
	}
	item.Lifecycle = domain.WhiteboardWorkLifecycleActive
	if item.DeletedAt != nil || board.ArchivedAt != nil || locationDeleted {
		item.Lifecycle = domain.WhiteboardWorkLifecycleTrash
	} else if locationArchived {
		item.Lifecycle = domain.WhiteboardWorkLifecycleArchived
	}
	breadcrumb := []domain.WhiteboardWorkBreadcrumbItem{{Type: domain.TaskAccessTargetEnvironment, ID: item.EnvironmentID, Name: environmentName}}
	// A parent folder is added only by the caller after proving it is visible.
	// Omitting it here is the safe projection for a directly shared list.
	if scopeType == domain.TaskAccessTargetFolder {
		breadcrumb = append(breadcrumb, domain.WhiteboardWorkBreadcrumbItem{Type: scopeType, ID: scopeID, Name: scopeName})
	} else {
		_ = listParentID
		_ = listParentName
		breadcrumb = append(breadcrumb, domain.WhiteboardWorkBreadcrumbItem{Type: scopeType, ID: scopeID, Name: scopeName})
	}
	location := &domain.WhiteboardWorkLocation{
		TaskViewID: item.ID, EnvironmentID: item.EnvironmentID, ScopeType: scopeType,
		ScopeID: scopeID, ScopeName: scopeName, Breadcrumb: breadcrumb, Lifecycle: item.Lifecycle,
	}
	board.Origin = domain.WhiteboardOriginWork
	board.WorkLocation = location
	if board.ThumbnailAssetID != nil {
		board.ThumbnailURL = "/api/whiteboards/" + board.ID.String() + "/assets/" + board.ThumbnailAssetID.String()
	}
	item.Scope = location
	item.Resource.Whiteboard = board
	return item, nil
}

func applyTaskLocationViewAccess(item *domain.TaskLocationView, access *domain.TaskEffectiveAccess) {
	if item == nil {
		return
	}
	item.Capabilities = domain.TaskLocationCapabilities(access)
	if item.Lifecycle == domain.WhiteboardWorkLifecycleArchived {
		item.Capabilities.CanComment = false
		item.Capabilities.CanEdit = false
		item.Capabilities.CanManage = false
		item.Capabilities.CanManageAccess = false
	}
	level := domain.WhiteboardAccessNone
	switch {
	case item.Capabilities.CanManage:
		level = domain.WhiteboardAccessManage
	case item.Capabilities.CanEdit:
		level = domain.WhiteboardAccessEdit
	case item.Capabilities.CanComment:
		level = domain.WhiteboardAccessComment
	case item.Capabilities.CanView:
		level = domain.WhiteboardAccessView
	}
	if item.Resource.Whiteboard != nil {
		item.Resource.Whiteboard.EffectiveAccess = BuildWhiteboardEffectiveAccess(level,
			item.Capabilities.CanManageAccess, "work_location")
	}
}

func applyTaskLocationWhiteboardAccess(item *domain.TaskLocationView, access *domain.WhiteboardEffectiveAccess, location *domain.WhiteboardWorkLocation) {
	if item == nil || access == nil {
		return
	}
	if location != nil {
		item.Scope = location
		item.EnvironmentID = location.EnvironmentID
		item.Lifecycle = location.Lifecycle
		if item.Resource.Whiteboard != nil {
			item.Resource.Whiteboard.WorkLocation = location
		}
	}
	item.Capabilities = domain.TaskLocationViewCapabilities{
		CanView: access.CanView, CanComment: access.CanComment, CanEdit: access.CanEdit,
		CanManage: access.Level == domain.WhiteboardAccessManage, CanManageAccess: false,
	}
	if item.Resource.Whiteboard != nil {
		item.Resource.Whiteboard.EffectiveAccess = access
	}
}

func taskLocationViewLimit(limit int) int {
	if limit <= 0 {
		return 50
	}
	if limit > 200 {
		return 200
	}
	return limit
}

func validTaskLocationScope(scopeType string, scopeID uuid.UUID) bool {
	return scopeID != uuid.Nil && (scopeType == domain.TaskAccessTargetFolder || scopeType == domain.TaskAccessTargetList)
}

func (r *TaskLocationViewRepository) List(ctx context.Context, accountID, actorID uuid.UUID, options TaskLocationViewListOptions) ([]*domain.TaskLocationView, bool, error) {
	if accountID == uuid.Nil || actorID == uuid.Nil || !validTaskLocationScope(options.ScopeType, options.ScopeID) {
		return nil, false, ErrTaskLocationViewInvalid
	}
	var access *domain.TaskEffectiveAccess
	var err error
	if options.IncludeArchived {
		access, err = resolveHistoricalTaskLocationAccessWith(ctx, r.db, accountID, actorID, options.ScopeID, options.ScopeType, domain.TaskAccessView)
	} else {
		access, _, err = resolveContainerAccessWith(ctx, r.db, accountID, actorID, options.ScopeID, options.ScopeType)
	}
	if err != nil {
		return nil, false, err
	}
	if !TaskAccessAllows(access, domain.TaskAccessView) {
		return nil, false, ErrTaskWorkNotFound
	}
	whereScope := "view_item.folder_id=$2"
	if options.ScopeType == domain.TaskAccessTargetList {
		whereScope = "view_item.list_id=$2"
	}
	args := []any{accountID, options.ScopeID}
	cursor := ""
	if options.AfterSortOrder != nil && options.AfterID != nil {
		args = append(args, *options.AfterSortOrder, *options.AfterID)
		cursor = " AND (view_item.sort_order,view_item.id)>($3,$4)"
	}
	limit := taskLocationViewLimit(options.Limit)
	args = append(args, limit+1)
	lifecycleWhere := ` AND environment.archived_at IS NULL AND environment.deleted_at IS NULL
		AND (location_folder.id IS NULL OR (location_folder.archived_at IS NULL AND location_folder.deleted_at IS NULL))
		AND (location_list.id IS NULL OR (location_list.archived_at IS NULL AND location_list.deleted_at IS NULL))
		AND (list_parent.id IS NULL OR (list_parent.archived_at IS NULL AND list_parent.deleted_at IS NULL))`
	if options.IncludeArchived {
		lifecycleWhere = ` AND environment.deleted_at IS NULL
			AND (location_folder.id IS NULL OR location_folder.deleted_at IS NULL)
			AND (location_list.id IS NULL OR location_list.deleted_at IS NULL)
			AND (list_parent.id IS NULL OR list_parent.deleted_at IS NULL)
			AND (environment.archived_at IS NOT NULL OR location_folder.archived_at IS NOT NULL
				OR location_list.archived_at IS NOT NULL OR list_parent.archived_at IS NOT NULL)`
	}
	query := `SELECT ` + taskLocationViewSelect + taskLocationViewFrom + `
		WHERE view_item.account_id=$1 AND ` + whereScope + ` AND view_item.deleted_at IS NULL
		AND board.archived_at IS NULL` + lifecycleWhere + cursor + `
		ORDER BY view_item.sort_order,view_item.id LIMIT $`
	// The limit placeholder follows the optional cursor pair.
	if cursor == "" {
		query += "3"
	} else {
		query += "5"
	}
	rows, err := r.db.Query(ctx, query, args...)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	items := make([]*domain.TaskLocationView, 0, limit)
	for rows.Next() {
		item, scanErr := scanTaskLocationView(rows)
		if scanErr != nil {
			return nil, false, scanErr
		}
		applyTaskLocationViewAccess(item, access)
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	hasMore := len(items) > limit
	if hasMore {
		items = items[:limit]
	}
	if len(items) > 0 && items[0].Resource.Whiteboard != nil {
		boardAccess, canonicalLocation, accessErr := NewWhiteboardRepository(r.db).ResolveWorkWhiteboardAccess(ctx,
			accountID, actorID, items[0].Resource.Whiteboard.ID, domain.WhiteboardAccessView, false)
		if accessErr != nil {
			return nil, false, accessErr
		}
		for _, item := range items {
			location := *canonicalLocation
			location.TaskViewID = item.ID
			location.Breadcrumb = append([]domain.WhiteboardWorkBreadcrumbItem(nil), canonicalLocation.Breadcrumb...)
			applyTaskLocationWhiteboardAccess(item, boardAccess, &location)
		}
	}
	return items, hasMore, nil
}

func (r *TaskLocationViewRepository) getRaw(ctx context.Context, accountID, viewID uuid.UUID) (*domain.TaskLocationView, error) {
	item, err := scanTaskLocationView(r.db.QueryRow(ctx, `SELECT `+taskLocationViewSelect+taskLocationViewFrom+`
		WHERE view_item.account_id=$1 AND view_item.id=$2`, accountID, viewID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrTaskLocationViewNotFound
	}
	return item, err
}

func (r *TaskLocationViewRepository) Get(ctx context.Context, accountID, actorID, viewID uuid.UUID) (*domain.TaskLocationView, error) {
	if accountID == uuid.Nil || actorID == uuid.Nil || viewID == uuid.Nil {
		return nil, ErrTaskLocationViewInvalid
	}
	item, err := r.getRaw(ctx, accountID, viewID)
	if err != nil {
		return nil, err
	}
	if item.Resource.Whiteboard == nil || item.DeletedAt != nil {
		return nil, ErrTaskLocationViewNotFound
	}
	access, location, err := NewWhiteboardRepository(r.db).ResolveWorkWhiteboardAccess(ctx, accountID, actorID,
		item.Resource.Whiteboard.ID, domain.WhiteboardAccessView, false)
	if err != nil {
		return nil, err
	}
	applyTaskLocationWhiteboardAccess(item, access, location)
	return item, nil
}

// GetMutationContext returns the authorized canonical provenance required to
// bind an idempotency hash. Unlike the ordinary active read it deliberately
// permits an explicitly trashed view so restore retries can reproduce the
// exact same account/Entorno/location/name payload.
func (r *TaskLocationViewRepository) GetMutationContext(ctx context.Context, accountID, actorID, viewID uuid.UUID) (*domain.TaskLocationView, error) {
	if accountID == uuid.Nil || actorID == uuid.Nil || viewID == uuid.Nil {
		return nil, ErrTaskLocationViewInvalid
	}
	return r.getOperationResult(ctx, accountID, actorID, viewID)
}

// getOperationResult hydrates an idempotent result through the same canonical
// Work resolver as an ordinary read. It intentionally accepts an explicitly
// trashed view so DELETE retries can return their committed canonical result,
// while a trashed parent or a revoked actor still resolves as 404.
func (r *TaskLocationViewRepository) getOperationResult(ctx context.Context, accountID, actorID, viewID uuid.UUID) (*domain.TaskLocationView, error) {
	item, err := r.getRaw(ctx, accountID, viewID)
	if err != nil {
		return nil, err
	}
	if item.Resource.Whiteboard == nil {
		return nil, ErrTaskLocationViewNotFound
	}
	access, location, err := NewWhiteboardRepository(r.db).ResolveWorkWhiteboardAccess(ctx, accountID, actorID,
		item.Resource.Whiteboard.ID, domain.WhiteboardAccessView, false)
	if err != nil {
		return nil, err
	}
	applyTaskLocationWhiteboardAccess(item, access, location)
	return item, nil
}

func (r *TaskLocationViewRepository) FindOperation(ctx context.Context, accountID, actorID, operationID uuid.UUID, action, requestPayloadHash string) (*domain.TaskLocationView, bool, error) {
	if accountID == uuid.Nil || actorID == uuid.Nil || operationID == uuid.Nil || len(requestPayloadHash) != 64 {
		return nil, false, ErrTaskLocationViewInvalid
	}
	var storedAction, storedHash string
	var viewID uuid.UUID
	err := r.db.QueryRow(ctx, `SELECT action,request_payload_hash,result_task_view_id
		FROM task_location_view_operations WHERE account_id=$1 AND actor_id=$2 AND operation_id=$3`,
		accountID, actorID, operationID).Scan(&storedAction, &storedHash, &viewID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if err := validateTaskLocationOperationReplay(storedAction, storedHash, action, requestPayloadHash); err != nil {
		return nil, true, ErrTaskLocationViewConflict
	}
	item, err := r.getOperationResult(ctx, accountID, actorID, viewID)
	return item, true, err
}

func taskLocationViewOperationTx(ctx context.Context, tx pgx.Tx, accountID, actorID, operationID uuid.UUID, action, payloadHash string) (uuid.UUID, bool, error) {
	var storedAction, storedHash string
	var viewID uuid.UUID
	err := tx.QueryRow(ctx, `SELECT action,request_payload_hash,result_task_view_id
		FROM task_location_view_operations WHERE account_id=$1 AND actor_id=$2 AND operation_id=$3 FOR SHARE`,
		accountID, actorID, operationID).Scan(&storedAction, &storedHash, &viewID)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, false, nil
	}
	if err != nil {
		return uuid.Nil, false, err
	}
	if err := validateTaskLocationOperationReplay(storedAction, storedHash, action, payloadHash); err != nil {
		return uuid.Nil, true, ErrTaskLocationViewConflict
	}
	return viewID, true, nil
}

func validateTaskLocationOperationReplay(storedAction, storedHash, action, payloadHash string) error {
	if storedAction != action || storedHash != payloadHash {
		return ErrTaskLocationViewConflict
	}
	return nil
}

func lockTaskLocationOperationTx(ctx context.Context, tx pgx.Tx, accountID, actorID, operationID uuid.UUID) error {
	key := accountID.String() + ":" + actorID.String() + ":" + operationID.String()
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))`, key)
	return err
}

func insertTaskLocationViewOperationTx(ctx context.Context, tx pgx.Tx, accountID, actorID, operationID, viewID uuid.UUID, action, payloadHash string) error {
	result, _ := json.Marshal(map[string]any{"task_view_id": viewID, "action": action})
	_, err := tx.Exec(ctx, `INSERT INTO task_location_view_operations(
		account_id,actor_id,operation_id,action,request_payload_hash,result_task_view_id,result_json
	) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`, accountID, actorID, operationID, action, payloadHash, viewID, result)
	return err
}

func lockActiveTaskLocationTx(ctx context.Context, tx pgx.Tx, accountID, scopeID uuid.UUID, scopeType string) (uuid.UUID, error) {
	query := `SELECT folder.environment_id FROM task_folders folder
		JOIN task_environments environment ON environment.account_id=folder.account_id AND environment.id=folder.environment_id
		WHERE folder.account_id=$1 AND folder.id=$2 AND folder.archived_at IS NULL AND folder.deleted_at IS NULL
		AND environment.archived_at IS NULL AND environment.deleted_at IS NULL FOR SHARE OF folder,environment`
	if scopeType == domain.TaskAccessTargetList {
		query = `SELECT list_item.environment_id FROM task_lists list_item
			LEFT JOIN task_folders folder ON folder.account_id=list_item.account_id AND folder.id=list_item.folder_id
			JOIN task_environments environment ON environment.account_id=list_item.account_id AND environment.id=list_item.environment_id
			WHERE list_item.account_id=$1 AND list_item.id=$2 AND list_item.archived_at IS NULL AND list_item.deleted_at IS NULL
			AND environment.archived_at IS NULL AND environment.deleted_at IS NULL
			AND (folder.id IS NULL OR (folder.archived_at IS NULL AND folder.deleted_at IS NULL)) FOR SHARE OF list_item,environment`
	} else if scopeType != domain.TaskAccessTargetFolder {
		return uuid.Nil, ErrTaskLocationViewInvalid
	}
	var environmentID uuid.UUID
	if err := tx.QueryRow(ctx, query, accountID, scopeID).Scan(&environmentID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return uuid.Nil, ErrTaskLocationViewParent
		}
		return uuid.Nil, err
	}
	return environmentID, nil
}

func taskLocationModulesAllowed(role string, permissions []string, globalSuperAdmin bool) bool {
	return domain.HasAccountAdminAuthority(role, globalSuperAdmin) ||
		(whiteboardPermissionSetAllows(permissions, domain.PermTasks) &&
			whiteboardPermissionSetAllows(permissions, domain.PermWhiteboards))
}

func actorCanUseTaskLocationViewsWith(ctx context.Context, q taskAccessQuerier, accountID, actorID uuid.UUID) (bool, error) {
	var role string
	var permissions []string
	var globalSuperAdmin bool
	if err := q.QueryRow(ctx, `SELECT membership.role,COALESCE(role_item.permissions,'{}'::text[]),
		COALESCE(account_user.is_super_admin,FALSE)
		FROM user_accounts membership JOIN users account_user ON account_user.id=membership.user_id AND account_user.is_active
		LEFT JOIN roles role_item ON role_item.id=membership.role_id
			WHERE membership.account_id=$1 AND membership.user_id=$2`, accountID, actorID).
		Scan(&role, &permissions, &globalSuperAdmin); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	return taskLocationModulesAllowed(role, permissions, globalSuperAdmin), nil
}

func (r *TaskWorkRepository) CanUseTaskLocationViews(ctx context.Context, accountID, actorID uuid.UUID) (bool, error) {
	return actorCanUseTaskLocationViewsWith(ctx, r.db, accountID, actorID)
}

func requireTaskLocationModulesWith(ctx context.Context, q taskAccessQuerier, accountID, actorID uuid.UUID) error {
	allowed, err := actorCanUseTaskLocationViewsWith(ctx, q, accountID, actorID)
	if err != nil {
		return err
	}
	if !allowed {
		return ErrTaskWorkNotFound
	}
	return nil
}

func resolveHistoricalTaskLocationAccessWith(ctx context.Context, q taskAccessQuerier, accountID, actorID, scopeID uuid.UUID, scopeType, required string) (*domain.TaskEffectiveAccess, error) {
	if err := requireTaskLocationModulesWith(ctx, q, accountID, actorID); err != nil {
		return nil, err
	}
	query := `SELECT (` + taskActorFolderAccessRankSQL("folder", "$3") + `),(` + taskActorFolderCanManageSQL("folder", "$3") + `)
		FROM task_folders folder JOIN task_environments environment
		ON environment.account_id=folder.account_id AND environment.id=folder.environment_id
		WHERE folder.account_id=$1 AND folder.id=$2 AND folder.deleted_at IS NULL AND environment.deleted_at IS NULL`
	if scopeType == domain.TaskAccessTargetList {
		query = `SELECT (` + taskActorListAccessRankSQL("list_item", "$3") + `),(` + taskActorListCanManageSQL("list_item", "$3") + `)
			FROM task_lists list_item JOIN task_environments environment
			ON environment.account_id=list_item.account_id AND environment.id=list_item.environment_id
			LEFT JOIN task_folders folder ON folder.account_id=list_item.account_id AND folder.id=list_item.folder_id
			WHERE list_item.account_id=$1 AND list_item.id=$2 AND list_item.deleted_at IS NULL
			AND environment.deleted_at IS NULL AND (folder.id IS NULL OR folder.deleted_at IS NULL)`
	} else if scopeType != domain.TaskAccessTargetFolder {
		return nil, ErrTaskLocationViewInvalid
	}
	var rank int
	var manage bool
	if err := q.QueryRow(ctx, query, accountID, scopeID, actorID).Scan(&rank, &manage); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrTaskLocationViewParent
		}
		return nil, err
	}
	access := buildTaskEffectiveAccess(taskAccessLevelFromRank(rank), manage, "historical_container")
	if !TaskAccessAllows(access, required) {
		if !access.CanView {
			return nil, ErrTaskWorkNotFound
		}
		return access, ErrTaskAccessDenied
	}
	return access, nil
}

func requireHistoricalTaskLocationManageTx(ctx context.Context, tx pgx.Tx, accountID, actorID, scopeID uuid.UUID, scopeType string) error {
	// Resolve once before locking so an actor without Ver cannot use mutation
	// timing to discover a hidden Work location.
	if _, err := resolveHistoricalTaskLocationAccessWith(ctx, tx, accountID, actorID, scopeID, scopeType, domain.TaskAccessFull); err != nil {
		return err
	}
	query := `SELECT (` + taskActorFolderAccessRankSQL("folder", "$3") + `)
		FROM task_folders folder JOIN task_environments environment
		ON environment.account_id=folder.account_id AND environment.id=folder.environment_id
		WHERE folder.account_id=$1 AND folder.id=$2 AND folder.deleted_at IS NULL AND environment.deleted_at IS NULL
		FOR SHARE OF folder,environment`
	if scopeType == domain.TaskAccessTargetList {
		query = `SELECT (` + taskActorListAccessRankSQL("list_item", "$3") + `)
			FROM task_lists list_item JOIN task_environments environment
			ON environment.account_id=list_item.account_id AND environment.id=list_item.environment_id
			LEFT JOIN task_folders folder ON folder.account_id=list_item.account_id AND folder.id=list_item.folder_id
			WHERE list_item.account_id=$1 AND list_item.id=$2 AND list_item.deleted_at IS NULL
			AND environment.deleted_at IS NULL AND (folder.id IS NULL OR folder.deleted_at IS NULL)
			FOR SHARE OF list_item,environment`
	} else if scopeType != domain.TaskAccessTargetFolder {
		return ErrTaskLocationViewInvalid
	}
	var rank int
	if err := tx.QueryRow(ctx, query, accountID, scopeID, actorID).Scan(&rank); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrTaskLocationViewParent
		}
		return err
	}
	if rank < taskAccessRank(domain.TaskAccessFull) {
		return ErrTaskAccessDenied
	}
	// The parent row is now stable. Join the same account-wide barrier used by
	// role, membership, module, ACL and lifecycle invalidations, then resolve
	// again from a fresh READ COMMITTED statement. Ancestor ACL changes that do
	// not lock this exact row are still serialized by the barrier.
	if err := lockWhiteboardAuthorityAccountTx(ctx, tx, accountID); err != nil {
		return err
	}
	_, err := resolveHistoricalTaskLocationAccessWith(ctx, tx, accountID, actorID, scopeID, scopeType, domain.TaskAccessFull)
	return err
}

func requireTaskLocationManageTx(ctx context.Context, tx pgx.Tx, accountID, actorID, scopeID uuid.UUID, scopeType string) (*domain.TaskEffectiveAccess, uuid.UUID, error) {
	// Resolve once before locking so a hidden location remains indistinguishable
	// from a missing one. This result is never trusted for the write itself.
	if err := requireTaskLocationModulesWith(ctx, tx, accountID, actorID); err != nil {
		return nil, uuid.Nil, err
	}
	access, environmentID, err := resolveContainerAccessWith(ctx, tx, accountID, actorID, scopeID, scopeType)
	if err != nil {
		return nil, uuid.Nil, err
	}
	if !TaskAccessAllows(access, domain.TaskAccessFull) {
		if access == nil || !access.CanView {
			return nil, uuid.Nil, ErrTaskWorkNotFound
		}
		return nil, uuid.Nil, ErrTaskAccessDenied
	}
	lockedEnvironmentID, err := lockActiveTaskLocationTx(ctx, tx, accountID, scopeID, scopeType)
	if err != nil {
		return nil, uuid.Nil, err
	}
	if lockedEnvironmentID != environmentID {
		return nil, uuid.Nil, ErrTaskLocationViewConflict
	}
	// Serialize against every account/global authority and Work ACL/lifecycle
	// mutation that can affect a contextual board. Re-resolve only after the
	// barrier: if revocation won, this write is denied; if this write won, the
	// later invalidation must enumerate the row inserted by this transaction.
	if err := lockWhiteboardAuthorityAccountTx(ctx, tx, accountID); err != nil {
		return nil, uuid.Nil, err
	}
	if err := requireTaskLocationModulesWith(ctx, tx, accountID, actorID); err != nil {
		return nil, uuid.Nil, err
	}
	access, currentEnvironmentID, err := resolveContainerAccessWith(ctx, tx, accountID, actorID, scopeID, scopeType)
	if err != nil {
		return nil, uuid.Nil, err
	}
	if currentEnvironmentID != lockedEnvironmentID {
		return nil, uuid.Nil, ErrTaskLocationViewConflict
	}
	if !TaskAccessAllows(access, domain.TaskAccessFull) {
		if access == nil || !access.CanView {
			return nil, uuid.Nil, ErrTaskWorkNotFound
		}
		return nil, uuid.Nil, ErrTaskAccessDenied
	}
	return access, currentEnvironmentID, nil
}

func taskLocationScopeColumns(scopeType string, scopeID uuid.UUID) (folderID, listID *uuid.UUID) {
	if scopeType == domain.TaskAccessTargetFolder {
		folderID = &scopeID
	} else {
		listID = &scopeID
	}
	return folderID, listID
}

func (r *TaskLocationViewRepository) Create(ctx context.Context, input TaskLocationViewCreateInput) (*domain.TaskLocationView, bool, error) {
	if input.ViewID == uuid.Nil || input.BoardID == uuid.Nil || input.AccountID == uuid.Nil || input.ActorID == uuid.Nil ||
		input.OperationID == uuid.Nil || !validTaskLocationScope(input.ScopeType, input.ScopeID) || strings.TrimSpace(input.Name) == "" ||
		len(input.RequestPayloadHash) != 64 || len(input.Scene) == 0 || input.SnapshotObjectKey == "" ||
		input.SnapshotContentHash == "" || input.SnapshotSizeBytes <= 0 {
		return nil, false, ErrTaskLocationViewInvalid
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockActiveWhiteboardTenantTx(ctx, tx, input.AccountID); err != nil {
		return nil, false, ErrTaskLocationViewNotFound
	}
	if err := lockTaskLocationViewActorMembershipTx(ctx, tx, input.AccountID, input.ActorID); err != nil {
		return nil, false, err
	}
	if err := lockTaskLocationOperationTx(ctx, tx, input.AccountID, input.ActorID, input.OperationID); err != nil {
		return nil, false, err
	}
	if existingID, found, opErr := taskLocationViewOperationTx(ctx, tx, input.AccountID, input.ActorID,
		input.OperationID, "create", input.RequestPayloadHash); opErr != nil {
		return nil, false, opErr
	} else if found {
		_ = tx.Rollback(ctx)
		item, getErr := r.getOperationResult(ctx, input.AccountID, input.ActorID, existingID)
		return item, true, getErr
	}
	_, environmentID, err := requireTaskLocationManageTx(ctx, tx, input.AccountID, input.ActorID, input.ScopeID, input.ScopeType)
	if err != nil {
		return nil, false, err
	}
	if err := requireTaskLocationModulesWith(ctx, tx, input.AccountID, input.ActorID); err != nil {
		return nil, false, err
	}
	folderID, listID := taskLocationScopeColumns(input.ScopeType, input.ScopeID)
	var sortOrder int64
	if err := tx.QueryRow(ctx, `SELECT COALESCE(MAX(sort_order),0)+1024 FROM task_location_views
		WHERE account_id=$1 AND environment_id=$2 AND folder_id IS NOT DISTINCT FROM $3::uuid
		AND list_id IS NOT DISTINCT FROM $4::uuid`, input.AccountID, environmentID, folderID, listID).Scan(&sortOrder); err != nil {
		return nil, false, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO whiteboards(
		id,account_id,folder_id,name,description,scene_json,scene_schema_version,editor_version,
		scene_sequence,version,access_mode,access_revision,created_by,updated_by
	) VALUES($1,$2,NULL,$3,'',$4::jsonb,$5,$6,0,1,'private',1,$7,$7)`, input.BoardID,
		input.AccountID, strings.TrimSpace(input.Name), input.Scene, input.SceneSchemaVersion, input.EditorVersion, input.ActorID); err != nil {
		return nil, false, normalizeWhiteboardConstraintError(err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO task_location_views(
		id,account_id,environment_id,folder_id,list_id,view_type,sort_order,created_by
	) VALUES($1,$2,$3,$4,$5,'whiteboard',$6,$7)`, input.ViewID, input.AccountID, environmentID,
		folderID, listID, sortOrder, input.ActorID); err != nil {
		return nil, false, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO task_location_whiteboard_views(account_id,task_view_id,whiteboard_id)
		VALUES($1,$2,$3)`, input.AccountID, input.ViewID, input.BoardID); err != nil {
		return nil, false, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO whiteboard_operations(
		account_id,board_id,base_sequence,sequence,operation_id,operation_kind,request_payload_hash,result_scene_hash,actor_id
	) VALUES($1,$2,0,0,$3,'create',$4,$5,$6)`, input.AccountID, input.BoardID, input.OperationID,
		input.RequestPayloadHash, input.ResultSceneHash, input.ActorID); err != nil {
		return nil, false, normalizeWhiteboardConstraintError(err)
	}
	// Promote the pre-written inventory row before inserting the revision that
	// references it. A missing reservation is an atomic conflict, not a leaked
	// partial board or an opaque FK error; any later failure rolls this update
	// back with the rest of the transaction.
	storageTag, err := tx.Exec(ctx, `UPDATE storage_objects SET status='active',next_delete_at=NULL,
		delete_error='',deleted_at=NULL,updated_at=NOW() WHERE account_id=$1 AND object_key=$2`,
		input.AccountID, input.SnapshotObjectKey)
	if err != nil {
		return nil, false, err
	}
	if storageTag.RowsAffected() != 1 {
		return nil, false, ErrTaskLocationViewConflict
	}
	if _, err := tx.Exec(ctx, `DELETE FROM whiteboard_snapshot_gc_jobs WHERE account_id=$1 AND object_key=$2`,
		input.AccountID, input.SnapshotObjectKey); err != nil {
		return nil, false, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO whiteboard_revisions(
		account_id,board_id,revision_number,sequence,operation_id,write_kind,revision_kind,expires_at,
		snapshot_object_key,snapshot_content_hash,snapshot_size_bytes,snapshot_compression,
		scene_schema_version,editor_version,actor_id
	) VALUES($1,$2,1,0,$3,'create','system',NULL,$4,$5,$6,'gzip',$7,$8,$9)`, input.AccountID,
		input.BoardID, input.OperationID, input.SnapshotObjectKey, input.SnapshotContentHash,
		input.SnapshotSizeBytes, input.SceneSchemaVersion, input.EditorVersion, input.ActorID); err != nil {
		return nil, false, normalizeWhiteboardConstraintError(err)
	}
	after, _ := json.Marshal(map[string]any{"access_mode": "work_inherited", "creator_id": input.ActorID,
		"task_view_id": input.ViewID, "scope_type": input.ScopeType, "scope_id": input.ScopeID})
	if _, err := tx.Exec(ctx, `INSERT INTO whiteboard_access_audit(
		account_id,board_id,actor_id,action,after_state,operation_id,request_payload_hash
	) VALUES($1,$2,$3,'board_created',$4::jsonb,$5,$6)`, input.AccountID, input.BoardID, input.ActorID,
		after, input.OperationID, input.RequestPayloadHash); err != nil {
		return nil, false, err
	}
	if err := insertWhiteboardActivityTx(ctx, tx, WhiteboardActivityInput{AccountID: input.AccountID,
		BoardID: input.BoardID, ActorID: &input.ActorID, Action: WhiteboardActivityCreated,
		Details: after, OperationID: &input.OperationID}); err != nil {
		return nil, false, err
	}
	if err := insertTaskLocationViewOperationTx(ctx, tx, input.AccountID, input.ActorID, input.OperationID,
		input.ViewID, "create", input.RequestPayloadHash); err != nil {
		return nil, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, false, err
	}
	item, err := r.getOperationResult(ctx, input.AccountID, input.ActorID, input.ViewID)
	return item, false, err
}

func (r *TaskLocationViewRepository) Update(ctx context.Context, accountID, actorID, viewID uuid.UUID, input TaskLocationViewUpdateInput) (*domain.TaskLocationView, bool, error) {
	if accountID == uuid.Nil || actorID == uuid.Nil || viewID == uuid.Nil || input.ExpectedVersion <= 0 ||
		input.OperationID == uuid.Nil || strings.TrimSpace(input.Name) == "" || len(input.RequestPayloadHash) != 64 {
		return nil, false, ErrTaskLocationViewInvalid
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockActiveWhiteboardTenantTx(ctx, tx, accountID); err != nil {
		return nil, false, ErrTaskLocationViewNotFound
	}
	if err := lockTaskLocationViewActorMembershipTx(ctx, tx, accountID, actorID); err != nil {
		return nil, false, err
	}
	if err := lockTaskLocationOperationTx(ctx, tx, accountID, actorID, input.OperationID); err != nil {
		return nil, false, err
	}
	if existingID, found, opErr := taskLocationViewOperationTx(ctx, tx, accountID, actorID, input.OperationID, "update", input.RequestPayloadHash); opErr != nil {
		return nil, false, opErr
	} else if found {
		_ = tx.Rollback(ctx)
		item, getErr := r.getOperationResult(ctx, accountID, actorID, existingID)
		return item, true, getErr
	}
	initial, err := readTaskLocationViewMutationState(ctx, tx, accountID, viewID, false)
	if err != nil {
		return nil, false, err
	}
	if initial.DeletedAt != nil || initial.BoardArchivedAt != nil {
		return nil, false, ErrTaskLocationViewConflict
	}
	_, _, err = requireTaskLocationManageTx(ctx, tx, accountID, actorID, initial.ScopeID, initial.ScopeType)
	if err != nil {
		return nil, false, err
	}
	current, err := readTaskLocationViewMutationState(ctx, tx, accountID, viewID, true)
	if err != nil {
		return nil, false, err
	}
	if current.ScopeType != initial.ScopeType || current.ScopeID != initial.ScopeID || current.BoardID != initial.BoardID ||
		current.DeletedAt != nil || current.BoardArchivedAt != nil || current.Version != input.ExpectedVersion {
		return nil, false, ErrTaskLocationViewConflict
	}
	if _, _, err := requireWorkWhiteboardAccessTx(ctx, tx, accountID, actorID,
		current.BoardID, domain.WhiteboardAccessManage, true); err != nil {
		return nil, false, err
	}
	if _, err := tx.Exec(ctx, `UPDATE task_location_views SET version=version+1,updated_at=NOW()
		WHERE account_id=$1 AND id=$2`, accountID, viewID); err != nil {
		return nil, false, err
	}
	if _, err := tx.Exec(ctx, `UPDATE whiteboards SET name=$3,updated_by=$4,version=version+1,updated_at=NOW()
		WHERE account_id=$1 AND id=$2`, accountID, current.BoardID, strings.TrimSpace(input.Name), actorID); err != nil {
		return nil, false, normalizeWhiteboardConstraintError(err)
	}
	if err := insertTaskLocationViewOperationTx(ctx, tx, accountID, actorID, input.OperationID, viewID, "update", input.RequestPayloadHash); err != nil {
		return nil, false, err
	}
	details, _ := json.Marshal(map[string]any{"changed_fields": []string{"name"}, "task_view_id": viewID})
	if err := insertWhiteboardActivityTx(ctx, tx, WhiteboardActivityInput{AccountID: accountID, BoardID: current.BoardID,
		ActorID: &actorID, Action: WhiteboardActivityUpdated, Details: details, OperationID: &input.OperationID}); err != nil {
		return nil, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, false, err
	}
	item, err := r.getOperationResult(ctx, accountID, actorID, viewID)
	return item, false, err
}

func (r *TaskLocationViewRepository) Trash(ctx context.Context, accountID, actorID, viewID uuid.UUID, input TaskLocationViewMutationInput) (*domain.TaskLocationView, bool, error) {
	return r.setTrashState(ctx, accountID, actorID, viewID, input, true)
}

func (r *TaskLocationViewRepository) Restore(ctx context.Context, accountID, actorID, viewID uuid.UUID, input TaskLocationViewMutationInput) (*domain.TaskLocationView, bool, error) {
	return r.setTrashState(ctx, accountID, actorID, viewID, input, false)
}

func (r *TaskLocationViewRepository) setTrashState(ctx context.Context, accountID, actorID, viewID uuid.UUID, input TaskLocationViewMutationInput, trash bool) (*domain.TaskLocationView, bool, error) {
	action := "restore"
	if trash {
		action = "trash"
	}
	if accountID == uuid.Nil || actorID == uuid.Nil || viewID == uuid.Nil || input.ExpectedVersion <= 0 ||
		input.OperationID == uuid.Nil || len(input.RequestPayloadHash) != 64 {
		return nil, false, ErrTaskLocationViewInvalid
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockActiveWhiteboardTenantTx(ctx, tx, accountID); err != nil {
		return nil, false, ErrTaskLocationViewNotFound
	}
	if err := lockTaskLocationViewActorMembershipTx(ctx, tx, accountID, actorID); err != nil {
		return nil, false, err
	}
	if err := lockTaskLocationOperationTx(ctx, tx, accountID, actorID, input.OperationID); err != nil {
		return nil, false, err
	}
	if existingID, found, opErr := taskLocationViewOperationTx(ctx, tx, accountID, actorID, input.OperationID, action, input.RequestPayloadHash); opErr != nil {
		return nil, false, opErr
	} else if found {
		_ = tx.Rollback(ctx)
		item, getErr := r.getOperationResult(ctx, accountID, actorID, existingID)
		return item, true, getErr
	}
	initial, err := readTaskLocationViewMutationState(ctx, tx, accountID, viewID, false)
	if err != nil {
		return nil, false, err
	}
	if trash {
		_, _, accessErr := requireTaskLocationManageTx(ctx, tx, accountID, actorID, initial.ScopeID, initial.ScopeType)
		if accessErr != nil {
			return nil, false, accessErr
		}
	} else {
		if _, _, accessErr := requireWorkWhiteboardAccessTx(ctx, tx, accountID, actorID, initial.BoardID, domain.WhiteboardAccessView, false); accessErr != nil {
			return nil, false, accessErr
		}
		if accessErr := requireHistoricalTaskLocationManageTx(ctx, tx, accountID, actorID, initial.ScopeID, initial.ScopeType); accessErr != nil {
			return nil, false, accessErr
		}
	}
	current, err := readTaskLocationViewMutationState(ctx, tx, accountID, viewID, true)
	if err != nil {
		return nil, false, err
	}
	if current.ScopeType != initial.ScopeType || current.ScopeID != initial.ScopeID || current.BoardID != initial.BoardID ||
		current.Version != input.ExpectedVersion {
		return nil, false, ErrTaskLocationViewConflict
	}
	if trash {
		if _, _, err := requireWorkWhiteboardAccessTx(ctx, tx, accountID, actorID,
			current.BoardID, domain.WhiteboardAccessManage, true); err != nil {
			return nil, false, err
		}
	} else if _, _, err := requireWorkWhiteboardLifecycleAccessTx(ctx, tx, accountID, actorID,
		current.BoardID, domain.WhiteboardAccessManage); err != nil {
		return nil, false, err
	}
	if trash && current.DeletedAt != nil && current.BoardArchivedAt != nil {
		if err := insertTaskLocationViewOperationTx(ctx, tx, accountID, actorID, input.OperationID, viewID, action, input.RequestPayloadHash); err != nil {
			return nil, false, err
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, false, err
		}
		item, getErr := r.getOperationResult(ctx, accountID, actorID, viewID)
		return item, false, getErr
	}
	if !trash && (current.DeletedAt == nil || current.BoardArchivedAt == nil) {
		return nil, false, ErrTaskLocationViewConflict
	}
	if trash {
		if _, err := tx.Exec(ctx, `UPDATE task_location_views SET deleted_at=NOW(),deleted_by=$3,
			version=version+1,access_revision=access_revision+1,updated_at=NOW() WHERE account_id=$1 AND id=$2`,
			accountID, viewID, actorID); err != nil {
			return nil, false, err
		}
		if _, err := tx.Exec(ctx, `UPDATE whiteboards SET archived_at=NOW(),updated_by=$3,
			version=version+1,access_revision=access_revision+1,updated_at=NOW() WHERE account_id=$1 AND id=$2`,
			accountID, current.BoardID, actorID); err != nil {
			return nil, false, err
		}
	} else {
		if _, err := tx.Exec(ctx, `UPDATE task_location_views SET deleted_at=NULL,deleted_by=NULL,
			version=version+1,access_revision=access_revision+1,updated_at=NOW() WHERE account_id=$1 AND id=$2`, accountID, viewID); err != nil {
			return nil, false, err
		}
		if _, err := tx.Exec(ctx, `UPDATE whiteboards SET archived_at=NULL,updated_by=$3,
			version=version+1,access_revision=access_revision+1,updated_at=NOW() WHERE account_id=$1 AND id=$2`,
			accountID, current.BoardID, actorID); err != nil {
			return nil, false, err
		}
	}
	if err := insertTaskLocationViewOperationTx(ctx, tx, accountID, actorID, input.OperationID, viewID, action, input.RequestPayloadHash); err != nil {
		return nil, false, err
	}
	details, _ := json.Marshal(map[string]any{"task_view_id": viewID})
	activityAction := WhiteboardActivityRestored
	if trash {
		activityAction = WhiteboardActivityArchived
	}
	if err := insertWhiteboardActivityTx(ctx, tx, WhiteboardActivityInput{AccountID: accountID, BoardID: current.BoardID,
		ActorID: &actorID, Action: activityAction, Details: details, OperationID: &input.OperationID}); err != nil {
		return nil, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, false, err
	}
	item, err := r.getOperationResult(ctx, accountID, actorID, viewID)
	return item, false, err
}
