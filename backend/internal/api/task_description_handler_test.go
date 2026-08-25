package api

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/repository"
)

func TestTaskDescriptionRequestRequiresContentAndVersion(t *testing.T) {
	validDescription := ""
	validVersion := int64(4)
	zeroVersion := int64(0)
	if got := taskDescriptionRequestError(taskDescriptionUpdateRequest{Version: &validVersion}); got != "La descripción es obligatoria" {
		t.Fatalf("missing description error=%q", got)
	}
	if got := taskDescriptionRequestError(taskDescriptionUpdateRequest{Description: &validDescription}); got != "La versión de la tarea es obligatoria" {
		t.Fatalf("missing version error=%q", got)
	}
	if got := taskDescriptionRequestError(taskDescriptionUpdateRequest{Description: &validDescription, Version: &zeroVersion}); got != "La versión de la tarea es obligatoria" {
		t.Fatalf("unsafe version error=%q", got)
	}
	if got := taskDescriptionRequestError(taskDescriptionUpdateRequest{Description: &validDescription, Version: &validVersion}); got != "" {
		t.Fatalf("empty-but-valid description was rejected: %q", got)
	}
}

func TestTaskDescriptionConflictResponseReturnsNarrowCanonicalState(t *testing.T) {
	updatedAt := time.Date(2026, time.August, 25, 12, 30, 0, 0, time.UTC)
	state := &repository.TaskDescriptionState{Description: "versión remota", Version: 9, UpdatedAt: updatedAt}
	response := taskDescriptionConflictResponse(state)
	if response["success"] != false || response["code"] != "version_conflict" {
		t.Fatalf("unexpected conflict envelope: %#v", response)
	}
	current, ok := response["current"].(fiber.Map)
	if !ok || current["description"] != state.Description || current["version"] != state.Version || current["updated_at"] != updatedAt {
		t.Fatalf("canonical conflict state was lost: %#v", response)
	}
	if _, leaked := response["task"]; leaked {
		t.Fatalf("conflict response leaked an unrelated task payload: %#v", response)
	}
	if _, leaked := response["hierarchy_counts"]; leaked {
		t.Fatalf("conflict response included unrelated hierarchy counts: %#v", response)
	}
}

func TestTaskDescriptionSuccessResponseHasNoHierarchySnapshot(t *testing.T) {
	operationID := uuid.New()
	updatedAt := time.Date(2026, time.August, 25, 12, 35, 0, 0, time.UTC)
	state := &repository.TaskDescriptionState{Description: "guardada", Version: 3, UpdatedAt: updatedAt, Changed: true}
	response := taskDescriptionSuccessResponse(state, operationID)
	if response["success"] != true || response["operation_id"] != operationID.String() {
		t.Fatalf("unexpected success envelope: %#v", response)
	}
	current, ok := response["current"].(fiber.Map)
	if !ok || current["description"] != state.Description || current["version"] != state.Version || current["updated_at"] != updatedAt {
		t.Fatalf("canonical success state was lost: %#v", response)
	}
	if _, exists := response["task"]; exists {
		t.Fatalf("description save returned an unrelated task payload: %#v", response)
	}
	if _, exists := response["hierarchy_counts"]; exists {
		t.Fatalf("description save returned unrelated hierarchy counts: %#v", response)
	}
}

func TestTaskDescriptionRouteRequiresCanonicalEditAccess(t *testing.T) {
	t.Parallel()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source path")
	}
	apiDir := filepath.Dir(currentFile)
	raw, err := os.ReadFile(filepath.Join(apiDir, "server.go"))
	if err != nil {
		t.Fatalf("read server routes: %v", err)
	}
	route := `tasks.Patch("/:id/description", s.requireTaskAccessParam("id", domain.TaskAccessEdit), s.handleUpdateTaskDescription)`
	if !strings.Contains(string(raw), route) {
		t.Fatalf("description route lost its Editar middleware")
	}
}

func TestTaskDescriptionHandlerInvalidatesBeforeRealtimePublication(t *testing.T) {
	t.Parallel()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source path")
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(currentFile), "task_description_handler.go"))
	if err != nil {
		t.Fatalf("read description handler: %v", err)
	}
	source := string(raw)
	invalidateAt := strings.Index(source, "s.invalidateTasksCache(accountID)")
	publishAt := strings.Index(source, "s.services.Task.PublishDescriptionUpdated")
	responseAt := strings.Index(source, "return c.JSON(taskDescriptionSuccessResponse(state")
	if invalidateAt < 0 || publishAt < 0 || responseAt < 0 || !(invalidateAt < publishAt && publishAt < responseAt) {
		t.Fatalf("description mutation must invalidate cache, then publish realtime, then respond")
	}
}
