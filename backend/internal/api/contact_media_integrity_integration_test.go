package api

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"mime/multipart"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
	"github.com/naperu/clarin/internal/storage"
	"github.com/naperu/clarin/pkg/database"
)

func TestContactMediaIntegrityAllContexts(t *testing.T) {
	if os.Getenv("CLARIN_RUN_CONTACT_MEDIA_INTEGRATION") != "1" {
		t.Skip("requires disposable PostgreSQL and MinIO")
	}
	u, err := url.Parse(os.Getenv("DATABASE_URL"))
	if err != nil || u.Path != "/program_survey_integrity_test" || os.Getenv("MINIO_ENDPOINT") != "127.0.0.1:19001" {
		t.Fatal("exact isolated QA services required")
	}
	ctx := context.Background()
	adminURL := *u
	adminURL.Path = "/postgres"
	admin, err := pgxpool.New(ctx, adminURL.String())
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	name := "clarin_contact_media_qa_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err = admin.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = admin.Exec(ctx, "DROP DATABASE "+name+" WITH (FORCE)") }()
	u.Path = "/" + name
	db, err := pgxpool.New(ctx, u.String())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err = database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	store, err := storage.New(storage.Config{Endpoint: os.Getenv("MINIO_ENDPOINT"), AccessKey: os.Getenv("MINIO_ACCESS_KEY"), SecretKey: os.Getenv("MINIO_SECRET_KEY"), Bucket: os.Getenv("MINIO_BUCKET"), PublicURL: os.Getenv("MINIO_PUBLIC_URL")})
	if err != nil {
		t.Fatal("isolated storage unavailable")
	}
	repos := repository.NewRepositories(db)
	s := &Server{repos: repos, services: &service.Services{ContactProfile: service.NewContactProfileService(repos)}, storage: store}
	account, contact, user := uuid.New(), uuid.New(), uuid.New()
	chat, lead, event, participant, program, enrollment := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO accounts(id,name) VALUES($1,'Synthetic media QA')`, account)
	exec(`INSERT INTO users(id,account_id,username,email,password_hash) VALUES($1,$2,$3,$4,'not-a-login')`, user, account, "media-"+user.String(), user.String()+"@test.invalid")
	exec(`INSERT INTO contacts(id,account_id,jid,name) VALUES($1,$2,$3,'Synthetic shared identity')`, contact, account, contact.String()+"@test.invalid")
	// A historical chat without a device must still support manual profile media.
	exec(`INSERT INTO chats(id,account_id,contact_id,jid) VALUES($1,$2,$3,$4)`, chat, account, contact, contact.String()+"@test.invalid")
	exec(`INSERT INTO leads(id,account_id,contact_id,title,jid) VALUES($1,$2,$3,'Synthetic opportunity',$4)`, lead, account, contact, contact.String()+"@test.invalid")
	exec(`INSERT INTO events(id,account_id,name) VALUES($1,$2,'Synthetic event')`, event, account)
	exec(`INSERT INTO event_participants(id,event_id,contact_id,name) VALUES($1,$2,$3,'Synthetic participant')`, participant, event, contact)
	exec(`INSERT INTO programs(id,account_id,name,type) VALUES($1,$2,'Synthetic classes','course')`, program, account)
	exec(`INSERT INTO program_participants(id,program_id,contact_id) VALUES($1,$2,$3)`, enrollment, program, contact)
	app := fiber.New()
	app.Use(func(c *fiber.Ctx) error {
		c.Locals("account_id", account)
		c.Locals("user_id", user)
		c.Locals("claims", &service.JWTClaims{AccountID: account, UserID: user, Role: "admin", Permissions: []string{"*"}})
		return c.Next()
	})
	app.Get("/api/contact-profiles/:contactId", s.handleGetContactProfile)
	app.Get("/api/contact-avatars/:id", s.handleGetContactAvatar)
	app.Post("/api/contact-avatars/:id/upload", s.handleUploadContactAvatar)
	app.Delete("/api/contact-avatars/:id", s.handleDeleteContactAvatar)
	contexts := []struct {
		kind string
		id   uuid.UUID
	}{{"contact", contact}, {"chat", chat}, {"lead", lead}, {"event_participant", participant}, {"program_participant", enrollment}}
	imageBytes := func(format string, shade uint8) []byte {
		var b bytes.Buffer
		img := image.NewRGBA(image.Rect(0, 0, 32, 32))
		for y := 0; y < 32; y++ {
			for x := 0; x < 32; x++ {
				img.Set(x, y, color.RGBA{shade, 120, 200, 255})
			}
		}
		if format == "png" {
			_ = png.Encode(&b, img)
		} else {
			_ = jpeg.Encode(&b, img, nil)
		}
		return b.Bytes()
	}
	request := func(method, path string, payload []byte, contentType string) (int, map[string]any) {
		t.Helper()
		req := httptest.NewRequest(method, path, bytes.NewReader(payload))
		if contentType != "" {
			req.Header.Set("Content-Type", contentType)
		}
		res, err := app.Test(req, 10000)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var data map[string]any
		_ = json.NewDecoder(res.Body).Decode(&data)
		return res.StatusCode, data
	}
	upload := func(kind string, id uuid.UUID, data []byte) (int, map[string]any) {
		var b bytes.Buffer
		w := multipart.NewWriter(&b)
		file, _ := w.CreateFormFile("image", "synthetic.png")
		_, _ = file.Write(data)
		_ = w.WriteField("context_type", kind)
		_ = w.WriteField("context_id", id.String())
		_ = w.Close()
		return request("POST", "/api/contact-avatars/"+contact.String()+"/upload", b.Bytes(), w.FormDataContentType())
	}
	defer func() {
		rows, err := db.Query(ctx, `SELECT object_key FROM media_assets WHERE account_id=$1`, account)
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var key string
				_ = rows.Scan(&key)
				_ = store.DeleteFile(ctx, key)
			}
		}
	}()
	for _, surface := range contexts {
		for _, format := range []string{"png", "jpeg"} {
			status, data := upload(surface.kind, surface.id, imageBytes(format, 60))
			if status != 200 || data["avatar"] == nil {
				t.Fatalf("manual %s %s failed status=%d response=%v", surface.kind, format, status, data)
			}
		}
		query := "?context_type=" + surface.kind + "&context_id=" + surface.id.String()
		status, profile := request("GET", "/api/contact-profiles/"+contact.String()+query, nil, "")
		if status != 200 || profile["contact"] == nil {
			t.Fatalf("profile %s failed: %d %v", surface.kind, status, profile)
		}
		status, metadata := request("GET", "/api/contact-avatars/"+contact.String()+query, nil, "")
		if status != 200 || metadata["avatar"] == nil {
			t.Fatalf("avatar reload %s failed", surface.kind)
		}
	}
	var key string
	if err = db.QueryRow(ctx, `SELECT ma.object_key FROM contacts c JOIN media_assets ma ON ma.id=c.avatar_media_asset_id AND ma.account_id=c.account_id JOIN storage_objects so ON so.account_id=ma.account_id AND so.object_key=ma.object_key WHERE c.account_id=$1 AND c.id=$2`, account, contact).Scan(&key); err != nil || !strings.HasPrefix(key, account.String()+"/") {
		t.Fatal("photo inventory/account boundary missing")
	}
	if bytes, err := store.GetFile(ctx, key); err != nil || len(bytes) == 0 {
		t.Fatal("stored image unreadable")
	}
	if status, _ := upload("chat", uuid.New(), imageBytes("png", 80)); status != 404 {
		t.Fatal("foreign context accepted")
	}
	if status, _ := upload("chat", chat, []byte("invalid image")); status != 422 {
		t.Fatal("invalid image accepted")
	}
	status, data := request("DELETE", "/api/contact-avatars/"+contact.String()+"?context_type=chat&context_id="+chat.String(), nil, "")
	if status != 200 || data["avatar"].(map[string]any)["avatar_url"] != nil {
		t.Fatal("canonical photo clear lost")
	}
	exec(`UPDATE accounts SET storage_limit_bytes=1 WHERE id=$1`, account)
	if status, _ := upload("chat", chat, imageBytes("png", 90)); status != 507 {
		t.Fatalf("quota status=%d expected507", status)
	}
}
