package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
)

func TestLeadIntelligenceReportRetirementCoversBaseAndDescendants(t *testing.T) {
	// The retired endpoint must work without report repositories, Eros or a
	// database. Old clients cannot create work or inspect preserved history.
	s := &Server{}
	app := fiber.New()
	protected := app.Group("/api", func(c *fiber.Ctx) error {
		c.Locals("claims", &service.JWTClaims{Role: domain.RoleAgent, Permissions: []string{domain.PermReports}})
		return c.Next()
	})
	s.registerReportRoutes(protected)

	for _, request := range []struct{ method, path string }{
		{http.MethodGet, "/api/reports/lead-intelligence"},
		{http.MethodPost, "/api/reports/lead-intelligence/"},
		{http.MethodGet, "/api/reports/lead-intelligence/options"},
		{http.MethodPost, "/api/reports/lead-intelligence/preview"},
		{http.MethodPost, "/api/reports/lead-intelligence/runs"},
		{http.MethodGet, "/api/reports/lead-intelligence/runs"},
		{http.MethodGet, "/api/reports/lead-intelligence/runs/invalid-id"},
		{http.MethodPost, "/api/reports/lead-intelligence/runs/invalid-id/cancel"},
		{http.MethodGet, "/api/reports/lead-intelligence/runs/invalid-id/result"},
		{http.MethodDelete, "/api/reports/lead-intelligence/future/path"},
	} {
		t.Run(request.method+request.path, func(t *testing.T) {
			res, err := app.Test(httptest.NewRequest(request.method, request.path, nil))
			if err != nil {
				t.Fatal(err)
			}
			defer res.Body.Close()
			if res.StatusCode != http.StatusGone {
				t.Fatalf("status=%d, want 410", res.StatusCode)
			}
			if got := res.Header.Get("Cache-Control"); got != "no-store" {
				t.Fatalf("cache-control=%q", got)
			}
			var body struct {
				Success bool   `json:"success"`
				Code    string `json:"code"`
			}
			if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if body.Success || body.Code != "report_retired" {
				t.Fatalf("unexpected retirement response: %+v", body)
			}
		})
	}
	res, err := app.Test(httptest.NewRequest(http.MethodGet, "/api/reports/lead-intelligence-other", nil))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("unrelated report prefix was intercepted: status=%d", res.StatusCode)
	}
}

func TestLeadIntelligenceReportRetirementKeepsAuthentication(t *testing.T) {
	s := &Server{}
	app := fiber.New()
	s.registerReportRoutes(app.Group("/api", s.authMiddleware))
	for _, path := range []string{"/api/reports/lead-intelligence", "/api/reports/lead-intelligence/runs"} {
		res, err := app.Test(httptest.NewRequest(http.MethodGet, path, nil))
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusUnauthorized {
			t.Fatalf("%s status=%d, want 401", path, res.StatusCode)
		}
	}
}

func TestLeadIntelligenceReportRetirementKeepsReportsPermission(t *testing.T) {
	// A closed pool exercises the existing permission fallback deterministically
	// without a live database or granting permission through a legacy role.
	db, err := pgxpool.New(context.Background(), "postgres://unused:unused@127.0.0.1:1/unused")
	if err != nil {
		t.Fatal(err)
	}
	db.Close()
	s := &Server{repos: repository.NewRepositories(db)}
	for _, tc := range []struct {
		name        string
		role        string
		permissions []string
		status      int
	}{
		{name: "unrelated module", role: domain.RoleAgent, permissions: []string{domain.PermLeads}, status: http.StatusForbidden},
		{name: "reports", role: domain.RoleAgent, permissions: []string{domain.PermReports}, status: http.StatusGone},
		{name: "all permissions", role: domain.RoleAgent, permissions: []string{domain.PermAll}, status: http.StatusGone},
		{name: "account admin", role: domain.RoleAdmin, status: http.StatusGone},
	} {
		t.Run(tc.name, func(t *testing.T) {
			app := fiber.New()
			protected := app.Group("/api", func(c *fiber.Ctx) error {
				c.Locals("claims", &service.JWTClaims{UserID: uuid.New(), AccountID: uuid.New(), Role: tc.role, Permissions: tc.permissions})
				return c.Next()
			})
			s.registerReportRoutes(protected)
			res, err := app.Test(httptest.NewRequest(http.MethodPost, "/api/reports/lead-intelligence/runs", nil))
			if err != nil {
				t.Fatal(err)
			}
			defer res.Body.Close()
			if res.StatusCode != tc.status {
				t.Fatalf("status=%d, want %d", res.StatusCode, tc.status)
			}
		})
	}
}

func TestRetiredReportDoesNotRequireCommercialPolicy(t *testing.T) {
	for _, path := range []string{"/api/reports/lead-intelligence", "/api/reports/lead-intelligence/runs/id/result"} {
		if leadPolicyRouteRequired(http.MethodGet, path) {
			t.Fatalf("retired route must return 410 independently of the Leads policy: %s", path)
		}
	}
}
