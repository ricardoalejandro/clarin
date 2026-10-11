package api

import (
	"bytes"
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/service"
	"github.com/naperu/clarin/internal/storage"
)

func TestStorageSelfServiceReviewFingerprintPreservesEncodingAndBindsETag(t *testing.T) {
	file := storageSelfServiceFile{ObjectKey: "account/chats/document.pdf", SizeBytes: 12, LastModified: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC), Status: "active"}
	refs := []storageSelfServiceReference{{Origin: "chats", ID: "message-2"}, {Origin: "chats", ID: "message-1"}}
	// This vector uses the encoding persisted by already-reviewed operations.
	const existing = "c3dc2d706d76c680f3631b4120587dc9e97bdec1b7dd9ecccb04745e1cbbc2ca"
	if got := storageSelfServiceReviewFingerprint(file, refs, "etag-before"); got != existing {
		t.Fatalf("existing review encoding changed: %s", got)
	}
	if storageSelfServiceReviewFingerprint(file, refs, "etag-after") == existing {
		t.Fatal("same-size replacement with unchanged metadata must invalidate the review")
	}
	reordered := []storageSelfServiceReference{refs[1], refs[0]}
	if storageSelfServiceReviewFingerprint(file, reordered, "etag-before") != existing {
		t.Fatal("reference query order must not invalidate an unchanged review")
	}
	changed := append([]storageSelfServiceReference(nil), refs...)
	changed[0].ID = "new-message"
	if storageSelfServiceReviewFingerprint(file, changed, "etag-before") == existing {
		t.Fatal("changed live reference must invalidate the review")
	}
}

// Called by the native storage integration suite. Real PostgreSQL verifies the
// sparse predicates; real MinIO verifies selected reviews still bind object ETags.
func runStorageCatalogOptimizationIntegrationChecks(t *testing.T, db *pgxpool.Pool, store *storage.Storage) {
	f := newStorageQAFixture(t, db, store)
	ctx := context.Background()
	urlOnly, _, urlMessage := f.media(f.account, "chats", "legacy-url-only.pdf", true)
	assetOnly, _, assetMessage := f.media(f.account, "chats", "asset-only.pdf", true)
	unreferenced, _, _ := f.media(f.account, "uploads", "unreferenced.pdf", false)
	foreign, _, _ := f.media(f.other, "chats", "foreign-catalog.pdf", true)
	f.exec(`UPDATE messages SET media_asset_id=NULL WHERE account_id=$1 AND id=$2`, f.account, urlMessage)
	f.exec(`UPDATE messages SET media_url=NULL WHERE account_id=$1 AND id=$2`, f.account, assetMessage)
	// Both historical NULL and explicitly empty URLs contain no media evidence.
	f.exec(`INSERT INTO messages(account_id,chat_id,message_id,body,message_type,media_url,timestamp)
	 SELECT $1::uuid,m.chat_id,'empty-'||g::text,'Text without media','text',CASE WHEN g=1 THEN NULL ELSE '' END,NOW()
	 FROM messages m CROSS JOIN generate_series(1,2) g WHERE m.account_id=$1 AND m.id=$2`, f.account, urlMessage)
	avatarURL, _, _ := f.media(f.account, "contacts", "avatar-url-only.jpg", false)
	avatarAsset, avatarAssetID, _ := f.media(f.account, "contacts", "avatar-asset-only.jpg", false)
	for i, avatar := range []struct {
		url   any
		asset any
	}{
		{mediaProxyURLFromObjectKey(avatarURL), nil},
		{nil, avatarAssetID},
		{nil, nil},
		{"", nil},
	} {
		id := uuid.New()
		f.exec(`INSERT INTO contacts(id,account_id,jid,name,avatar_url,avatar_media_asset_id) VALUES($1,$2,$3,$4,$5,$6)`, id, f.account, id.String()+"@test.invalid", []string{"Avatar URL", "Avatar asset", "No avatar", "Empty avatar"}[i], avatar.url, avatar.asset)
	}
	for _, source := range storageSelfServiceReferenceQueries {
		if source.origin != "chats" && source.origin != "contacts" {
			continue
		}
		rows, err := db.Query(ctx, source.sql, f.account)
		if err != nil {
			t.Fatal(err)
		}
		count := 0
		for rows.Next() {
			count++
		}
		err = rows.Err()
		rows.Close()
		if err != nil || count != 2 {
			t.Fatalf("%s sparse reference query returned %d rows, expected URL-only and asset-only; error=%v", source.origin, count, err)
		}
	}
	claims := &service.JWTClaims{AccountID: f.account, UserID: f.user, Role: "member", Permissions: []string{domain.PermSettings, domain.PermChats, domain.PermContacts}}
	full, err := f.server.storageSelfServiceCatalog(ctx, db, f.account, f.user, claims)
	if err != nil {
		t.Fatal(err)
	}
	if len(full.Files) != 4 {
		t.Fatalf("visible inventory=%d, expected two chat files and two avatars", len(full.Files))
	}
	seen := map[string]bool{}
	for _, file := range full.Files {
		if file.ObjectKey == foreign || file.ObjectKey == unreferenced {
			t.Fatal("foreign or unreferenced object became readable")
		}
		if file.Fingerprint != "" {
			t.Fatal("general inventory calculated an unused review fingerprint")
		}
		if file.ReferencesCount != 1 {
			t.Fatal("legacy references were lost or duplicated")
		}
		seen[file.ObjectKey] = true
	}
	for _, key := range []string{urlOnly, assetOnly, avatarURL, avatarAsset} {
		if !seen[key] {
			t.Fatal("URL-only or asset-only reference missing from inventory")
		}
	}
	selected, err := f.server.storageSelfServiceCatalog(ctx, db, f.account, f.user, claims, []string{urlOnly, assetOnly})
	if err != nil {
		t.Fatal(err)
	}
	if len(selected.Files) != 2 {
		t.Fatal("selected review lost a legacy file")
	}
	before := ""
	for _, file := range selected.Files {
		if file.Fingerprint == "" || !file.CanRemove {
			t.Fatal("selected review lost fingerprint or chat eligibility")
		}
		if file.ObjectKey == urlOnly {
			before = file.Fingerprint
		}
	}
	info, err := store.GetFileInfo(ctx, urlOnly)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.UploadObject(ctx, urlOnly, bytes.Repeat([]byte("x"), int(info.Size)), "application/pdf"); err != nil {
		t.Fatal(err)
	}
	afterInfo, err := store.GetFileInfo(ctx, urlOnly)
	if err != nil || info.Size != afterInfo.Size || info.ETag == afterInfo.ETag {
		t.Fatalf("replacement did not preserve size and change ETag: %v", err)
	}
	replaced, err := f.server.storageSelfServiceCatalog(ctx, db, f.account, f.user, claims, []string{urlOnly})
	if err != nil {
		t.Fatal(err)
	}
	if len(replaced.Files) != 1 || replaced.Files[0].Fingerprint == before {
		t.Fatal("selected review did not notice changed physical bytes")
	}
}
