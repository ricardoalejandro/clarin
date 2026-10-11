package api

// Regression acceptance for real-world URL keys, missing bytes and a full
// selection. Reads deliberately bypass storageQAFixture.request: that helper
// drains the index before each GET and cannot expose normal stale-index states.
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
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/service"
)

type storageReportedQueryCounter struct {
	storageSelfServiceQuerier
	references int
}

func (q *storageReportedQueryCounter) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	if strings.Contains(sql, "SELECT 'chats',r.id") {
		q.references++
	}
	return q.storageSelfServiceQuerier.Query(ctx, sql, args...)
}

func storageReportedRequest(t *testing.T, f *storageMultiOriginQAFixture, method, path string, payload any, headers map[string]string) (int, []byte) {
	t.Helper()
	var body []byte
	var err error
	if payload != nil {
		body, err = json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for name, value := range headers {
		req.Header.Set(name, value)
	}
	response, err := f.app.Test(req, 15000)
	if err != nil {
		t.Fatalf("regression request %s failed: %v", method, err)
	}
	defer response.Body.Close()
	body, err = io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, body
}

func storageReportedJSON(t *testing.T, data []byte) map[string]any {
	t.Helper()
	var result map[string]any
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatal("regression endpoint returned non-JSON data")
	}
	return result
}

func storageReportedDrainCycles(t *testing.T, f *storageMultiOriginQAFixture) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	for cycle := 0; cycle < 150; cycle++ {
		pending, err := f.server.storageInventoryCycle(ctx, f.account)
		if err != nil {
			t.Fatal(err)
		}
		if !pending {
			return
		}
	}
	t.Fatal("normal inventory cycles did not finish the bounded fixture")
}

func TestStorageSelfServiceReportedRegressionsIntegration(t *testing.T) {
	db, store := storageMultiOriginQAServices(t)
	ctx := context.Background()
	t.Run("URL-only legacy keys keep spaces Unicode and literal percent identity", func(t *testing.T) {
		f := newStorageMultiOriginQAFixture(t, db, store)
		type object struct {
			key, name string
			data      []byte
			message   uuid.UUID
		}
		var objects []object
		for _, name := range []string{"Plan con espacios.pdf", "Canción de otoño (versión 2).pdf", "literal %20 + signo.pdf", "pregunta ? y fragmento #.pdf", `Notas "A" y apóstrofo '.pdf`, `una "cita" & <foto>.pdf`, "separadores \"línea\" \u2028 y \u2029.pdf"} {
			key, _, message := f.media(f.account, "chats", name, true)
			legacy := (&url.URL{Path: "/api/media/file/" + key}).String()
			if !strings.ContainsAny(name, "%?#") {
				legacy = "/api/media/file/" + key
			}
			if strings.Contains(name, "%20") {
				legacy += "?download=1"
			}
			f.exec(`UPDATE messages SET media_asset_id=NULL,media_url=$3 WHERE account_id=$1 AND id=$2`, f.account, message, legacy)
			data, err := store.GetFile(ctx, key)
			if err != nil {
				t.Fatal(err)
			}
			objects = append(objects, object{key, name, data, message})
			if strings.Contains(name, "%20") {
				// A second decoding pass would address this different object. It
				// exists physically but has no authorized business reference.
				if _, err := store.UploadObject(ctx, strings.ReplaceAll(key, "%20", " "), []byte("Must never substitute these bytes"), "application/pdf"); err != nil {
					t.Fatal(err)
				}
			}
		}
		keys := make([]string, 0, len(objects))
		for _, obj := range objects {
			keys = append(keys, obj.key)
		}
		batch, err := storageSelfServiceReferencesForKeys(ctx, db, f.account, keys, store)
		if err != nil {
			t.Fatalf("legacy batch reference query failed: %v", err)
		}
		for _, obj := range objects {
			refs := batch[obj.key]
			if len(refs) != 1 || refs[0].Origin != "chats" || refs[0].ID != obj.message.String() {
				t.Fatal("legacy batch query did not retain exactly its original message reference")
			}
		}
		storageReportedDrainCycles(t, f)
		code, raw := storageReportedRequest(t, f, "GET", "/storage/files?limit=40", nil, nil)
		if code != 200 {
			t.Fatalf("legacy listing status=%d", code)
		}
		listed := storageQAItems(t, storageReportedJSON(t, raw), "files")
		if len(listed) != len(objects) {
			t.Fatalf("URL-only listing has %d files, want %d", len(listed), len(objects))
		}
		for _, obj := range objects {
			matches := 0
			for _, file := range listed {
				if file["object_key"] == obj.key && file["filename"] == obj.name {
					matches++
				}
			}
			if matches != 1 {
				t.Fatal("legacy key/name identity missing or duplicated in indexed listing")
			}
			if strings.Contains(obj.key, "%20") {
				status, _ := storageReportedRequest(t, f, "GET", "/storage/content?object_key="+url.QueryEscape(strings.ReplaceAll(obj.key, "%20", " ")), nil, nil)
				if status != 404 {
					t.Fatalf("double-decoded neighbouring key became authorized: status=%d", status)
				}
			}
			path := "/storage/content?object_key=" + url.QueryEscape(obj.key)
			status, content := storageReportedRequest(t, f, "GET", path, nil, nil)
			if status != 200 || !bytes.Equal(content, obj.data) {
				t.Fatalf("authorized legacy bytes differ: status=%d", status)
			}
			status, raw = storageReportedRequest(t, f, "GET", "/storage/uses?object_key="+url.QueryEscape(obj.key), nil, nil)
			if status != 200 {
				t.Fatalf("URL-only uses status=%d", status)
			}
			uses := storageQAItems(t, storageReportedJSON(t, raw), "uses")
			if len(uses) != 1 || uses[0]["can_remove"] != true {
				t.Fatal("URL-only message was not represented as one authorized use")
			}
			status, raw = storageReportedRequest(t, f, "GET", path, nil, map[string]string{"X-QA-Account": "other"})
			if status != 404 || bytes.Contains(raw, []byte(obj.name)) {
				t.Fatalf("foreign account learned legacy media: status=%d", status)
			}
		}
	})
	t.Run("physical absence before reconciliation is an error without changing business history", func(t *testing.T) {
		f := newStorageMultiOriginQAFixture(t, db, store)
		key, _, message := f.media(f.account, "chats", "missing-after-index.pdf", true)
		present, _, presentMessage := f.media(f.account, "chats", "still-present.pdf", true)
		storageReportedDrainCycles(t, f)
		if err := store.DeleteFile(ctx, key); err != nil {
			t.Fatal(err)
		}
		// No reconciliation between removal of bytes and the requests below.
		for attempt := 0; attempt < 2; attempt++ {
			status, raw := storageReportedRequest(t, f, "GET", "/storage/content?object_key="+url.QueryEscape(key), nil, nil)
			if status != 404 {
				t.Fatalf("confirmed missing bytes status=%d, want 404", status)
			}
			if storageReportedJSON(t, raw)["error"] == "" {
				t.Fatal("missing bytes did not explain the unavailable content")
			}
		}
		status, raw := storageReportedRequest(t, f, "POST", "/storage/cleanup/preview", map[string]any{"action": "trash", "targets": []map[string]any{{"object_key": key, "mode": "file"}, {"object_key": present, "mode": "file"}}}, nil)
		result := storageReportedJSON(t, raw)
		if status != 200 || result["eligible_count"] != float64(1) || result["estimated_freed_bytes"] != float64(0) {
			t.Fatalf("mixed missing/present review status=%d eligible=%v", status, result["eligible_count"])
		}
		items := storageQAItems(t, result, "items")
		if len(items) != 2 {
			t.Fatal("missing-object review lost part of the selection")
		}
		for _, item := range items {
			if item["object_key"] == key && (item["eligible"] != false || item["size_bytes"] != float64(0) || item["reason"] == "") {
				t.Fatal("missing object was not explicitly blocked with zero physical bytes")
			}
			if item["object_key"] == present && item["eligible"] != true {
				t.Fatal("available file was incorrectly blocked by another missing object")
			}
		}
		f.expectMessage(message, false)
		f.expectMessage(presentMessage, false)
		var removed int
		if err := db.QueryRow(ctx, `SELECT count(*) FROM storage_removed_references WHERE account_id=$1`, f.account).Scan(&removed); err != nil || removed != 0 {
			t.Fatalf("failed review altered recovery ledger: count=%d err=%v", removed, err)
		}
		f.expectObject(key, false)
	})
	t.Run("missing recovery bytes block restore and purge without consuming history", func(t *testing.T) {
		f := newStorageMultiOriginQAFixture(t, db, store)
		key, _, message := f.media(f.account, "chats", "missing-recovery.pdf", true)
		use := storageQAUseOfType(t, f.uses(key, nil), "chats")["use_id"].(string)
		f.confirmUse(f.previewUses(key, use))
		id := f.recoveryID(key, use)
		// Make purge otherwise eligible without waiting seven wall-clock days.
		// The missing-byte review must preserve both this recovery and its marker.
		f.exec(`UPDATE storage_removed_references SET removed_at=NOW()-INTERVAL '9 days',retain_until=NOW()-INTERVAL '1 day' WHERE account_id=$1 AND id=$2`, f.account, id)
		f.exec(`UPDATE storage_media_trash SET removed_at=NOW()-INTERVAL '9 days',purge_after=NOW()-INTERVAL '1 day' WHERE account_id=$1 AND object_key=$2`, f.account, key)
		var beforeRecovery, beforeMarker string
		if err := db.QueryRow(ctx, `SELECT to_jsonb(r)::text FROM storage_removed_references r WHERE account_id=$1 AND id=$2`, f.account, id).Scan(&beforeRecovery); err != nil {
			t.Fatal(err)
		}
		if err := db.QueryRow(ctx, `SELECT to_jsonb(t)::text FROM storage_media_trash t WHERE account_id=$1 AND object_key=$2`, f.account, key).Scan(&beforeMarker); err != nil {
			t.Fatal(err)
		}
		if err := store.DeleteFile(ctx, key); err != nil {
			t.Fatal(err)
		}
		// No inventory reconciliation after externally losing the physical object.
		for _, action := range []string{"restore", "purge"} {
			status, raw := storageReportedRequest(t, f, "POST", "/storage/cleanup/preview", map[string]any{"action": action, "recovery_ids": []string{id}}, nil)
			result := storageReportedJSON(t, raw)
			if status != 200 || result["eligible_count"] != float64(0) || result["estimated_bytes"] != float64(0) || result["estimated_freed_bytes"] != float64(0) {
				t.Fatalf("missing recovery %s review status=%d eligible=%v", action, status, result["eligible_count"])
			}
			items := storageQAItems(t, result, "items")
			if len(items) != 1 || items[0]["recovery_id"] != id || items[0]["eligible"] != false || items[0]["size_bytes"] != float64(0) {
				t.Fatalf("missing recovery %s was not retained as one blocked zero-byte item", action)
			}
			if reason, ok := items[0]["reason"].(string); !ok || reason == "" {
				t.Fatalf("missing recovery %s did not explain why it is blocked", action)
			}
			var recovery, marker string
			if err := db.QueryRow(ctx, `SELECT to_jsonb(r)::text FROM storage_removed_references r WHERE account_id=$1 AND id=$2`, f.account, id).Scan(&recovery); err != nil {
				t.Fatal(err)
			}
			if err := db.QueryRow(ctx, `SELECT to_jsonb(t)::text FROM storage_media_trash t WHERE account_id=$1 AND object_key=$2`, f.account, key).Scan(&marker); err != nil {
				t.Fatal(err)
			}
			if recovery != beforeRecovery || marker != beforeMarker {
				t.Fatalf("missing recovery %s changed stored history or retention", action)
			}
			f.expectMessage(message, true)
			f.expectObject(key, false)
		}
	})
	t.Run("provider inspection failure is unavailable rather than false absence", func(t *testing.T) {
		f := newStorageMultiOriginQAFixture(t, db, store)
		key, _, message := f.media(f.account, "chats", "provider-failure.pdf", true)
		_, faulty := storageQAProxy(t, func(proxy *httputil.ReverseProxy) {
			proxy.ModifyResponse = func(response *http.Response) error {
				if response.Request.Method != http.MethodHead || !strings.HasSuffix(response.Request.URL.Path, "/"+key) {
					return nil
				}
				_ = response.Body.Close()
				body := `<Error><Code>AccessDenied</Code><Message>Synthetic provider inspection failure</Message></Error>`
				response.StatusCode = http.StatusForbidden
				response.Status = "403 Forbidden"
				response.Body = io.NopCloser(strings.NewReader(body))
				response.ContentLength = int64(len(body))
				response.Header.Set("Content-Type", "application/xml")
				response.Header.Set("Content-Length", fmt.Sprint(len(body)))
				return nil
			}
		})
		f.server.storage = faulty
		status, _ := storageReportedRequest(t, f, "GET", "/storage/content?object_key="+url.QueryEscape(key), nil, nil)
		if status != 503 {
			t.Fatalf("provider error reported as status=%d, want 503", status)
		}
		f.expectMessage(message, false)
		f.expectObject(key, true)
	})
	t.Run("forty selected files review amid unrelated text invalidation without mutation", func(t *testing.T) {
		f := newStorageMultiOriginQAFixture(t, db, store)
		var targets []map[string]any
		var typedTargets []storageUseTarget
		var messages []uuid.UUID
		for index := 0; index < 40; index++ {
			key, _, message := f.media(f.account, "chats", fmt.Sprintf("Batch review %02d.pdf", index+1), true)
			targets = append(targets, map[string]any{"object_key": key, "mode": "file"})
			typedTargets = append(typedTargets, storageUseTarget{ObjectKey: key, Mode: "file"})
			messages = append(messages, message)
		}
		_, _, unselected := f.media(f.account, "chats", "Unselected conversation document.pdf", true)
		f.exec(`INSERT INTO messages(account_id,chat_id,message_id,body,message_type,timestamp)
 SELECT $1,m.chat_id,'reported-text-'||g::text,'Unrelated synthetic text','text',NOW()
 FROM messages m CROSS JOIN generate_series(1,10000) g WHERE m.account_id=$1 AND m.id=$2`, f.account, messages[0])
		code, raw := storageReportedRequest(t, f, "GET", "/storage/files?limit=40", nil, nil)
		if code != 200 || storageReportedJSON(t, raw)["catalog_status"] != "indexing" {
			t.Fatalf("unbuilt inventory falsely ready: status=%d", code)
		}
		storageReportedDrainCycles(t, f)
		code, raw = storageReportedRequest(t, f, "GET", "/storage/files?limit=40", nil, nil)
		listing := storageReportedJSON(t, raw)
		if code != 200 || listing["catalog_status"] != "ready" || len(storageQAItems(t, listing, "files")) != 40 {
			t.Fatalf("normal index cycles did not expose the full page: status=%d", code)
		}
		f.exec(`UPDATE chats SET name='Unselected conversation changed' WHERE account_id=$1 AND id=(SELECT chat_id FROM messages WHERE account_id=$1 AND id=$2)`, f.account, unselected)
		code, raw = storageReportedRequest(t, f, "GET", "/storage/usage", nil, nil)
		if code != 200 || storageReportedJSON(t, raw)["catalog_status"] != "indexing" {
			t.Fatal("unselected source edit did not create the intended stale-index condition")
		}
		counter := &storageReportedQueryCounter{storageSelfServiceQuerier: db}
		actor := storageUseActor{AccountID: f.account, UserID: f.user, Claims: &service.JWTClaims{AccountID: f.account, UserID: f.user, Role: "member", Permissions: []string{domain.PermSettings, domain.PermChats}}}
		built, err := f.server.storageBuildUseSelection(ctx, counter, actor, storageUseSelection{Version: 1, Action: "trash", Targets: typedTargets})
		if err != nil || len(built.Items) != 40 || counter.references != 1 {
			t.Fatalf("40-file review did not use one physical-reference query: items=%d queries=%d err=%v", len(built.Items), counter.references, err)
		}
		started := time.Now()
		code, raw = storageReportedRequest(t, f, "POST", "/storage/cleanup/preview", map[string]any{"action": "trash", "targets": targets}, nil)
		result := storageReportedJSON(t, raw)
		t.Logf("STORAGE_REPORTED_REVIEW selected=40 unrelated_text=10000 duration_ms=%.3f status=%d", float64(time.Since(started).Microseconds())/1000, code)
		if code != 200 || result["eligible_count"] != float64(40) {
			t.Fatalf("unchanged live selection rejected after text-only invalidation: status=%d code=%v eligible=%v", code, result["code"], result["eligible_count"])
		}
		for _, message := range messages {
			f.expectMessage(message, false)
		}
		var removed int
		if err := db.QueryRow(ctx, `SELECT count(*) FROM storage_removed_references WHERE account_id=$1`, f.account).Scan(&removed); err != nil || removed != 0 {
			t.Fatalf("review mutated recoveries: count=%d err=%v", removed, err)
		}
		// An actual attachment change must still reject the prepared operation.
		f.exec(`UPDATE messages SET media_url=NULL,media_asset_id=NULL WHERE account_id=$1 AND id=$2`, f.account, messages[0])
		code, _ = storageReportedRequest(t, f, "POST", "/storage/cleanup/confirm", map[string]any{"preview_id": result["preview_id"]}, nil)
		if code != 409 {
			t.Fatalf("real attachment change did not invalidate review: status=%d", code)
		}
		for _, message := range messages[1:] {
			f.expectMessage(message, false)
		}
	})
}
