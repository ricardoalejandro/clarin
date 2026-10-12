package whiteboard

import (
	"sync"
	"time"
)

const EventRateWindow = time.Second

type EventRateDecision struct {
	Allowed    bool
	RetryAfter time.Duration
}

type rateWindow struct {
	started time.Time
	count   int
}

// EventRateLimiter bounds a single socket independently. Infrastructure-wide
// abuse controls remain separate; this protects a room and PostgreSQL from a
// valid editor or guest session flooding high-frequency messages.
type EventRateLimiter struct {
	mu      sync.Mutex
	windows map[string]rateWindow
}

func NewEventRateLimiter() *EventRateLimiter {
	return &EventRateLimiter{windows: make(map[string]rateWindow)}
}

func (l *EventRateLimiter) Allow(event string, now time.Time) bool {
	return l.Check(event, now).Allowed
}

// Check includes the actual remaining deadline without extending rejected windows.
func (l *EventRateLimiter) Check(event string, now time.Time) EventRateDecision {
	limit := eventLimit(event)
	if limit == 0 {
		return EventRateDecision{}
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	window := l.windows[event]
	if window.started.IsZero() || now.Sub(window.started) >= EventRateWindow || now.Before(window.started) {
		window = rateWindow{started: now}
	}
	if window.count >= limit {
		l.windows[event] = window
		return EventRateDecision{RetryAfter: EventRateWindow - now.Sub(window.started)}
	}
	window.count++
	l.windows[event] = window
	return EventRateDecision{Allowed: true}
}

func eventLimit(event string) int {
	switch event {
	case EventScenePatch:
		return 10
	case EventSyncRequest:
		return 4
	case EventCursorUpdate:
		return 60
	case EventPresenceUpdate:
		return 12
	case EventPresentationStart, EventPresentationStop:
		return 3
	case EventFollowChange:
		return 12
	case EventViewportUpdate:
		return 24
	default:
		return 0
	}
}

// Invalid frames retain their protocol-strike budget. Temporary rate rejections
// use the existing one-second window rather than accumulating for hours.
type RealtimeViolationCounter struct {
	invalid int
	rate    rateWindow
}

func (c *RealtimeViolationCounter) RejectInvalid() bool {
	c.invalid++
	return c.invalid >= 5
}

func (c *RealtimeViolationCounter) RejectRate(now time.Time) bool {
	if c.rate.started.IsZero() || now.Sub(c.rate.started) >= EventRateWindow || now.Before(c.rate.started) {
		c.rate = rateWindow{started: now}
	}
	c.rate.count++
	return c.rate.count >= 5
}
