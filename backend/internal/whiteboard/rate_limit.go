package whiteboard

import (
	"sync"
	"time"
)

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
	limit := eventLimit(event)
	if limit == 0 {
		return false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	window := l.windows[event]
	if window.started.IsZero() || now.Sub(window.started) >= time.Second || now.Before(window.started) {
		window = rateWindow{started: now}
	}
	if window.count >= limit {
		l.windows[event] = window
		return false
	}
	window.count++
	l.windows[event] = window
	return true
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
