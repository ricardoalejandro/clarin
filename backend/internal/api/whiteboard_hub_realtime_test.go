package api

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestWhiteboardHubChangedPayloadIsDataFree(t *testing.T) {
	for _, action := range []string{whiteboardHubChangedAction, whiteboardWorkHubRevokedAction} {
		payload := whiteboardHubControlPayload(action)
		if len(payload) != 1 || payload["action"] != action {
			t.Fatalf("Hub invalidation must contain only its action, got %#v", payload)
		}
		raw, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		expected, _ := json.Marshal(map[string]string{"action": action})
		if string(raw) != string(expected) {
			t.Fatalf("unexpected Hub invalidation shape: %s", raw)
		}
	}
}

func whiteboardHubHandlerSource(t *testing.T, name string) string {
	t.Helper()
	_, current, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("could not resolve test path")
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(current), name))
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func handlerSlice(t *testing.T, source, functionName, nextFunctionName string) string {
	t.Helper()
	start := strings.Index(source, "func (s *Server) "+functionName+"(")
	end := strings.Index(source, "func (s *Server) "+nextFunctionName+"(")
	if start < 0 || end <= start {
		t.Fatalf("could not isolate %s", functionName)
	}
	return source[start:end]
}

func TestWhiteboardHubFanoutIsMutationOnlyAndPostCommit(t *testing.T) {
	source := whiteboardHubHandlerSource(t, "whiteboard_handler.go")
	for _, readOnly := range []struct{ current, next string }{
		{"handleListWhiteboardFolders", "handleCreateWhiteboardFolder"},
		{"handleGetWhiteboardFolder", "handleUpdateWhiteboardFolder"},
		{"handleListWhiteboards", "handleCreateWhiteboard"},
		{"handleGetWhiteboard", "handleListWhiteboardActivity"},
		{"handleListWhiteboardActivity", "handleUpdateWhiteboard"},
	} {
		body := handlerSlice(t, source, readOnly.current, readOnly.next)
		if strings.Contains(body, "notifyWhiteboardHub") || strings.Contains(body, "notifyWhiteboardWorkHub") {
			t.Fatalf("read-only %s must not invalidate the Hub", readOnly.current)
		}
	}

	for _, mutation := range []struct {
		current, next, committedCall string
	}{
		{"handleCreateWhiteboardFolder", "handleGetWhiteboardFolder", "CreateFolder("},
		{"handleUpdateWhiteboardFolder", "handleArchiveWhiteboardFolder", "UpdateFolder("},
		{"handleCreateWhiteboard", "handleDuplicateWhiteboard", "CreateBoard("},
		{"handleDuplicateWhiteboard", "handleGetWhiteboard", "DuplicateBoard("},
		{"handleUpdateWhiteboard", "handleArchiveWhiteboard", "UpdateBoard("},
		{"handleArchiveWhiteboard", "handleRestoreWhiteboard", "ArchiveBoard("},
		{"handleRestoreWhiteboard", "handleGetWhiteboardScene", "RestoreBoard("},
	} {
		body := handlerSlice(t, source, mutation.current, mutation.next)
		commit := strings.LastIndex(body, mutation.committedCall)
		notify := strings.LastIndex(body, "notifyWhiteboard")
		if commit < 0 || notify <= commit {
			t.Fatalf("%s must notify only after its committed repository mutation", mutation.current)
		}
	}
}
