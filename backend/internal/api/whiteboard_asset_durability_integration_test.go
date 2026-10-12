package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"os"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/storage"
	"github.com/naperu/clarin/pkg/config"
)

// Runs inside the parent's disposable, migrated PostgreSQL database. MinIO is
// real and opt-in too; cleanup touches only this generated board's exact prefix.
// HTTP requests use Fiber's in-process server, not a deployed backend or browser.
func runWhiteboardAssetDurabilityIntegration(t *testing.T, db *pgxpool.Pool, accountID, actorID, foreignAccountID, foreignActorID uuid.UUID) {
	t.Helper()
	if os.Getenv("CLARIN_RUN_WHITEBOARD_STORAGE_INTEGRATION") != "1" {
		t.Skip("set CLARIN_RUN_WHITEBOARD_STORAGE_INTEGRATION=1 with disposable MinIO settings")
	}
	for _, key := range []string{"MINIO_ENDPOINT", "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY", "MINIO_BUCKET"} {
		if os.Getenv(key) == "" {
			t.Fatalf("%s is required", key)
		}
	}
	store, err := storage.New(storage.Config{
		Endpoint: os.Getenv("MINIO_ENDPOINT"), AccessKey: os.Getenv("MINIO_ACCESS_KEY"),
		SecretKey: os.Getenv("MINIO_SECRET_KEY"), Bucket: os.Getenv("MINIO_BUCKET"),
		UseSSL: os.Getenv("MINIO_USE_SSL") == "true", PublicURL: os.Getenv("MINIO_PUBLIC_URL"),
	})
	if err != nil {
		t.Fatal("connect isolated MinIO:", err)
	}
	ctx := context.Background()
	boardID := uuid.New()
	prefix := storage.PrivateObjectKey(accountID, "whiteboards", boardID.String()) + "/"
	defer func() {
		if _, err := store.DeletePrefix(ctx, prefix); err != nil {
			t.Error("remove generated test objects:", err)
		}
		if objects, err := store.ListPrefix(ctx, prefix); err != nil || len(objects) != 0 {
			t.Errorf("test object cleanup: remaining=%d err=%v", len(objects), err)
		}
	}()
	if _, err := db.Exec(ctx, `INSERT INTO whiteboards(id,account_id,name,scene_json,scene_schema_version,editor_version,created_by,updated_by)
		VALUES($1,$2,'QA asset durability',$3::jsonb,'excalidraw','0.18.1-clarin.8',$4,$4)`, boardID, accountID, emptyWhiteboardScene, actorID); err != nil {
		t.Fatal(err)
	}
	server := &Server{cfg: &config.Config{Env: "production"}, repos: repository.NewRepositories(db), storage: store}
	defer server.stopWhiteboardCheckpoints()
	app := fiber.New()
	app.Use(func(c *fiber.Ctx) error {
		requestAccount, requestActor := accountID, actorID
		if c.Get("X-Test-Foreign-Account") == "1" {
			requestAccount, requestActor = foreignAccountID, foreignActorID
		}
		c.Locals("account_id", requestAccount)
		c.Locals("user_id", requestActor)
		return c.Next()
	})
	app.Patch("/api/whiteboards/:id/scene", server.handlePatchWhiteboardScene)
	app.Get("/api/whiteboards/:id/scene", server.handleGetWhiteboardScene)
	app.Post("/api/whiteboards/:id/assets", server.handleUploadWhiteboardAsset)
	app.Get("/api/whiteboards/:id/assets/:assetId", server.handleDownloadWhiteboardAsset)
	path := "/api/whiteboards/" + boardID.String()
	const fileID = "durability-image"
	payload := func(sequence int, version int, deleted bool, operationID uuid.UUID) map[string]any {
		element := map[string]any{"id": "image-1", "type": "image", "index": "a0", "version": version, "versionNonce": version * 101,
			"x": 10, "y": 20, "width": 40, "height": 40, "fileId": fileID, "status": "saved", "isDeleted": deleted, "scale": []int{1, 1}}
		return map[string]any{"expected_sequence": sequence, "operation_id": operationID,
			"scene":                map[string]any{"type": "excalidraw", "version": 2, "source": "clarin", "elements": []map[string]any{element}, "appState": map[string]any{"viewBackgroundColor": "#ffffff"}, "files": map[string]any{}},
			"patch":                map[string]any{"base_sequence": sequence, "elements": []map[string]any{element}, "app_state": map[string]any{"viewBackgroundColor": "#ffffff"}},
			"scene_schema_version": "excalidraw", "editor_version": "0.18.1-clarin.8"}
	}
	assertDatabase := func(sequence, operations, committedLinks int) {
		t.Helper()
		var gotSequence, gotOperations, gotLinks int
		if err := db.QueryRow(ctx, `SELECT scene_sequence,
			(SELECT COUNT(*) FROM whiteboard_operations WHERE account_id=$1 AND board_id=$2),
			(SELECT COUNT(*) FROM whiteboard_assets WHERE account_id=$1 AND board_id=$2 AND committed_at IS NOT NULL)
			FROM whiteboards WHERE account_id=$1 AND id=$2`, accountID, boardID).Scan(&gotSequence, &gotOperations, &gotLinks); err != nil {
			t.Fatal(err)
		}
		if gotSequence != sequence || gotOperations != operations || gotLinks != committedLinks {
			t.Fatalf("database sequence/operations/committed links=%d/%d/%d want=%d/%d/%d", gotSequence, gotOperations, gotLinks, sequence, operations, committedLinks)
		}
	}
	assertMissing := func(body map[string]any) {
		t.Helper()
		response := performWhiteboardSceneRequest(t, app, http.MethodPatch, path+"/scene", body)
		var rejected struct {
			Code    string   `json:"code"`
			Missing []string `json:"missing_file_ids"`
		}
		if response.StatusCode != http.StatusUnprocessableEntity || json.Unmarshal([]byte(response.Body), &rejected) != nil ||
			rejected.Code != "whiteboard_assets_missing" || len(rejected.Missing) != 1 || rejected.Missing[0] != fileID {
			t.Fatalf("missing binary rejection: status=%d body=%s", response.StatusCode, response.Body)
		}
	}
	assertWrite := func(body map[string]any, sequence int64, idempotent bool) {
		t.Helper()
		response := performWhiteboardSceneRequest(t, app, http.MethodPatch, path+"/scene", body)
		if response.StatusCode != http.StatusOK || response.Result == nil || response.Result.Scene == nil ||
			response.Result.Scene.Sequence != sequence || response.Result.Idempotent != idempotent {
			t.Fatalf("scene write/retry: status=%d body=%s", response.StatusCode, response.Body)
		}
	}
	first := payload(0, 1, false, uuid.New())
	assertMissing(first)
	assertDatabase(0, 0, 0)

	// Unique pixels prevent this fixture from reusing another test's object.
	pixels := image.NewRGBA(image.Rect(0, 0, 2, 2))
	pixels.Set(0, 0, color.RGBA{R: boardID[0], G: boardID[1], B: boardID[2], A: 255})
	pixels.Set(1, 1, color.RGBA{R: boardID[3], G: boardID[4], B: boardID[5], A: 255})
	var pngBytes bytes.Buffer
	if err := png.Encode(&pngBytes, pixels); err != nil {
		t.Fatal(err)
	}
	upload := func() *domain.WhiteboardAsset {
		t.Helper()
		var body bytes.Buffer
		writer := multipart.NewWriter(&body)
		if err := writer.WriteField("file_id", fileID); err != nil {
			t.Fatal(err)
		}
		if err := writer.WriteField("kind", "asset"); err != nil {
			t.Fatal(err)
		}
		header := make(textproto.MIMEHeader)
		header.Set("Content-Disposition", `form-data; name="file"; filename="qa-durability.png"`)
		header.Set("Content-Type", "image/png")
		part, err := writer.CreatePart(header)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write(pngBytes.Bytes()); err != nil {
			t.Fatal(err)
		}
		if err := writer.Close(); err != nil {
			t.Fatal(err)
		}
		request := httptest.NewRequest(http.MethodPost, path+"/assets", &body)
		request.Header.Set("Content-Type", writer.FormDataContentType())
		response, err := app.Test(request, -1)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		raw, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		var result struct {
			Asset *domain.WhiteboardAsset `json:"asset"`
		}
		if response.StatusCode != http.StatusCreated || json.Unmarshal(raw, &result) != nil || result.Asset == nil || result.Asset.FileID != fileID {
			t.Fatalf("upload: status=%d body=%s", response.StatusCode, raw)
		}
		return result.Asset
	}
	asset := upload()
	assertWrite(first, 1, false)
	assertWrite(first, 1, true) // Same immutable attempt after a hypothetically lost ACK.
	assertDatabase(1, 1, 1)
	deleted := payload(1, 2, true, uuid.New())
	assertWrite(deleted, 2, false)
	assertDatabase(2, 2, 0)
	var pendingGC int
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM whiteboard_media_gc_jobs WHERE account_id=$1 AND media_asset_id=$2 AND status='pending'`, accountID, asset.MediaAssetID).Scan(&pendingGC); err != nil || pendingGC != 1 {
		t.Fatalf("unlinked image must retain a durable GC candidate: count=%d err=%v", pendingGC, err)
	}
	undo := payload(2, 3, false, uuid.New())
	assertMissing(undo)
	assertDatabase(2, 2, 0)
	relinked := upload()
	if relinked.MediaAssetID != asset.MediaAssetID {
		t.Fatal("undo duplicated the media inventory")
	}
	assertWrite(undo, 3, false)
	assertWrite(undo, 3, true)
	assertDatabase(3, 3, 1)
	loaded := performWhiteboardSceneRequest(t, app, http.MethodGet, path+"/scene", nil)
	if loaded.StatusCode != http.StatusOK || loaded.Scene == nil || loaded.Scene.Sequence != 3 {
		t.Fatalf("reopen: %s", loaded.Body)
	}
	var document struct {
		Elements []struct {
			FileID  string `json:"fileId"`
			Deleted bool   `json:"isDeleted"`
		} `json:"elements"`
	}
	if err := json.Unmarshal(loaded.Scene.Scene, &document); err != nil || len(document.Elements) != 1 || document.Elements[0].FileID != fileID || document.Elements[0].Deleted {
		t.Fatalf("reopened scene lost the restored image: %v", err)
	}
	for _, foreign := range []bool{false, true} {
		request := httptest.NewRequest(http.MethodGet, fmt.Sprintf("%s/assets/%s", path, relinked.ID), nil)
		if foreign {
			request.Header.Set("X-Test-Foreign-Account", "1")
		}
		response, err := app.Test(request, -1)
		if err != nil {
			t.Fatal(err)
		}
		raw, readErr := io.ReadAll(response.Body)
		response.Body.Close()
		if readErr != nil {
			t.Fatal(readErr)
		}
		if foreign {
			if response.StatusCode != http.StatusNotFound {
				t.Fatalf("cross-account download status=%d", response.StatusCode)
			}
		} else if response.StatusCode != http.StatusOK || !bytes.Equal(raw, pngBytes.Bytes()) {
			t.Fatal("restored image bytes could not be downloaded through the authorized HTTP handler")
		}
	}
	var inventories, active int
	if err := db.QueryRow(ctx, `SELECT COUNT(*),COUNT(*) FILTER(WHERE status='active') FROM storage_objects WHERE account_id=$1 AND object_key LIKE $2`, accountID, prefix+"%").Scan(&inventories, &active); err != nil || inventories != 1 || active != 1 {
		t.Fatalf("storage inventory was duplicated or left pending: total=%d active=%d err=%v", inventories, active, err)
	}
	if objects, err := store.ListPrefix(ctx, prefix); err != nil || len(objects) != 1 {
		t.Fatalf("physical objects count=%d err=%v", len(objects), err)
	}
	t.Log("real PostgreSQL + MinIO: 422 rollback, upload, idempotent save, delete, undo/relink, reopen, authorized bytes and account isolation passed")
}
