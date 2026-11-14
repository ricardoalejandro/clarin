package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/service"
	"github.com/naperu/clarin/internal/utilities"
)

func TestUtilityVaultStatusNeedsAuthenticatedUtilityPermissionAndIsNoStore(t *testing.T) {
	for _, tc := range []struct {
		name   string
		claims *service.JWTClaims
		status int
	}{
		{"anonymous", nil, 401},
		{"allowed", &service.JWTClaims{AccountID: uuid.New(), UserID: uuid.New(), Permissions: []string{domain.PermUtilities}}, 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			app := fiber.New()
			server := &Server{utilities: &utilities.Service{}}
			protected := app.Group("/api", func(c *fiber.Ctx) error {
				if tc.claims != nil {
					c.Locals("claims", tc.claims)
				}
				return c.Next()
			})
			server.registerUtilityRoutes(protected)
			response, err := app.Test(httptest.NewRequest(http.MethodGet, "/api/utilities/vault/status", nil))
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			if response.StatusCode != tc.status {
				t.Fatalf("HTTP %d", response.StatusCode)
			}
			if tc.status == 200 {
				if response.Header.Get("Cache-Control") != "no-store" {
					t.Fatal("secret routes are cacheable")
				}
				var body struct {
					Data struct {
						Configured bool `json:"configured"`
					} `json:"data"`
				}
				if json.NewDecoder(response.Body).Decode(&body) != nil || body.Data.Configured {
					t.Fatal("unconfigured vault advertised usable")
				}
			}
		})
	}
}

type utilityRetentionRow struct {
	value bool
	err   error
}

func (r utilityRetentionRow) Scan(target ...any) error {
	if r.err != nil {
		return r.err
	}
	*target[0].(*bool) = r.value
	return nil
}

type utilityRetentionProbe struct {
	retained     bool
	err          error
	args         []any
	query        string
	catalogCalls int
}

func (p *utilityRetentionProbe) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	p.query = sql
	p.args = args
	return utilityRetentionRow{p.retained, p.err}
}
func (p *utilityRetentionProbe) Query(context.Context, string, ...any) (pgx.Rows, error) {
	p.catalogCalls++
	return nil, errors.New("canonical catalog unavailable")
}
func TestUtilityCleanupRetentionsAreScopedAndFailuresPreserveTheObject(t *testing.T) {
	a := uuid.New()
	key := a.String() + "/_private/utilities/fixture"
	retained := &utilityRetentionProbe{retained: true}
	ok, err := utilityStorageReferences(context.Background(), retained, a, key, nil)
	if err != nil || !ok || retained.catalogCalls != 0 || len(retained.args) != 2 || retained.args[0] != a || retained.args[1] != key {
		t.Fatal("retention scope or short-circuit failed", err)
	}
	for _, table := range []string{"media_assets", "storage_media_trash", "storage_removed_references", "storage_upload_ownership"} {
		if !strings.Contains(retained.query, table) {
			t.Fatal("missing protected retention", table)
		}
	}
	for _, probe := range []*utilityRetentionProbe{{err: errors.New("storage unavailable")}, {}} {
		_, err = utilityStorageReferences(context.Background(), probe, a, key, nil)
		if err == nil {
			t.Fatal("reference read failure could authorize deletion")
		}
	}
}

func TestUtilityCommittedDeletionReturnsCanonicalWorkspaceAndSurvivesPreferenceReadFailure(t *testing.T) {
	remaining := uuid.New()
	for _, failed := range []bool{false, true} {
		app := fiber.New()
		app.Delete("/", func(c *fiber.Ctx) error {
			return utilityDocumentDeleted(c, func() (domain.UtilityWorkspace, error) {
				if failed {
					return domain.UtilityWorkspace{}, errors.New("preference storage unavailable")
				}
				return domain.UtilityWorkspace{OpenIDs: []uuid.UUID{remaining}, Version: 8}, nil
			})
		})
		response, err := app.Test(httptest.NewRequest(http.MethodDelete, "/", nil))
		if err != nil {
			t.Fatal(err)
		}
		var payload struct {
			Success bool `json:"success"`
			Data    struct {
				Deleted        bool                     `json:"deleted"`
				CleanupPending bool                     `json:"cleanup_pending"`
				Workspace      *domain.UtilityWorkspace `json:"workspace"`
			} `json:"data"`
		}
		err = json.NewDecoder(response.Body).Decode(&payload)
		response.Body.Close()
		if err != nil || response.StatusCode != 200 || !payload.Success || !payload.Data.Deleted || !payload.Data.CleanupPending {
			t.Fatal("committed deletion was reported as failed", err)
		}
		if failed {
			if payload.Data.Workspace != nil {
				t.Fatal("failed preference read fabricated a canonical version")
			}
		} else if payload.Data.Workspace == nil || payload.Data.Workspace.Version != 8 || len(payload.Data.Workspace.OpenIDs) != 1 || payload.Data.Workspace.OpenIDs[0] != remaining || payload.Data.Workspace.ActiveID != nil {
			t.Fatal("post-delete preference state/version omitted")
		}
	}
}
func TestUtilityErrorsAreActionableWithoutLeakingUnderlyingDetails(t *testing.T) {
	for _, tc := range []struct {
		err    error
		status int
		code   string
	}{{utilities.ErrMissing, 404, "utility_not_found"}, {utilities.ErrConflict, 409, "utility_conflict"}, {utilities.ErrInvalid, 400, "invalid_utility"}, {utilities.ErrQuota, 413, "storage_quota_exceeded"}, {utilities.ErrVaultUnavailable, 503, "vault_unavailable"}} {
		app := fiber.New()
		app.Get("/", func(c *fiber.Ctx) error { return utilityError(c, tc.err) })
		response, err := app.Test(httptest.NewRequest(http.MethodGet, "/", nil))
		if err != nil {
			t.Fatal(err)
		}
		var body map[string]any
		_ = json.NewDecoder(response.Body).Decode(&body)
		response.Body.Close()
		if response.StatusCode != tc.status || body["code"] != tc.code {
			t.Fatal("wrong error disposition", body)
		}
	}
}
func TestUtilityInvalidIDsAndMissingVersionsNeverReachStorage(t *testing.T) {
	app := fiber.New()
	server := &Server{utilities: &utilities.Service{}}
	claims := &service.JWTClaims{AccountID: uuid.New(), UserID: uuid.New(), Permissions: []string{domain.PermUtilities}}
	group := app.Group("/api", func(c *fiber.Ctx) error { c.Locals("claims", claims); return c.Next() })
	server.registerUtilityRoutes(group)
	for _, path := range []string{"/api/utilities/documents/not-uuid", "/api/utilities/vault/not-uuid"} {
		response, err := app.Test(httptest.NewRequest(http.MethodDelete, path, strings.NewReader("")))
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != 400 {
			t.Fatal("invalid id reached database")
		}
	}
	response, err := app.Test(httptest.NewRequest(http.MethodDelete, "/api/utilities/documents/"+uuid.NewString(), nil))
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 400 {
		t.Fatal("missing CAS version accepted")
	}
}
