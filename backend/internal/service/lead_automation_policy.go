package service

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"time"
)

type commercialExecutionCancel struct {
	accountID uuid.UUID
	cancel    context.CancelFunc
}

func (s *AutomationService) CancelCommercialAccount(accountID uuid.UUID) {
	s.policyMu.Lock()
	defer s.policyMu.Unlock()
	for _, entry := range s.commercialRunning {
		if entry.accountID == accountID {
			entry.cancel()
		}
	}
}

func executionPolicyVersion(exec *domain.AutomationExecution) int64 {
	if exec.ContextData != nil {
		switch value := exec.ContextData["leads_policy_version"].(type) {
		case int64:
			return value
		case float64:
			return int64(value)
		case json.Number:
			n, _ := value.Int64()
			return n
		}
	}
	return 1 // compatibility for jobs created before this policy existed
}

func (s *AutomationService) commercialExecutionContext(ctx context.Context, exec *domain.AutomationExecution) (context.Context, error) {
	if !domain.IsCommercialAutomation(exec.LeadID != nil, "", exec.ConfigSnapshot) {
		return ctx, nil
	}
	policy, err := s.repos.Account.GetLeadPolicy(ctx, exec.AccountID)
	if err != nil {
		return ctx, err
	}
	if !policy.AllowsAutomaticEvent(executionPolicyVersion(exec), exec.CreatedAt) {
		return ctx, repository.ErrLeadAutomationDisabled
	}
	return repository.WithLeadAutomationPolicy(ctx, policy.Version, exec.CreatedAt), nil
}

func (s *AutomationService) stopForCommercialPolicy(exec *domain.AutomationExecution, err error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	exec.Status = domain.AutoExecFailed
	exec.ErrorMessage = "lead_policy_paused"
	now := time.Now().UTC()
	exec.CompletedAt = &now
	exec.ResumeAt = nil
	_ = s.repos.Automation.UpdateExecution(ctx, exec)
	if !errors.Is(err, context.Canceled) {
		s.broadcastUpdate(exec.AccountID, exec.ID, domain.AutoExecFailed)
	}
}
