package api

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/storage"
	"github.com/naperu/clarin/pkg/config"
)

// Invoked by the disposable PostgreSQL+MinIO storage suite. The ordinary route
// also requires disposable Redis to validate real login sessions and revocation.
func runMediaAccessIntegrationChecks(t *testing.T, db *pgxpool.Pool, store *storage.Storage) {
	t.Run("SQL media assignment authority", func(t *testing.T) { runMediaAccessSQLChecks(t, db) })
	t.Run("legacy public bucket becomes private without losing bytes", runMediaLegacyBucketPolicyIntegrationCheck)
	t.Run("ordinary downloads with real login sessions", func(t *testing.T) { runMediaAccessSessionIntegrationChecks(t, db, store) })
	f := newStorageQAFixture(t, db, store)
	f.server.cfg = &config.Config{JWTSecret: "disposable-media-qa-signing-key"}
	key, _, _ := f.media(f.account, "surveys/branding", "public-brand.pdf", false)
	otherKey, _, _ := f.media(f.other, "uploads", "other-account.pdf", false)
	app := fiber.New()
	app.Get("/api/media/file/*", f.server.handleMediaProxy)
	get := func(target string, want int) {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, target, nil)
		res, err := app.Test(req, 15000)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		if res.StatusCode != want {
			t.Fatalf("media GET status %d, want %d", res.StatusCode, want)
		}
		if res.Header.Get("Cache-Control") != "private, no-store, max-age=0" {
			t.Fatal("media could be cached across accounts")
		}
		if want == http.StatusOK {
			data, err := io.ReadAll(res.Body)
			if err != nil || len(data) == 0 {
				t.Fatal("authorized resource did not stream")
			}
		}
	}
	get(mediaProxyURLFromObjectKey(key), http.StatusNotFound)
	get(mediaProxyURLFromObjectKey(otherKey), http.StatusNotFound)
	direct := "http://" + os.Getenv("MINIO_ENDPOINT") + "/" + os.Getenv("MINIO_BUCKET") + "/" + key
	res, err := http.Get(direct)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("anonymous S3 GET status %d, want 403", res.StatusCode)
	}
	surveyID := uuid.New()
	raw := mediaProxyURLFromObjectKey(key)
	f.exec(`INSERT INTO surveys(id,account_id,name,slug,status,branding) VALUES($1,$2,'Media QA',$3,'active',jsonb_build_object('logo_url',$4::text))`, surveyID, f.account, "media-qa-"+surveyID.String(), raw)
	survey := &domain.Survey{ID: surveyID, AccountID: f.account, Branding: domain.SurveyBranding{LogoURL: raw}}
	publicURL := f.server.publishSurveyBranding(survey).LogoURL
	get(publicURL, http.StatusOK)
	parsed, _ := url.Parse(publicURL)
	capability := parsed.Query().Get("media_access")
	get(mediaProxyURLFromObjectKey(otherKey)+"?media_access="+capability, http.StatusNotFound)
	get(publicURL+"tampered", http.StatusNotFound)
	expired := mediaAccessGrant{Purpose: "survey-branding", AccountID: f.account, ResourceID: surveyID, ObjectKey: key, Expires: time.Now().Add(-time.Minute).Unix()}
	get(raw+"?media_access="+signMediaAccessGrant(f.server.cfg.JWTSecret, expired), http.StatusNotFound)
	f.exec(`UPDATE surveys SET branding='{}' WHERE id=$1 AND account_id=$2`, surveyID, f.account)
	get(publicURL, http.StatusNotFound)
	f.exec(`UPDATE surveys SET branding=jsonb_build_object('logo_url',$3::text),status='closed' WHERE id=$1 AND account_id=$2`, surveyID, f.account, raw)
	get(publicURL, http.StatusNotFound)

	dynamicID, itemID := uuid.New(), uuid.New()
	f.exec(`INSERT INTO dynamics(id,account_id,type,name,slug,is_active) VALUES($1,$2,'scratch','Media QA',$3,true)`, dynamicID, f.account, "media-qa-"+dynamicID.String())
	f.exec(`INSERT INTO dynamic_items(id,dynamic_id,image_url,is_active) VALUES($1,$2,$3,true)`, itemID, dynamicID, raw)
	dynamicURL := f.server.publicResourceMediaURL(raw, mediaAccessGrant{Purpose: "dynamic-public", AccountID: f.account, ResourceID: dynamicID})
	get(dynamicURL, http.StatusOK)
	f.exec(`UPDATE dynamic_items SET is_active=false WHERE id=$1`, itemID)
	get(dynamicURL, http.StatusNotFound)
	// The authenticated S3 client still reads the bytes after public revocation.
	if _, err := store.GetFile(context.Background(), key); err != nil {
		t.Fatal("revocation destroyed the stored file")
	}
}

func runMediaLegacyBucketPolicyIntegrationCheck(t *testing.T) {
	ctx := context.Background()
	cfg := storage.Config{
		Endpoint: os.Getenv("MINIO_ENDPOINT"), AccessKey: os.Getenv("MINIO_ACCESS_KEY"),
		SecretKey: os.Getenv("MINIO_SECRET_KEY"), PublicURL: os.Getenv("MINIO_PUBLIC_URL"),
		Bucket: "clarin-qa-legacy-" + uuid.NewString(),
	}
	if cfg.Endpoint != "127.0.0.1:19001" {
		t.Fatal("legacy bucket policy test requires the disposable loopback MinIO")
	}
	client, err := minio.New(cfg.Endpoint, &minio.Options{
		Creds: credentials.NewStaticV4(cfg.AccessKey, cfg.SecretKey, ""), Secure: false,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := client.MakeBucket(ctx, cfg.Bucket, minio.MakeBucketOptions{}); err != nil {
		t.Fatal(err)
	}
	key := uuid.NewString() + "/uploads/legacy.pdf"
	want := []byte("Disposable legacy media: preserve these exact bytes")
	t.Cleanup(func() {
		if err := client.RemoveObject(ctx, cfg.Bucket, key, minio.RemoveObjectOptions{}); err != nil {
			t.Errorf("remove disposable legacy object: %v", err)
		}
		for _, bucket := range []string{cfg.Bucket, cfg.Bucket + "-private"} {
			exists, err := client.BucketExists(ctx, bucket)
			if err != nil {
				t.Errorf("inspect disposable bucket: %v", err)
				continue
			}
			if exists {
				if err := client.RemoveBucket(ctx, bucket); err != nil {
					t.Errorf("remove disposable bucket: %v", err)
				}
			}
		}
	})
	if _, err := client.PutObject(ctx, cfg.Bucket, key, bytes.NewReader(want), int64(len(want)), minio.PutObjectOptions{ContentType: "application/pdf"}); err != nil {
		t.Fatal(err)
	}
	policy := fmt.Sprintf(`{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"AWS":["*"]},"Action":["s3:GetObject"],"Resource":["arn:aws:s3:::%s/*"]}]}`, cfg.Bucket)
	if err := client.SetBucketPolicy(ctx, cfg.Bucket, policy); err != nil {
		t.Fatal(err)
	}
	getAnonymous := func(wantStatus int) {
		t.Helper()
		client := &http.Client{Timeout: 10 * time.Second}
		res, err := client.Get("http://" + cfg.Endpoint + "/" + cfg.Bucket + "/" + key)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		if res.StatusCode != wantStatus {
			t.Fatalf("legacy anonymous GET status %d, want %d", res.StatusCode, wantStatus)
		}
		if wantStatus == http.StatusOK {
			got, err := io.ReadAll(res.Body)
			if err != nil || !bytes.Equal(got, want) {
				t.Fatal("legacy public object bytes differ from the fixture")
			}
		}
	}
	getAnonymous(http.StatusOK)
	// A second startup must preserve the private policy and the original bytes.
	for startup := 0; startup < 2; startup++ {
		store, err := storage.New(cfg)
		if err != nil {
			t.Fatal(err)
		}
		if policy, err := client.GetBucketPolicy(ctx, cfg.Bucket); err != nil || policy != "" {
			t.Fatal("storage startup did not remove the legacy public policy")
		}
		getAnonymous(http.StatusForbidden)
		got, err := store.GetFile(ctx, key)
		if err != nil || !bytes.Equal(got, want) {
			t.Fatal("privatizing the legacy bucket changed authenticated media bytes")
		}
	}
}
