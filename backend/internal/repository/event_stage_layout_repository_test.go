package repository

import (
	"errors"
	"github.com/google/uuid"
	"testing"
)

func stageRevision(value int64) *int64 { return &value }
func validEventLayout() EventStageLayoutInput {
	return EventStageLayoutInput{ExpectedRevision: stageRevision(0), Stages: []EventStageDraftInput{{ID: uuid.NewString(), Name: " Invitados ", Color: "#12abEF"}, {ClientID: "draft-confirmed", Name: "Confirmados", Color: "#34AB56"}}}
}
func TestEventStageLayoutValidation(t *testing.T) {
	input := validEventLayout()
	normalized, err := normalizeEventStageLayout(input)
	if err != nil {
		t.Fatal(err)
	}
	if normalized.Stages[0].Name != "Invitados" || normalized.Stages[0].Color != "#12ABEF" || normalized.Stages[1].Position != 1 {
		t.Fatalf("not normalized: %#v", normalized.Stages)
	}
	if input.Stages[0].Name != " Invitados " {
		t.Fatal("normalization mutated caller draft")
	}
	cases := map[string]func(*EventStageLayoutInput){
		"missing revision": func(i *EventStageLayoutInput) { i.ExpectedRevision = nil },
		"empty":            func(i *EventStageLayoutInput) { i.Stages = nil },
		"name":             func(i *EventStageLayoutInput) { i.Stages[0].Name = "  " },
		"duplicate name":   func(i *EventStageLayoutInput) { i.Stages[1].Name = "invitados" },
		"unsafe color":     func(i *EventStageLayoutInput) { i.Stages[0].Color = "url(x)" },
		"alpha color":      func(i *EventStageLayoutInput) { i.Stages[0].Color = "#11223344" },
		"missing client":   func(i *EventStageLayoutInput) { i.Stages[1].ClientID = "" },
		"unknown destination": func(i *EventStageLayoutInput) {
			i.Deletions = []EventStageDeletionInput{{ID: uuid.NewString(), MoveTo: EventStageDestination{Kind: "stage", ID: uuid.NewString()}}}
		},
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			draft := validEventLayout()
			change(&draft)
			if _, err := normalizeEventStageLayout(draft); !errors.Is(err, ErrEventStageLayoutInvalid) {
				t.Fatalf("expected invalid, got %v", err)
			}
		})
	}
}
func TestEventStageLayoutAcceptsNewDestinationAndRejectsDeletedDestination(t *testing.T) {
	input := validEventLayout()
	input.Deletions = []EventStageDeletionInput{{ID: uuid.NewString(), MoveTo: EventStageDestination{Kind: "client", ID: "draft-confirmed"}}}
	if _, err := normalizeEventStageLayout(input); err != nil {
		t.Fatal(err)
	}
	input.Deletions[0].MoveTo = EventStageDestination{Kind: "stage", ID: input.Deletions[0].ID}
	if _, err := normalizeEventStageLayout(input); !errors.Is(err, ErrEventStageLayoutInvalid) {
		t.Fatal("accepted deleted destination")
	}
}
