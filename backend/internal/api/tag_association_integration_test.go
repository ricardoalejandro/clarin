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

func TestTagAssociationAPIIntegration(t *testing.T) {
	db := newFunctionalIntegrityIntegrationDB(t, "CLARIN_RUN_TAG_ASSOCIATION_INTEGRATION", "clarin_tags_qa_")
	ctx := context.Background()
	account, other, user, contact, own, foreign := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO accounts(id,name) VALUES($1,'Tags QA'),($2,'Other')`, account, other)
	exec(`INSERT INTO users(id,account_id,username,email,password_hash) VALUES($1,$2,$3,$4,'synthetic')`, user, account, user.String(), user.String()+"@test.invalid")
	exec(`INSERT INTO contacts(id,account_id,jid,name) VALUES($1,$2,$3,'Synthetic')`, contact, account, contact.String()+"@test.invalid")
	exec(`INSERT INTO tags(id,account_id,name,color) VALUES($1,$2,'Visible tag','#123456'),($3,$4,'Foreign tag','#123456')`, own, account, foreign, other)
	repos := repository.NewRepositories(db)
	s := &Server{repos: repos, services: service.NewServices(repos, nil, nil)}
	app := fiber.New()
	app.Use(func(c *fiber.Ctx) error {
		permissions := []string{domain.PermContacts}
		if c.Get("X-QA-Permission") != "" {
			permissions = []string{c.Get("X-QA-Permission")}
		}
		c.Locals("account_id", account)
		c.Locals("user_id", user)
		c.Locals("claims", &service.JWTClaims{UserID: user, AccountID: account, Role: "member", Permissions: permissions})
		return c.Next()
	})
	app.Get("/tags/search", s.handleSearchTags)
	app.Post("/leads", s.handleCreateLead)
	app.Post("/automations", s.handleCreateAutomation)
	app.Patch("/automations/:id/toggle", s.handleToggleAutomation)
	app.Patch("/contact-profiles/:contactId", s.handlePatchContactProfile)
	call := func(method, path string, body any, permission string) (int, map[string]any) {
		t.Helper()
		raw, _ := json.Marshal(body)
		request := httptest.NewRequest(method, path, strings.NewReader(string(raw)))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-QA-Permission", permission)
		response, err := app.Test(request, -1)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		data := map[string]any{}
		if strings.Contains(response.Header.Get("Content-Type"), "json") {
			if err = json.NewDecoder(response.Body).Decode(&data); err != nil {
				t.Fatal(err)
			}
		}
		return response.StatusCode, data
	}
	status, data := call("GET", "/tags/search?context_type=contact_create&q=tag&limit=20", nil, domain.PermContacts)
	if status != 200 || data["can_create"] != false || len(data["tags"].([]any)) != 1 {
		t.Fatalf("context search: status=%d data=%v", status, data)
	}
	status, data = call("GET", "/tags/search?context_type=lead_create&q=tag", nil, domain.PermContacts)
	if status != 403 {
		t.Fatal("Contact permission accessed lead-create context")
	}
	status, data = call("GET", "/tags/search?context_type=lead_import&ids="+own.String()+","+foreign.String(), nil, domain.PermLeads)
	if status != 200 || len(data["tags"].([]any)) != 1 {
		t.Fatal("foreign hydration exposed")
	}
	status, _ = call("GET", "/tags/search?context_type=automation&q=tag", nil, domain.PermContacts)
	if status != 403 {
		t.Fatal("automation context bypassed")
	}
	status, data = call("POST", "/leads", map[string]any{"name": "Created", "tag_ids": []string{own.String()}, "tags": []string{"Ignored missing"}}, domain.PermLeads)
	if status != 201 {
		t.Fatalf("lead selected existing tag: %d %v", status, data)
	}
	if len(data["lead"].(map[string]any)["structured_tags"].([]any)) != 1 {
		t.Fatal("lead response missing canonical tags")
	}
	status, _ = call("POST", "/leads", map[string]any{"name": "Rejected", "tag_ids": nil}, domain.PermLeads)
	if status != 422 {
		t.Fatal("null tag ids accepted")
	}
	status, _ = call("POST", "/leads", map[string]any{"name": "Rejected", "tags": []string{"Forbidden create"}}, domain.PermLeads)
	if status != 403 {
		t.Fatal("legacy new name bypassed permission")
	}
	status, _ = call("POST", "/automations", map[string]any{"name": "Invalid foreign", "trigger": "manual", "graph": map[string]any{"nodes": []any{map[string]any{"id": "tag", "type": "assign_tag", "data": map[string]any{"tag_id": foreign.String()}}}}}, domain.PermAutomations)
	if status != 422 {
		t.Fatal("foreign automation tag saved")
	}
	status, data = call("POST", "/automations", map[string]any{"name": "Tag draft", "trigger": "manual", "graph": map[string]any{"nodes": []any{map[string]any{"id": "tag", "type": "assign_tag", "data": map[string]any{"tag_id": ""}}}}}, domain.PermAutomations)
	if status != 201 {
		t.Fatalf("inactive tag draft rejected: %d %v", status, data)
	}
	draftID := data["automation"].(map[string]any)["id"].(string)
	status, _ = call("PATCH", "/automations/"+draftID+"/toggle", map[string]any{"active": true}, domain.PermAutomations)
	if status != 422 {
		t.Fatal("unconfigured tag action activated")
	}
	status, data = call("POST", "/automations", map[string]any{"name": "Tag configured", "trigger": "manual", "is_active": true, "graph": map[string]any{"nodes": []any{map[string]any{"id": "tag", "type": "assign_tag", "data": map[string]any{"tag_id": own.String()}}}}}, domain.PermAutomations)
	if status != 201 {
		t.Fatalf("configured tag action rejected: %d %v", status, data)
	}
	configuredID := data["automation"].(map[string]any)["id"].(string)
	saved := data["automation"].(map[string]any)["graph"].(map[string]any)["nodes"].([]any)[0].(map[string]any)["data"].(map[string]any)
	if saved["nodeType"] != "assign_tag" || saved["config"].(map[string]any)["tag_id"] != own.String() {
		t.Fatal("editor tag shape did not persist executable compatibility config")
	}
	// Simulate only the auxiliary pinned counter being unavailable. This must
	// fail before Contact tags commit, never report failure after a real change.
	exec(`ALTER TABLE interactions RENAME COLUMN is_pinned TO qa_unavailable_is_pinned`)
	status, _ = call("PATCH", fmt.Sprintf("/contact-profiles/%s?context_type=contact&context_id=%s", contact, contact), map[string]any{"tag_ids": []string{own.String()}}, domain.PermContacts)
	if status != 500 {
		t.Fatalf("counter failure expected 500, got %d", status)
	}
	var count int
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM contact_tags WHERE contact_id=$1`, contact).Scan(&count); err != nil || count != 0 {
		t.Fatal("counter failure committed tags")
	}
	exec(`ALTER TABLE interactions RENAME COLUMN qa_unavailable_is_pinned TO is_pinned`)
	selected, err := s.resolveCSVImportTag(ctx, account, "Visible tag")
	if err != nil || selected == nil || *selected != own {
		t.Fatalf("existing selected import tag rejected: %v", err)
	}
	if _, err := s.resolveCSVImportTag(ctx, account, "Foreign tag"); err == nil {
		t.Fatal("foreign import tag resolved")
	}
	if selected, err := s.resolveCSVImportTag(ctx, account, ""); err != nil || selected != nil {
		t.Fatal("optional import tag required")
	}
	canonical, err := repos.ContactProfile.Get(ctx, account, contact)
	if err != nil {
		t.Fatal(err)
	}
	record := csvImportRecord{JID: canonical.JID, Name: "Import synthetic", Tags: []string{"Legacy file metadata"}}
	if err := s.createCSVImportLead(ctx, account, user, record, canonical, selected, false); err != nil {
		t.Fatalf("selected existing import tag failed: %v", err)
	}
	var assigned int
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM contact_tags WHERE contact_id=$1`, contact).Scan(&assigned); err != nil || assigned != 2 {
		t.Fatalf("selected import tag/file metadata not assigned: %v", err)
	}
	exec(`DELETE FROM tags WHERE account_id=$1 AND id=$2`, account, own)
	status, _ = call("PATCH", "/automations/"+configuredID+"/toggle", map[string]any{"active": false}, domain.PermAutomations)
	if status != 200 {
		t.Fatal("removed tag prevented deactivating automation")
	}
	status, _ = call("PATCH", "/automations/"+configuredID+"/toggle", map[string]any{"active": true}, domain.PermAutomations)
	if status != 422 {
		t.Fatal("removed tag automation reactivated")
	}

	if _, err := s.resolveCSVImportTag(ctx, account, "Visible tag"); err == nil {
		t.Fatal("deleted selected import tag resolved")
	}
	if err := s.createCSVImportLead(ctx, account, user, record, canonical, &own, false); err == nil {
		t.Fatal("selected import tag deleted after preview reported success")
	}
	var importedLeads int
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM leads WHERE account_id=$1 AND contact_id=$2`, account, contact).Scan(&importedLeads); err != nil || importedLeads != 1 {
		t.Fatalf("failed selected-tag import left an unlabelled Lead: count=%d err=%v", importedLeads, err)
	}
	if err := s.createCSVImportLead(ctx, account, user, record, canonical, &foreign, false); err == nil {
		t.Fatal("foreign selected import tag accepted")
	}
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM leads WHERE account_id=$1 AND contact_id=$2`, account, contact).Scan(&importedLeads); err != nil || importedLeads != 1 {
		t.Fatalf("foreign selected-tag import left a Lead: count=%d err=%v", importedLeads, err)
	}
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM tags WHERE account_id=$1 AND name='Visible tag'`, account).Scan(&assigned); err != nil || assigned != 0 {
		t.Fatal("manual import choice recreated a deleted catalog tag")
	}

	// A failed imported row remains retryable: no committed open Lead may
	// cause the next attempt to skip the row as an existing opportunity.
	retryContact := uuid.New()
	retryJID := retryContact.String() + "@test.invalid"
	exec(`INSERT INTO contacts(id,account_id,jid,name) VALUES($1,$2,$3,'Retry synthetic')`, retryContact, account, retryJID)
	plan := &csvImportPlan{
		Summary:       csvImportSummary{ImportType: "leads", Source: "kommo_csv", New: 1, NewOpportunities: 1},
		Records:       []csvImportRecord{{RowNum: 2, Action: "create", JID: retryJID, Name: "Retry synthetic"}},
		SelectedTagID: &own,
	}
	failedImport := s.executeCSVImportPlan(ctx, account, user, plan)
	if failedImport.Created != 0 || failedImport.Skipped != 1 || failedImport.ErrorCount != 1 {
		t.Fatalf("failed selected-tag row result: %+v", failedImport)
	}
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM leads WHERE account_id=$1 AND contact_id=$2`, account, retryContact).Scan(&importedLeads); err != nil || importedLeads != 0 {
		t.Fatal("failed imported row committed an open Lead")
	}
	retryTag := uuid.New()
	exec(`INSERT INTO tags(id,account_id,name,color) VALUES($1,$2,'Retry selection','#123456')`, retryTag, account)
	plan.SelectedTagID = &retryTag
	retriedImport := s.executeCSVImportPlan(ctx, account, user, plan)
	if retriedImport.Created != 1 || retriedImport.Skipped != 0 || retriedImport.ErrorCount != 0 || retriedImport.DuplicateContactLeads != 0 {
		t.Fatalf("corrected selected-tag retry was skipped: %+v", retriedImport)
	}
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM leads l JOIN contact_tags ct ON ct.contact_id=l.contact_id WHERE l.account_id=$1 AND l.contact_id=$2 AND ct.tag_id=$3`, account, retryContact, retryTag).Scan(&importedLeads); err != nil || importedLeads != 1 {
		t.Fatal("retry did not commit exactly one selected-tag Lead")
	}
}
