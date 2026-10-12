package api

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestTagSearchContextPermissions(t *testing.T) {
	for _, test := range []struct {
		context, permission    string
		commercial, automation bool
	}{{"contact_create", domain.PermContacts, false, false}, {"lead_create", domain.PermLeads, true, false}, {"lead_import", domain.PermLeads, true, false}, {"automation", domain.PermAutomations, true, true}, {"other", "", false, false}} {
		permission, commercial, automation := tagSearchContextPermission(test.context)
		if permission != test.permission || commercial != test.commercial || automation != test.automation {
			t.Fatalf("unexpected context authority: %s", test.context)
		}
	}
}

func TestTagSearchIDHydrationIsBoundedAndDeduplicated(t *testing.T) {
	id := uuid.New()
	ids, err := parseTagSearchIDs(id.String() + "," + id.String())
	if err != nil || len(ids) != 1 {
		t.Fatalf("duplicate ids: %v %v", ids, err)
	}
	for _, raw := range []string{"invalid", uuid.Nil.String(), strings.Repeat(id.String()+",", 25) + id.String()} {
		if _, err := parseTagSearchIDs(raw); err == nil {
			t.Fatal("invalid hydration accepted")
		}
	}
}

func TestManualLeadTagIDsParserPreservesEmptyAndRejectsNull(t *testing.T) {
	empty, err := parseContactProfileTagIDs(json.RawMessage(`[]`))
	if err != nil || empty == nil || len(empty) != 0 {
		t.Fatal("explicit empty lost")
	}
	if _, err := parseContactProfileTagIDs(json.RawMessage(`null`)); err == nil {
		t.Fatal("null accepted")
	}
}

func TestAutomationTagConfigurationDraftAndActive(t *testing.T) {
	id := uuid.New()
	a := &domain.Automation{Config: domain.AutomationGraph{Nodes: []domain.AutomationNode{{Type: domain.AutoNodeAssignTag, Data: map[string]interface{}{"tag_id": ""}}}}}
	if ids, err := automationTagActionIDs(a); err != nil || len(ids) != 0 {
		t.Fatal("empty inactive draft rejected")
	}
	a.IsActive = true
	if _, err := automationTagActionIDs(a); err == nil {
		t.Fatal("active empty action accepted")
	}
	a.Config.Nodes[0].Data["tag_id"] = id.String()
	a.Config.Nodes = append(a.Config.Nodes, a.Config.Nodes[0])
	if ids, err := automationTagActionIDs(a); err != nil || len(ids) != 1 || ids[0] != id {
		t.Fatal("valid actions rejected/doubled")
	}
	a.Config.Nodes[0].Data["tag_id"] = "not-a-uuid"
	if _, err := automationTagActionIDs(a); err == nil {
		t.Fatal("malformed tag accepted")
	}
}
