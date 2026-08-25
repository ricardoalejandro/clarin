package repository

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestWhiteboardCommentValidationPreservesUnicodeAndBoundsAnchors(t *testing.T) {
	t.Parallel()
	body, err := normalizeWhiteboardCommentBody("  Revisa esto 👀\nGracias  ")
	if err != nil || body != "Revisa esto 👀\nGracias" {
		t.Fatalf("unicode comment normalization failed: %q %v", body, err)
	}
	if _, err := normalizeWhiteboardCommentBody(strings.Repeat("á", maxWhiteboardCommentRunes+1)); err == nil {
		t.Fatal("oversized comment was accepted")
	}
	elementID := "shape-1"
	ratioX, ratioY := 0.25, 0.75
	if err := validateWhiteboardCommentAnchor(&elementID, -50, 120, &ratioX, &ratioY); err != nil {
		t.Fatalf("valid shape anchor rejected: %v", err)
	}
	for name, test := range map[string]struct {
		element *string
		x, y    float64
		rx, ry  *float64
	}{
		"nan":           {x: math.NaN()},
		"ratio no item": {x: 1, y: 1, rx: &ratioX, ry: &ratioY},
		"partial ratio": {element: &elementID, x: 1, y: 1, rx: &ratioX},
		"outside ratio": {element: &elementID, x: 1, y: 1, rx: float64Pointer(2), ry: &ratioY},
	} {
		t.Run(name, func(t *testing.T) {
			if err := validateWhiteboardCommentAnchor(test.element, test.x, test.y, test.rx, test.ry); err == nil {
				t.Fatal("invalid anchor was accepted")
			}
		})
	}
}

func TestWhiteboardCommentOperationHashAndStatusAreDeterministic(t *testing.T) {
	t.Parallel()
	payload := struct {
		ThreadID uuid.UUID `json:"thread_id"`
		Body     string    `json:"body"`
	}{uuid.New(), "Hola"}
	first, err := whiteboardCommentPayloadHash(payload)
	if err != nil {
		t.Fatal(err)
	}
	retry, err := whiteboardCommentPayloadHash(payload)
	if err != nil || first != retry || len(first) != 64 {
		t.Fatalf("operation payload hash is unstable: %q %q %v", first, retry, err)
	}
	if !validWhiteboardCommentStatus(domain.WhiteboardCommentOpen, false) ||
		!validWhiteboardCommentStatus(domain.WhiteboardCommentResolved, false) ||
		validWhiteboardCommentStatus("all", false) || !validWhiteboardCommentStatus("all", true) {
		t.Fatal("comment status filter/mutation boundary is invalid")
	}
}

func TestWhiteboardCommentCollectionBudgetsAreGloballyBounded(t *testing.T) {
	t.Parallel()
	if got := normalizeWhiteboardCommentThreadListLimit(200); got != maxWhiteboardCommentThreadsPerPage {
		t.Fatalf("thread page escaped cap: %d", got)
	}
	if got := normalizeWhiteboardThreadCommentListLimit(200); got != maxWhiteboardThreadCommentPageSize {
		t.Fatalf("comment page escaped cap: %d", got)
	}
	if got := normalizeWhiteboardCommentMarkerListLimit(500); got != maxWhiteboardCommentMarkersPerPage {
		t.Fatalf("marker page escaped cap: %d", got)
	}
	if maxWhiteboardCommentPreviewCount != maxWhiteboardCommentThreadsPerPage*maxWhiteboardCommentPreviewsPerThread {
		t.Fatalf("preview count is not globally derived: %d", maxWhiteboardCommentPreviewCount)
	}
	if maxWhiteboardCommentPreviewCount > 200 {
		t.Fatalf("preview response can hydrate %d comments", maxWhiteboardCommentPreviewCount)
	}
	if maxWhiteboardCommentPreviewBodyBytes != maxWhiteboardCommentPreviewCount*maxWhiteboardCommentBodyBytes ||
		maxWhiteboardCommentPreviewBodyBytes > 4*1024*1024 {
		t.Fatalf("preview body budget is unsafe: %d bytes", maxWhiteboardCommentPreviewBodyBytes)
	}
	if maxWhiteboardThreadCommentPageBodyBytes != maxWhiteboardThreadCommentPageSize*maxWhiteboardCommentBodyBytes ||
		maxWhiteboardThreadCommentPageBodyBytes > 2*1024*1024 {
		t.Fatalf("thread comment page budget is unsafe: %d bytes", maxWhiteboardThreadCommentPageBodyBytes)
	}
}

func TestWhiteboardCommentMarkerContractExcludesCommentBodies(t *testing.T) {
	t.Parallel()
	marker := domain.WhiteboardCommentMarker{
		ID: uuid.New(), BoardID: uuid.New(), AnchorX: 12, AnchorY: 18,
		Version: 3, CommentCount: 9, UpdatedAt: time.Now().UTC(),
	}
	encoded, err := json.Marshal(marker)
	if err != nil {
		t.Fatal(err)
	}
	payload := string(encoded)
	if strings.Contains(payload, `"comments"`) || strings.Contains(payload, `"body"`) {
		t.Fatalf("marker leaked comment content: %s", payload)
	}
	for _, expected := range []string{`"id"`, `"board_id"`, `"anchor_x"`, `"anchor_y"`, `"version"`, `"comment_count"`, `"updated_at"`} {
		if !strings.Contains(payload, expected) {
			t.Fatalf("marker omitted %s: %s", expected, payload)
		}
	}
}

func float64Pointer(value float64) *float64 { return &value }
