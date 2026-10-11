package api

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/png"
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
	if err != nil || redisURL.Scheme != "redis" || redisURL.Hostname() != "127.0.0.1" || redisURL.Port() != storageQAPort(t, "CLARIN_STORAGE_QA_REDIS_PORT", "16379") {
		t.Fatal("ordinary media integration requires configured disposable loopback Redis via CLARIN_STORAGE_QA_REDIS_URL")
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
	app.Get("/api/storage/content", f.server.authMiddleware, f.server.handleStorageSelfServiceContent)
	// Exercise the same authenticated capability issuance used after an upload.
	app.Get("/qa/upload-preview", f.server.authMiddleware, func(c *fiber.Ctx) error {
		return c.SendString(f.server.uploadPreviewURL(c, draftKey))
	})
	getAt := func(t *testing.T, target, token string, cookie bool, wantStatus int, wantBody []byte, headers map[string]string) http.Header {
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
	get := func(target, token string, cookie bool, wantStatus int, wantBody []byte, headers map[string]string) http.Header {
		return getAt(t, target, token, cookie, wantStatus, wantBody, headers)
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
	t.Run("storage native cookie HEAD and range download", func(t *testing.T) {
		target := "/api/storage/content?object_key=" + url.QueryEscape(key)
		req := httptest.NewRequest(http.MethodHead, target+"&download=1", nil)
		req.AddCookie(&http.Cookie{Name: "auth-token", Value: owner.token})
		response, err := app.Test(req, 15000)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		body, err := io.ReadAll(response.Body)
		if err != nil || response.StatusCode != http.StatusOK || len(body) != 0 || response.ContentLength != int64(len(want)) {
			t.Fatalf("native HEAD failed status=%d length=%d body=%d error=%v", response.StatusCode, response.ContentLength, len(body), err)
		}
		if response.Header.Get("X-Content-Type-Options") != "nosniff" || !strings.HasPrefix(response.Header.Get("Content-Disposition"), "attachment;") {
			t.Fatal("native download missing safe attachment headers")
		}
		get(target, owner.token, true, http.StatusPartialContent, want[:8], map[string]string{"Range": "bytes=0-7"})
		get(target, otherToken, true, http.StatusNotFound, nil, nil)
		f.exec(`UPDATE roles SET permissions=$2 WHERE id=$1`, f.role, []string{domain.PermSettings})
		get(target, owner.token, true, http.StatusNotFound, nil, map[string]string{"Range": "bytes=0-7"})
		f.exec(`UPDATE roles SET permissions=$2 WHERE id=$1`, f.role, []string{domain.PermSettings, domain.PermChats})
	})

	t.Run("durable canonical own upload remains actor scoped until attached or retained", func(t *testing.T) {
		for _, state := range []string{"business", "trash", "recovery"} {
			t.Run(state, func(t *testing.T) {
				ownKey, _, _ := f.media(f.account, "uploads", "durable-"+state+".pdf", false)
				ownWant := readObject(ownKey)
				f.exec(`INSERT INTO storage_upload_ownership(account_id,object_key,actor_id,provenance_verified,state,filename) VALUES($1,$2,$3,true,'active','own.pdf')`, f.account, ownKey, f.user)
				ownURL := mediaProxyURLFromObjectKey(ownKey)
				get(ownURL, owner.token, true, http.StatusOK, ownWant, nil)
				get(ownURL, secondSession.token, true, http.StatusOK, ownWant, nil)
				get(ownURL, otherActor.token, true, http.StatusNotFound, nil, nil)
				get(ownURL, otherToken, true, http.StatusNotFound, nil, nil)
				switch state {
				case "business":
					f.exec(`INSERT INTO document_templates(account_id,name,canvas_json) VALUES($1,'Private own draft',jsonb_build_object('backgroundImage',jsonb_build_object('src',$2::text)))`, f.account, ownURL)
				case "trash":
					f.exec(`INSERT INTO storage_media_trash(account_id,object_key,actor_id,filename,media_type,size_bytes,message_backups,purge_after) VALUES($1,$2,$3,'own.pdf','document',$4,'[]',NOW()+INTERVAL '7 days')`, f.account, ownKey, f.user, len(ownWant))
				case "recovery":
					f.exec(`UPDATE storage_upload_ownership SET state='removed' WHERE account_id=$1 AND object_key=$2`, f.account, ownKey)
				}
				get(ownURL, owner.token, true, http.StatusNotFound, nil, nil)
			})
		}
	})
	t.Run("historical document images read before saving with current authority", func(t *testing.T) {
		previousURL := f.server.cfg.PublicURL
		f.server.cfg.PublicURL = "https://clarin.test.invalid"
		defer func() {
			f.server.cfg.PublicURL = previousURL
			f.exec(`UPDATE roles SET permissions=$2 WHERE id=$1`, f.role, []string{domain.PermSettings, domain.PermChats})
		}()
		f.exec(`UPDATE roles SET permissions=$2 WHERE id=$1`, f.role, []string{domain.PermSettings, domain.PermDocuments})
		var pngBytes bytes.Buffer
		if err := png.Encode(&pngBytes, image.NewRGBA(image.Rect(0, 0, 2, 3))); err != nil {
			t.Fatal(err)
		}
		seed := func(name, slot string, documentAccount uuid.UUID, host, folder string) (string, uuid.UUID) {
			t.Helper()
			assetKey, _, _ := f.media(documentAccount, folder, name+".png", false)
			if _, err := store.UploadObject(ctx, assetKey, pngBytes.Bytes(), "image/png"); err != nil {
				t.Fatal(err)
			}
			absolute := host + mediaProxyURLFromObjectKey(assetKey)
			canvas := map[string]any{"fabricJson": map[string]any{"objects": []any{map[string]any{"type": "Image", "src": absolute}}}}
			thumbnail := ""
			switch slot {
			case "background":
				canvas = map[string]any{"background": map[string]any{"imageUrl": absolute}}
			case "pattern":
				canvas = map[string]any{"fabricJson": map[string]any{"objects": []any{map[string]any{"type": "Rect", "fill": map[string]any{"type": "pattern", "source": absolute}}}}}
			case "thumbnail":
				canvas, thumbnail = map[string]any{}, absolute
			case "text":
				canvas = map[string]any{"fabricJson": map[string]any{"objects": []any{map[string]any{"type": "Textbox", "text": absolute}}}}
			}
			encoded, err := json.Marshal(canvas)
			if err != nil {
				t.Fatal(err)
			}
			documentID := uuid.New()
			f.exec(`INSERT INTO document_templates(id,account_id,name,canvas_json,thumbnail_url) VALUES($1,$2,'Historical image QA',$3::jsonb,$4)`, documentID, documentAccount, encoded, thumbnail)
			return assetKey, documentID
		}
		for _, slot := range []string{"src", "background", "pattern", "thumbnail"} {
			t.Run(slot, func(t *testing.T) {
				assetKey, documentID := seed(slot, slot, f.account, f.server.cfg.PublicURL, "documents")
				proxy := mediaProxyURLFromObjectKey(assetKey)
				if h := getAt(t, proxy, owner.token, true, http.StatusOK, pngBytes.Bytes(), nil); h.Get("Content-Type") != "image/png" {
					t.Fatal("historical image did not retain its PNG content type")
				}
				getAt(t, proxy, otherToken, true, http.StatusNotFound, nil, nil)
				f.exec(`UPDATE roles SET permissions=$2 WHERE id=$1`, f.role, []string{domain.PermSettings})
				getAt(t, proxy, owner.token, true, http.StatusNotFound, nil, nil)
				f.exec(`UPDATE roles SET permissions=$2 WHERE id=$1`, f.role, []string{domain.PermSettings, domain.PermDocuments})
				getAt(t, proxy, owner.token, true, http.StatusOK, pngBytes.Bytes(), nil)
				var historical bool
				if err := db.QueryRow(ctx, `SELECT position($3::text IN jsonb_build_array(canvas_json,thumbnail_url)::text)>0 FROM document_templates WHERE id=$1 AND account_id=$2`, documentID, f.account, f.server.cfg.PublicURL).Scan(&historical); err != nil || !historical {
					t.Fatal("media read changed the historical document instead of authorizing its original asset")
				}
				f.exec(`DELETE FROM document_templates WHERE id=$1 AND account_id=$2`, documentID, f.account)
				getAt(t, proxy, owner.token, true, http.StatusNotFound, nil, nil)
			})
		}
		for _, negative := range []struct {
			name, slot, host, folder string
			foreign                  bool
		}{
			{"foreign_document", "src", "https://clarin.test.invalid", "documents", true},
			{"external_host", "src", "https://foreign.invalid", "documents", false},
			{"text_only", "text", "https://clarin.test.invalid", "documents", false},
			{"protected", "src", "https://clarin.test.invalid", "_private/tasks/attachments", false},
		} {
			t.Run(negative.name, func(t *testing.T) {
				account := f.account
				if negative.foreign {
					account = f.other
				}
				assetKey, _ := seed(negative.name, negative.slot, account, negative.host, negative.folder)
				getAt(t, mediaProxyURLFromObjectKey(assetKey), owner.token, true, http.StatusNotFound, nil, nil)
			})
		}
		t.Run("retained", func(t *testing.T) {
			assetKey, _ := seed("retained", "src", f.account, f.server.cfg.PublicURL, "documents")
			f.exec(`INSERT INTO storage_media_trash(account_id,object_key,actor_id,filename,media_type,size_bytes,message_backups,purge_after) VALUES($1,$2,$3,'history.png','image',$4,'[]',NOW()+INTERVAL '7 days')`, f.account, assetKey, f.user, pngBytes.Len())
			getAt(t, mediaProxyURLFromObjectKey(assetKey), owner.token, true, http.StatusNotFound, nil, nil)
		})
	})
	t.Run("legacy URL-only references preserve encoded filenames and authority", func(t *testing.T) {
		for _, name := range []string{"Historia 17.11.41.mp4", "Niñez y canción.jpeg", "6392_0216(1)1.mp4", "la historia).mp4", "a+b.jpeg", "literal%20espacio.jpeg", "100% listo.jpeg", "pregunta?.jpeg", "fragmento#.jpeg", "una \"cita\".jpeg", "signos'\"]}.jpeg", "una \"cita\" & <foto>.jpeg", "separadores \"línea\" \u2028 y \u2029.jpeg"} {
			t.Run(name, func(t *testing.T) {
				mediaKey, _, message := f.media(f.account, "legacy", name, true)
				wantBytes := readObject(mediaKey)
				proxy := mediaProxyURLFromObjectKey(mediaKey)
				persisted := proxy
				if !strings.ContainsAny(name, "%?#") {
					// Historical rows stored spaces, Unicode and parentheses in
					// the URL itself, without a normalized media_asset_id.
					persisted = "/api/media/file/" + mediaKey
				}
				f.exec(`UPDATE messages SET media_asset_id=NULL,media_url=$3 WHERE account_id=$1 AND id=$2`, f.account, message, persisted)
				get(proxy, owner.token, true, http.StatusOK, wantBytes, nil)
				get(proxy, otherToken, true, http.StatusNotFound, nil, nil)
				get(proxy, "", false, http.StatusNotFound, nil, nil)
				f.exec(`UPDATE roles SET permissions=$2 WHERE id=$1`, f.role, []string{domain.PermSettings})
				get(proxy, owner.token, true, http.StatusNotFound, nil, nil)
				f.exec(`UPDATE roles SET permissions=$2 WHERE id=$1`, f.role, []string{domain.PermSettings, domain.PermChats})
				get(proxy, owner.token, true, http.StatusOK, wantBytes, nil)
			})
		}
	})
	t.Run("a missing provider object does not erase its authorized reference", func(t *testing.T) {
		mediaKey, _, message := f.media(f.account, "legacy", "Objeto ausente.jpeg", true)
		f.expectObject(mediaKey, true)
		if err := store.DeleteFile(ctx, mediaKey); err != nil {
			t.Fatal(err)
		}
		get(mediaProxyURLFromObjectKey(mediaKey), owner.token, true, http.StatusNotFound, nil, nil)
		f.expectMessage(message, false)
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
		get(raw, otherActor.token, true, http.StatusServiceUnavailable, nil, nil)
	})
}
