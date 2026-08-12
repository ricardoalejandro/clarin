package repository

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestWhiteboardMediaReferenceProofCoversHistoricalAndSharedConsumers(t *testing.T) {
	t.Parallel()
	for _, table := range []string{
		"whiteboard_assets",
		"whiteboard_revision_assets",
		"whiteboards",
		"task_attachments",
		"task_attachment_previews",
		"messages",
		"contacts",
		"whatsapp_statuses",
		"survey_file_uploads",
		"survey_branding_asset_refs",
	} {
		if !strings.Contains(whiteboardMediaReferenceProofSQL, "FROM "+table) {
			t.Fatalf("media reference proof omitted %s", table)
		}
	}
	if !strings.Contains(whiteboardMediaReferenceProofSQL, "account_id=$1") {
		t.Fatal("media reference proof is not account-scoped")
	}
}

func TestAbandonedWhiteboardAssetSweepPreservesLiveAndHistoricalReferences(t *testing.T) {
	t.Parallel()
	for _, invariant := range []string{
		"link.committed_at IS NULL",
		"link.draft_expires_at<=NOW()",
		"element->>'fileId'=link.file_id",
		"element->'isDeleted' IS DISTINCT FROM 'true'::jsonb",
		"FOR UPDATE OF board SKIP LOCKED",
	} {
		if !strings.Contains(whiteboardUnreferencedAssetLinksSQL, invariant) {
			t.Fatalf("abandoned-link proof omitted %q", invariant)
		}
	}
	if !strings.Contains(whiteboardMediaReferenceProofSQL, "FROM whiteboard_revision_assets") {
		t.Fatal("historical revision assets would not preserve abandoned upload bytes")
	}
}

func TestAbandonedLibraryAssetSweepLocksOwnerAndChecksLibraryItems(t *testing.T) {
	t.Parallel()
	for _, invariant := range []string{
		"link.library_id IS NOT NULL",
		"link.committed_at IS NULL",
		"link.draft_expires_at<=NOW()",
		"library.library_json",
		"FOR UPDATE OF library SKIP LOCKED",
	} {
		if !strings.Contains(whiteboardUnreferencedLibraryAssetLinksSQL, invariant) {
			t.Fatalf("abandoned library-link proof omitted %q", invariant)
		}
	}
}

func TestWhiteboardGCRetryDelayIsBounded(t *testing.T) {
	t.Parallel()
	if got := whiteboardGCRetryDelay(0); got != time.Minute {
		t.Fatalf("first retry delay=%s", got)
	}
	if got := whiteboardGCRetryDelay(2); got != 4*time.Minute {
		t.Fatalf("third retry delay=%s", got)
	}
	if got := whiteboardGCRetryDelay(100); got != time.Hour {
		t.Fatalf("retry delay was not capped: %s", got)
	}
}

func TestWhiteboardTechnicalHistoryPruneKeepsRecoveryAndMeaningfulAudit(t *testing.T) {
	t.Parallel()
	for _, invariant := range []string{
		"operation.created_at<$1",
		"operation.operation_kind='patch'",
		"operation.operation_kind='snapshot'",
		"NOT EXISTS",
		"FROM whiteboard_revisions revision",
		"revision.account_id=operation.account_id",
		"revision.board_id=operation.board_id",
		"revision.operation_id=operation.operation_id",
		"FOR UPDATE OF operation SKIP LOCKED",
		"operation.account_id=candidates.account_id",
		"operation.board_id=candidates.board_id",
	} {
		if !strings.Contains(whiteboardTechnicalOperationPruneSQL, invariant) {
			t.Fatalf("technical operation prune omitted %q", invariant)
		}
	}
	if strings.Contains(whiteboardTechnicalOperationPruneSQL, "operation.operation_kind='create'") ||
		strings.Contains(whiteboardTechnicalOperationPruneSQL, "operation.operation_kind='restore'") {
		t.Fatal("technical compaction selected a durable create or restore operation")
	}
	for _, invariant := range []string{
		"activity.created_at<$1",
		"'scene.patched'",
		"'scene.snapshotted'",
		"'thumbnail.updated'",
		"FOR UPDATE OF activity SKIP LOCKED",
		"activity.account_id=candidates.account_id",
		"activity.board_id=candidates.board_id",
	} {
		if !strings.Contains(whiteboardTechnicalActivityPruneSQL, invariant) {
			t.Fatalf("technical activity prune omitted %q", invariant)
		}
	}
	if whiteboardTechnicalGCLimit(1000) != 500 || whiteboardTechnicalGCLimit(0) != 100 {
		t.Fatal("technical history batches are not safely bounded")
	}
}

func TestWhiteboardAssetReservationBlocksPhysicalDeletionWindow(t *testing.T) {
	t.Parallel()
	if !whiteboardAssetReservationBlocked("whiteboard_gc_deleting") {
		t.Fatal("asset reservation could resurrect bytes during physical deletion")
	}
	for _, status := range []string{"active", "whiteboard_upload_pending", "whiteboard_gc_pending", "deleted"} {
		if whiteboardAssetReservationBlocked(status) {
			t.Fatalf("safe reservation state was blocked: %s", status)
		}
	}
	for _, status := range []string{"active", "whiteboard_upload_pending", "whiteboard_gc_pending"} {
		if !whiteboardAssetReservationReusesObject(status) {
			t.Fatalf("deduplicated bytes would abandon their existing object: %s", status)
		}
	}
	if whiteboardAssetReservationReusesObject("deleted") || whiteboardAssetReservationReusesObject("whiteboard_gc_deleting") {
		t.Fatal("terminal/deleting object was selected for reuse")
	}
}

func TestWhiteboardSnapshotReservationBlocksPhysicalDeletionWindow(t *testing.T) {
	t.Parallel()
	for _, status := range []string{"whiteboard_snapshot_uploading", "whiteboard_snapshot_deleting"} {
		if !whiteboardSnapshotReservationBlocked(status) {
			t.Fatalf("snapshot reservation accepted unsafe state: %s", status)
		}
	}
	for _, status := range []string{"active", "whiteboard_snapshot_pending", "deleted"} {
		if whiteboardSnapshotReservationBlocked(status) {
			t.Fatalf("snapshot reservation blocked safe state: %s", status)
		}
	}
}

func TestWhiteboardRestoreLocksSourceRevisionAgainstRetention(t *testing.T) {
	t.Parallel()
	if !strings.Contains(whiteboardRestoreRevisionLockSQL, "FOR SHARE") ||
		!strings.Contains(whiteboardRestoreRevisionLockSQL, "account_id=$1") ||
		!strings.Contains(whiteboardRestoreRevisionLockSQL, "board_id=$2") {
		t.Fatalf("restore source lock lost isolation or retention exclusion: %s", whiteboardRestoreRevisionLockSQL)
	}
}

func TestWhiteboardGCErrorIsBounded(t *testing.T) {
	t.Parallel()
	got := whiteboardGCError(errors.New(strings.Repeat("x", whiteboardGCErrorLength+50)))
	if len(got) != whiteboardGCErrorLength {
		t.Fatalf("stored GC error length=%d", len(got))
	}
}
