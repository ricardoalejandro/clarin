package api

import (
	"testing"
	"time"

	"github.com/naperu/clarin/internal/domain"
)

func TestParseOfflineTaskSimplePatchIsClosedAndPreservesNullDates(t *testing.T) {
	patch, err := parseOfflineTaskSimplePatch([]byte(`{"title":"  Preparar informe  ","due_at":null,"priority":"high"}`), true)
	if err != nil {
		t.Fatal(err)
	}
	if patch.Title != "Preparar informe" || !patch.DueAtSet || patch.DueAt != nil || patch.Priority != "high" {
		t.Fatalf("unexpected patch: %#v", patch)
	}
	if _, err := parseOfflineTaskSimplePatch([]byte(`{"title":"Tarea","status_id":"forbidden"}`), true); err == nil {
		t.Fatal("offline patch accepted a workflow/status mutation")
	}
}

func TestOfflineTaskMatchesPatchAllowsCrashRetryNoop(t *testing.T) {
	due := time.Date(2026, 9, 13, 10, 0, 0, 0, time.UTC)
	task := &domain.Task{Title: "Tarea", Description: "Texto", DueAt: &due, Priority: "medium"}
	patch, err := parseOfflineTaskSimplePatch([]byte(`{"title":"Tarea","description":"Texto","due_at":"2026-09-13T10:00:00Z","priority":"medium"}`), true)
	if err != nil {
		t.Fatal(err)
	}
	if !offlineTaskMatchesPatch(task, patch) {
		t.Fatal("the already-applied canonical task was not recognized as a noop")
	}
}
