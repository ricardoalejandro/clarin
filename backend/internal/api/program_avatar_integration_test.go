package api

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"mime/multipart"
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
	"github.com/naperu/clarin/internal/storage"
	"github.com/naperu/clarin/pkg/database"
)

func TestProgramAvatarHTTPRoundtrip(t *testing.T) {
	if os.Getenv("CLARIN_RUN_CONTACT_MEDIA_INTEGRATION") != "1" {
		t.Skip("requires disposable PostgreSQL and MinIO")
	}
	u, err := url.Parse(os.Getenv("INTEGRITY_TEST_DATABASE_URL"))
	if err != nil || u.Hostname() != "127.0.0.1" || u.Path != "/program_survey_integrity_test" || os.Getenv("MINIO_ENDPOINT") != storageQAMinioEndpoint(t) {
		t.Fatal("isolated loopback services required")
	}
	ctx := context.Background()
	db, err := pgxpool.New(ctx, u.String())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err = database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	store, err := storage.New(storage.Config{Endpoint: os.Getenv("MINIO_ENDPOINT"), AccessKey: os.Getenv("MINIO_ACCESS_KEY"), SecretKey: os.Getenv("MINIO_SECRET_KEY"), Bucket: os.Getenv("MINIO_BUCKET")})
	if err != nil {
		t.Fatal("isolated storage unavailable")
	}
	account, foreign, program := uuid.New(), uuid.New(), uuid.New()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO accounts(id,name)VALUES($1,'Synthetic avatar HTTP'),($2,'Synthetic foreign account')`, account, foreign)
	exec(`INSERT INTO programs(id,account_id,name,type)VALUES($1,$2,'Synthetic photo group','course')`, program, account)
	defer func() {
		exec(`UPDATE programs SET avatar_media_asset_id=NULL WHERE account_id=$1`, account)
		objects, _ := store.ListPrefix(ctx, account.String()+"/")
		for _, object := range objects {
			_ = store.DeleteFile(ctx, object.Key)
		}
		exec(`DELETE FROM accounts WHERE id=ANY($1::uuid[])`, []uuid.UUID{account, foreign})
	}()
	repos := repository.NewRepositories(db)
	s := &Server{repos: repos, storage: store}
	actor, permission := account, domain.PermPrograms
	app := fiber.New(fiber.Config{BodyLimit: 10 << 20})
	app.Use(func(c *fiber.Ctx) error {
		c.Locals("account_id", actor)
		c.Locals("claims", &service.JWTClaims{AccountID: actor, Permissions: []string{permission}})
		return c.Next()
	})
	routes := app.Group("/api/programs", s.requirePermission(domain.PermPrograms))
	routes.Post("/:id/avatar", s.handleUploadProgramAvatar)
	routes.Get("/:id/avatar/content", s.handleGetProgramAvatarContent)
	routes.Delete("/:id/avatar", s.handleDeleteProgramAvatar)
	request := func(method, path string, data []byte, contentType string) (int, []byte) {
		t.Helper()
		req := httptest.NewRequest(method, path, bytes.NewReader(data))
		req.Header.Set("Content-Type", contentType)
		res, err := app.Test(req, 10000)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		body, _ := io.ReadAll(res.Body)
		return res.StatusCode, body
	}
	base := "/api/programs/" + program.String() + "/avatar"
	upload := func(revision string, data []byte) (int, []byte) {
		var body bytes.Buffer
		w := multipart.NewWriter(&body)
		part, _ := w.CreateFormFile("file", "synthetic.png")
		_, _ = part.Write(data)
		_ = w.WriteField("expected_revision", revision)
		_ = w.Close()
		return request("POST", base, body.Bytes(), w.FormDataContentType())
	}
	var original bytes.Buffer
	_ = png.Encode(&original, image.NewRGBA(image.Rect(0, 0, 800, 1200)))
	if status, _ := upload("", original.Bytes()); status != 400 {
		t.Fatalf("missing revision=%d", status)
	}
	if status, _ := upload("0", []byte("not an image")); status != 400 {
		t.Fatalf("invalid MIME=%d", status)
	}
	if status, _ := upload("0", make([]byte, (8<<20)+1)); status != 413 {
		t.Fatalf("oversized image=%d", status)
	}
	status, body := upload("0", original.Bytes())
	var saved domain.Program
	_ = json.Unmarshal(body, &saved)
	if status != 200 || saved.AvatarRevision != 1 || saved.AvatarURL == nil || saved.ID != program {
		t.Fatalf("save=%d %s", status, body)
	}
	status, body = request("GET", base+"/content?v=1", nil, "")
	cfg, format, err := image.DecodeConfig(bytes.NewReader(body))
	if status != 200 || err != nil || format != "jpeg" || cfg.Width != 512 || cfg.Height != 512 || len(body) > 250*1024 {
		t.Fatalf("normalized content=%d %s %v", status, format, err)
	}
	key, _, err := repos.Program.AvatarContent(ctx, account, program)
	if err != nil {
		t.Fatal(err)
	}
	refs, err := storageSelfServiceObjectReferences(ctx, db, account, key, store)
	if err != nil || len(refs) != 1 || refs[0].Origin != "programs" {
		t.Fatalf("storage reference visibility: %#v %v", refs, err)
	}
	uses, err := s.storageSelfServiceListUses(ctx, db, storageUseActor{AccountID: account, Claims: &service.JWTClaims{Permissions: []string{domain.PermPrograms, domain.PermSettings}}}, key)
	if err != nil || len(uses) != 1 || uses[0].CanRemove || uses[0].Adapter != "protected" {
		t.Fatalf("storage must defer edits to Program: %#v %v", uses, err)
	}
	indexCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err = s.ReconcileStorageInventory(indexCtx, account); err != nil {
		t.Fatalf("program image inventory: %v", err)
	}
	for _, granted := range []bool{true, false} {
		permissions := []string{domain.PermContacts}
		if granted {
			permissions = []string{domain.PermPrograms}
		}
		_, allowed, err := s.storageAuthorizeContent(ctx, storageUseActor{AccountID: account, Claims: &service.JWTClaims{Permissions: permissions}}, key)
		if err != nil || allowed != granted {
			t.Fatalf("indexed Program photo authorization granted=%t allowed=%t err=%v", granted, allowed, err)
		}
	}
	permission = domain.PermContacts
	if status, _ := request("GET", base+"/content", nil, ""); status != 403 {
		t.Fatalf("missing module permission=%d", status)
	}
	permission = domain.PermPrograms
	actor = foreign
	if status, _ := request("GET", base+"/content", nil, ""); status != 404 {
		t.Fatalf("foreign content=%d", status)
	}
	actor = account
	if status, body := request("DELETE", base, []byte(`{"expected_revision":0}`), "application/json"); status != 409 || !strings.Contains(string(body), "PROGRAM_AVATAR_CONFLICT") {
		t.Fatalf("stale removal=%d %s", status, body)
	}
	if status, _ := request("DELETE", base, []byte(`{"expected_revision":1}`), "application/json"); status != 200 {
		t.Fatalf("remove=%d", status)
	}
	if status, _ := request("GET", base+"/content", nil, ""); status != 404 {
		t.Fatalf("removed content=%d", status)
	}
}
