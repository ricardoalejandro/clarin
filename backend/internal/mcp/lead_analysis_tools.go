package mcp

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
	"github.com/mark3labs/mcp-go/mcp"
)

type analysisCursor struct {
	Offset int `json:"offset"`
}

type leadAnalysisBase struct {
	LeadID            string
	ContactID         string
	Name              string
	Phone             string
	Email             string
	Age               *int
	DNI               string
	CreatedAt         string
	Source            string
	Status            string
	LeadNotes         string
	ContactNotes      string
	Stage             string
	Tags              []string
	IsArchived        bool
	IsBlocked         bool
	InboundCount      int
	OutboundCount     int
	LastInboundAt     string
	LastOutboundAt    string
	InboundText       string
	EventCount        int
	EventConfirmed    bool
	EventAttended     bool
	EventDeclined     bool
	ProgramCount      int
	CampaignCount     int
	SurveyCount       int
	DynamicCount      int
	InteractionCount  int
	TaskCount         int
	CustomFieldCount  int
	DuplicatePhoneCnt int
}

type leadAnalysisScore struct {
	Score               int      `json:"score_prioridad_contacto_0_100"`
	InterestScore       int      `json:"score_interes_real_0_5"`
	WhatsAppScore       int      `json:"score_respuesta_whatsapp_0_5"`
	IdealistScore       int      `json:"score_perfil_idealista_0_5"`
	EmotionalScore      int      `json:"score_necesidad_emocional_0_5"`
	Priority            string   `json:"nivel_prioridad"`
	Temperature         string   `json:"temperatura_real"`
	WhatsAppCategory    string   `json:"respuesta_whatsapp_categoria"`
	LastConversation    string   `json:"ultimo_estado_conversacion"`
	PrimaryProfile      string   `json:"perfil_humano_principal"`
	SecondaryProfile    string   `json:"perfil_humano_secundario,omitempty"`
	RecommendedAction   string   `json:"accion_recomendada"`
	MessageType         string   `json:"mensaje_sugerido_tipo"`
	Reason              string   `json:"razon_prioridad"`
	Evidence            string   `json:"evidencia_chat_clave,omitempty"`
	Risk                string   `json:"riesgo_de_insistir"`
	Segments            []string `json:"segmentos"`
	ConvertedOrInternal bool     `json:"ya_convertido_o_interno"`
}

func encodeAnalysisCursor(offset int) string {
	if offset <= 0 {
		return ""
	}
	b, _ := json.Marshal(analysisCursor{Offset: offset})
	return base64.RawURLEncoding.EncodeToString(b)
}

func decodeAnalysisCursor(raw string) (int, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0, nil
	}
	b, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return 0, errors.New("cursor inválido")
	}
	var c analysisCursor
	if err := json.Unmarshal(b, &c); err != nil || c.Offset < 0 {
		return 0, errors.New("cursor inválido")
	}
	return c.Offset, nil
}

func timePtrString(t *time.Time) string {
	if t == nil || t.IsZero() {
		return ""
	}
	return t.Format(time.RFC3339)
}

func jsonRawOrEmpty(raw []byte) json.RawMessage {
	if len(raw) == 0 {
		return json.RawMessage("[]")
	}
	return json.RawMessage(raw)
}

func jsonObject(raw []byte) map[string]any {
	out := map[string]any{}
	_ = json.Unmarshal(raw, &out)
	return out
}

func jsonArray(raw []byte) []map[string]any {
	var out []map[string]any
	_ = json.Unmarshal(raw, &out)
	if out == nil {
		return []map[string]any{}
	}
	return out
}

func numberFromJSON(v any) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	case int64:
		return int(n)
	case json.Number:
		i, _ := n.Int64()
		return int(i)
	default:
		return 0
	}
}

func compactSnippet(s string, max int) string {
	s = strings.TrimSpace(strings.Join(strings.Fields(s), " "))
	if max > 0 && len(s) > max {
		return s[:max] + "..."
	}
	return s
}

func lowerText(parts ...string) string {
	return strings.ToLower(strings.Join(parts, " "))
}

func hasAny(text string, words ...string) bool {
	text = strings.ToLower(text)
	for _, w := range words {
		if strings.Contains(text, strings.ToLower(w)) {
			return true
		}
	}
	return false
}

func addReason(reasons *[]string, reason string) {
	for _, r := range *reasons {
		if r == reason {
			return
		}
	}
	*reasons = append(*reasons, reason)
}

func leadAnalysisWhere(req mcp.CallToolRequest, accountID uuid.UUID) (string, []any, error) {
	where := ` WHERE l.account_id = $1`
	args := []any{accountID}
	argN := 2

	if query := strings.TrimSpace(stringArg(req, "query")); query != "" {
		where += fmt.Sprintf(` AND (
			COALESCE(l.name, '') ILIKE $%d OR COALESCE(l.last_name, '') ILIKE $%d OR
			COALESCE(c.name, '') ILIKE $%d OR COALESCE(c.custom_name, '') ILIKE $%d OR
			COALESCE(c.push_name, '') ILIKE $%d OR COALESCE(l.phone, c.phone, '') ILIKE $%d OR
			COALESCE(l.email, c.email, '') ILIKE $%d
		)`, argN, argN, argN, argN, argN, argN, argN)
		args = append(args, "%"+query+"%")
		argN++
	}
	if tag := strings.TrimSpace(stringArg(req, "tag")); tag != "" {
		where += fmt.Sprintf(` AND EXISTS (
			SELECT 1 FROM contact_tags ct_filter
			JOIN tags t_filter ON t_filter.id = ct_filter.tag_id
			WHERE ct_filter.contact_id = l.contact_id
			  AND t_filter.account_id = l.account_id
			  AND t_filter.name ILIKE $%d
		)`, argN)
		args = append(args, "%"+tag+"%")
		argN++
	}
	if stage := strings.TrimSpace(stringArg(req, "stage")); stage != "" {
		where += fmt.Sprintf(` AND COALESCE(ps.name, '') ILIKE $%d`, argN)
		args = append(args, "%"+stage+"%")
		argN++
	}
	if source := strings.TrimSpace(stringArg(req, "source")); source != "" {
		where += fmt.Sprintf(` AND COALESCE(l.source, c.source, '') ILIKE $%d`, argN)
		args = append(args, "%"+source+"%")
		argN++
	}
	if leadIDRaw := strings.TrimSpace(stringArg(req, "lead_id")); leadIDRaw != "" {
		leadID, err := uuid.Parse(leadIDRaw)
		if err != nil {
			return "", nil, errors.New("lead_id inválido")
		}
		where += fmt.Sprintf(` AND l.id = $%d`, argN)
		args = append(args, leadID)
		argN++
	}
	if createdAfter := strings.TrimSpace(stringArg(req, "created_after")); createdAfter != "" {
		t, err := time.Parse("2006-01-02", createdAfter)
		if err != nil {
			return "", nil, errors.New("created_after debe tener formato YYYY-MM-DD")
		}
		where += fmt.Sprintf(` AND l.created_at >= $%d`, argN)
		args = append(args, t)
		argN++
	}
	if createdBefore := strings.TrimSpace(stringArg(req, "created_before")); createdBefore != "" {
		t, err := time.Parse("2006-01-02", createdBefore)
		if err != nil {
			return "", nil, errors.New("created_before debe tener formato YYYY-MM-DD")
		}
		where += fmt.Sprintf(` AND l.created_at < $%d`, argN)
		args = append(args, t.Add(24*time.Hour))
		argN++
	}
	if boolArg(req, "active_only", false) {
		where += ` AND l.is_archived = false AND l.is_blocked = false`
	}
	return where, args, nil
}

func (s *MCPServer) toolGetAnalysisCapabilities(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	accountID, err := s.getAccountIDFromRequest(ctx, req)
	if err != nil {
		return mcpAccountStructuredError(err), nil
	}

	counts := map[string]int{}
	countQueries := map[string]string{
		"leads":        `SELECT COUNT(*) FROM leads WHERE account_id = $1`,
		"contacts":     `SELECT COUNT(*) FROM contacts WHERE account_id = $1`,
		"chats":        `SELECT COUNT(*) FROM chats WHERE account_id = $1`,
		"messages":     `SELECT COUNT(*) FROM messages WHERE account_id = $1`,
		"events":       `SELECT COUNT(*) FROM events WHERE account_id = $1`,
		"programs":     `SELECT COUNT(*) FROM programs WHERE account_id = $1`,
		"campaigns":    `SELECT COUNT(*) FROM campaigns WHERE account_id = $1`,
		"surveys":      `SELECT COUNT(*) FROM surveys WHERE account_id = $1`,
		"dynamics":     `SELECT COUNT(*) FROM dynamics WHERE account_id = $1`,
		"tags":         `SELECT COUNT(*) FROM tags WHERE account_id = $1`,
		"interactions": `SELECT COUNT(*) FROM interactions WHERE account_id = $1`,
	}
	for key, sql := range countQueries {
		var count int
		_ = s.repos.DB().QueryRow(ctx, sql, accountID).Scan(&count)
		counts[key] = count
	}

	return jsonResult(map[string]any{
		"account_id": accountID.String(),
		"counts":     counts,
		"recommended_workflow": []string{
			"1. Si el usuario pide CSV, Excel, Word, PowerPoint, descargar leads, nombre y celular o lista para difusión, usa list_leads con fields y cursor y luego prepare_file_export/render_file_export para que Clarin adjunte el archivo en el chat.",
			"2. Si el usuario sólo necesita contar o revisar una muestra ligera, usa count_leads y luego list_leads con fields.",
			"3. Usa get_lead_analysis_overview para entender la base completa sin descargar todo.",
			"4. Usa get_lead_analysis_report para obtener prioridades A+/A/B/C/D/E y acciones recomendadas.",
			"5. Usa get_segment_members para pedir directamente CALL, WHATSAPP_PERSONALIZADO, DIFUSION o NO_PRIORIZAR.",
			"6. Usa export_leads_for_analysis y export_messages_for_analysis con cursor cuando necesites evidencia cruda masiva.",
			"7. Usa get_lead_analysis_detail para revisar un lead puntual con todos sus cruces.",
		},
		"technical_limits": map[string]any{
			"simple_lead_list_default_page": 500,
			"simple_lead_list_max_page":     1000,
			"simple_data_delivery":          "json_paginated_for_chat_attachment; no usa MinIO ni devuelve URL pública",
			"client_format_policy":          "CSV, Excel, Word, PowerPoint y TXT se adjuntan en Eros mediante prepare_file_export/render_file_export y render bajo demanda del backend.",
			"lead_export_default_page":      500,
			"lead_export_max_page":          1000,
			"message_export_default_page":   1000,
			"message_export_max_page":       5000,
			"report_default_page":           200,
			"report_max_page":               1000,
			"report_default_max_scan":       5000,
			"report_max_scan":               20000,
			"pagination":                    "Todas las herramientas masivas devuelven has_more y next_cursor. No hay límite bajo de 20/50; se recorre la base por páginas.",
		},
		"sensitive_data_policy": "Esta conexión MCP autorizada puede acceder a teléfonos, emails, notas y texto de chats de las cuentas permitidas. Todas las herramientas siguen validando account_id/account_slug contra el allowlist MCP.",
		"available_tools": []string{
			"count_leads",
			"list_leads",
			"get_lead_analysis_overview",
			"get_lead_analysis_report",
			"export_leads_for_analysis",
			"export_messages_for_analysis",
			"get_lead_analysis_detail",
			"get_segment_members",
		},
	}), nil
}

func (s *MCPServer) toolGetLeadAnalysisOverview(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	accountID, err := s.getAccountIDFromRequest(ctx, req)
	if err != nil {
		return mcpAccountStructuredError(err), nil
	}
	where, args, err := leadAnalysisWhere(req, accountID)
	if err != nil {
		return errResult(err.Error()), nil
	}

	baseFrom := ` FROM leads l LEFT JOIN contacts c ON c.id = l.contact_id LEFT JOIN pipeline_stages ps ON ps.id = l.stage_id`
	var total int
	_ = s.repos.DB().QueryRow(ctx, `SELECT COUNT(*)`+baseFrom+where, args...).Scan(&total)

	overview := map[string]any{
		"account_id":   accountID.String(),
		"total_leads":  total,
		"filters_note": "Los filtros se aplican antes de calcular las distribuciones. active_only=false incluye archivados/bloqueados para analizar toda la base.",
	}

	overview["data_quality"] = s.singleRowMap(ctx, `
		SELECT
			COUNT(*) FILTER (WHERE COALESCE(l.phone, c.phone, '') <> '') AS with_phone,
			COUNT(*) FILTER (WHERE COALESCE(l.email, c.email, '') <> '') AS with_email,
			COUNT(*) FILTER (WHERE l.contact_id IS NOT NULL) AS with_contact,
			COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM chats ch WHERE ch.account_id = l.account_id AND ch.contact_id = l.contact_id)) AS with_chat,
			COUNT(*) FILTER (WHERE COALESCE(l.notes, c.notes, '') <> '') AS with_notes,
			COUNT(*) FILTER (WHERE l.is_archived = true) AS archived,
			COUNT(*) FILTER (WHERE l.is_blocked = true) AS blocked
	`+baseFrom+where, args...)

	overview["by_stage"] = s.rowsToMaps(ctx, `
		SELECT COALESCE(ps.name, 'Sin etapa') AS name, COUNT(*) AS count
	`+baseFrom+where+` GROUP BY ps.name, ps.position ORDER BY count DESC, ps.position NULLS LAST`, args...)

	overview["by_source"] = s.rowsToMaps(ctx, `
		SELECT COALESCE(NULLIF(l.source, ''), NULLIF(c.source, ''), 'Sin fuente') AS name, COUNT(*) AS count
	`+baseFrom+where+` GROUP BY name ORDER BY count DESC LIMIT 50`, args...)

	overview["top_tags"] = s.rowsToMaps(ctx, `
		SELECT t.name, COUNT(DISTINCT l.id) AS count
	`+baseFrom+`
		JOIN contact_tags ct ON ct.contact_id = l.contact_id
		JOIN tags t ON t.id = ct.tag_id AND t.account_id = l.account_id
	`+where+`
		GROUP BY t.name ORDER BY count DESC LIMIT 75`, args...)

	overview["chat_activity"] = s.singleRowMap(ctx, `
		SELECT
			COUNT(DISTINCT l.id) FILTER (WHERE ch.id IS NOT NULL) AS leads_with_chats,
			COUNT(m.id) AS total_messages,
			COUNT(m.id) FILTER (WHERE m.is_from_me = false) AS inbound_messages,
			COUNT(m.id) FILTER (WHERE m.is_from_me = true) AS outbound_messages,
			COUNT(DISTINCT l.id) FILTER (WHERE ch.last_inbound_at IS NOT NULL) AS leads_with_inbound,
			MAX(m.timestamp) AS last_message_at
	`+baseFrom+`
		LEFT JOIN chats ch ON ch.account_id = l.account_id AND ch.contact_id = l.contact_id
		LEFT JOIN messages m ON m.chat_id = ch.id
	`+where, args...)

	overview["events"] = s.singleRowMap(ctx, `
		SELECT
			COUNT(DISTINCT ep.lead_id) AS leads_with_events,
			COUNT(ep.id) AS participant_rows,
			COUNT(ep.id) FILTER (WHERE ep.confirmed_at IS NOT NULL OR ep.status ILIKE '%confirm%') AS confirmed_rows,
			COUNT(ep.id) FILTER (WHERE ep.attended_at IS NOT NULL OR ep.status ILIKE '%attend%' OR ep.status ILIKE '%asis%') AS attended_rows,
			COUNT(DISTINCT e.id) AS events
	`+baseFrom+`
		LEFT JOIN event_participants ep ON ep.lead_id = l.id
		LEFT JOIN events e ON e.id = ep.event_id AND e.account_id = l.account_id
	`+where, args...)

	overview["related_records"] = s.singleRowMap(ctx, `
		SELECT
			COUNT(DISTINCT pp.id) AS program_participants,
			COUNT(DISTINCT cr.id) AS campaign_recipients,
			COUNT(DISTINCT sr.id) AS survey_responses,
			COUNT(DISTINCT dlr.id) AS dynamic_registrations,
			COUNT(DISTINCT i.id) AS interactions,
			COUNT(DISTINCT tk.id) AS tasks
	`+baseFrom+`
		LEFT JOIN program_participants pp ON pp.lead_id = l.id
		LEFT JOIN campaign_recipients cr ON cr.contact_id = l.contact_id
		LEFT JOIN survey_responses sr ON sr.lead_id = l.id
		LEFT JOIN dynamic_link_registrations dlr ON dlr.lead_id = l.id
		LEFT JOIN interactions i ON i.account_id = l.account_id AND i.lead_id = l.id
		LEFT JOIN tasks tk ON tk.account_id = l.account_id AND tk.lead_id = l.id
	`+where, args...)

	return jsonResult(overview), nil
}

func (s *MCPServer) singleRowMap(ctx context.Context, sql string, args ...any) map[string]any {
	rows := s.rowsToMaps(ctx, sql, args...)
	if len(rows) == 0 {
		return map[string]any{}
	}
	return rows[0]
}

func (s *MCPServer) rowsToMaps(ctx context.Context, sql string, args ...any) []map[string]any {
	rows, err := s.repos.DB().Query(ctx, sql, args...)
	if err != nil {
		return []map[string]any{{"error": err.Error()}}
	}
	defer rows.Close()
	fields := rows.FieldDescriptions()
	out := make([]map[string]any, 0)
	for rows.Next() {
		values := make([]any, len(fields))
		ptrs := make([]any, len(fields))
		for i := range values {
			ptrs[i] = &values[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			continue
		}
		row := make(map[string]any, len(fields))
		for i, fd := range fields {
			v := values[i]
			if b, ok := v.([]byte); ok {
				row[string(fd.Name)] = string(b)
			} else if t, ok := v.(time.Time); ok {
				row[string(fd.Name)] = t.Format(time.RFC3339)
			} else {
				row[string(fd.Name)] = v
			}
		}
		out = append(out, row)
	}
	if out == nil {
		return []map[string]any{}
	}
	return out
}

func (s *MCPServer) fetchLeadAnalysisBase(ctx context.Context, accountID uuid.UUID, req mcp.CallToolRequest, maxScan int) ([]leadAnalysisBase, int, bool, error) {
	where, args, err := leadAnalysisWhere(req, accountID)
	if err != nil {
		return nil, 0, false, err
	}
	baseFrom := ` FROM leads l LEFT JOIN contacts c ON c.id = l.contact_id LEFT JOIN pipeline_stages ps ON ps.id = l.stage_id`
	var total int
	_ = s.repos.DB().QueryRow(ctx, `SELECT COUNT(*)`+baseFrom+where, args...).Scan(&total)

	sql := `
		SELECT
			l.id::text,
			COALESCE(l.contact_id::text, ''),
			COALESCE(NULLIF(l.name, ''), NULLIF(c.custom_name, ''), NULLIF(c.name, ''), NULLIF(c.push_name, ''), ''),
			COALESCE(NULLIF(l.phone, ''), NULLIF(c.phone, ''), ''),
			COALESCE(NULLIF(l.email, ''), NULLIF(c.email, ''), ''),
			COALESCE(l.age, c.age),
			COALESCE(NULLIF(l.dni, ''), NULLIF(c.dni, ''), ''),
			l.created_at,
			COALESCE(NULLIF(l.source, ''), NULLIF(c.source, ''), ''),
			COALESCE(l.status, ''),
			COALESCE(l.notes, ''),
			COALESCE(c.notes, ''),
			COALESCE(ps.name, ''),
			COALESCE((SELECT array_agg(DISTINCT t.name ORDER BY t.name)
				FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id
				WHERE ct.contact_id = l.contact_id AND t.account_id = l.account_id), ARRAY[]::text[]),
			COALESCE(l.is_archived, false),
			COALESCE(l.is_blocked, false),
			COALESCE(cs.inbound_count, 0),
			COALESCE(cs.outbound_count, 0),
			cs.last_inbound_at,
			cs.last_outbound_at,
			COALESCE(it.inbound_text, ''),
			COALESCE(es.event_count, 0),
			COALESCE(es.confirmed, false),
			COALESCE(es.attended, false),
			COALESCE(es.declined, false),
			COALESCE(psg.program_count, 0),
			COALESCE(cpg.campaign_count, 0),
			COALESCE(svg.survey_count, 0),
			COALESCE(dyg.dynamic_count, 0),
			COALESCE(ig.interaction_count, 0),
			COALESCE(tkg.task_count, 0),
			COALESCE(cfg.custom_field_count, 0),
			COALESCE(dup.duplicate_phone_count, 0)
	` + baseFrom + `
		LEFT JOIN LATERAL (
			SELECT
				COUNT(m.id) FILTER (WHERE m.is_from_me = false)::int AS inbound_count,
				COUNT(m.id) FILTER (WHERE m.is_from_me = true)::int AS outbound_count,
				MAX(m.timestamp) FILTER (WHERE m.is_from_me = false) AS last_inbound_at,
				MAX(m.timestamp) FILTER (WHERE m.is_from_me = true) AS last_outbound_at
			FROM chats ch
			LEFT JOIN messages m ON m.chat_id = ch.id
			WHERE ch.account_id = l.account_id AND ch.contact_id = l.contact_id
		) cs ON true
		LEFT JOIN LATERAL (
			SELECT string_agg(snippet, ' | ' ORDER BY ts DESC) AS inbound_text
			FROM (
				SELECT LEFT(COALESCE(m.body, ''), 300) AS snippet, m.timestamp AS ts
				FROM chats ch
				JOIN messages m ON m.chat_id = ch.id
				WHERE ch.account_id = l.account_id
				  AND ch.contact_id = l.contact_id
				  AND m.is_from_me = false
				  AND COALESCE(m.body, '') <> ''
				ORDER BY m.timestamp DESC
				LIMIT 40
			) inbound_samples
		) it ON true
		LEFT JOIN LATERAL (
			SELECT
				COUNT(ep.id)::int AS event_count,
				BOOL_OR(ep.confirmed_at IS NOT NULL OR ep.status ILIKE '%confirm%' OR eps.name ILIKE '%confirm%') AS confirmed,
				BOOL_OR(ep.attended_at IS NOT NULL OR ep.status ILIKE '%attend%' OR ep.status ILIKE '%asis%' OR eps.name ILIKE '%asis%') AS attended,
				BOOL_OR(ep.status ILIKE '%declin%' OR eps.name ILIKE '%declin%') AS declined
			FROM event_participants ep
			JOIN events e ON e.id = ep.event_id AND e.account_id = l.account_id
			LEFT JOIN event_pipeline_stages eps ON eps.id = ep.stage_id
			WHERE ep.lead_id = l.id OR ep.contact_id = l.contact_id
		) es ON true
		LEFT JOIN LATERAL (
			SELECT COUNT(pp.id)::int AS program_count
			FROM program_participants pp
			JOIN programs p ON p.id = pp.program_id AND p.account_id = l.account_id
			WHERE pp.lead_id = l.id OR pp.contact_id = l.contact_id
		) psg ON true
		LEFT JOIN LATERAL (
			SELECT COUNT(cr.id)::int AS campaign_count
			FROM campaign_recipients cr
			JOIN campaigns ca ON ca.id = cr.campaign_id AND ca.account_id = l.account_id
			WHERE cr.contact_id = l.contact_id
			   OR (regexp_replace(COALESCE(cr.phone, ''), '\D', '', 'g') <> ''
			       AND regexp_replace(COALESCE(cr.phone, ''), '\D', '', 'g') = regexp_replace(COALESCE(l.phone, c.phone, ''), '\D', '', 'g'))
		) cpg ON true
		LEFT JOIN LATERAL (
			SELECT COUNT(sr.id)::int AS survey_count
			FROM survey_responses sr
			WHERE sr.account_id = l.account_id AND sr.lead_id = l.id
		) svg ON true
		LEFT JOIN LATERAL (
			SELECT COUNT(dlr.id)::int AS dynamic_count
			FROM dynamic_link_registrations dlr
			JOIN dynamic_links dl ON dl.id = dlr.link_id
			JOIN dynamics d ON d.id = dl.dynamic_id AND d.account_id = l.account_id
			WHERE dlr.lead_id = l.id OR dlr.contact_id = l.contact_id
		) dyg ON true
		LEFT JOIN LATERAL (
			SELECT COUNT(i.id)::int AS interaction_count
			FROM interactions i
			WHERE i.account_id = l.account_id AND (i.lead_id = l.id OR i.contact_id = l.contact_id)
		) ig ON true
		LEFT JOIN LATERAL (
			SELECT COUNT(tk.id)::int AS task_count
			FROM tasks tk
			WHERE tk.account_id = l.account_id AND (tk.lead_id = l.id OR tk.contact_id = l.contact_id)
		) tkg ON true
		LEFT JOIN LATERAL (
			SELECT COUNT(cfv.id)::int AS custom_field_count
			FROM custom_field_values cfv
			JOIN custom_field_definitions cfd ON cfd.id = cfv.field_id AND cfd.account_id = l.account_id
			WHERE cfv.contact_id = l.contact_id
		) cfg ON true
		LEFT JOIN LATERAL (
			SELECT COUNT(l2.id)::int AS duplicate_phone_count
			FROM leads l2
			LEFT JOIN contacts c2 ON c2.id = l2.contact_id
			WHERE l2.account_id = l.account_id
			  AND l2.id <> l.id
			  AND regexp_replace(COALESCE(l2.phone, c2.phone, ''), '\D', '', 'g') <> ''
			  AND regexp_replace(COALESCE(l2.phone, c2.phone, ''), '\D', '', 'g') = regexp_replace(COALESCE(l.phone, c.phone, ''), '\D', '', 'g')
		) dup ON true
	` + where + fmt.Sprintf(` ORDER BY l.created_at DESC, l.id DESC LIMIT %d`, maxScan)

	rows, err := s.repos.DB().Query(ctx, sql, args...)
	if err != nil {
		return nil, total, false, err
	}
	defer rows.Close()

	out := make([]leadAnalysisBase, 0)
	for rows.Next() {
		var r leadAnalysisBase
		var createdAt time.Time
		var lastIn, lastOut *time.Time
		if err := rows.Scan(
			&r.LeadID, &r.ContactID, &r.Name, &r.Phone, &r.Email, &r.Age, &r.DNI, &createdAt,
			&r.Source, &r.Status, &r.LeadNotes, &r.ContactNotes, &r.Stage, &r.Tags,
			&r.IsArchived, &r.IsBlocked, &r.InboundCount, &r.OutboundCount, &lastIn, &lastOut,
			&r.InboundText, &r.EventCount, &r.EventConfirmed, &r.EventAttended, &r.EventDeclined,
			&r.ProgramCount, &r.CampaignCount, &r.SurveyCount, &r.DynamicCount, &r.InteractionCount,
			&r.TaskCount, &r.CustomFieldCount, &r.DuplicatePhoneCnt,
		); err != nil {
			return nil, total, false, err
		}
		r.CreatedAt = createdAt.Format(time.RFC3339)
		r.LastInboundAt = timePtrString(lastIn)
		r.LastOutboundAt = timePtrString(lastOut)
		out = append(out, r)
	}
	return out, total, total > len(out), nil
}

func scoreLeadForAnalysis(r leadAnalysisBase) leadAnalysisScore {
	stage := strings.ToLower(r.Stage)
	tagsText := strings.ToLower(strings.Join(r.Tags, " "))
	allText := lowerText(r.Source, r.LeadNotes, r.ContactNotes, tagsText, r.InboundText, r.Stage)
	inbound := strings.ToLower(r.InboundText)

	course := hasAny(allText, "conócete", "conocete", "autoconocimiento", "filosof", "curso", "acrópolis", "acropolis")
	ideal := hasAny(allText, "sentido", "conciencia", "quién soy", "quien soy", "sabidur", "estoic", "platón", "platon")
	emotional := hasAny(allText, "ansiedad", "emoción", "emocion", "cansancio", "estrés", "estres", "fortaleza", "serenidad", "resiliencia", "dolor", "felicidad", "equilibrio")
	details := hasAny(inbound, "horario", "hora", "dirección", "direccion", "ubicación", "ubicacion", "lugar", "costo", "precio", "modalidad", "duración", "duracion", "termina")
	confirm := hasAny(inbound, "confirmo", "confirmado", "estaré", "estare", "voy", "asistiré", "asistire", "separar", "cupo", "inscrib") || hasAny(tagsText, "confirmado", "conf_") || r.EventConfirmed
	date := hasAny(inbound, "miércoles", "miercoles", "sábado", "sabado", "domingo", "lunes", "martes", "jueves", "viernes", "fecha", "turno")
	newDate := hasAny(inbound, "nueva fecha", "proxima fecha", "próxima fecha", "otra fecha", "otro día", "otro dia", "reprogram")
	obstacle := hasAny(inbound, "trabajo", "examen", "lluvia", "salud", "enfermedad", "clases", "universidad", "estudios", "reunión", "reunion", "viaje", "horario", "se me complica", "no pude", "no podré", "no podre")
	apology := hasAny(inbound, "disculpa", "perdón", "perdon", "lo siento", "no pude", "se me complic")
	rejection := hasAny(inbound, "no estoy interesado", "no estoy interesada", "no me interesa", "no deseo", "no quiero", "no me escrib", "no enviar", "dar de baja", "eliminar", "stop")
	family := hasAny(inbound, "esposa", "esposo", "hija", "hijo", "hermana", "hermano", "mamá", "mama", "papá", "papa", "sobrina", "sobrino", "familiar", "acompañante", "acompanante")
	student := hasAny(inbound, "universidad", "instituto", "estudio", "estudios", "clases", "examen", "prácticas", "practicas")
	cultural := hasAny(allText, "libro", "lectura", "poesía", "poesia", "oratoria", "cultura", "comunidad", "voluntariado", "arte")
	adsOnly := hasAny(r.Source+" "+tagsText, "ads", "rrss", "facebook", "instagram", "kommo", "meta") && r.InboundCount < 2 && !details && !confirm
	converted := hasAny(stage, "inscritos", "closed - won") || r.ProgramCount > 0
	internal := hasAny(strings.ToLower(r.Name+" "+r.Source+" "+tagsText), "test", "prueba", "nueva acrópolis", "nueva acropolis")

	score := 0
	reasons := make([]string, 0)
	if hasAny(stage+" "+tagsText, "pre-inscrito") {
		score += 25
		addReason(&reasons, "etapa/tag PRE-INSCRITO")
	}
	if hasAny(stage, "interesado curso") {
		score += 25
		addReason(&reasons, "etapa INTERESADO CURSO")
	}
	if r.EventAttended || hasAny(tagsText, "asis_") {
		score += 20
		addReason(&reasons, "asistencia previa o tag ASIS")
	}
	if (hasAny(stage, "confirmado") || hasAny(tagsText, "confirmado", "conf_") || r.EventConfirmed) && r.InboundCount > 0 {
		score += 18
		addReason(&reasons, "confirmación con respuesta registrada")
	}
	if course {
		score += 15
		addReason(&reasons, "interés por curso/autoconocimiento")
	}
	if date {
		score += 15
		addReason(&reasons, "elige o consulta fecha/turno")
	}
	if r.Phone != "" && (r.Email != "" || r.DNI != "" || r.Age != nil) {
		score += 15
		addReason(&reasons, "datos complementarios registrados")
	}
	if details {
		score += 15
		addReason(&reasons, "pregunta detalles concretos")
	}
	if newDate {
		score += 12
		addReason(&reasons, "pide nueva fecha")
	}
	if apology || obstacle {
		score += 10
		addReason(&reasons, "obstáculo real o disculpa")
	}
	if hasAny(tagsText, "miembro-comunidad", "comunidad") && r.InboundCount > 0 {
		score += 10
		addReason(&reasons, "comunidad con respuesta real")
	}
	if hasAny(tagsText, "revivió", "revivio") {
		score += 8
		addReason(&reasons, "tag REVIVIÓ")
	}
	if ideal {
		score += 8
		addReason(&reasons, "lenguaje filosófico/idealista")
	}
	if family {
		score += 8
		addReason(&reasons, "familiar o acompañante")
	}
	if hasAny(tagsText, "dinamica", "dinámica") && r.InboundCount > 0 {
		score += 5
		addReason(&reasons, "dinámica con respuesta")
	}
	if r.InboundCount >= 2 && r.OutboundCount >= 1 {
		score += 5
		addReason(&reasons, "conversación real de ida y vuelta")
	}
	if adsOnly {
		score -= 5
		addReason(&reasons, "ads/redes sin maduración")
	}
	if r.InboundCount == 0 && r.OutboundCount > 0 {
		score -= 10
		addReason(&reasons, "solo mensajes salientes")
	}
	if hasAny(tagsText, "no responde") {
		score -= 12
		addReason(&reasons, "tag NO RESPONDE")
	}
	if r.OutboundCount >= 2 && r.InboundCount == 0 {
		score -= 12
		addReason(&reasons, "silencio tras 2+ salientes")
	}
	if hasAny(stage, "por invitar - frios") && !(course || details || confirm || obstacle || r.EventAttended) {
		score -= 15
		addReason(&reasons, "frío sin evidencia fuerte")
	}
	if rejection {
		score -= 25
		addReason(&reasons, "rechazo explícito o baja intención")
	}
	if r.DuplicatePhoneCnt > 0 {
		score -= 8
		addReason(&reasons, "posible duplicado")
	}
	if r.IsArchived || hasAny(stage, "archivado", "closed - lost") {
		score -= 40
		addReason(&reasons, "archivado/lost sin reactivación clara")
	}
	if score < 0 {
		score = 0
	}
	if score > 100 {
		score = 100
	}

	priority, temperature, action, msgType := "E", "No insistir", "No priorizar", "No contactar"
	if converted {
		priority, temperature, action, msgType = "E", "No insistir", "Seguimiento interno / no tratar como captación externa", "No contactar"
		addReason(&reasons, "ya convertido o programa asociado")
	} else if rejection || internal || r.Phone == "" {
		priority, temperature, action, msgType = "E", "No insistir", "No contactar por ahora", "No contactar"
	} else if score >= 80 {
		priority, temperature, action, msgType = "A+", "Caliente", "Llamar / contacto personal inmediato", "Llamada"
	} else if score >= 65 {
		priority, temperature, action, msgType = "A", "Tibio alto", "WhatsApp personalizado muy humano", "WhatsApp personalizado"
	} else if score >= 45 {
		priority, temperature, action, msgType = "B", "Tibio", "WhatsApp personalizado breve", "WhatsApp personalizado"
	} else if score >= 25 {
		priority, temperature, action, msgType = "C", "Frío recuperable", "Difusión segmentada o mensaje suave", "WhatsApp suave"
	} else if score > 0 {
		priority, temperature, action, msgType = "D", "Frío real", "Mantener sin insistir", "Solo broadcast"
	}
	if obstacle && (priority == "A" || priority == "B" || priority == "C") {
		msgType = "Mensaje de disculpa/recuperación"
	}
	if student && (priority == "A+" || priority == "A" || priority == "B" || priority == "C") {
		msgType = "Mensaje para estudiantes"
	}
	if family && (priority == "A+" || priority == "A" || priority == "B" || priority == "C") {
		msgType = "Mensaje familiar/acompañante"
	}
	if cultural && (priority == "B" || priority == "C") {
		msgType = "Invitación a comunidad"
	}
	if adsOnly && (priority == "C" || priority == "D") {
		msgType = "Solo broadcast"
	}

	waCategory, waScore := "No contacto útil", 0
	switch {
	case r.InboundCount >= 2 && r.OutboundCount >= 1 && (confirm || details || course):
		waCategory, waScore = "Proactivo sostenido", 5
	case obstacle:
		waCategory, waScore = "Obstáculo real", 4
	case r.InboundCount > 0 && (confirm || details || course):
		waCategory, waScore = "Reactivo positivo", 4
	case r.InboundCount > 0 && r.OutboundCount >= 2:
		waCategory, waScore = "Intermitente", 3
	case r.InboundCount > 0:
		waCategory, waScore = "Proactivo débil", 2
	case r.OutboundCount > 0:
		waCategory, waScore = "Silencioso", 1
	}
	if rejection {
		waCategory, waScore = "Rechazo cordial", 0
	}

	lastState := "Sin conversación registrada"
	switch {
	case rejection:
		lastState = "Rechazo"
	case obstacle:
		lastState = "Obstáculo real"
	case r.LastInboundAt != "" && (r.LastOutboundAt == "" || r.LastInboundAt > r.LastOutboundAt):
		lastState = "Último mensaje fue del lead"
	case r.InboundCount > 0 && r.OutboundCount > 0:
		lastState = "Silencio después de invitación"
	case r.OutboundCount > 0:
		lastState = "Último mensaje fue nuestro"
	}

	profileScores := map[string]int{}
	if course || ideal {
		profileScores["Buscador filosófico / idealista"] += 3
	}
	if emotional {
		profileScores["Necesidad emocional / contención"] += 3
	}
	if hasAny(allText, "felicidad", "hábitos", "habitos", "decisiones", "emociones", "ansiedad", "fortaleza") {
		profileScores["Mejora personal práctica"] += 2
	}
	if cultural || hasAny(tagsText, "comunidad", "miembro-comunidad") {
		profileScores["Cultural / comunitario"] += 2
	}
	if student {
		profileScores["Estudiante / joven con limitación de horario"] += 2
	}
	if family {
		profileScores["Familiar / referidor"] += 3
	}
	if r.EventAttended || hasAny(tagsText, "asis_") {
		profileScores["Asistente previo recuperable"] += 4
	}
	if r.EventConfirmed && !r.EventAttended {
		profileScores["Confirmado que no asistió"] += 3
	}
	if adsOnly {
		profileScores["Lead frío de redes/ads"] += 3
	}
	if len(profileScores) == 0 {
		profileScores["No prioritario / sin señales"] = 1
	}
	type kv struct {
		Key string
		Val int
	}
	ordered := make([]kv, 0, len(profileScores))
	for k, v := range profileScores {
		ordered = append(ordered, kv{k, v})
	}
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].Val > ordered[j].Val })
	primary, secondary := ordered[0].Key, ""
	if len(ordered) > 1 {
		secondary = ordered[1].Key
	}

	interest := 0
	switch {
	case score >= 80:
		interest = 5
	case score >= 65:
		interest = 4
	case score >= 45:
		interest = 3
	case score >= 25:
		interest = 2
	case score > 0:
		interest = 1
	}
	if rejection || r.Phone == "" {
		interest = 0
	}
	if converted {
		interest = 5
	}

	risk := "Medio: usar difusión suave"
	if converted {
		risk = "Alto: ya convertido / seguimiento interno"
	} else if rejection {
		risk = "Alto: rechazo explícito"
	} else if r.OutboundCount >= 3 && r.InboundCount == 0 {
		risk = "Medio-alto: posible saturación por silencio"
	} else if priority == "A+" || priority == "A" || priority == "B" {
		risk = "Bajo si se personaliza"
	}

	segments := []string{}
	if priority == "A+" || priority == "A" {
		segments = append(segments, "CALL")
	}
	if priority == "B" {
		segments = append(segments, "WHATSAPP_PERSONALIZADO")
	}
	if priority == "C" || priority == "D" {
		segments = append(segments, "DIFUSION")
	}
	if priority == "E" {
		segments = append(segments, "NO_PRIORIZAR")
	}
	if obstacle {
		segments = append(segments, "OBSTACULO_REAL")
	}
	if r.EventAttended || hasAny(tagsText, "asis_") {
		segments = append(segments, "ASISTENTE_PREVIO")
	}
	if r.EventConfirmed && !r.EventAttended {
		segments = append(segments, "CONFIRMADO_NO_ASISTIO")
	}
	if adsOnly {
		segments = append(segments, "REDES_FRIAS")
	}

	evidence := ""
	for _, part := range strings.Split(r.InboundText, "|") {
		part = compactSnippet(part, 120)
		if part == "" {
			continue
		}
		if evidence == "" || hasAny(part, "curso", "horario", "confirm", "fecha", "disculpa", "examen", "trabajo", "conócete", "conocete", "costo") {
			evidence = `"` + part + `"`
			break
		}
	}
	reason := strings.Join(reasons, "; ")
	if reason == "" {
		reason = "Sin evidencia suficiente; clasificación inferida por metadata disponible"
	}

	return leadAnalysisScore{
		Score:               score,
		InterestScore:       interest,
		WhatsAppScore:       waScore,
		IdealistScore:       minInt(5, boolInt(ideal)*3+boolInt(course)*2),
		EmotionalScore:      minInt(5, boolInt(emotional)*4),
		Priority:            priority,
		Temperature:         temperature,
		WhatsAppCategory:    waCategory,
		LastConversation:    lastState,
		PrimaryProfile:      primary,
		SecondaryProfile:    secondary,
		RecommendedAction:   action,
		MessageType:         msgType,
		Reason:              reason,
		Evidence:            evidence,
		Risk:                risk,
		Segments:            segments,
		ConvertedOrInternal: converted || internal,
	}
}

func boolInt(v bool) int {
	if v {
		return 1
	}
	return 0
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func reportRowFromBase(r leadAnalysisBase) map[string]any {
	score := scoreLeadForAnalysis(r)
	row := map[string]any{
		"lead_id":                        r.LeadID,
		"contact_id":                     r.ContactID,
		"nombre":                         r.Name,
		"telefono":                       r.Phone,
		"email":                          r.Email,
		"edad":                           r.Age,
		"dni":                            r.DNI,
		"fecha_creacion":                 r.CreatedAt,
		"fuente":                         r.Source,
		"etapa_crm":                      r.Stage,
		"status":                         r.Status,
		"tags":                           r.Tags,
		"total_mensajes_entrantes":       r.InboundCount,
		"total_mensajes_salientes":       r.OutboundCount,
		"ultimo_mensaje_entrante_fecha":  r.LastInboundAt,
		"ultimo_mensaje_saliente_fecha":  r.LastOutboundAt,
		"eventos_asociados_count":        r.EventCount,
		"programas_asociados_count":      r.ProgramCount,
		"campañas_recibidas_count":       r.CampaignCount,
		"encuestas_respuestas_count":     r.SurveyCount,
		"dinamicas_registros_count":      r.DynamicCount,
		"observaciones_count":            r.InteractionCount + r.TaskCount,
		"custom_fields_count":            r.CustomFieldCount,
		"posible_duplicado_phone_count":  r.DuplicatePhoneCnt,
		"is_archived":                    r.IsArchived,
		"is_blocked":                     r.IsBlocked,
		"score_interes_real_0_5":         score.InterestScore,
		"score_respuesta_whatsapp_0_5":   score.WhatsAppScore,
		"score_perfil_idealista_0_5":     score.IdealistScore,
		"score_necesidad_emocional_0_5":  score.EmotionalScore,
		"score_prioridad_contacto_0_100": score.Score,
		"nivel_prioridad":                score.Priority,
		"temperatura_real":               score.Temperature,
		"respuesta_whatsapp_categoria":   score.WhatsAppCategory,
		"ultimo_estado_conversacion":     score.LastConversation,
		"perfil_humano_principal":        score.PrimaryProfile,
		"perfil_humano_secundario":       score.SecondaryProfile,
		"razon_prioridad":                score.Reason,
		"evidencia_chat_clave":           score.Evidence,
		"accion_recomendada":             score.RecommendedAction,
		"mensaje_sugerido_tipo":          score.MessageType,
		"riesgo_de_insistir":             score.Risk,
		"segmentos":                      score.Segments,
		"ya_convertido_o_interno":        score.ConvertedOrInternal,
	}
	return row
}

func applyExportMetricsToBase(base *leadAnalysisBase, chatMetrics, eventsRaw, programsRaw, campaignsRaw, surveysRaw, dynamicsRaw, interactionsRaw, tasksRaw, customFieldsRaw, duplicateRaw []byte) {
	chat := jsonObject(chatMetrics)
	base.InboundCount = numberFromJSON(chat["inbound_messages"])
	base.OutboundCount = numberFromJSON(chat["outbound_messages"])
	if v, ok := chat["last_inbound_at"].(string); ok {
		base.LastInboundAt = v
	}
	if v, ok := chat["last_outbound_at"].(string); ok {
		base.LastOutboundAt = v
	}

	events := jsonArray(eventsRaw)
	base.EventCount = len(events)
	for _, ev := range events {
		status := strings.ToLower(fmt.Sprint(ev["participant_status"], " ", ev["stage"]))
		if ev["confirmed_at"] != nil || strings.Contains(status, "confirm") {
			base.EventConfirmed = true
		}
		if ev["attended_at"] != nil || strings.Contains(status, "attend") || strings.Contains(status, "asis") {
			base.EventAttended = true
		}
		if strings.Contains(status, "declin") {
			base.EventDeclined = true
		}
	}
	base.ProgramCount = len(jsonArray(programsRaw))
	base.CampaignCount = len(jsonArray(campaignsRaw))
	base.SurveyCount = len(jsonArray(surveysRaw))
	base.DynamicCount = len(jsonArray(dynamicsRaw))
	base.InteractionCount = len(jsonArray(interactionsRaw))
	base.TaskCount = len(jsonArray(tasksRaw))
	base.CustomFieldCount = len(jsonArray(customFieldsRaw))

	dup := jsonObject(duplicateRaw)
	base.DuplicatePhoneCnt = numberFromJSON(dup["phone_duplicates"])
}

func segmentMatches(score leadAnalysisScore, segment string) bool {
	segment = strings.ToUpper(strings.TrimSpace(segment))
	if segment == "" {
		return true
	}
	for _, s := range score.Segments {
		if strings.ToUpper(s) == segment {
			return true
		}
	}
	switch segment {
	case "CALL":
		return score.Priority == "A+" || score.Priority == "A"
	case "WHATSAPP_PERSONALIZADO":
		return score.Priority == "B"
	case "DIFUSION":
		return score.Priority == "C" || score.Priority == "D"
	case "NO_PRIORIZAR":
		return score.Priority == "E"
	default:
		return false
	}
}

func (s *MCPServer) buildLeadAnalysisReport(ctx context.Context, req mcp.CallToolRequest) (map[string]any, error) {
	accountID, err := s.getAccountIDFromRequest(ctx, req)
	if err != nil {
		return nil, err
	}
	limit := intArg(req, "limit", 200, 1000)
	maxScan := intArg(req, "max_scan", 5000, 20000)
	offset, err := decodeAnalysisCursor(stringArg(req, "cursor"))
	if err != nil {
		return nil, err
	}
	segment := strings.TrimSpace(stringArg(req, "segment"))

	baseRows, total, scanLimited, err := s.fetchLeadAnalysisBase(ctx, accountID, req, maxScan)
	if err != nil {
		return nil, err
	}

	type scored struct {
		base  leadAnalysisBase
		score leadAnalysisScore
	}
	scoredRows := make([]scored, 0, len(baseRows))
	priorityCount := map[string]int{"A+": 0, "A": 0, "B": 0, "C": 0, "D": 0, "E": 0}
	segmentCount := map[string]int{}
	for _, r := range baseRows {
		sc := scoreLeadForAnalysis(r)
		priorityCount[sc.Priority]++
		for _, seg := range sc.Segments {
			segmentCount[seg]++
		}
		if segmentMatches(sc, segment) {
			scoredRows = append(scoredRows, scored{base: r, score: sc})
		}
	}
	sort.Slice(scoredRows, func(i, j int) bool {
		if scoredRows[i].score.Score != scoredRows[j].score.Score {
			return scoredRows[i].score.Score > scoredRows[j].score.Score
		}
		if scoredRows[i].score.Priority != scoredRows[j].score.Priority {
			return priorityOrder(scoredRows[i].score.Priority) < priorityOrder(scoredRows[j].score.Priority)
		}
		return scoredRows[i].base.Name < scoredRows[j].base.Name
	})

	end := offset + limit
	if end > len(scoredRows) {
		end = len(scoredRows)
	}
	page := []map[string]any{}
	if offset < len(scoredRows) {
		for _, sr := range scoredRows[offset:end] {
			page = append(page, reportRowFromBase(sr.base))
		}
	}
	nextCursor := ""
	if end < len(scoredRows) {
		nextCursor = encodeAnalysisCursor(end)
	}

	return map[string]any{
		"account_id":       accountID.String(),
		"total_matching":   total,
		"scanned":          len(baseRows),
		"scan_limited":     scanLimited,
		"segment":          segment,
		"segment_matching": len(scoredRows),
		"returned_count":   len(page),
		"has_more":         nextCursor != "",
		"next_cursor":      nextCursor,
		"priority_counts":  priorityCount,
		"segment_counts":   segmentCount,
		"leads":            page,
		"scoring_note":     "El score no infla interés por ads/redes; prioriza respuesta real, confirmación, preguntas concretas, asistencia, disculpa/obstáculo, nueva fecha y datos completos.",
	}, nil
}

func priorityOrder(p string) int {
	switch p {
	case "A+":
		return 0
	case "A":
		return 1
	case "B":
		return 2
	case "C":
		return 3
	case "D":
		return 4
	case "E":
		return 5
	default:
		return 9
	}
}

func (s *MCPServer) toolGetLeadAnalysisReport(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	report, err := s.buildLeadAnalysisReport(ctx, req)
	if err != nil {
		var coded *mcpCodedError
		if errors.As(err, &coded) {
			return mcpAccountStructuredError(err), nil
		}
		return errResult(err.Error()), nil
	}
	return jsonResult(report), nil
}

func (s *MCPServer) toolGetSegmentMembers(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	if strings.TrimSpace(stringArg(req, "segment")) == "" {
		return errResult("segment es requerido"), nil
	}
	report, err := s.buildLeadAnalysisReport(ctx, req)
	if err != nil {
		var coded *mcpCodedError
		if errors.As(err, &coded) {
			return mcpAccountStructuredError(err), nil
		}
		return errResult(err.Error()), nil
	}
	report["tool_note"] = "Segmento calculado con el mismo scoring de get_lead_analysis_report."
	return jsonResult(report), nil
}

func (s *MCPServer) toolExportLeadsForAnalysis(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	accountID, err := s.getAccountIDFromRequest(ctx, req)
	if err != nil {
		return mcpAccountStructuredError(err), nil
	}
	where, args, err := leadAnalysisWhere(req, accountID)
	if err != nil {
		return errResult(err.Error()), nil
	}
	limit := intArg(req, "limit", 500, 1000)
	offset, err := decodeAnalysisCursor(stringArg(req, "cursor"))
	if err != nil {
		return errResult(err.Error()), nil
	}

	baseFrom := ` FROM leads l LEFT JOIN contacts c ON c.id = l.contact_id LEFT JOIN pipeline_stages ps ON ps.id = l.stage_id`
	var total int
	_ = s.repos.DB().QueryRow(ctx, `SELECT COUNT(*)`+baseFrom+where, args...).Scan(&total)

	sql := `
		SELECT
			l.id::text AS lead_id,
			COALESCE(l.contact_id::text, '') AS contact_id,
			COALESCE(NULLIF(l.name, ''), NULLIF(c.custom_name, ''), NULLIF(c.name, ''), NULLIF(c.push_name, ''), '') AS name,
			COALESCE(NULLIF(l.phone, ''), NULLIF(c.phone, ''), '') AS phone,
			COALESCE(NULLIF(l.email, ''), NULLIF(c.email, ''), '') AS email,
			COALESCE(l.age, c.age) AS age,
			COALESCE(NULLIF(l.dni, ''), NULLIF(c.dni, ''), '') AS dni,
			l.created_at,
			l.updated_at,
			COALESCE(NULLIF(l.source, ''), NULLIF(c.source, ''), '') AS source,
			COALESCE(l.status, '') AS status,
			COALESCE(ps.name, '') AS stage,
			COALESCE((SELECT array_agg(DISTINCT t.name ORDER BY t.name)
				FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id
				WHERE ct.contact_id = l.contact_id AND t.account_id = l.account_id), ARRAY[]::text[]) AS tags,
			COALESCE(l.notes, '') AS lead_notes,
			COALESCE(c.notes, '') AS contact_notes,
			COALESCE(l.custom_fields, '{}'::jsonb) AS lead_custom_fields,
			COALESCE(l.is_archived, false) AS is_archived,
			COALESCE(l.is_blocked, false) AS is_blocked,
			COALESCE(l.archive_reason, '') AS archive_reason,
			COALESCE(l.block_reason, '') AS block_reason,
			COALESCE(chat_metrics.data, '{}'::jsonb) AS chat_metrics,
			COALESCE(events.data, '[]'::jsonb) AS events,
			COALESCE(programs.data, '[]'::jsonb) AS programs,
			COALESCE(campaigns.data, '[]'::jsonb) AS campaigns,
			COALESCE(surveys.data, '[]'::jsonb) AS surveys,
			COALESCE(dynamics.data, '[]'::jsonb) AS dynamics,
			COALESCE(interactions.data, '[]'::jsonb) AS interactions,
			COALESCE(tasks_data.data, '[]'::jsonb) AS tasks,
			COALESCE(custom_fields.data, '[]'::jsonb) AS custom_fields,
			COALESCE(duplicates.data, '{}'::jsonb) AS duplicate_flags
	` + baseFrom + `
		LEFT JOIN LATERAL (
			SELECT jsonb_build_object(
				'chat_count', COUNT(DISTINCT ch.id),
				'total_messages', COUNT(m.id),
				'inbound_messages', COUNT(m.id) FILTER (WHERE m.is_from_me = false),
				'outbound_messages', COUNT(m.id) FILTER (WHERE m.is_from_me = true),
				'last_inbound_at', MAX(m.timestamp) FILTER (WHERE m.is_from_me = false),
				'last_outbound_at', MAX(m.timestamp) FILTER (WHERE m.is_from_me = true),
				'last_message_at', MAX(m.timestamp)
			) AS data
			FROM chats ch LEFT JOIN messages m ON m.chat_id = ch.id
			WHERE ch.account_id = l.account_id AND ch.contact_id = l.contact_id
		) chat_metrics ON true
		LEFT JOIN LATERAL (
			SELECT jsonb_agg(jsonb_build_object(
				'event_id', e.id, 'name', e.name, 'event_date', e.event_date,
				'event_status', e.status, 'participant_status', ep.status,
				'stage', eps.name, 'notes', ep.notes, 'next_action', ep.next_action,
				'invited_at', ep.invited_at, 'confirmed_at', ep.confirmed_at, 'attended_at', ep.attended_at
			) ORDER BY e.event_date DESC NULLS LAST) AS data
			FROM event_participants ep
			JOIN events e ON e.id = ep.event_id AND e.account_id = l.account_id
			LEFT JOIN event_pipeline_stages eps ON eps.id = ep.stage_id
			WHERE ep.lead_id = l.id OR ep.contact_id = l.contact_id
		) events ON true
		LEFT JOIN LATERAL (
			SELECT jsonb_agg(jsonb_build_object(
				'program_id', p.id, 'name', p.name, 'program_status', p.status,
				'participant_status', pp.status, 'enrolled_at', pp.enrolled_at,
				'dropped_at', pp.dropped_at, 'drop_reason', pp.drop_reason,
				'completed_at', pp.completed_at
			) ORDER BY pp.enrolled_at DESC NULLS LAST) AS data
			FROM program_participants pp
			JOIN programs p ON p.id = pp.program_id AND p.account_id = l.account_id
			WHERE pp.lead_id = l.id OR pp.contact_id = l.contact_id
		) programs ON true
		LEFT JOIN LATERAL (
			SELECT jsonb_agg(jsonb_build_object(
				'campaign_id', ca.id, 'name', ca.name, 'campaign_status', ca.status,
				'recipient_status', cr.status, 'sent_at', cr.sent_at, 'error_message', cr.error_message
			) ORDER BY cr.sent_at DESC NULLS LAST) AS data
			FROM campaign_recipients cr
			JOIN campaigns ca ON ca.id = cr.campaign_id AND ca.account_id = l.account_id
			WHERE cr.contact_id = l.contact_id
			   OR (regexp_replace(COALESCE(cr.phone, ''), '\D', '', 'g') <> ''
			       AND regexp_replace(COALESCE(cr.phone, ''), '\D', '', 'g') = regexp_replace(COALESCE(l.phone, c.phone, ''), '\D', '', 'g'))
		) campaigns ON true
		LEFT JOIN LATERAL (
			SELECT jsonb_agg(jsonb_build_object(
				'survey_id', s.id, 'survey_name', s.name, 'slug', s.slug,
				'response_id', sr.id, 'source', sr.source, 'completed_at', sr.completed_at
			) ORDER BY sr.created_at DESC) AS data
			FROM survey_responses sr
			JOIN surveys s ON s.id = sr.survey_id AND s.account_id = l.account_id
			WHERE sr.lead_id = l.id
		) surveys ON true
		LEFT JOIN LATERAL (
			SELECT jsonb_agg(jsonb_build_object(
				'dynamic_id', d.id, 'dynamic_name', d.name, 'dynamic_slug', d.slug,
				'type', d.type, 'link_slug', dl.slug, 'registered_at', dlr.created_at,
				'whatsapp_status', dlr.whatsapp_status, 'shared_by_registration_id', dlr.shared_by_registration_id
			) ORDER BY dlr.created_at DESC) AS data
			FROM dynamic_link_registrations dlr
			JOIN dynamic_links dl ON dl.id = dlr.link_id
			JOIN dynamics d ON d.id = dl.dynamic_id AND d.account_id = l.account_id
			WHERE dlr.lead_id = l.id OR dlr.contact_id = l.contact_id
		) dynamics ON true
		LEFT JOIN LATERAL (
			SELECT jsonb_agg(jsonb_build_object(
				'id', i.id, 'type', i.type, 'direction', i.direction, 'outcome', i.outcome,
				'notes', i.notes, 'next_action', i.next_action, 'next_action_date', i.next_action_date,
				'created_at', i.created_at
			) ORDER BY i.created_at DESC) AS data
			FROM interactions i
			WHERE i.account_id = l.account_id AND (i.lead_id = l.id OR i.contact_id = l.contact_id)
		) interactions ON true
		LEFT JOIN LATERAL (
			SELECT jsonb_agg(jsonb_build_object(
				'id', tk.id, 'title', tk.title, 'description', tk.description, 'type', tk.type,
				'priority', tk.priority, 'status', tk.status, 'due_at', tk.due_at,
				'notes', tk.notes, 'created_at', tk.created_at
			) ORDER BY tk.created_at DESC) AS data
			FROM tasks tk
			WHERE tk.account_id = l.account_id AND (tk.lead_id = l.id OR tk.contact_id = l.contact_id)
		) tasks_data ON true
		LEFT JOIN LATERAL (
			SELECT jsonb_agg(jsonb_build_object(
				'name', cfd.name, 'slug', cfd.slug,
				'value', COALESCE(cfv.value_text, cfv.value_number::text, cfv.value_date::text, cfv.value_bool::text, cfv.value_json::text)
			) ORDER BY cfd.sort_order, cfd.name) AS data
			FROM custom_field_values cfv
			JOIN custom_field_definitions cfd ON cfd.id = cfv.field_id AND cfd.account_id = l.account_id
			WHERE cfv.contact_id = l.contact_id
		) custom_fields ON true
		LEFT JOIN LATERAL (
			SELECT jsonb_build_object(
				'phone_duplicates', COUNT(l2.id),
				'has_phone_duplicate', COUNT(l2.id) > 0
			) AS data
			FROM leads l2
			LEFT JOIN contacts c2 ON c2.id = l2.contact_id
			WHERE l2.account_id = l.account_id
			  AND l2.id <> l.id
			  AND regexp_replace(COALESCE(l2.phone, c2.phone, ''), '\D', '', 'g') <> ''
			  AND regexp_replace(COALESCE(l2.phone, c2.phone, ''), '\D', '', 'g') = regexp_replace(COALESCE(l.phone, c.phone, ''), '\D', '', 'g')
		) duplicates ON true
	` + where + fmt.Sprintf(` ORDER BY l.created_at DESC, l.id DESC LIMIT %d OFFSET %d`, limit, offset)

	rows, err := s.repos.DB().Query(ctx, sql, args...)
	if err != nil {
		return errResult("error exportando leads: " + err.Error()), nil
	}
	defer rows.Close()

	leads := make([]map[string]any, 0, limit)
	for rows.Next() {
		var leadID, contactID, name, phone, email, dni, source, status, stage, leadNotes, contactNotes, archiveReason, blockReason string
		var age *int
		var createdAt, updatedAt time.Time
		var tags []string
		var archived, blocked bool
		var leadCustom, chatMetrics, events, programs, campaigns, surveys, dynamics, interactions, tasks, customFields, duplicateFlags []byte
		if err := rows.Scan(
			&leadID, &contactID, &name, &phone, &email, &age, &dni, &createdAt, &updatedAt, &source, &status, &stage, &tags,
			&leadNotes, &contactNotes, &leadCustom, &archived, &blocked, &archiveReason, &blockReason,
			&chatMetrics, &events, &programs, &campaigns, &surveys, &dynamics, &interactions, &tasks, &customFields, &duplicateFlags,
		); err != nil {
			return errResult("error leyendo export de leads: " + err.Error()), nil
		}
		base := leadAnalysisBase{
			LeadID:       leadID,
			ContactID:    contactID,
			Name:         name,
			Phone:        phone,
			Email:        email,
			Age:          age,
			DNI:          dni,
			CreatedAt:    createdAt.Format(time.RFC3339),
			Source:       source,
			Status:       status,
			LeadNotes:    leadNotes,
			ContactNotes: contactNotes,
			Stage:        stage,
			Tags:         tags,
			IsArchived:   archived,
			IsBlocked:    blocked,
		}
		applyExportMetricsToBase(&base, chatMetrics, events, programs, campaigns, surveys, dynamics, interactions, tasks, customFields, duplicateFlags)
		score := scoreLeadForAnalysis(base)
		leads = append(leads, map[string]any{
			"lead_id":            leadID,
			"contact_id":         contactID,
			"name":               name,
			"phone":              phone,
			"email":              email,
			"age":                age,
			"dni":                dni,
			"created_at":         createdAt.Format(time.RFC3339),
			"updated_at":         updatedAt.Format(time.RFC3339),
			"source":             source,
			"status":             status,
			"stage":              stage,
			"tags":               tags,
			"lead_notes":         leadNotes,
			"contact_notes":      contactNotes,
			"lead_custom_fields": jsonRawOrEmpty(leadCustom),
			"is_archived":        archived,
			"is_blocked":         blocked,
			"archive_reason":     archiveReason,
			"block_reason":       blockReason,
			"chat_metrics":       jsonRawOrEmpty(chatMetrics),
			"events":             jsonRawOrEmpty(events),
			"programs":           jsonRawOrEmpty(programs),
			"campaigns":          jsonRawOrEmpty(campaigns),
			"surveys":            jsonRawOrEmpty(surveys),
			"dynamics":           jsonRawOrEmpty(dynamics),
			"interactions":       jsonRawOrEmpty(interactions),
			"tasks":              jsonRawOrEmpty(tasks),
			"custom_fields":      jsonRawOrEmpty(customFields),
			"duplicate_flags":    jsonRawOrEmpty(duplicateFlags),
			"analysis_score":     score,
		})
	}

	nextOffset := offset + len(leads)
	nextCursor := ""
	if nextOffset < total {
		nextCursor = encodeAnalysisCursor(nextOffset)
	}
	return jsonResult(map[string]any{
		"account_id":      accountID.String(),
		"total_estimate":  total,
		"returned_count":  len(leads),
		"offset":          offset,
		"has_more":        nextCursor != "",
		"next_cursor":     nextCursor,
		"leads":           leads,
		"pagination_note": "Llama de nuevo con next_cursor hasta que has_more=false para recorrer toda la base.",
	}), nil
}

func (s *MCPServer) toolExportMessagesForAnalysis(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	accountID, err := s.getAccountIDFromRequest(ctx, req)
	if err != nil {
		return mcpAccountStructuredError(err), nil
	}
	limit := intArg(req, "limit", 1000, 5000)
	offset, err := decodeAnalysisCursor(stringArg(req, "cursor"))
	if err != nil {
		return errResult(err.Error()), nil
	}
	where := ` WHERE m.account_id = $1 AND ch.account_id = $1`
	args := []any{accountID}
	argN := 2

	if leadIDRaw := strings.TrimSpace(stringArg(req, "lead_id")); leadIDRaw != "" {
		leadID, err := uuid.Parse(leadIDRaw)
		if err != nil {
			return errResult("lead_id inválido"), nil
		}
		where += fmt.Sprintf(` AND ch.contact_id = (SELECT contact_id FROM leads WHERE id = $%d AND account_id = $1)`, argN)
		args = append(args, leadID)
		argN++
	}
	if contactIDRaw := strings.TrimSpace(stringArg(req, "contact_id")); contactIDRaw != "" {
		contactID, err := uuid.Parse(contactIDRaw)
		if err != nil {
			return errResult("contact_id inválido"), nil
		}
		where += fmt.Sprintf(` AND ch.contact_id = $%d`, argN)
		args = append(args, contactID)
		argN++
	}
	if phone := strings.TrimSpace(stringArg(req, "phone")); phone != "" {
		where += fmt.Sprintf(` AND regexp_replace(COALESCE(c.phone, ch.jid, ''), '\D', '', 'g') ILIKE $%d`, argN)
		args = append(args, "%"+normalizePhone(phone)+"%")
		argN++
	}
	switch strings.ToLower(strings.TrimSpace(stringArg(req, "direction"))) {
	case "inbound":
		where += ` AND m.is_from_me = false`
	case "outbound":
		where += ` AND m.is_from_me = true`
	case "":
	default:
		return errResult("direction debe ser inbound, outbound o vacío"), nil
	}
	if createdAfter := strings.TrimSpace(stringArg(req, "created_after")); createdAfter != "" {
		t, err := time.Parse("2006-01-02", createdAfter)
		if err != nil {
			return errResult("created_after debe tener formato YYYY-MM-DD"), nil
		}
		where += fmt.Sprintf(` AND m.timestamp >= $%d`, argN)
		args = append(args, t)
		argN++
	}
	if createdBefore := strings.TrimSpace(stringArg(req, "created_before")); createdBefore != "" {
		t, err := time.Parse("2006-01-02", createdBefore)
		if err != nil {
			return errResult("created_before debe tener formato YYYY-MM-DD"), nil
		}
		where += fmt.Sprintf(` AND m.timestamp < $%d`, argN)
		args = append(args, t.Add(24*time.Hour))
		argN++
	}

	baseFrom := ` FROM messages m JOIN chats ch ON ch.id = m.chat_id LEFT JOIN contacts c ON c.id = ch.contact_id`
	var total int
	_ = s.repos.DB().QueryRow(ctx, `SELECT COUNT(*)`+baseFrom+where, args...).Scan(&total)

	sql := `
		SELECT
			m.id::text, ch.id::text, COALESCE(ch.contact_id::text, ''),
			COALESCE(c.custom_name, c.name, c.push_name, ch.name, '') AS contact_name,
			COALESCE(c.phone, '') AS phone,
			COALESCE((SELECT array_agg(l.id::text ORDER BY l.created_at DESC)
				FROM leads l WHERE l.account_id = $1 AND l.contact_id = ch.contact_id), ARRAY[]::text[]) AS lead_ids,
			m.message_id,
			CASE WHEN m.is_from_me THEN 'outbound' ELSE 'inbound' END AS direction,
			COALESCE(m.from_name, ''),
			COALESCE(m.body, ''),
			COALESCE(m.message_type, ''),
			COALESCE(m.status, ''),
			m.timestamp,
			COALESCE(m.provider, ''),
			COALESCE(m.template_name, ''),
			COALESCE(m.media_url, ''),
			COALESCE(m.media_mimetype, ''),
			COALESCE(m.media_filename, ''),
			COALESCE(m.quoted_body, '')
	` + baseFrom + where + fmt.Sprintf(` ORDER BY m.timestamp ASC, m.id ASC LIMIT %d OFFSET %d`, limit, offset)

	rows, err := s.repos.DB().Query(ctx, sql, args...)
	if err != nil {
		return errResult("error exportando mensajes: " + err.Error()), nil
	}
	defer rows.Close()
	messages := make([]map[string]any, 0, limit)
	for rows.Next() {
		var id, chatID, contactID, contactName, phone, messageID, direction, fromName, body, msgType, status, provider, templateName, mediaURL, mediaMime, mediaFilename, quotedBody string
		var leadIDs []string
		var ts time.Time
		if err := rows.Scan(&id, &chatID, &contactID, &contactName, &phone, &leadIDs, &messageID, &direction, &fromName, &body, &msgType, &status, &ts, &provider, &templateName, &mediaURL, &mediaMime, &mediaFilename, &quotedBody); err != nil {
			return errResult("error leyendo mensajes: " + err.Error()), nil
		}
		messages = append(messages, map[string]any{
			"message_row_id": id,
			"message_id":     messageID,
			"chat_id":        chatID,
			"contact_id":     contactID,
			"lead_ids":       leadIDs,
			"contact_name":   contactName,
			"phone":          phone,
			"direction":      direction,
			"from_name":      fromName,
			"body":           body,
			"type":           msgType,
			"status":         status,
			"timestamp":      ts.Format(time.RFC3339),
			"provider":       provider,
			"template_name":  templateName,
			"media_url":      mediaURL,
			"media_mimetype": mediaMime,
			"media_filename": mediaFilename,
			"quoted_body":    quotedBody,
		})
	}
	nextOffset := offset + len(messages)
	nextCursor := ""
	if nextOffset < total {
		nextCursor = encodeAnalysisCursor(nextOffset)
	}
	return jsonResult(map[string]any{
		"account_id":      accountID.String(),
		"total_estimate":  total,
		"returned_count":  len(messages),
		"offset":          offset,
		"has_more":        nextCursor != "",
		"next_cursor":     nextCursor,
		"messages":        messages,
		"pagination_note": "Llama de nuevo con next_cursor hasta que has_more=false para recorrer todos los mensajes filtrados.",
	}), nil
}

func decodeToolResultJSON(result *mcp.CallToolResult) (any, error) {
	if result == nil || len(result.Content) == 0 {
		return nil, errors.New("resultado vacío")
	}
	textContent, ok := result.Content[0].(mcp.TextContent)
	if !ok {
		return nil, errors.New("resultado sin contenido de texto JSON")
	}
	var decoded any
	if err := json.Unmarshal([]byte(textContent.Text), &decoded); err != nil {
		return nil, err
	}
	return decoded, nil
}

func (s *MCPServer) toolGetLeadAnalysisDetail(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	leadID := strings.TrimSpace(stringArg(req, "lead_id"))
	if leadID == "" {
		return errResult("lead_id es requerido"), nil
	}
	args := getArgs(req)
	args["lead_id"] = leadID
	args["limit"] = float64(1)
	args["cursor"] = ""
	req.Params.Arguments = args

	leadExport, err := s.toolExportLeadsForAnalysis(ctx, req)
	if err != nil || leadExport == nil || leadExport.IsError {
		return leadExport, err
	}
	leadData, err := decodeToolResultJSON(leadExport)
	if err != nil {
		return errResult("error decodificando detalle de lead: " + err.Error()), nil
	}

	msgArgs := getArgs(req)
	msgArgs["lead_id"] = leadID
	msgArgs["limit"] = float64(intArg(req, "messages_limit", 200, 1000))
	msgArgs["cursor"] = ""
	req.Params.Arguments = msgArgs
	messages, err := s.toolExportMessagesForAnalysis(ctx, req)
	if err != nil || messages == nil || messages.IsError {
		return messages, err
	}
	messageData, err := decodeToolResultJSON(messages)
	if err != nil {
		return errResult("error decodificando mensajes: " + err.Error()), nil
	}

	return jsonResult(map[string]any{
		"lead":     leadData,
		"messages": messageData,
		"note":     "Ficha profunda compuesta desde export_leads_for_analysis y export_messages_for_analysis para un lead puntual.",
	}), nil
}
