package repository

import (
	"github.com/google/uuid"
	"strings"
	"testing"
)

func TestSnapshotPredicateRejectsInvalidFiltersAndUsesCanonicalIdentity(t *testing.T) {
	event := uuid.New()
	for _, filter := range []*SnapshotFilter{{StageIDs: "garbage"}, {TagFormula: "("}, {DateFrom: "wrong"}, {DateField: "dropped_at"}, {TagMode: "NOT"}, {DateField: "created_at", DateFrom: "2026-10-12T00:00:00Z", DateTo: "2026-10-11T00:00:00Z"}} {
		if _, _, err := snapshotPredicate(event, filter); err == nil {
			t.Fatalf("accepted invalid filter: %#v", filter)
		}
	}
	sql, args, err := snapshotPredicate(event, &SnapshotFilter{TextSearch: "Álvaro", StageIDs: "unassigned", HasPhone: true})
	if err != nil || !strings.Contains(sql, "c.custom_name") || !strings.Contains(sql, "NULLIF(BTRIM(c.short_name),'')") || !strings.Contains(sql, "ep.stage_id IS NULL") || len(args) != 2 {
		t.Fatalf("incorrect canonical search predicate: %s %v", sql, err)
	}
}
func TestLogbookLifecycleAndCursorRules(t *testing.T) {
	for _, tc := range []struct {
		from         string
		captured     bool
		action, want string
	}{{"active", true, "complete", "completed"}, {"completed", true, "reopen", "active"}, {"completed", false, "reopen", "pending"}} {
		got, err := logbookTransition(tc.from, tc.captured, tc.action)
		if err != nil || got != tc.want {
			t.Fatal(got, err)
		}
	}
	for _, tc := range []struct {
		from     string
		captured bool
		action   string
	}{{"pending", false, "complete"}, {"active", false, "complete"}, {"pending", true, "reopen"}} {
		if _, err := logbookTransition(tc.from, tc.captured, tc.action); err == nil {
			t.Fatal("invalid transition accepted")
		}
	}
	c := logbookCursor{Date: "2026-10-12", ID: uuid.New()}
	got, err := decodeLogbookCursor(encodeLogbookCursor(c))
	if err != nil || got != c {
		t.Fatal("cursor roundtrip", err)
	}
	if _, err = decodeLogbookCursor("oops"); err == nil {
		t.Fatal("bad cursor")
	}
	if logbookLimit(0) != 50 || logbookLimit(1000) != 200 {
		t.Fatal("unbounded page")
	}
}
