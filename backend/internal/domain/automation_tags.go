package domain

import "strings"

// AutomationTagAction understands both the editor shape and historical config.
// An explicit editor tag_id (including empty) overrides the historical value.
func AutomationTagAction(node *AutomationNode) (kind, tagID string, ok bool) {
	kind = node.Type
	if kind != AutoNodeAssignTag && kind != AutoNodeRemoveTag {
		kind, _ = node.Data["nodeType"].(string)
	}
	if kind != AutoNodeAssignTag && kind != AutoNodeRemoveTag {
		return "", "", false
	}
	if raw, present := node.Data["tag_id"]; present {
		tagID, _ = raw.(string)
	} else if config, valid := node.Data["config"].(map[string]interface{}); valid {
		tagID, _ = config["tag_id"].(string)
	}
	return kind, strings.TrimSpace(tagID), true
}

// NormalizeAutomationTagActions preserves both formats without rewriting other nodes.
func NormalizeAutomationTagActions(graph *AutomationGraph) {
	for index := range graph.Nodes {
		node := &graph.Nodes[index]
		kind, tagID, ok := AutomationTagAction(node)
		if !ok {
			continue
		}
		data := make(map[string]interface{}, len(node.Data)+3)
		for key, value := range node.Data {
			data[key] = value
		}
		config := map[string]interface{}{}
		if old, ok := data["config"].(map[string]interface{}); ok {
			for key, value := range old {
				config[key] = value
			}
		}
		data["nodeType"] = kind
		data["tag_id"] = tagID
		config["tag_id"] = tagID
		data["config"] = config
		node.Data = data
	}
}
