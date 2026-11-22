package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/programtransfer"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
	"github.com/naperu/clarin/pkg/config"
	"github.com/naperu/clarin/pkg/database"
)

func TestProgramTransferHTTPRoundTrip(t *testing.T) {
	rawDB := os.Getenv("PROGRAM_TRANSFER_HTTP_TEST_DATABASE_URL")
	if rawDB == "" {
		t.Skip("PROGRAM_TRANSFER_HTTP_TEST_DATABASE_URL requires a disposable PostgreSQL database program_transfer_http_test on loopback")
	}
	settings, err := pgxpool.ParseConfig(rawDB)
	if err != nil || settings.ConnConfig.Database != "program_transfer_http_test" || settings.ConnConfig.Host != "127.0.0.1" {
		t.Fatal("refusing to run the transfer HTTP fixture against a non-disposable PostgreSQL endpoint")
	}
	for _, fallback := range settings.ConnConfig.Fallbacks {
		if fallback.Host != "127.0.0.1" {
			t.Fatal("refusing a non-loopback PostgreSQL fallback")
		}
	}
	// A confirmation that tries to borrow a second connection while holding
	// its import transaction cannot finish with this fixture's pool size.
	settings.MaxConns, settings.MinConns = 1, 0
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	db, err := pgxpool.NewWithConfig(ctx, settings)
	if err != nil {
		t.Fatal("could not open the disposable transfer HTTP database")
	}
	t.Cleanup(db.Close)
	if err := database.Migrate(db); err != nil {
		t.Fatalf("isolated startup migration failed: %v", err)
	}
	planCode := "transfer-" + uuid.NewString()
	if _, err := db.Exec(ctx, `INSERT INTO plans(code,name,is_public) VALUES($1,'Synthetic transfer plan',FALSE)`, planCode); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := db.Exec(context.Background(), `DELETE FROM plans WHERE code=$1`, planCode); err != nil {
			t.Error(err)
		}
	})
	if _, err := db.Exec(ctx, `INSERT INTO plan_entitlements(plan_code,key,value_json) VALUES($1,'max_contacts','1'::jsonb)`, planCode); err != nil {
		t.Fatal(err)
	}
	a, b := transferActor(domain.PermPrograms, domain.PermContacts), transferActor(domain.PermPrograms, domain.PermContacts)
	for _, actor := range []*service.JWTClaims{a, b} {
		if _, err := db.Exec(ctx, `INSERT INTO accounts(id,name) VALUES($1,'Synthetic transfer HTTP account')`, actor.AccountID); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			if _, err := db.Exec(context.Background(), `DELETE FROM accounts WHERE id=$1`, actor.AccountID); err != nil {
				t.Error(err)
			}
		})
		if _, err := db.Exec(ctx, `INSERT INTO users(id,account_id,username,email,password_hash) VALUES($1,$2,$3,$4,'test-only-hash')`, actor.UserID, actor.AccountID, actor.UserID.String(), actor.UserID.String()+"@test.invalid"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(ctx, `INSERT INTO subscriptions(account_id,plan_code,status) VALUES($1,$2,'active')`, b.AccountID, planCode); err != nil {
		t.Fatal(err)
	}
	occupied := uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO contacts(id,account_id,jid,name) VALUES($1,$2,$3,'Synthetic quota occupant')`, occupied, b.AccountID, occupied.String()+"@test.invalid"); err != nil {
		t.Fatal(err)
	}
	program, contact := uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO programs(id,account_id,type,name,status) VALUES($1,$2,'course','Synthetic HTTP program','active')`, program, a.AccountID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO contacts(id,account_id,jid,name) VALUES($1,$2,$3,'Synthetic HTTP participant')`, contact, a.AccountID, contact.String()+"@test.invalid"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO program_participants(program_id,contact_id,status,enrolled_at) VALUES($1,$2,'active','2026-11-01')`, program, contact); err != nil {
		t.Fatal(err)
	}
	repos := repository.NewRepositories(db)
	server := &Server{repos: repos, services: service.NewServices(repos, nil, nil), cfg: &config.Config{JWTSecret: uuid.NewString()}}
	app := fiber.New()
	group := app.Group("/api/programs", func(c *fiber.Ctx) error {
		actor := a
		if c.Get("X-Synthetic-Account") == "b" {
			actor = b
		}
		copy := *actor
		if c.Get("X-Synthetic-Session") == "changed" {
			copy.SessionID = "other-synthetic-session"
		}
		c.Locals("claims", &copy)
		return c.Next()
	}, server.requirePermission(domain.PermPrograms))
	group.Post("/transfer/preview", server.handlePreviewProgramTransfer)
	group.Post("/transfer/confirm", server.handleConfirmProgramTransfer)
	group.Get("/:id/transfer/export", server.handleExportProgramTransfer)
	request := func(method, path, account, session string, body any, status int) (http.Header, []byte) {
		t.Helper()
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(method, "/api/programs"+path, bytes.NewReader(raw))
		req.Header.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSON)
		req.Header.Set("X-Synthetic-Account", account)
		req.Header.Set("X-Synthetic-Session", session)
		res, err := app.Test(req, 15000)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		output, err := io.ReadAll(res.Body)
		if err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != status {
			t.Fatalf("%s %s: got HTTP %d, expected %d", method, path, res.StatusCode, status)
		}
		if actual := res.Header.Get(fiber.HeaderCacheControl); actual != "private, no-store" {
			t.Fatalf("unexpected transfer cache policy %q", actual)
		}
		return res.Header, output
	}
	exportPath := "/" + program.String() + "/transfer/export"
	request(http.MethodGet, exportPath, "b", "", nil, 404)
	headers, exported := request(http.MethodGet, exportPath, "a", "", nil, 200)
	if !strings.HasPrefix(headers.Get(fiber.HeaderContentDisposition), `attachment; filename="programa-`) {
		t.Fatal("export is not an attachment")
	}
	var file programtransfer.File
	if err := json.Unmarshal(exported, &file); err != nil || len(file.Records) < 3 {
		t.Fatal("download did not include the synthetic program, participant and contact")
	}
	in := programtransfer.Request{File: file}
	_, prepared := request(http.MethodPost, "/transfer/preview", "b", "", in, 200)
	var preview programtransfer.Preview
	if err := json.Unmarshal(prepared, &preview); err != nil || preview.Token == "" || preview.Summary.Create < 3 || preview.Digest != "" {
		t.Fatal("preview did not stage an import without exposing the snapshot binding")
	}
	confirm := programtransfer.ConfirmRequest{Request: in, Token: preview.Token}
	request(http.MethodPost, "/transfer/confirm", "b", "changed", confirm, 409)
	_, overLimit := request(http.MethodPost, "/transfer/confirm", "b", "", confirm, 409)
	var problem struct{ Code string }
	if err := json.Unmarshal(overLimit, &problem); err != nil || problem.Code != "program_transfer_contact_limit" {
		t.Fatal("confirmation did not apply the live destination contact quota")
	}
	var programs, heldLocks int
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM programs WHERE account_id=$1`, b.AccountID).Scan(&programs); err != nil || programs != 0 {
		t.Fatalf("over-quota confirmation must not create a program; got %d (%v)", programs, err)
	}
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()`).Scan(&heldLocks); err != nil || heldLocks != 0 {
		t.Fatalf("failed confirmation returned an advisory lock to the pool: %d (%v)", heldLocks, err)
	}
	if _, err := db.Exec(ctx, `DELETE FROM contacts WHERE account_id=$1 AND id=$2`, b.AccountID, occupied); err != nil {
		t.Fatal(err)
	}
	_, applied := request(http.MethodPost, "/transfer/confirm", "b", "", confirm, 200)
	var result programtransfer.Result
	if err := json.Unmarshal(applied, &result); err != nil || result.ProgramID == "" || result.ProgramID == program.String() {
		t.Fatal("confirm did not assign a local destination program identity")
	}
	destination, err := uuid.Parse(result.ProgramID)
	if err != nil {
		t.Fatal("confirm returned an invalid destination program identity")
	}
	request(http.MethodGet, "/"+result.ProgramID+"/transfer/export", "a", "", nil, 404)
	request(http.MethodGet, "/"+result.ProgramID+"/transfer/export", "b", "", nil, 200)
	var participantCount int
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM program_participants pp JOIN contacts c ON c.id=pp.contact_id WHERE pp.program_id=$1 AND c.account_id=$2`, destination, b.AccountID).Scan(&participantCount); err != nil || participantCount != 1 {
		t.Fatalf("destination must have exactly one same-account participant; got %d (%v)", participantCount, err)
	}
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()`).Scan(&heldLocks); err != nil || heldLocks != 0 {
		t.Fatalf("successful confirmation returned an advisory lock to the pool: %d (%v)", heldLocks, err)
	}
}
