package api

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

type botGraphDTO struct {
	Nodes []botNodeDTO `json:"nodes"`
	Edges []botEdgeDTO `json:"edges"`
}

type botNodeDTO struct {
	ID   string                 `json:"id"`
	Type string                 `json:"type"`
	Data map[string]interface{} `json:"data"`
}

type botEdgeDTO struct {
	ID           string `json:"id"`
	Source       string `json:"source"`
	Target       string `json:"target"`
	SourceHandle string `json:"sourceHandle,omitempty"`
}

func (s *Server) handleListBots(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	flows, err := s.repos.Bot.List(c.Context(), accountID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if flows == nil {
		flows = []*domain.BotFlow{}
	}
	return c.JSON(fiber.Map{"success": true, "bots": flows})
}

func (s *Server) handleGetBot(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid bot ID"})
	}
	flow, err := s.repos.Bot.GetByID(c.Context(), id, accountID)
	if err != nil || flow == nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Bot not found"})
	}
	return c.JSON(fiber.Map{"success": true, "bot": flow})
}

func (s *Server) handleCreateBot(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	var req struct {
		Name          string                 `json:"name"`
		Description   string                 `json:"description"`
		Channel       string                 `json:"channel"`
		TriggerType   string                 `json:"trigger_type"`
		TriggerConfig map[string]interface{} `json:"trigger_config"`
		Graph         interface{}            `json:"graph"`
		IsActive      bool                   `json:"is_active"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	if strings.TrimSpace(req.Name) == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "name is required"})
	}
	flow := &domain.BotFlow{
		AccountID:     accountID,
		Name:          strings.TrimSpace(req.Name),
		Description:   req.Description,
		Channel:       defaultString(req.Channel, domain.BotChannelWhatsApp),
		TriggerType:   defaultString(req.TriggerType, domain.BotTriggerMessageReceived),
		TriggerConfig: req.TriggerConfig,
		Graph:         marshalJSONDefault(req.Graph, `{"nodes":[{"id":"trigger","type":"trigger","data":{"label":"Mensaje recibido"}}],"edges":[]}`),
		IsActive:      req.IsActive,
	}
	if err := s.repos.Bot.Create(c.Context(), flow); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.Status(201).JSON(fiber.Map{"success": true, "bot": flow})
}

func (s *Server) handleUpdateBot(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid bot ID"})
	}
	flow, err := s.repos.Bot.GetByID(c.Context(), id, accountID)
	if err != nil || flow == nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Bot not found"})
	}
	var req struct {
		Name          string                 `json:"name"`
		Description   string                 `json:"description"`
		Channel       string                 `json:"channel"`
		TriggerType   string                 `json:"trigger_type"`
		TriggerConfig map[string]interface{} `json:"trigger_config"`
		Graph         interface{}            `json:"graph"`
		IsActive      bool                   `json:"is_active"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	flow.Name = strings.TrimSpace(req.Name)
	flow.Description = req.Description
	flow.Channel = defaultString(req.Channel, domain.BotChannelWhatsApp)
	flow.TriggerType = defaultString(req.TriggerType, domain.BotTriggerMessageReceived)
	flow.TriggerConfig = req.TriggerConfig
	flow.Graph = marshalJSONDefault(req.Graph, string(flow.Graph))
	flow.IsActive = req.IsActive
	if flow.Name == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "name is required"})
	}
	if err := s.repos.Bot.Update(c.Context(), flow); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	updated, _ := s.repos.Bot.GetByID(c.Context(), id, accountID)
	return c.JSON(fiber.Map{"success": true, "bot": updated})
}

func (s *Server) handleDeleteBot(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid bot ID"})
	}
	if err := s.repos.Bot.Delete(c.Context(), id, accountID); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handlePublishBot(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid bot ID"})
	}
	var userID *uuid.UUID
	if localUserID, ok := c.Locals("user_id").(uuid.UUID); ok {
		userID = &localUserID
	}
	flow, err := s.repos.Bot.Publish(c.Context(), id, accountID, userID)
	if err != nil || flow == nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Bot not found"})
	}
	return c.JSON(fiber.Map{"success": true, "bot": flow})
}

func (s *Server) handleSimulateBot(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid bot ID"})
	}
	flow, err := s.repos.Bot.GetByID(c.Context(), id, accountID)
	if err != nil || flow == nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Bot not found"})
	}
	var req struct {
		Message string                 `json:"message"`
		Context map[string]interface{} `json:"context"`
	}
	_ = c.BodyParser(&req)
	if req.Context == nil {
		req.Context = map[string]interface{}{}
	}
	if req.Message != "" {
		req.Context["message"] = req.Message
	}
	result := simulateBotFlow(flow, req.Context)
	for _, step := range result.Steps {
		_ = s.repos.Bot.LogExecution(c.Context(), &domain.BotExecutionLog{
			AccountID: accountID,
			FlowID:    flow.ID,
			NodeID:    step.NodeID,
			NodeType:  step.NodeType,
			Status:    step.Status,
			Input:     req.Context,
			Output:    step.Output,
			Error:     result.Error,
		})
	}
	return c.JSON(fiber.Map{"success": true, "result": result})
}

func (s *Server) handleListBotLogs(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid bot ID"})
	}
	if flow, _ := s.repos.Bot.GetByID(c.Context(), id, accountID); flow == nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Bot not found"})
	}
	logs, err := s.repos.Bot.ListLogs(c.Context(), id, accountID, c.QueryInt("limit", 50))
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if logs == nil {
		logs = []*domain.BotExecutionLog{}
	}
	return c.JSON(fiber.Map{"success": true, "logs": logs})
}

func simulateBotFlow(flow *domain.BotFlow, input map[string]interface{}) domain.BotSimulationResult {
	result := domain.BotSimulationResult{FlowID: flow.ID, Steps: []domain.BotSimulationStep{}}
	var graph botGraphDTO
	if err := json.Unmarshal(flow.Graph, &graph); err != nil {
		result.Error = "graph invalid: " + err.Error()
		return result
	}
	if len(graph.Nodes) == 0 {
		result.Ended = true
		return result
	}
	nodes := map[string]botNodeDTO{}
	for _, node := range graph.Nodes {
		nodes[node.ID] = node
	}
	current := graph.Nodes[0].ID
	for _, node := range graph.Nodes {
		if node.Type == "trigger" {
			current = node.ID
			break
		}
	}
	visited := map[string]bool{}
	for stepCount := 0; stepCount < 50; stepCount++ {
		node, ok := nodes[current]
		if !ok {
			result.Error = fmt.Sprintf("node %s not found", current)
			return result
		}
		if visited[current] {
			result.Error = fmt.Sprintf("cycle detected at node %s", current)
			return result
		}
		visited[current] = true
		output, branch := simulateBotNode(node, input)
		result.Steps = append(result.Steps, domain.BotSimulationStep{
			NodeID:   node.ID,
			NodeType: node.Type,
			Label:    stringFromMap(node.Data, "label", node.Type),
			Status:   "success",
			Output:   output,
		})
		next := ""
		for _, edge := range graph.Edges {
			if edge.Source != current {
				continue
			}
			if branch == "" || edge.SourceHandle == "" || edge.SourceHandle == branch {
				next = edge.Target
				break
			}
		}
		if next == "" {
			result.Ended = true
			return result
		}
		current = next
	}
	result.Error = "simulation limit reached"
	return result
}

func simulateBotNode(node botNodeDTO, input map[string]interface{}) (map[string]interface{}, string) {
	switch node.Type {
	case "trigger":
		return map[string]interface{}{"accepted": true}, ""
	case "message", "send_message", "send_whatsapp":
		return map[string]interface{}{"message": stringFromMap(node.Data, "message", stringFromMap(node.Data, "message_template", "")), "send_blocked": true}, ""
	case "condition":
		field := stringFromMap(node.Data, "field", "message")
		operator := stringFromMap(node.Data, "operator", "contains")
		value := strings.ToLower(stringFromMap(node.Data, "value", ""))
		actual := strings.ToLower(fmt.Sprint(input[field]))
		matched := false
		switch operator {
		case "eq":
			matched = actual == value
		case "neq":
			matched = actual != value
		case "starts_with":
			matched = strings.HasPrefix(actual, value)
		case "empty":
			matched = strings.TrimSpace(actual) == ""
		case "not_empty":
			matched = strings.TrimSpace(actual) != ""
		default:
			matched = value == "" || strings.Contains(actual, value)
		}
		branch := "false"
		if matched {
			branch = "true"
		}
		return map[string]interface{}{"matched": matched, "branch": branch}, branch
	case "assign_tag", "remove_tag", "change_stage":
		return map[string]interface{}{"action": node.Type, "dry_run": true}, ""
	case "handoff":
		return map[string]interface{}{"handoff": true}, ""
	default:
		return map[string]interface{}{"node_type": node.Type, "dry_run": true}, ""
	}
}

func stringFromMap(data map[string]interface{}, key, fallback string) string {
	if data == nil {
		return fallback
	}
	value, ok := data[key]
	if !ok || value == nil {
		return fallback
	}
	return fmt.Sprint(value)
}
