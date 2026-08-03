package api

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestBulkAssigneeConfirmationHTTPContract(t *testing.T) {
	t.Parallel()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source path")
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(currentFile), "task_bulk_handler.go"))
	if err != nil {
		t.Fatalf("read task bulk handler: %v", err)
	}
	source := string(raw)
	for _, invariant := range []string{
		"ConfirmGrants bool",
		"`json:\"confirm_grants\"`",
		"ConfirmParticipantGrants: req.ConfirmGrants",
		"fiber.StatusConflict",
		"\"code\": \"access_change_confirmation_required\"",
		"\"affected_user_ids\": confirmation.AffectedUserIDs",
	} {
		if !strings.Contains(source, invariant) {
			t.Fatalf("bulk assignee HTTP contract lost %q", invariant)
		}
	}
}
