package repository

import (
	"encoding/json"
	"errors"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"strings"
	"testing"
)

func TestEventSelectionNormalizationAndScope(t *testing.T) {
	id := uuid.New()
	normalized, err := normalizeEventSelection(PrepareEventSelection{Mode: "ids", ContactIDs: []uuid.UUID{id, id}})
	if err != nil || len(normalized.ContactIDs) != 1 {
		t.Fatalf("dedup: %+v %v", normalized, err)
	}
	for _, req := range []PrepareEventSelection{
		{Mode: "filtered", ContactIDs: []uuid.UUID{id}},
		{Mode: "ids"},
		{Mode: "filtered", Filter: EventSelectionFilter{Search: strings.Repeat("x", 501)}},
		{Mode: "ids", ContactIDs: []uuid.UUID{uuid.Nil}},
		{Mode: "filtered", ExcludedIDs: make([]uuid.UUID, 5001)},
		{Mode: "filtered", Filter: EventSelectionFilter{Membership: "active"}},
	} {
		if _, err := normalizeEventSelection(req); !errors.Is(err, ErrEventSelectionInvalid) {
			t.Fatalf("accepted invalid: %+v", req)
		}
	}
}
func TestEventCandidateCursorAndBlankIdentity(t *testing.T) {
	id := uuid.New()
	var contact domain.Contact
	if err := json.Unmarshal([]byte(`{"id":"`+id.String()+`","custom_name":" ","name":"","short_name":"Alias","jid":"test@invalid"}`), &contact); err != nil {
		t.Fatal(err)
	}
	encoded := encodeEventCandidateCursor(&contact)
	cursor, err := decodeEventCandidateCursor(encoded)
	if err != nil || cursor.ID != id || cursor.Name != "Alias" {
		t.Fatalf("cursor=%+v err=%v", cursor, err)
	}
	if _, err = decodeEventCandidateCursor("bad"); !errors.Is(err, ErrEventSelectionInvalid) {
		t.Fatalf("invalid cursor accepted: %v", err)
	}
	where, args := eventCandidateWhere(EventParticipantCandidateFilter{Search: "Alias"}, []interface{}{uuid.New(), uuid.New()})
	if !strings.Contains(where, "NULLIF(BTRIM(c.custom_name),'')") || !strings.Contains(where, "c.short_name") || strings.Contains(where, "%!") {
		t.Fatalf("invalid search predicate %s (%d args)", where, len(args))
	}
}
func TestEventSelectionStageSnapshot(t *testing.T) {
	id, other := uuid.New(), uuid.New()
	if !sameSelectionStage(nil, nil) || !sameSelectionStage(&id, &id) || sameSelectionStage(&id, nil) || sameSelectionStage(&id, &other) {
		t.Fatal("stage snapshot comparator")
	}
}
