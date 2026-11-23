package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
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
	"github.com/naperu/clarin/internal/service"
	"github.com/naperu/clarin/internal/storage"
	"github.com/naperu/clarin/internal/utilities"
	"github.com/naperu/clarin/pkg/database"
)

// No real JWT, listener or account is used. Only authentication is replaced;
// registered Fiber routes, services, SQL, envelope cipher and MinIO are real.
func TestUtilityVaultScopedHTTPIntegration(t *testing.T) {
	if os.Getenv("CLARIN_RUN_UTILITIES_INTEGRATION") != "1" {
		t.Skip("requires disposable loopback PostgreSQL and MinIO")
	}
	raw := os.Getenv("UTILITIES_TEST_DATABASE_URL")
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Hostname() != "127.0.0.1" || parsed.Path != "/clarin_utilities_qa" {
		t.Fatal("isolated loopback database required")
	}
	endpoint := os.Getenv("UTILITIES_TEST_MINIO_ENDPOINT")
	if !strings.HasPrefix(endpoint, "127.0.0.1:") {
		t.Fatal("isolated loopback MinIO required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	db, err := pgxpool.New(ctx, raw)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	if err = database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	objects, err := storage.New(storage.Config{Endpoint: endpoint, AccessKey: "utilitiesqa", SecretKey: "utilities-qa-only", Bucket: "clarin-utilities-qa-b7a3", PublicURL: "http://invalid.test"})
	if err != nil {
		t.Fatal(err)
	}
	ring, _ := json.Marshal(map[string]string{"qa": base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{13}, 32))})
	cipher, err := utilities.NewCipher("qa", string(ring))
	if err != nil {
		t.Fatal(err)
	}
	vault := &utilities.Service{Store: &utilities.Store{DB: db}, Objects: utilityObjectStore{objects}, Cipher: cipher}
	server := &Server{utilities: vault}
	account, neighborAccount, owner, neighborOwner := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	exec := func(query string, args ...any) {
		t.Helper()
		if _, e := db.Exec(ctx, query, args...); e != nil {
			t.Fatal(e)
		}
	}
	exec(`INSERT INTO accounts(id,name) VALUES($1,'Vault HTTP fixture A'),($2,'Vault HTTP fixture B')`, account, neighborAccount)
	for _, id := range []uuid.UUID{owner, neighborOwner} {
		exec(`INSERT INTO users(id,account_id,username,email,password_hash) VALUES($1,$2,$3,$4,'fixture-only')`, id, account, id.String(), id.String()+"@fixture.invalid")
	}
	t.Cleanup(func() {
		cleanup, stop := context.WithTimeout(context.Background(), 15*time.Second)
		defer stop()
		keys := []string{}
		rows, e := db.Query(cleanup, `SELECT object_key FROM utility_objects WHERE account_id=ANY($1::uuid[])`, []uuid.UUID{account, neighborAccount})
		if e == nil {
			for rows.Next() {
				var key string
				if rows.Scan(&key) == nil {
					keys = append(keys, key)
				}
			}
			rows.Close()
		}
		if _, e = db.Exec(cleanup, `DELETE FROM accounts WHERE id=ANY($1::uuid[])`, []uuid.UUID{account, neighborAccount}); e != nil {
			t.Error("fixture row teardown failed", e)
			return
		}
		for _, key := range keys {
			if e = objects.DeleteUtilityObject(cleanup, key); e != nil {
				t.Error("fixture object teardown failed", e)
			}
		}
	})
	appFor := func(a, u uuid.UUID) *fiber.App {
		app := fiber.New()
		protected := app.Group("/api", func(c *fiber.Ctx) error {
			c.SetUserContext(ctx)
			c.Locals("claims", &service.JWTClaims{AccountID: a, UserID: u, Permissions: []string{domain.PermUtilities}})
			return c.Next()
		})
		server.registerUtilityRoutes(protected)
		return app
	}
	app := appFor(account, owner)
	request := func(target *fiber.App, method, path string, input, output any, status int) {
		t.Helper()
		body := []byte{}
		if input != nil {
			var e error
			body, e = json.Marshal(input)
			if e != nil {
				t.Fatal(e)
			}
		}
		r := httptest.NewRequest(method, "/api/utilities"+path, bytes.NewReader(body))
		if input != nil {
			r.Header.Set("Content-Type", "application/json")
		}
		response, e := target.Test(r, 10_000)
		if e != nil {
			t.Fatal("HTTP fixture request failed", method, path, e)
		}
		defer response.Body.Close()
		if response.StatusCode != status {
			var failure struct {
				Code  string `json:"code"`
				Error string `json:"error"`
			}
			_ = json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&failure)
			// Print only bounded error fields; never dump a material response.
			t.Fatalf("%s %s: HTTP %d, expected %d; code=%q error=%q", method, path, response.StatusCode, status, failure.Code[:min(80, len(failure.Code))], failure.Error[:min(256, len(failure.Error))])
		}
		if status == 200 {
			if response.Header.Get("Cache-Control") != "no-store" {
				t.Fatal("private HTTP response was cacheable")
			}
			if output != nil {
				var wrapper struct {
					Success bool            `json:"success"`
					Data    json.RawMessage `json:"data"`
				}
				if json.NewDecoder(response.Body).Decode(&wrapper) != nil || !wrapper.Success || json.Unmarshal(wrapper.Data, output) != nil {
					t.Fatal("invalid successful HTTP envelope")
				}
			}
		}
	}
	create := func(title string) domain.UtilityDocument {
		t.Helper()
		var result struct {
			Document domain.UtilityDocument `json:"document"`
		}
		request(app, http.MethodPost, "/documents", utilities.DocumentInput{Type: "criptografia", Title: title, Config: json.RawMessage(`{}`), OperationID: uuid.New()}, &result, 200)
		return result.Document
	}
	left, right := create("HTTP left"), create("HTTP right")
	list := func(document uuid.UUID) []domain.UtilityVaultItem {
		t.Helper()
		var result struct {
			Items []domain.UtilityVaultItem `json:"items"`
		}
		request(app, http.MethodGet, "/documents/"+document.String()+"/vault", nil, &result, 200)
		if result.Items == nil {
			t.Fatal("empty collection must be []")
		}
		return result.Items
	}
	if len(list(left.ID)) != 0 || len(list(right.ID)) != 0 {
		t.Fatal("new documents were not empty")
	}
	secret := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{21}, 32))
	materialBytes, _ := json.Marshal(map[string]any{"kind": "aes", "algorithm": "AES-GCM", "secret": secret, "certificates": []string{}})
	var created struct {
		Item domain.UtilityVaultItem `json:"item"`
	}
	request(app, http.MethodPost, "/documents/"+left.ID.String()+"/vault", utilities.VaultInput{DocumentID: right.ID, Name: "HTTP AES fixture", Kind: "aes", Algorithm: "AES-GCM", Material: string(materialBytes), Metadata: json.RawMessage(`{}`), OperationID: uuid.New()}, &created, 200)
	key := created.Item
	if key.DocumentID == nil || *key.DocumentID != left.ID || len(list(left.ID)) != 1 || len(list(right.ID)) != 0 {
		t.Fatal("path/document ownership was not canonical")
	}
	materialPath := func(document, key uuid.UUID) string {
		return "/documents/" + document.String() + "/vault/" + key.String() + "/material"
	}
	var opened struct {
		Material string `json:"material"`
	}
	request(app, http.MethodGet, materialPath(left.ID, key.ID), nil, &opened, 200)
	if opened.Material != string(materialBytes) {
		t.Fatal("HTTP material did not recover encrypted bytes")
	}
	request(app, http.MethodGet, materialPath(right.ID, key.ID), nil, nil, 404)
	for _, scope := range []*fiber.App{appFor(account, neighborOwner), appFor(neighborAccount, owner)} {
		request(scope, http.MethodGet, materialPath(left.ID, key.ID), nil, nil, 404)
		request(scope, http.MethodGet, "/documents/"+left.ID.String()+"/vault", nil, nil, 404)
	}
	request(app, http.MethodGet, "/vault/"+key.ID.String()+"/material", nil, nil, 404)
	var selected struct {
		Document domain.UtilityDocument `json:"document"`
	}
	config, _ := json.Marshal(map[string]string{"key_id": key.ID.String()})
	request(app, http.MethodPatch, "/documents/"+left.ID.String(), utilities.DocumentPatch{BaseVersion: left.Version, Config: config, OperationID: uuid.New()}, &selected, 200)
	left = selected.Document
	duplicateInput := utilities.DocumentDuplicate{BaseVersion: left.Version, OperationID: uuid.New(), Title: "HTTP independent copy", Config: left.Config}
	var duplicated struct {
		Document domain.UtilityDocument `json:"document"`
	}
	request(app, http.MethodPost, "/documents/"+left.ID.String()+"/duplicate", duplicateInput, &duplicated, 200)
	copy := duplicated.Document
	var preferences map[string]string
	if json.Unmarshal(copy.Config, &preferences) != nil {
		t.Fatal("invalid copied config")
	}
	copiedID, e := uuid.Parse(preferences["key_id"])
	if e != nil || copiedID == key.ID || len(list(copy.ID)) != 1 {
		t.Fatal("HTTP duplicate did not remap selected key")
	}
	request(app, http.MethodGet, materialPath(copy.ID, copiedID), nil, &opened, 200)
	if opened.Material != string(materialBytes) {
		t.Fatal("HTTP copy changed key material")
	}
	var sourceObject, copyObject string
	var sourceWrapped, copyWrapped []byte
	if e = db.QueryRow(ctx, `SELECT object_key,wrapped_key FROM utility_vault WHERE account_id=$1 AND owner_id=$2 AND id=$3`, account, owner, key.ID).Scan(&sourceObject, &sourceWrapped); e != nil {
		t.Fatal(e)
	}
	if e = db.QueryRow(ctx, `SELECT object_key,wrapped_key FROM utility_vault WHERE account_id=$1 AND owner_id=$2 AND id=$3`, account, owner, copiedID).Scan(&copyObject, &copyWrapped); e != nil {
		t.Fatal(e)
	}
	sourceBody, e := objects.GetFileLimited(ctx, sourceObject, utilities.SecretLimit+1024)
	if e != nil {
		t.Fatal(e)
	}
	copyBody, e := objects.GetFileLimited(ctx, copyObject, utilities.SecretLimit+1024)
	if e != nil {
		t.Fatal(e)
	}
	if sourceObject == copyObject || bytes.Equal(sourceWrapped, copyWrapped) || bytes.Equal(sourceBody, copyBody) || bytes.Contains(sourceBody, []byte(secret)) || bytes.Contains(copyBody, []byte(secret)) {
		t.Fatal("HTTP clone reused ciphertext or exposed plaintext storage")
	}
	var replay struct {
		Document domain.UtilityDocument `json:"document"`
	}
	request(app, http.MethodPost, "/documents/"+left.ID.String()+"/duplicate", duplicateInput, &replay, 200)
	if replay.Document.ID != copy.ID {
		t.Fatal("HTTP duplicate retry created a second document")
	}
	var deleted struct {
		Deleted        bool                    `json:"deleted"`
		CleanupPending bool                    `json:"cleanup_pending"`
		Document       *domain.UtilityDocument `json:"document"`
	}
	request(app, http.MethodDelete, "/documents/"+left.ID.String()+"/vault/"+key.ID.String()+"?version=1", nil, &deleted, 200)
	if !deleted.Deleted || !deleted.CleanupPending || deleted.Document == nil || deleted.Document.Version != left.Version+1 {
		t.Fatal("HTTP delete omitted canonical document/version")
	}
	if json.Unmarshal(deleted.Document.Config, &preferences) != nil || preferences["key_id"] != "" || len(list(left.ID)) != 0 {
		t.Fatal("HTTP delete left the selected key reference")
	}
	request(app, http.MethodGet, materialPath(left.ID, key.ID), nil, nil, 404)
	request(app, http.MethodGet, materialPath(copy.ID, copiedID), nil, &opened, 200)
	if opened.Material != string(materialBytes) {
		t.Fatal("deleting original changed independent copy")
	}
}
