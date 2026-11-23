package domain

import (
	"time"

	"github.com/google/uuid"
)

// ChatPin is private to one actor in one account. Its version is independent
// from shared read/attention state so concurrent messages cannot undo a pin.
type ChatPin struct {
	ChatID     uuid.UUID  `json:"chat_id"`
	IsPinned   bool       `json:"is_pinned"`
	PinnedAt   *time.Time `json:"pinned_at"`
	PinVersion int64      `json:"pin_version"`
}

type ChatListCursor struct {
	Pinned bool       `json:"p"`
	SortAt *time.Time `json:"at"`
	ID     uuid.UUID  `json:"id"`
	Scope  string     `json:"scope"`
}
