package domain

import "strings"

// Feature ownership is explicit: event pipelines, contacts and generic file
// rendering are not commercial tools merely because their names overlap.
func ToolRequiresLeadModule(name string, args map[string]any) bool {
	switch name {
	case "search_leads", "get_lead_detail", "list_pipelines", "get_lead_analytics", "analyze_leads",
		"count_leads", "list_leads", "get_lead_analysis_overview", "get_lead_analysis_report",
		"export_leads_for_analysis", "get_lead_analysis_detail",
		"get_segment_members", "get_leads_with_chats", "query_leads_operational", "reuse_eros_result_set":
		return true
	}
	for _, key := range []string{"lead_id", "lead_ids"} {
		if value, ok := args[key]; ok && value != nil {
			switch value := value.(type) {
			case string:
				if strings.TrimSpace(value) != "" {
					return true
				}
			case []any:
				if len(value) > 0 {
					return true
				}
			case []string:
				if len(value) > 0 {
					return true
				}
			}
		}
	}
	return false
}

// Mixed tools retain independent Contact/Chat/automation behavior when Leads is
// disabled, but their enabled results may contain commercial enrichment.
func ToolMayIncludeLeadData(name string) bool {
	switch name {
	case "get_crm_stats", "get_contact_detail", "get_analysis_capabilities", "export_messages_for_analysis", "list_automations", "get_automation_detail":
		return true
	}
	return false
}
