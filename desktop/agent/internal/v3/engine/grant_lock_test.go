package engine

import (
	"testing"
	"time"
)

func TestGrantAuthorityLockSerializesOneGrant(t *testing.T) {
	service := &Engine{}
	release := service.lockGrant("55555555-5555-4555-8555-555555555555")
	started := make(chan struct{})
	acquired := make(chan struct{})
	done := make(chan struct{})
	go func() {
		close(started)
		unlock := service.lockGrant("55555555-5555-4555-8555-555555555555")
		close(acquired)
		unlock()
		close(done)
	}()
	<-started
	select {
	case <-acquired:
		t.Fatal("same-grant authority update crossed an in-flight write")
	case <-time.After(20 * time.Millisecond):
	}
	release()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("same-grant authority lock did not release")
	}
}
