package api

// These checks deliberately require PostgreSQL queries even though they do not
// require object storage. They catch schema/column/parameter regressions that
// pure authorization helpers and successful compilation cannot detect.
import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
	"github.com/naperu/clarin/pkg/config"
	"github.com/naperu/clarin/pkg/database"
)

func TestMediaAccessSQLIntegration(t *testing.T) {
	if os.Getenv("CLARIN_RUN_MEDIA_ACCESS_SQL_INTEGRATION") != "1" {
		t.Skip("requires explicit disposable SQL integration opt-in")
	}
	var db *pgxpool.Pool
	if os.Getenv("CLARIN_STORAGE_QA_PGLITE") == "1" {
		parsed, err := url.Parse(os.Getenv("DATABASE_URL"))
		if err != nil || parsed.Hostname() != "127.0.0.1" || parsed.Port() != "15439" || parsed.Path != "/clarin_storage_qa" {
			t.Fatal("dedicated loopback PGlite endpoint required")
		}
		cfg, err := pgxpool.ParseConfig(parsed.String())
		if err != nil {
			t.Fatal(err)
		}
		cfg.MaxConns = 1
		db, err = pgxpool.NewWithConfig(context.Background(), cfg)
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
	} else {
		db = newFunctionalIntegrityIntegrationDB(t, "CLARIN_RUN_MEDIA_ACCESS_SQL_INTEGRATION", "clarin_media_sql_qa_")
	}
	runMediaAccessSQLChecks(t, db)
}

func runMediaAccessSQLChecks(t *testing.T, db *pgxpool.Pool) {
	ctx := context.Background()
	account, other, user, session := uuid.New(), uuid.New(), uuid.New(), uuid.NewString()
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO accounts(id,name) VALUES($1,'Media SQL QA A'),($2,'Media SQL QA B')`, account, other)
	exec(`INSERT INTO users(id,account_id,username,email,password_hash) VALUES($1,$2,$3,$4,'no-login')`, user, account, "media-sql-"+user.String(), user.String()+"@test.invalid")
	server := &Server{repos: repository.NewRepositories(db), cfg: &config.Config{JWTSecret: "disposable-media-sql-qa"}}
	asset, otherAsset := uuid.New(), uuid.New()
	key := account.String() + "/uploads/" + uuid.NewString() + ".png"
	otherKey := other.String() + "/uploads/" + uuid.NewString() + ".png"
	for _, row := range []struct {
		id, account uuid.UUID
		key         string
	}{{asset, account, key}, {otherAsset, other, otherKey}} {
		exec(`INSERT INTO media_assets(id,account_id,content_hash,object_key,media_type,content_type,filename,size_bytes) VALUES($1,$2,$3,$4,'image','image/png','qa.png',100)`, row.id, row.account, row.id.String(), row.key)
		exec(`INSERT INTO storage_objects(account_id,object_key,media_type,content_type,filename,size_bytes,source) VALUES($1,$2,'image','image/png','qa.png',100,'uploads')`, row.account, row.key)
	}
	claims := &service.JWTClaims{AccountID: account, UserID: user, SessionID: session, Role: "member", Permissions: []string{domain.PermBroadcasts}}
	grant := mediaAccessGrant{Purpose: "upload-preview", AccountID: account, UserID: user, SessionID: session, ObjectKey: key, Expires: time.Now().Add(mediaGrantLifetime).Unix()}
	raw := mediaProxyURLFromObjectKey(key)
	draft := raw + "?media_preview=" + signMediaAccessGrant(server.cfg.JWTSecret, grant)
	app := fiber.New()
	app.Post("/assign", func(c *fiber.Ctx) error {
		copied := *claims
		if c.Get("X-QA-Chats") == "yes" {
			copied.Permissions = []string{domain.PermChats}
		}
		if c.Get("X-QA-User") == "other" {
			copied.UserID = uuid.New()
		}
		c.Locals("claims", &copied)
		assetID := asset
		if c.Query("other_asset") == "1" {
			assetID = otherAsset
		}
		var err error
		if c.Query("branding") == "1" {
			err = server.authorizeBrandingPublication(c, domain.SurveyBranding{LogoURL: c.Query("url"), LogoMediaAssetID: &assetID})
		} else {
			err = server.authorizeMediaAssetAssignment(c, &assetID, c.Query("url"))
		}
		if err != nil {
			return mediaPublicationDenied(c, err)
		}
		return c.SendStatus(http.StatusNoContent)
	})
	app.Get("/public-check/*", func(c *fiber.Ctx) error {
		if server.authorizeOrdinaryMedia(c, c.Params("*")) {
			return c.SendStatus(http.StatusNoContent)
		}
		return c.SendStatus(http.StatusNotFound)
	})
	request := func(method, target string, want int, headers map[string]string) {
		t.Helper()
		req := httptest.NewRequest(method, target, nil)
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		res, err := app.Test(req, 15000)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		if res.StatusCode != want {
			t.Fatalf("SQL media boundary returned %d want %d (path %s)", res.StatusCode, want, strings.Split(target, "?")[0])
		}
	}
	assign := func(media string) string { return "/assign?url=" + url.QueryEscape(media) }
	t.Run("draft URL and ID can be assigned before first reference", func(t *testing.T) {
		request(http.MethodPost, assign(draft), http.StatusNoContent, nil)
		request(http.MethodPost, assign(draft)+"&branding=1", http.StatusNoContent, nil)
	})
	t.Run("unknown URL and foreign asset are denied", func(t *testing.T) {
		request(http.MethodPost, assign(raw), http.StatusForbidden, nil)
		request(http.MethodPost, assign(draft)+"&other_asset=1", http.StatusForbidden, nil)
		request(http.MethodPost, assign(draft), http.StatusForbidden, map[string]string{"X-QA-User": "other"})
	})
	// Exercise the new UNION query against a real stored message/media relationship.
	chat, contact := uuid.New(), uuid.New()
	exec(`INSERT INTO contacts(id,account_id,jid,name) VALUES($1,$2,$3,'Media SQL QA contact')`, contact, account, contact.String()+"@test.invalid")
	exec(`INSERT INTO chats(id,account_id,jid,contact_id) VALUES($1,$2,$3,$4)`, chat, account, contact.String()+"@test.invalid", contact)
	exec(`INSERT INTO messages(id,account_id,chat_id,message_id,message_type,media_url,media_asset_id,timestamp) VALUES($1,$2,$3,$4,'image',$5,$6,NOW())`, uuid.New(), account, chat, uuid.NewString(), raw, asset)
	t.Run("origin permission is enforced by real SQL references", func(t *testing.T) {
		request(http.MethodPost, assign(raw), http.StatusForbidden, nil)
		request(http.MethodPost, assign(raw), http.StatusNoContent, map[string]string{"X-QA-Chats": "yes"})
	})
	exec(`INSERT INTO storage_media_trash(account_id,object_key,actor_id,filename,media_type,size_bytes,message_backups,purge_after) VALUES($1,$2,$3,'qa.png','image',100,'[]',NOW()+INTERVAL '7 days')`, account, key, user)
	t.Run("trash and purging revoke upload assignment", func(t *testing.T) {
		request(http.MethodPost, assign(draft), http.StatusForbidden, nil)
		exec(`UPDATE storage_media_trash SET state='purging' WHERE account_id=$1 AND object_key=$2`, account, key)
		request(http.MethodPost, assign(draft), http.StatusForbidden, nil)
	})
	exec(`UPDATE storage_media_trash SET state='restored' WHERE account_id=$1 AND object_key=$2`, account, key)
	surveyID := uuid.New()
	exec(`INSERT INTO surveys(id,account_id,name,slug,status,branding) VALUES($1,$2,'Media QA',$3,'active',jsonb_build_object('logo_url',$4::text))`, surveyID, account, "media-sql-"+surveyID.String(), raw)
	survey := &domain.Survey{ID: surveyID, AccountID: account, Branding: domain.SurveyBranding{LogoURL: raw}}
	published := server.publishSurveyBranding(survey).LogoURL
	parsed, _ := url.Parse(published)
	checkURL := "/public-check/" + key + "?media_access=" + url.QueryEscape(parsed.Query().Get("media_access"))
	t.Run("survey publication queries and revocation", func(t *testing.T) {
		request(http.MethodGet, checkURL, http.StatusNoContent, nil)
		exec(`UPDATE surveys SET status='closed' WHERE account_id=$1 AND id=$2`, account, surveyID)
		request(http.MethodGet, checkURL, http.StatusNotFound, nil)
	})
	dynamicID, itemID, linkID := uuid.New(), uuid.New(), uuid.New()
	exec(`INSERT INTO dynamics(id,account_id,type,name,slug,is_active) VALUES($1,$2,'scratch_card','Media SQL QA',$3,true)`, dynamicID, account, "media-sql-"+dynamicID.String())
	exec(`INSERT INTO dynamic_items(id,dynamic_id,image_url,is_active) VALUES($1,$2,$3,true)`, itemID, dynamicID, raw)
	exec(`INSERT INTO dynamic_links(id,dynamic_id,slug,is_active) VALUES($1,$2,$3,true)`, linkID, dynamicID, "media-sql-"+linkID.String())
	dynamicURL := server.publicResourceMediaURL(raw, mediaAccessGrant{Purpose: "dynamic-public", AccountID: account, ResourceID: dynamicID, LinkID: linkID})
	dynamicParsed, _ := url.Parse(dynamicURL)
	dynamicCheck := "/public-check/" + key + "?media_access=" + url.QueryEscape(dynamicParsed.Query().Get("media_access"))
	t.Run("dynamic publication queries and revocation", func(t *testing.T) {
		request(http.MethodGet, dynamicCheck, http.StatusNoContent, nil)
		exec(`UPDATE dynamic_items SET is_active=false WHERE id=$1`, itemID)
		request(http.MethodGet, dynamicCheck, http.StatusNotFound, nil)
		// The overlay branch must use the same key, account and publication rule.
		encoded, _ := json.Marshal(domain.DynamicConfig{OverlayImageURL: raw})
		exec(`UPDATE dynamics SET config=$2 WHERE id=$1`, dynamicID, encoded)
		request(http.MethodGet, dynamicCheck, http.StatusNoContent, nil)
		exec(`UPDATE dynamic_links SET is_active=false WHERE id=$1`, linkID)
		request(http.MethodGet, dynamicCheck, http.StatusNotFound, nil)
	})
}
