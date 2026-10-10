package api

import (
	"context"
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
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/storage"
	"github.com/naperu/clarin/pkg/config"
)

// Invoked by the disposable PostgreSQL+MinIO storage suite. Ordinary authenticated
// object ACLs are checked by the catalog suite; this covers anonymous publication
// capabilities and their immediate lifecycle revocation against real persistence.
func runMediaAccessIntegrationChecks(t *testing.T, db *pgxpool.Pool, store *storage.Storage) {
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
	if res.StatusCode == http.StatusOK {
		t.Fatal("anonymous S3 bypass remains")
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
