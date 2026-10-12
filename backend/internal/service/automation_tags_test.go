package service

import (
	"context"
	"testing"

	"github.com/naperu/clarin/internal/domain"
)

func TestAutomationTagNodesDispatchEditorAndHistoricalConfigs(t *testing.T) {
	service := &AutomationService{}
	for _, kind := range []string{domain.AutoNodeAssignTag, domain.AutoNodeRemoveTag} {
		for _, node := range []domain.AutomationNode{{Type: kind, Data: map[string]interface{}{"tag_id": "not-uuid"}}, {Type: "action", Data: map[string]interface{}{"nodeType": kind, "config": map[string]interface{}{"tag_id": "not-uuid"}}}} {
			_, err := service.executeNode(context.Background(), &domain.AutomationExecution{}, &node)
			if err == nil || err.Error() != "no lead_id for tag action" {
				t.Fatalf("tag node was skipped: %v", err)
			}
		}
	}
}
