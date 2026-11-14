package ws

import (
	"testing"
	"time"

	"github.com/gofiber/websocket/v2"
)

func TestSessionGuardChecksDeadlineAndNeverReopensClosedConnection(t *testing.T) {
	now := time.Now()
	initialDeadline := now.Add(2 * time.Second)
	renewedDeadline := now.Add(6 * time.Second)
	calls := 0
	guard := newSessionGuard(initialDeadline, func() (time.Time, int) {
		calls++
		if calls == 1 {
			return renewedDeadline, 0
		}
		return time.Time{}, websocket.ClosePolicyViolation
	})
	if code := guard.check(initialDeadline.Add(-time.Millisecond)); code != 0 || calls != 0 {
		t.Fatalf("guard prematurely checked deadline: code=%d calls=%d", code, calls)
	}
	if code := guard.check(initialDeadline); code != 0 || calls != 1 || !guard.next.Equal(renewedDeadline) {
		t.Fatalf("guard did not adopt renewed deadline: code=%d calls=%d next=%v", code, calls, guard.next)
	}
	if code := guard.check(renewedDeadline); code != websocket.ClosePolicyViolation || calls != 2 {
		t.Fatalf("guard did not close at deadline: code=%d calls=%d", code, calls)
	}
	if code := guard.check(renewedDeadline.Add(time.Minute)); code != websocket.ClosePolicyViolation || calls != 2 {
		t.Fatalf("guard allowed reopening: code=%d calls=%d", code, calls)
	}
}
