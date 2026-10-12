package domain

import "time"

// LeadPolicy is account configuration, independent of user permissions.
type LeadPolicy struct {
	LeadsEnabled           bool       `json:"leads_enabled"`
	LeadAutomationEnabled  bool       `json:"lead_automation_enabled"`
	Version                int64      `json:"leads_policy_version"`
	AutomationEnabledSince *time.Time `json:"lead_automation_enabled_since"`
}

func (p LeadPolicy) AutomationEnabled() bool { return p.LeadsEnabled && p.LeadAutomationEnabled }

// AllowsAutomaticEvent rejects work from a previous enablement, including
// delayed provider deliveries and queued retries. A nil boundary preserves
// pre-policy behavior until an administrator first pauses the account.
func (p LeadPolicy) AllowsAutomaticEvent(version int64, occurredAt time.Time) bool {
	return p.AutomationEnabled() && p.Version == version && !occurredAt.IsZero() &&
		(p.AutomationEnabledSince == nil || !occurredAt.Before(*p.AutomationEnabledSince))
}

func IsCommercialAutomation(leadIDPresent bool, trigger string, graph *AutomationGraph) bool {
	if leadIDPresent {
		return true
	}
	switch trigger {
	case AutoTriggerLeadCreated, AutoTriggerLeadStageChanged, AutoTriggerTagAssigned, AutoTriggerTagRemoved:
		return true
	}
	if graph != nil {
		for _, node := range graph.Nodes {
			typ, _ := node.Data["nodeType"].(string)
			if tagKind, _, ok := AutomationTagAction(&node); ok {
				typ = tagKind
			}
			switch typ {
			case AutoNodeSendWhatsApp, AutoNodeChangeStage, AutoNodeAssignTag, AutoNodeRemoveTag, AutoNodeCondition, AutoTriggerLeadCreated, AutoTriggerLeadStageChanged, AutoTriggerTagAssigned, AutoTriggerTagRemoved:
				return true
			}
		}
	}
	return false
}
