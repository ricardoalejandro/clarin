package service

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

const (
	ErosQuickTaskLeadCycleSummary      = "lead_cycle_summary"
	ErosQuickTaskLeadOperationalSearch = "lead_operational_search"
	ErosQuickTaskLeadUnmanaged         = "lead_unmanaged"
	ErosQuickTaskLeadFollowupPriority  = "lead_followup_priority"
	ErosQuickTaskChatUnanswered        = "chat_unanswered"
	ErosQuickTaskTaskOverdue           = "task_overdue"
	ErosQuickTaskLeadDataQuality       = "lead_data_quality"
	ErosQuickTaskPerformanceOverview   = "performance_overview"
	ErosQuickTaskExportCurrentResult   = "export_current_result"
)

const (
	ErosQuickTaskActionOperationalLeadQuery = "query_leads_operational"
	ErosQuickTaskActionLeadCycleSummary     = "summarize_lead_cycle"
	ErosQuickTaskActionFollowupPriority     = "rank_lead_followup"
	ErosQuickTaskActionLeadDataQuality      = "analyze_lead_data_quality"
	ErosQuickTaskActionPerformanceOverview  = "summarize_performance"
	ErosQuickTaskActionExportCurrentResult  = "export_current_result"
)

// ErosQuickTaskDefinition is the backend-owned catalog contract. Action is an
// allowlisted dispatcher key, never a function name supplied by the client.
type ErosQuickTaskDefinition struct {
	ID             string         `json:"id"`
	Title          string         `json:"title"`
	Description    string         `json:"description"`
	Category       string         `json:"category"`
	Action         string         `json:"action"`
	Permission     string         `json:"-"`
	ReadOnly       bool           `json:"read_only"`
	SupportsExport bool           `json:"supports_export"`
	InputSchema    map[string]any `json:"input_schema"`
	Defaults       map[string]any `json:"defaults,omitempty"`
}

// ErosQuickTaskCatalog returns a defensive copy so handlers can filter the
// catalog by permissions without modifying process-global state.
func ErosQuickTaskCatalog() []ErosQuickTaskDefinition {
	definitions := []ErosQuickTaskDefinition{
		{
			ID: ErosQuickTaskLeadCycleSummary, Title: "Resumen de leads", Category: "leads",
			Description: "Cuenta abiertas, ganadas, perdidas y archivadas en el pipeline elegido.",
			Action:      ErosQuickTaskActionLeadCycleSummary, Permission: domain.PermLeads, ReadOnly: true, SupportsExport: true,
			InputSchema: objectSchema(map[string]any{
				"pipeline": stringSchema("UUID, nombre exacto o __no_pipeline__."),
			}),
		},
		{
			ID: ErosQuickTaskLeadOperationalSearch, Title: "Buscar leads", Category: "leads",
			Description: "Busca o cuenta leads combinando pipeline, etapa, tag, fuente, estado, fechas, conversaciones, interacciones y tareas.",
			Action:      ErosQuickTaskActionOperationalLeadQuery, Permission: domain.PermLeads, ReadOnly: true, SupportsExport: true,
			InputSchema: operationalLeadQuickTaskSchema(),
			Defaults:    map[string]any{"mode": "list", "limit": 100},
		},
		{
			ID: ErosQuickTaskLeadUnmanaged, Title: "Leads aún no gestionados", Category: "seguimiento",
			Description: "Lista leads sin mensajes reales y sin notas ni llamadas registradas.",
			Action:      ErosQuickTaskActionOperationalLeadQuery, Permission: domain.PermLeads, ReadOnly: true, SupportsExport: true,
			InputSchema: objectSchema(map[string]any{
				"pipeline": stringSchema("UUID, nombre exacto o __no_pipeline__."),
				"stage":    stringSchema("UUID o nombre exacto de etapa."),
				"tag":      stringSchema("Nombre exacto del tag."),
				"limit":    numberSchema("Máximo de resultados por página; límite servidor 500."),
			}),
			Defaults: map[string]any{
				"mode": "list", "status": "open", "conversation_state": "no_messages",
				"interaction_state": "none", "interaction_types": []string{"note", "call"},
				"is_archived": false, "is_deleted": false, "is_blocked": false,
				"fields": []string{"id", "name", "phone", "status", "pipeline", "stage", "source", "created_at", "tags"}, "limit": 100,
			},
		},
		{
			ID: ErosQuickTaskLeadFollowupPriority, Title: "Prioridad de seguimiento", Category: "seguimiento",
			Description: "Ordena leads por señales operativas de seguimiento sin modificar datos.",
			Action:      ErosQuickTaskActionFollowupPriority, Permission: domain.PermLeads, ReadOnly: true, SupportsExport: true,
			InputSchema: objectSchema(map[string]any{
				"pipeline": stringSchema("UUID, nombre exacto o __no_pipeline__."),
				"limit":    numberSchema("Cantidad de leads a priorizar; máximo 100."),
			}),
			Defaults: map[string]any{"limit": 20},
		},
		{
			ID: ErosQuickTaskChatUnanswered, Title: "Chats sin respuesta", Category: "conversaciones",
			Description: "Lista leads cuyo último intercambio real quedó con un mensaje entrante sin respuesta posterior.",
			Action:      ErosQuickTaskActionOperationalLeadQuery, Permission: domain.PermChats, ReadOnly: true, SupportsExport: true,
			InputSchema: objectSchema(map[string]any{
				"pipeline": stringSchema("UUID, nombre exacto o __no_pipeline__."),
				"limit":    numberSchema("Máximo de resultados por página; límite servidor 500."),
			}),
			Defaults: map[string]any{
				"mode": "list", "status": "open", "conversation_state": "unanswered",
				"is_archived": false, "is_deleted": false, "is_blocked": false,
				"fields": []string{"id", "name", "phone", "pipeline", "stage", "last_message_at", "conversation_state"}, "limit": 100,
			},
		},
		{
			ID: ErosQuickTaskTaskOverdue, Title: "Tareas vencidas", Category: "tareas",
			Description: "Lista leads que tienen al menos una tarea pendiente con fecha vencida.",
			Action:      ErosQuickTaskActionOperationalLeadQuery, Permission: domain.PermTasks, ReadOnly: true, SupportsExport: true,
			InputSchema: objectSchema(map[string]any{
				"pipeline": stringSchema("UUID, nombre exacto o __no_pipeline__."),
				"limit":    numberSchema("Máximo de resultados por página; límite servidor 500."),
			}),
			Defaults: map[string]any{
				"mode": "list", "task_state": "overdue",
				"fields": []string{"id", "name", "phone", "pipeline", "stage", "task_count", "overdue_task_count", "next_task_due_at"}, "limit": 100,
			},
		},
		{
			ID: ErosQuickTaskLeadDataQuality, Title: "Calidad de datos", Category: "calidad",
			Description: "Detecta datos incompletos y candidatos a duplicado sin fusionar ni editar contactos.",
			Action:      ErosQuickTaskActionLeadDataQuality, Permission: domain.PermLeads, ReadOnly: true, SupportsExport: true,
			InputSchema: objectSchema(map[string]any{"pipeline": stringSchema("UUID, nombre exacto o __no_pipeline__."), "limit": numberSchema("Máximo de filas de detalle.")}),
			Defaults:    map[string]any{"limit": 100},
		},
		{
			ID: ErosQuickTaskPerformanceOverview, Title: "Rendimiento", Category: "análisis",
			Description: "Resume campañas, eventos, programas y encuestas en el período elegido.",
			Action:      ErosQuickTaskActionPerformanceOverview, Permission: domain.PermBroadcasts, ReadOnly: true, SupportsExport: true,
			InputSchema: objectSchema(map[string]any{
				"created_from": stringSchema("Inicio en YYYY-MM-DD o RFC3339."),
				"created_to":   stringSchema("Fin exclusivo en YYYY-MM-DD o RFC3339."),
			}),
		},
		{
			ID: ErosQuickTaskExportCurrentResult, Title: "Exportar resultado", Category: "exportación",
			Description: "Exporta el resultado actual a CSV, XLSX o PDF sin cambiar datos del CRM.",
			Action:      ErosQuickTaskActionExportCurrentResult, ReadOnly: true, SupportsExport: false,
			InputSchema: requiredObjectSchema(map[string]any{
				"format":        map[string]any{"type": "string", "enum": []string{"csv", "xlsx", "pdf"}},
				"source_run_id": stringSchema("UUID de la ejecución completada cuyo resultado se exportará."),
			}, []string{"format", "source_run_id"}),
		},
	}
	return cloneQuickTaskDefinitions(definitions)
}

func ErosQuickTaskByID(id string) (ErosQuickTaskDefinition, bool) {
	id = strings.TrimSpace(id)
	for _, definition := range ErosQuickTaskCatalog() {
		if definition.ID == id {
			return definition, true
		}
	}
	return ErosQuickTaskDefinition{}, false
}

// OperationalLeadFiltersForQuickTask resolves a catalog task into the same
// typed filter object used by MCP. Preset semantics (for example, unmanaged
// means no messages AND no note/call) cannot be weakened by client parameters.
func OperationalLeadFiltersForQuickTask(taskID string, accountID uuid.UUID, parameters map[string]any) (OperationalLeadFilters, error) {
	definition, ok := ErosQuickTaskByID(taskID)
	if !ok {
		return OperationalLeadFilters{}, fmt.Errorf("unknown quick task %q", taskID)
	}
	if definition.Action != ErosQuickTaskActionOperationalLeadQuery {
		return OperationalLeadFilters{}, fmt.Errorf("quick task %q is not an operational lead query", taskID)
	}
	if accountID == uuid.Nil {
		return OperationalLeadFilters{}, errors.New("account_id is required")
	}

	merged := make(map[string]any, len(definition.Defaults)+len(parameters))
	for key, value := range definition.Defaults {
		merged[key] = value
	}
	properties, _ := definition.InputSchema["properties"].(map[string]any)
	for key, value := range parameters {
		if _, allowed := properties[key]; !allowed {
			return OperationalLeadFilters{}, fmt.Errorf("parameter %q is not allowed for quick task %q", key, taskID)
		}
		merged[key] = value
	}

	location, err := time.LoadLocation("America/Lima")
	if err != nil {
		return OperationalLeadFilters{}, err
	}
	createdFrom, err := parseOperationalQuickTaskDate(merged["created_from"], location, false)
	if err != nil {
		return OperationalLeadFilters{}, fmt.Errorf("created_from: %w", err)
	}
	createdTo, err := parseOperationalQuickTaskDate(merged["created_to"], location, true)
	if err != nil {
		return OperationalLeadFilters{}, fmt.Errorf("created_to: %w", err)
	}
	activityFrom, err := parseOperationalQuickTaskDate(merged["activity_from"], location, false)
	if err != nil {
		return OperationalLeadFilters{}, fmt.Errorf("activity_from: %w", err)
	}
	activityTo, err := parseOperationalQuickTaskDate(merged["activity_to"], location, true)
	if err != nil {
		return OperationalLeadFilters{}, fmt.Errorf("activity_to: %w", err)
	}
	fields, err := quickTaskStringSlice(merged["fields"])
	if err != nil {
		return OperationalLeadFilters{}, fmt.Errorf("fields: %w", err)
	}
	interactionTypes, err := quickTaskStringSlice(merged["interaction_types"])
	if err != nil {
		return OperationalLeadFilters{}, fmt.Errorf("interaction_types: %w", err)
	}
	limit, err := quickTaskInt(merged["limit"])
	if err != nil {
		return OperationalLeadFilters{}, fmt.Errorf("limit: %w", err)
	}

	filters := OperationalLeadFilters{
		AccountID:         accountID,
		Mode:              OperationalLeadQueryMode(quickTaskString(merged["mode"])),
		Search:            quickTaskString(merged["search"]),
		Pipeline:          quickTaskString(merged["pipeline"]),
		Stage:             quickTaskString(merged["stage"]),
		Tag:               quickTaskString(merged["tag"]),
		Source:            quickTaskString(merged["source"]),
		Status:            quickTaskString(merged["status"]),
		Archived:          quickTaskBool(merged["is_archived"]),
		Blocked:           quickTaskBool(merged["is_blocked"]),
		Deleted:           quickTaskBool(merged["is_deleted"]),
		Contactable:       quickTaskBool(merged["contactable"]),
		CreatedFrom:       createdFrom,
		CreatedTo:         createdTo,
		ActivityFrom:      activityFrom,
		ActivityTo:        activityTo,
		ConversationState: OperationalConversationState(quickTaskString(merged["conversation_state"])),
		InteractionState:  OperationalPresenceState(quickTaskString(merged["interaction_state"])),
		InteractionTypes:  interactionTypes,
		TaskState:         OperationalTaskState(quickTaskString(merged["task_state"])),
		Fields:            fields,
		Limit:             limit,
		Cursor:            quickTaskString(merged["cursor"]),
	}
	validated, _, err := validateOperationalLeadFilters(filters)
	return validated, err
}

func parseOperationalQuickTaskDate(raw any, location *time.Location, end bool) (*time.Time, error) {
	value := quickTaskString(raw)
	if value == "" {
		return nil, nil
	}
	if parsed, err := time.ParseInLocation("2006-01-02", value, location); err == nil {
		if end {
			parsed = parsed.AddDate(0, 0, 1)
		}
		return &parsed, nil
	}
	if parsed, err := time.Parse(time.RFC3339, value); err == nil {
		return &parsed, nil
	}
	return nil, errors.New("must use YYYY-MM-DD or RFC3339")
}

func quickTaskString(raw any) string {
	value, _ := raw.(string)
	return strings.TrimSpace(value)
}

func quickTaskStringSlice(raw any) ([]string, error) {
	if raw == nil {
		return nil, nil
	}
	result := make([]string, 0)
	switch values := raw.(type) {
	case []string:
		result = append(result, values...)
	case []any:
		for _, rawValue := range values {
			value, ok := rawValue.(string)
			if !ok {
				return nil, errors.New("must contain only strings")
			}
			result = append(result, value)
		}
	default:
		return nil, errors.New("must be an array of strings")
	}
	for index := range result {
		result[index] = strings.TrimSpace(result[index])
	}
	return result, nil
}

func quickTaskBool(raw any) *bool {
	value, ok := raw.(bool)
	if !ok {
		return nil
	}
	return &value
}

func quickTaskInt(raw any) (int, error) {
	if raw == nil {
		return 0, nil
	}
	switch value := raw.(type) {
	case int:
		return value, nil
	case int32:
		return int(value), nil
	case int64:
		return int(value), nil
	case float64:
		if value != float64(int(value)) {
			return 0, errors.New("must be an integer")
		}
		return int(value), nil
	case json.Number:
		parsed, err := strconv.Atoi(value.String())
		return parsed, err
	default:
		return 0, errors.New("must be an integer")
	}
}

func operationalLeadQuickTaskSchema() map[string]any {
	properties := map[string]any{
		"mode":               map[string]any{"type": "string", "enum": []string{"list", "count"}},
		"search":             stringSchema("Nombre, teléfono o email."),
		"pipeline":           stringSchema("UUID, nombre exacto o __no_pipeline__."),
		"stage":              stringSchema("UUID o nombre exacto de etapa."),
		"tag":                stringSchema("Nombre exacto del tag."),
		"source":             stringSchema("Fuente exacta."),
		"status":             map[string]any{"type": "string", "enum": []string{"open", "won", "lost"}},
		"is_archived":        map[string]any{"type": "boolean"},
		"is_blocked":         map[string]any{"type": "boolean"},
		"is_deleted":         map[string]any{"type": "boolean"},
		"contactable":        map[string]any{"type": "boolean"},
		"created_from":       stringSchema("Inicio inclusivo en YYYY-MM-DD o RFC3339."),
		"created_to":         stringSchema("Fin exclusivo en YYYY-MM-DD o RFC3339."),
		"activity_from":      stringSchema("Última actividad desde, inclusiva, en YYYY-MM-DD o RFC3339."),
		"activity_to":        stringSchema("Última actividad hasta, exclusiva, en YYYY-MM-DD o RFC3339."),
		"conversation_state": map[string]any{"type": "string", "enum": []string{"any", "no_messages", "no_chat_row", "has_messages", "unanswered"}},
		"interaction_state":  map[string]any{"type": "string", "enum": []string{"any", "none", "present"}},
		"interaction_types":  map[string]any{"type": "array", "items": map[string]any{"type": "string", "enum": OperationalLeadAllowedInteractionTypes()}, "uniqueItems": true},
		"task_state":         map[string]any{"type": "string", "enum": []string{"any", "none", "present", "pending", "overdue"}},
		"fields":             map[string]any{"type": "array", "items": map[string]any{"type": "string", "enum": OperationalLeadAllowedFields()}, "uniqueItems": true},
		"limit":              numberSchema("Máximo de resultados por página; límite servidor 500."),
		"cursor":             stringSchema("Cursor opaco devuelto por la página anterior."),
	}
	return objectSchema(properties)
}

func objectSchema(properties map[string]any) map[string]any {
	return requiredObjectSchema(properties, nil)
}

func requiredObjectSchema(properties map[string]any, required []string) map[string]any {
	schema := map[string]any{"type": "object", "properties": properties, "additionalProperties": false}
	if len(required) > 0 {
		schema["required"] = required
	}
	return schema
}

func stringSchema(description string) map[string]any {
	return map[string]any{"type": "string", "description": description}
}

func numberSchema(description string) map[string]any {
	return map[string]any{"type": "integer", "minimum": 1, "description": description}
}

func cloneQuickTaskDefinitions(definitions []ErosQuickTaskDefinition) []ErosQuickTaskDefinition {
	payload, err := json.Marshal(definitions)
	if err != nil {
		return nil
	}
	var clone []ErosQuickTaskDefinition
	if err := json.Unmarshal(payload, &clone); err != nil {
		return nil
	}
	for index := range clone {
		clone[index].Permission = definitions[index].Permission
	}
	return clone
}
