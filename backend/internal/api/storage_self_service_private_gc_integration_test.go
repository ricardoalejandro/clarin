package api

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/storage"
)

// Exercise the gap between the committed GC reservation and physical S3
// deletion. A URL-only writer must not bypass the object reservation.
func runStoragePrivateGCIntegrationChecks(t *testing.T, db *pgxpool.Pool, store *storage.Storage) {
	for _, kind := range []string{"task", "whiteboard"} {
		t.Run(kind+" GC reserves its key through ambiguous deletion and retry", func(t *testing.T) {
			ctx := context.Background()
			f := newStorageMultiOriginQAFixture(t, db, store)
			key, assetID, _ := f.media(f.account, "gc-check", "orphan.pdf", false)
			jobID, claim := uuid.New(), uuid.New()
			table := "task_media_gc_jobs"
			gcState := "task_gc_deleting"
			if kind == "whiteboard" {
				table = "whiteboard_media_gc_jobs"
				gcState = "whiteboard_gc_deleting"
			}
			f.exec(`INSERT INTO `+table+`(id,account_id,media_asset_id,object_key,status,claim_token,available_at)
				VALUES($1,$2,$3,$4,'processing',$5,NOW())`, jobID, f.account, assetID, key, claim)
			taskJob := &domain.TaskMediaGCJob{ID: jobID, AccountID: f.account, MediaAssetID: assetID, ObjectKey: key, ClaimToken: claim}
			boardJob := &repository.WhiteboardMediaGCJob{ID: jobID, AccountID: f.account, MediaAssetID: assetID, ObjectKey: key, ClaimToken: claim}
			prepare := func() (bool, error) {
				if kind == "whiteboard" {
					return f.server.repos.Whiteboard.PrepareWhiteboardMediaGCDeletion(ctx, boardJob)
				}
				return f.server.repos.TaskWork.PrepareTaskMediaGCDeletion(ctx, taskJob)
			}
			if prepared, err := prepare(); err != nil || !prepared {
				t.Fatalf("stage GC: prepared=%v error=%v", prepared, err)
			}
			assertWriterRejected := func() {
				t.Helper()
				_, err := db.Exec(ctx, `INSERT INTO saved_stickers(account_id,media_url) VALUES($1,$2)`, f.account, mediaProxyURLFromObjectKey(key))
				var pgErr *pgconn.PgError
				if !errors.As(err, &pgErr) || pgErr.Code != "23514" {
					t.Fatalf("URL writer reached a reserved/deleted object: %v", err)
				}
			}
			assertWriterRejected()
			var hash string
			if err := db.QueryRow(ctx, `SELECT content_hash FROM media_assets WHERE account_id=$1 AND id=$2`, f.account, assetID).Scan(&hash); err != nil {
				t.Fatal(err)
			}
			newKey := f.account.String() + "/gc-check/reuploaded-" + uuid.NewString() + ".pdf"
			input := repository.MediaAssetUpsert{AccountID: f.account, ContentHash: hash, ObjectKey: newKey, MediaType: "document", ContentType: "application/pdf", Filename: "reuploaded.pdf", SizeBytes: 7}
			if _, err := f.server.repos.MediaAsset.Upsert(ctx, input); !errors.Is(err, repository.ErrMediaAssetDeletionInProgress) {
				t.Fatalf("upload replaced a GC-owned row/job: %v", err)
			}
			// Simulate a successful DeleteObject whose response was lost.
			if err := store.DeleteFile(ctx, key); err != nil {
				t.Fatal(err)
			}
			cause := errors.New("synthetic response lost after deletion")
			var retryErr error
			if kind == "whiteboard" {
				retryErr = f.server.repos.Whiteboard.RetryWhiteboardMediaGCJob(ctx, boardJob, cause)
			} else {
				retryErr = f.server.repos.TaskWork.RetryTaskMediaGCJob(ctx, taskJob, cause)
			}
			if retryErr != nil {
				t.Fatal(retryErr)
			}
			var mediaState, objectState, jobState string
			if err := db.QueryRow(ctx, `SELECT asset.status,object.status,job.status FROM media_assets asset
				JOIN storage_objects object ON object.account_id=asset.account_id AND object.object_key=asset.object_key
				JOIN `+table+` job ON job.account_id=asset.account_id AND job.media_asset_id=asset.id
				WHERE asset.account_id=$1 AND asset.id=$2`, f.account, assetID).Scan(&mediaState, &objectState, &jobState); err != nil {
				t.Fatal(err)
			}
			if mediaState != gcState || objectState != gcState || jobState != "pending" {
				t.Fatalf("ambiguous delete made bytes reusable or lost retry: %s %s %s", mediaState, objectState, jobState)
			}
			assertWriterRejected()
			claim = uuid.New()
			taskJob.ClaimToken, boardJob.ClaimToken = claim, claim
			f.exec(`UPDATE `+table+` SET status='processing',claim_token=$3 WHERE account_id=$1 AND id=$2`, f.account, jobID, claim)
			if prepared, err := prepare(); err != nil || !prepared {
				t.Fatalf("retry GC: prepared=%v error=%v", prepared, err)
			}
			if err := store.DeleteFile(ctx, key); err != nil {
				t.Fatal(err)
			}
			var completeErr error
			if kind == "whiteboard" {
				completeErr = f.server.repos.Whiteboard.CompleteWhiteboardMediaGCJob(ctx, boardJob, true)
			} else {
				completeErr = f.server.repos.TaskWork.CompleteTaskMediaGCJob(ctx, taskJob, true)
			}
			if completeErr != nil {
				t.Fatal(completeErr)
			}
			assertWriterRejected()
			if _, err := store.UploadObject(ctx, newKey, []byte("new pdf"), "application/pdf"); err != nil {
				t.Fatal(err)
			}
			newAsset, err := f.server.repos.MediaAsset.Upsert(ctx, input)
			if err != nil || newAsset.ObjectKey != newKey {
				t.Fatalf("completed GC prevented fresh unique-key upload: asset=%v error=%v", newAsset, err)
			}
			assertWriterRejected()
		})
		t.Run(kind+" GC waits for an earlier reference writer", func(t *testing.T) {
			ctx := context.Background()
			f := newStorageMultiOriginQAFixture(t, db, store)
			key, assetID, _ := f.media(f.account, "gc-check", "shared.pdf", false)
			jobID, claim := uuid.New(), uuid.New()
			table := "task_media_gc_jobs"
			if kind == "whiteboard" {
				table = "whiteboard_media_gc_jobs"
			}
			f.exec(`INSERT INTO `+table+`(id,account_id,media_asset_id,object_key,status,claim_token,available_at)
				VALUES($1,$2,$3,$4,'processing',$5,NOW())`, jobID, f.account, assetID, key, claim)
			writer, err := db.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer writer.Rollback(ctx)
			if _, err := writer.Exec(ctx, `INSERT INTO saved_stickers(account_id,media_url) VALUES($1,$2)`, f.account, mediaProxyURLFromObjectKey(key)); err != nil {
				t.Fatal(err)
			}
			result := make(chan error, 1)
			go func() {
				var prepared bool
				var err error
				if kind == "whiteboard" {
					prepared, err = f.server.repos.Whiteboard.PrepareWhiteboardMediaGCDeletion(ctx, &repository.WhiteboardMediaGCJob{ID: jobID, AccountID: f.account, MediaAssetID: assetID, ObjectKey: key, ClaimToken: claim})
				} else {
					prepared, err = f.server.repos.TaskWork.PrepareTaskMediaGCDeletion(ctx, &domain.TaskMediaGCJob{ID: jobID, AccountID: f.account, MediaAssetID: assetID, ObjectKey: key, ClaimToken: claim})
				}
				if prepared && err == nil {
					err = errors.New("GC ignored a committed reference")
				}
				result <- err
			}()
			select {
			case err := <-result:
				t.Fatalf("GC did not wait for the active reference transaction: %v", err)
			case <-time.After(75 * time.Millisecond):
			}
			if err := writer.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-result:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(10 * time.Second):
				t.Fatal("GC remained blocked after reference commit")
			}
			if _, err := store.GetFileInfo(ctx, key); err != nil {
				t.Fatalf("referenced bytes lost: %v", err)
			}
		})
	}
}
