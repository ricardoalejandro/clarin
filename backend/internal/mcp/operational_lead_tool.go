package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	mdmcp "github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/service"
)

func (s *MCPServer) registerOperationalLeadTool(mcpServer *server.MCPServer) {
	fieldItems := map[string]any{"type": "string", "enum": service.OperationalLeadAllowedFields()}
	interactionItems := map[string]any{"type": "string", "enum": service.OperationalLeadAllowedInteractionTypes()}

	mcpServer.AddTool(readOnlyTool("query_leads_operational",
		mdmcp.WithDescription("Cuenta o lista leads con filtros operativos combinables y SQL parametrizado. Úsala para consultas precisas sobre ausencia/presencia de mensajes, chats técnicos, respuestas, notas/llamadas y tareas. Para 'nunca revisados' usa conversation_state=no_messages, interaction_state=none e interaction_types=[note,call]. La paginación es estable por (created_at,id)."),
		mdmcp.WithString("account_id", mdmcp.Description("UUID de cuenta. Obténlo con list_accounts.")),
		mdmcp.WithString("account_slug", mdmcp.Description(mcpAccountSlugArgDescription)),
		mdmcp.WithString("mode", mdmcp.Description("Modo: list (default) o count.")),
		mdmcp.WithString("search", mdmcp.Description("Buscar por nombre, teléfono o email.")),
		mdmcp.WithString("pipeline", mdmcp.Description("UUID, nombre exacto o __no_pipeline__.")),
		mdmcp.WithString("stage", mdmcp.Description("UUID o nombre exacto de etapa.")),
		mdmcp.WithString("tag", mdmcp.Description("Nombre exacto del tag, sin distinguir mayúsculas.")),
		mdmcp.WithString("source", mdmcp.Description("Fuente exacta, sin distinguir mayúsculas.")),
		mdmcp.WithString("status", mdmcp.Description("Estado exacto: open, won o lost.")),
		mdmcp.WithBoolean("is_archived", mdmcp.Description("Filtrar explícitamente por archivado/no archivado.")),
		mdmcp.WithBoolean("is_blocked", mdmcp.Description("Filtrar explícitamente por bloqueado/no bloqueado.")),
		mdmcp.WithBoolean("is_deleted", mdmcp.Description("Filtrar explícitamente por papelera/fuera de papelera.")),
		mdmcp.WithBoolean("contactable", mdmcp.Description("true excluye contactos marcados como no contactables; false devuelve sólo no contactables.")),
		mdmcp.WithString("created_from", mdmcp.Description("Creación desde, inclusiva: YYYY-MM-DD o RFC3339.")),
		mdmcp.WithString("created_to", mdmcp.Description("Creación hasta, exclusiva. YYYY-MM-DD incluye el día indicado y se convierte al inicio del día siguiente.")),
		mdmcp.WithString("activity_from", mdmcp.Description("Última actividad desde, inclusiva: YYYY-MM-DD o RFC3339.")),
		mdmcp.WithString("activity_to", mdmcp.Description("Última actividad hasta, exclusiva. YYYY-MM-DD incluye el día indicado.")),
		mdmcp.WithString("timezone", mdmcp.Description("Zona IANA para fechas sin hora. Default America/Lima.")),
		mdmcp.WithString("conversation_state", mdmcp.Description("any, no_messages, no_chat_row, has_messages o unanswered.")),
		mdmcp.WithString("interaction_state", mdmcp.Description("any, none o present.")),
		mdmcp.WithArray("interaction_types", mdmcp.Description("Tipos a considerar en interaction_state."), mdmcp.Items(interactionItems), mdmcp.UniqueItems(true)),
		mdmcp.WithString("task_state", mdmcp.Description("any, none, present, pending u overdue.")),
		mdmcp.WithArray("fields", mdmcp.Description("Campos seguros a devolver. phone/email deben usarse sólo cuando la solicitud y los permisos los justifiquen."), mdmcp.Items(fieldItems), mdmcp.UniqueItems(true)),
		mdmcp.WithNumber("limit", mdmcp.Description("Resultados por página; default 100, máximo 500.")),
		mdmcp.WithString("cursor", mdmcp.Description("Cursor opaco devuelto por la página anterior.")),
	), s.toolQueryLeadsOperational)

	mcpServer.AddTool(readOnlyTool("reuse_eros_result_set",
		mdmcp.WithDescription("Reutiliza exactamente una selección previa de Eros y consulta campos actuales sin repetir sus filtros. Úsala para 'esa lista', 'los anteriores', añadir celulares/correos, resumir o exportar el resultado mostrado."),
		mdmcp.WithString("result_set_id", mdmcp.Required(), mdmcp.Description("ID del resultado guardado incluido en la memoria estructurada de la conversación.")),
		mdmcp.WithArray("fields", mdmcp.Required(), mdmcp.Description("Campos actuales que se necesitan."), mdmcp.Items(fieldItems), mdmcp.UniqueItems(true)),
	), s.toolReuseErosResultSet)

	clarificationItems := map[string]any{"type": "object", "required": []string{"id", "label", "description"}, "properties": map[string]any{
		"id": map[string]any{"type": "string"}, "label": map[string]any{"type": "string"}, "description": map[string]any{"type": "string"},
	}}
	mcpServer.AddTool(readOnlyTool("request_eros_clarification",
		mdmcp.WithDescription("Pausa la ejecución y pide una aclaración sólo cuando dos o más interpretaciones cambiarían materialmente el resultado. Ofrece 2 o 3 alternativas excluyentes; la interfaz siempre añadirá texto libre."),
		mdmcp.WithString("question", mdmcp.Required()),
		mdmcp.WithString("context", mdmcp.Description("Explicación breve de por qué hace falta elegir.")),
		mdmcp.WithArray("options", mdmcp.Required(), mdmcp.MinItems(2), mdmcp.MaxItems(3), mdmcp.Items(clarificationItems)),
	), s.toolRequestErosClarification)
}

func (s *MCPServer) toolQueryLeadsOperational(ctx context.Context, req mdmcp.CallToolRequest) (*mdmcp.CallToolResult, error) {
	accountID, err := s.getAccountIDFromRequest(ctx, req)
	if err != nil {
		return mcpAccountStructuredError(err), nil
	}

	filters, err := parseMCPOperationalLeadFilters(req)
	if err != nil {
		return mcpStructuredError("INVALID_FILTER", err.Error(), map[string]any{
			"allowed_fields":            service.OperationalLeadAllowedFields(),
			"allowed_interaction_types": service.OperationalLeadAllowedInteractionTypes(),
		}), nil
	}
	filters.AccountID = accountID

	result, err := service.NewOperationalLeadQueryService(s.repos).Query(ctx, filters)
	if err != nil {
		// Validation errors are safe and actionable. Database errors stay out of
		// the tool response because they may expose schema or operational detail.
		if isOperationalLeadValidationError(err) {
			return mcpStructuredError("INVALID_FILTER", err.Error(), nil), nil
		}
		return mcpStructuredError("QUERY_FAILED", "no se pudo ejecutar la consulta operativa de leads", nil), nil
	}
	if result.Mode == service.OperationalLeadQueryModeList && len(result.Items) > 0 {
		claims, claimsErr := s.getErosContextClaims(ctx, req)
		if claimsErr == nil && !claims.Legacy {
			runID, _ := uuid.Parse(claims.RunID)
			userID, _ := uuid.Parse(claims.UserID)
			ids := operationalResultIDs(result.Items)
			if len(ids) > 0 {
				filtersJSON, _ := json.Marshal(sanitizedErosToolArgs(req))
				set, saveErr := s.repos.ErosResultSet.Save(ctx, &domain.ErosResultSet{AccountID: accountID, UserID: userID, RunID: runID, EntityType: "lead", SourceTool: "query_leads_operational", Fields: result.Fields, Filters: filtersJSON, HasMore: result.HasMore, NextCursor: result.NextCursor, EntityIDs: ids})
				if saveErr == nil {
					return jsonResult(map[string]any{"mode": result.Mode, "count": result.Count, "items": result.Items, "returned": result.Returned, "has_more": result.HasMore, "next_cursor": result.NextCursor, "fields": result.Fields, "result_set": set}), nil
				}
			}
		}
	}
	return jsonResult(result), nil
}

func operationalResultIDs(items []map[string]any) []uuid.UUID {
	seen := map[uuid.UUID]bool{}
	ids := make([]uuid.UUID, 0, len(items))
	for _, item := range items {
		id, err := uuid.Parse(strings.TrimSpace(fmt.Sprint(item["id"])))
		if err == nil && !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	return ids
}

func sanitizedErosToolArgs(req mdmcp.CallToolRequest) map[string]any {
	out := map[string]any{}
	for key, value := range getArgs(req) {
		if key != "eros_context" && key != "account_id" && key != "account_slug" {
			out[key] = value
		}
	}
	return out
}

func (s *MCPServer) toolReuseErosResultSet(ctx context.Context, req mdmcp.CallToolRequest) (*mdmcp.CallToolResult, error) {
	claims, err := s.getErosContextClaims(ctx, req)
	if err != nil {
		return mcpAccountStructuredError(err), nil
	}
	accountID, _ := uuid.Parse(claims.AccountID)
	userID, _ := uuid.Parse(claims.UserID)
	runID, _ := uuid.Parse(claims.RunID)
	setID, err := uuid.Parse(strings.TrimSpace(stringArg(req, "result_set_id")))
	if err != nil {
		return mcpStructuredError("INVALID_RESULT_SET", "result_set_id inválido", nil), nil
	}
	set, err := s.repos.ErosResultSet.Get(ctx, accountID, userID, setID)
	if err != nil {
		return mcpStructuredError("RESULT_SET_NOT_FOUND", "el resultado guardado no existe o no pertenece al usuario actual", nil), nil
	}
	if set.EntityType != "lead" {
		return mcpStructuredError("UNSUPPORTED_RESULT_SET", "este tipo de resultado todavía no admite enriquecimiento directo", nil), nil
	}
	fields, err := mcpStringArrayArg(req, "fields")
	if err != nil {
		return mcpStructuredError("INVALID_FILTER", err.Error(), nil), nil
	}
	if !containsString(fields, "id") {
		fields = append([]string{"id"}, fields...)
	}
	result, err := service.NewOperationalLeadQueryService(s.repos).Query(ctx, service.OperationalLeadFilters{AccountID: accountID, Mode: service.OperationalLeadQueryModeList, Fields: fields, Limit: len(set.EntityIDs), IDs: set.EntityIDs, PreserveIDOrder: true})
	if err != nil {
		return mcpStructuredError("QUERY_FAILED", "no se pudo actualizar el resultado guardado", nil), nil
	}
	currentIDs := operationalResultIDs(result.Items)
	missing := len(set.EntityIDs) - len(currentIDs)
	filtersJSON, _ := json.Marshal(map[string]any{"source_result_set_id": set.ID, "strategy": "snapshot"})
	newSet, saveErr := s.repos.ErosResultSet.Save(ctx, &domain.ErosResultSet{AccountID: accountID, UserID: userID, RunID: runID, EntityType: "lead", SourceTool: "reuse_eros_result_set", Fields: result.Fields, Filters: filtersJSON, EntityIDs: currentIDs})
	response := map[string]any{"mode": "list", "items": result.Items, "returned": result.Returned, "fields": result.Fields, "source_result_set_id": set.ID, "missing_records": missing}
	if saveErr == nil {
		response["result_set"] = newSet
	}
	return jsonResult(response), nil
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func (s *MCPServer) toolRequestErosClarification(ctx context.Context, req mdmcp.CallToolRequest) (*mdmcp.CallToolResult, error) {
	claims, err := s.getErosContextClaims(ctx, req)
	if err != nil {
		return mcpAccountStructuredError(err), nil
	}
	runID, _ := uuid.Parse(claims.RunID)
	var depth int
	_ = s.repos.DB().QueryRow(ctx, `WITH RECURSIVE chain AS (SELECT id,parent_run_id FROM eros_runs WHERE id=$1 UNION ALL SELECT r.id,r.parent_run_id FROM eros_runs r JOIN chain c ON r.id=c.parent_run_id) SELECT GREATEST(COUNT(*)-1,0) FROM chain`, runID).Scan(&depth)
	if depth >= 2 {
		return mcpStructuredError("CLARIFICATION_LIMIT", "ya se solicitaron dos aclaraciones; pide ahora una instrucción textual concreta", nil), nil
	}
	question := strings.TrimSpace(stringArg(req, "question"))
	contextText := strings.TrimSpace(stringArg(req, "context"))
	rawOptions, ok := getArgs(req)["options"].([]any)
	if question == "" || !ok || len(rawOptions) < 2 || len(rawOptions) > 3 {
		return mcpStructuredError("INVALID_CLARIFICATION", "se requieren una pregunta y entre 2 y 3 alternativas", nil), nil
	}
	options := make([]map[string]string, 0, len(rawOptions))
	seen := map[string]bool{}
	for _, raw := range rawOptions {
		value, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		id := strings.TrimSpace(fmt.Sprint(value["id"]))
		label := strings.TrimSpace(fmt.Sprint(value["label"]))
		description := strings.TrimSpace(fmt.Sprint(value["description"]))
		if id == "" || label == "" || description == "" || seen[id] {
			continue
		}
		seen[id] = true
		options = append(options, map[string]string{"id": id, "label": label, "description": description})
	}
	if len(options) < 2 {
		return mcpStructuredError("INVALID_CLARIFICATION", "las alternativas deben ser únicas y completas", nil), nil
	}
	return jsonResult(map[string]any{"eros_clarification": true, "question": question, "context": contextText, "options": options, "allow_custom": true}), nil
}

func parseMCPOperationalLeadFilters(req mdmcp.CallToolRequest) (service.OperationalLeadFilters, error) {
	timezone := strings.TrimSpace(stringArg(req, "timezone"))
	if timezone == "" {
		timezone = mcpSimpleLeadDefaultTimezone
	}
	location, err := time.LoadLocation(timezone)
	if err != nil {
		return service.OperationalLeadFilters{}, fmt.Errorf("timezone inválido: %s", timezone)
	}

	createdFrom, err := parseMCPOperationalDate(stringArg(req, "created_from"), location, false)
	if err != nil {
		return service.OperationalLeadFilters{}, fmt.Errorf("created_from: %w", err)
	}
	createdTo, err := parseMCPOperationalDate(stringArg(req, "created_to"), location, true)
	if err != nil {
		return service.OperationalLeadFilters{}, fmt.Errorf("created_to: %w", err)
	}
	activityFrom, err := parseMCPOperationalDate(stringArg(req, "activity_from"), location, false)
	if err != nil {
		return service.OperationalLeadFilters{}, fmt.Errorf("activity_from: %w", err)
	}
	activityTo, err := parseMCPOperationalDate(stringArg(req, "activity_to"), location, true)
	if err != nil {
		return service.OperationalLeadFilters{}, fmt.Errorf("activity_to: %w", err)
	}

	fields, err := mcpStringArrayArg(req, "fields")
	if err != nil {
		return service.OperationalLeadFilters{}, err
	}
	interactionTypes, err := mcpStringArrayArg(req, "interaction_types")
	if err != nil {
		return service.OperationalLeadFilters{}, err
	}

	return service.OperationalLeadFilters{
		Mode:              service.OperationalLeadQueryMode(strings.ToLower(strings.TrimSpace(stringArg(req, "mode")))),
		Search:            strings.TrimSpace(stringArg(req, "search")),
		Pipeline:          strings.TrimSpace(stringArg(req, "pipeline")),
		Stage:             strings.TrimSpace(stringArg(req, "stage")),
		Tag:               strings.TrimSpace(stringArg(req, "tag")),
		Source:            strings.TrimSpace(stringArg(req, "source")),
		Status:            strings.TrimSpace(stringArg(req, "status")),
		Archived:          mcpOptionalBoolArg(req, "is_archived"),
		Blocked:           mcpOptionalBoolArg(req, "is_blocked"),
		Deleted:           mcpOptionalBoolArg(req, "is_deleted"),
		Contactable:       mcpOptionalBoolArg(req, "contactable"),
		CreatedFrom:       createdFrom,
		CreatedTo:         createdTo,
		ActivityFrom:      activityFrom,
		ActivityTo:        activityTo,
		ConversationState: service.OperationalConversationState(strings.ToLower(strings.TrimSpace(stringArg(req, "conversation_state")))),
		InteractionState:  service.OperationalPresenceState(strings.ToLower(strings.TrimSpace(stringArg(req, "interaction_state")))),
		InteractionTypes:  interactionTypes,
		TaskState:         service.OperationalTaskState(strings.ToLower(strings.TrimSpace(stringArg(req, "task_state")))),
		Fields:            fields,
		Limit:             intArg(req, "limit", 100, 500),
		Cursor:            strings.TrimSpace(stringArg(req, "cursor")),
	}, nil
}

func mcpOptionalBoolArg(req mdmcp.CallToolRequest, key string) *bool {
	value, ok := getArgs(req)[key].(bool)
	if !ok {
		return nil
	}
	return &value
}

func parseMCPOperationalDate(raw string, location *time.Location, end bool) (*time.Time, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	if parsed, err := time.ParseInLocation("2006-01-02", raw, location); err == nil {
		if end {
			parsed = parsed.AddDate(0, 0, 1)
		}
		return &parsed, nil
	}
	if parsed, err := time.Parse(time.RFC3339, raw); err == nil {
		return &parsed, nil
	}
	return nil, errors.New("debe tener formato YYYY-MM-DD o RFC3339")
}

func mcpStringArrayArg(req mdmcp.CallToolRequest, key string) ([]string, error) {
	raw, exists := getArgs(req)[key]
	if !exists || raw == nil {
		return nil, nil
	}
	values := make([]string, 0)
	switch typed := raw.(type) {
	case []any:
		for _, value := range typed {
			text, ok := value.(string)
			if !ok {
				return nil, fmt.Errorf("%s debe contener sólo strings", key)
			}
			values = append(values, text)
		}
	case []string:
		values = append(values, typed...)
	case string:
		values = append(values, strings.Split(typed, ",")...)
	default:
		return nil, fmt.Errorf("%s debe ser un array de strings", key)
	}
	result := make([]string, 0, len(values))
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			result = append(result, value)
		}
	}
	return result, nil
}

func isOperationalLeadValidationError(err error) bool {
	if err == nil {
		return false
	}
	message := err.Error()
	return strings.HasPrefix(message, "invalid ") ||
		strings.HasSuffix(message, " is required") ||
		strings.Contains(message, " must be before ")
}
