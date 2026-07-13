package api

import (
	"reflect"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestLeadLifecycleWhereClauses(t *testing.T) {
	tests := []struct {
		name      string
		lifecycle string
		want      []string
	}{
		{
			name:      "open",
			lifecycle: domain.LeadStatusOpen,
			want:      []string{"l.deleted_at IS NULL", "l.is_archived = FALSE", "l.status = 'open'"},
		},
		{
			name:      "won",
			lifecycle: domain.LeadStatusWon,
			want:      []string{"l.deleted_at IS NULL", "l.is_archived = FALSE", "l.status = 'won'"},
		},
		{
			name:      "lost",
			lifecycle: domain.LeadStatusLost,
			want:      []string{"l.deleted_at IS NULL", "l.is_archived = FALSE", "l.status = 'lost'"},
		},
		{
			name:      "archived",
			lifecycle: leadLifecycleArchived,
			want:      []string{"l.deleted_at IS NULL", "l.is_archived = TRUE"},
		},
		{
			name:      "trash",
			lifecycle: leadLifecycleTrash,
			want:      []string{"l.deleted_at IS NOT NULL"},
		},
		{
			name:      "blocked is transversal",
			lifecycle: leadLifecycleBlocked,
			want:      []string{"l.deleted_at IS NULL", "COALESCE(c.do_not_contact, FALSE) = TRUE"},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := leadLifecycleWhereClauses(test.lifecycle); !reflect.DeepEqual(got, test.want) {
				t.Fatalf("leadLifecycleWhereClauses(%q) = %#v, want %#v", test.lifecycle, got, test.want)
			}
		})
	}
}

func TestNormalizeLeadLifecycleLegacyCompatibility(t *testing.T) {
	tests := []struct {
		name         string
		lifecycle    string
		statusFilter string
		want         string
	}{
		{name: "lifecycle wins", lifecycle: "lost", statusFilter: "archived", want: "lost"},
		{name: "legacy archived", statusFilter: "archived", want: leadLifecycleArchived},
		{name: "legacy blocked", statusFilter: "blocked", want: leadLifecycleBlocked},
		{name: "legacy won", statusFilter: "won", want: domain.LeadStatusWon},
		{name: "default active", statusFilter: "active", want: domain.LeadStatusOpen},
		{name: "unknown lifecycle is safe", lifecycle: "unexpected", want: domain.LeadStatusOpen},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := normalizeLeadLifecycle(test.lifecycle, test.statusFilter); got != test.want {
				t.Fatalf("normalizeLeadLifecycle(%q, %q) = %q, want %q", test.lifecycle, test.statusFilter, got, test.want)
			}
		})
	}
}

func TestLeadWhereClausesIncludeAccountContactIntegrity(t *testing.T) {
	want := []string{
		"l.account_id = $1",
		"l.contact_id IS NOT NULL",
		"l.deleted_at IS NULL",
		"l.is_archived = FALSE",
		"l.status = 'won'",
	}
	if got := leadWhereClauses("$1", domain.LeadStatusWon, "active"); !reflect.DeepEqual(got, want) {
		t.Fatalf("leadWhereClauses() = %#v, want %#v", got, want)
	}
}

func TestAddLeadPipelineWhereUsesLeadPipelineID(t *testing.T) {
	pipelineID := uuid.New()
	tests := []struct {
		name       string
		pipelineID string
		wantClause []string
		wantArgs   int
		wantIdx    int
	}{
		{name: "selected pipeline", pipelineID: pipelineID.String(), wantClause: []string{"l.pipeline_id = $2"}, wantArgs: 2, wantIdx: 3},
		{name: "without pipeline", pipelineID: "__no_pipeline__", wantClause: []string{"l.pipeline_id IS NULL"}, wantArgs: 1, wantIdx: 2},
		{name: "empty selection", pipelineID: "", wantClause: nil, wantArgs: 1, wantIdx: 2},
		{name: "invalid selection", pipelineID: "not-a-uuid", wantClause: nil, wantArgs: 1, wantIdx: 2},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			clauses := []string(nil)
			args := []interface{}{"account"}
			argIdx := 2
			addLeadPipelineWhere(test.pipelineID, &clauses, &args, &argIdx)
			if !reflect.DeepEqual(clauses, test.wantClause) {
				t.Fatalf("clauses = %#v, want %#v", clauses, test.wantClause)
			}
			if len(args) != test.wantArgs {
				t.Fatalf("len(args) = %d, want %d", len(args), test.wantArgs)
			}
			if argIdx != test.wantIdx {
				t.Fatalf("argIdx = %d, want %d", argIdx, test.wantIdx)
			}
			if len(args) == 2 && args[1] != pipelineID {
				t.Fatalf("pipeline arg = %#v, want %s", args[1], pipelineID)
			}
		})
	}
}
