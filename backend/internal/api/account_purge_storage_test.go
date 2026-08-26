package api

import (
	"errors"
	"testing"
)

func TestFinalizeAccountPurgeStorageCleanupFailureIsExplicitAndRetryable(t *testing.T) {
	t.Parallel()
	injected := errors.New("injected storage failure")
	result := finalizeAccountPurgeStorageCleanup(true, func() (int64, error) {
		// A prefix implementation may have deleted some objects before failing.
		// The API must not present that partial count as completed cleanup.
		return 7, injected
	})
	if result.DeletedFiles != 0 || result.State != "pending_orphan_cleanup" ||
		result.Code != "storage_cleanup_failed" || !errors.Is(result.Err, injected) {
		t.Fatalf("unexpected failed cleanup contract: %#v", result)
	}
}

func TestFinalizeAccountPurgeStorageCleanupSuccessAndSkip(t *testing.T) {
	t.Parallel()
	called := false
	skipped := finalizeAccountPurgeStorageCleanup(false, func() (int64, error) {
		called = true
		return 1, nil
	})
	if called || skipped.State != "skipped" || skipped.DeletedFiles != 0 {
		t.Fatalf("disabled cleanup executed: called=%t result=%#v", called, skipped)
	}
	unavailable := finalizeAccountPurgeStorageCleanup(true, nil)
	if unavailable.State != "pending_orphan_cleanup" || unavailable.Code != "storage_unavailable" {
		t.Fatalf("unavailable storage is not retryable: %#v", unavailable)
	}
	completed := finalizeAccountPurgeStorageCleanup(true, func() (int64, error) { return 4, nil })
	if completed.State != "completed" || completed.DeletedFiles != 4 || completed.Code != "" || completed.Err != nil {
		t.Fatalf("successful cleanup contract changed: %#v", completed)
	}
}
