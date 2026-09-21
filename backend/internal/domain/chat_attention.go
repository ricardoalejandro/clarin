package domain

import (
	"context"
	"time"

	"github.com/google/uuid"
)

// MessageSender is an immutable attribution, never a name supplied by the composer.
type MessageSender struct {
	UserID *uuid.UUID `json:"user_id,omitempty"`
	Name   string     `json:"name,omitempty"`
	Origin string     `json:"origin"`
}

type MessageSendContext struct {
	AccountID      uuid.UUID
	ChatID         uuid.UUID
	Sender         MessageSender
	ThroughAt      *time.Time
	ThroughID      *uuid.UUID
	DeferAttention bool
	OperationID    *uuid.UUID
}

const MessageSendContextKey = "clarin.message-send-context"

func WithMessageSendContext(ctx context.Context, value MessageSendContext) context.Context {
	return context.WithValue(ctx, MessageSendContextKey, value)
}

func MessageSendContextFrom(ctx context.Context) (MessageSendContext, bool) {
	value, ok := ctx.Value(MessageSendContextKey).(MessageSendContext)
	return value, ok
}

type ChatState struct {
	ChatID       uuid.UUID  `json:"chat_id"`
	UnreadCount  int        `json:"unread_count"`
	WaitingSince *time.Time `json:"waiting_since"`
	NeedsReply   bool       `json:"needs_reply"`
	Version      int64      `json:"state_version"`
}

type QuickReplyItem struct {
	ID           uuid.UUID  `json:"id"`
	Type         string     `json:"type"`
	Text         string     `json:"text,omitempty"`
	AttachmentID *uuid.UUID `json:"attachment_id,omitempty"`
}
