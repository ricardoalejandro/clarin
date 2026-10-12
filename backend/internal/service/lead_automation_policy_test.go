package service

import (
	"context"
	"encoding/json"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"testing"
)

func TestExecutionPolicyVersionSurvivesJSONAndLegacy(t *testing.T) {
	for _, value := range []interface{}{int64(7), float64(7), json.Number("7")} {
		e := &domain.AutomationExecution{ContextData: map[string]interface{}{"leads_policy_version": value}}
		if executionPolicyVersion(e) != 7 {
			t.Fatalf("lost epoch for %T", value)
		}
	}
	if executionPolicyVersion(&domain.AutomationExecution{}) != 1 {
		t.Fatal("legacy job compatibility epoch changed")
	}
}

func TestCancelCommercialAccountIsIsolated(t *testing.T) {
	a, b := uuid.New(), uuid.New()
	ctxA, cancelA := context.WithCancel(context.Background())
	defer cancelA()
	ctxB, cancelB := context.WithCancel(context.Background())
	defer cancelB()
	s := &AutomationService{commercialRunning: map[uuid.UUID]commercialExecutionCancel{uuid.New(): {accountID: a, cancel: cancelA}, uuid.New(): {accountID: b, cancel: cancelB}}}
	s.CancelCommercialAccount(a)
	if ctxA.Err() == nil || ctxB.Err() != nil {
		t.Fatal("cancellation crossed account boundary or missed worker")
	}
}
