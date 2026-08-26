package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
	"github.com/naperu/clarin/internal/storage"
	whiteboardcore "github.com/naperu/clarin/internal/whiteboard"
	"github.com/naperu/clarin/pkg/cache"
	"github.com/naperu/clarin/pkg/config"
	"github.com/naperu/clarin/pkg/database"
)

// TestWhiteboardSceneRouterPersistsAndReloadsRepresentativeElements exercises
// the real Fiber handlers and PostgreSQL repositories. It is opt-in because it
// creates and drops an isolated database; no production/user board is touched.
func TestWhiteboardSceneRouterPersistsAndReloadsRepresentativeElements(t *testing.T) {
	if os.Getenv("CLARIN_RUN_WHITEBOARD_API_INTEGRATION") != "1" {
		t.Skip("set CLARIN_RUN_WHITEBOARD_API_INTEGRATION=1 in an isolated PostgreSQL environment")
	}
	rawURL := os.Getenv("DATABASE_URL")
	if rawURL == "" {
		t.Fatal("DATABASE_URL is required")
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	const databaseName = "clarin_whiteboard_api_test"
	adminURL, testURL := *parsed, *parsed
	adminURL.Path = "/postgres"
	testURL.Path = "/" + databaseName
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, adminURL.String())
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	_, _ = admin.Exec(ctx, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, databaseName)
	_, _ = admin.Exec(ctx, `DROP DATABASE IF EXISTS `+databaseName)
	if _, err := admin.Exec(ctx, `CREATE DATABASE `+databaseName); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_, _ = admin.Exec(ctx, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, databaseName)
		_, _ = admin.Exec(ctx, `DROP DATABASE IF EXISTS `+databaseName)
	}()
	db, err := pgxpool.New(ctx, testURL.String())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := database.Migrate(db); err != nil {
		t.Fatalf("migrate isolated database: %v", err)
	}

	accountID, actorID, boardID, operationID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	personalLibraryID := uuid.New()
	commenterID, viewerID := uuid.New(), uuid.New()
	foreignAccountID, foreignActorID := uuid.New(), uuid.New()
	whiteboardRoleID := uuid.New()
	// Fixture insertion deliberately bypasses unrelated account bootstrap
	// triggers. The test exercises the real whiteboard schema/repositories and
	// keeps task/default-environment seed behavior outside this focused path.
	if _, err := db.Exec(ctx, `SET session_replication_role='replica'`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO accounts(id,name) VALUES
		($1,'Whiteboard API test'),($2,'Whiteboard API foreign test')`, accountID, foreignAccountID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO subscriptions(account_id,plan_code,status,current_period_start,current_period_end)
		VALUES($1,'enterprise','active',NOW(),NOW()+INTERVAL '1 year'),
			($2,'enterprise','active',NOW(),NOW()+INTERVAL '1 year')`, accountID, foreignAccountID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO roles(id,name,permissions)
		VALUES($1,$2,ARRAY[$3]::text[])`, whiteboardRoleID, "Whiteboard API integration "+whiteboardRoleID.String(), domain.PermWhiteboards); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO users(id,account_id,username,email,password_hash,display_name,is_admin)
		VALUES
		($1,$5,$6,$7,'test','Whiteboard API actor',TRUE),
		($2,$5,$8,$9,'test','Whiteboard API commenter',FALSE),
		($3,$5,$10,$11,'test','Whiteboard API viewer',FALSE),
		($4,$12,$13,$14,'test','Whiteboard API foreign actor',FALSE)`,
		actorID, commenterID, viewerID, foreignActorID, accountID,
		"wb-api-"+actorID.String(), actorID.String()+"@test.invalid",
		"wb-api-"+commenterID.String(), commenterID.String()+"@test.invalid",
		"wb-api-"+viewerID.String(), viewerID.String()+"@test.invalid",
		foreignAccountID, "wb-api-"+foreignActorID.String(), foreignActorID.String()+"@test.invalid"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO user_accounts(user_id,account_id,role,role_id,is_default) VALUES
		($1,$5,'admin',NULL,TRUE),($2,$5,'agent',$7,FALSE),($3,$5,'agent',$7,FALSE),($4,$6,'agent',$7,TRUE)`,
		actorID, commenterID, viewerID, foreignActorID, accountID, foreignAccountID, whiteboardRoleID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO whiteboards(
		id,account_id,name,scene_json,scene_schema_version,editor_version,created_by,updated_by
	) VALUES($1,$2,'Persistencia Fiber',$3::jsonb,'excalidraw','0.18.1',$4,$4)`,
		boardID, accountID, emptyWhiteboardScene, actorID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO whiteboard_grants(
		account_id,board_id,user_id,access_level,can_manage_access,created_by
	) VALUES
		($1,$2,$3,'manage',TRUE,$3),
		($1,$2,$4,'comment',FALSE,$3),
		($1,$2,$5,'view',FALSE,$3)`, accountID, boardID, actorID, commenterID, viewerID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO whiteboard_libraries(
		id,account_id,name,library_json,visibility,created_by,updated_by
	) VALUES($1,$2,$3,'{"type":"excalidrawlib","version":2,"libraryItems":[]}'::jsonb,'private',$4,$4)`,
		personalLibraryID, accountID, "Personal integration "+personalLibraryID.String(), actorID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `SET session_replication_role='origin'`); err != nil {
		t.Fatal(err)
	}

	elements := []map[string]any{
		{"id": "rect-1", "type": "rectangle", "index": "a0", "version": 1, "versionNonce": 101, "x": 40, "y": 40, "width": 180, "height": 100},
		{"id": "diamond-1", "type": "diamond", "index": "a1", "version": 1, "versionNonce": 102, "x": 280, "y": 40, "width": 180, "height": 120, "boundElements": []map[string]any{{"id": "diamond-text-1", "type": "text"}}},
		{"id": "diamond-text-1", "type": "text", "index": "a2", "version": 1, "versionNonce": 103, "x": 320, "y": 85, "width": 100, "height": 25, "text": "Decisión", "originalText": "Decisión", "containerId": "diamond-1"},
		{"id": "ellipse-1", "type": "ellipse", "index": "a3", "version": 1, "versionNonce": 104, "x": 520, "y": 40, "width": 120, "height": 120},
		{"id": "text-1", "type": "text", "index": "a4", "version": 1, "versionNonce": 105, "x": 40, "y": 220, "width": 180, "height": 25, "text": "Texto independiente", "originalText": "Texto independiente", "containerId": nil},
	}
	scene := map[string]any{
		"type": "excalidraw", "version": 2, "source": "clarin", "elements": elements,
		"appState": map[string]any{"viewBackgroundColor": "#ffffff", "gridModeEnabled": false}, "files": map[string]any{},
	}
	requestBody := map[string]any{
		"expected_sequence": 0, "operation_id": operationID, "scene": scene,
		"patch":                map[string]any{"base_sequence": 0, "elements": elements, "app_state": scene["appState"]},
		"scene_schema_version": "excalidraw", "editor_version": "0.18.1-clarin.5",
	}

	repos := repository.NewRepositories(db)
	server := &Server{
		cfg:   &config.Config{PublicURL: "https://clarin.example", Env: "production"},
		repos: repos, abuseLimiter: newInMemoryAbuseLimiter(),
		whiteboardCheckpoints: make(map[string]*whiteboardCheckpointEntry),
	}
	defer server.stopWhiteboardCheckpoints()
	app := fiber.New()
	app.Use(func(c *fiber.Ctx) error {
		requestAccountID := accountID
		requestActorID := actorID
		if value := c.Get("X-Test-Account-ID"); value != "" {
			parsed, parseErr := uuid.Parse(value)
			if parseErr != nil {
				return parseErr
			}
			requestAccountID = parsed
		}
		if value := c.Get("X-Test-Actor-ID"); value != "" {
			parsed, parseErr := uuid.Parse(value)
			if parseErr != nil {
				return parseErr
			}
			requestActorID = parsed
		}
		c.Locals("account_id", requestAccountID)
		c.Locals("user_id", requestActorID)
		return c.Next()
	})
	app.Patch("/api/whiteboards/:id/scene", server.handlePatchWhiteboardScene)
	app.Get("/api/whiteboards/:id/scene", server.handleGetWhiteboardScene)
	app.Get("/api/whiteboards/:id/comment-markers", server.handleListWhiteboardCommentMarkers)
	app.Get("/api/whiteboards/:id/comment-threads", server.handleListWhiteboardCommentThreads)
	app.Get("/api/whiteboards/:id/comment-threads/:threadId", server.handleGetWhiteboardCommentThread)
	app.Post("/api/whiteboards/:id/comment-threads", server.handleCreateWhiteboardCommentThread)
	app.Post("/api/whiteboards/:id/comment-threads/:threadId/replies", server.handleReplyWhiteboardCommentThread)
	app.Patch("/api/whiteboards/:id/comment-threads/:threadId/comments/:commentId", server.handleEditWhiteboardComment)
	app.Delete("/api/whiteboards/:id/comment-threads/:threadId/comments/:commentId", server.handleDeleteWhiteboardComment)
	app.Patch("/api/whiteboards/:id/comment-threads/:threadId/status", server.handleUpdateWhiteboardCommentThreadStatus)
	app.Post("/api/whiteboards/:id/public-library-import/start", server.guardWhiteboardLibraryImportMutation, server.guardWhiteboardPublicLibraryStart, server.handleStartWhiteboardPublicLibraryImport)
	app.Get("/api/whiteboards/:id/public-library-imports/:importId/navigate", server.guardWhiteboardPublicLibraryNavigation, server.handleNavigateWhiteboardPublicLibraryImport)

	startPath := "https://clarin.example/api/whiteboards/" + boardID.String() + "/public-library-import/start?library_id=" + personalLibraryID.String()
	startRequest := httptest.NewRequest(http.MethodPost, startPath, strings.NewReader(`{}`))
	startRequest.Header.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSON)
	startRequest.Header.Set(fiber.HeaderOrigin, "https://clarin.example")
	startRequest.Header.Set(whiteboardLibraryStartHeader, "1")
	startResponse, err := app.Test(startRequest, -1)
	if err != nil {
		t.Fatal(err)
	}
	startBody, err := io.ReadAll(startResponse.Body)
	startResponse.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	var startResult struct {
		Success        bool   `json:"success"`
		NavigationPath string `json:"navigation_path"`
	}
	if startResponse.StatusCode != http.StatusOK || json.Unmarshal(startBody, &startResult) != nil || !startResult.Success {
		t.Fatalf("public library start failed: status=%d body=%s", startResponse.StatusCode, startBody)
	}
	parsedNavigation, err := url.Parse(startResult.NavigationPath)
	if err != nil || parsedNavigation.IsAbs() || parsedNavigation.RawQuery != "" || parsedNavigation.Fragment != "" {
		t.Fatalf("public library start returned unsafe navigation: %q err=%v", startResult.NavigationPath, err)
	}
	var handoffCookie *http.Cookie
	for _, cookie := range startResponse.Cookies() {
		if cookie.Name == whiteboardLibraryHandoffCookieName {
			handoffCookie = cookie
			break
		}
	}
	if handoffCookie == nil || handoffCookie.Value == "" || handoffCookie.Path != startResult.NavigationPath ||
		handoffCookie.Domain != "" || !handoffCookie.HttpOnly || !handoffCookie.Secure ||
		handoffCookie.SameSite != http.SameSiteStrictMode || handoffCookie.MaxAge <= 0 || handoffCookie.MaxAge > 120 {
		t.Fatalf("public library start did not issue the bounded host-only handoff cookie")
	}
	if bytes.Contains(startBody, []byte(handoffCookie.Value)) {
		t.Fatal("public library start exposed its HttpOnly handoff secret in JSON")
	}
	var importExpiresAt time.Time
	var storedNavigationHash string
	if err := db.QueryRow(ctx, `SELECT expires_at,token_hash FROM whiteboard_library_import_sessions
		WHERE account_id=$1 AND actor_id=$2 AND board_id=$3`, accountID, actorID, boardID).Scan(&importExpiresAt, &storedNavigationHash); err != nil {
		t.Fatal(err)
	}
	if handoffCookie.Expires.After(importExpiresAt) || storedNavigationHash != service.HashWhiteboardLibraryNavigationSecret(handoffCookie.Value) {
		t.Fatal("public library handoff cookie exceeded import expiry or used an unbound token hash")
	}
	if _, _, err := repos.Whiteboard.ClaimWhiteboardLibraryImport(ctx, accountID, actorID,
		service.HashWhiteboardLibraryCallbackSecret(handoffCookie.Value), time.Now().UTC()); !errors.Is(err, repository.ErrWhiteboardNotFound) {
		t.Fatalf("pre-navigation cookie secret was accepted as a callback: %v", err)
	}

	type navigationResponse struct {
		Status   int
		Location string
		Cookies  []*http.Cookie
	}
	performNavigation := func(actor uuid.UUID, cookieValue string, metadata bool) navigationResponse {
		t.Helper()
		request := httptest.NewRequest(http.MethodGet, "https://clarin.example"+startResult.NavigationPath, nil)
		request.Header.Set("X-Test-Actor-ID", actor.String())
		request.AddCookie(&http.Cookie{Name: whiteboardLibraryHandoffCookieName, Value: cookieValue, Path: startResult.NavigationPath})
		if metadata {
			request.Header.Set("Sec-Fetch-Site", "same-origin")
			request.Header.Set("Sec-Fetch-Mode", "navigate")
			request.Header.Set("Sec-Fetch-Dest", "document")
		}
		response, requestErr := app.Test(request, -1)
		if requestErr != nil {
			t.Fatal(requestErr)
		}
		defer response.Body.Close()
		return navigationResponse{Status: response.StatusCode, Location: response.Header.Get(fiber.HeaderLocation), Cookies: response.Cookies()}
	}
	if response := performNavigation(actorID, strings.Repeat("z", 43), false); response.Status != http.StatusNotFound {
		t.Fatalf("public library navigation accepted wrong cookie: status=%d", response.Status)
	}
	if response := performNavigation(commenterID, handoffCookie.Value, false); response.Status != http.StatusNotFound {
		t.Fatalf("public library navigation crossed actor ownership: status=%d", response.Status)
	}
	navigated := performNavigation(actorID, handoffCookie.Value, false)
	redirect, parseErr := url.Parse(navigated.Location)
	callbackToken := ""
	if parseErr == nil {
		callbackToken = redirect.Query().Get("token")
	}
	if navigated.Status != http.StatusFound || parseErr != nil || redirect.Scheme != "https" || redirect.Host != "libraries.excalidraw.com" ||
		callbackToken == "" || callbackToken == handoffCookie.Value || redirect.Query().Has("handoff") {
		t.Fatalf("public library cookie navigation failed without Fetch Metadata: status=%d err=%v", navigated.Status, parseErr)
	}
	cleared := false
	cookieDiagnostics := make([]string, 0, len(navigated.Cookies))
	for _, cookie := range navigated.Cookies {
		cookieDiagnostics = append(cookieDiagnostics, fmt.Sprintf(
			"name=%q path=%q max_age=%d expires=%s secure=%t http_only=%t same_site=%d value_empty=%t",
			cookie.Name, cookie.Path, cookie.MaxAge, cookie.Expires.UTC().Format(time.RFC3339), cookie.Secure,
			cookie.HttpOnly, cookie.SameSite, cookie.Value == "",
		))
		if cookie.Name == whiteboardLibraryHandoffCookieName && cookie.Path == startResult.NavigationPath &&
			cookie.Value == "" && cookie.MaxAge <= 0 && cookie.Expires.Before(time.Now()) &&
			cookie.HttpOnly && cookie.Secure && cookie.SameSite == http.SameSiteStrictMode {
			cleared = true
		}
	}
	if !cleared {
		t.Fatalf("public library navigation did not clear its path-bound cookie: %v", cookieDiagnostics)
	}
	if replay := performNavigation(actorID, handoffCookie.Value, true); replay.Status != http.StatusNotFound {
		t.Fatalf("public library navigation cookie replay status=%d, want 404", replay.Status)
	}
	var importStatus string
	var consumedAt *time.Time
	if err := db.QueryRow(ctx, `SELECT status,consumed_at FROM whiteboard_library_import_sessions
		WHERE account_id=$1 AND actor_id=$2 AND board_id=$3 AND token_hash=$4`,
		accountID, actorID, boardID, service.HashWhiteboardLibraryCallbackSecret(callbackToken)).Scan(&importStatus, &consumedAt); err != nil {
		t.Fatal(err)
	}
	if importStatus != domain.WhiteboardLibraryImportPending || consumedAt != nil {
		t.Fatalf("navigation token rotation mutated import lifecycle: status=%s consumed_at=%v", importStatus, consumedAt)
	}

	first := performWhiteboardSceneRequest(t, app, http.MethodPatch, "/api/whiteboards/"+boardID.String()+"/scene", requestBody)
	if first.StatusCode != http.StatusOK {
		t.Fatalf("first PATCH status=%d body=%s", first.StatusCode, first.Body)
	}
	if first.Result.Scene == nil || first.Result.Scene.Sequence != 1 || first.Result.Idempotent {
		t.Fatalf("first PATCH did not confirm canonical sequence 1: %#v", first.Result)
	}

	replay := performWhiteboardSceneRequest(t, app, http.MethodPatch, "/api/whiteboards/"+boardID.String()+"/scene", requestBody)
	if replay.StatusCode != http.StatusOK || replay.Result.Scene == nil || replay.Result.Scene.Sequence != 1 || !replay.Result.Idempotent {
		t.Fatalf("same operation_id was not idempotent: status=%d result=%#v", replay.StatusCode, replay.Result)
	}

	rebasedOperationID := uuid.New()
	rebasedElements := append(append([]map[string]any{}, elements...), map[string]any{
		"id": "arrow-1", "type": "arrow", "index": "a5", "version": 1, "versionNonce": 106,
		"x": 220, "y": 90, "width": 60, "height": 10, "points": [][]float64{{0, 0}, {60, 10}},
		"startBinding": map[string]any{"elementId": "rect-1", "focus": 0, "gap": 1},
		"endBinding":   map[string]any{"elementId": "diamond-1", "focus": 0, "gap": 1},
	})
	rebasedScene := map[string]any{
		"type": "excalidraw", "version": 2, "source": "clarin", "elements": rebasedElements,
		"appState": scene["appState"], "files": map[string]any{},
	}
	rebasedRequest := map[string]any{
		"expected_sequence": 0, "operation_id": rebasedOperationID, "scene": rebasedScene,
		"patch": map[string]any{
			"base_sequence": 0,
			"elements":      []map[string]any{rebasedElements[len(rebasedElements)-1]},
			"app_state":     scene["appState"],
		},
		"scene_schema_version": "excalidraw", "editor_version": "0.18.1-clarin.5",
	}
	rebased := performWhiteboardSceneRequest(t, app, http.MethodPatch, "/api/whiteboards/"+boardID.String()+"/scene", rebasedRequest)
	if rebased.StatusCode != http.StatusOK || rebased.Result == nil || rebased.Result.Scene == nil || rebased.Result.Scene.Sequence != 2 || !rebased.Rebased {
		t.Fatalf("stale PATCH was not canonically rebased: status=%d rebased=%v result=%#v body=%s", rebased.StatusCode, rebased.Rebased, rebased.Result, rebased.Body)
	}
	rebasedReplay := performWhiteboardSceneRequest(t, app, http.MethodPatch, "/api/whiteboards/"+boardID.String()+"/scene", rebasedRequest)
	if rebasedReplay.StatusCode != http.StatusOK || rebasedReplay.Result == nil || !rebasedReplay.Result.Idempotent || !rebasedReplay.Rebased {
		t.Fatalf("rebased operation was not idempotent: status=%d rebased=%v result=%#v", rebasedReplay.StatusCode, rebasedReplay.Rebased, rebasedReplay.Result)
	}
	futureRequest := map[string]any{
		"expected_sequence": 99, "operation_id": uuid.New(), "scene": rebasedScene,
		"patch":                map[string]any{"base_sequence": 99, "elements": []map[string]any{}, "app_state": scene["appState"]},
		"scene_schema_version": "excalidraw", "editor_version": "0.18.1-clarin.5",
	}
	future := performWhiteboardSceneRequest(t, app, http.MethodPatch, "/api/whiteboards/"+boardID.String()+"/scene", futureRequest)
	if future.StatusCode != http.StatusConflict {
		t.Fatalf("future base did not remain a strict conflict: status=%d body=%s", future.StatusCode, future.Body)
	}

	assetHash := strings.Repeat("a", 64)
	assetKey, err := whiteboardcore.AssetObjectKey(accountID, boardID, "thumbnail", whiteboardcore.NormalizedAsset{
		ContentType: "image/png", Extension: ".png", Hash: assetHash, Size: 68,
	})
	if err != nil {
		t.Fatal(err)
	}
	mediaAsset, uploadRequired, err := repos.Whiteboard.ReserveWhiteboardAsset(ctx, repository.MediaAssetUpsert{
		AccountID: accountID, ContentHash: domain.MediaAssetHashWhiteboardPrefix + assetHash,
		ObjectKey: assetKey, MediaType: "image", ContentType: "image/png", Filename: "thumbnail.png", SizeBytes: 68,
	})
	if err != nil || !uploadRequired {
		t.Fatalf("reserve thumbnail asset: asset=%#v required=%v err=%v", mediaAsset, uploadRequired, err)
	}
	thumbnail, err := repos.Whiteboard.AttachBoardAsset(ctx, accountID, actorID, boardID, mediaAsset.ID, "thumbnail", "thumbnail", nil)
	if err != nil || thumbnail == nil || thumbnail.CommittedAt == nil {
		t.Fatalf("attach real PostgreSQL thumbnail: thumbnail=%#v err=%v", thumbnail, err)
	}

	checkpointOperationID := uuid.New()
	rebasedSceneJSON, err := json.Marshal(rebasedScene)
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := service.PrepareWhiteboardSnapshot(accountID, boardID, checkpointOperationID, rebasedSceneJSON)
	if err != nil {
		t.Fatal(err)
	}
	reserved, err := repos.Whiteboard.ReserveRevisionSnapshot(ctx, accountID, prepared.ObjectKey, prepared.ContentHash, prepared.SizeBytes)
	if err != nil || !reserved {
		t.Fatalf("reserve automatic checkpoint: reserved=%v err=%v", reserved, err)
	}
	checkpoint, err := repos.Whiteboard.UpdateScene(ctx, accountID, actorID, boardID, repository.WhiteboardSceneWriteInput{
		ExpectedSequence: 2, OperationID: checkpointOperationID, Scene: rebasedSceneJSON,
		SceneSchemaVersion: "excalidraw", EditorVersion: "0.18.1-clarin.5", WriteKind: "snapshot", RevisionKind: "automatic",
		RequestPayloadHash: prepared.SceneHash, ResultSceneHash: prepared.SceneHash,
		SnapshotObjectKey: prepared.ObjectKey, SnapshotContentHash: prepared.ContentHash, SnapshotSizeBytes: prepared.SizeBytes,
	})
	if err != nil || checkpoint == nil || checkpoint.Scene == nil || checkpoint.Scene.Sequence != 3 || checkpoint.Revision == nil {
		t.Fatalf("persist automatic checkpoint: checkpoint=%#v err=%v", checkpoint, err)
	}

	loaded := performWhiteboardSceneRequest(t, app, http.MethodGet, "/api/whiteboards/"+boardID.String()+"/scene", nil)
	if loaded.StatusCode != http.StatusOK || loaded.Scene == nil || loaded.Scene.Sequence != 3 {
		t.Fatalf("GET did not reload canonical sequence: status=%d scene=%#v", loaded.StatusCode, loaded.Scene)
	}
	var document struct {
		Elements []map[string]any `json:"elements"`
	}
	if err := json.Unmarshal(loaded.Scene.Scene, &document); err != nil {
		t.Fatal(err)
	}
	if len(document.Elements) != len(rebasedElements) {
		t.Fatalf("reloaded scene lost elements: got=%d want=%d", len(document.Elements), len(rebasedElements))
	}
	byID := make(map[string]map[string]any, len(document.Elements))
	for _, element := range document.Elements {
		byID[element["id"].(string)] = element
	}
	if byID["diamond-text-1"]["containerId"] != "diamond-1" || byID["text-1"]["containerId"] != nil {
		t.Fatalf("bound/standalone text relationship was not preserved: %#v", byID)
	}
	var sequence, operationCount int64
	if err := db.QueryRow(ctx, `SELECT scene_sequence FROM whiteboards WHERE account_id=$1 AND id=$2`, accountID, boardID).Scan(&sequence); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM whiteboard_operations WHERE account_id=$1 AND board_id=$2`, accountID, boardID).Scan(&operationCount); err != nil {
		t.Fatal(err)
	}
	var thumbnailCount, automaticRevisionCount, activeSnapshotCount int64
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM whiteboard_assets WHERE account_id=$1 AND board_id=$2 AND kind='thumbnail'`, accountID, boardID).Scan(&thumbnailCount); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM whiteboard_revisions WHERE account_id=$1 AND board_id=$2 AND revision_kind='automatic' AND operation_id=$3`, accountID, boardID, checkpointOperationID).Scan(&automaticRevisionCount); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM storage_objects WHERE account_id=$1 AND object_key=$2 AND status='active'`, accountID, prepared.ObjectKey).Scan(&activeSnapshotCount); err != nil {
		t.Fatal(err)
	}
	if sequence != 3 || operationCount != 3 || thumbnailCount != 1 || automaticRevisionCount != 1 || activeSnapshotCount != 1 {
		t.Fatalf("database durability mismatch: sequence=%d operations=%d", sequence, operationCount)
	}

	openThread, err := repos.Whiteboard.CreateWhiteboardCommentThread(ctx, accountID, actorID, boardID,
		repository.WhiteboardCommentThreadCreateInput{OperationID: uuid.New(), AnchorX: 15, AnchorY: 20, Body: "Visible en marcador"})
	if err != nil {
		t.Fatalf("create API comment fixture: %v", err)
	}
	resolvedThread, err := repos.Whiteboard.CreateWhiteboardCommentThread(ctx, accountID, actorID, boardID,
		repository.WhiteboardCommentThreadCreateInput{OperationID: uuid.New(), AnchorX: 25, AnchorY: 30, Body: "Resuelto"})
	if err != nil {
		t.Fatalf("create resolved API comment fixture: %v", err)
	}
	resolvedThread, err = repos.Whiteboard.UpdateWhiteboardCommentThreadStatus(ctx, accountID, actorID, boardID, resolvedThread.ID,
		repository.WhiteboardCommentStatusInput{OperationID: uuid.New(), ExpectedVersion: resolvedThread.Version, Status: domain.WhiteboardCommentResolved})
	if err != nil {
		t.Fatalf("resolve API comment fixture: %v", err)
	}
	commentListResponse, err := app.Test(httptest.NewRequest(http.MethodGet,
		"/api/whiteboards/"+boardID.String()+"/comment-threads?status=resolved&limit=10", nil), -1)
	if err != nil {
		t.Fatal(err)
	}
	defer commentListResponse.Body.Close()
	var commentListPayload struct {
		Threads []*domain.WhiteboardCommentThread    `json:"threads"`
		Counts  domain.WhiteboardCommentThreadCounts `json:"counts"`
	}
	if err := json.NewDecoder(commentListResponse.Body).Decode(&commentListPayload); err != nil {
		t.Fatal(err)
	}
	if commentListResponse.StatusCode != http.StatusOK || len(commentListPayload.Threads) != 1 ||
		commentListPayload.Threads[0].ID != resolvedThread.ID || commentListPayload.Threads[0].Status != domain.WhiteboardCommentResolved ||
		commentListPayload.Counts.Open != 1 || commentListPayload.Counts.Resolved != 1 || commentListPayload.Counts.All != 2 {
		t.Fatalf("comment list API lost filter/counts: status=%d payload=%#v", commentListResponse.StatusCode, commentListPayload)
	}
	markerResponse, err := app.Test(httptest.NewRequest(http.MethodGet,
		"/api/whiteboards/"+boardID.String()+"/comment-markers?limit=1", nil), -1)
	if err != nil {
		t.Fatal(err)
	}
	defer markerResponse.Body.Close()
	markerBody, err := io.ReadAll(markerResponse.Body)
	if err != nil {
		t.Fatal(err)
	}
	var markerPayload struct {
		Markers []*domain.WhiteboardCommentMarker `json:"markers"`
	}
	if err := json.Unmarshal(markerBody, &markerPayload); err != nil {
		t.Fatal(err)
	}
	if markerResponse.StatusCode != http.StatusOK || len(markerPayload.Markers) != 1 || markerPayload.Markers[0].ID != openThread.ID ||
		bytes.Contains(markerBody, []byte(`"body"`)) || bytes.Contains(markerBody, []byte(`"comments"`)) {
		t.Fatalf("open marker API leaked content or wrong status: status=%d body=%s", markerResponse.StatusCode, markerBody)
	}
	detailResponse, err := app.Test(httptest.NewRequest(http.MethodGet,
		"/api/whiteboards/"+boardID.String()+"/comment-threads/"+openThread.ID.String(), nil), -1)
	if err != nil {
		t.Fatal(err)
	}
	defer detailResponse.Body.Close()
	var detailPayload struct {
		Thread *domain.WhiteboardCommentThread `json:"thread"`
	}
	if err := json.NewDecoder(detailResponse.Body).Decode(&detailPayload); err != nil {
		t.Fatal(err)
	}
	if detailResponse.StatusCode != http.StatusOK || detailPayload.Thread == nil || detailPayload.Thread.ID != openThread.ID ||
		len(detailPayload.Thread.Comments) != 1 || detailPayload.Thread.Comments[0].Body != "Visible en marcador" {
		t.Fatalf("comment detail API failed: status=%d payload=%#v", detailResponse.StatusCode, detailPayload)
	}

	performCommentRequest := func(method, path string, requestAccountID, requestActorID uuid.UUID, payload any) (int, []byte) {
		t.Helper()
		var body io.Reader
		if payload != nil {
			encoded, encodeErr := json.Marshal(payload)
			if encodeErr != nil {
				t.Fatal(encodeErr)
			}
			body = bytes.NewReader(encoded)
		}
		request := httptest.NewRequest(method, path, body)
		request.Header.Set("X-Test-Account-ID", requestAccountID.String())
		request.Header.Set("X-Test-Actor-ID", requestActorID.String())
		if payload != nil {
			request.Header.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSON)
		}
		response, requestErr := app.Test(request, -1)
		if requestErr != nil {
			t.Fatal(requestErr)
		}
		defer response.Body.Close()
		responseBody, readErr := io.ReadAll(response.Body)
		if readErr != nil {
			t.Fatal(readErr)
		}
		return response.StatusCode, responseBody
	}
	decodeCommentThread := func(body []byte) *domain.WhiteboardCommentThread {
		t.Helper()
		var payload struct {
			Thread *domain.WhiteboardCommentThread `json:"thread"`
		}
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Fatalf("decode comment response: %v body=%s", err, body)
		}
		return payload.Thread
	}

	commentBasePath := "/api/whiteboards/" + boardID.String() + "/comment-threads"
	createOperationID := uuid.New()
	status, responseBody := performCommentRequest(http.MethodPost, commentBasePath, accountID, commenterID, map[string]any{
		"operation_id": createOperationID,
		"anchor_x":     70,
		"anchor_y":     80,
		"body":         "CRUD Fiber",
	})
	createdThread := decodeCommentThread(responseBody)
	if status != http.StatusCreated || createdThread == nil || len(createdThread.Comments) != 1 || createdThread.Comments[0].Body != "CRUD Fiber" {
		t.Fatalf("comment create API failed: status=%d body=%s", status, responseBody)
	}
	status, responseBody = performCommentRequest(http.MethodPost, commentBasePath, accountID, commenterID, map[string]any{
		"operation_id": createOperationID,
		"anchor_x":     70,
		"anchor_y":     80,
		"body":         "CRUD Fiber",
	})
	replayedCreatedThread := decodeCommentThread(responseBody)
	if status != http.StatusCreated || replayedCreatedThread == nil || replayedCreatedThread.ID != createdThread.ID || len(replayedCreatedThread.Comments) != 1 {
		t.Fatalf("comment create API was not idempotent: status=%d body=%s", status, responseBody)
	}
	status, responseBody = performCommentRequest(http.MethodPost, commentBasePath, accountID, viewerID, map[string]any{
		"operation_id": uuid.New(),
		"anchor_x":     1,
		"anchor_y":     1,
		"body":         "No autorizado",
	})
	if status != http.StatusForbidden {
		t.Fatalf("view-only comment create did not return 403: status=%d body=%s", status, responseBody)
	}

	threadPath := commentBasePath + "/" + createdThread.ID.String()
	status, responseBody = performCommentRequest(http.MethodPost, threadPath+"/replies", accountID, commenterID, map[string]any{
		"operation_id": uuid.New(),
		"body":         "Respuesta Fiber",
	})
	repliedAPThread := decodeCommentThread(responseBody)
	if status != http.StatusOK || repliedAPThread == nil || len(repliedAPThread.Comments) != 2 {
		t.Fatalf("comment reply API failed: status=%d body=%s", status, responseBody)
	}

	ownedAPIComment := repliedAPThread.Comments[0]
	commentPath := threadPath + "/comments/" + ownedAPIComment.ID.String()
	status, responseBody = performCommentRequest(http.MethodPatch, commentPath, accountID, actorID, map[string]any{
		"operation_id":     uuid.New(),
		"expected_version": ownedAPIComment.Version,
		"body":             "Edición ajena",
	})
	if status != http.StatusForbidden {
		t.Fatalf("non-owner comment edit did not return 403: status=%d body=%s", status, responseBody)
	}
	status, responseBody = performCommentRequest(http.MethodPatch, commentPath, accountID, commenterID, map[string]any{
		"operation_id":     uuid.New(),
		"expected_version": ownedAPIComment.Version + 1,
		"body":             "Versión obsoleta",
	})
	if status != http.StatusConflict {
		t.Fatalf("stale comment edit did not return 409: status=%d body=%s", status, responseBody)
	}
	status, responseBody = performCommentRequest(http.MethodPatch, commentPath, accountID, commenterID, map[string]any{
		"operation_id":     uuid.New(),
		"expected_version": ownedAPIComment.Version,
		"body":             "Edición Fiber canónica",
	})
	editedAPIThread := decodeCommentThread(responseBody)
	if status != http.StatusOK || editedAPIThread == nil || editedAPIThread.Comments[0].Body != "Edición Fiber canónica" || editedAPIThread.Comments[0].Version != ownedAPIComment.Version+1 {
		t.Fatalf("owned comment edit API failed: status=%d body=%s", status, responseBody)
	}

	status, responseBody = performCommentRequest(http.MethodDelete, commentPath, accountID, commenterID, map[string]any{
		"operation_id":     uuid.New(),
		"expected_version": ownedAPIComment.Version,
	})
	if status != http.StatusConflict {
		t.Fatalf("stale comment delete did not return 409: status=%d body=%s", status, responseBody)
	}
	status, responseBody = performCommentRequest(http.MethodDelete, commentPath, accountID, commenterID, map[string]any{
		"operation_id":     uuid.New(),
		"expected_version": editedAPIThread.Comments[0].Version,
	})
	deletedAPIThread := decodeCommentThread(responseBody)
	if status != http.StatusOK || deletedAPIThread == nil || deletedAPIThread.Comments[0].DeletedAt == nil || deletedAPIThread.Comments[0].Body != "" {
		t.Fatalf("owned comment delete API failed: status=%d body=%s", status, responseBody)
	}

	status, responseBody = performCommentRequest(http.MethodGet, commentBasePath+"/"+uuid.NewString(), accountID, commenterID, nil)
	if status != http.StatusNotFound {
		t.Fatalf("missing comment detail did not return 404: status=%d body=%s", status, responseBody)
	}
	status, responseBody = performCommentRequest(http.MethodGet, threadPath, foreignAccountID, foreignActorID, nil)
	if status != http.StatusNotFound {
		t.Fatalf("cross-account comment detail did not return 404: status=%d body=%s", status, responseBody)
	}
}

// TestWhiteboardDeployedRuntimePersistsControlledScene verifies the running
// backend with a short-lived authenticated session. The exact QA board and
// session are removed on exit, while assertions inspect PostgreSQL before that
// cleanup. It must only be enabled intentionally after a deployment.
func TestWhiteboardDeployedRuntimePersistsControlledScene(t *testing.T) {
	if os.Getenv("CLARIN_RUN_WHITEBOARD_RUNTIME_SMOKE") != "1" {
		t.Skip("set CLARIN_RUN_WHITEBOARD_RUNTIME_SMOKE=1 after an intentional deployment")
	}
	rawDatabaseURL := os.Getenv("DATABASE_URL")
	redisURL := os.Getenv("REDIS_URL")
	jwtSecret := os.Getenv("JWT_SECRET")
	baseURL := strings.TrimRight(os.Getenv("CLARIN_RUNTIME_BASE_URL"), "/")
	minioEndpoint := os.Getenv("MINIO_ENDPOINT")
	minioAccessKey := os.Getenv("MINIO_ACCESS_KEY")
	minioSecretKey := os.Getenv("MINIO_SECRET_KEY")
	minioBucket := os.Getenv("MINIO_BUCKET")
	if rawDatabaseURL == "" || redisURL == "" || jwtSecret == "" || baseURL == "" || minioEndpoint == "" || minioAccessKey == "" || minioSecretKey == "" || minioBucket == "" {
		t.Fatal("DATABASE_URL, REDIS_URL, JWT_SECRET, CLARIN_RUNTIME_BASE_URL and MinIO settings are required")
	}
	ctx := context.Background()
	db, err := pgxpool.New(ctx, rawDatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	redisCache, err := cache.New(redisURL)
	if err != nil {
		t.Fatal(err)
	}
	objectStore, err := storage.New(storage.Config{
		Endpoint: minioEndpoint, AccessKey: minioAccessKey, SecretKey: minioSecretKey,
		Bucket: minioBucket, UseSSL: false, PublicURL: "http://" + minioEndpoint,
	})
	if err != nil {
		t.Fatalf("connect runtime smoke storage: %v", err)
	}

	var actorID, accountID uuid.UUID
	var username, role string
	var isSuperAdmin bool
	if err := db.QueryRow(ctx, `SELECT account_user.id,membership.account_id,account_user.username,
		COALESCE(account_user.is_super_admin,FALSE),membership.role
		FROM user_accounts membership
		JOIN users account_user ON account_user.id=membership.user_id AND account_user.is_active
		JOIN accounts account ON account.id=membership.account_id AND account.is_active
		WHERE account_user.is_super_admin OR membership.role IN ('admin','super_admin')
		ORDER BY account_user.is_super_admin DESC,(membership.role IN ('admin','super_admin')) DESC,membership.created_at
		LIMIT 1`).Scan(&actorID, &accountID, &username, &isSuperAdmin, &role); err != nil {
		t.Fatalf("select smoke-test administrator: %v", err)
	}
	now := time.Now().UTC()
	sessionID := "whiteboard-smoke-" + uuid.NewString()
	sessionKey := "session:" + sessionID
	sessionJSON, _ := json.Marshal(map[string]any{
		"user_id": actorID.String(), "account_id": accountID.String(), "username": username,
		"created_at": now.Unix(), "last_seen": now.Unix(),
	})
	if err := redisCache.Set(ctx, sessionKey, sessionJSON, 5*time.Minute); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = redisCache.Del(ctx, sessionKey) }()
	claims := service.JWTClaims{
		UserID: actorID, AccountID: accountID, SessionID: sessionID, Username: username,
		IsAdmin:      domain.HasAccountAdminAuthority(role, isSuperAdmin),
		IsSuperAdmin: isSuperAdmin, Role: role, Permissions: []string{domain.PermAll},
		RegisteredClaims: jwt.RegisteredClaims{
			ID: uuid.NewString(), Issuer: "clarin", IssuedAt: jwt.NewNumericDate(now), ExpiresAt: jwt.NewNumericDate(now.Add(5 * time.Minute)),
		},
	}
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(jwtSecret))
	if err != nil {
		t.Fatal(err)
	}

	createOperationID := uuid.New()
	created := performWhiteboardRuntimeRequest(t, http.MethodPost, baseURL+"/api/whiteboards", token, map[string]any{
		"name": "QA temporal · guardado desplegado", "operation_id": createOperationID,
		"scene": json.RawMessage(emptyWhiteboardScene), "scene_schema_version": "excalidraw", "editor_version": "0.18.1-clarin.5",
	})
	if created.StatusCode != http.StatusCreated {
		t.Fatalf("runtime create status=%d body=%s", created.StatusCode, created.Body)
	}
	var createResponse struct {
		Whiteboard struct {
			ID uuid.UUID `json:"id"`
		} `json:"whiteboard"`
	}
	if err := json.Unmarshal([]byte(created.Body), &createResponse); err != nil || createResponse.Whiteboard.ID == uuid.Nil {
		t.Fatalf("decode runtime board: %v body=%s", err, created.Body)
	}
	boardID := createResponse.Whiteboard.ID
	objectPrefix := storage.PrivateObjectKey(accountID, "whiteboards", boardID.String()) + "/"
	defer func() {
		if _, cleanupErr := objectStore.DeletePrefix(ctx, objectPrefix); cleanupErr != nil {
			t.Errorf("cleanup runtime smoke objects: %v", cleanupErr)
		}
		if remaining, cleanupErr := objectStore.ListPrefix(ctx, objectPrefix); cleanupErr != nil || len(remaining) != 0 {
			t.Errorf("verify runtime smoke object cleanup: remaining=%d err=%v", len(remaining), cleanupErr)
		}
		if _, cleanupErr := db.Exec(ctx, `DELETE FROM whiteboards WHERE account_id=$1 AND id=$2`, accountID, boardID); cleanupErr != nil {
			t.Errorf("cleanup runtime smoke board: %v", cleanupErr)
		}
		if _, cleanupErr := db.Exec(ctx, `DELETE FROM media_assets
			WHERE account_id=$1 AND object_key LIKE $2 AND NOT EXISTS (
				SELECT 1 FROM whiteboard_assets link WHERE link.account_id=media_assets.account_id AND link.media_asset_id=media_assets.id
			)`, accountID, objectPrefix+"%"); cleanupErr != nil {
			t.Errorf("cleanup runtime smoke media inventory: %v", cleanupErr)
		}
		if _, cleanupErr := db.Exec(ctx, `DELETE FROM storage_objects
			WHERE account_id=$1 AND object_key LIKE $2 AND NOT EXISTS (
				SELECT 1 FROM whiteboard_revisions revision
				WHERE revision.account_id=storage_objects.account_id AND revision.snapshot_object_key=storage_objects.object_key
			)`, accountID, objectPrefix+"%"); cleanupErr != nil {
			t.Errorf("cleanup runtime smoke storage inventory: %v", cleanupErr)
		}
		var remainingRows int64
		if cleanupErr := db.QueryRow(ctx, `SELECT
			(SELECT COUNT(*) FROM whiteboards WHERE account_id=$1 AND id=$2)+
			(SELECT COUNT(*) FROM media_assets WHERE account_id=$1 AND object_key LIKE $3)+
			(SELECT COUNT(*) FROM storage_objects WHERE account_id=$1 AND object_key LIKE $3)`,
			accountID, boardID, objectPrefix+"%").Scan(&remainingRows); cleanupErr != nil || remainingRows != 0 {
			t.Errorf("verify runtime smoke database cleanup: remaining=%d err=%v", remainingRows, cleanupErr)
		}
	}()

	elements := []map[string]any{
		{"id": "runtime-rect", "type": "rectangle", "index": "a0", "version": 1, "versionNonce": 201, "x": 40, "y": 40, "width": 180, "height": 100},
		{"id": "runtime-diamond", "type": "diamond", "index": "a1", "version": 1, "versionNonce": 202, "x": 280, "y": 40, "width": 180, "height": 120, "boundElements": []map[string]any{{"id": "runtime-bound-text", "type": "text"}}},
		{"id": "runtime-bound-text", "type": "text", "index": "a2", "version": 1, "versionNonce": 203, "x": 320, "y": 85, "width": 100, "height": 25, "text": "Decisión", "originalText": "Decisión", "containerId": "runtime-diamond"},
		{"id": "runtime-ellipse", "type": "ellipse", "index": "a3", "version": 1, "versionNonce": 204, "x": 520, "y": 40, "width": 120, "height": 120},
		{"id": "runtime-text", "type": "text", "index": "a4", "version": 1, "versionNonce": 205, "x": 40, "y": 220, "width": 180, "height": 25, "text": "Persistido en Clarin", "originalText": "Persistido en Clarin", "containerId": nil},
	}
	scene := map[string]any{
		"type": "excalidraw", "version": 2, "source": "clarin", "elements": elements,
		"appState": map[string]any{"viewBackgroundColor": "#ffffff"}, "files": map[string]any{},
	}
	writeOperationID := uuid.New()
	payload := map[string]any{
		"expected_sequence": 0, "operation_id": writeOperationID, "scene": scene,
		"patch":                map[string]any{"base_sequence": 0, "elements": elements, "app_state": scene["appState"]},
		"scene_schema_version": "excalidraw", "editor_version": "0.18.1-clarin.5",
	}
	written := performWhiteboardRuntimeRequest(t, http.MethodPatch, baseURL+"/api/whiteboards/"+boardID.String()+"/scene", token, payload)
	if written.StatusCode != http.StatusOK {
		t.Fatalf("runtime PATCH status=%d body=%s", written.StatusCode, written.Body)
	}

	thumbnailImage := image.NewRGBA(image.Rect(0, 0, 2, 2))
	boardBytes := boardID
	thumbnailImage.Set(0, 0, color.RGBA{R: boardBytes[0], G: boardBytes[1], B: boardBytes[2], A: 255})
	thumbnailImage.Set(1, 0, color.RGBA{R: boardBytes[3], G: boardBytes[4], B: boardBytes[5], A: 255})
	thumbnailImage.Set(0, 1, color.RGBA{R: boardBytes[6], G: boardBytes[7], B: boardBytes[8], A: 255})
	thumbnailImage.Set(1, 1, color.RGBA{R: boardBytes[9], G: boardBytes[10], B: boardBytes[11], A: 255})
	var thumbnailPNG bytes.Buffer
	if err := png.Encode(&thumbnailPNG, thumbnailImage); err != nil {
		t.Fatal(err)
	}
	uploaded := performWhiteboardRuntimeMultipartRequest(t,
		baseURL+"/api/whiteboards/"+boardID.String()+"/assets", token,
		map[string]string{"file_id": "thumbnail", "kind": "thumbnail"},
		"file", "thumbnail.png", "image/png", thumbnailPNG.Bytes())
	if uploaded.StatusCode != http.StatusCreated {
		t.Fatalf("runtime thumbnail status=%d body=%s", uploaded.StatusCode, uploaded.Body)
	}

	revisionOperationID := uuid.New()
	revision := performWhiteboardRuntimeRequest(t, http.MethodPost, baseURL+"/api/whiteboards/"+boardID.String()+"/revisions", token, map[string]any{
		"expected_sequence": 1, "operation_id": revisionOperationID,
	})
	if revision.StatusCode != http.StatusCreated {
		t.Fatalf("runtime revision status=%d body=%s", revision.StatusCode, revision.Body)
	}
	loaded := performWhiteboardRuntimeRequest(t, http.MethodGet, baseURL+"/api/whiteboards/"+boardID.String()+"/scene", token, nil)
	if loaded.StatusCode != http.StatusOK {
		t.Fatalf("runtime GET status=%d body=%s", loaded.StatusCode, loaded.Body)
	}
	var sceneResponse struct {
		Scene domain.WhiteboardScene `json:"scene"`
	}
	if err := json.Unmarshal([]byte(loaded.Body), &sceneResponse); err != nil {
		t.Fatal(err)
	}
	var document struct {
		Elements []map[string]any `json:"elements"`
	}
	if err := json.Unmarshal(sceneResponse.Scene.Scene, &document); err != nil {
		t.Fatal(err)
	}
	var sequence, operationCount int64
	if err := db.QueryRow(ctx, `SELECT scene_sequence FROM whiteboards WHERE account_id=$1 AND id=$2`, accountID, boardID).Scan(&sequence); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM whiteboard_operations WHERE account_id=$1 AND board_id=$2`, accountID, boardID).Scan(&operationCount); err != nil {
		t.Fatal(err)
	}
	var thumbnailCount, manualRevisionCount, activeStorageCount int64
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM whiteboard_assets WHERE account_id=$1 AND board_id=$2 AND kind='thumbnail' AND committed_at IS NOT NULL`, accountID, boardID).Scan(&thumbnailCount); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM whiteboard_revisions WHERE account_id=$1 AND board_id=$2 AND revision_kind='manual' AND operation_id=$3`, accountID, boardID, revisionOperationID).Scan(&manualRevisionCount); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM storage_objects WHERE account_id=$1 AND object_key LIKE $2 AND status='active'`, accountID, objectPrefix+"%").Scan(&activeStorageCount); err != nil {
		t.Fatal(err)
	}
	storedObjects, err := objectStore.ListPrefix(ctx, objectPrefix)
	if err != nil {
		t.Fatalf("list runtime smoke objects: %v", err)
	}
	// Creation owns an immutable system snapshot, then this smoke adds one
	// thumbnail and one manual snapshot under the same board-only prefix.
	if sceneResponse.Scene.Sequence != 2 || sequence != 2 || len(document.Elements) != len(elements) || operationCount < 3 || thumbnailCount != 1 || manualRevisionCount != 1 || activeStorageCount != 3 || len(storedObjects) != 3 {
		t.Fatalf("deployed durability mismatch: api_sequence=%d db_sequence=%d elements=%d operations=%d thumbnail=%d revision=%d storage=%d objects=%d",
			sceneResponse.Scene.Sequence, sequence, len(document.Elements), operationCount, thumbnailCount, manualRevisionCount, activeStorageCount, len(storedObjects))
	}
	t.Logf("deployed whiteboard persistence verified: sequence=%d elements=%d operations=%d thumbnail=%d revision=%d storage=%d",
		sequence, len(document.Elements), operationCount, thumbnailCount, manualRevisionCount, activeStorageCount)
}

type whiteboardSceneRouterResponse struct {
	StatusCode int
	Body       string
	Success    bool                               `json:"success"`
	Rebased    bool                               `json:"rebased"`
	Result     *domain.WhiteboardSceneWriteResult `json:"result"`
	Scene      *domain.WhiteboardScene            `json:"scene"`
}

func performWhiteboardSceneRequest(t *testing.T, app *fiber.App, method, path string, body any) whiteboardSceneRouterResponse {
	t.Helper()
	var encoded []byte
	var err error
	if body != nil {
		encoded, err = json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
	}
	request, err := http.NewRequest(method, path, bytes.NewReader(encoded))
	if err != nil {
		t.Fatal(err)
	}
	if body != nil {
		request.Header.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSON)
	}
	response, err := app.Test(request, -1)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	result := whiteboardSceneRouterResponse{StatusCode: response.StatusCode, Body: string(raw)}
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatalf("decode response status=%d body=%s: %v", response.StatusCode, raw, err)
	}
	return result
}

type whiteboardRuntimeResponse struct {
	StatusCode int
	Body       string
}

func performWhiteboardRuntimeRequest(t *testing.T, method, url, token string, body any) whiteboardRuntimeResponse {
	t.Helper()
	var encoded []byte
	var err error
	if body != nil {
		encoded, err = json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
	}
	request, err := http.NewRequest(method, url, bytes.NewReader(encoded))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+token)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return whiteboardRuntimeResponse{StatusCode: response.StatusCode, Body: string(raw)}
}

func performWhiteboardRuntimeMultipartRequest(t *testing.T, url, token string, fields map[string]string, fileField, filename, contentType string, data []byte) whiteboardRuntimeResponse {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for key, value := range fields {
		if err := writer.WriteField(key, value); err != nil {
			t.Fatal(err)
		}
	}
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", fmt.Sprintf(`form-data; name=%q; filename=%q`, fileField, filename))
	header.Set("Content-Type", contentType)
	part, err := writer.CreatePart(header)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodPost, url, &body)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return whiteboardRuntimeResponse{StatusCode: response.StatusCode, Body: string(raw)}
}
