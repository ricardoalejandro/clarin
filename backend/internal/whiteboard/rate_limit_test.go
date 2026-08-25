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
