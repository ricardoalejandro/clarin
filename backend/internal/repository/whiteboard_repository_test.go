package repository

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestWhiteboardAccessLevelsAreCumulative(t *testing.T) {
	t.Parallel()
	tests := []struct {
		level                                  string
		manage                                 bool
		view, comment, edit, remove, manageACL bool
	}{
		{level: domain.WhiteboardAccessNone},
		{level: domain.WhiteboardAccessView, view: true},
		{level: domain.WhiteboardAccessComment, view: true, comment: true},
		{level: domain.WhiteboardAccessEdit, view: true, comment: true, edit: true},
		{level: domain.WhiteboardAccessManage, manage: true, view: true, comment: true, edit: true, remove: true, manageACL: true},
	}
	for _, test := range tests {
		access := BuildWhiteboardEffectiveAccess(test.level, test.manage, "test")
		if access.CanView != test.view || access.CanComment != test.comment || access.CanEdit != test.edit || access.CanDelete != test.remove || access.CanManageAccess != test.manageACL {
			t.Fatalf("unexpected capabilities for %s: %#v", test.level, access)
		}
	}
	edit := BuildWhiteboardEffectiveAccess(domain.WhiteboardAccessEdit, false, "test")
	if !WhiteboardAccessAllows(edit, domain.WhiteboardAccessView) || !WhiteboardAccessAllows(edit, domain.WhiteboardAccessComment) || !WhiteboardAccessAllows(edit, domain.WhiteboardAccessEdit) || WhiteboardAccessAllows(edit, domain.WhiteboardAccessManage) {
		t.Fatalf("unexpected edit ordering: %#v", edit)
	}
	comment := BuildWhiteboardEffectiveAccess(domain.WhiteboardAccessComment, false, "test")
	if !WhiteboardAccessAllows(comment, domain.WhiteboardAccessView) || !comment.CanComment || comment.CanEdit || WhiteboardAccessAllows(comment, domain.WhiteboardAccessEdit) {
		t.Fatalf("unexpected comment ordering: %#v", comment)
	}
	invalid := BuildWhiteboardEffectiveAccess("full", true, "legacy")
	if invalid.Level != domain.WhiteboardAccessNone || invalid.CanView {
		t.Fatalf("legacy task access leaked into whiteboards: %#v", invalid)
	}
}

func TestWhiteboardActiveAccessExcludesArchivedWithoutChangingHistoricalGate(t *testing.T) {
	t.Parallel()
	historical := strings.Join(strings.Fields(strings.ToLower(whiteboardEffectiveAccessQuery)), " ")
	active := strings.Join(strings.Fields(strings.ToLower(whiteboardActiveEffectiveAccessQuery)), " ")
	if strings.Contains(historical, "board.archived_at is null") {
		t.Fatalf("historical RequireAccess query unexpectedly excludes archived boards: %q", historical)
	}
	if !strings.Contains(active, "board.account_id=$1") || !strings.Contains(active, "board.id=$3") ||
		!strings.Contains(active, "board.archived_at is null") {
		t.Fatalf("active access query lost account/board/archive scope: %q", active)
	}
}

func TestWhiteboardActivityAcceptsOnlyBoundedObjectMetadata(t *testing.T) {
	t.Parallel()
	valid := WhiteboardActivityInput{
		AccountID: uuid.New(), BoardID: uuid.New(), Action: WhiteboardActivityUpdated,
		Details: json.RawMessage(`{"changed_fields":["name"]}`),
	}
	if _, err := validateWhiteboardActivityInput(valid); err != nil {
		t.Fatalf("valid activity rejected: %v", err)
	}
	valid.Action = "share.secret.exposed"
	if _, err := validateWhiteboardActivityInput(valid); !errors.Is(err, ErrWhiteboardInvalid) {
		t.Fatalf("unknown activity accepted: %v", err)
	}
	valid.Action = WhiteboardActivityUpdated
	valid.Details = json.RawMessage(`[]`)
	if _, err := validateWhiteboardActivityInput(valid); !errors.Is(err, ErrWhiteboardInvalid) {
		t.Fatalf("non-object activity metadata accepted: %v", err)
	}
}

func TestWhiteboardMutationsRequirePositiveExpectedVersion(t *testing.T) {
	t.Parallel()
	for _, version := range []int64{-1, 0} {
		if err := requireWhiteboardExpectedVersion(version); !errors.Is(err, ErrWhiteboardInvalid) {
			t.Fatalf("expected version %d was accepted: %v", version, err)
		}
	}
	if err := checkWhiteboardExpectedVersion(7, 8); !errors.Is(err, ErrWhiteboardConflict) {
		t.Fatalf("stale version was not a conflict: %v", err)
	}
	var conflict *WhiteboardConflictError
	if err := checkWhiteboardExpectedVersion(7, 8); !errors.As(err, &conflict) || conflict.CurrentVersion != 8 {
		t.Fatalf("conflict did not expose canonical version: %#v %v", conflict, err)
	}
	if err := checkWhiteboardExpectedVersion(8, 8); err != nil {
		t.Fatalf("canonical version was rejected: %v", err)
	}
}

func TestSharedLibraryEditorCannotPrivatizeLibrary(t *testing.T) {
	t.Parallel()
	if canChangeWhiteboardLibraryVisibility(domain.WhiteboardAccessEdit, domain.WhiteboardAccessAccount, domain.WhiteboardAccessPrivate) {
		t.Fatal("account-library editor could convert a shared library into a private library")
	}
	if !canChangeWhiteboardLibraryVisibility(domain.WhiteboardAccessEdit, domain.WhiteboardAccessAccount, domain.WhiteboardAccessAccount) {
		t.Fatal("account-library editor could not preserve visibility while editing content")
	}
	if !canChangeWhiteboardLibraryVisibility(domain.WhiteboardAccessManage, domain.WhiteboardAccessAccount, domain.WhiteboardAccessPrivate) {
		t.Fatal("library manager could not change visibility")
	}
}

func TestWhiteboardLibraryDescriptionIsBounded(t *testing.T) {
	t.Parallel()
	if !validWhiteboardLibraryDescription(string(bytes.Repeat([]byte("á"), 1000))) {
		t.Fatal("description at the documented rune limit was rejected")
	}
	if validWhiteboardLibraryDescription(string(bytes.Repeat([]byte("á"), 1001))) {
		t.Fatal("oversized library description was accepted")
	}
	if validWhiteboardLibraryDescription(string([]byte{0xff})) {
		t.Fatal("invalid UTF-8 library description was accepted")
	}
	if !validWhiteboardLibraryQuery(strings.Repeat("q", 200)) || validWhiteboardLibraryQuery(strings.Repeat("q", 201)) {
		t.Fatal("library search query limit is not enforced")
	}
}

func TestWhiteboardLibrarySummaryOmitsHeavyJSON(t *testing.T) {
	t.Parallel()
	summary := domain.WhiteboardLibrary{Name: "Catálogo", Description: "Resumen", ItemCount: 7, ContentSizeBytes: 8 * 1024 * 1024}
	encoded, err := json.Marshal(summary)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(encoded, []byte("library_json")) || !bytes.Contains(encoded, []byte(`"item_count":7`)) {
		t.Fatalf("summary response exposed content or omitted cardinality: %s", encoded)
	}
}

func TestWhiteboardListScopesAreExplicit(t *testing.T) {
	t.Parallel()
	for _, scope := range []string{WhiteboardScopeAll, WhiteboardScopeMine, WhiteboardScopeRecent, WhiteboardScopeShared, WhiteboardScopeTrash} {
		if !validWhiteboardListScope(scope) {
			t.Fatalf("valid scope rejected: %s", scope)
		}
	}
	for _, scope := range []string{"", "archived", "account", "all OR 1=1"} {
		if validWhiteboardListScope(scope) {
			t.Fatalf("invalid scope accepted: %q", scope)
		}
	}
}
