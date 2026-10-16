package repository

import (
	"encoding/json"
	"testing"
)

func TestOfflineV5TaskCreatePreservesVisibleFieldsAndRejectsUnknown(t *testing.T) {
	input, err := parseOfflineV5TaskCreate(json.RawMessage(`{"title":"  Seguimiento  ","type":"call","color":"#123aBC","assigned_to":"00000000-0000-4000-8000-000000000001","status_id":"00000000-0000-4000-8000-000000000002","priority":"urgent"}`))
	if err != nil || input.Title != "Seguimiento" || input.Type != "call" || input.Color == nil || *input.Color != "#123aBC" || input.AssignedTo == nil || input.StatusID == nil {
		t.Fatalf("lost canonical create fields: %#v %v", input, err)
	}
	for _, raw := range []string{`{"title":"x","collaborator_ids":[]}`, `{"title":"x","confirm_participant_grants":true}`, `{"title":"x","assigned_to":null}`, `{"title":"x","status_id":"bad"}`, `{"title":"x","type":"other"}`, `{"title":"x","color":"red"}`, `{"title":"x","title":"y"}`} {
		if _, err := parseOfflineV5TaskCreate(json.RawMessage(raw)); err == nil {
			t.Fatalf("accepted unsupported or invalid payload: %s", raw)
		}
	}
}
