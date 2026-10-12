package mcp

import (
	"github.com/naperu/clarin/internal/domain"
	"strings"
	"testing"
)

func TestIndependentMessageExportAvoidsLeadJoin(t *testing.T) {
	if strings.Contains(messageExportLeadIDsSQL(false), "leads") {
		t.Fatal("disabled export queries commercial data")
	}
	if !strings.Contains(messageExportLeadIDsSQL(true), "l.account_id = $1") {
		t.Fatal("commercial enrichment lost account scope")
	}
	if toolRequiresLeadModule("export_messages_for_analysis", map[string]any{"contact_id": "contact"}) {
		t.Fatal("Contact export blocked")
	}
	if !toolRequiresLeadModule("export_messages_for_analysis", map[string]any{"lead_id": "lead"}) {
		t.Fatal("commercial export bypass")
	}
}

func TestAutomationVisibilityUsesGraphAndTrigger(t *testing.T) {
	independent := &domain.Automation{TriggerType: "manual"}
	commercial := &domain.Automation{TriggerType: domain.AutoTriggerLeadCreated}
	if !automationVisibleForLeadPolicy(independent, false) || automationVisibleForLeadPolicy(commercial, false) || !automationVisibleForLeadPolicy(commercial, true) || automationVisibleForLeadPolicy(nil, true) {
		t.Fatal("automation module ownership changed")
	}
	for _, name := range []string{"export_messages_for_analysis", "list_automations", "get_automation_detail", "get_contact_detail", "get_crm_stats"} {
		if !domain.ToolMayIncludeLeadData(name) {
			t.Fatalf("%s missing completion epoch check", name)
		}
	}
}
