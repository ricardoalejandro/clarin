package api

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestDirectParticipantInteractionScope(t *testing.T) {
	tests := []struct {
		name       string
		raw        string
		directOnly bool
		wantErr    bool
	}{
		{name: "legacy aggregate", raw: "", directOnly: false},
		{name: "direct participant", raw: "participant", directOnly: true},
		{name: "trimmed direct participant", raw: " participant ", directOnly: true},
		{name: "reject ambiguous scope", raw: "contact", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			directOnly, err := directParticipantInteractionScope(tt.raw)
			if (err != nil) != tt.wantErr {
				t.Fatalf("directParticipantInteractionScope(%q) error = %v, wantErr %v", tt.raw, err, tt.wantErr)
			}
			if directOnly != tt.directOnly {
				t.Fatalf("directParticipantInteractionScope(%q) = %v, want %v", tt.raw, directOnly, tt.directOnly)
			}
		})
	}
}

func TestDirectParticipantInteractionWhereIsAccountScopedAndDoesNotAggregateContact(t *testing.T) {
	where := directParticipantInteractionWhere()
	for _, required := range []string{"i.account_id = $1", "i.participant_id = $2"} {
		if !strings.Contains(where, required) {
			t.Fatalf("direct participant filter must contain %q: %s", required, where)
		}
	}
	for _, forbidden := range []string{"i.contact_id", "i.lead_id"} {
		if strings.Contains(where, forbidden) {
			t.Fatalf("direct participant filter must not aggregate %q: %s", forbidden, where)
		}
	}
}

func TestParseOptionalCRMOperationID(t *testing.T) {
	const valid = "6f2d88b4-3a35-49ff-b302-9ccf4d0d64ab"
	if got, err := parseOptionalCRMOperationID("  " + valid + "  "); err != nil || got != valid {
		t.Fatalf("valid operation id = %q, %v", got, err)
	}
	if got, err := parseOptionalCRMOperationID(""); err != nil || got != "" {
		t.Fatalf("empty operation id = %q, %v", got, err)
	}
	if _, err := parseOptionalCRMOperationID("not-a-uuid"); err == nil {
		t.Fatal("invalid operation id must be rejected")
	}
}

func TestParseCRMStageTargetSupportsCanonicalUnassigned(t *testing.T) {
	valid := uuid.New()
	stageID, err := parseCRMStageTarget(json.RawMessage(`"` + valid.String() + `"`))
	if err != nil || stageID == nil || *stageID != valid {
		t.Fatalf("valid stage = %#v, %v", stageID, err)
	}
	for _, raw := range []json.RawMessage{json.RawMessage(`null`), json.RawMessage(`"__unassigned__"`), json.RawMessage(`""`)} {
		stageID, err = parseCRMStageTarget(raw)
		if err != nil || stageID != nil {
			t.Fatalf("unassigned %s = %#v, %v", raw, stageID, err)
		}
	}
	if _, err := parseCRMStageTarget(nil); err == nil {
		t.Fatal("missing stage_id must be rejected")
	}
	if _, err := parseCRMStageTarget(json.RawMessage(`"not-a-uuid"`)); err == nil {
		t.Fatal("invalid stage id must be rejected")
	}
}

func TestInteractionUpdatePayloadPreservesDirectScope(t *testing.T) {
	contactID := uuid.New()
	leadID := uuid.New()
	eventID := uuid.New()
	participantID := uuid.New()
	interactionID := uuid.New()
	payload := interactionUpdatePayload("created", &domain.Interaction{
		ID: interactionID, ContactID: &contactID, LeadID: &leadID, EventID: &eventID, ParticipantID: &participantID,
	})

	for key, want := range map[string]string{
		"interaction_id": interactionID.String(),
		"contact_id":     contactID.String(),
		"lead_id":        leadID.String(),
		"event_id":       eventID.String(),
		"participant_id": participantID.String(),
	} {
		if got, ok := payload[key].(string); !ok || got != want {
			t.Fatalf("%s = %#v, want %q", key, payload[key], want)
		}
	}
	if payload["interaction"] == nil {
		t.Fatal("created events must include the canonical interaction")
	}
}

func TestInteractionUpdatePayloadDoesNotInventUnrelatedScopes(t *testing.T) {
	payload := interactionUpdatePayload("deleted", &domain.Interaction{ID: uuid.New()})
	for _, key := range []string{"contact_id", "lead_id", "event_id", "participant_id", "interaction"} {
		if _, exists := payload[key]; exists {
			t.Fatalf("deleted payload unexpectedly contains %s", key)
		}
	}
}
