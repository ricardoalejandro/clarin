package api

import "errors"

type accountPurgeStorageCleanupResult struct {
	DeletedFiles int64
	State        string
	Code         string
	Err          error
}

// finalizeAccountPurgeStorageCleanup runs only after the account transaction
// commits. On failure it reports an explicit retryable orphan-cleanup state
// and never claims a partially reported object count as successfully deleted.
func finalizeAccountPurgeStorageCleanup(deleteFiles bool, deletePrefix func() (int64, error)) accountPurgeStorageCleanupResult {
	if !deleteFiles {
		return accountPurgeStorageCleanupResult{State: "skipped"}
	}
	if deletePrefix == nil {
		return accountPurgeStorageCleanupResult{
			State: "pending_orphan_cleanup", Code: "storage_unavailable",
		}
	}
	deleted, err := deletePrefix()
	if err != nil {
		return accountPurgeStorageCleanupResult{
			State: "pending_orphan_cleanup", Code: "storage_cleanup_failed", Err: err,
		}
	}
	if deleted < 0 {
		return accountPurgeStorageCleanupResult{
			State: "pending_orphan_cleanup", Code: "storage_cleanup_failed",
			Err: errors.New("storage cleanup returned a negative object count"),
		}
	}
	return accountPurgeStorageCleanupResult{DeletedFiles: deleted, State: "completed"}
}
