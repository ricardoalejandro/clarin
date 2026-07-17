package storage

import (
	"context"
	"net/http"
	"os"
	"testing"

	"github.com/google/uuid"
)

func TestPrivateObjectKey(t *testing.T) {
	accountID := uuid.New()
	key := PrivateObjectKey(accountID, "statuses", "photo.webp")
	if key != accountID.String()+"/_private/statuses/photo.webp" {
		t.Fatalf("unexpected private object key: %q", key)
	}
	for _, candidate := range []string{key, "/" + key, accountID.String() + "/_private/statuses/../statuses/photo.webp"} {
		if !IsPrivateObjectKey(candidate) {
			t.Fatalf("private object key was not detected: %q", candidate)
		}
	}
	for _, candidate := range []string{"", accountID.String() + "/statuses/photo.webp", "_private/statuses/photo.webp"} {
		if IsPrivateObjectKey(candidate) {
			t.Fatalf("public object key was marked private: %q", candidate)
		}
	}
	legacyKey := accountID.String() + "/statuses/photo.webp"
	if !IsLegacyStatusObjectKey(legacyKey) || !IsProtectedStatusObjectKey(legacyKey) {
		t.Fatalf("legacy status key was not protected: %q", legacyKey)
	}
	if !IsAccountPrivateStatusObjectKey(accountID, key) || !IsAccountLegacyStatusObjectKey(accountID, legacyKey) ||
		!IsAccountStatusObjectKey(accountID, key) || !IsAccountStatusObjectKey(accountID, legacyKey) {
		t.Fatal("account-scoped status keys were not recognized")
	}
	otherAccountID := uuid.New()
	for _, candidate := range []string{
		otherAccountID.String() + "/_private/statuses/photo.webp",
		otherAccountID.String() + "/statuses/photo.webp",
		accountID.String() + "/_private/../statuses/photo.webp",
		"/" + key,
	} {
		if IsAccountStatusObjectKey(accountID, candidate) {
			t.Fatalf("unsafe destructive key was accepted: %q", candidate)
		}
	}
}

func TestAccountScopedObjectKey(t *testing.T) {
	accountID := uuid.New()
	if key, err := accountScopedObjectKey(accountID, "uploads", "photo.jpg"); err != nil || key != accountID.String()+"/uploads/photo.jpg" {
		t.Fatalf("safe account key: key=%q err=%v", key, err)
	}
	for _, test := range []struct{ folder, filename string }{
		{"uploads", "x/../../../victim/file"},
		{"../victim", "file"},
		{"_private/statuses", "file"},
		{"statuses", "file"},
	} {
		if key, err := accountScopedObjectKey(accountID, test.folder, test.filename); err == nil {
			t.Fatalf("unsafe key escaped: folder=%q filename=%q key=%q", test.folder, test.filename, key)
		}
	}
}

func TestPublicAndPrivateBucketsIntegration(t *testing.T) {
	if os.Getenv("CLARIN_RUN_STORAGE_INTEGRATION") != "1" {
		t.Skip("set CLARIN_RUN_STORAGE_INTEGRATION=1 with a disposable MinIO endpoint")
	}
	endpoint := os.Getenv("MINIO_ENDPOINT")
	accessKey := os.Getenv("MINIO_ACCESS_KEY")
	secretKey := os.Getenv("MINIO_SECRET_KEY")
	if endpoint == "" || accessKey == "" || secretKey == "" {
		t.Fatal("MINIO_ENDPOINT, MINIO_ACCESS_KEY and MINIO_SECRET_KEY are required")
	}
	bucket := "clarin-storage-test-" + uuid.NewString()[:8]
	store, err := New(Config{
		Endpoint: endpoint, AccessKey: accessKey, SecretKey: secretKey,
		Bucket: bucket, PublicURL: "http://" + endpoint,
	})
	if err != nil {
		t.Fatalf("create storage: %v", err)
	}
	ctx := context.Background()
	accountID := uuid.New()
	if _, err := store.GetPresignedUploadURL(ctx, accountID, "uploads", "x/../../../victim/_private/statuses/pwn"); err == nil {
		t.Fatal("presigned upload escaped the account prefix")
	}
	if _, err := store.GetPresignedUploadURL(ctx, accountID, "_private/statuses", "pwn"); err == nil {
		t.Fatal("presigned upload entered the private namespace")
	}
	publicKey := accountID.String() + "/uploads/public.txt"
	privateKey := PrivateObjectKey(accountID, "statuses", "private.txt")
	legacyKey := accountID.String() + "/statuses/legacy.txt"
	if _, err := store.UploadObject(ctx, publicKey, []byte("public"), "text/plain"); err != nil {
		t.Fatalf("upload public object: %v", err)
	}
	if directURL, err := store.UploadObject(ctx, legacyKey, []byte("legacy"), "text/plain"); err != nil || directURL != "" {
		t.Fatalf("upload legacy status object: directURL=%q err=%v", directURL, err)
	}
	if directURL, err := store.UploadObject(ctx, privateKey, []byte("private"), "text/plain"); err != nil || directURL != "" {
		t.Fatalf("upload private object: directURL=%q err=%v", directURL, err)
	}
	if data, err := store.GetFile(ctx, privateKey); err != nil || string(data) != "private" {
		t.Fatalf("read private object with service credentials: data=%q err=%v", data, err)
	}

	publicResponse, err := http.Get("http://" + endpoint + "/" + bucket + "/" + publicKey) // #nosec G107 -- disposable integration endpoint
	if err != nil {
		t.Fatalf("anonymous public GET: %v", err)
	}
	publicResponse.Body.Close()
	if publicResponse.StatusCode != http.StatusOK {
		t.Fatalf("public object was not anonymous: %s", publicResponse.Status)
	}
	legacyResponse, err := http.Get("http://" + endpoint + "/" + bucket + "/" + legacyKey) // #nosec G107 -- disposable integration endpoint
	if err != nil {
		t.Fatalf("anonymous legacy status GET: %v", err)
	}
	legacyResponse.Body.Close()
	if legacyResponse.StatusCode == http.StatusOK {
		t.Fatal("legacy status object was anonymously readable")
	}
	if data, err := store.GetFile(ctx, legacyKey); err != nil || string(data) != "legacy" {
		t.Fatalf("read legacy object with service credentials: data=%q err=%v", data, err)
	}
	privateResponse, err := http.Get("http://" + endpoint + "/" + bucket + "-private/" + privateKey) // #nosec G107 -- disposable integration endpoint
	if err != nil {
		t.Fatalf("anonymous private GET: %v", err)
	}
	privateResponse.Body.Close()
	if privateResponse.StatusCode == http.StatusOK {
		t.Fatal("private object was anonymously readable")
	}

	objects, err := store.ListPrefix(ctx, accountID.String()+"/")
	if err != nil || len(objects) != 3 {
		t.Fatalf("combined inventory: objects=%#v err=%v", objects, err)
	}
	size, count, err := store.UsagePrefix(ctx, accountID.String()+"/")
	if err != nil || count != 3 || size != int64(len("public")+len("private")+len("legacy")) {
		t.Fatalf("combined quota: size=%d count=%d err=%v", size, count, err)
	}
	deleted, err := store.DeletePrefix(ctx, accountID.String()+"/")
	if err != nil || deleted != 3 {
		t.Fatalf("combined purge: deleted=%d err=%v", deleted, err)
	}
}
