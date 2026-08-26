package api

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/pkg/config"
)

func TestTaskLocationViewHTTPRolloutGateFailsClosedAndReopensDynamically(t *testing.T) {
	t.Parallel()
	server := &Server{cfg: &config.Config{WorkWhiteboardViewsEnabled: false}}
	app := fiber.New()
	viewID := uuid.NewString()
	downstreamCalls := 0
	authenticated := func(c *fiber.Ctx) error {
		c.Locals("account_id", uuid.New())
		c.Locals("user_id", uuid.New())
		return c.Next()
	}
	routes := []struct {
		method  string
		pattern string
		path    string
	}{
		{fiber.MethodPost, "/location-views", "/location-views"},
		{fiber.MethodGet, "/location-views/:viewId", "/location-views/" + viewID},
		{fiber.MethodPatch, "/location-views/:viewId", "/location-views/" + viewID},
		{fiber.MethodPost, "/location-views/:viewId/duplicate", "/location-views/" + viewID + "/duplicate"},
		{fiber.MethodDelete, "/location-views/:viewId", "/location-views/" + viewID},
		{fiber.MethodPost, "/location-views/:viewId/restore", "/location-views/" + viewID + "/restore"},
	}
	for _, route := range routes {
		app.Add(route.method, route.pattern, authenticated, server.requireWorkWhiteboardViewsEnabled, func(c *fiber.Ctx) error {
			downstreamCalls++
			return c.SendStatus(fiber.StatusNoContent)
		})
	}

	for _, route := range routes {
		response, err := app.Test(httptest.NewRequest(route.method, route.path, nil))
		if err != nil {
			t.Fatalf("flag-off %s %s: %v", route.method, route.path, err)
		}
		var body struct {
			Code string `json:"code"`
		}
		if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
			response.Body.Close()
			t.Fatalf("decode flag-off %s %s: %v", route.method, route.path, err)
		}
		response.Body.Close()
		if response.StatusCode != fiber.StatusNotFound || body.Code != "work_whiteboard_views_disabled" {
			t.Fatalf("flag-off %s %s = status %d code %q", route.method, route.path, response.StatusCode, body.Code)
		}
	}
	if downstreamCalls != 0 {
		t.Fatalf("flag-off requests reached contextual handlers %d times", downstreamCalls)
	}

	server.cfg.WorkWhiteboardViewsEnabled = true
	for _, route := range routes {
		response, err := app.Test(httptest.NewRequest(route.method, route.path, nil))
		if err != nil {
			t.Fatalf("flag-on %s %s: %v", route.method, route.path, err)
		}
		response.Body.Close()
		if response.StatusCode != fiber.StatusNoContent {
			t.Fatalf("flag-on %s %s = status %d, want %d", route.method, route.path, response.StatusCode, fiber.StatusNoContent)
		}
	}
	if downstreamCalls != len(routes) {
		t.Fatalf("flag-on requests reached contextual handlers %d times, want %d", downstreamCalls, len(routes))
	}

	server.cfg.WorkWhiteboardViewsEnabled = false
	response, err := app.Test(httptest.NewRequest(fiber.MethodGet, "/location-views/"+viewID, nil))
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != fiber.StatusNotFound || downstreamCalls != len(routes) {
		t.Fatalf("dynamic kill switch failed closed again: status=%d downstream=%d", response.StatusCode, downstreamCalls)
	}
}

func TestTaskLocationViewCursorRoundTripAndValidation(t *testing.T) {
	t.Parallel()
	id := uuid.New()
	encoded := encodeTaskLocationViewCursor(2048, id)
	order, decodedID, err := decodeTaskLocationViewCursor(encoded)
	if err != nil || order == nil || decodedID == nil || *order != 2048 || *decodedID != id {
		t.Fatalf("cursor did not round trip: order=%v id=%v err=%v", order, decodedID, err)
	}
	if order, decodedID, err := decodeTaskLocationViewCursor(""); err != nil || order != nil || decodedID != nil {
		t.Fatalf("empty cursor should start the first page: order=%v id=%v err=%v", order, decodedID, err)
	}
	for _, invalid := range []string{"not-base64", "e30", "eyJzb3J0X29yZGVyIjotMX0"} {
		if _, _, err := decodeTaskLocationViewCursor(invalid); err == nil {
			t.Fatalf("invalid cursor %q was accepted", invalid)
		}
	}
}

func TestTaskLocationBoardIDIsStableAndActorScoped(t *testing.T) {
	t.Parallel()
	accountID, actorA, actorB, operationID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	first, err := stableTaskLocationBoardID(accountID, actorA, operationID)
	if err != nil {
		t.Fatal(err)
	}
	retry, err := stableTaskLocationBoardID(accountID, actorA, operationID)
	if err != nil {
		t.Fatal(err)
	}
	otherActor, err := stableTaskLocationBoardID(accountID, actorB, operationID)
	if err != nil {
		t.Fatal(err)
	}
	if first == uuid.Nil || first != retry {
		t.Fatalf("retry changed deterministic board id: first=%s retry=%s", first, retry)
	}
	if first == otherActor {
		t.Fatal("the same operation id collided across actors")
	}
}

func TestTaskLocationMutationHashBindsActionAndCanonicalLocation(t *testing.T) {
	t.Parallel()
	base := &domain.TaskLocationView{ID: uuid.New(), AccountID: uuid.New(), EnvironmentID: uuid.New(), Type: domain.TaskLocationViewTypeWhiteboard,
		Scope:    &domain.WhiteboardWorkLocation{ScopeType: domain.TaskAccessTargetList, ScopeID: uuid.New()},
		Resource: domain.TaskLocationViewResource{Whiteboard: &domain.Whiteboard{Name: "Pizarra"}}}
	first, err := taskLocationCanonicalMutationHash(base, "update", "Pizarra", 4)
	if err != nil {
		t.Fatal(err)
	}
	retry, err := taskLocationCanonicalMutationHash(base, "update", "Pizarra", 4)
	if err != nil || first != retry || len(first) != 64 {
		t.Fatalf("canonical payload hash is not stable: first=%q retry=%q err=%v", first, retry, err)
	}
	actionHash, err := taskLocationCanonicalMutationHash(base, "trash", "Pizarra", 4)
	if err != nil {
		t.Fatal(err)
	}
	changedScope := *base
	changedScope.Scope = &domain.WhiteboardWorkLocation{ScopeType: domain.TaskAccessTargetFolder, ScopeID: uuid.New()}
	scopeHash, err := taskLocationCanonicalMutationHash(&changedScope, "update", "Pizarra", 4)
	if err != nil {
		t.Fatal(err)
	}
	changedAccount := *base
	changedAccount.AccountID = uuid.New()
	accountHash, err := taskLocationCanonicalMutationHash(&changedAccount, "update", "Pizarra", 4)
	if err != nil {
		t.Fatal(err)
	}
	changedEnvironment := *base
	changedEnvironment.EnvironmentID = uuid.New()
	environmentHash, err := taskLocationCanonicalMutationHash(&changedEnvironment, "update", "Pizarra", 4)
	if err != nil {
		t.Fatal(err)
	}
	nameHash, err := taskLocationCanonicalMutationHash(base, "update", "Otro nombre", 4)
	if err != nil {
		t.Fatal(err)
	}
	for label, value := range map[string]string{"action": actionHash, "scope": scopeHash, "account": accountHash, "environment": environmentHash, "name": nameHash} {
		if first == value {
			t.Fatalf("operation hash did not bind canonical %s", label)
		}
	}
}

func TestTaskLocationTrashArchivesSocketsOnlyAfterRepositoryCommit(t *testing.T) {
	t.Parallel()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve handler source")
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(currentFile), "task_location_view_handler.go"))
	if err != nil {
		t.Fatal(err)
	}
	source := string(raw)
	trashStart := strings.Index(source, "func (s *Server) handleTrashTaskLocationView")
	restoreStart := strings.Index(source, "func (s *Server) handleRestoreTaskLocationView")
	if trashStart < 0 || restoreStart <= trashStart {
		t.Fatal("trash handler bounds changed")
	}
	trashSource := source[trashStart:restoreStart]
	commitIndex := strings.Index(trashSource, "s.repos.TaskLocationView.Trash")
	revokeIndex := strings.Index(trashSource, "s.invalidateArchivedWhiteboardSockets")
	if commitIndex < 0 || revokeIndex < 0 || revokeIndex < commitIndex {
		t.Fatal("contextual trash must emit board_archived after the repository mutation commits")
	}
}

func TestArchiveAndTrashWhiteboardCountsUseRolloutAndModuleGate(t *testing.T) {
	t.Parallel()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve API source directory")
	}
	read := func(name string) string {
		t.Helper()
		raw, err := os.ReadFile(filepath.Join(filepath.Dir(currentFile), name))
		if err != nil {
			t.Fatal(err)
		}
		return string(raw)
	}
	gateSource := read("task_location_view_handler.go")
	gateStart := strings.Index(gateSource, "func (s *Server) includeTaskLocationWhiteboardCounts")
	gateEnd := strings.Index(gateSource, "func (s *Server) requireWorkWhiteboardViewsEnabled")
	if gateStart < 0 || gateEnd <= gateStart {
		t.Fatal("whiteboard count gate bounds changed")
	}
	gate := gateSource[gateStart:gateEnd]
	flagIndex := strings.Index(gate, "!s.workWhiteboardViewsEnabled()")
	moduleIndex := strings.Index(gate, "CanUseTaskLocationViews")
	if flagIndex < 0 || moduleIndex < 0 || flagIndex > moduleIndex {
		t.Fatal("count gate must fail closed on rollout before querying canonical module access")
	}

	archive := read("task_environment_handler.go")
	if !strings.Contains(archive, "includeWhiteboardCounts, err := s.includeTaskLocationWhiteboardCounts(c)") ||
		!strings.Contains(archive, "environmentID, includeWhiteboardCounts") {
		t.Fatal("Archive hierarchy no longer passes the canonical whiteboard count decision to the repository")
	}
	trash := read("task_trash_handler.go")
	if strings.Count(trash, "includeTaskLocationWhiteboardCounts(c)") < 2 ||
		strings.Count(trash, "includeWhiteboardCounts,") < 2 {
		t.Fatal("Trash containers and Entornos must both pass the canonical whiteboard count decision")
	}
}

func TestTaskContainerLifecycleHandlersUseExactRepositoryInvalidationSet(t *testing.T) {
	t.Parallel()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve API source directory")
	}
	read := func(name string) string {
		t.Helper()
		raw, err := os.ReadFile(filepath.Join(filepath.Dir(currentFile), name))
		if err != nil {
			t.Fatal(err)
		}
		return string(raw)
	}
	sources := map[string]string{
		"environment": read("task_environment_handler.go"),
		"trash":       read("task_trash_handler.go"),
		"work":        read("task_work_handler.go"),
		"task":        read("task_handler.go"),
	}
	for name, source := range sources {
		if strings.Contains(source, "taskLocationWhiteboardIDs(") {
			t.Fatalf("%s handler still captures board IDs before the lifecycle transaction", name)
		}
	}
	for _, invariant := range []string{
		"boardIDs, err := s.repos.TaskWork.ArchiveEnvironment(",
		"boardIDs, err := s.repos.TaskWork.RestoreEnvironment(",
	} {
		if !strings.Contains(sources["environment"], invariant) {
			t.Fatalf("environment lifecycle lost exact repository result %q", invariant)
		}
	}
	for _, invariant := range []string{
		"boardIDs, err := s.repos.TaskWork.ArchiveList(",
		"boardIDs, err := s.repos.TaskWork.UnarchiveList(",
		"boardIDs, err := s.repos.TaskWork.ArchiveFolder(",
		"boardIDs, err := s.repos.TaskWork.UnarchiveFolder(",
		"boardIDs, err := s.repos.TaskWork.TrashEnvironment(",
		"boardIDs, err := s.repos.TaskWork.RestoreEnvironmentFromTrash(",
		"boardIDs, err := s.repos.TaskWork.RestoreList(",
		"boardIDs, err := s.repos.TaskWork.RestoreFolder(",
	} {
		if !strings.Contains(sources["trash"], invariant) {
			t.Fatalf("Archive/Trash lifecycle lost exact repository result %q", invariant)
		}
	}
	if !strings.Contains(sources["work"], "boardIDs, err := s.repos.TaskWork.TrashFolderConfirmed(") ||
		!strings.Contains(sources["task"], "boardIDs, err := s.repos.TaskWork.TrashListConfirmed(") {
		t.Fatal("active List/Folder Trash handlers no longer consume exact transaction results")
	}
	if strings.Count(sources["trash"], "result.WhiteboardIDs") != 3 {
		t.Fatal("List, Folder and Entorno purge must invalidate only the exact committed purge set")
	}
	for name, source := range sources {
		mutation := strings.Index(source, "boardIDs, err := s.repos.TaskWork.")
		revoke := strings.Index(source, "s.revokeTaskLocationWhiteboardSockets(accountID, boardIDs)")
		if mutation >= 0 && (revoke < 0 || revoke < mutation) {
			t.Fatalf("%s handler publishes invalidation before its repository transaction succeeds", name)
		}
	}
	accessMutation := strings.Index(sources["environment"], "var mutationEffects repository.TaskAccessMutationEffects")
	accessWrite := strings.Index(sources["environment"], "ReplaceAccessGrants(")
	accessPublish := strings.Index(sources["environment"], "s.notifyTaskLocationWhiteboardAccessChanged(accountID, mutationEffects.WhiteboardIDs)")
	if accessMutation < 0 || accessWrite < 0 || accessPublish < 0 ||
		!(accessMutation < accessWrite && accessWrite < accessPublish) {
		t.Fatal("ACL handler must publish the exact ReplaceAccessGrants transaction result only after success")
	}
	if strings.Contains(sources["environment"], "WorkWhiteboardIDsForAccessTarget(") {
		t.Fatal("ACL handler still re-queries contextual board IDs after commit")
	}
}

func TestTaskContainerPurgePassesDynamicWorkWhiteboardKillSwitch(t *testing.T) {
	t.Parallel()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve API source directory")
	}
	read := func(name string) string {
		t.Helper()
		raw, err := os.ReadFile(filepath.Join(filepath.Dir(currentFile), name))
		if err != nil {
			t.Fatal(err)
		}
		return string(raw)
	}
	trash := read("task_trash_handler.go")
	for _, call := range []string{"PurgeList(", "PurgeFolder(", "PurgeEnvironment("} {
		start := strings.Index(trash, call)
		if start < 0 {
			t.Fatalf("missing %s handler call", call)
		}
		end := strings.Index(trash[start:], ")\n")
		if end < 0 || !strings.Contains(trash[start:start+end], "s.workWhiteboardViewsEnabled()") {
			t.Fatalf("%s does not pass the live kill-switch policy into the purge transaction", call)
		}
	}
	errorMapper := read("task_work_handler.go")
	if !strings.Contains(errorMapper, "errors.Is(err, repository.ErrTaskLocationViewDisabled)") ||
		!strings.Contains(errorMapper, `"code": "work_whiteboard_views_disabled"`) {
		t.Fatal("blocked contextual purge does not return the explicit disabled capability error")
	}
}

func TestTaskListReparentReauthorizesTheExactCommittedWhiteboardSet(t *testing.T) {
	t.Parallel()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve handler source")
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(currentFile), "task_work_handler.go"))
	if err != nil {
		t.Fatal(err)
	}
	source := string(raw)
	start := strings.Index(source, "func (s *Server) handleUpdateTaskListStructure")
	end := strings.Index(source, "func (s *Server) handleGetTaskWorkflows")
	if start < 0 || end <= start {
		t.Fatal("list update handler bounds changed")
	}
	handler := source[start:end]
	updateIndex := strings.Index(handler, "affectedBoardIDs, err := s.repos.TaskWork.UpdateListLocation")
	revokeIndex := strings.Index(handler, "s.notifyTaskLocationWhiteboardAccessChanged(accountID, affectedBoardIDs)")
	followupReadIndex := strings.Index(handler, "s.repos.TaskWork.ContainerEnvironmentID")
	if updateIndex < 0 || revokeIndex < 0 || followupReadIndex < 0 || !(updateIndex < revokeIndex && revokeIndex < followupReadIndex) {
		t.Fatal("list reparenting must reauthorize the exact board IDs returned by the committed repository mutation before follow-up reads")
	}
	if strings.Contains(handler, "s.revokeTaskLocationWhiteboardSockets(accountID, affectedBoardIDs)") {
		t.Fatal("list reparenting must not terminal-disconnect retained viewers")
	}
}

func TestWorkWhiteboardTerminalMappingsDistinguishTrashAndPurge(t *testing.T) {
	t.Parallel()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve API source directory")
	}
	read := func(name string) string {
		t.Helper()
		raw, err := os.ReadFile(filepath.Join(filepath.Dir(currentFile), name))
		if err != nil {
			t.Fatal(err)
		}
		return string(raw)
	}
	location := read("task_location_view_handler.go")
	trashStart := strings.Index(location, "func (s *Server) handleTrashTaskLocationView")
	restoreStart := strings.Index(location, "func (s *Server) handleRestoreTaskLocationView")
	if trashStart < 0 || restoreStart <= trashStart ||
		!strings.Contains(location[trashStart:restoreStart], "s.invalidateArchivedWhiteboardSockets(") {
		t.Fatal("explicit Work whiteboard trash must emit board_archived")
	}
	purge := read("task_trash_handler.go")
	if strings.Count(purge, "s.purgeTaskLocationWhiteboardSockets(accountID, result.WhiteboardIDs)") != 3 {
		t.Fatal("List, Folder and Entorno purge must emit board_deleted for their exact committed whiteboard sets")
	}
	if strings.Contains(purge, "s.revokeTaskLocationWhiteboardSockets(accountID, result.WhiteboardIDs)") {
		t.Fatal("permanent parent purge still emits reversible work_access_changed semantics")
	}
}
