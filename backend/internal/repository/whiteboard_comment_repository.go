package repository

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

const (
	maxWhiteboardCommentRunes               = 4000
	maxWhiteboardCommentBodyBytes           = maxWhiteboardCommentRunes * utf8.UTFMax
	maxWhiteboardCommentsPerThread          = 200
	maxWhiteboardCommentThreadsPerPage      = 40
	maxWhiteboardCommentMarkersPerPage      = 200
	maxWhiteboardCommentPreviewsPerThread   = 5
	maxWhiteboardCommentPreviewCount        = maxWhiteboardCommentThreadsPerPage * maxWhiteboardCommentPreviewsPerThread
	maxWhiteboardCommentPreviewBodyBytes    = maxWhiteboardCommentPreviewCount * maxWhiteboardCommentBodyBytes
	maxWhiteboardThreadCommentPageSize      = 100
	maxWhiteboardThreadCommentPageBodyBytes = maxWhiteboardThreadCommentPageSize * maxWhiteboardCommentBodyBytes
	maxWhiteboardAnchorCoordinate           = 1_000_000_000
)

const (
	whiteboardCommentActionThreadCreated = "comment.thread_created"
	whiteboardCommentActionReplied       = "comment.replied"
	whiteboardCommentActionEdited        = "comment.edited"
	whiteboardCommentActionDeleted       = "comment.deleted"
	whiteboardCommentActionResolved      = "comment.resolved"
	whiteboardCommentActionReopened      = "comment.reopened"
)

type WhiteboardCommentThreadListOptions struct {
	Status          string
	BeforeUpdatedAt *time.Time
	BeforeID        *uuid.UUID
	Limit           int
}

type WhiteboardCommentThreadCreateInput struct {
	OperationID  uuid.UUID
	ElementID    *string
	AnchorX      float64
	AnchorY      float64
	AnchorRatioX *float64
	AnchorRatioY *float64
	Body         string
}

type WhiteboardCommentListOptions struct {
	AfterCreatedAt *time.Time
	AfterID        *uuid.UUID
	Limit          int
}

type WhiteboardCommentMarkerListOptions struct {
	BeforeUpdatedAt *time.Time
	BeforeID        *uuid.UUID
	Limit           int
}

func normalizeWhiteboardCommentThreadListLimit(limit int) int {
	if limit <= 0 {
		return maxWhiteboardCommentThreadsPerPage
	}
	if limit > maxWhiteboardCommentThreadsPerPage {
		return maxWhiteboardCommentThreadsPerPage
	}
	return limit
}

func normalizeWhiteboardThreadCommentListLimit(limit int) int {
	if limit <= 0 {
		return 50
	}
	if limit > maxWhiteboardThreadCommentPageSize {
		return maxWhiteboardThreadCommentPageSize
	}
	return limit
}

func normalizeWhiteboardCommentMarkerListLimit(limit int) int {
	if limit <= 0 {
		return 50
	}
	if limit > maxWhiteboardCommentMarkersPerPage {
		return maxWhiteboardCommentMarkersPerPage
	}
	return limit
}

type WhiteboardCommentReplyInput struct {
	OperationID uuid.UUID
	Body        string
}

type WhiteboardCommentEditInput struct {
	OperationID     uuid.UUID
	ExpectedVersion int64
	Body            string
}

type WhiteboardCommentDeleteInput struct {
	OperationID     uuid.UUID
	ExpectedVersion int64
}

type WhiteboardCommentStatusInput struct {
	OperationID     uuid.UUID
	ExpectedVersion int64
	Status          string
}

func normalizeWhiteboardCommentBody(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" || !utf8.ValidString(value) || utf8.RuneCountInString(value) > maxWhiteboardCommentRunes {
		return "", ErrWhiteboardInvalid
	}
	return value, nil
}

func validWhiteboardCommentCoordinate(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && math.Abs(value) <= maxWhiteboardAnchorCoordinate
}

func validateWhiteboardCommentAnchor(elementID *string, x, y float64, ratioX, ratioY *float64) error {
	if !validWhiteboardCommentCoordinate(x) || !validWhiteboardCommentCoordinate(y) {
		return ErrWhiteboardInvalid
	}
	if elementID == nil {
		if ratioX != nil || ratioY != nil {
			return ErrWhiteboardInvalid
		}
		return nil
	}
	trimmed := strings.TrimSpace(*elementID)
	if trimmed == "" || trimmed != *elementID || !utf8.ValidString(trimmed) || utf8.RuneCountInString(trimmed) > 255 {
		return ErrWhiteboardInvalid
	}
	if (ratioX == nil) != (ratioY == nil) {
		return ErrWhiteboardInvalid
	}
	if ratioX != nil && (!validWhiteboardCommentCoordinate(*ratioX) || !validWhiteboardCommentCoordinate(*ratioY) || *ratioX < 0 || *ratioX > 1 || *ratioY < 0 || *ratioY > 1) {
		return ErrWhiteboardInvalid
	}
	return nil
}

func whiteboardCommentPayloadHash(value any) (string, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", ErrWhiteboardInvalid
	}
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:]), nil
}

func validWhiteboardCommentStatus(status string, allowAll bool) bool {
	return status == domain.WhiteboardCommentOpen || status == domain.WhiteboardCommentResolved || (allowAll && status == "all")
}

func scanWhiteboardCommentThread(scanner whiteboardRowScanner) (*domain.WhiteboardCommentThread, error) {
	item := &domain.WhiteboardCommentThread{Comments: []*domain.WhiteboardComment{}}
	err := scanner.Scan(&item.ID, &item.AccountID, &item.BoardID, &item.ElementID,
		&item.AnchorX, &item.AnchorY, &item.AnchorRatioX, &item.AnchorRatioY,
		&item.Status, &item.Version, &item.CreatedBy, &item.CreatedByName,
		&item.ResolvedBy, &item.ResolvedAt, &item.CreatedAt, &item.UpdatedAt)
	return item, err
}

func scanWhiteboardComment(scanner whiteboardRowScanner) (*domain.WhiteboardComment, error) {
	item := &domain.WhiteboardComment{}
	err := scanner.Scan(&item.ID, &item.ThreadID, &item.AuthorID, &item.AuthorName,
		&item.Body, &item.Version, &item.DeletedAt, &item.CreatedAt, &item.UpdatedAt)
	return item, err
}

const whiteboardCommentThreadColumns = `thread.id,thread.account_id,thread.board_id,thread.element_id,
	thread.anchor_x,thread.anchor_y,thread.anchor_ratio_x,thread.anchor_ratio_y,
	thread.status,thread.version,thread.created_by,
	COALESCE(NULLIF(author.display_name,''),author.username,''),thread.resolved_by,thread.resolved_at,
	thread.created_at,thread.updated_at`

func (r *WhiteboardRepository) hydrateWhiteboardThreadComments(ctx context.Context, accountID, boardID uuid.UUID, threads []*domain.WhiteboardCommentThread) error {
	if len(threads) == 0 {
		return nil
	}
	threadIDs := make([]uuid.UUID, 0, len(threads))
	byID := make(map[uuid.UUID]*domain.WhiteboardCommentThread, len(threads))
	for _, thread := range threads {
		threadIDs = append(threadIDs, thread.ID)
		byID[thread.ID] = thread
	}
	rows, err := r.db.Query(ctx, `SELECT comment.id,comment.thread_id,comment.author_id,
		COALESCE(NULLIF(author.display_name,''),author.username,''),comment.body,comment.version,
		comment.deleted_at,comment.created_at,comment.updated_at
		FROM whiteboard_comments comment
		LEFT JOIN users author ON author.id=comment.author_id
		WHERE comment.account_id=$1 AND comment.board_id=$2 AND comment.thread_id=ANY($3::uuid[])
		ORDER BY comment.created_at,comment.id`, accountID, boardID, threadIDs)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		item, err := scanWhiteboardComment(rows)
		if err != nil {
			return err
		}
		if thread := byID[item.ThreadID]; thread != nil {
			thread.Comments = append(thread.Comments, item)
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, thread := range threads {
		thread.CommentCount = len(thread.Comments)
		thread.CommentsHasMore = false
	}
	return nil
}

// hydrateWhiteboardThreadCommentPreviews returns a bounded, contiguous prefix
// for every thread in one query. With the thread-page cap this can return at
// most 200 comments / 3.2 MB of comment bodies, independent of history depth.
func (r *WhiteboardRepository) hydrateWhiteboardThreadCommentPreviews(ctx context.Context, accountID, boardID uuid.UUID, threads []*domain.WhiteboardCommentThread) error {
	if len(threads) == 0 {
		return nil
	}
	threadIDs := make([]uuid.UUID, 0, len(threads))
	byID := make(map[uuid.UUID]*domain.WhiteboardCommentThread, len(threads))
	for _, thread := range threads {
		threadIDs = append(threadIDs, thread.ID)
		byID[thread.ID] = thread
	}
	rows, err := r.db.Query(ctx, `WITH selected(thread_id,ordinal) AS (
			SELECT * FROM unnest($3::uuid[]) WITH ORDINALITY
		), ranked AS (
			SELECT candidate.*,selected.ordinal,
				ROW_NUMBER() OVER (PARTITION BY candidate.thread_id ORDER BY candidate.created_at,candidate.id) AS comment_position,
				(COUNT(*) OVER (PARTITION BY candidate.thread_id))::int AS comment_count
			FROM selected JOIN whiteboard_comments candidate ON candidate.thread_id=selected.thread_id
			WHERE candidate.account_id=$1 AND candidate.board_id=$2 AND octet_length(candidate.body)<=$4
		)
		SELECT comment.id,comment.thread_id,comment.author_id,
		COALESCE(NULLIF(author.display_name,''),author.username,''),comment.body,comment.version,
		comment.deleted_at,comment.created_at,comment.updated_at,comment.comment_count
		FROM ranked comment
		LEFT JOIN users author ON author.id=comment.author_id
		WHERE comment.comment_position<=$5
		ORDER BY comment.ordinal,comment.created_at,comment.id`, accountID, boardID, threadIDs,
		maxWhiteboardCommentBodyBytes, maxWhiteboardCommentPreviewsPerThread)
	if err != nil {
		return err
	}
	defer rows.Close()
	totalComments := 0
	totalBodyBytes := 0
	for rows.Next() {
		item := &domain.WhiteboardComment{}
		var commentCount int
		if err := rows.Scan(&item.ID, &item.ThreadID, &item.AuthorID, &item.AuthorName,
			&item.Body, &item.Version, &item.DeletedAt, &item.CreatedAt, &item.UpdatedAt, &commentCount); err != nil {
			return err
		}
		thread := byID[item.ThreadID]
		if thread == nil {
			continue
		}
		thread.CommentCount = commentCount
		if totalComments >= maxWhiteboardCommentPreviewCount || totalBodyBytes+len(item.Body) > maxWhiteboardCommentPreviewBodyBytes {
			thread.CommentsHasMore = true
			continue
		}
		thread.Comments = append(thread.Comments, item)
		totalComments++
		totalBodyBytes += len(item.Body)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, thread := range threads {
		thread.CommentsHasMore = thread.CommentsHasMore || thread.CommentCount > len(thread.Comments)
	}
	return nil
}

func (r *WhiteboardRepository) getWhiteboardCommentThread(ctx context.Context, accountID, boardID, threadID uuid.UUID) (*domain.WhiteboardCommentThread, error) {
	item, err := scanWhiteboardCommentThread(r.db.QueryRow(ctx, `SELECT `+whiteboardCommentThreadColumns+`
		FROM whiteboard_comment_threads thread
		LEFT JOIN users author ON author.id=thread.created_by
		WHERE thread.account_id=$1 AND thread.board_id=$2 AND thread.id=$3`, accountID, boardID, threadID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrWhiteboardNotFound
	}
	if err != nil {
		return nil, err
	}
	if err := r.hydrateWhiteboardThreadComments(ctx, accountID, boardID, []*domain.WhiteboardCommentThread{item}); err != nil {
		return nil, err
	}
	return item, nil
}

func (r *WhiteboardRepository) GetWhiteboardCommentThread(ctx context.Context, accountID, actorID, boardID, threadID uuid.UUID) (*domain.WhiteboardCommentThread, error) {
	if boardID == uuid.Nil || threadID == uuid.Nil {
		return nil, ErrWhiteboardInvalid
	}
	if _, err := r.RequireAccess(ctx, accountID, actorID, boardID, domain.WhiteboardAccessView); err != nil {
		return nil, err
	}
	return r.getWhiteboardCommentThread(ctx, accountID, boardID, threadID)
}

func (r *WhiteboardRepository) GetWhiteboardCommentThreadCounts(ctx context.Context, accountID, actorID, boardID uuid.UUID) (domain.WhiteboardCommentThreadCounts, error) {
	counts := domain.WhiteboardCommentThreadCounts{}
	if boardID == uuid.Nil {
		return counts, ErrWhiteboardInvalid
	}
	if _, err := r.RequireAccess(ctx, accountID, actorID, boardID, domain.WhiteboardAccessView); err != nil {
		return counts, err
	}
	err := r.db.QueryRow(ctx, `SELECT
		COUNT(*) FILTER (WHERE status='open'),
		COUNT(*) FILTER (WHERE status='resolved'),
		COUNT(*)
		FROM whiteboard_comment_threads
		WHERE account_id=$1 AND board_id=$2`, accountID, boardID).Scan(&counts.Open, &counts.Resolved, &counts.All)
	return counts, err
}

func (r *WhiteboardRepository) ListWhiteboardCommentMarkers(ctx context.Context, accountID, actorID, boardID uuid.UUID, options WhiteboardCommentMarkerListOptions) ([]*domain.WhiteboardCommentMarker, bool, error) {
	if boardID == uuid.Nil || (options.BeforeUpdatedAt == nil) != (options.BeforeID == nil) {
		return nil, false, ErrWhiteboardInvalid
	}
	if _, err := r.RequireAccess(ctx, accountID, actorID, boardID, domain.WhiteboardAccessView); err != nil {
		return nil, false, err
	}
	limit := normalizeWhiteboardCommentMarkerListLimit(options.Limit)
	rows, err := r.db.Query(ctx, `WITH selected AS (
			SELECT thread.id,thread.account_id,thread.board_id,thread.element_id,
				thread.anchor_x,thread.anchor_y,thread.anchor_ratio_x,thread.anchor_ratio_y,
				thread.version,thread.updated_at
			FROM whiteboard_comment_threads thread
			WHERE thread.account_id=$1 AND thread.board_id=$2 AND thread.status='open'
			AND ($3::timestamptz IS NULL OR (thread.updated_at,thread.id)<($3::timestamptz,$4::uuid))
			ORDER BY thread.updated_at DESC,thread.id DESC LIMIT $5
		)
		SELECT selected.id,selected.board_id,selected.element_id,
			selected.anchor_x,selected.anchor_y,selected.anchor_ratio_x,selected.anchor_ratio_y,
			selected.version,COUNT(comment.id)::int,selected.updated_at
		FROM selected
		LEFT JOIN whiteboard_comments comment ON comment.account_id=selected.account_id
			AND comment.board_id=selected.board_id AND comment.thread_id=selected.id
		GROUP BY selected.id,selected.board_id,selected.element_id,selected.anchor_x,selected.anchor_y,
			selected.anchor_ratio_x,selected.anchor_ratio_y,selected.version,selected.updated_at
		ORDER BY selected.updated_at DESC,selected.id DESC`, accountID, boardID,
		options.BeforeUpdatedAt, options.BeforeID, limit+1)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	items := make([]*domain.WhiteboardCommentMarker, 0, limit)
	for rows.Next() {
		item := &domain.WhiteboardCommentMarker{}
		if err := rows.Scan(&item.ID, &item.BoardID, &item.ElementID,
			&item.AnchorX, &item.AnchorY, &item.AnchorRatioX, &item.AnchorRatioY,
			&item.Version, &item.CommentCount, &item.UpdatedAt); err != nil {
			return nil, false, err
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

func (r *WhiteboardRepository) ListWhiteboardCommentThreads(ctx context.Context, accountID, actorID, boardID uuid.UUID, options WhiteboardCommentThreadListOptions) ([]*domain.WhiteboardCommentThread, bool, error) {
	if _, err := r.RequireAccess(ctx, accountID, actorID, boardID, domain.WhiteboardAccessView); err != nil {
		return nil, false, err
	}
	status := strings.ToLower(strings.TrimSpace(options.Status))
	if status == "" {
		status = domain.WhiteboardCommentOpen
	}
	if !validWhiteboardCommentStatus(status, true) {
		return nil, false, ErrWhiteboardInvalid
	}
	if (options.BeforeUpdatedAt == nil) != (options.BeforeID == nil) {
		return nil, false, ErrWhiteboardInvalid
	}
	limit := normalizeWhiteboardCommentThreadListLimit(options.Limit)
	rows, err := r.db.Query(ctx, `SELECT `+whiteboardCommentThreadColumns+`
		FROM whiteboard_comment_threads thread
		LEFT JOIN users author ON author.id=thread.created_by
		WHERE thread.account_id=$1 AND thread.board_id=$2
		AND ($3::text='all' OR thread.status=$3::text)
		AND ($4::timestamptz IS NULL OR (thread.updated_at,thread.id)<($4::timestamptz,$5::uuid))
		ORDER BY thread.updated_at DESC,thread.id DESC LIMIT $6`, accountID, boardID, status,
		options.BeforeUpdatedAt, options.BeforeID, limit+1)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	items := make([]*domain.WhiteboardCommentThread, 0, limit)
	for rows.Next() {
		item, scanErr := scanWhiteboardCommentThread(rows)
		if scanErr != nil {
			return nil, false, scanErr
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
	if err := r.hydrateWhiteboardThreadCommentPreviews(ctx, accountID, boardID, items); err != nil {
		return nil, false, err
	}
	return items, hasMore, nil
}

func (r *WhiteboardRepository) ListWhiteboardThreadComments(ctx context.Context, accountID, actorID, boardID, threadID uuid.UUID, options WhiteboardCommentListOptions) ([]*domain.WhiteboardComment, bool, error) {
	if threadID == uuid.Nil || (options.AfterCreatedAt == nil) != (options.AfterID == nil) {
		return nil, false, ErrWhiteboardInvalid
	}
	if _, err := r.RequireAccess(ctx, accountID, actorID, boardID, domain.WhiteboardAccessView); err != nil {
		return nil, false, err
	}
	limit := normalizeWhiteboardThreadCommentListLimit(options.Limit)
	rows, err := r.db.Query(ctx, `SELECT comment.id,comment.thread_id,comment.author_id,
		COALESCE(NULLIF(author.display_name,''),author.username,''),comment.body,comment.version,
		comment.deleted_at,comment.created_at,comment.updated_at
		FROM whiteboard_comments comment
		JOIN whiteboard_comment_threads thread ON thread.account_id=comment.account_id
			AND thread.board_id=comment.board_id AND thread.id=comment.thread_id
		LEFT JOIN users author ON author.id=comment.author_id
		WHERE comment.account_id=$1 AND comment.board_id=$2 AND comment.thread_id=$3
		AND octet_length(comment.body)<=$4
		AND ($5::timestamptz IS NULL OR (comment.created_at,comment.id)>($5::timestamptz,$6::uuid))
		ORDER BY comment.created_at,comment.id LIMIT $7`, accountID, boardID, threadID,
		maxWhiteboardCommentBodyBytes, options.AfterCreatedAt, options.AfterID, limit+1)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	items := make([]*domain.WhiteboardComment, 0, limit)
	for rows.Next() {
		item, scanErr := scanWhiteboardComment(rows)
		if scanErr != nil {
			return nil, false, scanErr
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	if len(items) == 0 {
		var exists bool
		if err := r.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM whiteboard_comment_threads
			WHERE account_id=$1 AND board_id=$2 AND id=$3)`, accountID, boardID, threadID).Scan(&exists); err != nil {
			return nil, false, err
		}
		if !exists {
			return nil, false, ErrWhiteboardNotFound
		}
	}
	hasMore := len(items) > limit
	if hasMore {
		items = items[:limit]
	}
	totalBodyBytes := 0
	for _, item := range items {
		totalBodyBytes += len(item.Body)
	}
	if totalBodyBytes > maxWhiteboardThreadCommentPageBodyBytes {
		return nil, false, ErrWhiteboardInvalid
	}
	return items, hasMore, nil
}

func requireActiveWhiteboardCommentAccessTx(ctx context.Context, tx pgx.Tx, accountID, actorID, boardID uuid.UUID) error {
	var archivedAt *time.Time
	if err := tx.QueryRow(ctx, `SELECT archived_at FROM whiteboards WHERE account_id=$1 AND id=$2 FOR SHARE`, accountID, boardID).Scan(&archivedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrWhiteboardNotFound
		}
		return err
	}
	if _, err := requireWhiteboardAccessTx(ctx, tx, accountID, actorID, boardID, domain.WhiteboardAccessComment, false); err != nil {
		return err
	}
	if archivedAt != nil {
		return ErrWhiteboardConflict
	}
	return nil
}

// reserveWhiteboardCommentOperationTx makes every mutation safely retryable.
// For create/reply, the canonical entity ID from the first attempt is returned.
func reserveWhiteboardCommentOperationTx(ctx context.Context, tx pgx.Tx, accountID, boardID, actorID, operationID uuid.UUID, action string, proposedEntityID uuid.UUID, payloadHash string, requireSameEntity bool) (uuid.UUID, bool, error) {
	if operationID == uuid.Nil || actorID == uuid.Nil || proposedEntityID == uuid.Nil || payloadHash == "" {
		return uuid.Nil, false, ErrWhiteboardInvalid
	}
	command, err := tx.Exec(ctx, `INSERT INTO whiteboard_comment_operations(
		account_id,board_id,operation_id,actor_id,action,entity_id,request_payload_hash
	) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(account_id,board_id,operation_id) DO NOTHING`,
		accountID, boardID, operationID, actorID, action, proposedEntityID, payloadHash)
	if err != nil {
		return uuid.Nil, false, err
	}
	if command.RowsAffected() == 1 {
		return proposedEntityID, false, nil
	}
	var existingActor *uuid.UUID
	var existingAction string
	var existingEntity uuid.UUID
	var existingHash string
	if err := tx.QueryRow(ctx, `SELECT actor_id,action,entity_id,request_payload_hash
		FROM whiteboard_comment_operations WHERE account_id=$1 AND board_id=$2 AND operation_id=$3`,
		accountID, boardID, operationID).Scan(&existingActor, &existingAction, &existingEntity, &existingHash); err != nil {
		return uuid.Nil, false, err
	}
	if existingActor == nil || *existingActor != actorID || existingAction != action || existingHash != payloadHash || (requireSameEntity && existingEntity != proposedEntityID) {
		return uuid.Nil, false, ErrWhiteboardConflict
	}
	return existingEntity, true, nil
}

func (r *WhiteboardRepository) CreateWhiteboardCommentThread(ctx context.Context, accountID, actorID, boardID uuid.UUID, input WhiteboardCommentThreadCreateInput) (*domain.WhiteboardCommentThread, error) {
	body, err := normalizeWhiteboardCommentBody(input.Body)
	if err != nil || validateWhiteboardCommentAnchor(input.ElementID, input.AnchorX, input.AnchorY, input.AnchorRatioX, input.AnchorRatioY) != nil || input.OperationID == uuid.Nil {
		return nil, ErrWhiteboardInvalid
	}
	payloadHash, _ := whiteboardCommentPayloadHash(struct {
		ElementID    *string  `json:"element_id"`
		AnchorX      float64  `json:"anchor_x"`
		AnchorY      float64  `json:"anchor_y"`
		AnchorRatioX *float64 `json:"anchor_ratio_x"`
		AnchorRatioY *float64 `json:"anchor_ratio_y"`
		Body         string   `json:"body"`
	}{input.ElementID, input.AnchorX, input.AnchorY, input.AnchorRatioX, input.AnchorRatioY, body})
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := requireActiveWhiteboardCommentAccessTx(ctx, tx, accountID, actorID, boardID); err != nil {
		return nil, err
	}
	threadID, idempotent, err := reserveWhiteboardCommentOperationTx(ctx, tx, accountID, boardID, actorID,
		input.OperationID, whiteboardCommentActionThreadCreated, uuid.New(), payloadHash, false)
	if err != nil {
		return nil, err
	}
	if !idempotent {
		if _, err := tx.Exec(ctx, `INSERT INTO whiteboard_comment_threads(
			id,account_id,board_id,element_id,anchor_x,anchor_y,anchor_ratio_x,anchor_ratio_y,
			created_by,operation_id,request_payload_hash
		) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, threadID, accountID, boardID,
			input.ElementID, input.AnchorX, input.AnchorY, input.AnchorRatioX, input.AnchorRatioY,
			actorID, input.OperationID, payloadHash); err != nil {
			return nil, normalizeWhiteboardConstraintError(err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO whiteboard_comments(
			id,account_id,board_id,thread_id,author_id,body
		) VALUES($1,$2,$3,$4,$5,$6)`, uuid.New(), accountID, boardID, threadID, actorID, body); err != nil {
			return nil, normalizeWhiteboardConstraintError(err)
		}
		details, _ := json.Marshal(map[string]any{"thread_id": threadID})
		if err := insertWhiteboardActivityTx(ctx, tx, WhiteboardActivityInput{AccountID: accountID, BoardID: boardID,
			ActorID: &actorID, Action: whiteboardCommentActionThreadCreated, Details: details, OperationID: &input.OperationID}); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return r.getWhiteboardCommentThread(ctx, accountID, boardID, threadID)
}

func (r *WhiteboardRepository) AddWhiteboardCommentReply(ctx context.Context, accountID, actorID, boardID, threadID uuid.UUID, input WhiteboardCommentReplyInput) (*domain.WhiteboardCommentThread, error) {
	body, err := normalizeWhiteboardCommentBody(input.Body)
	if err != nil || input.OperationID == uuid.Nil || threadID == uuid.Nil {
		return nil, ErrWhiteboardInvalid
	}
	payloadHash, _ := whiteboardCommentPayloadHash(struct {
		ThreadID uuid.UUID `json:"thread_id"`
		Body     string    `json:"body"`
	}{threadID, body})
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := requireWhiteboardAccessTx(ctx, tx, accountID, actorID, boardID, domain.WhiteboardAccessComment, false); err != nil {
		return nil, err
	}
	commentID, idempotent, err := reserveWhiteboardCommentOperationTx(ctx, tx, accountID, boardID, actorID,
		input.OperationID, whiteboardCommentActionReplied, uuid.New(), payloadHash, false)
	if err != nil {
		return nil, err
	}
	if idempotent {
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return r.getWhiteboardCommentThread(ctx, accountID, boardID, threadID)
	}
	if err := requireActiveWhiteboardCommentAccessTx(ctx, tx, accountID, actorID, boardID); err != nil {
		return nil, err
	}
	var status string
	var count int
	if err := tx.QueryRow(ctx, `SELECT thread.status,(SELECT COUNT(*) FROM whiteboard_comments comment
		WHERE comment.account_id=thread.account_id AND comment.board_id=thread.board_id AND comment.thread_id=thread.id)
		FROM whiteboard_comment_threads thread WHERE thread.account_id=$1 AND thread.board_id=$2 AND thread.id=$3 FOR UPDATE`,
		accountID, boardID, threadID).Scan(&status, &count); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrWhiteboardNotFound
		}
		return nil, err
	}
	if status != domain.WhiteboardCommentOpen || count >= maxWhiteboardCommentsPerThread {
		return nil, ErrWhiteboardConflict
	}
	if _, err := tx.Exec(ctx, `INSERT INTO whiteboard_comments(
			id,account_id,board_id,thread_id,author_id,body
		) VALUES($1,$2,$3,$4,$5,$6)`, commentID, accountID, boardID, threadID, actorID, body); err != nil {
		return nil, normalizeWhiteboardConstraintError(err)
	}
	if _, err := tx.Exec(ctx, `UPDATE whiteboard_comment_threads SET version=version+1,updated_at=NOW()
			WHERE account_id=$1 AND board_id=$2 AND id=$3`, accountID, boardID, threadID); err != nil {
		return nil, err
	}
	details, _ := json.Marshal(map[string]any{"thread_id": threadID, "comment_id": commentID})
	if err := insertWhiteboardActivityTx(ctx, tx, WhiteboardActivityInput{AccountID: accountID, BoardID: boardID,
		ActorID: &actorID, Action: whiteboardCommentActionReplied, Details: details, OperationID: &input.OperationID}); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return r.getWhiteboardCommentThread(ctx, accountID, boardID, threadID)
}

func (r *WhiteboardRepository) EditWhiteboardComment(ctx context.Context, accountID, actorID, boardID, threadID, commentID uuid.UUID, input WhiteboardCommentEditInput) (*domain.WhiteboardCommentThread, error) {
	body, err := normalizeWhiteboardCommentBody(input.Body)
	if err != nil || input.OperationID == uuid.Nil || input.ExpectedVersion <= 0 {
		return nil, ErrWhiteboardInvalid
	}
	payloadHash, _ := whiteboardCommentPayloadHash(struct {
		ThreadID        uuid.UUID `json:"thread_id"`
		CommentID       uuid.UUID `json:"comment_id"`
		ExpectedVersion int64     `json:"expected_version"`
		Body            string    `json:"body"`
	}{threadID, commentID, input.ExpectedVersion, body})
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := requireActiveWhiteboardCommentAccessTx(ctx, tx, accountID, actorID, boardID); err != nil {
		return nil, err
	}
	_, idempotent, err := reserveWhiteboardCommentOperationTx(ctx, tx, accountID, boardID, actorID,
		input.OperationID, whiteboardCommentActionEdited, commentID, payloadHash, true)
	if err != nil {
		return nil, err
	}
	if !idempotent {
		var authorID *uuid.UUID
		var version int64
		var deletedAt *time.Time
		var status string
		if err := tx.QueryRow(ctx, `SELECT comment.author_id,comment.version,comment.deleted_at,thread.status
			FROM whiteboard_comments comment JOIN whiteboard_comment_threads thread
			ON thread.account_id=comment.account_id AND thread.board_id=comment.board_id AND thread.id=comment.thread_id
			WHERE comment.account_id=$1 AND comment.board_id=$2 AND comment.thread_id=$3 AND comment.id=$4
			FOR UPDATE OF comment,thread`, accountID, boardID, threadID, commentID).Scan(&authorID, &version, &deletedAt, &status); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, ErrWhiteboardNotFound
			}
			return nil, err
		}
		if authorID == nil || *authorID != actorID {
			return nil, ErrWhiteboardForbidden
		}
		if deletedAt != nil || status != domain.WhiteboardCommentOpen {
			return nil, ErrWhiteboardConflict
		}
		if err := checkWhiteboardExpectedVersion(input.ExpectedVersion, version); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `UPDATE whiteboard_comments SET body=$5,version=version+1,updated_at=NOW()
			WHERE account_id=$1 AND board_id=$2 AND thread_id=$3 AND id=$4`, accountID, boardID, threadID, commentID, body); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `UPDATE whiteboard_comment_threads SET version=version+1,updated_at=NOW()
			WHERE account_id=$1 AND board_id=$2 AND id=$3`, accountID, boardID, threadID); err != nil {
			return nil, err
		}
		details, _ := json.Marshal(map[string]any{"thread_id": threadID, "comment_id": commentID})
		if err := insertWhiteboardActivityTx(ctx, tx, WhiteboardActivityInput{AccountID: accountID, BoardID: boardID,
			ActorID: &actorID, Action: whiteboardCommentActionEdited, Details: details, OperationID: &input.OperationID}); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return r.getWhiteboardCommentThread(ctx, accountID, boardID, threadID)
}

func (r *WhiteboardRepository) DeleteWhiteboardComment(ctx context.Context, accountID, actorID, boardID, threadID, commentID uuid.UUID, input WhiteboardCommentDeleteInput) (*domain.WhiteboardCommentThread, error) {
	if input.OperationID == uuid.Nil || input.ExpectedVersion <= 0 {
		return nil, ErrWhiteboardInvalid
	}
	payloadHash, _ := whiteboardCommentPayloadHash(struct {
		ThreadID        uuid.UUID `json:"thread_id"`
		CommentID       uuid.UUID `json:"comment_id"`
		ExpectedVersion int64     `json:"expected_version"`
	}{threadID, commentID, input.ExpectedVersion})
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := requireActiveWhiteboardCommentAccessTx(ctx, tx, accountID, actorID, boardID); err != nil {
		return nil, err
	}
	_, idempotent, err := reserveWhiteboardCommentOperationTx(ctx, tx, accountID, boardID, actorID,
		input.OperationID, whiteboardCommentActionDeleted, commentID, payloadHash, true)
	if err != nil {
		return nil, err
	}
	if !idempotent {
		var authorID *uuid.UUID
		var version int64
		var deletedAt *time.Time
		var status string
		if err := tx.QueryRow(ctx, `SELECT comment.author_id,comment.version,comment.deleted_at,thread.status
			FROM whiteboard_comments comment JOIN whiteboard_comment_threads thread
			ON thread.account_id=comment.account_id AND thread.board_id=comment.board_id AND thread.id=comment.thread_id
			WHERE comment.account_id=$1 AND comment.board_id=$2 AND comment.thread_id=$3 AND comment.id=$4
			FOR UPDATE OF comment,thread`, accountID, boardID, threadID, commentID).Scan(&authorID, &version, &deletedAt, &status); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, ErrWhiteboardNotFound
			}
			return nil, err
		}
		if authorID == nil || *authorID != actorID {
			return nil, ErrWhiteboardForbidden
		}
		if deletedAt != nil || status != domain.WhiteboardCommentOpen {
			return nil, ErrWhiteboardConflict
		}
		if err := checkWhiteboardExpectedVersion(input.ExpectedVersion, version); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `UPDATE whiteboard_comments SET body='',deleted_at=NOW(),version=version+1,updated_at=NOW()
			WHERE account_id=$1 AND board_id=$2 AND thread_id=$3 AND id=$4`, accountID, boardID, threadID, commentID); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `UPDATE whiteboard_comment_threads SET version=version+1,updated_at=NOW()
			WHERE account_id=$1 AND board_id=$2 AND id=$3`, accountID, boardID, threadID); err != nil {
			return nil, err
		}
		details, _ := json.Marshal(map[string]any{"thread_id": threadID, "comment_id": commentID})
		if err := insertWhiteboardActivityTx(ctx, tx, WhiteboardActivityInput{AccountID: accountID, BoardID: boardID,
			ActorID: &actorID, Action: whiteboardCommentActionDeleted, Details: details, OperationID: &input.OperationID}); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return r.getWhiteboardCommentThread(ctx, accountID, boardID, threadID)
}

func (r *WhiteboardRepository) UpdateWhiteboardCommentThreadStatus(ctx context.Context, accountID, actorID, boardID, threadID uuid.UUID, input WhiteboardCommentStatusInput) (*domain.WhiteboardCommentThread, error) {
	status := strings.ToLower(strings.TrimSpace(input.Status))
	if input.OperationID == uuid.Nil || input.ExpectedVersion <= 0 || !validWhiteboardCommentStatus(status, false) {
		return nil, ErrWhiteboardInvalid
	}
	action := whiteboardCommentActionResolved
	if status == domain.WhiteboardCommentOpen {
		action = whiteboardCommentActionReopened
	}
	payloadHash, _ := whiteboardCommentPayloadHash(struct {
		ThreadID        uuid.UUID `json:"thread_id"`
		ExpectedVersion int64     `json:"expected_version"`
		Status          string    `json:"status"`
	}{threadID, input.ExpectedVersion, status})
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := requireActiveWhiteboardCommentAccessTx(ctx, tx, accountID, actorID, boardID); err != nil {
		return nil, err
	}
	_, idempotent, err := reserveWhiteboardCommentOperationTx(ctx, tx, accountID, boardID, actorID,
		input.OperationID, action, threadID, payloadHash, true)
	if err != nil {
		return nil, err
	}
	if !idempotent {
		var currentStatus string
		var version int64
		if err := tx.QueryRow(ctx, `SELECT status,version FROM whiteboard_comment_threads
			WHERE account_id=$1 AND board_id=$2 AND id=$3 FOR UPDATE`, accountID, boardID, threadID).Scan(&currentStatus, &version); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, ErrWhiteboardNotFound
			}
			return nil, err
		}
		if currentStatus == status {
			return nil, ErrWhiteboardConflict
		}
		if err := checkWhiteboardExpectedVersion(input.ExpectedVersion, version); err != nil {
			return nil, err
		}
		if status == domain.WhiteboardCommentResolved {
			_, err = tx.Exec(ctx, `UPDATE whiteboard_comment_threads SET status='resolved',resolved_by=$4,
				resolved_at=NOW(),version=version+1,updated_at=NOW() WHERE account_id=$1 AND board_id=$2 AND id=$3`,
				accountID, boardID, threadID, actorID)
		} else {
			_, err = tx.Exec(ctx, `UPDATE whiteboard_comment_threads SET status='open',resolved_by=NULL,
				resolved_at=NULL,version=version+1,updated_at=NOW() WHERE account_id=$1 AND board_id=$2 AND id=$3`,
				accountID, boardID, threadID)
		}
		if err != nil {
			return nil, err
		}
		details, _ := json.Marshal(map[string]any{"thread_id": threadID, "status": status})
		if err := insertWhiteboardActivityTx(ctx, tx, WhiteboardActivityInput{AccountID: accountID, BoardID: boardID,
			ActorID: &actorID, Action: action, Details: details, OperationID: &input.OperationID}); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return r.getWhiteboardCommentThread(ctx, accountID, boardID, threadID)
}
