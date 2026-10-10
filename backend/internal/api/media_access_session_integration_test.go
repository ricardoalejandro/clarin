package api

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
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
	"github.com/naperu/clarin/internal/service"
	"github.com/naperu/clarin/internal/storage"
	"github.com/naperu/clarin/pkg/cache"
	"github.com/naperu/clarin/pkg/config"
	"golang.org/x/crypto/bcrypt"
)

// This runs inside the native storage suite, with real password login, signed
// JWTs, canonical Redis sessions, SQL authority and MinIO bytes. No request
// injects account/user/permission locals around the ordinary download handler.
func runMediaAccessSessionIntegrationChecks(t *testing.T, db *pgxpool.Pool, store *storage.Storage) {
	ctx := context.Background()
	redisURL, err := url.Parse(os.Getenv("CLARIN_STORAGE_QA_REDIS_URL"))
	if err != nil || redisURL.Scheme != "redis" || redisURL.Hostname() != "127.0.0.1" || redisURL.Port() != "16379" {
		t.Fatal("ordinary media integration requires disposable Redis at 127.0.0.1:16379 via CLARIN_STORAGE_QA_REDIS_URL")
	}
	redisCache, err := cache.New(redisURL.String())
	if err != nil {
		t.Fatal("connect disposable media session cache")
	}
	t.Cleanup(func() { _ = redisCache.Close() })
	f := newStorageQAFixture(t, db, store)
	f.server.cfg = &config.Config{JWTSecret: "disposable-authenticated-media-qa-signing-key"}
	f.server.services.Auth.SetCache(redisCache)
	password := "disposable-media-login-" + uuid.NewString()
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	// The catalog fixture never logs in and leaves display_name NULL. Real user
	// repository hydration scans it into a string, so use a complete login user.
	f.exec(`UPDATE users SET password_hash=$3,display_name='Disposable media QA user' WHERE id IN ($1,$2)`, f.user, f.secondUser, string(hash))
	type loginSession struct {
		token, refresh string
		claims         *service.JWTClaims
	}
	login := func(user, account uuid.UUID) loginSession {
		t.Helper()
		loginUser, err := f.server.repos.User.GetByUsername(ctx, "qa-"+user.String())
		if err != nil {
			t.Fatalf("hydrate disposable login fixture: %v", err)
		}
		if loginUser == nil || loginUser.ID != user {
			t.Fatal("disposable login fixture is missing")
		}
		token, refresh, _, _, _, err := f.server.services.Auth.Login(ctx, "qa-"+user.String(), password, f.server.cfg.JWTSecret,
			service.OfflineReauthIdentity{UserID: user, AccountID: account})
		if err != nil {
			t.Fatalf("password login for disposable account: %v", err)
		}
		claims, err := f.server.services.Auth.ValidateTokenReadOnly(ctx, token, f.server.cfg.JWTSecret)
		if err != nil || claims == nil || claims.UserID != user || claims.AccountID != account {
			t.Fatal("login did not create the expected canonical identity")
		}
		t.Cleanup(func() {
			f.server.services.Auth.Logout(ctx, claims, refresh)
			_ = redisCache.Del(ctx, "jwtblk:"+claims.ID, "userinv:"+user.String(), "usersessinv:"+user.String())
		})
		return loginSession{token: token, refresh: refresh, claims: claims}
	}
	owner := login(f.user, f.account)
	secondSession := login(f.user, f.account)
	otherActor := login(f.secondUser, f.account)
	otherToken, otherRefresh, _, err := f.server.services.Auth.SwitchAccount(ctx, f.user, f.other, owner.claims.SessionID, owner.refresh, f.server.cfg.JWTSecret)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = redisCache.Del(ctx, "refresh:"+otherRefresh) })
	key, _, _ := f.media(f.account, "uploads", "account-a.pdf", true)
	otherKey, _, _ := f.media(f.other, "uploads", "account-b.pdf", true)
	draftKey, _, _ := f.media(f.account, "uploads", "own-draft.pdf", false)
	readObject := func(key string) []byte {
		t.Helper()
		data, err := store.GetFile(ctx, key)
		if err != nil {
			t.Fatal(err)
		}
		return data
	}
	want, otherWant, draftWant := readObject(key), readObject(otherKey), readObject(draftKey)
	raw, otherRaw, draftRaw := mediaProxyURLFromObjectKey(key), mediaProxyURLFromObjectKey(otherKey), mediaProxyURLFromObjectKey(draftKey)
	app := fiber.New()
	app.Get("/api/media/file/*", f.server.handleMediaProxy)
	// Exercise the same authenticated capability issuance used after an upload.
	app.Get("/qa/upload-preview", f.server.authMiddleware, func(c *fiber.Ctx) error {
		return c.SendString(f.server.uploadPreviewURL(c, draftKey))
	})
	get := func(target, token string, cookie bool, wantStatus int, wantBody []byte, headers map[string]string) http.Header {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, target, nil)
		if token != "" {
			if cookie {
				req.AddCookie(&http.Cookie{Name: "auth-token", Value: token})
			} else {
				req.Header.Set("Authorization", "Bearer "+token)
			}
		}
		for name, value := range headers {
			req.Header.Set(name, value)
		}
		res, err := app.Test(req, 15000)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		if res.StatusCode != wantStatus {
			t.Fatalf("ordinary media status %d, want %d (path %s)", res.StatusCode, wantStatus, strings.Split(target, "?")[0])
		}
		if res.Header.Get("Cache-Control") != "private, no-store, max-age=0" || res.Header.Get("Vary") != "Cookie, Authorization" {
			t.Fatal("ordinary media response is not isolated from shared/browser caches")
		}
		body, err := io.ReadAll(res.Body)
		if err != nil {
			t.Fatal(err)
		}
		if wantBody != nil && !bytes.Equal(body, wantBody) {
			t.Fatal("ordinary download bytes differ from the authorized object")
		}
		return res.Header
	}
	t.Run("cookie and bearer access isolate active accounts", func(t *testing.T) {
		get(raw, "", false, http.StatusNotFound, nil, nil)
		get(raw, owner.token, true, http.StatusOK, want, nil)
		get(raw, owner.token, false, http.StatusOK, want, nil)
		get(otherRaw, otherToken, true, http.StatusOK, otherWant, nil)
		get(otherRaw, owner.token, true, http.StatusNotFound, nil, nil)
		get(raw, otherToken, true, http.StatusNotFound, nil, nil)
		get(raw, owner.token+"invalid", false, http.StatusNotFound, nil, nil)
		expired := *owner.claims
		expired.ExpiresAt = jwt.NewNumericDate(time.Now().Add(-time.Minute))
		expiredToken, err := jwt.NewWithClaims(jwt.SigningMethodHS256, expired).SignedString([]byte(f.server.cfg.JWTSecret))
		if err != nil {
			t.Fatal(err)
		}
		get(raw, expiredToken, false, http.StatusNotFound, nil, nil)
	})
	t.Run("ranges and conditional requests revalidate authority", func(t *testing.T) {
		before, err := redisCache.Get(ctx, "session:"+owner.claims.SessionID)
		if err != nil {
			t.Fatal(err)
		}
		headers := get(raw, owner.token, true, http.StatusOK, want, nil)
		get(raw, owner.token, true, http.StatusOK, want, map[string]string{"If-None-Match": headers.Get("ETag")})
		get(raw, owner.token, true, http.StatusPartialContent, want[:8], map[string]string{"Range": "bytes=0-7"})
		after, err := redisCache.Get(ctx, "session:"+owner.claims.SessionID)
		if err != nil || !bytes.Equal(before, after) {
			t.Fatal("passive media reads changed the canonical session")
		}
		f.exec(`UPDATE roles SET permissions=$2 WHERE id=$1`, f.role, []string{domain.PermSettings})
		get(raw, owner.token, true, http.StatusNotFound, nil, map[string]string{"If-None-Match": headers.Get("ETag"), "Range": "bytes=0-7"})
		f.exec(`UPDATE roles SET permissions=$2 WHERE id=$1`, f.role, []string{domain.PermSettings, domain.PermChats})
		get(raw, owner.token, true, http.StatusOK, want, nil)
	})
	t.Run("membership and user revocation are immediate", func(t *testing.T) {
		f.exec(`DELETE FROM user_accounts WHERE user_id=$1 AND account_id=$2`, f.user, f.account)
		get(raw, owner.token, true, http.StatusNotFound, nil, nil)
		get(otherRaw, otherToken, true, http.StatusOK, otherWant, nil)
		f.exec(`INSERT INTO user_accounts(user_id,account_id,role,role_id) VALUES($1,$2,'member',$3)`, f.user, f.account, f.role)
		get(raw, owner.token, true, http.StatusOK, want, nil)
		f.exec(`UPDATE users SET is_active=false WHERE id=$1`, f.user)
		get(raw, owner.token, true, http.StatusNotFound, nil, nil)
		f.exec(`UPDATE users SET is_active=true WHERE id=$1`, f.user)
		get(raw, owner.token, true, http.StatusOK, want, nil)
	})
	t.Run("own upload preview is bound to account user session and lifecycle", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/qa/upload-preview", nil)
		req.AddCookie(&http.Cookie{Name: "auth-token", Value: owner.token})
		res, err := app.Test(req, 15000)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		body, err := io.ReadAll(res.Body)
		if err != nil || res.StatusCode != http.StatusOK {
			t.Fatal("authenticated upload preview capability was not issued")
		}
		preview := string(body)
		get(draftRaw, owner.token, true, http.StatusNotFound, nil, nil)
		get(preview, owner.token, true, http.StatusOK, draftWant, nil)
		get(preview, "", false, http.StatusNotFound, nil, nil)
		get(preview, secondSession.token, true, http.StatusNotFound, nil, nil)
		get(preview, otherActor.token, true, http.StatusNotFound, nil, nil)
		get(preview, otherToken, true, http.StatusNotFound, nil, nil)
		get(preview+"invalid", owner.token, true, http.StatusNotFound, nil, nil)
		f.exec(`INSERT INTO storage_media_trash(account_id,object_key,actor_id,filename,media_type,size_bytes,message_backups,purge_after) VALUES($1,$2,$3,'own-draft.pdf','document',$4,'[]',NOW()+INTERVAL '7 days')`, f.account, draftKey, f.user, len(draftWant))
		for _, state := range []string{"trash", "purging", "purged"} {
			f.exec(`UPDATE storage_media_trash SET state=$3 WHERE account_id=$1 AND object_key=$2`, f.account, draftKey, state)
			get(preview, owner.token, true, http.StatusNotFound, nil, nil)
		}
		f.exec(`UPDATE storage_media_trash SET state='restored' WHERE account_id=$1 AND object_key=$2`, f.account, draftKey)
		get(preview, owner.token, true, http.StatusOK, draftWant, nil)
		if got := readObject(draftKey); !bytes.Equal(got, draftWant) {
			t.Fatal("preview lifecycle revocation changed persisted bytes")
		}
	})
	t.Run("logout and global session revocation reject still signed tokens", func(t *testing.T) {
		f.server.services.Auth.Logout(ctx, owner.claims, otherRefresh)
		get(raw, owner.token, true, http.StatusNotFound, nil, nil)
		// The switched token has a different JTI but shares the revoked session.
		get(otherRaw, otherToken, true, http.StatusNotFound, nil, nil)
		get(raw, secondSession.token, true, http.StatusOK, want, nil)
		f.server.services.Auth.InvalidateUserSessions(f.user)
		get(raw, secondSession.token, true, http.StatusNotFound, nil, nil)
		get(raw, otherActor.token, true, http.StatusOK, want, nil)
	})
	t.Run("session cache failure denies media without exposing bytes", func(t *testing.T) {
		failedCache, err := cache.New(redisURL.String())
		if err != nil {
			t.Fatal("connect disposable cache failure fixture")
		}
		if err := failedCache.Close(); err != nil {
			t.Fatal(err)
		}
		f.server.services.Auth.SetCache(failedCache)
		defer f.server.services.Auth.SetCache(redisCache)
		get(raw, otherActor.token, true, http.StatusNotFound, nil, nil)
	})
}
