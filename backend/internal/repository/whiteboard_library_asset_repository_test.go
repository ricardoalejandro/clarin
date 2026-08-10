package repository

import (
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestClassifyWhiteboardLibraryAssetReconciliationPromotesExactReferencesOnly(t *testing.T) {
	t.Parallel()
	keepID, removeID, draftID := uuid.New(), uuid.New(), uuid.New()
	linked := map[string]whiteboardLibraryLinkedAsset{
		"keep":             {mediaAssetID: keepID, committed: true},
		"remove_committed": {mediaAssetID: removeID, committed: true},
		"concurrent_draft": {mediaAssetID: draftID, committed: false},
	}
	removed, err := classifyWhiteboardLibraryAssetReconciliation([]string{"keep"}, linked)
	if err != nil {
		t.Fatal(err)
	}
	if len(removed) != 1 {
		t.Fatalf("removed=%v", removed)
	}
	if _, ok := removed[removeID]; !ok {
		t.Fatal("unreferenced committed asset was preserved")
	}
	if _, ok := removed[draftID]; ok {
		t.Fatal("concurrent unreferenced draft was removed by library save")
	}
	if _, ok := removed[keepID]; ok {
		t.Fatal("live committed asset was removed")
	}
	if _, err := classifyWhiteboardLibraryAssetReconciliation([]string{"missing"}, linked); !errors.Is(err, ErrWhiteboardInvalid) {
		t.Fatalf("missing asset reference was accepted: %v", err)
	}
}

func TestWhiteboardLibraryDraftVisibilityFollowsMutationAccess(t *testing.T) {
	t.Parallel()
	if whiteboardLibraryAssetDraftVisible(domain.WhiteboardAccessView) {
		t.Fatal("shared-library viewer can observe an unpublished draft")
	}
	for _, level := range []string{domain.WhiteboardAccessEdit, domain.WhiteboardAccessManage} {
		if !whiteboardLibraryAssetDraftVisible(level) {
			t.Fatalf("%s cannot recover its own draft", level)
		}
	}
}
