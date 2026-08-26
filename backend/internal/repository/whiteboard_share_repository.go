package repository

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

type WhiteboardShareLinkInput struct {
	Label        string
	AccessLevel  string
	TokenHash    string
	PasswordHash string
	AllowExport  bool
	ExpiresAt    *time.Time
	MaxSessions  *int
}

type WhiteboardShareLinkRecord struct {
	Link         *domain.WhiteboardShareLink
	TokenHash    string
	PasswordHash string
}

type WhiteboardTimeCursorOptions struct {
	BeforeCreatedAt *time.Time
	BeforeID        *uuid.UUID
	Limit           int
}

func scanWhiteboardShareLink(scanner whiteboardRowScanner, includeSecrets bool) (*WhiteboardShareLinkRecord, error) {
	record := &WhiteboardShareLinkRecord{Link: &domain.WhiteboardShareLink{}}
	passwordProtected := false
	if includeSecrets {
		err := scanner.Scan(&record.Link.ID, &record.Link.AccountID, &record.Link.BoardID, &record.TokenHash,
			&record.Link.Label, &record.Link.AccessLevel, &record.PasswordHash, &record.Link.AllowExport,
			&record.Link.ExpiresAt, &record.Link.MaxSessions, &record.Link.SessionCount,
			&record.Link.CreatedBy, &record.Link.RevokedAt, &record.Link.LastUsedAt,
			&record.Link.CreatedAt, &record.Link.UpdatedAt)
		record.Link.PasswordProtected = record.PasswordHash != ""
		return record, err
	}
	err := scanner.Scan(&record.Link.ID, &record.Link.AccountID, &record.Link.BoardID,
		&record.Link.Label, &record.Link.AccessLevel, &passwordProtected, &record.Link.AllowExport,
		&record.Link.ExpiresAt, &record.Link.MaxSessions, &record.Link.SessionCount,
		&record.Link.CreatedBy, &record.Link.RevokedAt, &record.Link.LastUsedAt,
		&record.Link.CreatedAt, &record.Link.UpdatedAt)
	record.Link.PasswordProtected = passwordProtected
	return record, err
}

const whiteboardShareLinkPublicColumns = `id,account_id,board_id,label,access_level,
	(password_hash IS NOT NULL AND password_hash<>''),allow_export,expires_at,max_sessions,session_count,
	created_by,revoked_at,last_used_at,created_at,updated_at`

const whiteboardShareLinkSecretColumns = `link.id,link.account_id,link.board_id,link.token_hash,link.label,link.access_level,
	COALESCE(link.password_hash,''),link.allow_export,link.expires_at,link.max_sessions,link.session_count,
	link.created_by,link.revoked_at,link.last_used_at,link.created_at,link.updated_at`

const whiteboardStandaloneBoardOriginSQL = `NOT EXISTS(SELECT 1 FROM task_location_whiteboard_views work_binding
	WHERE work_binding.account_id=board.account_id AND work_binding.whiteboard_id=board.id)`

const whiteboardStandaloneShareLinkOriginSQL = `NOT EXISTS(SELECT 1 FROM task_location_whiteboard_views work_binding
	WHERE work_binding.account_id=link.account_id AND work_binding.whiteboard_id=link.board_id)`

func requireStandaloneWhiteboardManageMutationTx(
	ctx context.Context,
	tx pgx.Tx,
	accountID, actorID, boardID uuid.UUID,
	allowArchived bool,
) error {
	workState, err := lockWorkWhiteboardParentViewTx(ctx, tx, accountID, boardID, true, true)
	if err != nil {
		return err
	}
	var archivedAt *time.Time
	if err := tx.QueryRow(ctx, `SELECT archived_at FROM whiteboards
		WHERE account_id=$1 AND id=$2 FOR UPDATE`, accountID, boardID).Scan(&archivedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrWhiteboardNotFound
		}
		return err
	}
	if _, err := requireWhiteboardAccessTx(ctx, tx, accountID, actorID, boardID, domain.WhiteboardAccessView, false); err != nil {
		return err
	}
	if err := requireStandaloneWhiteboardMutationLock(workState); err != nil {
		return err
	}
	if archivedAt != nil && !allowArchived {
		return ErrWhiteboardConflict
	}
	_, err = requireWhiteboardAccessTx(ctx, tx, accountID, actorID, boardID, domain.WhiteboardAccessManage, true)
	return err
}

func (r *WhiteboardRepository) CreateShareLink(ctx context.Context, accountID, actorID, boardID uuid.UUID, input WhiteboardShareLinkInput) (*domain.WhiteboardShareLink, error) {
	if input.TokenHash == "" || (input.AccessLevel != domain.WhiteboardAccessView && input.AccessLevel != domain.WhiteboardAccessEdit) {
		return nil, ErrWhiteboardInvalid
	}
	if input.MaxSessions != nil && *input.MaxSessions <= 0 {
		return nil, ErrWhiteboardInvalid
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockWhiteboardActorMembershipsTx(ctx, tx, accountID, actorID); err != nil {
		return nil, err
	}
	if err := requireStandaloneWhiteboardManageMutationTx(ctx, tx, accountID, actorID, boardID, false); err != nil {
		return nil, err
	}
	record, err := scanWhiteboardShareLink(tx.QueryRow(ctx, `INSERT INTO whiteboard_share_links(
		account_id,board_id,token_hash,label,access_level,password_hash,allow_export,
		expires_at,max_sessions,created_by
	) VALUES($1,$2,$3,$4,$5,NULLIF($6,''),$7,$8,$9,$10)
	RETURNING `+whiteboardShareLinkPublicColumns, accountID, boardID, input.TokenHash, input.Label,
		input.AccessLevel, input.PasswordHash, input.AllowExport, input.ExpiresAt, input.MaxSessions, actorID), false)
	if err != nil {
		return nil, normalizeWhiteboardConstraintError(err)
	}
	details, _ := json.Marshal(map[string]any{
		"share_link_id": record.Link.ID, "access_level": record.Link.AccessLevel,
		"allow_export": record.Link.AllowExport, "expires_at": record.Link.ExpiresAt,
	})
	if err := insertWhiteboardActivityTx(ctx, tx, WhiteboardActivityInput{
		AccountID: accountID, BoardID: boardID, ActorID: &actorID,
		Action: WhiteboardActivityShareCreated, Details: details,
	}); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return record.Link, nil
}

func (r *WhiteboardRepository) ListShareLinks(ctx context.Context, accountID, actorID, boardID uuid.UUID, options WhiteboardTimeCursorOptions) ([]*domain.WhiteboardShareLink, bool, error) {
	if _, err := r.RequireAccess(ctx, accountID, actorID, boardID, domain.WhiteboardAccessView); err != nil {
		return nil, false, err
	}
	if err := requireStandaloneWhiteboardWith(ctx, r.db, accountID, boardID); err != nil {
		return nil, false, err
	}
	if _, err := r.RequireManageAccess(ctx, accountID, actorID, boardID); err != nil {
		return nil, false, err
	}
	limit := whiteboardGCLimit(options.Limit)
	rows, err := r.db.Query(ctx, `SELECT `+whiteboardShareLinkPublicColumns+`
		FROM whiteboard_share_links WHERE account_id=$1 AND board_id=$2
		AND ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::uuid))
		ORDER BY created_at DESC,id DESC LIMIT $5`, accountID, boardID, options.BeforeCreatedAt, options.BeforeID, limit+1)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	items := make([]*domain.WhiteboardShareLink, 0, limit)
	for rows.Next() {
		record, scanErr := scanWhiteboardShareLink(rows, false)
		if scanErr != nil {
			return nil, false, scanErr
		}
		items = append(items, record.Link)
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

func (r *WhiteboardRepository) RevokeShareLink(ctx context.Context, accountID, actorID, boardID, linkID uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockWhiteboardActorMembershipsTx(ctx, tx, accountID, actorID); err != nil {
		return err
	}
	if err := requireStandaloneWhiteboardManageMutationTx(ctx, tx, accountID, actorID, boardID, true); err != nil {
		return err
	}
	var alreadyRevoked bool
	if err := tx.QueryRow(ctx, `SELECT revoked_at IS NOT NULL FROM whiteboard_share_links
		WHERE account_id=$1 AND board_id=$2 AND id=$3 FOR UPDATE`, accountID, boardID, linkID).Scan(&alreadyRevoked); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrWhiteboardNotFound
		}
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE whiteboard_share_links SET revoked_at=COALESCE(revoked_at,NOW()),updated_at=NOW()
		WHERE account_id=$1 AND board_id=$2 AND id=$3`, accountID, boardID, linkID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE whiteboard_guest_sessions SET revoked_at=COALESCE(revoked_at,NOW())
		WHERE account_id=$1 AND board_id=$2 AND share_link_id=$3`, accountID, boardID, linkID); err != nil {
		return err
	}
	if !alreadyRevoked {
		if _, err := tx.Exec(ctx, `UPDATE whiteboards SET access_revision=access_revision+1,updated_at=NOW()
			WHERE account_id=$1 AND id=$2`, accountID, boardID); err != nil {
			return err
		}
		details, _ := json.Marshal(map[string]any{"share_link_id": linkID})
		if err := insertWhiteboardActivityTx(ctx, tx, WhiteboardActivityInput{
			AccountID: accountID, BoardID: boardID, ActorID: &actorID,
			Action: WhiteboardActivityShareRevoked, Details: details,
		}); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (r *WhiteboardRepository) GetActiveShareLinkByTokenHash(ctx context.Context, tokenHash string, now time.Time) (*WhiteboardShareLinkRecord, error) {
	record, err := scanWhiteboardShareLink(r.db.QueryRow(ctx, `SELECT `+whiteboardShareLinkSecretColumns+`
		FROM whiteboard_share_links link
		JOIN whiteboards board ON board.account_id=link.account_id AND board.id=link.board_id
		JOIN accounts account ON account.id=link.account_id AND COALESCE(account.is_active,TRUE)
		JOIN subscriptions account_subscription ON account_subscription.account_id=link.account_id
			AND (
				(account_subscription.status='active' AND (account_subscription.current_period_end IS NULL OR account_subscription.current_period_end>=CURRENT_TIMESTAMP)) OR
				(account_subscription.status='trialing' AND (account_subscription.trial_ends_at IS NULL OR account_subscription.trial_ends_at>=CURRENT_TIMESTAMP)) OR
				(account_subscription.status='grace' AND (account_subscription.grace_ends_at IS NULL OR account_subscription.grace_ends_at>=CURRENT_TIMESTAMP))
			)
		WHERE link.token_hash=$1 AND link.revoked_at IS NULL AND board.archived_at IS NULL
		AND `+whiteboardStandaloneBoardOriginSQL+`
		AND (link.expires_at IS NULL OR link.expires_at>$2)`, tokenHash, now), true)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrWhiteboardShareUnavailable
	}
	return record, err
}

type WhiteboardGuestSessionInput struct {
	LinkID                uuid.UUID
	TokenHash             string
	DisplayName           string
	ClientFingerprintHash string
	ExpiresAt             time.Time
	Now                   time.Time
}

func (r *WhiteboardRepository) CreateGuestSession(ctx context.Context, input WhiteboardGuestSessionInput) (*domain.WhiteboardGuestSession, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var accountID, boardID uuid.UUID
	var accessLevel string
	var expiresAt *time.Time
	var maxSessions *int
	var sessionCount int
	if err := tx.QueryRow(ctx, `SELECT link.account_id,link.board_id,link.access_level,link.expires_at,link.max_sessions,link.session_count
		FROM whiteboard_share_links link
		JOIN whiteboards board ON board.account_id=link.account_id AND board.id=link.board_id AND board.archived_at IS NULL
		JOIN accounts account ON account.id=link.account_id AND COALESCE(account.is_active,TRUE)
		JOIN subscriptions account_subscription ON account_subscription.account_id=link.account_id
			AND (
				(account_subscription.status='active' AND (account_subscription.current_period_end IS NULL OR account_subscription.current_period_end>=CURRENT_TIMESTAMP)) OR
				(account_subscription.status='trialing' AND (account_subscription.trial_ends_at IS NULL OR account_subscription.trial_ends_at>=CURRENT_TIMESTAMP)) OR
				(account_subscription.status='grace' AND (account_subscription.grace_ends_at IS NULL OR account_subscription.grace_ends_at>=CURRENT_TIMESTAMP))
			)
		WHERE link.id=$1 AND link.revoked_at IS NULL
		AND `+whiteboardStandaloneShareLinkOriginSQL+`
		AND (link.expires_at IS NULL OR link.expires_at>$2) FOR UPDATE OF link,board`, input.LinkID, input.Now).Scan(
		&accountID, &boardID, &accessLevel, &expiresAt, &maxSessions, &sessionCount); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrWhiteboardShareUnavailable
		}
		return nil, err
	}
	if err := requireActiveWhiteboardTenantWith(ctx, tx, accountID); err != nil {
		return nil, ErrWhiteboardShareUnavailable
	}
	if maxSessions != nil && sessionCount >= *maxSessions {
		return nil, ErrWhiteboardShareUnavailable
	}
	if expiresAt != nil && input.ExpiresAt.After(*expiresAt) {
		input.ExpiresAt = *expiresAt
	}
	session := &domain.WhiteboardGuestSession{}
	if err := tx.QueryRow(ctx, `INSERT INTO whiteboard_guest_sessions(
		account_id,board_id,share_link_id,token_hash,display_name,access_level,
		client_fingerprint_hash,expires_at,last_seen_at
	) VALUES($1,$2,$3,$4,$5,$6,NULLIF($7,''),$8,$9)
	RETURNING id,account_id,board_id,share_link_id,display_name,access_level,expires_at,
		revoked_at,last_seen_at,created_at`, accountID, boardID, input.LinkID, input.TokenHash,
		input.DisplayName, accessLevel, input.ClientFingerprintHash, input.ExpiresAt, input.Now).Scan(
		&session.ID, &session.AccountID, &session.BoardID, &session.ShareLinkID, &session.DisplayName,
		&session.AccessLevel, &session.ExpiresAt, &session.RevokedAt, &session.LastSeenAt, &session.CreatedAt); err != nil {
		return nil, normalizeWhiteboardConstraintError(err)
	}
	if _, err := tx.Exec(ctx, `UPDATE whiteboard_share_links SET session_count=session_count+1,
		last_used_at=$2,updated_at=NOW() WHERE id=$1`, input.LinkID, input.Now); err != nil {
		return nil, err
	}
	details, _ := json.Marshal(map[string]any{
		"share_link_id": session.ShareLinkID, "access_level": session.AccessLevel,
	})
	if err := insertWhiteboardActivityTx(ctx, tx, WhiteboardActivityInput{
		AccountID: session.AccountID, BoardID: session.BoardID, GuestSessionID: &session.ID,
		Action: WhiteboardActivityGuestJoined, Details: details,
	}); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return session, nil
}

func (r *WhiteboardRepository) ResolveGuestSession(ctx context.Context, tokenHash, requiredLevel string, now time.Time) (*domain.WhiteboardGuestContext, error) {
	if requiredLevel != domain.WhiteboardAccessView && requiredLevel != domain.WhiteboardAccessEdit {
		return nil, ErrWhiteboardInvalid
	}
	contextItem := &domain.WhiteboardGuestContext{Session: &domain.WhiteboardGuestSession{}}
	err := r.db.QueryRow(ctx, `SELECT session.id,session.account_id,session.board_id,session.share_link_id,
		session.display_name,session.access_level,session.expires_at,session.revoked_at,
		session.last_seen_at,session.created_at,link.allow_export
		FROM whiteboard_guest_sessions session
		JOIN whiteboard_share_links link ON link.account_id=session.account_id AND link.id=session.share_link_id
		JOIN whiteboards board ON board.account_id=session.account_id AND board.id=session.board_id
		JOIN accounts account ON account.id=session.account_id AND COALESCE(account.is_active,TRUE)
		JOIN subscriptions account_subscription ON account_subscription.account_id=session.account_id
			AND (
				(account_subscription.status='active' AND (account_subscription.current_period_end IS NULL OR account_subscription.current_period_end>=CURRENT_TIMESTAMP)) OR
				(account_subscription.status='trialing' AND (account_subscription.trial_ends_at IS NULL OR account_subscription.trial_ends_at>=CURRENT_TIMESTAMP)) OR
				(account_subscription.status='grace' AND (account_subscription.grace_ends_at IS NULL OR account_subscription.grace_ends_at>=CURRENT_TIMESTAMP))
			)
		WHERE session.token_hash=$1 AND session.revoked_at IS NULL AND session.expires_at>$2
		AND link.revoked_at IS NULL AND (link.expires_at IS NULL OR link.expires_at>$2)
		AND board.archived_at IS NULL
		AND `+whiteboardStandaloneBoardOriginSQL+`
		AND ($3::text='view' OR session.access_level='edit')`, tokenHash, now, requiredLevel).Scan(
		&contextItem.Session.ID, &contextItem.Session.AccountID, &contextItem.Session.BoardID,
		&contextItem.Session.ShareLinkID, &contextItem.Session.DisplayName, &contextItem.Session.AccessLevel,
		&contextItem.Session.ExpiresAt, &contextItem.Session.RevokedAt, &contextItem.Session.LastSeenAt,
		&contextItem.Session.CreatedAt, &contextItem.AllowExport)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrWhiteboardSessionUnavailable
	}
	if err != nil {
		return nil, err
	}
	_, _ = r.db.Exec(ctx, `UPDATE whiteboard_guest_sessions SET last_seen_at=$2
		WHERE id=$1 AND (last_seen_at IS NULL OR last_seen_at<$2-INTERVAL '1 minute')`, contextItem.Session.ID, now)
	return contextItem, nil
}

// ResolveActiveGuestSessionAccessByID is the room-fanout revalidation path.
// The WebSocket hub keeps only the canonical guest-session UUID, never the
// bearer token hash, so an access_revision change can still distinguish an
// active guest from a revoked/expired session before another payload is sent.
func (r *WhiteboardRepository) ResolveActiveGuestSessionAccessByID(
	ctx context.Context,
	accountID, boardID, sessionID uuid.UUID,
	now time.Time,
) (string, error) {
	if accountID == uuid.Nil || boardID == uuid.Nil || sessionID == uuid.Nil {
		return "", ErrWhiteboardInvalid
	}
	var accessLevel string
	err := r.db.QueryRow(ctx, `SELECT session.access_level
		FROM whiteboard_guest_sessions session
		JOIN whiteboard_share_links link ON link.account_id=session.account_id AND link.id=session.share_link_id
		JOIN whiteboards board ON board.account_id=session.account_id AND board.id=session.board_id
		JOIN accounts account ON account.id=session.account_id AND COALESCE(account.is_active,TRUE)
		JOIN subscriptions account_subscription ON account_subscription.account_id=session.account_id
			AND (
				(account_subscription.status='active' AND (account_subscription.current_period_end IS NULL OR account_subscription.current_period_end>=CURRENT_TIMESTAMP)) OR
				(account_subscription.status='trialing' AND (account_subscription.trial_ends_at IS NULL OR account_subscription.trial_ends_at>=CURRENT_TIMESTAMP)) OR
				(account_subscription.status='grace' AND (account_subscription.grace_ends_at IS NULL OR account_subscription.grace_ends_at>=CURRENT_TIMESTAMP))
			)
		WHERE session.account_id=$1 AND session.board_id=$2 AND session.id=$3
		AND session.revoked_at IS NULL AND session.expires_at>$4
		AND link.revoked_at IS NULL AND (link.expires_at IS NULL OR link.expires_at>$4)
		AND board.archived_at IS NULL
		AND `+whiteboardStandaloneBoardOriginSQL,
		accountID, boardID, sessionID, now).Scan(&accessLevel)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrWhiteboardSessionUnavailable
	}
	if err != nil {
		return "", err
	}
	if accessLevel != domain.WhiteboardAccessView && accessLevel != domain.WhiteboardAccessEdit {
		return "", ErrWhiteboardSessionUnavailable
	}
	return accessLevel, nil
}

func (r *WhiteboardRepository) ListGuestSessions(ctx context.Context, accountID, actorID, boardID, linkID uuid.UUID, options WhiteboardTimeCursorOptions) ([]*domain.WhiteboardGuestSession, bool, error) {
	if _, err := r.RequireAccess(ctx, accountID, actorID, boardID, domain.WhiteboardAccessView); err != nil {
		return nil, false, err
	}
	if err := requireStandaloneWhiteboardWith(ctx, r.db, accountID, boardID); err != nil {
		return nil, false, err
	}
	if _, err := r.RequireManageAccess(ctx, accountID, actorID, boardID); err != nil {
		return nil, false, err
	}
	limit := whiteboardGCLimit(options.Limit)
	rows, err := r.db.Query(ctx, `SELECT id,account_id,board_id,share_link_id,display_name,access_level,
		expires_at,revoked_at,last_seen_at,created_at FROM whiteboard_guest_sessions
		WHERE account_id=$1 AND board_id=$2 AND share_link_id=$3
		AND ($4::timestamptz IS NULL OR (created_at,id)<($4::timestamptz,$5::uuid))
		ORDER BY created_at DESC,id DESC LIMIT $6`, accountID, boardID, linkID,
		options.BeforeCreatedAt, options.BeforeID, limit+1)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	items := make([]*domain.WhiteboardGuestSession, 0, limit)
	for rows.Next() {
		item := &domain.WhiteboardGuestSession{}
		if err := rows.Scan(&item.ID, &item.AccountID, &item.BoardID, &item.ShareLinkID,
			&item.DisplayName, &item.AccessLevel, &item.ExpiresAt, &item.RevokedAt,
			&item.LastSeenAt, &item.CreatedAt); err != nil {
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

func (r *WhiteboardRepository) RevokeGuestSession(ctx context.Context, accountID, actorID, boardID, sessionID uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockWhiteboardActorMembershipsTx(ctx, tx, accountID, actorID); err != nil {
		return err
	}
	if err := requireStandaloneWhiteboardManageMutationTx(ctx, tx, accountID, actorID, boardID, true); err != nil {
		return err
	}
	var alreadyRevoked bool
	if err := tx.QueryRow(ctx, `SELECT revoked_at IS NOT NULL FROM whiteboard_guest_sessions
		WHERE account_id=$1 AND board_id=$2 AND id=$3 FOR UPDATE`, accountID, boardID, sessionID).Scan(&alreadyRevoked); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrWhiteboardNotFound
		}
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE whiteboard_guest_sessions SET revoked_at=COALESCE(revoked_at,NOW())
		WHERE account_id=$1 AND board_id=$2 AND id=$3`, accountID, boardID, sessionID); err != nil {
		return err
	}
	if !alreadyRevoked {
		if _, err := tx.Exec(ctx, `UPDATE whiteboards SET access_revision=access_revision+1,updated_at=NOW()
			WHERE account_id=$1 AND id=$2`, accountID, boardID); err != nil {
			return err
		}
		details, _ := json.Marshal(map[string]any{"guest_session_id": sessionID})
		if err := insertWhiteboardActivityTx(ctx, tx, WhiteboardActivityInput{
			AccountID: accountID, BoardID: boardID, ActorID: &actorID,
			Action: WhiteboardActivityGuestRevoked, Details: details,
		}); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
