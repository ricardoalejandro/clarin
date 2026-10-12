package api

import (
	"bytes"
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
	"github.com/naperu/clarin/pkg/cache"
	"github.com/naperu/clarin/pkg/config"
	"github.com/naperu/clarin/pkg/database"
	"golang.org/x/crypto/bcrypt"
)

// This complements repository concurrency tests with actual HTTP handlers,
// password login, signed JWTs, Redis sessions and canonical SQL authorization.
// Only explicitly configured disposable databases and loopback Redis qualify.
func TestTaskIntegrityHTTPResponseLossAndRepeatedStartupMigration(t *testing.T) {
	raw := os.Getenv("TASK_INTEGRITY_TEST_DATABASE_URL")
	if raw == "" {
		t.Skip("TASK_INTEGRITY_TEST_DATABASE_URL requires isolated synthetic QA database")
	}
	dbConfig, err := pgxpool.ParseConfig(raw)
	if err != nil {
		t.Fatal("invalid QA database configuration")
	}
	if !strings.Contains(dbConfig.ConnConfig.Database, "test") && !strings.Contains(dbConfig.ConnConfig.Database, "qa") {
		t.Fatal("refusing non-QA database")
	}
	redisURL, err := url.Parse(os.Getenv("TASK_INTEGRITY_TEST_REDIS_URL"))
	if err != nil || redisURL.Scheme != "redis" || redisURL.Hostname() != "127.0.0.1" || redisURL.Port() != "16389" {
		t.Fatal("TASK_INTEGRITY_TEST_REDIS_URL must be disposable loopback Redis on port 16389")
	}
	ctx := context.Background()
	db, err := pgxpool.NewWithConfig(ctx, dbConfig)
	if err != nil {
		t.Fatal("connect QA database")
	}
	t.Cleanup(db.Close)
	if err := database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	redisCache, err := cache.New(redisURL.String())
	if err != nil {
		t.Fatal("connect disposable task session cache")
	}
	t.Cleanup(func() { _ = redisCache.Close() })
	repos := repository.NewRepositories(db)
	s := &Server{repos: repos, services: service.NewServices(repos, nil, nil), cache: redisCache,
		cfg: &config.Config{JWTSecret: "disposable-task-integrity-" + uuid.NewString()}}
	s.services.Auth.SetCache(redisCache)
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	type actor struct {
		account, user, environment, list, status uuid.UUID
		token                                    string
	}
	newActor := func() actor {
		t.Helper()
		a := actor{account: uuid.New(), user: uuid.New(), environment: uuid.New(), list: uuid.New(), status: uuid.New()}
		workflow := uuid.New()
		password := "disposable-task-login-" + uuid.NewString()
		hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.MinCost)
		if err != nil {
			t.Fatal(err)
		}
		exec(`INSERT INTO accounts(id,name) VALUES($1,'HTTP task QA')`, a.account)
		exec(`INSERT INTO users(id,account_id,username,email,password_hash,display_name,role,is_active) VALUES($1,$2,$3,$4,$5,'Synthetic HTTP actor','agent',TRUE)`, a.user, a.account, a.user.String(), a.user.String()+"@test.invalid", string(hash))
		exec(`INSERT INTO user_accounts(user_id,account_id,role,is_default) VALUES($1,$2,'admin',TRUE)`, a.user, a.account)
		exec(`INSERT INTO task_environments(id,account_id,name,visibility,default_access_level,created_by) VALUES($1,$2,'HTTP QA','account','edit',$3)`, a.environment, a.account, a.user)
		exec(`INSERT INTO task_workflows(id,account_id,environment_id,name,is_default,created_by) VALUES($1,$2,$3,'HTTP flow',TRUE,$4)`, workflow, a.account, a.environment, a.user)
		exec(`INSERT INTO task_statuses(id,account_id,workflow_id,name,color,category,sort_order,is_default) VALUES($1,$2,$3,'Open','#64748B','not_started',0,TRUE)`, a.status, a.account, workflow)
		exec(`INSERT INTO task_lists(id,account_id,environment_id,workflow_id,name,created_by) VALUES($1,$2,$3,$4,'HTTP list',$5)`, a.list, a.account, a.environment, workflow, a.user)
		token, refresh, _, _, _, err := s.services.Auth.Login(ctx, a.user.String(), password, s.cfg.JWTSecret,
			service.OfflineReauthIdentity{UserID: a.user, AccountID: a.account})
		if err != nil {
			t.Fatalf("real password login: %v", err)
		}
		claims, err := s.services.Auth.ValidateTokenReadOnly(ctx, token, s.cfg.JWTSecret)
		if err != nil || claims == nil || claims.AccountID != a.account || claims.UserID != a.user {
			t.Fatal("login did not establish the requested canonical account identity")
		}
		t.Cleanup(func() {
			s.services.Auth.Logout(ctx, claims, refresh)
			_ = redisCache.Del(ctx, "jwtblk:"+claims.ID, "userinv:"+a.user.String(), "usersessinv:"+a.user.String())
		})
		a.token = token
		return a
	}
	first, second := newActor(), newActor()
	app := fiber.New()
	t.Cleanup(func() { _ = app.Shutdown() })
	group := app.Group("/api/tasks", s.authMiddleware, s.requirePermission(domain.PermTasks))
	group.Post("/", s.handleCreateTask)
	group.Get("/:id", s.handleGetTask)
	request := func(method, path string, body any, token string) *http.Response {
		t.Helper()
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(method, path, bytes.NewReader(raw))
		req.Header.Set("Content-Type", "application/json")
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		response, err := app.Test(req, 15000)
		if err != nil {
			t.Fatal(err)
		}
		return response
	}
	call := func(method, path string, body any, token string, wantStatus int) map[string]any {
		t.Helper()
		response := request(method, path, body, token)
		defer response.Body.Close()
		var result map[string]any
		if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != wantStatus {
			t.Fatalf("%s %s status %d, want %d: %v", method, path, response.StatusCode, wantStatus, result)
		}
		return result
	}
	operation := uuid.New()
	payload := func(a actor) map[string]any {
		return map[string]any{"title": "Once over HTTP", "list_id": a.list, "status_id": a.status,
			"assigned_to": a.user, "due_at": time.Now().UTC().Add(48 * time.Hour).Format(time.RFC3339),
			"reminder_minutes": 30, "operation_id": operation}
	}
	firstPayload, secondPayload := payload(first), payload(second)
	call("POST", "/api/tasks", firstPayload, "", http.StatusUnauthorized)
	// Commit successfully, then lose the entire HTTP response before decoding it.
	// The client retries its exact frozen payload and operation ID afterwards.
	lost := request("POST", "/api/tasks", firstPayload, first.token)
	_ = lost.Body.Close()
	if lost.StatusCode != http.StatusOK {
		t.Fatalf("first write failed before response loss: %d", lost.StatusCode)
	}
	var originalID uuid.UUID
	if err := db.QueryRow(ctx, `SELECT task_id FROM task_create_receipts WHERE account_id=$1 AND actor_id=$2 AND operation_id=$3`, first.account, first.user, operation).Scan(&originalID); err != nil {
		t.Fatal(err)
	}
	replayed := call("POST", "/api/tasks", firstPayload, first.token, http.StatusOK)
	if replayed["task"].(map[string]any)["id"] != originalID.String() {
		t.Fatal("HTTP retry did not recover the committed task")
	}
	other := call("POST", "/api/tasks", secondPayload, second.token, http.StatusOK)
	otherID := other["task"].(map[string]any)["id"].(string)
	if otherID == originalID.String() {
		t.Fatal("operation ID crossed account boundary")
	}
	assertExactlyOnce := func(a actor) {
		t.Helper()
		var tasks, receipts, activity, reminders int
		if err := db.QueryRow(ctx, `SELECT (SELECT COUNT(*) FROM tasks WHERE account_id=$1),
		 (SELECT COUNT(*) FROM task_create_receipts WHERE account_id=$1),
		 (SELECT COUNT(*) FROM task_activity WHERE account_id=$1 AND action='created'),
		 (SELECT COUNT(*) FROM task_reminders WHERE account_id=$1)`, a.account).Scan(&tasks, &receipts, &activity, &reminders); err != nil {
			t.Fatal(err)
		}
		if tasks != 1 || receipts != 1 || activity != 1 || reminders != 1 {
			t.Fatalf("HTTP exactly-once task/receipt/activity/reminder: %d/%d/%d/%d", tasks, receipts, activity, reminders)
		}
	}
	assertExactlyOnce(first)
	assertExactlyOnce(second)
	call("GET", "/api/tasks/"+otherID, nil, first.token, http.StatusNotFound)
	call("GET", "/api/tasks/"+originalID.String(), nil, second.token, http.StatusNotFound)
	call("POST", "/api/tasks", secondPayload, first.token, http.StatusUnprocessableEntity)
	firstPayload["title"] = "Edited after uncertain result"
	conflict := call("POST", "/api/tasks", firstPayload, first.token, http.StatusConflict)
	if conflict["code"] != "operation_payload_conflict" {
		t.Fatal("different payload did not return the explicit receipt conflict")
	}
	firstPayload["title"] = "Once over HTTP"
	// Exercise the real startup registry twice with live rows. Additive migration
	// must retain both accounts' receipts, tasks, activities and reminders.
	for i := 0; i < 2; i++ {
		if err := database.Migrate(db); err != nil {
			t.Fatalf("repeat startup migration %d: %v", i+1, err)
		}
		assertExactlyOnce(first)
		assertExactlyOnce(second)
		retry := call("POST", "/api/tasks", firstPayload, first.token, http.StatusOK)
		if retry["task"].(map[string]any)["id"] != originalID.String() {
			t.Fatal("startup migration erased durable retry identity")
		}
	}
	// Purging the task must never turn its retained receipt into a new create.
	exec(`DELETE FROM tasks WHERE account_id=$1 AND id=$2`, first.account, originalID)
	call("POST", "/api/tasks", firstPayload, first.token, http.StatusNotFound)
	var remaining int
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM tasks WHERE account_id=$1`, first.account).Scan(&remaining); err != nil || remaining != 0 {
		t.Fatalf("purged task resurrected after HTTP retry: count=%d error=%v", remaining, err)
	}
	assertExactlyOnce(second)
}
