package api

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/storage"
)

func TestWhiteboardTechnicalHistoryRetentionIsThirtyDaysAndBounded(t *testing.T) {
	t.Parallel()
	if whiteboardTechnicalHistoryRetention != 30*24*time.Hour {
		t.Fatalf("technical history retention=%s", whiteboardTechnicalHistoryRetention)
	}
	if whiteboardTechnicalHistoryBatch <= 0 || whiteboardTechnicalHistoryBatch > 500 {
		t.Fatalf("unsafe technical history batch=%d", whiteboardTechnicalHistoryBatch)
	}
	if whiteboardLibraryImportExpiryBatch <= 0 || whiteboardLibraryImportExpiryBatch > 500 {
		t.Fatalf("unsafe public library import expiry batch=%d", whiteboardLibraryImportExpiryBatch)
	}
}

func TestWhiteboardGCObjectKeyRequiresExactAccountPrivateNamespace(t *testing.T) {
	t.Parallel()
	accountID := uuid.New()
	boardID := uuid.New()
	valid := storage.PrivateObjectKey(accountID, "whiteboards", boardID.String(), "assets", "one.png")
	if !validWhiteboardGCObjectKey(accountID, valid) {
		t.Fatalf("valid key rejected: %q", valid)
	}
	for _, candidate := range []string{
		"/" + valid,
		uuid.NewString() + "/_private/whiteboards/" + boardID.String() + "/assets/one.png",
		accountID.String() + "/_private/whiteboards/../avatars/one.png",
		accountID.String() + "/whiteboards/" + boardID.String() + "/assets/one.png",
	} {
		if validWhiteboardGCObjectKey(accountID, candidate) {
			t.Fatalf("unsafe key accepted: %q", candidate)
		}
	}
}

func TestWhiteboardRetentionDatabaseSweepDoesNotDependOnStorage(t *testing.T) {
	t.Parallel()
	databaseRuns, storageRuns := 0, 0
	runWhiteboardRetentionPhases(false, func() { databaseRuns++ }, func() { storageRuns++ })
	if databaseRuns != 1 || storageRuns != 0 {
		t.Fatalf("storage-less retention phases database=%d storage=%d", databaseRuns, storageRuns)
	}
	runWhiteboardRetentionPhases(true, func() { databaseRuns++ }, func() { storageRuns++ })
	if databaseRuns != 2 || storageRuns != 1 {
		t.Fatalf("storage-backed retention phases database=%d storage=%d", databaseRuns, storageRuns)
	}
}
