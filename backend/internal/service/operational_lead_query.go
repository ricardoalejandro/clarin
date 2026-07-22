package service

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/repository"
)

// OperationalLeadQueryService executes bounded, read-only lead queries. It is
// intentionally independent from the language model: callers must provide
// typed filters and can never submit SQL.
type OperationalLeadQueryService struct {
	repos *repository.Repositories
}

func NewOperationalLeadQueryService(repos *repository.Repositories) *OperationalLeadQueryService {
	return &OperationalLeadQueryService{repos: repos}
}

type OperationalLeadQueryMode string

const (
	OperationalLeadQueryModeList  OperationalLeadQueryMode = "list"
	OperationalLeadQueryModeCount OperationalLeadQueryMode = "count"
)

type OperationalConversationState string

const (
	OperationalConversationAny         OperationalConversationState = "any"
	OperationalConversationNoMessages  OperationalConversationState = "no_messages"
	OperationalConversationNoChatRow   OperationalConversationState = "no_chat_row"
	OperationalConversationHasMessages OperationalConversationState = "has_messages"
	OperationalConversationUnanswered  OperationalConversationState = "unanswered"
)

type OperationalPresenceState string

const (
	OperationalPresenceAny     OperationalPresenceState = "any"
	OperationalPresenceNone    OperationalPresenceState = "none"
	OperationalPresencePresent OperationalPresenceState = "present"
)

type OperationalTaskState string

const (
	OperationalTaskAny     OperationalTaskState = "any"
	OperationalTaskNone    OperationalTaskState = "none"
	OperationalTaskPresent OperationalTaskState = "present"
	OperationalTaskPending OperationalTaskState = "pending"
	OperationalTaskOverdue OperationalTaskState = "overdue"
)

var operationalInteractionTypes = map[string]struct{}{
	"call": {}, "note": {}, "whatsapp": {}, "email": {}, "meeting": {},
}

var operationalLeadFieldExpressions = map[string]string{
	"id":                  "l.id",
	"contact_id":          "l.contact_id",
	"name":                "CASE WHEN l.contact_id IS NULL THEN COALESCE(NULLIF(TRIM(CONCAT_WS(' ',l.name,l.last_name)),''),'') ELSE COALESCE(NULLIF(c.custom_name,''),NULLIF(TRIM(CONCAT_WS(' ',c.name,c.last_name)),''),NULLIF(c.push_name,''),'') END",
	"phone":               "COALESCE(CASE WHEN l.contact_id IS NULL THEN NULLIF(l.phone,'') ELSE NULLIF(c.phone,'') END,'')",
	"email":               "COALESCE(CASE WHEN l.contact_id IS NULL THEN NULLIF(l.email,'') ELSE NULLIF(c.email,'') END,'')",
	"title":               "l.title",
	"status":              "l.status",
	"pipeline_id":         "l.pipeline_id",
	"pipeline":            "COALESCE(p.name, '')",
	"stage_id":            "l.stage_id",
	"stage":               "COALESCE(ps.name, '')",
	"source":              "COALESCE(NULLIF(l.source, ''), NULLIF(c.source, ''), '')",
	"created_at":          "l.created_at",
	"updated_at":          "l.updated_at",
	"tags":                "COALESCE(tag_stats.tags, ARRAY[]::text[])",
	"chat_count":          "COALESCE(chat_stats.chat_count, 0)",
	"message_count":       "COALESCE(chat_stats.message_count, 0)",
	"last_message_at":     "chat_stats.last_message_at",
	"conversation_state":  "CASE WHEN COALESCE(chat_stats.chat_count, 0) = 0 THEN 'no_chat_row' WHEN COALESCE(chat_stats.message_count, 0) = 0 THEN 'no_messages' WHEN chat_stats.last_inbound_at IS NOT NULL AND (chat_stats.last_outbound_at IS NULL OR chat_stats.last_inbound_at > chat_stats.last_outbound_at) THEN 'unanswered' ELSE 'has_messages' END",
	"interaction_count":   "COALESCE(interaction_stats.interaction_count, 0)",
	"last_interaction_at": "interaction_stats.last_interaction_at",
	"task_count":          "COALESCE(task_stats.task_count, 0)",
	"overdue_task_count":  "COALESCE(task_stats.overdue_task_count, 0)",
	"next_task_due_at":    "task_stats.next_task_due_at",
	"last_activity_at":    "activity_stats.last_activity_at",
	"is_archived":         "l.is_archived",
	"is_blocked":          "CASE WHEN l.contact_id IS NULL THEN COALESCE(l.is_blocked,false) ELSE COALESCE(c.do_not_contact,false) END",
	"is_deleted":          "(l.deleted_at IS NOT NULL)",
	"contactable":         "NOT (CASE WHEN l.contact_id IS NULL THEN COALESCE(l.is_blocked,false) ELSE COALESCE(c.do_not_contact,false) END)",
}

var operationalLeadDefaultFields = []string{
	"id", "name", "phone", "status", "pipeline", "stage", "source", "created_at", "tags", "conversation_state",
}

type OperationalLeadFilters struct {
	AccountID uuid.UUID                `json:"-"`
	Mode      OperationalLeadQueryMode `json:"mode"`

	Search      string `json:"search,omitempty"`
	Pipeline    string `json:"pipeline,omitempty"` // UUID, exact name, or __no_pipeline__.
	Stage       string `json:"stage,omitempty"`    // UUID or exact name.
	Tag         string `json:"tag,omitempty"`      // Exact, case-insensitive name.
	Source      string `json:"source,omitempty"`
	Status      string `json:"status,omitempty"`
	Archived    *bool  `json:"is_archived,omitempty"`
	Blocked     *bool  `json:"is_blocked,omitempty"`
	Deleted     *bool  `json:"is_deleted,omitempty"`
	Contactable *bool  `json:"contactable,omitempty"`

	CreatedFrom  *time.Time `json:"created_from,omitempty"`
	CreatedTo    *time.Time `json:"created_to,omitempty"` // Exclusive.
	ActivityFrom *time.Time `json:"activity_from,omitempty"`
	ActivityTo   *time.Time `json:"activity_to,omitempty"` // Exclusive.

	ConversationState OperationalConversationState `json:"conversation_state,omitempty"`
	InteractionState  OperationalPresenceState     `json:"interaction_state,omitempty"`
	InteractionTypes  []string                     `json:"interaction_types,omitempty"`
	TaskState         OperationalTaskState         `json:"task_state,omitempty"`

	Fields          []string    `json:"fields,omitempty"`
	Limit           int         `json:"limit,omitempty"`
	Cursor          string      `json:"cursor,omitempty"`
	IDs             []uuid.UUID `json:"ids,omitempty"`
	PreserveIDOrder bool        `json:"preserve_id_order,omitempty"`
}

type OperationalLeadQueryResult struct {
	Mode       OperationalLeadQueryMode `json:"mode"`
	Count      int                      `json:"count"`
	Items      []map[string]any         `json:"items,omitempty"`
	Returned   int                      `json:"returned"`
	HasMore    bool                     `json:"has_more"`
	NextCursor string                   `json:"next_cursor,omitempty"`
	Fields     []string                 `json:"fields,omitempty"`
}

type operationalLeadCursor struct {
	CreatedAt time.Time `json:"created_at"`
	ID        uuid.UUID `json:"id"`
}

// OperationalLeadAllowedFields returns a sorted copy suitable for API and MCP
// schemas. Callers can additionally remove sensitive fields based on user
// permissions before assigning Filters.Fields.
func OperationalLeadAllowedFields() []string {
	fields := make([]string, 0, len(operationalLeadFieldExpressions))
	for field := range operationalLeadFieldExpressions {
		fields = append(fields, field)
	}
	sort.Strings(fields)
	return fields
}

func OperationalLeadAllowedInteractionTypes() []string {
	types := make([]string, 0, len(operationalInteractionTypes))
	for interactionType := range operationalInteractionTypes {
		types = append(types, interactionType)
	}
	sort.Strings(types)
	return types
}

func (s *OperationalLeadQueryService) Query(ctx context.Context, filters OperationalLeadFilters) (*OperationalLeadQueryResult, error) {
	if s == nil || s.repos == nil || s.repos.DB() == nil {
		return nil, errors.New("operational lead query service is not initialized")
	}
	validated, cursor, err := validateOperationalLeadFilters(filters)
	if err != nil {
		return nil, err
	}

	if validated.Mode == OperationalLeadQueryModeCount {
		query, args := buildOperationalLeadCountSQL(validated)
		var count int
		if err := s.repos.DB().QueryRow(ctx, query, args...).Scan(&count); err != nil {
			return nil, fmt.Errorf("count operational leads: %w", err)
		}
		return &OperationalLeadQueryResult{Mode: validated.Mode, Count: count}, nil
	}

	query, args := buildOperationalLeadListSQL(validated, cursor)
	rows, err := s.repos.DB().Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("query operational leads: %w", err)
	}
	defer rows.Close()

	items := make([]map[string]any, 0, validated.Limit)
	var lastCursor operationalLeadCursor
	scannedRows := 0
	for rows.Next() {
		scannedRows++
		item := make(map[string]any, len(validated.Fields))
		var rowCursor operationalLeadCursor
		descriptions := rows.FieldDescriptions()
		values := make([]any, len(descriptions))
		scanTargets := make([]any, len(descriptions))
		for index, description := range rows.FieldDescriptions() {
			name := string(description.Name)
			switch name {
			case "__cursor_created_at":
				scanTargets[index] = &rowCursor.CreatedAt
			case "__cursor_id":
				scanTargets[index] = &rowCursor.ID
			default:
				scanTargets[index] = &values[index]
			}
		}
		if err := rows.Scan(scanTargets...); err != nil {
			return nil, fmt.Errorf("read operational lead row: %w", err)
		}
		for index, description := range descriptions {
			name := string(description.Name)
			if name != "__cursor_created_at" && name != "__cursor_id" {
				item[name] = values[index]
			}
		}
		if len(items) < validated.Limit {
			items = append(items, item)
			lastCursor = rowCursor
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate operational leads: %w", err)
	}

	hasMore := scannedRows > validated.Limit && lastCursor.ID != uuid.Nil
	result := &OperationalLeadQueryResult{
		Mode:     validated.Mode,
		Items:    items,
		Returned: len(items),
		HasMore:  hasMore,
		Fields:   append([]string(nil), validated.Fields...),
	}
	if hasMore {
		result.NextCursor, err = encodeOperationalLeadCursor(lastCursor)
		if err != nil {
			return nil, err
		}
	}
	return result, nil
}

func validateOperationalLeadFilters(filters OperationalLeadFilters) (OperationalLeadFilters, *operationalLeadCursor, error) {
	if filters.AccountID == uuid.Nil {
		return filters, nil, errors.New("account_id is required")
	}
	if filters.Mode == "" {
		filters.Mode = OperationalLeadQueryModeList
	}
	if filters.Mode != OperationalLeadQueryModeList && filters.Mode != OperationalLeadQueryModeCount {
		return filters, nil, fmt.Errorf("invalid mode %q", filters.Mode)
	}
	if filters.ConversationState == "" {
		filters.ConversationState = OperationalConversationAny
	}
	switch filters.ConversationState {
	case OperationalConversationAny, OperationalConversationNoMessages, OperationalConversationNoChatRow, OperationalConversationHasMessages, OperationalConversationUnanswered:
	default:
		return filters, nil, fmt.Errorf("invalid conversation_state %q", filters.ConversationState)
	}
	if filters.InteractionState == "" {
		filters.InteractionState = OperationalPresenceAny
	}
	switch filters.InteractionState {
	case OperationalPresenceAny, OperationalPresenceNone, OperationalPresencePresent:
	default:
		return filters, nil, fmt.Errorf("invalid interaction_state %q", filters.InteractionState)
	}
	seenTypes := make(map[string]struct{}, len(filters.InteractionTypes))
	interactionTypes := make([]string, 0, len(filters.InteractionTypes))
	for _, raw := range filters.InteractionTypes {
		interactionType := strings.ToLower(strings.TrimSpace(raw))
		if _, ok := operationalInteractionTypes[interactionType]; !ok {
			return filters, nil, fmt.Errorf("invalid interaction type %q", raw)
		}
		if _, duplicate := seenTypes[interactionType]; !duplicate {
			seenTypes[interactionType] = struct{}{}
			interactionTypes = append(interactionTypes, interactionType)
		}
	}
	filters.InteractionTypes = interactionTypes
	if filters.TaskState == "" {
		filters.TaskState = OperationalTaskAny
	}
	switch filters.TaskState {
	case OperationalTaskAny, OperationalTaskNone, OperationalTaskPresent, OperationalTaskPending, OperationalTaskOverdue:
	default:
		return filters, nil, fmt.Errorf("invalid task_state %q", filters.TaskState)
	}
	if filters.CreatedFrom != nil && filters.CreatedTo != nil && !filters.CreatedFrom.Before(*filters.CreatedTo) {
		return filters, nil, errors.New("created_from must be before created_to")
	}
	if filters.ActivityFrom != nil && filters.ActivityTo != nil && !filters.ActivityFrom.Before(*filters.ActivityTo) {
		return filters, nil, errors.New("activity_from must be before activity_to")
	}
	if status := strings.ToLower(strings.TrimSpace(filters.Status)); status != "" {
		switch status {
		case "open", "won", "lost":
			filters.Status = status
		default:
			return filters, nil, fmt.Errorf("invalid status %q", filters.Status)
		}
	}

	if filters.Mode == OperationalLeadQueryModeCount {
		filters.Fields = nil
		filters.Limit = 0
		filters.Cursor = ""
		return filters, nil, nil
	}
	if len(filters.IDs) > 500 {
		return filters, nil, errors.New("ids admite un máximo de 500 registros")
	}
	if filters.Limit <= 0 {
		filters.Limit = 100
	}
	if filters.Limit > 500 {
		filters.Limit = 500
	}
	if len(filters.Fields) == 0 {
		filters.Fields = append([]string(nil), operationalLeadDefaultFields...)
	}
	seenFields := make(map[string]struct{}, len(filters.Fields))
	fields := make([]string, 0, len(filters.Fields))
	for _, raw := range filters.Fields {
		field := strings.ToLower(strings.TrimSpace(raw))
		if _, ok := operationalLeadFieldExpressions[field]; !ok {
			return filters, nil, fmt.Errorf("invalid field %q", raw)
		}
		if _, duplicate := seenFields[field]; !duplicate {
			seenFields[field] = struct{}{}
			fields = append(fields, field)
		}
	}
	filters.Fields = fields

	if strings.TrimSpace(filters.Cursor) == "" {
		return filters, nil, nil
	}
	cursor, err := decodeOperationalLeadCursor(filters.Cursor)
	if err != nil {
		return filters, nil, errors.New("invalid cursor")
	}
	return filters, &cursor, nil
}

type operationalSQLBuilder struct {
	where []string
	args  []any
}

func (b *operationalSQLBuilder) addArg(value any) string {
	b.args = append(b.args, value)
	return fmt.Sprintf("$%d", len(b.args))
}

func buildOperationalLeadBaseSQL(filters OperationalLeadFilters, cursor *operationalLeadCursor) (string, []any, map[string]bool) {
	b := &operationalSQLBuilder{}
	b.where = append(b.where, "l.account_id = "+b.addArg(filters.AccountID))
	required := requiredOperationalJoins(filters)
	if len(filters.IDs) > 0 {
		b.where = append(b.where, "l.id = ANY("+b.addArg(filters.IDs)+")")
	}

	if value := strings.TrimSpace(filters.Search); value != "" {
		arg := b.addArg("%" + value + "%")
		b.where = append(b.where, "(CASE WHEN l.contact_id IS NULL THEN COALESCE(l.name,'') ELSE COALESCE(c.custom_name,c.name,c.push_name,c.phone,c.jid,'') END ILIKE "+arg+" OR CASE WHEN l.contact_id IS NULL THEN COALESCE(l.last_name,'') ELSE COALESCE(c.last_name,'') END ILIKE "+arg+" OR CASE WHEN l.contact_id IS NULL THEN COALESCE(l.phone,'') ELSE COALESCE(c.phone,'') END ILIKE "+arg+" OR CASE WHEN l.contact_id IS NULL THEN COALESCE(l.email,'') ELSE COALESCE(c.email,'') END ILIKE "+arg+")")
	}
	if value := strings.TrimSpace(filters.Pipeline); value != "" {
		if value == "__no_pipeline__" {
			b.where = append(b.where, "l.pipeline_id IS NULL")
		} else if id, err := uuid.Parse(value); err == nil {
			b.where = append(b.where, "l.pipeline_id = "+b.addArg(id))
		} else {
			b.where = append(b.where, "LOWER(COALESCE(p.name, '')) = LOWER("+b.addArg(value)+")")
		}
	}
	if value := strings.TrimSpace(filters.Stage); value != "" {
		if id, err := uuid.Parse(value); err == nil {
			b.where = append(b.where, "l.stage_id = "+b.addArg(id))
		} else {
			b.where = append(b.where, "LOWER(COALESCE(ps.name, '')) = LOWER("+b.addArg(value)+")")
		}
	}
	if value := strings.TrimSpace(filters.Tag); value != "" {
		arg := b.addArg(value)
		b.where = append(b.where, "EXISTS (SELECT 1 FROM contact_tags filter_ct JOIN tags filter_t ON filter_t.id = filter_ct.tag_id AND filter_t.account_id = l.account_id WHERE filter_ct.contact_id = l.contact_id AND LOWER(filter_t.name) = LOWER("+arg+"))")
	}
	if value := strings.TrimSpace(filters.Source); value != "" {
		b.where = append(b.where, "LOWER(COALESCE(NULLIF(l.source, ''), NULLIF(c.source, ''), '')) = LOWER("+b.addArg(value)+")")
	}
	if value := strings.TrimSpace(filters.Status); value != "" {
		b.where = append(b.where, "LOWER(l.status) = LOWER("+b.addArg(value)+")")
	}
	if filters.Archived != nil {
		b.where = append(b.where, "l.is_archived = "+b.addArg(*filters.Archived))
	}
	if filters.Blocked != nil {
		b.where = append(b.where, "CASE WHEN l.contact_id IS NULL THEN COALESCE(l.is_blocked,false) ELSE COALESCE(c.do_not_contact,false) END = "+b.addArg(*filters.Blocked))
	}
	if filters.Deleted != nil {
		if *filters.Deleted {
			b.where = append(b.where, "l.deleted_at IS NOT NULL")
		} else {
			b.where = append(b.where, "l.deleted_at IS NULL")
		}
	}
	if filters.Contactable != nil {
		b.where = append(b.where, "CASE WHEN l.contact_id IS NULL THEN COALESCE(l.is_blocked,false) ELSE COALESCE(c.do_not_contact,false) END = "+b.addArg(!*filters.Contactable))
	}
	if filters.CreatedFrom != nil {
		b.where = append(b.where, "l.created_at >= "+b.addArg(*filters.CreatedFrom))
	}
	if filters.CreatedTo != nil {
		b.where = append(b.where, "l.created_at < "+b.addArg(*filters.CreatedTo))
	}

	messageExists := "EXISTS (SELECT 1 FROM chats filter_ch JOIN messages filter_m ON filter_m.chat_id = filter_ch.id AND filter_m.account_id = l.account_id AND NOT COALESCE(filter_m.is_revoked, false) WHERE filter_ch.account_id = l.account_id AND filter_ch.contact_id = l.contact_id)"
	switch filters.ConversationState {
	case OperationalConversationNoMessages:
		b.where = append(b.where, "NOT "+messageExists)
	case OperationalConversationNoChatRow:
		b.where = append(b.where, "NOT EXISTS (SELECT 1 FROM chats filter_ch WHERE filter_ch.account_id = l.account_id AND filter_ch.contact_id = l.contact_id)")
	case OperationalConversationHasMessages:
		b.where = append(b.where, messageExists)
	case OperationalConversationUnanswered:
		b.where = append(b.where, "EXISTS (SELECT 1 FROM chats filter_ch JOIN messages filter_in ON filter_in.chat_id = filter_ch.id AND filter_in.account_id = l.account_id AND NOT COALESCE(filter_in.is_revoked, false) AND NOT filter_in.is_from_me WHERE filter_ch.account_id = l.account_id AND filter_ch.contact_id = l.contact_id AND NOT EXISTS (SELECT 1 FROM chats filter_out_ch JOIN messages filter_out ON filter_out.chat_id = filter_out_ch.id AND filter_out.account_id = l.account_id AND filter_out.is_from_me AND NOT COALESCE(filter_out.is_revoked, false) WHERE filter_out_ch.account_id = l.account_id AND filter_out_ch.contact_id = l.contact_id AND filter_out.timestamp > filter_in.timestamp))")
	}

	if filters.InteractionState != OperationalPresenceAny {
		interactionPredicate := "filter_i.account_id = l.account_id AND (filter_i.lead_id = l.id OR filter_i.contact_id = l.contact_id)"
		if len(filters.InteractionTypes) > 0 {
			interactionPredicate += " AND filter_i.type = ANY(" + b.addArg(filters.InteractionTypes) + ")"
		}
		interactionExists := "EXISTS (SELECT 1 FROM interactions filter_i WHERE " + interactionPredicate + ")"
		if filters.InteractionState == OperationalPresenceNone {
			b.where = append(b.where, "NOT "+interactionExists)
		} else {
			b.where = append(b.where, interactionExists)
		}
	}

	taskPredicate := "filter_task.account_id = l.account_id AND (filter_task.lead_id = l.id OR (filter_task.lead_id IS NULL AND filter_task.contact_id = l.contact_id))"
	switch filters.TaskState {
	case OperationalTaskNone:
		b.where = append(b.where, "NOT EXISTS (SELECT 1 FROM tasks filter_task WHERE "+taskPredicate+")")
	case OperationalTaskPresent:
		b.where = append(b.where, "EXISTS (SELECT 1 FROM tasks filter_task WHERE "+taskPredicate+")")
	case OperationalTaskPending:
		b.where = append(b.where, "EXISTS (SELECT 1 FROM tasks filter_task WHERE "+taskPredicate+" AND filter_task.status = 'pending')")
	case OperationalTaskOverdue:
		b.where = append(b.where, "EXISTS (SELECT 1 FROM tasks filter_task WHERE "+taskPredicate+" AND filter_task.status = 'pending' AND filter_task.due_at < NOW())")
	}

	if filters.ActivityFrom != nil {
		b.where = append(b.where, "activity_stats.last_activity_at >= "+b.addArg(*filters.ActivityFrom))
	}
	if filters.ActivityTo != nil {
		b.where = append(b.where, "activity_stats.last_activity_at < "+b.addArg(*filters.ActivityTo))
	}
	if cursor != nil {
		createdArg := b.addArg(cursor.CreatedAt)
		idArg := b.addArg(cursor.ID)
		b.where = append(b.where, "(l.created_at < "+createdArg+" OR (l.created_at = "+createdArg+" AND l.id < "+idArg+"))")
	}

	from := `
		FROM leads l
		LEFT JOIN contacts c ON c.id=l.contact_id AND c.account_id=l.account_id
		LEFT JOIN pipelines p ON p.id = l.pipeline_id AND p.account_id = l.account_id
		LEFT JOIN pipeline_stages ps ON ps.id = l.stage_id AND ps.pipeline_id = l.pipeline_id
	`
	from += operationalLateralJoins(required)
	return from + " WHERE " + strings.Join(b.where, " AND "), b.args, required
}

func buildOperationalLeadCountSQL(filters OperationalLeadFilters) (string, []any) {
	base, args, _ := buildOperationalLeadBaseSQL(filters, nil)
	return "SELECT COUNT(*) " + base, args
}

func buildOperationalLeadListSQL(filters OperationalLeadFilters, cursor *operationalLeadCursor) (string, []any) {
	base, args, _ := buildOperationalLeadBaseSQL(filters, cursor)
	selects := make([]string, 0, len(filters.Fields)+2)
	for _, field := range filters.Fields {
		selects = append(selects, operationalLeadFieldExpressions[field]+` AS "`+field+`"`)
	}
	selects = append(selects, `l.created_at AS "__cursor_created_at"`, `l.id AS "__cursor_id"`)
	order := "l.created_at DESC, l.id DESC"
	if filters.PreserveIDOrder && len(filters.IDs) > 0 {
		args = append(args, filters.IDs)
		order = fmt.Sprintf("array_position($%d::uuid[], l.id)", len(args))
	}
	args = append(args, filters.Limit+1)
	return "SELECT " + strings.Join(selects, ", ") + " " + base + fmt.Sprintf(" ORDER BY %s LIMIT $%d", order, len(args)), args
}

func requiredOperationalJoins(filters OperationalLeadFilters) map[string]bool {
	required := map[string]bool{}
	for _, field := range filters.Fields {
		switch field {
		case "tags":
			required["tags"] = true
		case "chat_count", "message_count", "last_message_at", "conversation_state":
			required["chats"] = true
		case "interaction_count", "last_interaction_at":
			required["interactions"] = true
		case "task_count", "overdue_task_count", "next_task_due_at":
			required["tasks"] = true
		case "last_activity_at":
			required["activity"] = true
		}
	}
	if filters.ActivityFrom != nil || filters.ActivityTo != nil {
		required["activity"] = true
	}
	return required
}

func operationalLateralJoins(required map[string]bool) string {
	var joins strings.Builder
	if required["tags"] {
		joins.WriteString(` LEFT JOIN LATERAL (
			SELECT array_agg(DISTINCT tag.name ORDER BY tag.name) AS tags
			FROM contact_tags ct JOIN tags tag ON tag.id = ct.tag_id AND tag.account_id = l.account_id
			WHERE ct.contact_id = l.contact_id
		) tag_stats ON true `)
	}
	if required["chats"] {
		joins.WriteString(` LEFT JOIN LATERAL (
			SELECT COUNT(DISTINCT ch.id)::int AS chat_count,
				COUNT(m.id)::int AS message_count,
				MAX(m.timestamp) AS last_message_at,
				MAX(m.timestamp) FILTER (WHERE NOT m.is_from_me) AS last_inbound_at,
				MAX(m.timestamp) FILTER (WHERE m.is_from_me) AS last_outbound_at
			FROM chats ch
			LEFT JOIN messages m ON m.chat_id = ch.id AND m.account_id = l.account_id AND NOT COALESCE(m.is_revoked, false)
			WHERE ch.account_id = l.account_id AND ch.contact_id = l.contact_id
		) chat_stats ON true `)
	}
	if required["interactions"] {
		joins.WriteString(` LEFT JOIN LATERAL (
			SELECT COUNT(*)::int AS interaction_count, MAX(i.created_at) AS last_interaction_at
			FROM interactions i
			WHERE i.account_id = l.account_id AND (i.lead_id = l.id OR i.contact_id = l.contact_id)
		) interaction_stats ON true `)
	}
	if required["tasks"] {
		joins.WriteString(` LEFT JOIN LATERAL (
			SELECT COUNT(*)::int AS task_count,
				COUNT(*) FILTER (WHERE task.status = 'pending' AND task.due_at < NOW())::int AS overdue_task_count,
				MIN(task.due_at) FILTER (WHERE task.status = 'pending') AS next_task_due_at
			FROM tasks task
			WHERE task.account_id = l.account_id AND (task.lead_id = l.id OR (task.lead_id IS NULL AND task.contact_id = l.contact_id))
		) task_stats ON true `)
	}
	if required["activity"] {
		joins.WriteString(` LEFT JOIN LATERAL (
			SELECT MAX(activity_at) AS last_activity_at FROM (
				SELECT l.updated_at AS activity_at
				UNION ALL SELECT MAX(activity_message.timestamp) FROM chats activity_chat JOIN messages activity_message ON activity_message.chat_id = activity_chat.id AND activity_message.account_id = l.account_id AND NOT COALESCE(activity_message.is_revoked, false) WHERE activity_chat.account_id = l.account_id AND activity_chat.contact_id = l.contact_id
				UNION ALL SELECT MAX(activity_interaction.created_at) FROM interactions activity_interaction WHERE activity_interaction.account_id = l.account_id AND (activity_interaction.lead_id = l.id OR activity_interaction.contact_id = l.contact_id)
				UNION ALL SELECT MAX(activity_task.updated_at) FROM tasks activity_task WHERE activity_task.account_id = l.account_id AND (activity_task.lead_id = l.id OR (activity_task.lead_id IS NULL AND activity_task.contact_id = l.contact_id))
			) activity_values
		) activity_stats ON true `)
	}
	return joins.String()
}

func encodeOperationalLeadCursor(cursor operationalLeadCursor) (string, error) {
	payload, err := json.Marshal(cursor)
	if err != nil {
		return "", fmt.Errorf("encode operational lead cursor: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(payload), nil
}

func decodeOperationalLeadCursor(raw string) (operationalLeadCursor, error) {
	var cursor operationalLeadCursor
	payload, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(raw))
	if err != nil {
		return cursor, err
	}
	if err := json.Unmarshal(payload, &cursor); err != nil {
		return cursor, err
	}
	if cursor.CreatedAt.IsZero() || cursor.ID == uuid.Nil {
		return cursor, errors.New("incomplete cursor")
	}
	return cursor, nil
}
