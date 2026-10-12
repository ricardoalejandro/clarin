package mcp

import "testing"

func TestLeadPolicyToolOwnership(t *testing.T) {
	for _, name := range []string{"search_leads", "get_leads_with_chats", "get_segment_members", "reuse_eros_result_set", "list_pipelines"} {
		if !toolRequiresLeadModule(name, nil) {
			t.Errorf("commercial tool %s bypasses policy", name)
		}
	}
	for _, name := range []string{"list_accounts", "search_contacts", "get_contact_detail", "list_chats", "get_chat_history", "list_events", "get_program_detail", "render_file_export", "get_analysis_capabilities", "get_automation_detail", "list_automations", "export_messages_for_analysis"} {
		if toolRequiresLeadModule(name, nil) {
			t.Errorf("independent/mixed tool %s incorrectly blocked", name)
		}
	}
	if !toolRequiresLeadModule("get_chat_history", map[string]any{"lead_id": "lead-a"}) {
		t.Fatal("explicit commercial scope bypasses policy")
	}
	if toolRequiresLeadModule("get_chat_history", map[string]any{"lead_id": "", "lead_ids": []any{}}) {
		t.Fatal("empty scope should preserve independent chat")
	}
}
