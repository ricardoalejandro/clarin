package repository

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestWhiteboardLibraryImportExpiryLimitIsBounded(t *testing.T) {
	t.Parallel()
	for input, expected := range map[int]int{-1: 100, 0: 100, 1: 1, 500: 500, 501: 500} {
		if actual := whiteboardLibraryImportExpiryLimit(input); actual != expected {
			t.Fatalf("whiteboardLibraryImportExpiryLimit(%d)=%d, want %d", input, actual, expected)
		}
	}
}

func TestWhiteboardLibraryImportClaimSQLRequiresTokenAccountAndActor(t *testing.T) {
	t.Parallel()
	for name, query := range map[string]string{
		"board lookup": whiteboardLibraryImportClaimBoardSQL,
		"claim":        whiteboardLibraryImportClaimUpdateSQL,
		"locked state": whiteboardLibraryImportClaimSelectSQL,
	} {
		normalized := strings.Join(strings.Fields(strings.ToLower(query)), " ")
		for _, scope := range []string{"token_hash=$1", "account_id=$2", "actor_id=$3"} {
			if !strings.Contains(normalized, scope) {
				t.Fatalf("%s query is not account-bound; missing %q in %q", name, scope, normalized)
			}
		}
	}
	if !strings.Contains(strings.ToLower(whiteboardLibraryImportClaimSelectSQL), "for update") {
		t.Fatal("claim state is not locked before its authorized transition")
	}
}

func TestWhiteboardLibraryImportNavigationSQLLocksExactPendingActorHandoff(t *testing.T) {
	t.Parallel()
	normalized := strings.Join(strings.Fields(strings.ToLower(whiteboardLibraryImportNavigationSQL)), " ")
	for _, scope := range []string{
		"import_item.account_id=$1",
		"import_item.actor_id=$2",
		"import_item.board_id=$3",
		"import_item.id=$4",
		"import_item.token_hash=$5",
		"import_item.status='pending'",
		"import_item.expires_at>$6",
		"library.account_id=$1",
		"library.id=import_item.library_id",
		"library.created_by=$2",
		"library.visibility='private'",
		"library.archived_at is null",
		"for update of import_item for share of library",
	} {
		if !strings.Contains(normalized, scope) {
			t.Fatalf("catalog navigation query is missing %q in %q", scope, normalized)
		}
	}
}

func TestWhiteboardLibraryImportNavigationReplayIsSingleUse(t *testing.T) {
	t.Parallel()
	selectSQL := strings.Join(strings.Fields(strings.ToLower(whiteboardLibraryImportNavigationSQL)), " ")
	rotateSQL := strings.Join(strings.Fields(strings.ToLower(whiteboardLibraryImportNavigationRotateSQL)), " ")
	for _, scope := range []string{"account_id=$1", "actor_id=$2", "board_id=$3", "id=$4", "token_hash=$5", "status='pending'", "expires_at>$6"} {
		if !strings.Contains(selectSQL, scope) || !strings.Contains(rotateSQL, scope) {
			t.Fatalf("navigation rotation lost %q: select=%q rotate=%q", scope, selectSQL, rotateSQL)
		}
	}
	if !strings.Contains(rotateSQL, "set token_hash=$7") || !strings.Contains(rotateSQL, "returning import_item.token_hash") {
		t.Fatalf("navigation does not atomically rotate its one-time token: %q", rotateSQL)
	}
}

func TestRotateWhiteboardLibraryImportNavigationRejectsInvalidScopeBeforeDatabase(t *testing.T) {
	t.Parallel()
	repo := &WhiteboardRepository{}
	validID := uuid.New()
	validNavigationHash := strings.Repeat("a", 64)
	validCallbackHash := strings.Repeat("b", 64)
	now := time.Now().UTC()
	for name, invoke := range map[string]func() error{
		"account": func() error {
			return repo.RotateWhiteboardLibraryImportNavigation(t.Context(), uuid.Nil, validID, validID, validID, validNavigationHash, validCallbackHash, now)
		},
		"actor": func() error {
			return repo.RotateWhiteboardLibraryImportNavigation(t.Context(), validID, uuid.Nil, validID, validID, validNavigationHash, validCallbackHash, now)
		},
		"board": func() error {
			return repo.RotateWhiteboardLibraryImportNavigation(t.Context(), validID, validID, uuid.Nil, validID, validNavigationHash, validCallbackHash, now)
		},
		"import": func() error {
			return repo.RotateWhiteboardLibraryImportNavigation(t.Context(), validID, validID, validID, uuid.Nil, validNavigationHash, validCallbackHash, now)
		},
		"navigation token hash": func() error {
			return repo.RotateWhiteboardLibraryImportNavigation(t.Context(), validID, validID, validID, validID, "short", validCallbackHash, now)
		},
		"callback token hash": func() error {
			return repo.RotateWhiteboardLibraryImportNavigation(t.Context(), validID, validID, validID, validID, validNavigationHash, "short", now)
		},
		"same token hash": func() error {
			return repo.RotateWhiteboardLibraryImportNavigation(t.Context(), validID, validID, validID, validID, validNavigationHash, validNavigationHash, now)
		},
		"timestamp": func() error {
			return repo.RotateWhiteboardLibraryImportNavigation(t.Context(), validID, validID, validID, validID, validNavigationHash, validCallbackHash, time.Time{})
		},
	} {
		t.Run(name, func(t *testing.T) {
			if err := invoke(); !errors.Is(err, ErrWhiteboardInvalid) {
				t.Fatalf("invalid navigation scope was accepted: %v", err)
			}
		})
	}
}

func TestWhiteboardLibraryContainsEveryImportedItemID(t *testing.T) {
	t.Parallel()
	imported := json.RawMessage(`{"type":"excalidrawlib","libraryItems":[{"id":"catalog-a"},{"id":"catalog-b"}]}`)
	persisted := json.RawMessage(`{"type":"excalidrawlib","libraryItems":[[{"id":"legacy-element"}],{"id":"existing"},{"id":"catalog-b"},{"id":"catalog-a"}]}`)
	if err := whiteboardLibraryContainsImportedItems(imported, persisted); err != nil {
		t.Fatalf("persisted imported IDs were rejected: %v", err)
	}
	missing := json.RawMessage(`{"type":"excalidrawlib","libraryItems":[{"id":"catalog-a"}]}`)
	if err := whiteboardLibraryContainsImportedItems(imported, missing); !errors.Is(err, ErrWhiteboardLibraryImportNotPersisted) {
		t.Fatalf("missing imported ID was accepted: %v", err)
	}
}

func TestWhiteboardLibraryImportItemProofRejectsAmbiguousPayloads(t *testing.T) {
	t.Parallel()
	for name, payload := range map[string]json.RawMessage{
		"missing collection": json.RawMessage(`{"type":"excalidrawlib"}`),
		"legacy import":      json.RawMessage(`{"libraryItems":[[{"id":"element"}]]}`),
		"missing id":         json.RawMessage(`{"libraryItems":[{"elements":[]}]}`),
		"duplicate id":       json.RawMessage(`{"libraryItems":[{"id":"same"},{"id":"same"}]}`),
	} {
		if err := whiteboardLibraryContainsImportedItems(payload, json.RawMessage(`{"libraryItems":[]}`)); !errors.Is(err, ErrWhiteboardLibraryImportNotPersisted) {
			t.Fatalf("%s payload was accepted: %v", name, err)
		}
	}
}

func TestCompleteWhiteboardLibraryImportRequiresVersion(t *testing.T) {
	t.Parallel()
	repo := &WhiteboardRepository{}
	_, err := repo.CompleteWhiteboardLibraryImport(t.Context(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), 0, time.Now().UTC())
	if !errors.Is(err, ErrWhiteboardInvalid) {
		t.Fatalf("missing library version was accepted: %v", err)
	}
}
