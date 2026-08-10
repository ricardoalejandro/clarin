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
	case domain.WhiteboardAccessEdit:
		return 2
	case domain.WhiteboardAccessManage:
		return 3
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
		CanComment:      rank >= whiteboardAccessRank(domain.WhiteboardAccessEdit),
		CanEdit:         rank >= whiteboardAccessRank(domain.WhiteboardAccessEdit),
		CanDelete:       rank >= whiteboardAccessRank(domain.WhiteboardAccessManage),
		CanManageAccess: manage && rank >= whiteboardAccessRank(domain.WhiteboardAccessManage),
	}
}

func WhiteboardAccessAllows(access *domain.WhiteboardEffectiveAccess, required string) bool {
	return access != nil && validWhiteboardAccessLevel(required, false) &&
		whiteboardAccessRank(access.Level) >= whiteboardAccessRank(required)
}

func resolveWhiteboardAccessWith(ctx context.Context, q whiteboardQuerier, accountID, userID, boardID uuid.UUID) (*domain.WhiteboardEffectiveAccess, error) {
	var level, source string
	var canManage bool
	err := q.QueryRow(ctx, `
		SELECT
			CASE
				WHEN COALESCE(account_user.is_super_admin,FALSE) OR COALESCE(membership.role,'') IN ('admin','super_admin') THEN 'manage'
				WHEN board.created_by=$2 THEN 'manage'
				WHEN grant_item.access_level IS NOT NULL THEN grant_item.access_level
				WHEN board.access_mode='account' THEN 'view'
				ELSE 'none'
			END,
			CASE
				WHEN COALESCE(account_user.is_super_admin,FALSE) OR COALESCE(membership.role,'') IN ('admin','super_admin') THEN TRUE
				WHEN board.created_by=$2 THEN TRUE
				ELSE COALESCE(grant_item.can_manage_access,FALSE)
			END,
			CASE
				WHEN COALESCE(account_user.is_super_admin,FALSE) OR COALESCE(membership.role,'') IN ('admin','super_admin') THEN 'account_admin'
				WHEN board.created_by=$2 THEN 'creator'
				WHEN grant_item.access_level IS NOT NULL THEN 'direct_grant'
				WHEN board.access_mode='account' THEN 'account_visibility'
				ELSE 'private'
			END
		FROM whiteboards board
		JOIN users account_user ON account_user.id=$2 AND account_user.is_active
		LEFT JOIN user_accounts membership ON membership.account_id=board.account_id AND membership.user_id=$2
		LEFT JOIN whiteboard_grants grant_item ON grant_item.account_id=board.account_id
			AND grant_item.board_id=board.id AND grant_item.user_id=$2
		WHERE board.account_id=$1 AND board.id=$3
			AND (membership.user_id IS NOT NULL OR account_user.account_id=$1)
	`, accountID, userID, boardID).Scan(&level, &canManage, &source)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrWhiteboardNotFound
	}
	if err != nil {
		return nil, err
	}
	return BuildWhiteboardEffectiveAccess(level, canManage, source), nil
}

// RequireAccess is the canonical actor authorization gate prepared for both
// REST and a future board-room WebSocket gateway.
func (r *WhiteboardRepository) RequireAccess(ctx context.Context, accountID, userID, boardID uuid.UUID, requiredLevel string) (*domain.WhiteboardEffectiveAccess, error) {
	if !validWhiteboardAccessLevel(requiredLevel, false) {
		return nil, ErrWhiteboardInvalid
	}
	access, err := resolveWhiteboardAccessWith(ctx, r.db, accountID, userID, boardID)
	if err != nil {
		return nil, err
	}
	if !access.CanView {
		return nil, ErrWhiteboardNotFound
	}
	if !WhiteboardAccessAllows(access, requiredLevel) {
		return nil, ErrWhiteboardForbidden
	}
	return access, nil
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
)

func validWhiteboardListScope(scope string) bool {
	switch scope {
	case WhiteboardScopeAll, WhiteboardScopeMine, WhiteboardScopeRecent, WhiteboardScopeShared, WhiteboardScopeTrash:
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
	access, err := r.RequireAccess(ctx, accountID, userID, boardID, domain.WhiteboardAccessView)
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
	rows, err := r.db.Query(ctx, `WITH visible AS (
		SELECT `+whiteboardSelectColumns+`,
			COALESCE(folder.name,'') AS folder_name,
			COALESCE(NULLIF(creator.display_name,''),creator.username,'') AS owner_name,
			COALESCE(NULLIF(updater.display_name,''),updater.username,'') AS updated_by_name,
			(board.created_by<>$2 AND (grant_item.user_id IS NOT NULL OR board.access_mode='account')) AS shared,
			CASE
				WHEN COALESCE(account_user.is_super_admin,FALSE) OR COALESCE(membership.role,'') IN ('admin','super_admin') THEN 'manage'
				WHEN board.created_by=$2 THEN 'manage'
				WHEN grant_item.access_level IS NOT NULL THEN grant_item.access_level
				WHEN board.access_mode='account' THEN 'view'
				ELSE 'none'
			END AS effective_level,
			CASE
				WHEN COALESCE(account_user.is_super_admin,FALSE) OR COALESCE(membership.role,'') IN ('admin','super_admin') THEN TRUE
				WHEN board.created_by=$2 THEN TRUE
				ELSE COALESCE(grant_item.can_manage_access,FALSE)
			END AS can_manage,
			CASE
				WHEN COALESCE(account_user.is_super_admin,FALSE) OR COALESCE(membership.role,'') IN ('admin','super_admin') THEN 'account_admin'
				WHEN board.created_by=$2 THEN 'creator'
				WHEN grant_item.access_level IS NOT NULL THEN 'direct_grant'
				WHEN board.access_mode='account' THEN 'account_visibility'
				ELSE 'private'
			END AS access_source
		FROM whiteboards board
		JOIN users account_user ON account_user.id=$2 AND account_user.is_active
		LEFT JOIN user_accounts membership ON membership.account_id=board.account_id AND membership.user_id=$2
		LEFT JOIN whiteboard_grants grant_item ON grant_item.account_id=board.account_id
			AND grant_item.board_id=board.id AND grant_item.user_id=$2
		LEFT JOIN whiteboard_folders folder ON folder.account_id=board.account_id AND folder.id=board.folder_id
		LEFT JOIN users creator ON creator.id=board.created_by
		LEFT JOIN users updater ON updater.id=board.updated_by
		WHERE board.account_id=$1
			AND (membership.user_id IS NOT NULL OR account_user.account_id=$1)
			AND (($3::text='trash' AND board.archived_at IS NOT NULL) OR ($3::text<>'trash' AND board.archived_at IS NULL))
			AND ($3::text<>'mine' OR board.created_by=$2)
			AND ($3::text<>'recent' OR board.updated_at>=NOW()-INTERVAL '30 days')
			AND ($3::text<>'shared' OR (board.created_by<>$2
				AND (grant_item.user_id IS NOT NULL OR board.access_mode='account')))
			AND ($4::uuid IS NULL OR board.folder_id=$4::uuid)
			AND ($5::text='' OR board.name ILIKE '%'||$5::text||'%' OR board.description ILIKE '%'||$5::text||'%'
				OR COALESCE(folder.name,'') ILIKE '%'||$5::text||'%'
				OR COALESCE(NULLIF(creator.display_name,''),creator.username,'') ILIKE '%'||$5::text||'%')
			AND ($6::timestamptz IS NULL OR (board.updated_at,board.id)<($6::timestamptz,$7::uuid))
	)
	SELECT id,account_id,folder_id,name,description,scene_schema_version,editor_version,scene_sequence,
		version,access_mode,access_revision,thumbnail_media_asset_id,thumbnail_asset_id,created_by,updated_by,archived_at,
		created_at,updated_at,effective_level,can_manage,access_source,folder_name,owner_name,updated_by_name,shared
	FROM visible WHERE effective_level<>'none'
	ORDER BY updated_at DESC,id DESC LIMIT $8`, accountID, userID, scope,
		options.FolderID, query, options.BeforeUpdatedAt, options.BeforeID, limit+1)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	items := make([]*domain.Whiteboard, 0, limit)
	for rows.Next() {
		item := &domain.Whiteboard{}
		var level, source string
		var manage bool
		if err := rows.Scan(&item.ID, &item.AccountID, &item.FolderID, &item.Name, &item.Description,
			&item.SceneSchemaVersion, &item.EditorVersion, &item.SceneSequence, &item.Version, &item.AccessMode,
			&item.AccessRevision, &item.ThumbnailMediaAssetID, &item.ThumbnailAssetID, &item.CreatedBy, &item.UpdatedBy, &item.ArchivedAt,
			&item.CreatedAt, &item.UpdatedAt, &level, &manage, &source, &item.FolderName, &item.OwnerName,
			&item.UpdatedByName, &item.Shared); err != nil {
			return nil, false, err
		}
		item.EffectiveAccess = BuildWhiteboardEffectiveAccess(level, manage, source)
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

func (r *WhiteboardRepository) CountBoardScopes(ctx context.Context, accountID, userID uuid.UUID) (map[string]int64, error) {
	var all, mine, recent, shared, trash int64
	err := r.db.QueryRow(ctx, `WITH visible AS (
		SELECT board.archived_at,board.updated_at,board.created_by,
			(board.created_by<>$2 AND (grant_item.user_id IS NOT NULL OR board.access_mode='account')) AS shared,
			CASE
				WHEN COALESCE(account_user.is_super_admin,FALSE) OR COALESCE(membership.role,'') IN ('admin','super_admin') THEN 'manage'
				WHEN board.created_by=$2 THEN 'manage'
				WHEN grant_item.access_level IS NOT NULL THEN grant_item.access_level
				WHEN board.access_mode='account' THEN 'view'
				ELSE 'none'
			END AS effective_level
		FROM whiteboards board
		JOIN users account_user ON account_user.id=$2 AND account_user.is_active
		LEFT JOIN user_accounts membership ON membership.account_id=board.account_id AND membership.user_id=$2
		LEFT JOIN whiteboard_grants grant_item ON grant_item.account_id=board.account_id
			AND grant_item.board_id=board.id AND grant_item.user_id=$2
		WHERE board.account_id=$1 AND (membership.user_id IS NOT NULL OR account_user.account_id=$1)
	)
	SELECT
		COUNT(*) FILTER (WHERE archived_at IS NULL),
		COUNT(*) FILTER (WHERE archived_at IS NULL AND created_by=$2),
		COUNT(*) FILTER (WHERE archived_at IS NULL AND updated_at>=NOW()-INTERVAL '30 days'),
		COUNT(*) FILTER (WHERE archived_at IS NULL AND shared),
		COUNT(*) FILTER (WHERE archived_at IS NOT NULL)
	FROM visible WHERE effective_level<>'none'`, accountID, userID).Scan(&all, &mine, &recent, &shared, &trash)
	if err != nil {
		return nil, err
	}
	return map[string]int64{
		WhiteboardScopeAll: all, WhiteboardScopeMine: mine, WhiteboardScopeRecent: recent,
		WhiteboardScopeShared: shared, WhiteboardScopeTrash: trash,
	}, nil
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
