package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/storage"
)

// Exercise observable SQL/HTTP behavior around the page boundary. Equal sizes
// and dates make an unstable ordering visible; hidden references must neither
// rename a row nor enter its search results, even when that row is shared.
func runStorageInventoryQueryRegressionChecks(t *testing.T, db *pgxpool.Pool, store *storage.Storage) {
	t.Run("inventory unrelated dirty source preserves review but live preview rejects new shared use", func(t *testing.T) {
		f := newStorageQAFixture(t, db, store)
		stableKey, _, _ := f.media(f.account, "chats", "Stable selection.pdf", true)
		_, _, otherMessage := f.media(f.account, "chats", "Unrelated.pdf", true)
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		if err := f.server.ReconcileStorageInventory(ctx, f.account); err != nil {
			t.Fatal(err)
		}
		f.exec(`UPDATE messages SET media_filename='Unrelated changed.pdf' WHERE account_id=$1 AND id=$2`, f.account, otherMessage)
		page := storageInventoryRawGET(t, f, "/storage/files")
		files := storageQAItems(t, page, "files")
		if page["catalog_status"] != "indexing" || len(files) != 1 || files[0]["object_key"] != stableKey || files[0]["can_remove"] != true {
			t.Fatalf("unrelated source invalidated stable review capability: %v", page)
		}
		// A new, not-yet-indexed protected use must still be caught by the live
		// impact review. A list capability never authorizes a destructive write.
		config, _ := json.Marshal(map[string]string{"overlay_image_url": mediaProxyURLFromObjectKey(stableKey)})
		f.exec(`INSERT INTO dynamics(account_id,name,slug,config) VALUES($1,'New protected use',$2,$3::jsonb)`, f.account, "new-use-"+f.account.String(), config)
		if plan := f.preview("trash", stableKey); plan["eligible_count"] != float64(0) {
			t.Fatalf("live review trusted an incomplete projection: %v", plan)
		}
		f.exec(`UPDATE roles SET permissions=$2 WHERE id=$1`, f.role, []string{domain.PermSettings})
		if page := storageInventoryRawGET(t, f, "/storage/files"); page["total"] != float64(0) {
			t.Fatalf("revocation retained review capability: %v", page)
		}
	})
	t.Run("inventory pagination and summary preserve authorized projection", func(t *testing.T) {
		f := newStorageQAFixture(t, db, store)
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		const chatCount = 45
		type expectedFile struct {
			key, filename string
			shared, own   bool
		}
		active := make([]expectedFile, 0, chatCount+1)
		var sharedKey string
		for i := 0; i < chatCount; i++ {
			filename := fmt.Sprintf("Page-%02d.pdf", i)
			key, asset, message := f.media(f.account, "chats", filename, true)
			if i == 0 {
				sharedKey = key
				f.exec(`UPDATE media_assets SET filename='global-private-only.pdf' WHERE account_id=$1 AND id=$2`, f.account, asset)
			}
			if i == 2 {
				f.exec(`UPDATE chats SET name='Visible search context' WHERE account_id=$1 AND id=(SELECT chat_id FROM messages WHERE account_id=$1 AND id=$2)`, f.account, message)
			}
			if i == chatCount-1 {
				f.exec(`UPDATE media_assets SET filename='global-private-only.pdf' WHERE account_id=$1 AND id=$2`, f.account, asset)
				f.exec(`UPDATE messages SET media_filename='' WHERE account_id=$1 AND id=$2`, f.account, message)
				filename = "Documento"
			}
			active = append(active, expectedFile{key: key, filename: filename, shared: i == 0})
		}
		hiddenKey, _, _ := f.media(f.account, "uploads", "only-dynamics-name.pdf", false)
		for i, key := range []string{sharedKey, hiddenKey} {
			config, err := json.Marshal(map[string]string{"overlay_image_url": mediaProxyURLFromObjectKey(key)})
			if err != nil {
				t.Fatal(err)
			}
			f.exec(`INSERT INTO dynamics(account_id,name,slug,config) VALUES($1,'Hidden dynamics context',$2,$3::jsonb)`, f.account, fmt.Sprintf("query-regression-%s-%d", f.account, i), config)
		}
		ownKey, ownAsset, _ := f.media(f.account, "uploads", "global-upload-name.pdf", false)
		if err := f.server.recordStorageUpload(ctx, f.account, f.user, &domain.MediaAsset{ID: ownAsset, AccountID: f.account, ObjectKey: ownKey}, true, "Own aged.pdf"); err != nil {
			t.Fatal(err)
		}
		f.exec(`UPDATE storage_upload_ownership SET first_uploaded_at=NOW()-INTERVAL '2 days',last_uploaded_at=NOW()-INTERVAL '2 days' WHERE account_id=$1 AND object_key=$2 AND actor_id=$3`, f.account, ownKey, f.user)
		active = append(active, expectedFile{key: ownKey, filename: "Own aged.pdf", own: true})
		trashKey, _, _ := f.media(f.account, "chats", "Retained trash.pdf", true)
		f.confirm(f.preview("trash", trashKey))
		f.exec(`UPDATE storage_media_trash SET removed_at=NOW()-INTERVAL '9 days',purge_after=NOW()-INTERVAL '1 day' WHERE account_id=$1 AND object_key=$2`, f.account, trashKey)
		foreignKey, _, _ := f.media(f.other, "chats", "Foreign account.pdf", true)
		if err := f.server.ReconcileStorageInventory(ctx, f.account); err != nil {
			t.Fatal(err)
		}
		// The physical size remains the value verified by MinIO. Only the
		// synthetic catalog timestamp is fixed to exercise exact date ties and
		// the 180-day recommendation without depending on wall-clock uploads.
		modified := time.Now().UTC().Add(-200 * 24 * time.Hour).Truncate(time.Second)
		f.exec(`UPDATE storage_inventory_objects SET last_modified=$2 WHERE account_id=$1`, f.account, modified)
		object, err := store.GetFileInfo(ctx, active[0].key)
		if err != nil {
			t.Fatal(err)
		}
		objectBytes := float64(object.Size)
		var physicalCount, equalSizeCount int
		if err := db.QueryRow(ctx, `SELECT count(*),count(*) FILTER(WHERE size_bytes=$2) FROM storage_inventory_objects WHERE account_id=$1 AND presence='present'`, f.account, object.Size).Scan(&physicalCount, &equalSizeCount); err != nil || physicalCount != chatCount+3 || equalSizeCount != physicalCount {
			t.Fatalf("tied-size fixture mismatch: physical=%d equal=%d error=%v", physicalCount, equalSizeCount, err)
		}
		permissions := func(values ...string) {
			t.Helper()
			f.exec(`UPDATE roles SET permissions=$2 WHERE id=$1`, f.role, values)
		}
		get := func(query url.Values) (map[string]any, []map[string]any) {
			t.Helper()
			page := storageInventoryRawGET(t, f, "/storage/files?"+query.Encode())
			if page["catalog_status"] != "ready" || page["inventory_complete"] != true {
				t.Fatalf("fixture did not remain completely indexed: %v", page)
			}
			return page, storageQAItems(t, page, "files")
		}
		assertPage := func(query url.Values, wantTotal, wantLength int) []map[string]any {
			t.Helper()
			page, files := get(query)
			if page["total"] != float64(wantTotal) || len(files) != wantLength {
				t.Fatalf("page %s total=%v length=%d want=%d/%d", query.Encode(), page["total"], len(files), wantTotal, wantLength)
			}
			return files
		}
		assertMetadata := func(file map[string]any, want expectedFile) {
			t.Helper()
			references := float64(1)
			if want.own {
				references = 0
			}
			for field, value := range map[string]any{
				"object_key": want.key, "filename": want.filename, "size_bytes": objectBytes,
				"references_count": references, "status": "active", "retained_elsewhere": want.shared,
				"can_remove": !want.shared, "can_remove_uses": true, "is_own_upload": want.own,
			} {
				if file[field] != value {
					t.Fatalf("page projection %s=%v want=%v for %s", field, file[field], value, want.filename)
				}
			}
			encoded, err := json.Marshal(map[string]any{"filename": file["filename"], "origins": file["origins"]})
			if err != nil {
				t.Fatal(err)
			}
			for _, hidden := range []string{"Hidden dynamics context", "global-private-only", "global-upload-name", hiddenKey, foreignKey} {
				if strings.Contains(string(encoded), hidden) {
					t.Fatalf("page disclosed hidden metadata %q", hidden)
				}
			}
		}
		for _, column := range []string{"size", "date", "name"} {
			for _, direction := range []string{"asc", "desc"} {
				{
					ordered := append([]expectedFile(nil), active...)
					sort.Slice(ordered, func(i, j int) bool {
						if column == "name" && strings.ToLower(ordered[i].filename) != strings.ToLower(ordered[j].filename) {
							less := strings.ToLower(ordered[i].filename) < strings.ToLower(ordered[j].filename)
							if direction == "desc" {
								return !less
							}
							return less
						}
						return ordered[i].key < ordered[j].key
					})
					seen := map[string]bool{}
					for offset := 0; offset < len(ordered); offset += 17 {
						query := url.Values{"sort": {column}, "order": {direction}, "limit": {"17"}, "offset": {fmt.Sprint(offset)}}
						files := assertPage(query, len(ordered), min(17, len(ordered)-offset))
						for i, file := range files {
							assertMetadata(file, ordered[offset+i])
							key := file["object_key"].(string)
							if seen[key] {
								t.Fatalf("object repeated across adjacent pages: %s", key)
							}
							seen[key] = true
						}
					}
					if len(seen) != len(active) {
						t.Fatal("union of pages omitted an authorized object")
					}
					assertPage(url.Values{"sort": {column}, "order": {direction}, "limit": {"17"}, "offset": {"70"}}, len(active), 0)
				}
			}
		}
		assertPage(url.Values{"limit": {"40"}}, len(active), 40)
		assertPage(url.Values{"q": {"page-0"}, "limit": {"100"}}, 10, 10)
		assertPage(url.Values{"q": {"Visible search context"}}, 1, 1)
		for _, query := range []string{"Hidden dynamics context", "global-private-only", "global-upload-name", "only-dynamics-name"} {
			assertPage(url.Values{"q": {query}}, 0, 0)
		}
		assertPage(url.Values{"origin": {"dynamics"}}, 0, 0)
		assertPage(url.Values{"origin": {"own_uploads"}}, 1, 1)
		assertPage(url.Values{"status": {"unused_uploads"}}, 1, 1)
		assertPage(url.Values{"status": {"protected"}}, 1, 1)
		assertPage(url.Values{"status": {"removable"}, "limit": {"100"}}, chatCount, chatCount)
		assertPage(url.Values{"type": {"image"}}, 0, 0)
		assertPage(url.Values{"min_size": {fmt.Sprint(object.Size + 1)}}, 0, 0)
		assertPage(url.Values{"older_than_days": {"180"}, "limit": {"100"}}, len(active), len(active))
		trash := assertPage(url.Values{"status": {"trash_ready"}}, 1, 1)
		if trash[0]["object_key"] != trashKey || trash[0]["can_restore"] != true || trash[0]["can_purge"] != true || trash[0]["recovery_id"] == "" {
			t.Fatalf("page projection lost recoverable trash capabilities: %v", trash)
		}
		assertUsage := func(dynamicsVisible, canManage bool) {
			t.Helper()
			visibleObjects, activeObjects := chatCount+2, chatCount+1
			if dynamicsVisible {
				visibleObjects++
				activeObjects++
			}
			removable := chatCount
			if !canManage {
				removable = 0
			}
			usage := storageInventoryRawGET(t, f, "/storage/usage")
			for field, want := range map[string]any{
				"scope": "authorized", "object_count": float64(visibleObjects),
				"visible_bytes": float64(visibleObjects) * objectBytes, "used_bytes": float64(visibleObjects) * objectBytes,
				"trash_bytes": objectBytes, "removable_count": float64(removable), "removable_bytes": float64(removable) * objectBytes,
				"limit_bytes": float64(0), "managed_elsewhere_bytes": float64(0),
			} {
				if usage[field] != want {
					t.Fatalf("usage %s=%v want=%v", field, usage[field], want)
				}
			}
			byType, ok := usage["by_type"].(map[string]any)
			if !ok || byType["document"] != float64(visibleObjects)*objectBytes {
				t.Fatalf("document total mismatch: %v", usage["by_type"])
			}
			byOrigin, ok := usage["by_origin"].(map[string]any)
			if !ok || byOrigin["chats"] != float64(chatCount)*objectBytes || byOrigin["own_uploads"] != objectBytes || byOrigin["trash"] != objectBytes {
				t.Fatalf("origin totals are not deduplicated consistently: %v", usage["by_origin"])
			}
			if dynamicsVisible && byOrigin["dynamics"] != objectBytes || !dynamicsVisible && byOrigin["dynamics"] != nil {
				t.Fatalf("hidden origin entered summary: %v", byOrigin)
			}
			wanted := map[string]int{"large_files": 0, "older_files": activeObjects, "unused_uploads": 1, "trash_ready": 1}
			if !canManage {
				wanted["trash_ready"] = 0
			}
			for _, recommendation := range storageQAItems(t, usage, "recommendations") {
				id, _ := recommendation["id"].(string)
				count, exists := wanted[id]
				if !exists || recommendation["count"] != float64(count) || recommendation["bytes"] != float64(count)*objectBytes {
					t.Fatalf("recommendation does not match authorized physical rows: %v", recommendation)
				}
				delete(wanted, id)
			}
			if len(wanted) != 0 {
				t.Fatalf("missing recommendations: %v", wanted)
			}
		}
		assertUsage(false, true)
		// Re-evaluate current permissions without reconciling or rebuilding the
		// inventory. Counts, labels and summaries must change together.
		permissions(domain.PermSettings, domain.PermChats, domain.PermDynamics)
		assertPage(url.Values{"q": {"Hidden dynamics context"}}, 2, 2)
		assertPage(url.Values{"origin": {"dynamics"}}, 2, 2)
		assertPage(url.Values{"limit": {"100"}}, len(active)+1, len(active)+1)
		assertUsage(true, true)
		permissions(domain.PermChats)
		assertPage(url.Values{"q": {"Hidden dynamics context"}}, 0, 0)
		assertPage(url.Values{"status": {"removable"}}, 0, 0)
		assertUsage(false, false)
		permissions(domain.PermSettings, domain.PermChats)
		assertUsage(false, true)
		code, foreign := f.request("GET", "/storage/files?limit=100", nil, map[string]string{"X-QA-Account": "other"})
		foreignFiles := storageQAItems(t, foreign, "files")
		if code != 200 || foreign["total"] != float64(1) || len(foreignFiles) != 1 || foreignFiles[0]["object_key"] != foreignKey {
			t.Fatalf("switching account contaminated the inventory page: %v", foreign)
		}
	})
}
