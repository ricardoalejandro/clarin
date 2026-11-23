package ws

import (
	"sync"
	"time"
)

const sessionRecheckInterval = 5 * time.Second

type sessionGuard struct {
	mu       sync.Mutex
	next     time.Time
	validate func() (time.Time, int)
	close    int
}

func newSessionGuard(deadline time.Time, validate func() (time.Time, int)) *sessionGuard {
	return &sessionGuard{next: nextSessionCheck(time.Now(), deadline), validate: validate}
}

func nextSessionCheck(now, deadline time.Time) time.Time {
	if next := now.Add(sessionRecheckInterval); next.Before(deadline) {
		return next
	}
	return deadline
}

func (g *sessionGuard) delay() time.Duration {
	g.mu.Lock()
	defer g.mu.Unlock()
	return time.Until(g.next)
}

func (g *sessionGuard) check(now time.Time) int {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.close != 0 || now.Before(g.next) {
		return g.close
	}
	deadline, code := g.validate()
	g.close = code
	g.next = nextSessionCheck(now, deadline)
	return code
}
