package api

// This suite intentionally uses real SQL transactions and a disposable MinIO
// bucket. It is not an API mock test, and it never connects to WhatsApp.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
	"github.com/naperu/clarin/internal/storage"
	"github.com/naperu/clarin/pkg/database"
)

type storageQAFixture struct {
	t                                      *testing.T
	db                                     *pgxpool.Pool
	store                                  *storage.Storage
	server                                 *Server
	app                                    *fiber.App
	account, other, user, secondUser, role uuid.UUID
}

func newStorageQAFixture(t *testing.T, db *pgxpool.Pool, store *storage.Storage) *storageQAFixture {
	t.Helper()
	f := &storageQAFixture{t: t, db: db, store: store, account: uuid.New(), other: uuid.New(), user: uuid.New(), secondUser: uuid.New(), role: uuid.New()}
	f.exec(`INSERT INTO accounts(id,name,storage_limit_bytes) VALUES($1,'Storage QA A',1048576),($2,'Storage QA B',1048576)`, f.account, f.other)
	f.exec(`INSERT INTO roles(id,name,permissions) VALUES($1,$2,$3)`, f.role, "storage-qa-"+f.role.String(), []string{domain.PermSettings, domain.PermChats})
	for _, user := range []uuid.UUID{f.user, f.secondUser} {
		f.exec(`INSERT INTO users(id,account_id,username,email,password_hash) VALUES($1,$2,$3,$4,'no-login')`, user, f.account, "qa-"+user.String(), user.String()+"@test.invalid")
		for _, account := range []uuid.UUID{f.account, f.other} {
			f.exec(`INSERT INTO user_accounts(user_id,account_id,role,role_id) VALUES($1,$2,'member',$3)`, user, account, f.role)
		}
	}
	repos := repository.NewRepositories(db)
	f.server = &Server{repos: repos, services: service.NewServices(repos, nil, nil), storage: store}
	f.app = fiber.New()
	// Synthetic identity injection deliberately bypasses login only. Each real
	// handler must enforce the tenant, actor and permission boundary itself.
	f.app.Use(func(c *fiber.Ctx) error {
		account, user := f.account, f.user
		if c.Get("X-QA-Account") == "other" {
			account = f.other
		}
		if c.Get("X-QA-User") == "second" {
			user = f.secondUser
		}
		permissions := []string{domain.PermSettings, domain.PermChats}
		c.Locals("account_id", account)
		c.Locals("user_id", user)
		c.Locals("claims", &service.JWTClaims{AccountID: account, UserID: user, Role: "member", Permissions: permissions})
		return c.Next()
	})
	f.app.Get("/storage/usage", f.server.handleStorageSelfServiceUsage)
	f.app.Get("/storage/files", f.server.handleStorageSelfServiceFiles)
	f.app.Get("/storage/content", f.server.handleStorageSelfServiceContent)
	f.app.Post("/storage/cleanup/preview", f.server.handleStorageCleanupPreview)
	f.app.Post("/storage/cleanup/confirm", f.server.handleStorageCleanupConfirm)
	f.app.Get("/storage/activity", f.server.handleStorageCleanupActivity)
	t.Cleanup(func() {
		for _, account := range []uuid.UUID{f.account, f.other} {
			if _, err := store.DeletePrefix(context.Background(), account.String()+"/"); err != nil {
				t.Errorf("QA object cleanup failed: %v", err)
			}
		}
	})
	return f
}

func (f *storageQAFixture) exec(query string, args ...any) {
	f.t.Helper()
	if _, err := f.db.Exec(context.Background(), query, args...); err != nil {
		f.t.Fatal(err)
	}
}

func (f *storageQAFixture) request(method, path string, body any, headers map[string]string) (int, map[string]any) {
	f.t.Helper()
	permissions := []string{domain.PermSettings, domain.PermChats}
	if headers["X-QA-Permission"] == "no-chats" {
		permissions = []string{domain.PermSettings}
	}
	if headers["X-QA-Permission"] == "read-only" {
		permissions = []string{domain.PermChats}
	}
	// Claims intentionally retain the previous permissions. The storage API
	// must refresh current authority from the database on every operation.
	f.exec(`UPDATE roles SET permissions=$2 WHERE id=$1`, f.role, permissions)
	var payload []byte
	if body != nil {
		var err error
		payload, err = json.Marshal(body)
		if err != nil {
			f.t.Fatal(err)
		}
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	for name, value := range headers {
		req.Header.Set(name, value)
	}
	res, err := f.app.Test(req, 15000)
	if err != nil {
		f.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		f.t.Fatal(err)
	}
	var data map[string]any
	if err := json.Unmarshal(raw, &data); err != nil {
		f.t.Fatalf("non-JSON status=%d response=%s", res.StatusCode, raw)
	}
	return res.StatusCode, data
}

func (f *storageQAFixture) media(account uuid.UUID, folder, filename string, withMessage bool) (string, uuid.UUID, uuid.UUID) {
	f.t.Helper()
	key := account.String() + "/" + folder + "/" + uuid.NewString() + "-" + filename
	payload := []byte("Synthetic QA document " + uuid.NewString())
	if _, err := f.store.UploadObject(context.Background(), key, payload, "application/pdf"); err != nil {
		f.t.Fatal(err)
	}
	asset := uuid.New()
	f.exec(`INSERT INTO media_assets(id,account_id,content_hash,object_key,media_type,content_type,filename,size_bytes) VALUES($1,$2,$3,$4,'document','application/pdf',$5,$6)`, asset, account, "qa-hash-"+asset.String(), key, filename, len(payload))
	f.exec(`INSERT INTO storage_objects(account_id,object_key,media_type,content_type,filename,size_bytes,source) VALUES($1,$2,'document','application/pdf',$3,$4,'whatsapp')`, account, key, filename, len(payload))
	var message uuid.UUID
	if withMessage {
		chat, contact := uuid.New(), uuid.New()
		jid := "qa-" + contact.String() + "@test.invalid"
		f.exec(`INSERT INTO contacts(id,account_id,jid,name) VALUES($1,$2,$3,'Synthetic QA Contact')`, contact, account, jid)
		f.exec(`INSERT INTO chats(id,account_id,jid,contact_id) VALUES($1,$2,$3,$4)`, chat, account, jid, contact)
		message = uuid.New()
		f.exec(`INSERT INTO messages(id,account_id,chat_id,message_id,body,message_type,media_url,media_mimetype,media_filename,media_size,media_asset_id,timestamp) VALUES($1,$2,$3,$4,'Keep this message text','document',$5,'application/pdf',$6,$7,$8,NOW())`, message, account, chat, uuid.NewString(), mediaProxyURLFromObjectKey(key), filename, len(payload), asset)
	}
	return key, asset, message
}

func (f *storageQAFixture) expectObject(key string, present bool) {
	f.t.Helper()
	_, err := f.store.GetFileInfo(context.Background(), key)
	if present && err != nil {
		f.t.Fatalf("required object missing: %v", err)
	}
	if !present && err == nil {
		f.t.Fatal("object still present after confirmed purge")
	}
}

func (f *storageQAFixture) preview(action string, keys ...string) map[string]any {
	f.t.Helper()
	code, data := f.request("POST", "/storage/cleanup/preview", map[string]any{"action": action, "object_keys": keys}, nil)
	if code != 200 || data["preview_id"] == nil {
		f.t.Fatalf("preview failed status=%d response=%v", code, data)
	}
	return data
}

func (f *storageQAFixture) confirm(preview map[string]any) map[string]any {
	f.t.Helper()
	code, data := f.request("POST", "/storage/cleanup/confirm", map[string]any{"preview_id": preview["preview_id"]}, nil)
	if code != 200 || data["status"] != "completed" {
		f.t.Fatalf("confirm failed status=%d response=%v", code, data)
	}
	return data
}

func (f *storageQAFixture) expectMessage(message uuid.UUID, deleted bool) {
	f.t.Helper()
	var body string
	var gotDeleted bool
	if err := f.db.QueryRow(context.Background(), `SELECT body,COALESCE(media_deleted,false) FROM messages WHERE id=$1`, message).Scan(&body, &gotDeleted); err != nil {
		f.t.Fatal(err)
	}
	if body != "Keep this message text" || gotDeleted != deleted {
		f.t.Fatalf("message text/history changed or media state wrong: body=%q deleted=%v want=%v", body, gotDeleted, deleted)
	}
}

func storageQAItems(t *testing.T, data map[string]any, field string) []map[string]any {
	t.Helper()
	raw, ok := data[field].([]any)
	if !ok {
		t.Fatalf("missing %s collection: %v", field, data)
	}
	items := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		value, ok := item.(map[string]any)
		if !ok {
			t.Fatalf("invalid %s row", field)
		}
		items = append(items, value)
	}
	return items
}

func TestStorageSelfServiceIntegration(t *testing.T) {
	var db *pgxpool.Pool
	if os.Getenv("CLARIN_STORAGE_QA_PGLITE") == "1" {
		if os.Getenv("CLARIN_RUN_STORAGE_SELF_SERVICE_INTEGRATION") != "1" {
			t.Skip("requires explicit disposable storage integration opt-in")
		}
		parsed, err := url.Parse(os.Getenv("DATABASE_URL"))
		if err != nil || parsed.Hostname() != "127.0.0.1" || parsed.Port() != "15439" || parsed.Path != "/clarin_storage_qa" {
			t.Fatal("PGlite mode requires the dedicated loopback QA endpoint")
		}
		config, err := pgxpool.ParseConfig(parsed.String())
		if err != nil {
			t.Fatal(err)
		}
		config.MaxConns = 1
		db, err = pgxpool.NewWithConfig(context.Background(), config)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(db.Close)
		// PGlite is PostgreSQL WASM, not a native concurrent production server.
		// It validates sequential SQL/transactions only. CI should additionally
		// run this same suite through its normal disposable PostgreSQL path.
		if err = database.Migrate(db); err != nil {
			t.Fatal(err)
		}
		if err = database.MigrateEventPipelines(db); err != nil {
			t.Fatal(err)
		}
	} else {
		db = newFunctionalIntegrityIntegrationDB(t, "CLARIN_RUN_STORAGE_SELF_SERVICE_INTEGRATION", "clarin_storage_qa_")
	}
	if os.Getenv("MINIO_ENDPOINT") != "127.0.0.1:19001" || !strings.HasPrefix(os.Getenv("MINIO_BUCKET"), "clarin-qa") {
		t.Fatal("disposable loopback MinIO and clarin-qa bucket required")
	}
	store, err := storage.New(storage.Config{Endpoint: os.Getenv("MINIO_ENDPOINT"), AccessKey: os.Getenv("MINIO_ACCESS_KEY"), SecretKey: os.Getenv("MINIO_SECRET_KEY"), Bucket: os.Getenv("MINIO_BUCKET"), PublicURL: os.Getenv("MINIO_PUBLIC_URL")})
	if err != nil {
		t.Fatal("disposable QA storage unavailable")
	}
	t.Run("media access and publication", func(t *testing.T) { runMediaAccessIntegrationChecks(t, db, store) })
	t.Run("inventory and known object access are isolated by account and module", func(t *testing.T) {
		f := newStorageQAFixture(t, db, store)
		own, _, _ := f.media(f.account, "chats", "own-document.pdf", true)
		foreign, _, _ := f.media(f.other, "chats", "foreign-secret.pdf", true)
		private, _, _ := f.media(f.account, "_private/tasks/attachments", "work-secret.pdf", true)
		log, _, _ := f.media(f.account, "chats", "server.log", true)
		unknown, _, _ := f.media(f.account, "uploads", "unproven.pdf", false)
		code, data := f.request("GET", "/storage/files?limit=200", nil, nil)
		if code != 200 {
			t.Fatalf("inventory status=%d data=%v", code, data)
		}
		files := storageQAItems(t, data, "files")
		if len(files) != 1 || files[0]["object_key"] != own {
			t.Fatalf("visible inventory leaks private, foreign or technical objects: %v", files)
		}
		code, data = f.request("GET", "/storage/files", nil, map[string]string{"X-QA-Permission": "no-chats"})
		if code != 200 || len(storageQAItems(t, data, "files")) != 0 {
			t.Fatalf("Settings permission exposes Chats media: %d %v", code, data)
		}
		for _, key := range []string{foreign, private, log, unknown} {
			code, data = f.request("POST", "/storage/cleanup/preview", map[string]any{"action": "trash", "object_keys": []string{key}}, nil)
			if code == 200 && data["eligible_count"] != float64(0) {
				t.Fatalf("protected key considered removable: %v", data)
			}
			f.expectObject(key, true)
		}
		for _, key := range []string{foreign, private, unknown} {
			code, _ = f.request("GET", "/storage/content?object_key="+key, nil, nil)
			if code != 404 && code != 403 {
				t.Fatalf("known unauthorized content key status=%d", code)
			}
		}
	})
	t.Run("preview stages only deduplicates and enforces actor account and permission", func(t *testing.T) {
		f := newStorageQAFixture(t, db, store)
		key, _, message := f.media(f.account, "chats", "preview.pdf", true)
		plan := f.preview("trash", key, key)
		if plan["eligible_count"] != float64(1) {
			t.Fatalf("duplicate selected key doubled effects: %v", plan)
		}
		f.expectMessage(message, false)
		f.expectObject(key, true)
		for _, headers := range []map[string]string{{"X-QA-Account": "other"}, {"X-QA-User": "second"}, {"X-QA-Permission": "no-chats"}, {"X-QA-Permission": "read-only"}} {
			code, data := f.request("POST", "/storage/cleanup/confirm", map[string]any{"preview_id": plan["preview_id"]}, headers)
			if code < 400 {
				t.Fatalf("preview authority bypass: status=%d response=%v", code, data)
			}
			f.expectMessage(message, false)
			f.expectObject(key, true)
		}
		result := f.confirm(plan)
		if result["freed_bytes"] != float64(0) {
			t.Fatalf("trash claims bytes freed: %v", result)
		}
		f.expectMessage(message, true)
		f.expectObject(key, true)
		code, replayed := f.request("POST", "/storage/cleanup/confirm", map[string]any{"preview_id": plan["preview_id"]}, nil)
		if code != 200 || fmt.Sprint(replayed["operation_id"]) != fmt.Sprint(result["operation_id"]) {
			t.Fatalf("confirm is not idempotent: %d %v", code, replayed)
		}
		code, replayed = f.request("POST", "/storage/cleanup/confirm", map[string]any{"preview_id": plan["preview_id"]}, map[string]string{"X-QA-Permission": "no-chats"})
		if code < 400 {
			t.Fatalf("completed replay exposes previously authorized chat files after permission revocation: %d %v", code, replayed)
		}
		var count int
		if err := db.QueryRow(context.Background(), `SELECT COUNT(*) FROM storage_media_trash WHERE account_id=$1 AND object_key=$2`, f.account, key).Scan(&count); err != nil || count != 1 {
			t.Fatalf("duplicate durable effects count=%d error=%v", count, err)
		}
	})
	t.Run("cross module live references block cleanup without revealing hidden origin", func(t *testing.T) {
		f := newStorageQAFixture(t, db, store)
		key, _, message := f.media(f.account, "chats", "shared.pdf", true)
		f.exec(`INSERT INTO quick_replies(account_id,shortcut,title,body,media_url) VALUES($1,$2,'Reusable reply','Synthetic',$3)`, f.account, "qa-"+uuid.NewString(), mediaProxyURLFromObjectKey(key))
		plan := f.preview("trash", key)
		if plan["eligible_count"] != float64(0) {
			t.Fatalf("shared reply file eligible: %v", plan)
		}
		code, _ := f.request("POST", "/storage/cleanup/confirm", map[string]any{"preview_id": plan["preview_id"]}, nil)
		if code < 400 {
			t.Fatal("blocked-only selection accepted")
		}
		f.expectObject(key, true)
		f.expectMessage(message, false)
	})
	t.Run("dynamic overlay JSON is a live reference even without module permission", func(t *testing.T) {
		f := newStorageQAFixture(t, db, store)
		key, _, message := f.media(f.account, "chats", "overlay.pdf", true)
		config, _ := json.Marshal(map[string]any{"overlay_image_url": mediaProxyURLFromObjectKey(key)})
		f.exec(`INSERT INTO dynamics(account_id,name,slug,config) VALUES($1,'Hidden dynamic title',$2,$3::jsonb)`, f.account, "qa-"+uuid.NewString(), config)
		plan := f.preview("trash", key)
		if plan["eligible_count"] != float64(0) {
			t.Fatalf("dynamic overlay silently treated as unused: %v", plan)
		}
		_, inventory := f.request("GET", "/storage/files", nil, nil)
		encoded, _ := json.Marshal(inventory)
		if bytes.Contains(encoded, []byte("Hidden dynamic title")) {
			t.Fatal("unauthorized dynamic context leaked through shared file")
		}
		f.expectObject(key, true)
		f.expectMessage(message, false)
	})
	t.Run("expired plan fails before altering messages or media", func(t *testing.T) {
		f := newStorageQAFixture(t, db, store)
		key, _, message := f.media(f.account, "chats", "expired.pdf", true)
		plan := f.preview("trash", key)
		f.exec(`UPDATE storage_cleanup_previews SET expires_at=NOW()-INTERVAL '1 minute' WHERE id=$1`, plan["preview_id"])
		code, _ := f.request("POST", "/storage/cleanup/confirm", map[string]any{"preview_id": plan["preview_id"]}, nil)
		if code != 409 && code != 410 {
			t.Fatalf("expired confirmation status=%d", code)
		}
		f.expectObject(key, true)
		f.expectMessage(message, false)
	})
	t.Run("new reference after preview invalidates the entire selected plan", func(t *testing.T) {
		f := newStorageQAFixture(t, db, store)
		first, _, firstMessage := f.media(f.account, "chats", "first.pdf", true)
		second, _, secondMessage := f.media(f.account, "chats", "second.pdf", true)
		plan := f.preview("trash", first, second)
		f.exec(`INSERT INTO quick_replies(account_id,shortcut,title,body,media_url) VALUES($1,$2,'Added after preview','Synthetic',$3)`, f.account, "qa-"+uuid.NewString(), mediaProxyURLFromObjectKey(second))
		code, data := f.request("POST", "/storage/cleanup/confirm", map[string]any{"preview_id": plan["preview_id"]}, nil)
		if code != 409 {
			t.Fatalf("stale selection status=%d response=%v", code, data)
		}
		f.expectObject(first, true)
		f.expectObject(second, true)
		f.expectMessage(firstMessage, false)
		f.expectMessage(secondMessage, false)
	})
	t.Run("restore recovers exact references and keeps message text", func(t *testing.T) {
		f := newStorageQAFixture(t, db, store)
		key, asset, message := f.media(f.account, "chats", "restore.pdf", true)
		f.confirm(f.preview("trash", key))
		f.expectMessage(message, true)
		code, trash := f.request("GET", "/storage/files?status=trash", nil, nil)
		if code != 200 || len(storageQAItems(t, trash, "files")) != 1 {
			t.Fatalf("trash missing: %d %v", code, trash)
		}
		f.confirm(f.preview("restore", key))
		f.expectMessage(message, false)
		f.expectObject(key, true)
		var restoredID uuid.UUID
		var restoredURL string
		if err := db.QueryRow(context.Background(), `SELECT media_asset_id,media_url FROM messages WHERE id=$1`, message).Scan(&restoredID, &restoredURL); err != nil || restoredID != asset || restoredURL != mediaProxyURLFromObjectKey(key) {
			t.Fatalf("restore changed original pointer: %s %s %v", restoredID, restoredURL, err)
		}
		code, trash = f.request("GET", "/storage/files?status=trash", nil, nil)
		if code != 200 || len(storageQAItems(t, trash, "files")) != 0 {
			t.Fatalf("restored file still in trash: %v", trash)
		}
	})
	t.Run("retention prohibits early purge and purge repairs dedup hash truth", func(t *testing.T) {
		f := newStorageQAFixture(t, db, store)
		key, asset, message := f.media(f.account, "chats", "purge.pdf", true)
		f.confirm(f.preview("trash", key))
		plan := f.preview("purge", key)
		if plan["eligible_count"] != float64(0) {
			t.Fatal("7-day recovery window bypassed")
		}
		f.expectObject(key, true)
		f.exec(`UPDATE storage_media_trash SET purge_after=NOW()-INTERVAL '1 minute' WHERE account_id=$1 AND object_key=$2`, f.account, key)
		plan = f.preview("purge", key)
		result := f.confirm(plan)
		if freed, ok := result["freed_bytes"].(float64); !ok || freed <= 0 {
			t.Fatalf("no actual freed bytes recorded: %v", result)
		}
		f.expectObject(key, false)
		f.expectMessage(message, true)
		cached, err := f.server.repos.MediaAsset.GetByHash(context.Background(), f.account, "qa-hash-"+asset.String())
		if err != nil || cached != nil {
			t.Fatalf("dedup can reuse a physically deleted object: cached=%v err=%v", cached, err)
		}
		newKey := f.account.String() + "/uploads/reupload-" + uuid.NewString() + ".pdf"
		if _, err := store.UploadObject(context.Background(), newKey, []byte("Synthetic reupload"), "application/pdf"); err != nil {
			t.Fatal(err)
		}
		newAsset, err := f.server.repos.MediaAsset.Upsert(context.Background(), repository.MediaAssetUpsert{AccountID: f.account, ContentHash: "qa-hash-" + asset.String(), ObjectKey: newKey, MediaType: "document", ContentType: "application/pdf", Filename: "reupload.pdf", SizeBytes: 18})
		if err != nil || newAsset.ObjectKey != newKey {
			t.Fatalf("reupload resurrects missing old key: %v %v", newAsset, err)
		}
		f.expectObject(newKey, true)
	})
	t.Run("physical delete failure reports partial result and retains retryable object", func(t *testing.T) {
		f := newStorageQAFixture(t, db, store)
		first, _, firstMessage := f.media(f.account, "chats", "physical-success.pdf", true)
		second, _, secondMessage := f.media(f.account, "chats", "physical-failure.pdf", true)
		f.confirm(f.preview("trash", first, second))
		f.exec(`UPDATE storage_media_trash SET purge_after=NOW()-INTERVAL '1 minute' WHERE account_id=$1`, f.account)
		plan := f.preview("purge", first, second)
		upstream, err := url.Parse("http://" + os.Getenv("MINIO_ENDPOINT"))
		if err != nil {
			t.Fatal(err)
		}
		proxy := httputil.NewSingleHostReverseProxy(upstream)
		// Fault injection occurs only in this test's proxy. The real S3 server,
		// bucket, SQL state and unaffected object are still exercised.
		fault := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodDelete && strings.HasSuffix(r.URL.Path, "/"+second) {
				w.Header().Set("Content-Type", "application/xml")
				w.WriteHeader(http.StatusForbidden)
				_, _ = io.WriteString(w, `<Error><Code>AccessDenied</Code><Message>Synthetic QA deletion failure</Message></Error>`)
				return
			}
			proxy.ServeHTTP(w, r)
		}))
		defer fault.Close()
		faultyStore, err := storage.New(storage.Config{Endpoint: strings.TrimPrefix(fault.URL, "http://"), AccessKey: os.Getenv("MINIO_ACCESS_KEY"), SecretKey: os.Getenv("MINIO_SECRET_KEY"), Bucket: os.Getenv("MINIO_BUCKET"), PublicURL: os.Getenv("MINIO_PUBLIC_URL")})
		if err != nil {
			t.Fatal("QA fault-injection proxy initialization failed")
		}
		f.server.storage = faultyStore
		code, result := f.request("POST", "/storage/cleanup/confirm", map[string]any{"preview_id": plan["preview_id"]}, nil)
		if code != 200 || result["status"] != "partial" {
			t.Fatalf("false all-success after one physical failure: %d %v", code, result)
		}
		items := storageQAItems(t, result, "items")
		statuses := map[string]any{}
		for _, item := range items {
			statuses[item["object_key"].(string)] = item["status"]
		}
		if statuses[first] != "completed" || statuses[second] != "failed" {
			t.Fatalf("incorrect per-file outcome: %v", statuses)
		}
		f.expectObject(first, false)
		f.expectObject(second, true)
		f.expectMessage(firstMessage, true)
		f.expectMessage(secondMessage, true)
		f.server.storage = store
		resumed := f.confirm(plan)
		if resumed["operation_id"] != plan["preview_id"] {
			t.Fatal("retry created a competing cleanup operation")
		}
		f.expectObject(second, false)
	})
	t.Run("database finalization failure preserves tombstone and resumes after physical deletion", func(t *testing.T) {
		f := newStorageQAFixture(t, db, store)
		key, asset, _ := f.media(f.account, "chats", "interrupted.pdf", true)
		f.confirm(f.preview("trash", key))
		f.exec(`UPDATE storage_media_trash SET purge_after=NOW()-INTERVAL '1 minute' WHERE account_id=$1 AND object_key=$2`, f.account, key)
		plan := f.preview("purge", key)
		fn := "qa_fail_storage_finalize_" + strings.ReplaceAll(uuid.NewString(), "-", "")
		f.exec(fmt.Sprintf(`CREATE FUNCTION %s() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.account_id='%s'::uuid AND NEW.status='deleted' THEN RAISE EXCEPTION 'Synthetic QA finalization failure'; END IF; RETURN NEW; END $$`, fn, f.account))
		f.exec(fmt.Sprintf(`CREATE TRIGGER %s BEFORE UPDATE ON storage_objects FOR EACH ROW EXECUTE FUNCTION %s()`, fn, fn))
		t.Cleanup(func() {
			_, _ = db.Exec(context.Background(), fmt.Sprintf(`DROP TRIGGER IF EXISTS %s ON storage_objects`, fn))
			_, _ = db.Exec(context.Background(), fmt.Sprintf(`DROP FUNCTION IF EXISTS %s()`, fn))
		})
		code, data := f.request("POST", "/storage/cleanup/confirm", map[string]any{"preview_id": plan["preview_id"]}, nil)
		if code != 503 {
			t.Fatalf("unrecorded deletion reported success: %d %v", code, data)
		}
		f.expectObject(key, false)
		var state, assetStatus string
		if err := db.QueryRow(context.Background(), `SELECT t.state,ma.status FROM storage_media_trash t JOIN media_assets ma ON ma.account_id=t.account_id AND ma.object_key=t.object_key WHERE t.account_id=$1 AND ma.id=$2`, f.account, asset).Scan(&state, &assetStatus); err != nil || state != "purging" || assetStatus != "deleting" {
			t.Fatalf("durable recovery lost state=%s asset=%s err=%v", state, assetStatus, err)
		}
		f.exec(fmt.Sprintf(`DROP TRIGGER %s ON storage_objects`, fn))
		result := f.confirm(plan)
		if result["freed_bytes"] != float64(0) {
			t.Fatalf("retry invented unverified freed bytes: %v", result)
		}
		f.expectObject(key, false)
	})
	t.Run("reference guards reject cross-account writes and tombstone resurrection", func(t *testing.T) {
		f := newStorageQAFixture(t, db, store)
		key, _, _ := f.media(f.account, "chats", "guarded.pdf", true)
		foreign, _, _ := f.media(f.other, "chats", "foreign-guarded.pdf", true)
		insert := func(key string) error {
			_, err := db.Exec(context.Background(), `INSERT INTO quick_replies(account_id,shortcut,title,body,media_url) VALUES($1,$2,'Guard QA','Synthetic',$3)`, f.account, "qa-"+uuid.NewString(), mediaProxyURLFromObjectKey(key))
			return err
		}
		if err := insert(foreign); err == nil {
			t.Fatal("database accepted a media reference from a different account")
		}
		f.confirm(f.preview("trash", key))
		for _, state := range []string{"purging", "purged"} {
			f.exec(`UPDATE storage_media_trash SET state=$3 WHERE account_id=$1 AND object_key=$2`, f.account, key, state)
			if err := insert(key); err == nil {
				t.Fatalf("writer resurrected a %s object", state)
			}
		}
		f.expectObject(key, true)
	})
	t.Run("deleting initiating user preserves durable cleanup and allows only account administrator recovery", func(t *testing.T) {
		f := newStorageQAFixture(t, db, store)
		key, asset, _ := f.media(f.account, "chats", "departed-user.pdf", true)
		f.confirm(f.preview("trash", key))
		f.exec(`UPDATE storage_media_trash SET purge_after=NOW()-INTERVAL '1 minute' WHERE account_id=$1 AND object_key=$2`, f.account, key)
		plan := f.preview("purge", key)
		// Seed an interrupted, already committed operation, as if the process
		// stopped between durable intent and its first physical delete.
		f.exec(`UPDATE storage_media_trash SET state='purging' WHERE account_id=$1 AND object_key=$2`, f.account, key)
		f.exec(`UPDATE media_assets SET status='deleting' WHERE account_id=$1 AND id=$2`, f.account, asset)
		pending, _ := json.Marshal(map[string]any{"success": true, "operation_id": plan["preview_id"], "action": "purge", "status": "processing", "freed_bytes": 0, "items": []map[string]any{{"object_key": key, "filename": "departed-user.pdf", "status": "pending"}}})
		f.exec(`UPDATE storage_cleanup_previews SET result=$2::jsonb WHERE id=$1`, plan["preview_id"], pending)
		f.exec(`DELETE FROM users WHERE id=$1`, f.user)
		var count int
		if err := db.QueryRow(context.Background(), `SELECT COUNT(*) FROM storage_cleanup_previews WHERE id=$1`, plan["preview_id"]).Scan(&count); err != nil || count != 1 {
			t.Fatalf("user deletion erased durable operation: %d %v", count, err)
		}
		code, _ := f.request("POST", "/storage/cleanup/confirm", map[string]any{"preview_id": plan["preview_id"]}, map[string]string{"X-QA-User": "second"})
		if code < 400 {
			t.Fatal("another non-admin member resumed someone else's operation")
		}
		f.exec(`UPDATE user_accounts SET role='admin' WHERE user_id=$1 AND account_id=$2`, f.secondUser, f.account)
		code, data := f.request("POST", "/storage/cleanup/confirm", map[string]any{"preview_id": plan["preview_id"]}, map[string]string{"X-QA-User": "second", "X-QA-Account": "other"})
		if code < 400 {
			t.Fatalf("other account resumed durable operation: %v", data)
		}
		code, data = f.request("POST", "/storage/cleanup/confirm", map[string]any{"preview_id": plan["preview_id"]}, map[string]string{"X-QA-User": "second"})
		if code != 200 || data["status"] != "completed" {
			t.Fatalf("account administrator could not recover durable cleanup: %d %v", code, data)
		}
		f.expectObject(key, false)
	})
	t.Run("native PostgreSQL barrier blocks same-account writer without blocking another account", func(t *testing.T) {
		if os.Getenv("CLARIN_STORAGE_QA_PGLITE") == "1" {
			t.Skip("concurrency requires native PostgreSQL; PGlite is sequential")
		}
		f := newStorageQAFixture(t, db, store)
		first, _, _ := f.media(f.account, "chats", "barrier-a.pdf", true)
		second, _, _ := f.media(f.other, "chats", "barrier-b.pdf", true)
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		tx, err := db.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(context.Background())
		if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('storage-self-service:'||$1::text,0))`, f.account.String()); err != nil {
			t.Fatal(err)
		}
		write := func(account uuid.UUID, key string) error {
			_, err := db.Exec(ctx, `INSERT INTO quick_replies(account_id,shortcut,title,body,media_url) VALUES($1,$2,'Barrier QA','Synthetic',$3)`, account, "qa-"+uuid.NewString(), mediaProxyURLFromObjectKey(key))
			return err
		}
		same := make(chan error, 1)
		other := make(chan error, 1)
		go func() { same <- write(f.account, first) }()
		go func() { other <- write(f.other, second) }()
		select {
		case err := <-other:
			if err != nil {
				t.Fatalf("other account failed: %v", err)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("cleanup barrier blocks unrelated account")
		}
		select {
		case err := <-same:
			t.Fatalf("same-account writer bypassed cleanup barrier: %v", err)
		case <-time.After(100 * time.Millisecond):
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		select {
		case err := <-same:
			if err != nil {
				t.Fatalf("same-account writer failed after release: %v", err)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("writer failed to resume after cleanup releases barrier")
		}
	})
	t.Run("pagination exposes entries beyond 200 exactly once", func(t *testing.T) {
		f := newStorageQAFixture(t, db, store)
		for index := 0; index < 205; index++ {
			f.media(f.account, "chats", fmt.Sprintf("page-%03d.pdf", index), true)
		}
		seen := map[string]bool{}
		for offset := 0; offset < 205; offset += 40 {
			code, data := f.request("GET", fmt.Sprintf("/storage/files?limit=40&offset=%d&sort=name&order=asc", offset), nil, nil)
			if code != 200 || data["total"] != float64(205) {
				t.Fatalf("pagination lost total: %d %v", code, data)
			}
			for _, file := range storageQAItems(t, data, "files") {
				key := file["object_key"].(string)
				if seen[key] {
					t.Fatal("pagination repeated object")
				}
				seen[key] = true
			}
		}
		if len(seen) != 205 {
			t.Fatalf("only %d/205 accessible", len(seen))
		}
	})
}
