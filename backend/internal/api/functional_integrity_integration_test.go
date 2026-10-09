package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
)

func TestFunctionalIntegrityAPIIntegration(t *testing.T) {
	ctx := context.Background()
	db := newFunctionalIntegrityIntegrationDB(t, "CLARIN_RUN_FUNCTIONAL_INTEGRITY_INTEGRATION", "clarin_functional_qa_")
	account, other, user, folder, foreign := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := db.Exec(ctx, q, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO accounts(id,name) VALUES($1,'Functional QA'),($2,'Other QA')`, account, other)
	exec(`INSERT INTO users(id,account_id,username,email,password_hash) VALUES($1,$2,$3,$4,'test-only')`, user, account, user.String(), user.String()+"@test.invalid")
	exec(`INSERT INTO event_folders(id,account_id,name) VALUES($1,$2,'Own'),($3,$4,'Foreign')`, folder, account, foreign, other)
	exec(`INSERT INTO tags(account_id,name,color) VALUES($1,'Existing','#fff')`, account)
	repos := repository.NewRepositories(db)
	s := &Server{repos: repos, services: service.NewServices(repos, nil, nil)}
	app := fiber.New()
	app.Use(func(c *fiber.Ctx) error {
		permissions := []string{domain.PermContacts}
		role := "member"
		if c.Get("X-QA-Admin") == "1" {
			role = "admin"
			permissions = []string{domain.PermAll}
		}
		c.Locals("account_id", account)
		c.Locals("user_id", user)
		c.Locals("claims", &service.JWTClaims{UserID: user, AccountID: account, Role: role, Permissions: permissions})
		return c.Next()
	})
	app.Post("/events", s.handleCreateEvent)
	app.Put("/events/:id", s.handleUpdateEvent)
	app.Get("/events/:id", s.handleGetEvent)
	app.Get("/tags", s.handleGetTags)
	app.Post("/contacts", s.handleCreateContact)
	app.Put("/contacts/:id", s.handleUpdateContact)
	app.Post("/programs", s.handleCreateProgram)
	call := func(method, path string, body any, admin bool) (int, map[string]any) {
		t.Helper()
		raw, _ := json.Marshal(body)
		r := httptest.NewRequest(method, path, strings.NewReader(string(raw)))
		r.Header.Set("Content-Type", "application/json")
		if admin {
			r.Header.Set("X-QA-Admin", "1")
		}
		response, err := app.Test(r, 10000)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		var result map[string]any
		if err = json.NewDecoder(response.Body).Decode(&result); err != nil {
			t.Fatal(err)
		}
		return response.StatusCode, result
	}
	t.Run("program create validates requested lifecycle before persistence", func(t *testing.T) {
		for _, state := range []string{"invalid", "ACTIVE", " active ", "deleted"} {
			status, r := call("POST", "/programs", map[string]any{"name": "Invalid lifecycle", "status": state}, true)
			if status != fiber.StatusBadRequest {
				t.Fatalf("invalid create lifecycle %q accepted: %d %v", state, status, r)
			}
		}
		var count int
		if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM programs WHERE account_id=$1`, account).Scan(&count); err != nil || count != 0 {
			t.Fatalf("rejected creates left programs: %d, %v", count, err)
		}
		for _, state := range []string{"", "active", "completed", "archived"} {
			payload := map[string]any{"name": "Valid lifecycle"}
			if state != "" {
				payload["status"] = state
			}
			status, r := call("POST", "/programs", payload, true)
			if status != fiber.StatusCreated {
				t.Fatalf("valid create lifecycle %q rejected: %d %v", state, status, r)
			}
			want := state
			if want == "" {
				want = "active"
			}
			var persisted string
			if err := db.QueryRow(ctx, `SELECT status FROM programs WHERE account_id=$1 AND id=$2`, account, r["id"]).Scan(&persisted); err != nil || persisted != want || r["status"] != want {
				t.Fatalf("create lifecycle lost: requested %q, response %v, persisted %q, error %v", state, r["status"], persisted, err)
			}
		}
	})
	t.Run("event folder dates and explicit clears persist", func(t *testing.T) {
		status, r := call("POST", "/events", map[string]any{"name": "Synthetic", "folder_id": folder, "description": "Description", "location": "Here", "event_date": "2026-10-10T14:00:00Z", "event_end": "2026-10-10T16:00:00Z"}, true)
		if status != 201 {
			t.Fatalf("create status %d: %v", status, r)
		}
		event := r["event"].(map[string]any)
		id := event["id"].(string)
		if event["folder_id"] != folder.String() {
			t.Fatal("folder omitted")
		}
		status, _ = call("PUT", "/events/"+id, map[string]any{"description": nil, "location": nil, "event_date": nil, "event_end": nil}, true)
		if status != 200 {
			t.Fatalf("clear status %d", status)
		}
		_, r = call("GET", "/events/"+id, nil, true)
		event = r["event"].(map[string]any)
		for _, key := range []string{"description", "location", "event_date", "event_end"} {
			if event[key] != nil {
				t.Errorf("%s not cleared", key)
			}
		}
		status, r = call("POST", "/events", map[string]any{"name": "Foreign folder", "folder_id": foreign}, true)
		if status != 422 {
			t.Fatalf("foreign folder accepted: %d %v", status, r)
		}
		status, r = call("PUT", "/events/"+id, map[string]any{"event_date": "2026-10-11T14:00:00Z", "event_end": "2026-10-10T16:00:00Z"}, true)
		if status != 422 || r["code"] != "EVENT_DATE_RANGE_INVALID" {
			t.Fatal("reversed range accepted")
		}
	})
	t.Run("terminal event metadata remains readonly", func(t *testing.T) {
		for _, state := range []string{domain.EventStatusCompleted, domain.EventStatusCancelled} {
			id := uuid.New()
			exec(`INSERT INTO events(id,account_id,name,status,event_date,description) VALUES($1,$2,'Keep history',$3,'2026-10-10T14:00:00Z','Keep description')`, id, account, state)
			status, r := call("PUT", "/events/"+id.String(), map[string]any{"name": "Changed", "event_date": nil, "description": nil}, true)
			if status != 409 {
				t.Fatalf("closed %s metadata status %d: %v", state, status, r)
			}
			_, r = call("GET", "/events/"+id.String(), nil, true)
			event := r["event"].(map[string]any)
			if event["name"] != "Keep history" || event["description"] != "Keep description" || event["event_date"] == nil || event["status"] != state {
				t.Fatal("closed event changed")
			}
		}
	})
	t.Run("contact metadata rejects without partial identity", func(t *testing.T) {
		status, _ := call("POST", "/contacts", map[string]any{"name": "Invalid metadata", "email": strings.Repeat("a", 256)}, true)
		if status != 422 {
			t.Fatalf("oversized status %d", status)
		}
		status, _ = call("POST", "/contacts", map[string]any{"name": "Invalid birthday", "birth_date": "2026-02-30"}, true)
		if status != 422 {
			t.Fatalf("invalid date status %d", status)
		}
		var count int
		if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM contacts WHERE account_id=$1`, account).Scan(&count); err != nil || count != 0 {
			t.Fatal("partial contact created")
		}
	})
	t.Run("tag assignment is permission aware", func(t *testing.T) {
		_, r := call("GET", "/tags?limit=20", nil, false)
		if r["can_create"] != false {
			t.Fatal("member granted catalog creation")
		}
		_, r = call("GET", "/tags?limit=20", nil, true)
		if r["can_create"] != true {
			t.Fatal("admin capability missing")
		}
		id := uuid.New()
		exec(`INSERT INTO contacts(id,account_id,jid,name) VALUES($1,$2,$3,'Original')`, id, account, id.String()+"@test.invalid")
		status, r := call("PUT", fmt.Sprintf("/contacts/%s", id), map[string]any{"custom_name": "Unauthorized", "tags": []string{"Missing"}}, false)
		if status != 403 {
			t.Fatalf("new tag accepted %d %v", status, r)
		}
		status, _ = call("PUT", fmt.Sprintf("/contacts/%s", id), map[string]any{"tags": []string{"Existing"}}, false)
		if status != 200 {
			t.Fatalf("existing assignment failed %d", status)
		}
		var custom *string
		var tags int
		if err := db.QueryRow(ctx, `SELECT custom_name,(SELECT COUNT(*) FROM tags WHERE account_id=$1) FROM contacts WHERE id=$2`, account, id).Scan(&custom, &tags); err != nil {
			t.Fatal(err)
		}
		if custom != nil || tags != 1 {
			t.Fatal("unauthorized mutation left changes")
		}
	})
}
