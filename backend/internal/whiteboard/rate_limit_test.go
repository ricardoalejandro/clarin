package whiteboard

import (
	"testing"
	"time"
)

func TestEventRateLimiterUsesIndependentOneSecondWindows(t *testing.T) {
	limiter := NewEventRateLimiter()
	now := time.Date(2026, 8, 9, 0, 0, 0, 0, time.UTC)
	for index := 0; index < 10; index++ {
		if !limiter.Allow(EventScenePatch, now) {
			t.Fatalf("patch %d unexpectedly rejected", index)
		}
	}
	if limiter.Allow(EventScenePatch, now) {
		t.Fatal("patch flood was not rejected")
	}
	if !limiter.Allow(EventCursorUpdate, now) {
		t.Fatal("one event kind must not consume another kind's window")
	}
	for index := 0; index < 24; index++ {
		if !limiter.Allow(EventViewportUpdate, now) {
			t.Fatalf("viewport update %d unexpectedly rejected", index)
		}
	}
	if limiter.Allow(EventViewportUpdate, now) {
		t.Fatal("viewport flood was not rejected independently")
	}
	if !limiter.Allow(EventScenePatch, now.Add(time.Second)) {
		t.Fatal("new one-second window did not reset")
	}
	if limiter.Allow("unsupported", now) {
		t.Fatal("unsupported events must not be admitted")
	}
}

func TestEventRateLimiterReportsRemainingWindowWithoutExtendingIt(t *testing.T) {
	limiter := NewEventRateLimiter()
	now := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	for i := 0; i < 4; i++ {
		limiter.Allow(EventSyncRequest, now)
	}
	if got := limiter.Check(EventSyncRequest, now.Add(250*time.Millisecond)); got.Allowed || got.RetryAfter != 750*time.Millisecond {
		t.Fatalf("incorrect cooldown: %#v", got)
	}
	if got := limiter.Check(EventSyncRequest, now.Add(999*time.Millisecond)); got.RetryAfter != time.Millisecond {
		t.Fatalf("rejection extended the window: %#v", got)
	}
	if !limiter.Check(EventSyncRequest, now.Add(time.Second)).Allowed {
		t.Fatal("window did not recover")
	}
	if !limiter.Check(EventSyncRequest, now.Add(-time.Second)).Allowed {
		t.Fatal("clock rollback did not reset window")
	}
}

func TestRealtimeViolationCounterSeparatesTemporaryAndInvalidTraffic(t *testing.T) {
	now := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	var counter RealtimeViolationCounter
	for i := 0; i < 20; i++ {
		if counter.RejectRate(now.Add(time.Duration(i) * time.Second)) {
			t.Fatal("isolated throttling accumulated across windows")
		}
	}
	for i := 0; i < 4; i++ {
		if counter.RejectInvalid() {
			t.Fatal("invalid frames closed too early")
		}
	}
	if !counter.RejectInvalid() {
		t.Fatal("malformed-frame protection was weakened")
	}
	var burst RealtimeViolationCounter
	for i := 0; i < 4; i++ {
		if burst.RejectRate(now) {
			t.Fatal("rate burst closed too early")
		}
	}
	if !burst.RejectRate(now.Add(999 * time.Millisecond)) {
		t.Fatal("sustained rate burst was not bounded")
	}
}
