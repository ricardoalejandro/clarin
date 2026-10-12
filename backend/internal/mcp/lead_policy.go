package mcp

import (
	"context"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"

	"github.com/mark3labs/mcp-go/mcp"
)

func toolRequiresLeadModule(name string, args map[string]any) bool {
	return domain.ToolRequiresLeadModule(name, args)
}

type leadToolPolicyKey struct{}
type leadToolPolicyStamp struct {
	accountID uuid.UUID
	version   int64
}

func (s *MCPServer) leadPolicyToolContext(ctx context.Context, req mcp.CallToolRequest) (context.Context, *mcp.CallToolResult) {
	required := toolRequiresLeadModule(req.Params.Name, getArgs(req))
	mixed := domain.ToolMayIncludeLeadData(req.Params.Name)
	if !required && !mixed {
		return ctx, nil
	}
	accountID, err := s.getAccountIDFromRequest(ctx, req)
	if err != nil {
		return ctx, mcpAccountStructuredError(err)
	}
	policy, err := s.repos.Account.GetLeadPolicy(ctx, accountID)
	if err != nil {
		return ctx, mcpStructuredError("LEAD_POLICY_UNAVAILABLE", "No se pudo verificar la configuración de Leads.", nil)
	}
	if required && !policy.LeadsEnabled {
		return ctx, mcpStructuredError("LEADS_MODULE_DISABLED", "Leads está desactivado en esta cuenta. Los datos se conservan.", nil)
	}
	if policy.LeadsEnabled {
		ctx = repository.WithLeadPolicyVersion(ctx, policy.Version)
	}
	return context.WithValue(ctx, leadToolPolicyKey{}, leadToolPolicyStamp{accountID, policy.Version}), nil
}

func (s *MCPServer) leadPolicyCompletionError(ctx context.Context) *mcp.CallToolResult {
	stamp, ok := ctx.Value(leadToolPolicyKey{}).(leadToolPolicyStamp)
	if !ok {
		return nil
	}
	policy, err := s.repos.Account.GetLeadPolicy(ctx, stamp.accountID)
	if err != nil || policy.Version != stamp.version {
		return mcpStructuredError("LEAD_POLICY_CHANGED", "La configuración de Leads cambió durante la consulta. Vuelve a intentarlo.", nil)
	}
	return nil
}
