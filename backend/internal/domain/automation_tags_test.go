package domain

import "testing"

func TestAutomationTagActionSupportsEditorAndLegacyWithoutChangingOtherNodes(t *testing.T) {
	for _, kind := range []string{AutoNodeAssignTag, AutoNodeRemoveTag} {
		editor := AutomationNode{Type: kind, Data: map[string]interface{}{"tag_id": "editor"}}
		legacy := AutomationNode{Type: "action", Data: map[string]interface{}{"nodeType": kind, "config": map[string]interface{}{"tag_id": "legacy", "other": true}}}
		for _, node := range []*AutomationNode{&editor, &legacy} {
			want := "editor"
			if node == &legacy {
				want = "legacy"
			}
			graph := AutomationGraph{Nodes: []AutomationNode{*node}}
			NormalizeAutomationTagActions(&graph)
			got, id, ok := AutomationTagAction(&graph.Nodes[0])
			if !ok || got != kind || id != want {
				t.Fatalf("action %q %q %v", got, id, ok)
			}
			if graph.Nodes[0].Data["tag_id"] != want || graph.Nodes[0].Data["config"].(map[string]interface{})["tag_id"] != want {
				t.Fatal("formats differ")
			}
			if !IsCommercialAutomation(false, "manual", &graph) {
				t.Fatal("tag action bypassed commercial policy")
			}
		}
	}
	graph := AutomationGraph{Nodes: []AutomationNode{{Type: "delay", Data: map[string]interface{}{"duration_minutes": 5}}}}
	NormalizeAutomationTagActions(&graph)
	if len(graph.Nodes[0].Data) != 1 {
		t.Fatal("unrelated node changed")
	}
}

func TestAutomationTagActionExplicitClearWinsOverLegacy(t *testing.T) {
	node := AutomationNode{Type: AutoNodeAssignTag, Data: map[string]interface{}{"tag_id": "", "config": map[string]interface{}{"tag_id": "old"}}}
	_, id, ok := AutomationTagAction(&node)
	if !ok || id != "" {
		t.Fatal("cleared draft restored old tag")
	}
}
