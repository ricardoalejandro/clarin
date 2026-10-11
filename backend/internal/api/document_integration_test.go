package api

import (
	"context"
	"encoding/json"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
	"github.com/naperu/clarin/pkg/config"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDocumentTemplatesRevisionIntegration(t *testing.T) {
	db := newFunctionalIntegrityIntegrationDB(t, "CLARIN_RUN_DOCUMENT_INTEGRATION", "clarin_documents_qa_")
	ctx := context.Background()
	account, other, user := uuid.New(), uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO accounts(id,name) VALUES($1,'Documents QA'),($2,'Other QA')`, account, other); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO users(id,account_id,username,email,password_hash) VALUES($1,$2,$3,$4,'no-login')`, user, account, user.String(), user.String()+"@test.invalid"); err != nil {
		t.Fatal(err)
	}
	repos := repository.NewRepositories(db)
	server := &Server{repos: repos, services: service.NewServices(repos, nil, nil), cfg: &config.Config{PublicURL: "https://clarin.test.invalid"}}
	app := fiber.New()
	app.Use(func(c *fiber.Ctx) error {
		active := account
		if c.Get("X-Other") == "1" {
			active = other
		}
		c.Locals("account_id", active)
		c.Locals("user_id", user)
		c.Locals("claims", &service.JWTClaims{AccountID: active, UserID: user, Permissions: []string{domain.PermDocuments}})
		return c.Next()
	})
	app.Get("/", server.handleListDocumentTemplates)
	app.Post("/", server.handleCreateDocumentTemplate)
	app.Get("/:id", server.handleGetDocumentTemplate)
	app.Put("/:id", server.handleUpdateDocumentTemplate)
	app.Delete("/:id", server.handleDeleteDocumentTemplate)
	app.Post("/:id/duplicate", server.handleDuplicateDocumentTemplate)
	call := func(method, path string, body any, foreign bool) (int, map[string]any) {
		t.Helper()
		raw, _ := json.Marshal(body)
		req := httptest.NewRequest(method, path, strings.NewReader(string(raw)))
		req.Header.Set("Content-Type", "application/json")
		if foreign {
			req.Header.Set("X-Other", "1")
		}
		response, err := app.Test(req, 10000)
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
	body := map[string]any{"name": "Ficha", "canvas_json": map[string]any{}, "page_width": 210, "page_height": 140, "page_orientation": "landscape"}
	status, result := call("POST", "/", body, false)
	if status != 201 {
		t.Fatalf("create %d %v", status, result)
	}
	created := result["template"].(map[string]any)
	id := created["id"].(string)
	if created["revision"] != float64(1) {
		t.Fatal("initial revision")
	}
	if status, _ = call("PUT", "/"+id, body, false); status != 428 {
		t.Fatalf("missing revision: %d", status)
	}
	body["expected_revision"] = 1
	body["name"] = "Updated"
	status, result = call("PUT", "/"+id, body, false)
	if status != 200 || result["template"].(map[string]any)["revision"] != float64(2) {
		t.Fatalf("update %d %v", status, result)
	}
	body["name"] = "Stale"
	status, result = call("PUT", "/"+id, body, false)
	if status != 409 || result["template"].(map[string]any)["name"] != "Updated" {
		t.Fatalf("conflict %d %v", status, result)
	}
	for _, method := range []string{"GET", "PUT", "DELETE"} {
		path := "/" + id
		if method == "DELETE" {
			path += "?expected_revision=2"
		}
		if status, _ = call(method, path, body, true); status != 404 {
			t.Fatalf("foreign %s %d", method, status)
		}
	}
	if status, _ = call("DELETE", "/"+id+"?expected_revision=1", nil, false); status != 409 {
		t.Fatal("stale delete")
	}
	if status, _ = call("POST", "/"+id+"/duplicate", nil, false); status != 201 {
		t.Fatal("duplicate")
	}
	status, result = call("GET", "/?limit=1", nil, false)
	if status != 200 || result["total"] != float64(2) || result["has_more"] != true {
		t.Fatalf("page %d %v", status, result)
	}
	cursor := result["next_cursor"].(string)
	status, result = call("GET", "/?limit=1&cursor="+cursor, nil, false)
	if status != 200 || result["has_more"] != false || len(result["templates"].([]any)) != 1 {
		t.Fatal("second page")
	}
	if status, _ = call("GET", "/?cursor="+cursor, nil, true); status != 400 {
		t.Fatal("foreign cursor")
	}
	if status, _ = call("DELETE", "/"+id+"?expected_revision=2", nil, false); status != 200 {
		t.Fatal("delete")
	}
	if status, _ = call("GET", "/"+id, nil, false); status != 404 {
		t.Fatal("deleted read")
	}
	// External images cannot enter through a Fabric pattern or new background.
	for _, assetCanvas := range []any{map[string]any{"background": map[string]any{"imageUrl": "https://external.invalid/image.png"}}, map[string]any{"fabricJson": map[string]any{"objects": []any{map[string]any{"type": "Rect", "fill": map[string]any{"type": "pattern", "source": "https://external.invalid/image.png"}}}}}} {
		status, _ = call("POST", "/", map[string]any{"name": "External", "canvas_json": assetCanvas, "page_width": 210, "page_height": 140, "page_orientation": "landscape"}, false)
		if status != 422 {
			t.Fatalf("external asset accepted: %d", status)
		}
	}
	// A verified, current same-actor upload remains publishable after the legacy
	// preview-token lifetime. It never authorizes the same key for another account.
	asset, key := uuid.New(), account.String()+"/documents/qa-owned.png"
	if _, err := db.Exec(ctx, `INSERT INTO media_assets(id,account_id,content_hash,object_key,media_type,content_type,filename,size_bytes) VALUES($1,$2,$3,$4,'image','image/png','qa.png',100)`, asset, account, asset.String(), key); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO storage_objects(account_id,object_key,media_type,content_type,filename,size_bytes,source) VALUES($1,$2,'image','image/png','qa.png',100,'documents')`, account, key); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO storage_upload_ownership(account_id,object_key,actor_id,provenance_verified,state,filename,last_uploaded_at) VALUES($1,$2,$3,true,'active','qa.png',NOW()-INTERVAL '2 hours')`, account, key, user); err != nil {
		t.Fatal(err)
	}
	assetBody := map[string]any{"name": "Owned", "canvas_json": map[string]any{"version": 3, "fabricJson": map[string]any{"objects": []any{map[string]any{"type": "Image", "src": "https://clarin.test.invalid" + mediaProxyURLFromObjectKey(key)}}}}, "page_width": 210, "page_height": 140, "page_orientation": "landscape"}
	if status, _ = call("POST", "/", assetBody, true); status != 403 {
		t.Fatalf("foreign publication %d", status)
	}
	if status, result = call("POST", "/", assetBody, false); status != 201 {
		t.Fatalf("durable owned publication %d %v", status, result)
	}

	// Publication switches from verified upload ownership to the canonical
	// document reference on the first save, even while inventory is dirty.
	ownedID := result["template"].(map[string]any)["id"].(string)
	assetBody["thumbnail_url"] = "https://clarin.test.invalid" + mediaProxyURLFromObjectKey(key)
	for revision := 1; revision <= 2; revision++ {
		assetBody["expected_revision"] = revision
		status, result = call("PUT", "/"+ownedID, assetBody, false)
		if status != 200 || result["template"].(map[string]any)["revision"] != float64(revision+1) {
			t.Fatalf("consecutive owned save revision %d: status=%d result=%v", revision, status, result)
		}
		canonical := result["template"].(map[string]any)
		if canonical["thumbnail_url"] != mediaProxyURLFromObjectKey(key) {
			t.Fatal("thumbnail was not canonical")
		}
		saved, _ := json.Marshal(canonical["canvas_json"])
		if strings.Contains(string(saved), "https://clarin.test.invalid") {
			t.Fatal("Fabric absolute src persisted")
		}
	}

	// A previously persisted same-origin Fabric image is recovered from its real
	// document slot, never by treating every private_external reference as public.
	oldAbsolute, _ := json.Marshal(assetBody["canvas_json"])
	if _, err := db.Exec(ctx, `UPDATE document_templates SET canvas_json=$1,thumbnail_url=$2 WHERE id=$3 AND account_id=$4`, oldAbsolute, assetBody["thumbnail_url"], ownedID, account); err != nil {
		t.Fatal(err)
	}
	assetBody["expected_revision"] = 3
	if status, result = call("PUT", "/"+ownedID, assetBody, false); status != 200 {
		t.Fatalf("existing absolute document: %d %v", status, result)
	}
	if status, _ = call("GET", "/"+ownedID, nil, false); status != 200 {
		t.Fatal("canonical reload")
	}
	if status, _ = call("POST", "/"+ownedID+"/duplicate", nil, false); status != 201 {
		t.Fatal("canonical duplicate")
	}
	if status, _ = call("PUT", "/"+ownedID, assetBody, true); status != 403 {
		t.Fatalf("foreign asset write %d", status)
	}
	// A hostile host or a key placed in document text cannot confer image access.
	for _, textOnly := range []bool{false, true} {
		blockedKey := account.String() + "/documents/forbidden-" + uuid.NewString() + ".png"
		value := "https://foreign.invalid" + mediaProxyURLFromObjectKey(blockedKey)
		object := map[string]any{"type": "Image", "src": value}
		if textOnly {
			object = map[string]any{"type": "Textbox", "text": "https://clarin.test.invalid" + mediaProxyURLFromObjectKey(blockedKey)}
		}
		canvas, _ := json.Marshal(map[string]any{"fabricJson": map[string]any{"objects": []any{object}}})
		if _, err := db.Exec(ctx, `INSERT INTO document_templates(account_id,name,canvas_json) VALUES($1,'Unauthorized reference',$2::jsonb)`, account, canvas); err != nil {
			t.Fatal(err)
		}
		blockedBody := map[string]any{"name": "Denied", "canvas_json": map[string]any{"fabricJson": map[string]any{"objects": []any{map[string]any{"type": "Image", "src": mediaProxyURLFromObjectKey(blockedKey)}}}}, "page_width": 210, "page_height": 140, "page_orientation": "landscape"}
		if status, _ = call("POST", "/", blockedBody, false); status != 403 {
			t.Fatalf("foreign host or text reference granted access: %d", status)
		}
	}

	legacyID := result["template"].(map[string]any)["id"].(string)
	legacyCanvas := map[string]any{"version": 3, "fabricJson": map[string]any{"objects": []any{map[string]any{"type": "Image", "src": "https://legacy.invalid/image.png"}}}}
	encoded, _ := json.Marshal(legacyCanvas)
	if _, err := db.Exec(ctx, `UPDATE document_templates SET canvas_json=$1 WHERE id=$2 AND account_id=$3`, encoded, legacyID, account); err != nil {
		t.Fatal(err)
	}
	assetBody["canvas_json"] = legacyCanvas
	assetBody["thumbnail_url"] = ""
	if status, _ = call("POST", "/", assetBody, false); status != 422 {
		t.Fatalf("new external image %d", status)
	}
	assetBody["source_template_id"] = legacyID
	if status, _ = call("POST", "/", assetBody, false); status != 201 {
		t.Fatalf("authorized legacy copy %d", status)
	}
	if status, _ = call("POST", "/", assetBody, true); status != 404 {
		t.Fatalf("foreign legacy copy %d", status)
	}

}
