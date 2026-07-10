package mcp

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/mark3labs/mcp-go/mcp"
)

const (
	mcpSimpleLeadDefaultTimezone = "America/Lima"
)

var (
	mcpSimpleLeadAllowedFields = map[string]string{
		"id":               "id",
		"name":             "name",
		"phone":            "raw_phone",
		"normalized_phone": "normalized_phone",
		"email":            "email",
		"stage":            "stage",
		"source":           "source",
		"created_at":       "created_at",
		"tags":             "tags",
		"status":           "status",
	}
	mcpSimpleLeadDefaultListFields = []string{"id", "name", "phone", "normalized_phone", "stage", "source", "created_at", "tags", "status"}
)

type mcpSimpleLeadFilters struct {
	AccountID          uuid.UUID
	Query              string
	Tag                string
	Stage              string
	Source             string
	Status             string
	ActiveOnly         bool
	Timezone           string
	CreatedFromRaw     string
	CreatedToRaw       string
	CreatedFrom        *time.Time
	CreatedTo          *time.Time
	CreatedToInclusive bool
}

type mcpSimpleLeadRow struct {
	ID              uuid.UUID
	Name            string
	RawPhone        string
	NormalizedPhone string
	PhoneCountry    string
	PhoneValid      bool
	Email           string
	Stage           string
	Source          string
	Status          string
	CreatedAt       time.Time
	Tags            []string
}

func (s *MCPServer) toolCountLeads(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	accountID, err := s.getAccountIDFromRequest(ctx, req)
	if err != nil {
		return mcpAccountStructuredError(err), nil
	}

	filters, err := parseMCPSimpleLeadFilters(req, accountID)
	if err != nil {
		return mcpStructuredError("INVALID_DATE_RANGE", err.Error(), nil), nil
	}

	total, err := s.countSimpleLeads(ctx, filters)
	if err != nil {
		return mcpStructuredError("QUERY_FAILED", "no se pudo contar leads", map[string]any{"detail": err.Error()}), nil
	}

	queryHash := mcpSimpleLeadQueryHash("count_leads", filters, nil, nil)
	nextTool := "list_leads"
	nextReason := "Usa list_leads para revisar una página ligera con los campos que necesites."
	if total > 0 {
		nextReason = "Usa list_leads con fields y cursor. Si el usuario pidió archivo, después usa prepare_file_export/render_file_export con content para que Clarin adjunte la descarga en el chat sin pegar el fichero en la respuesta."
	}

	return jsonResult(map[string]any{
		"total_found":           total,
		"filters_applied":       filters.appliedMap(),
		"query_hash":            queryHash,
		"recommended_next_tool": nextTool,
		"recommendation":        nextReason,
	}), nil
}

func (s *MCPServer) toolListLeads(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	accountID, err := s.getAccountIDFromRequest(ctx, req)
	if err != nil {
		return mcpAccountStructuredError(err), nil
	}

	filters, err := parseMCPSimpleLeadFilters(req, accountID)
	if err != nil {
		return mcpStructuredError("INVALID_DATE_RANGE", err.Error(), nil), nil
	}
	fields, err := mcpSimpleLeadFieldsArg(req, mcpSimpleLeadDefaultListFields)
	if err != nil {
		return mcpStructuredError("INVALID_FIELD", err.Error(), map[string]any{"allowed_fields": mcpSimpleLeadAllowedFieldNames()}), nil
	}
	limit := intArg(req, "limit", 500, 1000)
	offset, err := decodeAnalysisCursor(stringArg(req, "cursor"))
	if err != nil {
		return mcpStructuredError("INVALID_CURSOR", "cursor inválido; usa el next_cursor devuelto por la página anterior", nil), nil
	}

	total, err := s.countSimpleLeads(ctx, filters)
	if err != nil {
		return mcpStructuredError("QUERY_FAILED", "no se pudo contar leads", map[string]any{"detail": err.Error()}), nil
	}

	rows, err := s.querySimpleLeads(ctx, filters, limit, offset)
	if err != nil {
		return mcpStructuredError("QUERY_FAILED", "no se pudo listar leads", map[string]any{"detail": err.Error()}), nil
	}

	items := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		items = append(items, row.mapForFields(fields))
	}
	returned := len(items)
	hasMore := offset+returned < total
	nextCursor := ""
	if hasMore && returned > 0 {
		nextCursor = encodeAnalysisCursor(offset + returned)
	}

	queryHash := mcpSimpleLeadQueryHash("list_leads", filters, fields, map[string]any{"limit": limit, "offset": offset})
	return jsonResult(map[string]any{
		"items":                        items,
		"leads":                        items,
		"returned":                     returned,
		"total":                        total,
		"has_more":                     hasMore,
		"next_cursor":                  nextCursor,
		"fields":                       fields,
		"filters_applied":              filters.appliedMap(),
		"query_hash":                   queryHash,
		"delivery":                     "json_paginated_for_chat_attachment",
		"client_format_responsibility": "Si el usuario pide CSV, Excel, Word, PowerPoint, PDF o descarga, usa prepare_file_export/render_file_export con content para que Clarin adjunte el archivo en el chat sin pegar el fichero en la respuesta.",
		"pagination_note":              "Si has_more=true, llama otra vez con next_cursor. No repitas el cursor anterior.",
	}), nil
}

func parseMCPSimpleLeadFilters(req mcp.CallToolRequest, accountID uuid.UUID) (mcpSimpleLeadFilters, error) {
	timezone := strings.TrimSpace(stringArg(req, "timezone"))
	if timezone == "" {
		timezone = mcpSimpleLeadDefaultTimezone
	}
	loc, err := time.LoadLocation(timezone)
	if err != nil {
		return mcpSimpleLeadFilters{}, fmt.Errorf("timezone inválido: %s", timezone)
	}

	createdFromRaw := strings.TrimSpace(stringArg(req, "created_from"))
	if createdFromRaw == "" {
		createdFromRaw = strings.TrimSpace(stringArg(req, "created_after"))
	}
	createdToRaw := strings.TrimSpace(stringArg(req, "created_to"))
	if createdToRaw == "" {
		createdToRaw = strings.TrimSpace(stringArg(req, "created_before"))
	}

	filters := mcpSimpleLeadFilters{
		AccountID:      accountID,
		Query:          strings.TrimSpace(stringArg(req, "query")),
		Tag:            strings.TrimSpace(stringArg(req, "tag")),
		Stage:          strings.TrimSpace(stringArg(req, "stage")),
		Source:         strings.TrimSpace(stringArg(req, "source")),
		Status:         strings.TrimSpace(stringArg(req, "status")),
		ActiveOnly:     boolArg(req, "active_only", false),
		Timezone:       timezone,
		CreatedFromRaw: createdFromRaw,
		CreatedToRaw:   createdToRaw,
	}

	if createdFromRaw != "" {
		from, _, err := mcpParseLeadDateBound(createdFromRaw, loc, false)
		if err != nil {
			return mcpSimpleLeadFilters{}, fmt.Errorf("created_from debe tener formato YYYY-MM-DD o RFC3339")
		}
		filters.CreatedFrom = &from
	}
	if createdToRaw != "" {
		to, dateOnly, err := mcpParseLeadDateBound(createdToRaw, loc, true)
		if err != nil {
			return mcpSimpleLeadFilters{}, fmt.Errorf("created_to debe tener formato YYYY-MM-DD o RFC3339")
		}
		filters.CreatedTo = &to
		filters.CreatedToInclusive = !dateOnly
	}
	if filters.CreatedFrom != nil && filters.CreatedTo != nil {
		if filters.CreatedToInclusive {
			if filters.CreatedFrom.After(*filters.CreatedTo) {
				return mcpSimpleLeadFilters{}, errors.New("created_from no puede ser posterior a created_to")
			}
		} else if !filters.CreatedFrom.Before(*filters.CreatedTo) {
			return mcpSimpleLeadFilters{}, errors.New("created_from debe ser anterior o igual al día de created_to")
		}
	}

	return filters, nil
}

func mcpParseLeadDateBound(raw string, loc *time.Location, endOfDay bool) (time.Time, bool, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return time.Time{}, false, errors.New("fecha vacía")
	}
	if t, err := time.ParseInLocation("2006-01-02", raw, loc); err == nil {
		if endOfDay {
			t = t.AddDate(0, 0, 1)
		}
		return t, true, nil
	}
	if t, err := time.Parse(time.RFC3339, raw); err == nil {
		return t, false, nil
	}
	for _, layout := range []string{"2006-01-02 15:04:05", "2006-01-02 15:04", "2006-01-02T15:04:05", "2006-01-02T15:04"} {
		if t, err := time.ParseInLocation(layout, raw, loc); err == nil {
			return t, false, nil
		}
	}
	return time.Time{}, false, errors.New("fecha inválida")
}

func (f mcpSimpleLeadFilters) sqlWhere() (string, []any) {
	where := ` WHERE l.account_id = $1`
	args := []any{f.AccountID}
	argN := 2

	if f.Query != "" {
		where += fmt.Sprintf(` AND (
			COALESCE(l.name, '') ILIKE $%d OR COALESCE(l.last_name, '') ILIKE $%d OR
			COALESCE(c.name, '') ILIKE $%d OR COALESCE(c.custom_name, '') ILIKE $%d OR
			COALESCE(c.push_name, '') ILIKE $%d OR COALESCE(l.phone, c.phone, '') ILIKE $%d OR
			COALESCE(l.email, c.email, '') ILIKE $%d
		)`, argN, argN, argN, argN, argN, argN, argN)
		args = append(args, "%"+f.Query+"%")
		argN++
	}
	if f.Tag != "" {
		where += fmt.Sprintf(` AND EXISTS (
			SELECT 1
			FROM contact_tags ct_filter
			JOIN tags t_filter ON t_filter.id = ct_filter.tag_id
			WHERE ct_filter.contact_id = l.contact_id
			  AND t_filter.account_id = l.account_id
			  AND t_filter.name ILIKE $%d
		)`, argN)
		args = append(args, "%"+f.Tag+"%")
		argN++
	}
	if f.Stage != "" {
		where += fmt.Sprintf(` AND COALESCE(ps.name, '') ILIKE $%d`, argN)
		args = append(args, "%"+f.Stage+"%")
		argN++
	}
	if f.Source != "" {
		where += fmt.Sprintf(` AND COALESCE(NULLIF(l.source, ''), NULLIF(c.source, ''), '') ILIKE $%d`, argN)
		args = append(args, "%"+f.Source+"%")
		argN++
	}
	if f.Status != "" {
		where += fmt.Sprintf(` AND COALESCE(l.status, '') ILIKE $%d`, argN)
		args = append(args, "%"+f.Status+"%")
		argN++
	}
	if f.CreatedFrom != nil {
		where += fmt.Sprintf(` AND l.created_at >= $%d`, argN)
		args = append(args, *f.CreatedFrom)
		argN++
	}
	if f.CreatedTo != nil {
		if f.CreatedToInclusive {
			where += fmt.Sprintf(` AND l.created_at <= $%d`, argN)
		} else {
			where += fmt.Sprintf(` AND l.created_at < $%d`, argN)
		}
		args = append(args, *f.CreatedTo)
		argN++
	}
	if f.ActiveOnly {
		where += ` AND l.is_archived = false AND l.is_blocked = false`
	}

	return where, args
}

func (f mcpSimpleLeadFilters) appliedMap() map[string]any {
	out := map[string]any{
		"account_id":    f.AccountID.String(),
		"timezone":      f.Timezone,
		"active_only":   f.ActiveOnly,
		"date_semantic": "created_to as YYYY-MM-DD includes the full local day; RFC3339 created_to is inclusive.",
	}
	if f.Query != "" {
		out["query"] = f.Query
	}
	if f.Tag != "" {
		out["tag"] = f.Tag
	}
	if f.Stage != "" {
		out["stage"] = f.Stage
	}
	if f.Source != "" {
		out["source"] = f.Source
	}
	if f.Status != "" {
		out["status"] = f.Status
	}
	if f.CreatedFrom != nil {
		out["created_from"] = f.CreatedFrom.Format(time.RFC3339)
		out["created_from_input"] = f.CreatedFromRaw
	}
	if f.CreatedTo != nil {
		out["created_to"] = f.CreatedTo.Format(time.RFC3339)
		out["created_to_input"] = f.CreatedToRaw
		out["created_to_operator"] = "<"
		if f.CreatedToInclusive {
			out["created_to_operator"] = "<="
		}
	}
	return out
}

func (s *MCPServer) countSimpleLeads(ctx context.Context, filters mcpSimpleLeadFilters) (int, error) {
	where, args := filters.sqlWhere()
	var total int
	err := s.repos.DB().QueryRow(ctx, `SELECT COUNT(*)`+mcpSimpleLeadBaseFrom()+where, args...).Scan(&total)
	return total, err
}

func (s *MCPServer) querySimpleLeads(ctx context.Context, filters mcpSimpleLeadFilters, limit, offset int) ([]mcpSimpleLeadRow, error) {
	if limit <= 0 {
		return []mcpSimpleLeadRow{}, nil
	}
	where, args := filters.sqlWhere()
	limitArg := len(args) + 1
	offsetArg := len(args) + 2
	args = append(args, limit, offset)

	rows, err := s.repos.DB().Query(ctx, `
		SELECT
			l.id,
			COALESCE(
				NULLIF(c.custom_name, ''),
				NULLIF(TRIM(CONCAT_WS(' ', NULLIF(c.name, ''), NULLIF(c.last_name, ''))), ''),
				NULLIF(TRIM(CONCAT_WS(' ', NULLIF(l.name, ''), NULLIF(l.last_name, ''))), ''),
				''
			) AS lead_name,
			COALESCE(NULLIF(c.phone, ''), NULLIF(l.phone, ''), '') AS raw_phone,
			COALESCE(NULLIF(c.email, ''), NULLIF(l.email, ''), '') AS email,
			COALESCE(ps.name, '') AS stage,
			COALESCE(NULLIF(l.source, ''), NULLIF(c.source, ''), '') AS source,
			COALESCE(l.status, '') AS status,
			l.created_at,
			COALESCE(lead_tags.tags, ARRAY[]::text[]) AS tags
		`+mcpSimpleLeadBaseFrom()+`
		LEFT JOIN LATERAL (
			SELECT array_agg(DISTINCT t.name ORDER BY t.name) AS tags
			FROM contact_tags ct
			JOIN tags t ON t.id = ct.tag_id AND t.account_id = l.account_id
			WHERE ct.contact_id = l.contact_id
		) lead_tags ON true
		`+where+fmt.Sprintf(`
		ORDER BY l.created_at DESC, l.id DESC
		LIMIT $%d OFFSET $%d
	`, limitArg, offsetArg), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make([]mcpSimpleLeadRow, 0, limit)
	for rows.Next() {
		var row mcpSimpleLeadRow
		if err := rows.Scan(&row.ID, &row.Name, &row.RawPhone, &row.Email, &row.Stage, &row.Source, &row.Status, &row.CreatedAt, &row.Tags); err != nil {
			return nil, err
		}
		row.NormalizedPhone, row.PhoneCountry, row.PhoneValid = normalizeLeadPhonePE(row.RawPhone)
		if row.Tags == nil {
			row.Tags = []string{}
		}
		result = append(result, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

func mcpSimpleLeadBaseFrom() string {
	return `
		FROM leads l
		LEFT JOIN contacts c ON c.id = l.contact_id AND c.account_id = l.account_id
		LEFT JOIN pipeline_stages ps ON ps.id = l.stage_id
	`
}

func mcpSimpleLeadFieldsArg(req mcp.CallToolRequest, defaults []string) ([]string, error) {
	raw, ok := getArgs(req)["fields"]
	if !ok || raw == nil {
		return append([]string{}, defaults...), nil
	}

	values := make([]string, 0)
	switch v := raw.(type) {
	case []any:
		for _, item := range v {
			values = append(values, fmt.Sprint(item))
		}
	case []string:
		values = append(values, v...)
	case string:
		for _, item := range strings.Split(v, ",") {
			values = append(values, item)
		}
	default:
		return nil, errors.New("fields debe ser un array de strings o un string separado por comas")
	}

	fields := make([]string, 0, len(values))
	seen := make(map[string]bool, len(values))
	for _, value := range values {
		field := strings.ToLower(strings.TrimSpace(value))
		if field == "" {
			continue
		}
		if field == "raw_phone" {
			field = "phone"
		}
		if _, ok := mcpSimpleLeadAllowedFields[field]; !ok {
			return nil, fmt.Errorf("field inválido: %s", field)
		}
		if !seen[field] {
			fields = append(fields, field)
			seen[field] = true
		}
	}
	if len(fields) == 0 {
		return append([]string{}, defaults...), nil
	}
	return fields, nil
}

func mcpSimpleLeadAllowedFieldNames() []string {
	fields := make([]string, 0, len(mcpSimpleLeadAllowedFields))
	for field := range mcpSimpleLeadAllowedFields {
		fields = append(fields, field)
	}
	sort.Strings(fields)
	return fields
}

func (r mcpSimpleLeadRow) mapForFields(fields []string) map[string]any {
	out := make(map[string]any, len(fields)+3)
	for _, field := range fields {
		switch field {
		case "id":
			out["id"] = r.ID.String()
		case "name":
			out["name"] = r.Name
		case "phone":
			out["phone"] = r.RawPhone
			out["raw_phone"] = r.RawPhone
		case "normalized_phone":
			out["normalized_phone"] = r.NormalizedPhone
			out["phone_country"] = r.PhoneCountry
			out["phone_valid"] = r.PhoneValid
		case "email":
			out["email"] = r.Email
		case "stage":
			out["stage"] = r.Stage
		case "source":
			out["source"] = r.Source
		case "created_at":
			out["created_at"] = r.CreatedAt.Format(time.RFC3339)
		case "tags":
			out["tags"] = r.Tags
		case "status":
			out["status"] = r.Status
		}
	}
	return out
}

func normalizeLeadPhonePE(raw string) (string, string, bool) {
	digits := onlyDigits(raw)
	for strings.HasPrefix(digits, "00") {
		digits = strings.TrimPrefix(digits, "00")
	}
	if strings.HasPrefix(digits, "0") && len(digits) == 10 {
		digits = strings.TrimPrefix(digits, "0")
	}

	if len(digits) == 9 {
		valid := strings.HasPrefix(digits, "9")
		return "+51" + digits, "PE", valid
	}
	if strings.HasPrefix(digits, "51") && len(digits) == 11 {
		local := strings.TrimPrefix(digits, "51")
		valid := len(local) == 9 && strings.HasPrefix(local, "9")
		return "+51" + local, "PE", valid
	}
	if strings.HasPrefix(digits, "51") && len(digits) > 2 {
		return "+" + digits, "PE", false
	}
	if digits != "" {
		return "+" + digits, "", false
	}
	return "", "", false
}

func onlyDigits(raw string) string {
	var b strings.Builder
	for _, r := range raw {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func mcpSimpleLeadQueryHash(tool string, filters mcpSimpleLeadFilters, fields []string, extra map[string]any) string {
	payload := map[string]any{
		"tool":            tool,
		"filters_applied": filters.appliedMap(),
		"fields":          fields,
	}
	for key, value := range extra {
		payload[key] = value
	}
	b, _ := json.Marshal(payload)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func mcpAccountStructuredError(err error) *mcp.CallToolResult {
	code := mcpErrorCode(err, mcpErrorAccountNotFound)
	message := mcpErrorMessage(err, "no se pudo determinar la cuenta")
	return mcpStructuredError(code, message, nil)
}

func mcpStructuredError(code, message string, details map[string]any) *mcp.CallToolResult {
	payload := map[string]any{
		"error_code":  code,
		"message":     message,
		"recoverable": true,
	}
	for key, value := range details {
		payload[key] = value
	}
	b, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return errResult("error al serializar error estructurado: " + err.Error())
	}
	return mcp.NewToolResultError(string(b))
}
