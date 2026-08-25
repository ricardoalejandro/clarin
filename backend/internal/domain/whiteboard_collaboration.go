package domain

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

// WhiteboardAccessComment is the cumulative member access level between view
// and edit. Guest links deliberately continue to support only view/edit and do
// not gain access to Clarin-owned comments.
const WhiteboardAccessComment = "comment"

const (
	WhiteboardCommentOpen     = "open"
	WhiteboardCommentResolved = "resolved"
)

// WhiteboardCommentThread is separate from the Excalidraw scene so comments do
// not leak into exports, revisions or duplicated boards.
type WhiteboardCommentThread struct {
	ID                 uuid.UUID            `json:"id"`
	AccountID          uuid.UUID            `json:"-"`
	BoardID            uuid.UUID            `json:"board_id"`
	ElementID          *string              `json:"element_id,omitempty"`
	AnchorX            float64              `json:"anchor_x"`
	AnchorY            float64              `json:"anchor_y"`
	AnchorRatioX       *float64             `json:"anchor_ratio_x,omitempty"`
	AnchorRatioY       *float64             `json:"anchor_ratio_y,omitempty"`
	Status             string               `json:"status"`
	Version            int64                `json:"version"`
	CreatedBy          *uuid.UUID           `json:"created_by,omitempty"`
	CreatedByName      string               `json:"created_by_name,omitempty"`
	ResolvedBy         *uuid.UUID           `json:"resolved_by,omitempty"`
	ResolvedAt         *time.Time           `json:"resolved_at,omitempty"`
	Comments           []*WhiteboardComment `json:"comments"`
	CommentCount       int                  `json:"comment_count"`
	CommentsHasMore    bool                 `json:"comments_has_more"`
	CommentsNextCursor string               `json:"comments_next_cursor,omitempty"`
	CreatedAt          time.Time            `json:"created_at"`
	UpdatedAt          time.Time            `json:"updated_at"`
}

type WhiteboardComment struct {
	ID         uuid.UUID  `json:"id"`
	ThreadID   uuid.UUID  `json:"thread_id"`
	AuthorID   *uuid.UUID `json:"author_id,omitempty"`
	AuthorName string     `json:"author_name,omitempty"`
	Body       string     `json:"body"`
	Version    int64      `json:"version"`
	DeletedAt  *time.Time `json:"deleted_at,omitempty"`
	CreatedAt  time.Time  `json:"created_at"`
	UpdatedAt  time.Time  `json:"updated_at"`
}

// WhiteboardCommentThreadCounts is derived from the complete persisted
// collection. It must never be inferred from a paginated thread response.
type WhiteboardCommentThreadCounts struct {
	Open     int64 `json:"open"`
	Resolved int64 `json:"resolved"`
	All      int64 `json:"all"`
}

// WhiteboardCommentMarker is the bounded canvas projection for an open
// thread. Comment bodies deliberately stay out of the marker collection; the
// authorized thread-detail endpoint loads them only when a user opens a pin.
type WhiteboardCommentMarker struct {
	ID           uuid.UUID `json:"id"`
	BoardID      uuid.UUID `json:"board_id"`
	ElementID    *string   `json:"element_id,omitempty"`
	AnchorX      float64   `json:"anchor_x"`
	AnchorY      float64   `json:"anchor_y"`
	AnchorRatioX *float64  `json:"anchor_ratio_x,omitempty"`
	AnchorRatioY *float64  `json:"anchor_ratio_y,omitempty"`
	Version      int64     `json:"version"`
	CommentCount int       `json:"comment_count"`
	UpdatedAt    time.Time `json:"updated_at"`
}

const (
	WhiteboardLibraryImportPending   = "pending"
	WhiteboardLibraryImportFetching  = "fetching"
	WhiteboardLibraryImportReady     = "ready"
	WhiteboardLibraryImportCompleted = "completed"
	WhiteboardLibraryImportFailed    = "failed"
	WhiteboardLibraryImportExpired   = "expired"
)

// WhiteboardLibraryImport is a short-lived, actor-bound handoff. LibraryJSON
// is already validated by Clarin before it is ever returned to the browser.
type WhiteboardLibraryImport struct {
	ID                      uuid.UUID       `json:"id"`
	AccountID               uuid.UUID       `json:"-"`
	BoardID                 uuid.UUID       `json:"board_id"`
	LibraryID               uuid.UUID       `json:"library_id"`
	ActorID                 uuid.UUID       `json:"-"`
	Status                  string          `json:"status"`
	SourceURL               string          `json:"source_url,omitempty"`
	LibraryJSON             json.RawMessage `json:"library_json,omitempty"`
	CompletedLibraryVersion *int64          `json:"completed_library_version,omitempty"`
	ExpiresAt               time.Time       `json:"expires_at"`
	ConsumedAt              *time.Time      `json:"consumed_at,omitempty"`
	CompletedAt             *time.Time      `json:"completed_at,omitempty"`
	CreatedAt               time.Time       `json:"created_at"`
	UpdatedAt               time.Time       `json:"updated_at"`
}
