package repository

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
)

var (
	ErrWhiteboardNotFound           = errors.New("whiteboard resource not found")
	ErrWhiteboardForbidden          = errors.New("whiteboard access forbidden")
	ErrWhiteboardInvalid            = errors.New("invalid whiteboard input")
	ErrWhiteboardConflict           = errors.New("whiteboard version conflict")
	ErrWhiteboardFolderNotEmpty     = errors.New("whiteboard folder is not empty")
	ErrWhiteboardUploadInProgress   = errors.New("whiteboard asset upload already in progress")
	ErrWhiteboardStorageLimit       = errors.New("whiteboard storage limit reached")
	ErrWhiteboardShareUnavailable   = errors.New("whiteboard share is unavailable")
	ErrWhiteboardSessionUnavailable = errors.New("whiteboard guest session is unavailable")
	ErrWhiteboardTrashConfirmation  = errors.New("whiteboard trash confirmation does not match")
	ErrWhiteboardTrashNotEligible   = errors.New("whiteboard is not eligible for permanent deletion")
	ErrWhiteboardInheritsWorkAccess = errors.New("whiteboard inherits access from Clarin Work")
)

type WhiteboardTrashEligibilityError struct {
	NextEligibleAt time.Time
}

func (e *WhiteboardTrashEligibilityError) Error() string {
	return ErrWhiteboardTrashNotEligible.Error()
}
func (e *WhiteboardTrashEligibilityError) Unwrap() error { return ErrWhiteboardTrashNotEligible }

type WhiteboardConflictError struct {
	CurrentSequence int64
	CurrentVersion  int64
}

func (e *WhiteboardConflictError) Error() string { return ErrWhiteboardConflict.Error() }
func (e *WhiteboardConflictError) Unwrap() error { return ErrWhiteboardConflict }

type WhiteboardRepository struct {
	db *pgxpool.Pool
}

func NewWhiteboardRepository(db *pgxpool.Pool) *WhiteboardRepository {
	return &WhiteboardRepository{db: db}
}

type whiteboardRowScanner interface {
	Scan(dest ...any) error
}

type whiteboardQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func whiteboardAccessRank(level string) int {
	switch level {
	case domain.WhiteboardAccessView:
		return 1
	case domain.WhiteboardAccessComment:
		return 2
	case domain.WhiteboardAccessEdit:
		return 3
	case domain.WhiteboardAccessManage:
		return 4
	default:
		return 0
	}
}

func validWhiteboardAccessLevel(level string, allowNone bool) bool {
	if allowNone && level == domain.WhiteboardAccessNone {
		return true
	}
	return whiteboardAccessRank(level) > 0
}

func BuildWhiteboardEffectiveAccess(level string, manage bool, source string) *domain.WhiteboardEffectiveAccess {
	rank := whiteboardAccessRank(level)
	if rank == 0 {
		level = domain.WhiteboardAccessNone
		manage = false
	}
	return &domain.WhiteboardEffectiveAccess{
		Level:           level,
		InheritedFrom:   source,
		CanView:         rank >= whiteboardAccessRank(domain.WhiteboardAccessView),
		CanComment:      rank >= whiteboardAccessRank(domain.WhiteboardAccessComment),
		CanEdit:         rank >= whiteboardAccessRank(domain.WhiteboardAccessEdit),
		CanDelete:       rank >= whiteboardAccessRank(domain.WhiteboardAccessManage),
		CanManageAccess: manage && rank >= whiteboardAccessRank(domain.WhiteboardAccessManage),
	}
}

func WhiteboardAccessAllows(access *domain.WhiteboardEffectiveAccess, required string) bool {
	return access != nil && validWhiteboardAccessLevel(required, false) &&
		whiteboardAccessRank(access.Level) >= whiteboardAccessRank(required)
}

// RequireAccess is the canonical actor authorization gate prepared for both
// REST and a future board-room WebSocket gateway.
func (r *WhiteboardRepository) RequireAccess(ctx context.Context, accountID, userID, boardID uuid.UUID, requiredLevel string) (*domain.WhiteboardEffectiveAccess, error) {
	access, _, err := r.requireAccessWithOrigin(ctx, accountID, userID, boardID, requiredLevel, false)
	return access, err
}

func (r *WhiteboardRepository) requireAccessWithOrigin(ctx context.Context, accountID, userID, boardID uuid.UUID, requiredLevel string, active bool) (*domain.WhiteboardEffectiveAccess, *domain.WhiteboardWorkLocation, error) {
	if !validWhiteboardAccessLevel(requiredLevel, false) {
		return nil, nil, ErrWhiteboardInvalid
	}
	access, location, err := resolveWhiteboardActorAccessWith(ctx, r.db, accountID, userID, boardID)
	if err != nil {
		return nil, nil, err
	}
	if active {
		if location != nil && location.Lifecycle != domain.WhiteboardWorkLifecycleActive {
			return nil, nil, ErrWhiteboardNotFound
		}
		var archived bool
		if err := r.db.QueryRow(ctx, `SELECT archived_at IS NOT NULL FROM whiteboards WHERE account_id=$1 AND id=$2`, accountID, boardID).Scan(&archived); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, nil, ErrWhiteboardNotFound
			}
			return nil, nil, err
		}
		if archived {
			return nil, nil, ErrWhiteboardNotFound
		}
	}
	if !access.CanView {
		return nil, nil, ErrWhiteboardNotFound
	}
	if !WhiteboardAccessAllows(access, requiredLevel) {
		return nil, location, ErrWhiteboardForbidden
	}
	return access, location, nil
}

// RequireActiveAccess is the collaboration authorization gate. Unlike the
// historical RequireAccess contract used by archive/restore workflows, it
// treats archived (and therefore also purged) boards as unavailable.
func (r *WhiteboardRepository) RequireActiveAccess(ctx context.Context, accountID, userID, boardID uuid.UUID, requiredLevel string) (*domain.WhiteboardEffectiveAccess, error) {
	access, _, err := r.requireAccessWithOrigin(ctx, accountID, userID, boardID, requiredLevel, true)
	return access, err
}

func (r *WhiteboardRepository) AccessRevision(ctx context.Context, accountID, boardID uuid.UUID) (int64, error) {
	var revision int64
	if err := r.db.QueryRow(ctx, `SELECT access_revision FROM whiteboards WHERE account_id=$1 AND id=$2`, accountID, boardID).Scan(&revision); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, ErrWhiteboardNotFound
		}
		return 0, err
	}
	return revision, nil
}

func (r *WhiteboardRepository) RequireManageAccess(ctx context.Context, accountID, userID, boardID uuid.UUID) (*domain.WhiteboardEffectiveAccess, error) {
	access, err := r.RequireAccess(ctx, accountID, userID, boardID, domain.WhiteboardAccessManage)
	if err != nil {
		return nil, err
	}
	if !access.CanManageAccess {
		return nil, ErrWhiteboardForbidden
	}
	return access, nil
}

type WhiteboardFolderListOptions struct {
	ParentID        *uuid.UUID
	FilterByParent  bool
	IncludeArchived bool
	AfterSortOrder  *int64
	AfterID         *uuid.UUID
	Limit           int
}

type WhiteboardListOptions struct {
	FolderID        *uuid.UUID
	Query           string
	Scope           string
	Origin          string
	IncludeWork     bool
	IncludeArchived bool
	BeforeUpdatedAt *time.Time
	BeforeID        *uuid.UUID
	Limit           int
}

const (
	WhiteboardScopeAll    = "all"
	WhiteboardScopeMine   = "mine"
	WhiteboardScopeRecent = "recent"
	WhiteboardScopeShared = "shared"
	WhiteboardScopeTrash  = "trash"
	WhiteboardScopeWork   = "work"
)

func validWhiteboardListScope(scope string) bool {
	switch scope {
	case WhiteboardScopeAll, WhiteboardScopeMine, WhiteboardScopeRecent, WhiteboardScopeShared, WhiteboardScopeTrash, WhiteboardScopeWork:
		return true
	default:
		return false
	}
}

type WhiteboardCreateInput struct {
	ID                  uuid.UUID
	AccountID           uuid.UUID
	ActorID             uuid.UUID
	FolderID            *uuid.UUID
	Name                string
	Description         string
	Scene               json.RawMessage
	SceneSchemaVersion  string
	EditorVersion       string
	AccessMode          string
	OperationID         uuid.UUID
	RequestPayloadHash  string
	ResultSceneHash     string
	SnapshotObjectKey   string
	SnapshotContentHash string
	SnapshotSizeBytes   int64
}

// FindCreatedBoardByOperation recognizes an already committed create request.
// A reused operation ID with a different actor or payload is a conflict, never
// permission to return another user's board or silently accept changed input.
func (r *WhiteboardRepository) FindCreatedBoardByOperation(ctx context.Context, accountID, actorID, boardID, operationID uuid.UUID, requestPayloadHash string) (*domain.Whiteboard, bool, error) {
	var creatorID *uuid.UUID
	var storedPayloadHash string
	err := r.db.QueryRow(ctx, `SELECT board.created_by,COALESCE(operation.request_payload_hash,'')
		FROM whiteboards board
		JOIN whiteboard_operations operation ON operation.account_id=board.account_id
			AND operation.board_id=board.id AND operation.operation_kind='create'
		WHERE board.account_id=$1 AND board.id=$2 AND operation.operation_id=$3`,
		accountID, boardID, operationID).Scan(&creatorID, &storedPayloadHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if creatorID == nil || *creatorID != actorID || strings.TrimSpace(storedPayloadHash) != requestPayloadHash {
		return nil, true, ErrWhiteboardConflict
	}
	item, err := r.GetBoard(ctx, accountID, actorID, boardID)
	return item, true, err
}

type WhiteboardUpdateInput struct {
	FolderID        *uuid.UUID
	Name            string
	Description     string
	ExpectedVersion int64
}

func scanWhiteboard(scanner whiteboardRowScanner) (*domain.Whiteboard, error) {
	item := &domain.Whiteboard{}
	err := scanner.Scan(
		&item.ID, &item.AccountID, &item.FolderID, &item.Name, &item.Description,
		&item.SceneSchemaVersion, &item.EditorVersion, &item.SceneSequence,
		&item.Version, &item.AccessMode, &item.AccessRevision, &item.ThumbnailMediaAssetID,
		&item.ThumbnailAssetID, &item.CreatedBy, &item.UpdatedBy, &item.ArchivedAt, &item.CreatedAt, &item.UpdatedAt,
	)
	return item, err
}

const whiteboardSelectColumns = `board.id,board.account_id,board.folder_id,board.name,board.description,
	board.scene_schema_version,board.editor_version,board.scene_sequence,board.version,board.access_mode,
	board.access_revision,board.thumbnail_media_asset_id,
	(SELECT thumbnail_link.id FROM whiteboard_assets thumbnail_link
		WHERE thumbnail_link.account_id=board.account_id AND thumbnail_link.board_id=board.id
		AND thumbnail_link.kind='thumbnail' LIMIT 1) AS thumbnail_asset_id,
	board.created_by,board.updated_by,board.archived_at,
	board.created_at,board.updated_at`

func (r *WhiteboardRepository) CreateBoard(ctx context.Context, input WhiteboardCreateInput) (*domain.Whiteboard, error) {
	if input.ID == uuid.Nil || input.AccountID == uuid.Nil || input.ActorID == uuid.Nil || input.OperationID == uuid.Nil || len(input.RequestPayloadHash) != 64 {
		return nil, ErrWhiteboardInvalid
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockActiveWhiteboardTenantTx(ctx, tx, input.AccountID); err != nil {
		return nil, err
	}
	if err := lockWhiteboardActorMembershipsTx(ctx, tx, input.AccountID, input.ActorID); err != nil {
		return nil, err
	}
	if input.FolderID != nil {
		if err := lockWhiteboardHierarchyTx(ctx, tx, input.AccountID); err != nil {
			return nil, err
		}
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM whiteboard_folders
			WHERE account_id=$1 AND id=$2 AND archived_at IS NULL)`, input.AccountID, *input.FolderID).Scan(&exists); err != nil {
			return nil, err
		}
		if !exists {
			return nil, ErrWhiteboardInvalid
		}
	}
	boardID := input.ID
	inserted, err := tx.Exec(ctx, `INSERT INTO whiteboards(
		id,account_id,folder_id,name,description,scene_json,scene_schema_version,editor_version,
		scene_sequence,version,access_mode,access_revision,created_by,updated_by
	) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,0,1,$9,1,$10,$10)
	ON CONFLICT(id) DO NOTHING`,
		boardID, input.AccountID, input.FolderID, input.Name, input.Description, input.Scene,
		input.SceneSchemaVersion, input.EditorVersion, input.AccessMode, input.ActorID)
	if err != nil {
		return nil, normalizeWhiteboardConstraintError(err)
	}
	if inserted.RowsAffected() == 0 {
		_ = tx.Rollback(ctx)
		item, found, findErr := r.FindCreatedBoardByOperation(ctx, input.AccountID, input.ActorID, boardID, input.OperationID, input.RequestPayloadHash)
		if findErr != nil {
			return nil, findErr
		}
		if !found {
			return nil, ErrWhiteboardConflict
		}
		return item, nil
	}
	if _, err := tx.Exec(ctx, `INSERT INTO whiteboard_grants(
		account_id,board_id,user_id,access_level,can_manage_access,created_by
	) VALUES($1,$2,$3,'manage',TRUE,$3)`, input.AccountID, boardID, input.ActorID); err != nil {
		return nil, normalizeWhiteboardConstraintError(err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO whiteboard_operations(
		account_id,board_id,base_sequence,sequence,operation_id,operation_kind,request_payload_hash,result_scene_hash,actor_id
	) VALUES($1,$2,0,0,$3,'create',$4,$5,$6)`, input.AccountID, boardID, input.OperationID,
		input.RequestPayloadHash, input.ResultSceneHash, input.ActorID); err != nil {
		return nil, normalizeWhiteboardConstraintError(err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO whiteboard_revisions(
		account_id,board_id,revision_number,sequence,operation_id,write_kind,revision_kind,expires_at,
		snapshot_object_key,snapshot_content_hash,snapshot_size_bytes,snapshot_compression,
		scene_schema_version,editor_version,actor_id
	) VALUES($1,$2,1,0,$3,'create','system',NULL,$4,$5,$6,'gzip',$7,$8,$9)`, input.AccountID, boardID,
		input.OperationID, input.SnapshotObjectKey, input.SnapshotContentHash, input.SnapshotSizeBytes,
		input.SceneSchemaVersion, input.EditorVersion, input.ActorID); err != nil {
		return nil, normalizeWhiteboardConstraintError(err)
	}
	if _, err := tx.Exec(ctx, `UPDATE storage_objects SET status='active',next_delete_at=NULL,
		delete_error='',deleted_at=NULL,updated_at=NOW() WHERE account_id=$1 AND object_key=$2`,
		input.AccountID, input.SnapshotObjectKey); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM whiteboard_snapshot_gc_jobs
		WHERE account_id=$1 AND object_key=$2`, input.AccountID, input.SnapshotObjectKey); err != nil {
		return nil, err
	}
	after, _ := json.Marshal(map[string]any{"access_mode": input.AccessMode, "creator_id": input.ActorID})
	if _, err := tx.Exec(ctx, `INSERT INTO whiteboard_access_audit(
		account_id,board_id,actor_id,action,after_state,operation_id
	) VALUES($1,$2,$3,'board_created',$4::jsonb,$5)`, input.AccountID, boardID, input.ActorID, after, input.OperationID); err != nil {
		return nil, err
	}
	if err := insertWhiteboardActivityTx(ctx, tx, WhiteboardActivityInput{
		AccountID: input.AccountID, BoardID: boardID, ActorID: &input.ActorID,
		Action: WhiteboardActivityCreated, Details: after, OperationID: &input.OperationID,
	}); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return r.GetBoard(ctx, input.AccountID, input.ActorID, boardID)
}

func (r *WhiteboardRepository) GetBoard(ctx context.Context, accountID, userID, boardID uuid.UUID) (*domain.Whiteboard, error) {
	access, workLocation, err := r.requireAccessWithOrigin(ctx, accountID, userID, boardID, domain.WhiteboardAccessView, false)
	if err != nil {
		return nil, err
	}
	item, err := scanWhiteboard(r.db.QueryRow(ctx, `SELECT `+whiteboardSelectColumns+`
		FROM whiteboards board WHERE board.account_id=$1 AND board.id=$2`, accountID, boardID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrWhiteboardNotFound
	}
	if err != nil {
		return nil, err
	}
	item.EffectiveAccess = access
	item.Origin = domain.WhiteboardOriginStandalone
	if workLocation != nil {
		item.Origin = domain.WhiteboardOriginWork
		item.WorkLocation = workLocation
	}
	if item.ThumbnailAssetID != nil {
		item.ThumbnailURL = "/api/whiteboards/" + item.ID.String() + "/assets/" + item.ThumbnailAssetID.String()
	}
	return item, nil
}

func (r *WhiteboardRepository) ListBoards(ctx context.Context, accountID, userID uuid.UUID, options WhiteboardListOptions) ([]*domain.Whiteboard, bool, error) {
	limit := options.Limit
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	query := strings.TrimSpace(options.Query)
	scope := strings.TrimSpace(options.Scope)
	if scope == "" {
		scope = WhiteboardScopeAll
	}
	if !validWhiteboardListScope(scope) {
		return nil, false, ErrWhiteboardInvalid
	}
	origin := strings.ToLower(strings.TrimSpace(options.Origin))
	if scope == WhiteboardScopeWork {
		origin, scope = domain.WhiteboardOriginWork, WhiteboardScopeAll
	}
	if origin == "" {
		origin = WhiteboardScopeAll
	}
	if origin != WhiteboardScopeAll && origin != domain.WhiteboardOriginStandalone && origin != domain.WhiteboardOriginWork {
		return nil, false, ErrWhiteboardInvalid
	}
	rows, err := r.db.Query(ctx, whiteboardHubAccessCTE+`
	SELECT id,account_id,folder_id,name,description,scene_schema_version,editor_version,scene_sequence,
		version,access_mode,access_revision,thumbnail_media_asset_id,thumbnail_asset_id,created_by,updated_by,archived_at,
		created_at,updated_at,effective_level,can_manage,access_source,folder_name,owner_name,updated_by_name,
		origin,task_view_id,work_environment_id,environment_name,
		view_folder_id,view_list_id,work_folder_id,work_folder_name,work_folder_visible,work_list_id,work_list_name,work_lifecycle
		,work_can_restore
	FROM visible
	WHERE effective_level<>'none'
		AND (($3::text='trash' AND (archived_at IS NOT NULL OR view_deleted_at IS NOT NULL))
			OR ($3::text<>'trash' AND archived_at IS NULL AND view_deleted_at IS NULL))
		AND ($3::text<>'mine' OR created_by=$2)
		AND ($3::text<>'recent' OR updated_at>=NOW()-INTERVAL '30 days')
		AND ($3::text<>'shared' OR COALESCE(created_by<>$2,TRUE))
		AND ($4::uuid IS NULL OR (origin='standalone' AND folder_id=$4::uuid))
		AND ($5::text='' OR name ILIKE '%'||$5::text||'%' OR description ILIKE '%'||$5::text||'%'
			OR folder_name ILIKE '%'||$5::text||'%' OR owner_name ILIKE '%'||$5::text||'%'
			OR environment_name ILIKE '%'||$5::text||'%'
			OR (work_folder_visible AND work_folder_name ILIKE '%'||$5::text||'%')
			OR work_list_name ILIKE '%'||$5::text||'%')
		AND ($6::timestamptz IS NULL OR (updated_at,id)<($6::timestamptz,$7::uuid))
		AND ($8::text='all' OR origin=$8::text)
		AND ($9::boolean OR origin='standalone')
	ORDER BY updated_at DESC,id DESC LIMIT $10`, accountID, userID, scope,
		options.FolderID, query, options.BeforeUpdatedAt, options.BeforeID, origin, options.IncludeWork, limit+1)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	items := make([]*domain.Whiteboard, 0, limit)
	for rows.Next() {
		item := &domain.Whiteboard{}
		var level, source string
		var manage bool
		var origin, workLifecycle string
		var taskViewID, environmentID, viewFolderID, viewListID, workFolderID, workListID *uuid.UUID
		var environmentName, workFolderName, workListName string
		var workFolderVisible, workCanRestore bool
		if err := rows.Scan(&item.ID, &item.AccountID, &item.FolderID, &item.Name, &item.Description,
			&item.SceneSchemaVersion, &item.EditorVersion, &item.SceneSequence, &item.Version, &item.AccessMode,
			&item.AccessRevision, &item.ThumbnailMediaAssetID, &item.ThumbnailAssetID, &item.CreatedBy, &item.UpdatedBy, &item.ArchivedAt,
			&item.CreatedAt, &item.UpdatedAt, &level, &manage, &source, &item.FolderName, &item.OwnerName,
			&item.UpdatedByName, &origin, &taskViewID, &environmentID, &environmentName,
			&viewFolderID, &viewListID, &workFolderID, &workFolderName, &workFolderVisible,
			&workListID, &workListName, &workLifecycle, &workCanRestore); err != nil {
			return nil, false, err
		}
		item.EffectiveAccess = BuildWhiteboardEffectiveAccess(level, manage, source)
		item.Shared = whiteboardHubSharedWithActor(item.CreatedBy, userID)
		applyWhiteboardHubStructuralCapabilities(item.EffectiveAccess, origin, workLifecycle, workCanRestore)
		item.Origin = origin
		if origin == domain.WhiteboardOriginWork && taskViewID != nil && environmentID != nil {
			location := &domain.WhiteboardWorkLocation{
				TaskViewID: *taskViewID, EnvironmentID: *environmentID, Lifecycle: workLifecycle,
				Breadcrumb: []domain.WhiteboardWorkBreadcrumbItem{{Type: domain.TaskAccessTargetEnvironment, ID: *environmentID, Name: environmentName}},
			}
			if viewListID != nil && workListID != nil {
				location.ScopeType, location.ScopeID, location.ScopeName = domain.TaskAccessTargetList, *workListID, workListName
				if workFolderVisible && workFolderID != nil {
					location.Breadcrumb = append(location.Breadcrumb, domain.WhiteboardWorkBreadcrumbItem{Type: domain.TaskAccessTargetFolder, ID: *workFolderID, Name: workFolderName})
				}
				location.Breadcrumb = append(location.Breadcrumb, domain.WhiteboardWorkBreadcrumbItem{Type: domain.TaskAccessTargetList, ID: *workListID, Name: workListName})
			} else if viewFolderID != nil && workFolderID != nil {
				location.ScopeType, location.ScopeID, location.ScopeName = domain.TaskAccessTargetFolder, *workFolderID, workFolderName
				location.Breadcrumb = append(location.Breadcrumb, domain.WhiteboardWorkBreadcrumbItem{Type: domain.TaskAccessTargetFolder, ID: *workFolderID, Name: workFolderName})
			}
			item.WorkLocation = location
		}
		if item.ThumbnailAssetID != nil {
			item.ThumbnailURL = "/api/whiteboards/" + item.ID.String() + "/assets/" + item.ThumbnailAssetID.String()
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	hasMore := len(items) > limit
	if hasMore {
		items = items[:limit]
	}
	return items, hasMore, nil
}

// A Work parent may be archived while one of its whiteboards is explicitly in
// Whiteboards Trash. Content remains read-only, but an actor who still has the
// underlying Work Administrar level must be able to restore that explicit
// deletion. Keep this structural capability separate from level/edit and from
// ACL management so archived content cannot be mutated or re-shared.
func applyWhiteboardHubStructuralCapabilities(access *domain.WhiteboardEffectiveAccess, origin, lifecycle string, canRestore bool) {
	if access == nil || origin != domain.WhiteboardOriginWork || lifecycle != domain.WhiteboardWorkLifecycleTrash || !canRestore {
		return
	}
	access.CanDelete = true
	access.CanManageAccess = false
}

func (r *WhiteboardRepository) CountBoardScopes(ctx context.Context, accountID, userID uuid.UUID, includeWork bool) (map[string]int64, error) {
	var all, mine, recent, shared, trash, work int64
	err := r.db.QueryRow(ctx, whiteboardHubAccessCTE+`
	SELECT
		COUNT(*) FILTER (WHERE archived_at IS NULL AND view_deleted_at IS NULL),
		COUNT(*) FILTER (WHERE archived_at IS NULL AND view_deleted_at IS NULL AND created_by=$2),
		COUNT(*) FILTER (WHERE archived_at IS NULL AND view_deleted_at IS NULL AND updated_at>=NOW()-INTERVAL '30 days'),
		COUNT(*) FILTER (WHERE archived_at IS NULL AND view_deleted_at IS NULL AND COALESCE(created_by<>$2,TRUE)),
		COUNT(*) FILTER (WHERE archived_at IS NOT NULL OR view_deleted_at IS NOT NULL),
		COUNT(*) FILTER (WHERE archived_at IS NULL AND view_deleted_at IS NULL AND origin='work')
	FROM visible WHERE effective_level<>'none' AND ($3::boolean OR origin='standalone')`, accountID, userID, includeWork).
		Scan(&all, &mine, &recent, &shared, &trash, &work)
	if err != nil {
		return nil, err
	}
	return map[string]int64{
		WhiteboardScopeAll: all, WhiteboardScopeMine: mine, WhiteboardScopeRecent: recent,
		WhiteboardScopeShared: shared, WhiteboardScopeTrash: trash, WhiteboardScopeWork: work,
	}, nil
}

// Historical boards outlive account memberships. A NULL creator therefore
// means the current actor is not the creator; treating SQL NULL as false would
// both hide the board from Compartidas and make the Hub row scan nullable.
func whiteboardHubSharedWithActor(createdBy *uuid.UUID, actorID uuid.UUID) bool {
	return createdBy == nil || *createdBy != actorID
}

func normalizeWhiteboardConstraintError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23503", "23514":
			return ErrWhiteboardInvalid
		case "23505":
			return ErrWhiteboardConflict
		}
	}
	return err
}
