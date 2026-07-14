package api

import (
	"testing"
	"time"

	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/service"
)

func TestResolveDashboardPeriodUsesLimaCalendarDays(t *testing.T) {
	now := time.Date(2026, time.July, 14, 16, 30, 0, 0, time.UTC)
	period, err := resolveDashboardPeriod("30d", now)
	if err != nil {
		t.Fatalf("resolveDashboardPeriod returned error: %v", err)
	}

	if got, want := period.From.Format(time.RFC3339), "2026-06-15T00:00:00-05:00"; got != want {
		t.Fatalf("from = %s, want %s", got, want)
	}
	if got, want := period.To.Format(time.RFC3339), "2026-07-15T00:00:00-05:00"; got != want {
		t.Fatalf("to = %s, want %s", got, want)
	}
	if got, want := period.PreviousFrom.Format(time.RFC3339), "2026-05-16T00:00:00-05:00"; got != want {
		t.Fatalf("previous_from = %s, want %s", got, want)
	}
	if !period.PreviousTo.Equal(period.From) {
		t.Fatalf("previous_to = %s, want %s", period.PreviousTo, period.From)
	}
}

func TestResolveDashboardPeriodRejectsUnsupportedPreset(t *testing.T) {
	if _, err := resolveDashboardPeriod("365d", time.Now()); err == nil {
		t.Fatal("expected unsupported period to return an error")
	}
}

func TestDashboardMetricCalculations(t *testing.T) {
	if dashboardPercentChange(3, 0) != nil {
		t.Fatal("percentage change without a comparison base must be nil")
	}
	change := dashboardPercentChange(15, 10)
	if change == nil || *change != 50 {
		t.Fatalf("change = %v, want 50", change)
	}

	conversion := dashboardConversionRate(3, 1)
	if conversion == nil || *conversion != 75 {
		t.Fatalf("conversion = %v, want 75", conversion)
	}
	if dashboardConversionRate(0, 0) != nil {
		t.Fatal("conversion without closed opportunities must be nil")
	}
}

func TestDashboardHasPermission(t *testing.T) {
	agent := &service.JWTClaims{Role: domain.RoleAgent, Permissions: []string{domain.PermChats}}
	if !dashboardHasPermission(agent, domain.PermChats) {
		t.Fatal("agent should have the explicitly granted chats permission")
	}
	if dashboardHasPermission(agent, domain.PermLeads) {
		t.Fatal("agent must not inherit a module that was not granted")
	}

	admin := &service.JWTClaims{Role: domain.RoleAdmin}
	if !dashboardHasPermission(admin, domain.PermLeads) || !dashboardHasPermission(admin, domain.PermTasks) {
		t.Fatal("admin role should see every dashboard section")
	}

	wildcard := &service.JWTClaims{Role: domain.RoleAgent, Permissions: []string{domain.PermAll}}
	if !dashboardHasPermission(wildcard, domain.PermEvents) {
		t.Fatal("wildcard permission should grant every dashboard section")
	}
}
