package domain

import (
	"testing"
	"time"
)

func TestLeadPolicyAutomaticEventBoundary(t *testing.T) {
	now := time.Date(2026, 10, 11, 18, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name              string
		module, automatic bool
		version           int64
		since             *time.Time
		at                time.Time
		want              bool
	}{
		{"compatible default", true, true, 1, nil, now.Add(-time.Hour), true},
		{"module paused", false, true, 1, nil, now, false},
		{"automation paused", true, false, 1, nil, now, false},
		{"old epoch", true, true, 2, nil, now, false},
		{"old provider delivery", true, true, 1, &now, now.Add(-time.Second), false},
		{"reenabled boundary", true, true, 1, &now, now, true},
		{"new activity", true, true, 1, &now, now.Add(time.Second), true},
		{"missing event time", true, true, 1, nil, time.Time{}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := LeadPolicy{LeadsEnabled: tc.module, LeadAutomationEnabled: tc.automatic, Version: tc.version, AutomationEnabledSince: tc.since}
			if got := p.AllowsAutomaticEvent(1, tc.at); got != tc.want {
				t.Fatalf("allowed=%v want=%v", got, tc.want)
			}
		})
	}
}

func TestCommercialAutomationClassifiesActualConsumers(t *testing.T) {
	neutral := &AutomationGraph{Nodes: []AutomationNode{{Data: map[string]interface{}{"nodeType": AutoNodeDelay, "label": "condition send_whatsapp"}}}}
	if IsCommercialAutomation(false, AutoTriggerManual, neutral) {
		t.Fatal("labels do not change neutral node semantics")
	}
	if IsCommercialAutomation(false, AutoTriggerManual, nil) {
		t.Fatal("neutral manual graph must remain usable")
	}
	if !IsCommercialAutomation(true, AutoTriggerManual, nil) {
		t.Fatal("a Lead relation is commercial")
	}
	for _, kind := range []string{AutoTriggerLeadCreated, AutoTriggerLeadStageChanged, AutoTriggerTagAssigned, AutoTriggerTagRemoved} {
		if !IsCommercialAutomation(false, kind, nil) {
			t.Fatalf("commercial trigger %s escaped", kind)
		}
	}
	for _, kind := range []string{AutoNodeSendWhatsApp, AutoNodeChangeStage, AutoNodeAssignTag, AutoNodeRemoveTag, AutoNodeCondition, AutoNodeDelay} {
		graph := &AutomationGraph{Nodes: []AutomationNode{{Data: map[string]interface{}{"nodeType": kind}}}}
		if got := IsCommercialAutomation(false, AutoTriggerManual, graph); got != (kind != AutoNodeDelay) {
			t.Fatalf("node %s classified commercial=%v", kind, got)
		}
	}
}
