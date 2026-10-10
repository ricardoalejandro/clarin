package api

// This suite executes the production SQL, repositories and storage-independent
// handlers against a disposable PostgreSQL database (or PGlite explicitly).
// It does NOT validate S3, object bytes, full preview/confirm, native concurrent
// transactions or physical deletion. Those remain in TestStorageSelfServiceIntegration.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http/httptest"
	"net/url"
	"os"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
	"github.com/naperu/clarin/pkg/database"
)

type storageSQLFixture struct {
	t                                      *testing.T
	db                                     *pgxpool.Pool
	server                                 *Server
	app                                    *fiber.App
	account, other, user, secondUser, role uuid.UUID
}

func newStorageSQLFixture(t *testing.T, db *pgxpool.Pool) *storageSQLFixture {
	t.Helper()
	f := &storageSQLFixture{t: t, db: db, account: uuid.New(), other: uuid.New(), user: uuid.New(), secondUser: uuid.New(), role: uuid.New()}
	f.exec(`INSERT INTO accounts(id,name) VALUES($1,'Disposable SQL QA A'),($2,'Disposable SQL QA B')`, f.account, f.other)
	f.exec(`INSERT INTO roles(id,name,permissions) VALUES($1,$2,$3)`, f.role, "storage-sql-qa-"+f.role.String(), []string{domain.PermSettings, domain.PermChats})
	for _, user := range []uuid.UUID{f.user, f.secondUser} {
		f.exec(`INSERT INTO users(id,account_id,username,email,password_hash) VALUES($1,$2,$3,$4,'no-login')`, user, f.account, "sql-qa-"+user.String(), user.String()+"@test.invalid")
		for _, account := range []uuid.UUID{f.account, f.other} {
			f.exec(`INSERT INTO user_accounts(user_id,account_id,role,role_id) VALUES($1,$2,'member',$3)`, user, account, f.role)
		}
	}
	repos := repository.NewRepositories(db)
	f.server = &Server{repos: repos, services: service.NewServices(repos, nil, nil)} // storage deliberately remains nil.
	f.app = fiber.New()
	f.app.Use(func(c *fiber.Ctx) error {
		account, actor := f.account, f.user
		if c.Get("X-QA-Account") == "other" {
			account = f.other
		}
		if c.Get("X-QA-User") == "second" {
			actor = f.secondUser
		}
		claims := &service.JWTClaims{AccountID: account, UserID: actor, Role: "admin", IsSuperAdmin: true, Permissions: []string{domain.PermSettings, domain.PermChats}}
		if c.Get("X-QA-Claims") == "foreign" {
			claims.AccountID = uuid.New()
		}
		c.Locals("account_id", account)
		c.Locals("user_id", actor)
		c.Locals("claims", claims)
		return c.Next()
	})
	// Test-only inspection route invokes the real actor resolver; it is never
	// registered by the application and does not substitute a production API.
	f.app.Get("/qa/actor", func(c *fiber.Ctx) error {
		account, actor, claims, err := f.server.storageSelfServiceActor(c)
		if err != nil {
			return c.Status(403).JSON(fiber.Map{"error": "forbidden"})
		}
		return c.JSON(fiber.Map{"account": account, "actor": actor, "role": claims.Role, "super_admin": claims.IsSuperAdmin, "settings": storageSelfServiceHasPermission(claims, domain.PermSettings), "chats": storageSelfServiceHasPermission(claims, domain.PermChats)})
	})
	f.app.Get("/storage/activity", f.server.handleStorageCleanupActivity)
	f.app.Get("/storage/usage", f.server.handleStorageSelfServiceUsage)
	f.app.Get("/storage/files", f.server.handleStorageSelfServiceFiles)
	f.app.Get("/storage/content", f.server.handleStorageSelfServiceContent)
	f.app.Post("/storage/cleanup/preview", f.server.handleStorageCleanupPreview)
	f.app.Post("/storage/cleanup/confirm", f.server.handleStorageCleanupConfirm)
	return f
}

func (f *storageSQLFixture) exec(query string, args ...any) {
	f.t.Helper()
	if _, err := f.db.Exec(context.Background(), query, args...); err != nil {
		f.t.Fatalf("SQL fixture: %v", err)
	}
}
func (f *storageSQLFixture) request(method, path string, body any, headers map[string]string) (int, map[string]any) {
	f.t.Helper()
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
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	res, err := f.app.Test(req, 10000)
	if err != nil {
		f.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		f.t.Fatal(err)
	}
	var result map[string]any
	if err = json.Unmarshal(raw, &result); err != nil {
		f.t.Fatalf("non JSON response %d: %s", res.StatusCode, raw)
	}
	return res.StatusCode, result
}
func (f *storageSQLFixture) media(account uuid.UUID, filename string) (storageSelfServiceFile, uuid.UUID, uuid.UUID) {
	f.t.Helper()
	ctx := context.Background()
	key := account.String() + "/chats/" + uuid.NewString() + "-" + filename
	asset, chat, message, contact := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	f.exec(`INSERT INTO media_assets(id,account_id,content_hash,object_key,filename,media_type,content_type,size_bytes) VALUES($1,$2,$3,$4,$5,'document','application/pdf',42)`, asset, account, asset.String(), key, filename)
	f.exec(`INSERT INTO storage_objects(account_id,object_key,filename,media_type,content_type,size_bytes,source) VALUES($1,$2,$3,'document','application/pdf',42,'whatsapp')`, account, key, filename)
	f.exec(`INSERT INTO contacts(id,account_id,jid,name) VALUES($1,$2,$3,'SQL QA contact')`, contact, account, chat.String()+"@test.invalid")
	f.exec(`INSERT INTO chats(id,account_id,jid,name,contact_id) VALUES($1,$2,$3,'SQL QA conversation',$4)`, chat, account, chat.String()+"@test.invalid", contact)
	f.exec(`INSERT INTO messages(id,account_id,chat_id,message_id,body,message_type,media_url,media_mimetype,media_filename,media_size,media_asset_id,timestamp) VALUES($1,$2,$3,$4,'Message history must survive','document',$5,'application/pdf',$6,42,$7,NOW())`, message, account, chat, message.String(), mediaProxyURLFromObjectKey(key), filename, asset)
	refs, err := storageSelfServiceObjectReferences(ctx, f.db, account, key)
	if err != nil {
		f.t.Fatal(err)
	}
	return storageSelfServiceFile{ObjectKey: key, Filename: filename, MediaType: "document", SizeBytes: 42, Status: "active", CanRemove: true, ReferencesCount: len(refs), refs: refs}, asset, message
}
func (f *storageSQLFixture) tx(run func(pgx.Tx) error, commit bool) error {
	f.t.Helper()
	ctx := context.Background()
	tx, err := f.db.Begin(ctx)
	if err != nil {
		f.t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if err = run(tx); err != nil {
		return err
	}
	if commit {
		return tx.Commit(ctx)
	}
	return nil
}
func (f *storageSQLFixture) count(query string, args ...any) int {
	f.t.Helper()
	var count int
	if err := f.db.QueryRow(context.Background(), query, args...).Scan(&count); err != nil {
		f.t.Fatal(err)
	}
	return count
}
func (f *storageSQLFixture) operation(account, actor uuid.UUID, action, status string) uuid.UUID {
	f.t.Helper()
	id := uuid.New()
	result := storageCleanupResult{OperationID: id, Action: action, Status: status, Items: []storageCleanupItemResult{{ObjectKey: account.String() + "/uploads/private-name.pdf", Filename: "private-name.pdf", Status: "pending"}}, FreedBytes: 0, RetainedBytes: 42}
	payload, err := json.Marshal(result)
	if err != nil {
		f.t.Fatal(err)
	}
	f.exec(`INSERT INTO storage_cleanup_previews(id,account_id,actor_id,action,items,expires_at,result) VALUES($1,$2,$3,$4,'[]',NOW()+INTERVAL '10 minutes',$5::jsonb)`, id, account, actor, action, payload)
	return id
}

func TestStorageSelfServiceSQLIntegration(t *testing.T) {
	if os.Getenv("CLARIN_RUN_STORAGE_SELF_SERVICE_SQL_INTEGRATION") != "1" {
		t.Skip("requires explicit disposable SQL-only integration opt-in")
	}
	parsed, err := url.Parse(os.Getenv("DATABASE_URL"))
	if err != nil || parsed.Hostname() != "127.0.0.1" || parsed.Port() != "15439" || parsed.Path != "/clarin_storage_qa" {
		t.Fatal("requires dedicated loopback disposable clarin_storage_qa database")
	}
	ctx := context.Background()
	config, err := pgxpool.ParseConfig(parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	config.MaxConns = 1
	if os.Getenv("CLARIN_STORAGE_QA_PGLITE") == "1" {
		t.Log("PGlite: real sequential PostgreSQL SQL; no native concurrency or S3 coverage")
		// The pgwire adapter shares a server session across pool reconnects;
		// avoid named prepared statements while preserving PostgreSQL JSONB OIDs.
		config.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeDescribeExec
	}
	db, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err = database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	if err = database.MigrateEventPipelines(db); err != nil {
		t.Fatal(err)
	}

	t.Run("live actor rejects stale permissions elevated claims and revoked membership", func(t *testing.T) {
		f := newStorageSQLFixture(t, db)
		code, data := f.request("GET", "/qa/actor", nil, nil)
		if code != 200 || data["role"] != "member" || data["super_admin"] != false || data["chats"] != true || data["settings"] != true {
			t.Fatalf("live authority not loaded: %d %v", code, data)
		}
		f.exec(`UPDATE roles SET permissions=$2 WHERE id=$1`, f.role, []string{domain.PermSettings})
		code, data = f.request("GET", "/qa/actor", nil, nil)
		if code != 200 || data["chats"] != false || data["settings"] != true {
			t.Fatalf("stale Chats permission survived: %d %v", code, data)
		}
		f.exec(`UPDATE roles SET permissions='{}' WHERE id=$1`, f.role)
		code, _ = f.request("GET", "/storage/activity", nil, nil)
		if code != 403 {
			t.Fatalf("revoked Settings activity status=%d", code)
		}
		f.exec(`DELETE FROM user_accounts WHERE account_id=$1 AND user_id=$2`, f.account, f.user)
		code, _ = f.request("GET", "/qa/actor", nil, nil)
		if code != 403 {
			t.Fatalf("revoked account accepted status=%d", code)
		}
		code, data = f.request("GET", "/qa/actor", nil, map[string]string{"X-QA-Account": "other"})
		if code != 200 || data["account"] != f.other.String() {
			t.Fatalf("independent membership lost: %d %v", code, data)
		}
		code, _ = f.request("GET", "/qa/actor", nil, map[string]string{"X-QA-Account": "other", "X-QA-Claims": "foreign"})
		if code != 403 {
			t.Fatalf("mismatched claims accepted status=%d", code)
		}
	})

	t.Run("real activity handler scopes account actor admin rescue and pages", func(t *testing.T) {
		f := newStorageSQLFixture(t, db)
		own := f.operation(f.account, f.user, "trash", "completed")
		f.operation(f.account, f.secondUser, "trash", "completed")
		rescue := f.operation(f.account, f.secondUser, "purge", "processing")
		f.operation(f.other, f.user, "purge", "processing")
		code, data := f.request("GET", "/storage/activity?limit=1", nil, nil)
		ops := storageQAItems(t, data, "operations")
		if code != 200 || data["total"] != float64(1) || len(ops) != 1 || ops[0]["id"] != own.String() {
			t.Fatalf("member activity scope: %d %v", code, data)
		}
		f.exec(`UPDATE user_accounts SET role='admin' WHERE account_id=$1 AND user_id=$2`, f.account, f.user)
		code, data = f.request("GET", "/storage/activity?limit=1", nil, nil)
		ops = storageQAItems(t, data, "operations")
		if code != 200 || data["total"] != float64(2) || data["has_more"] != true || len(ops) != 1 {
			t.Fatalf("admin rescue scope: %d %v", code, data)
		}
		_, page2 := f.request("GET", "/storage/activity?limit=1&offset=1", nil, nil)
		ops = append(ops, storageQAItems(t, page2, "operations")...)
		seen := map[string]bool{}
		for _, op := range ops {
			seen[op["id"].(string)] = true
			if op["items"] != nil || op["filename"] != nil || op["object_key"] != nil {
				t.Fatal("activity leaks item metadata")
			}
			if op["id"] == rescue.String() && op["can_retry"] != true {
				t.Fatal("durable rescue not retryable")
			}
		}
		if !seen[own.String()] || !seen[rescue.String()] || page2["has_more"] != false {
			t.Fatalf("pagination lost/duplicated operation: %v", seen)
		}
		f.exec(`DELETE FROM users WHERE id=$1`, f.secondUser)
		_, data = f.request("GET", "/storage/activity", nil, nil)
		if data["total"] != float64(2) {
			t.Fatal("actor deletion erased durable rescue")
		}
	})

	t.Run("every catalog reference query and selected union execute with exact account keys", func(t *testing.T) {
		f := newStorageSQLFixture(t, db)
		file, asset, _ := f.media(f.account, "informe español.pdf")
		other, _, _ := f.media(f.other, "foreign-secret.pdf")
		quick, dynamic, item, link, document, survey, template, contact := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
		raw := mediaProxyURLFromObjectKey(file.ObjectKey)
		encoded := "/api/media/file/" + strings.ReplaceAll(url.PathEscape(file.ObjectKey), "/", "%2F")
		f.exec(`INSERT INTO quick_replies(id,account_id,shortcut,title,body,media_url,items) VALUES($1,$2,$3,'Private quick title','',$4,jsonb_build_array(jsonb_build_object('media_url',$4::text)))`, quick, f.account, quick.String(), encoded)
		f.exec(`INSERT INTO quick_reply_attachments(quick_reply_id,account_id,media_url,media_asset_id) VALUES($1,$2,$3,$4)`, quick, f.account, raw, asset)
		f.exec(`INSERT INTO dynamics(id,account_id,name,slug,config) VALUES($1,$2,'Private dynamic title',$3,jsonb_build_object('overlay_image_url',$4::text))`, dynamic, f.account, dynamic.String(), encoded)
		f.exec(`INSERT INTO dynamic_items(id,dynamic_id,image_url) VALUES($1,$2,$3)`, item, dynamic, raw)
		f.exec(`INSERT INTO dynamic_links(id,dynamic_id,slug,extra_message_media_url) VALUES($1,$2,$3,$4)`, link, dynamic, link.String(), raw)
		f.exec(`INSERT INTO dynamic_link_extra_media(link_id,url) VALUES($1,$2)`, link, raw)
		f.exec(`INSERT INTO dynamic_whatsapp_queue(dynamic_id,account_id,link_id,phone,item_id,image_url) VALUES($1,$2,$3,'test-only',$4,$5)`, dynamic, f.account, link, item, raw)
		f.exec(`INSERT INTO document_templates(id,account_id,name,canvas_json) VALUES($1,$2,'SQL document',jsonb_build_object('image',$3::text))`, document, f.account, raw)
		f.exec(`INSERT INTO surveys(id,account_id,name,slug,branding) VALUES($1,$2,'SQL survey',$3,jsonb_build_object('logo_url',$4::text))`, survey, f.account, survey.String(), raw)
		f.exec(`INSERT INTO survey_templates(id,account_id,name,branding) VALUES($1,$2,'SQL template',jsonb_build_object('logo_url',$3::text))`, template, f.account, raw)
		f.exec(`INSERT INTO survey_branding_asset_refs(account_id,survey_id,slot,media_asset_id) VALUES($1,$2,'logo',$3)`, f.account, survey, asset)
		f.exec(`INSERT INTO contacts(id,account_id,jid,name,avatar_media_asset_id) VALUES($1,$2,$3,'SQL avatar',$4)`, contact, f.account, contact.String(), asset)
		f.exec(`INSERT INTO saved_stickers(account_id,media_url) VALUES($1,$2),($1,$3)`, f.account, raw, raw+".different")
		all, err := storageSelfServiceReferences(ctx, db, f.account)
		if err != nil {
			t.Fatal(err)
		}
		selected, err := storageSelfServiceObjectReferences(ctx, db, f.account, file.ObjectKey)
		if err != nil {
			t.Fatal(err)
		}
		ids := func(refs []storageSelfServiceReference) []string {
			result := []string{}
			for _, ref := range refs {
				result = append(result, ref.Origin+":"+ref.ID)
			}
			sort.Strings(result)
			return result
		}
		if !reflect.DeepEqual(ids(all[file.ObjectKey]), ids(selected)) || len(selected) != 14 {
			t.Fatalf("reference query parity/count: all=%v selected=%v", ids(all[file.ObjectKey]), ids(selected))
		}
		if _, leaked := all[other.ObjectKey]; leaked {
			t.Fatal("foreign account in references")
		}
		foreign, err := storageSelfServiceObjectReferences(ctx, db, f.account, other.ObjectKey)
		if err != nil || len(foreign) != 0 {
			t.Fatalf("known foreign key leaked: %v %v", foreign, err)
		}
		before := storageSelfServiceFingerprint(file, selected)
		f.exec(`INSERT INTO saved_stickers(account_id,media_url) VALUES($1,$2)`, f.account, raw+"?new-reference=1")
		changed, err := storageSelfServiceObjectReferences(ctx, db, f.account, file.ObjectKey)
		if err != nil {
			t.Fatal(err)
		}
		if storageSelfServiceFingerprint(file, changed) == before {
			t.Fatal("new persisted reference did not invalidate fingerprint")
		}
		// This checks the actual reference fingerprint dependency. It does not
		// claim to execute the S3-dependent confirm handler's HTTP 409 path.
	})

	t.Run("untrusted media origins protect deletion without granting visibility", func(t *testing.T) {
		f := newStorageSQLFixture(t, db)
		key := f.account.String() + "/uploads/unknown.pdf"
		f.exec(`INSERT INTO quick_replies(account_id,shortcut,title,body,media_url) VALUES($1,'external','Do not leak title','','https://untrusted.invalid/custom-bucket/'||$2)`, f.account, key)
		refs, err := storageSelfServiceObjectReferences(ctx, db, f.account, key)
		if err != nil {
			t.Fatal(err)
		}
		if len(refs) != 1 || refs[0].Origin != "private_external" || refs[0].Label != "" || refs[0].Href != "" || refs[0].Filename != "" {
			t.Fatalf("external origin classification: %+v", refs)
		}
		if storageSelfServiceCanRead(&service.JWTClaims{Role: "admin"}, refs) {
			t.Fatal("external URL gave admin content access")
		}
	})

	t.Run("trash rollback commit backup fidelity and foreign message protection", func(t *testing.T) {
		f := newStorageSQLFixture(t, db)
		file, asset, message := f.media(f.account, "history.pdf")
		foreign, _, foreignMessage := f.media(f.other, "other.pdf")
		trash := func(tx pgx.Tx) error { return f.server.storageSelfServiceTrash(ctx, tx, f.account, f.user, file) }
		if err := f.tx(trash, false); err != nil {
			t.Fatal(err)
		}
		if f.count(`SELECT COUNT(*) FROM storage_media_trash WHERE account_id=$1`, f.account) != 0 || f.count(`SELECT COUNT(*) FROM messages WHERE id=$1 AND media_url IS NOT NULL AND NOT media_deleted`, message) != 1 {
			t.Fatal("rollback left ledger or detached message")
		}
		if err := f.tx(trash, true); err != nil {
			t.Fatal(err)
		}
		var backups []byte
		var state string
		var retained int64
		var seconds float64
		if err := db.QueryRow(ctx, `SELECT message_backups,state,size_bytes,EXTRACT(EPOCH FROM purge_after-removed_at) FROM storage_media_trash WHERE account_id=$1 AND object_key=$2`, f.account, file.ObjectKey).Scan(&backups, &state, &retained, &seconds); err != nil {
			t.Fatal(err)
		}
		var parsed []storageMessageBackup
		if err := json.Unmarshal(backups, &parsed); err != nil {
			t.Fatal(err)
		}
		if state != "trash" || retained != 42 || seconds < 604799 || seconds > 604801 || len(parsed) != 1 || parsed[0].ID != message || parsed[0].AssetID == nil || *parsed[0].AssetID != asset || parsed[0].URL == nil || *parsed[0].URL != mediaProxyURLFromObjectKey(file.ObjectKey) || parsed[0].Size == nil || *parsed[0].Size != 42 {
			t.Fatalf("invalid recovery ledger: %s %s %d %f", backups, state, retained, seconds)
		}
		if f.count(`SELECT COUNT(*) FROM messages WHERE id=$1 AND body='Message history must survive' AND media_deleted AND media_url IS NULL AND media_asset_id IS NULL AND media_size IS NULL`, message) != 1 {
			t.Fatal("trash did not preserve message text while detaching media")
		}
		if f.count(`SELECT COUNT(*) FROM media_assets WHERE id=$1 AND status='active'`, asset) != 1 {
			t.Fatal("reversible trash retired media asset")
		}
		if f.count(`SELECT COUNT(*) FROM messages WHERE id=$1 AND NOT media_deleted AND media_url=$2`, foreignMessage, mediaProxyURLFromObjectKey(foreign.ObjectKey)) != 1 {
			t.Fatal("other account changed")
		}
		if err := f.tx(trash, true); err == nil {
			t.Fatal("stale message list accepted twice")
		}
		if err := f.tx(func(tx pgx.Tx) error { return f.server.storageSelfServiceTrash(ctx, tx, f.account, f.user, foreign) }, true); err == nil {
			t.Fatal("known foreign message IDs accepted")
		}
	})

	t.Run("shared references and missing messages reject trash without partial writes", func(t *testing.T) {
		f := newStorageSQLFixture(t, db)
		file, _, message := f.media(f.account, "shared.pdf")
		file.refs = append(file.refs, storageSelfServiceReference{Origin: "quick_replies", ID: uuid.NewString()})
		if err := f.tx(func(tx pgx.Tx) error { return f.server.storageSelfServiceTrash(ctx, tx, f.account, f.user, file) }, true); err == nil {
			t.Fatal("shared file removed")
		}
		file.refs = []storageSelfServiceReference{{Origin: "chats", ID: message.String()}, {Origin: "chats", ID: uuid.NewString()}}
		if err := f.tx(func(tx pgx.Tx) error { return f.server.storageSelfServiceTrash(ctx, tx, f.account, f.user, file) }, true); err == nil {
			t.Fatal("stale reference count accepted")
		}
		if f.count(`SELECT COUNT(*) FROM storage_media_trash WHERE account_id=$1`, f.account) != 0 || f.count(`SELECT COUNT(*) FROM messages WHERE id=$1 AND NOT media_deleted`, message) != 1 {
			t.Fatal("failed trash changed persistent state")
		}
	})

	t.Run("purge staging enforces retention new references rollback and tombstone", func(t *testing.T) {
		f := newStorageSQLFixture(t, db)
		file, asset, _ := f.media(f.account, "retention.pdf")
		if err := f.tx(func(tx pgx.Tx) error { return f.server.storageSelfServiceTrash(ctx, tx, f.account, f.user, file) }, true); err != nil {
			t.Fatal(err)
		}
		stage := func(tx pgx.Tx) error {
			return f.server.storageSelfServiceStagePurge(ctx, tx, f.account, file.ObjectKey)
		}
		if err := f.tx(stage, true); err == nil {
			t.Fatal("seven day retention bypassed")
		}
		f.exec(`UPDATE storage_media_trash SET purge_after=NOW()-INTERVAL '1 second' WHERE account_id=$1 AND object_key=$2`, f.account, file.ObjectKey)
		sticker := uuid.New()
		f.exec(`INSERT INTO saved_stickers(id,account_id,media_url) VALUES($1,$2,$3)`, sticker, f.account, mediaProxyURLFromObjectKey(file.ObjectKey))
		if err := f.tx(stage, true); err == nil {
			t.Fatal("new persisted reference did not prevent purge staging")
		}
		f.exec(`DELETE FROM saved_stickers WHERE id=$1`, sticker)
		if err := f.tx(func(tx pgx.Tx) error { return f.server.storageSelfServiceStagePurge(ctx, tx, f.other, file.ObjectKey) }, true); err == nil {
			t.Fatal("foreign account staged purge")
		}
		if err := f.tx(stage, false); err != nil {
			t.Fatal(err)
		}
		if f.count(`SELECT COUNT(*) FROM media_assets WHERE id=$1 AND status='active'`, asset) != 1 || f.count(`SELECT COUNT(*) FROM storage_media_trash WHERE account_id=$1 AND state='trash'`, f.account) != 1 {
			t.Fatal("rollback did not restore staged SQL state")
		}
		if err := f.tx(stage, true); err != nil {
			t.Fatal(err)
		}
		if f.count(`SELECT COUNT(*) FROM media_assets WHERE id=$1 AND status='deleting'`, asset) != 1 || f.count(`SELECT COUNT(*) FROM storage_media_trash WHERE account_id=$1 AND state='purging'`, f.account) != 1 || f.count(`SELECT COUNT(*) FROM storage_objects WHERE account_id=$1 AND object_key=$2 AND status='storage_purging'`, f.account, file.ObjectKey) != 1 {
			t.Fatal("durable staging state inconsistent")
		}
		guardErr := f.tx(func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `INSERT INTO saved_stickers(account_id,media_url) VALUES($1,$2)`, f.account, mediaProxyURLFromObjectKey(file.ObjectKey))
			return err
		}, false)
		var pgErr *pgconn.PgError
		if !errors.As(guardErr, &pgErr) || pgErr.Code != "23514" {
			t.Fatalf("purging object not rejected by reference constraint: %v", guardErr)
		}
		if err := f.tx(stage, true); err != nil {
			t.Fatalf("durable staging retry failed: %v", err)
		}
	})

	t.Run("message reconciliation scans complete batches and excludes foreign backup ids", func(t *testing.T) {
		f := newStorageSQLFixture(t, db)
		file, _, message := f.media(f.account, "many.pdf")
		foreign, _, foreignMessage := f.media(f.other, "foreign.pdf")
		var chat, foreignChat uuid.UUID
		if err := db.QueryRow(ctx, `SELECT chat_id FROM messages WHERE id=$1`, message).Scan(&chat); err != nil {
			t.Fatal(err)
		}
		if err := db.QueryRow(ctx, `SELECT chat_id FROM messages WHERE id=$1`, foreignMessage).Scan(&foreignChat); err != nil {
			t.Fatal(err)
		}
		f.exec(`INSERT INTO messages(id,account_id,chat_id,message_id,body,message_type,timestamp,media_deleted) SELECT gen_random_uuid(),$1,$2,gen_random_uuid()::text,'Message history must survive','document',NOW(),true FROM generate_series(1,204)`, f.account, chat)
		f.exec(`INSERT INTO storage_media_trash(account_id,object_key,actor_id,filename,media_type,size_bytes,message_backups,purge_after) SELECT $1,$2,$3,'many.pdf','document',42,jsonb_agg(jsonb_build_object('id',id,'chat_id',chat_id)),NOW()+INTERVAL '7 days' FROM messages WHERE account_id=$1`, f.account, file.ObjectKey, f.user)
		foreignBackup, _ := json.Marshal([]map[string]string{{"id": foreignMessage.String(), "chat_id": foreignChat.String()}})
		f.exec(`UPDATE storage_media_trash SET message_backups=message_backups||$3::jsonb WHERE account_id=$1 AND object_key=$2`, f.account, file.ObjectKey, foreignBackup)
		seen := map[uuid.UUID]bool{}
		after := uuid.Nil
		pageSizes := []int{}
		for {
			messages, err := f.server.repos.Message.ListStorageCleanupMessages(ctx, f.account, []string{file.ObjectKey, foreign.ObjectKey}, after)
			if err != nil {
				t.Fatal(err)
			}
			pageSizes = append(pageSizes, len(messages))
			for _, got := range messages {
				if got.AccountID != f.account || got.ChatID != chat || got.Body == nil || *got.Body != "Message history must survive" || seen[got.ID] || got.ID == foreignMessage {
					t.Fatalf("incomplete/foreign/duplicate canonical message: %+v", got)
				}
				seen[got.ID] = true
				after = got.ID
			}
			if len(messages) < 200 {
				break
			}
		}
		if len(seen) != 205 || !reflect.DeepEqual(pageSizes, []int{200, 5}) {
			t.Fatalf("reconciliation pagination %d %v", len(seen), pageSizes)
		}
		outside, err := f.server.repos.Message.ListStorageCleanupMessages(ctx, f.other, []string{file.ObjectKey}, uuid.Nil)
		if err != nil || len(outside) != 0 {
			t.Fatalf("foreign ledger leaked: %v %v", outside, err)
		}
	})

	t.Run("public publication SQL revokes replaced closed and foreign resources", func(t *testing.T) {
		f := newStorageSQLFixture(t, db)
		file, _, _ := f.media(f.account, "published.pdf")
		survey := uuid.New()
		raw := mediaProxyURLFromObjectKey(file.ObjectKey)
		f.exec(`INSERT INTO surveys(id,account_id,name,slug,status,branding) VALUES($1,$2,'SQL public survey',$3,'active',jsonb_build_object('logo_url',$4::text))`, survey, f.account, survey.String(), raw)
		grant := &mediaAccessGrant{Purpose: "survey-branding", AccountID: f.account, ResourceID: survey, ObjectKey: file.ObjectKey}
		if !f.server.publicMediaGrantCurrent(ctx, grant) {
			t.Fatal("active canonical survey publication rejected")
		}
		grant.AccountID = f.other
		if f.server.publicMediaGrantCurrent(ctx, grant) {
			t.Fatal("foreign resource publication accepted")
		}
		grant.AccountID = f.account
		f.exec(`UPDATE surveys SET branding='{}' WHERE id=$1`, survey)
		if f.server.publicMediaGrantCurrent(ctx, grant) {
			t.Fatal("removed branding grant survived")
		}
		f.exec(`UPDATE surveys SET branding=jsonb_build_object('logo_url',$2::text),status='closed' WHERE id=$1`, survey, raw)
		if f.server.publicMediaGrantCurrent(ctx, grant) {
			t.Fatal("closed survey grant survived")
		}
		dynamic, item := uuid.New(), uuid.New()
		f.exec(`INSERT INTO dynamics(id,account_id,name,slug,is_active) VALUES($1,$2,'SQL public dynamic',$3,true)`, dynamic, f.account, dynamic.String())
		f.exec(`INSERT INTO dynamic_items(id,dynamic_id,image_url,is_active) VALUES($1,$2,$3,true)`, item, dynamic, raw)
		grant = &mediaAccessGrant{Purpose: "dynamic-public", AccountID: f.account, ResourceID: dynamic, ObjectKey: file.ObjectKey}
		if !f.server.publicMediaGrantCurrent(ctx, grant) {
			t.Fatal("active dynamic item grant rejected")
		}
		f.exec(`UPDATE dynamic_items SET is_active=false WHERE id=$1`, item)
		if f.server.publicMediaGrantCurrent(ctx, grant) {
			t.Fatal("deactivated item grant survived")
		}
		f.exec(`UPDATE dynamics SET config=jsonb_build_object('overlay_image_url',$2::text) WHERE id=$1`, dynamic, raw)
		if !f.server.publicMediaGrantCurrent(ctx, grant) {
			t.Fatal("live overlay not authorized")
		}
		f.exec(`UPDATE dynamics SET is_active=false WHERE id=$1`, dynamic)
		if f.server.publicMediaGrantCurrent(ctx, grant) {
			t.Fatal("deactivated dynamic grant survived")
		}
	})

	t.Run("unavailable physical storage fails closed without creating plans or trash", func(t *testing.T) {
		f := newStorageSQLFixture(t, db)
		for _, path := range []string{"/storage/usage", "/storage/files", "/storage/content?object_key=" + f.account.String() + "/uploads/a.pdf"} {
			code, data := f.request("GET", path, nil, nil)
			if code != 503 || data["code"] != "storage_unavailable" {
				t.Fatalf("missing storage GET %s: %d %v", path, code, data)
			}
		}
		for _, path := range []string{"/storage/cleanup/preview", "/storage/cleanup/confirm"} {
			code, data := f.request("POST", path, map[string]any{"action": "trash", "object_keys": []string{f.account.String() + "/uploads/a.pdf"}, "preview_id": uuid.NewString()}, nil)
			if code != 503 || data["code"] != "storage_unavailable" {
				t.Fatalf("missing storage POST %s: %d %v", path, code, data)
			}
		}
		if f.count(`SELECT COUNT(*) FROM storage_cleanup_previews WHERE account_id=$1`, f.account) != 0 || f.count(`SELECT COUNT(*) FROM storage_media_trash WHERE account_id=$1`, f.account) != 0 {
			t.Fatal("unavailable storage produced mutation")
		}
	})
}
