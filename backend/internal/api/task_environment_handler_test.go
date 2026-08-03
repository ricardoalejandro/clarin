package api

import (
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
)

func TestValidateTaskEnvironmentNormalizesSafeDefaults(t *testing.T) {
	t.Parallel()
	environment := &domain.TaskEnvironment{Name: "  Operaciones  ", Description: "  Contexto  "}
	if err := validateTaskEnvironment(environment); err != nil {
		t.Fatalf("validate environment: %v", err)
	}
	if environment.Name != "Operaciones" || environment.Description != "Contexto" || environment.Icon != "layers" ||
		environment.Color != "#6366F1" || environment.Visibility != "restricted" || environment.DefaultAccessLevel != domain.TaskAccessNone {
		t.Fatalf("environment defaults were not canonical: %#v", environment)
	}
}

func TestValidateTaskEnvironmentRejectsInvalidCatalogValues(t *testing.T) {
	t.Parallel()
	tests := []*domain.TaskEnvironment{
		{Name: ""},
		{Name: "Entorno", Icon: "arbitrary-svg"},
		{Name: "Entorno", Color: "red"},
		{Name: "Entorno", Visibility: "public"},
		{Name: "Entorno", DefaultAccessLevel: "owner"},
	}
	for index, environment := range tests {
		if err := validateTaskEnvironment(environment); err == nil {
			t.Fatalf("invalid environment %d was accepted: %#v", index, environment)
		}
	}
}

func TestParseTaskEnvironmentListScope(t *testing.T) {
	t.Parallel()
	tests := []struct {
		raw       string
		hasFolder bool
		all       bool
		valid     bool
	}{
		{raw: "", valid: true},
		{raw: "root", valid: true},
		{raw: " ALL ", all: true, valid: true},
		{raw: "folder", valid: false},
		{raw: "all", hasFolder: true, valid: false},
	}
	for _, test := range tests {
		all, err := parseTaskEnvironmentListScope(test.raw, test.hasFolder)
		if (err == nil) != test.valid || all != test.all {
			t.Fatalf("scope=%q folder=%v returned all=%v err=%v", test.raw, test.hasFolder, all, err)
		}
	}
}

func TestTaskStructurePageCursorIsStableAndScopeBound(t *testing.T) {
	t.Parallel()
	accountID := uuid.New()
	contextKey := taskStructurePageContext(accountID, "lists:"+uuid.NewString()+":root", "  campaña ")
	original := &repository.TaskStructurePageCursor{SortOrder: 2048, ID: uuid.New()}
	encoded, err := encodeTaskStructurePageCursor(original, contextKey)
	if err != nil || encoded == "" {
		t.Fatalf("encode structure cursor: cursor=%q err=%v", encoded, err)
	}
	decoded, err := decodeTaskStructurePageCursor(encoded, contextKey)
	if err != nil || decoded == nil || decoded.SortOrder != original.SortOrder || decoded.ID != original.ID {
		t.Fatalf("structure cursor changed during round trip: %#v err=%v", decoded, err)
	}
	if _, err := decodeTaskStructurePageCursor(encoded, taskStructurePageContext(uuid.New(), "lists:foreign:root", "campaña")); err == nil {
		t.Fatal("cursor from another account or collection was accepted")
	}
	for _, invalid := range []string{"not-base64", "e30", strings.Repeat("x", 2049)} {
		if _, err := decodeTaskStructurePageCursor(invalid, contextKey); err == nil {
			t.Fatalf("invalid structure cursor accepted: %q", invalid)
		}
	}
	if taskStructurePageContext(accountID, "folders:one", " query ") != taskStructurePageContext(accountID, "folders:one", "query") {
		t.Fatal("cursor context did not normalize the repository search value")
	}
}

func TestParseTaskAccessInputsCanonicalizesAndRejectsInvalid(t *testing.T) {
	t.Parallel()
	userID := uuid.New()
	inputs, err := parseTaskAccessInputs([]taskAccessGrantRequest{{UserID: userID.String(), AccessLevel: " EDIT "}})
	if err != nil || len(inputs) != 1 || inputs[0].UserID != userID || inputs[0].AccessLevel != domain.TaskAccessEdit {
		t.Fatalf("canonical grant input=%#v err=%v", inputs, err)
	}
	for _, request := range []taskAccessGrantRequest{
		{UserID: "invalid", AccessLevel: domain.TaskAccessView},
		{UserID: userID.String(), AccessLevel: "owner"},
	} {
		if _, err := parseTaskAccessInputs([]taskAccessGrantRequest{request}); err == nil {
			t.Fatalf("invalid grant was accepted: %#v", request)
		}
	}
}

func TestTaskAccessRecipientSetOperations(t *testing.T) {
	t.Parallel()
	one, two, three := uuid.New(), uuid.New(), uuid.New()
	union := unionTaskAccessRecipients([]uuid.UUID{one, two}, []uuid.UUID{two, three})
	if len(union) != 3 {
		t.Fatalf("union did not deduplicate recipients: %#v", union)
	}
	revoked := subtractTaskAccessRecipients(union, []uuid.UUID{two})
	if len(revoked) != 2 || (revoked[0] != one && revoked[1] != one) || (revoked[0] != three && revoked[1] != three) {
		t.Fatalf("revoked recipients were not exact: %#v", revoked)
	}
}

func TestTaskSharedResourceCursorIsEnvironmentBound(t *testing.T) {
	t.Parallel()
	environmentID := uuid.New()
	original := &repository.TaskSharedResourceCursor{Type: domain.TaskAccessTargetList, Name: "Lista compartida", ID: uuid.New()}
	encoded, err := encodeTaskSharedResourceCursor(original, environmentID)
	if err != nil || encoded == "" {
		t.Fatalf("encode shared cursor: %q err=%v", encoded, err)
	}
	decoded, err := parseTaskSharedResourceCursor(encoded, environmentID)
	if err != nil || decoded == nil || decoded.Type != original.Type || decoded.Name != original.Name || decoded.ID != original.ID {
		t.Fatalf("shared cursor changed during round trip: %#v err=%v", decoded, err)
	}
	if _, err := parseTaskSharedResourceCursor(encoded, uuid.New()); err == nil {
		t.Fatal("shared cursor crossed an Entorno boundary")
	}
	if _, err := parseTaskSharedResourceCursor("invalid", environmentID); err == nil {
		t.Fatal("malformed shared cursor was accepted")
	}
}
