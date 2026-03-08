package api

import (
"bytes"
"context"
"encoding/json"
"fmt"
"io"
"log"
"net/http"
"strings"
"time"

"github.com/gofiber/fiber/v2"
"github.com/google/uuid"
"github.com/naperu/clarin/internal/domain"
)

// --- Request/Response Types ---

type aiChatMessage struct {
Role    string `json:"role"`
Content string `json:"content"`
}

type aiChatRequest struct {
	Message        string          `json:"message"`
	History        []aiChatMessage `json:"history"`
	CurrentPage    string          `json:"current_page"`
	ConversationID string          `json:"conversation_id"`
}

// --- CRM Context Data ---

type crmContextData struct {
TotalLeads      int
TotalContacts   int
TotalEvents     int
RecentLeads30d  int
LeadsWithWA     int
ActiveCampaigns int
ByStage         []stageCount
TopTags         []tagCount
Events          []eventSummary
Campaigns       []campaignSummary
Programs        []programSummary
RecentLeads     []recentLead
Pipelines       []pipelineSummary
}

type stageCount struct {
Stage string
Count int
}

type tagCount struct {
Tag   string
Count int
}

type eventSummary struct {
Name         string
Status       string
Date         string
Location     string
Participants int
TagFormula   string
Sessions     []eventSessionInfo
}

type eventSessionInfo struct {
Date   string
Title  string
Status string
}

type campaignSummary struct {
Name      string
Status    string
Total     int
Sent      int
Failed    int
CreatedAt string
}

type programSummary struct {
Name         string
Status       string
Participants int
Sessions     int
}

type recentLead struct {
Name      string
Stage     string
CreatedAt string
Tags      string
}

type pipelineSummary struct {
Name   string
Stages string
}

// --- Groq API Types (OpenAI-compatible) ---

type groqMessage struct {
Role       string         `json:"role"`
Content    *string        `json:"content"`
Name       string         `json:"name,omitempty"`
ToolCalls  []groqToolCall `json:"tool_calls,omitempty"`
ToolCallID string         `json:"tool_call_id,omitempty"`
}

type groqToolCall struct {
ID       string `json:"id"`
Type     string `json:"type"`
Function struct {
Name      string `json:"name"`
Arguments string `json:"arguments"`
} `json:"function"`
}

type groqTool struct {
Type     string       `json:"type"`
Function groqFunction `json:"function"`
}

type groqFunction struct {
Name        string      `json:"name"`
Description string      `json:"description"`
Parameters  interface{} `json:"parameters"`
}

type groqRequest struct {
Model       string        `json:"model"`
Messages    []groqMessage `json:"messages"`
Tools       []groqTool    `json:"tools,omitempty"`
Temperature float64       `json:"temperature"`
MaxTokens   int           `json:"max_tokens"`
}

type groqResponse struct {
Choices []struct {
Message      groqMessage `json:"message"`
FinishReason string      `json:"finish_reason"`
} `json:"choices"`
Usage *struct {
PromptTokens     int `json:"prompt_tokens"`
CompletionTokens int `json:"completion_tokens"`
TotalTokens      int `json:"total_tokens"`
} `json:"usage,omitempty"`
Error *struct {
Message string `json:"message"`
Type    string `json:"type"`
} `json:"error,omitempty"`
}

// --- Tool Definitions ---

func getToolDefinitions() []groqTool {
return []groqTool{
{
Type: "function",
Function: groqFunction{
Name:        "search_leads",
Description: "Busca leads por nombre, teléfono, email o etiqueta. Devuelve hasta 10 resultados.",
Parameters: map[string]interface{}{
"type": "object",
"properties": map[string]interface{}{
"query": map[string]interface{}{
"type":        "string",
"description": "Texto de búsqueda (nombre, teléfono, email o etiqueta)",
},
},
"required": []string{"query"},
},
},
},
{
Type: "function",
Function: groqFunction{
Name:        "get_lead_details",
Description: "Obtiene información detallada de un lead por nombre o teléfono, con etiquetas e interacciones.",
Parameters: map[string]interface{}{
"type": "object",
"properties": map[string]interface{}{
"query": map[string]interface{}{
"type":        "string",
"description": "Nombre o teléfono del lead",
},
},
"required": []string{"query"},
},
},
},
{
Type: "function",
Function: groqFunction{
Name:        "get_chat_messages",
Description: "Obtiene los últimos 20 mensajes de WhatsApp de un contacto por teléfono.",
Parameters: map[string]interface{}{
"type": "object",
"properties": map[string]interface{}{
"phone": map[string]interface{}{
"type":        "string",
"description": "Número de teléfono (ej: 993738489 o 51993738489)",
},
},
"required": []string{"phone"},
},
},
},
{
Type: "function",
Function: groqFunction{
Name:        "get_event_details",
Description: "Obtiene detalles de un evento por nombre: participantes, sesiones (logbooks), ubicación. Para detalles con participantes y mensajes WA, usa get_event_report.",
Parameters: map[string]interface{}{
"type": "object",
"properties": map[string]interface{}{
"name": map[string]interface{}{
"type":        "string",
"description": "Nombre o parte del nombre del evento",
},
},
"required": []string{"name"},
},
},
},
{
Type: "function",
Function: groqFunction{
Name:        "get_daily_activity",
Description: "Resumen de actividad de un día: mensajes, leads creados, interacciones.",
Parameters: map[string]interface{}{
"type": "object",
"properties": map[string]interface{}{
"date": map[string]interface{}{
"type":        "string",
"description": "Fecha en formato DD/MM/YYYY (ej: 06/03/2026)",
},
},
"required": []string{"date"},
},
},
},
{
Type: "function",
Function: groqFunction{
Name:        "get_campaign_details",
Description: "Detalles de una campaña de WhatsApp: envíos, fallos, destinatarios.",
Parameters: map[string]interface{}{
"type": "object",
"properties": map[string]interface{}{
"name": map[string]interface{}{
"type":        "string",
"description": "Nombre o parte del nombre de la campaña",
},
},
"required": []string{"name"},
},
},
},
{
Type: "function",
Function: groqFunction{
Name:        "get_unanswered_leads",
Description: "Leads a los que les enviamos mensaje pero NO han respondido en los últimos 7 días.",
Parameters: map[string]interface{}{
"type": "object",
"properties": map[string]interface{}{},
},
},
},
{
Type: "function",
Function: groqFunction{
Name:        "get_event_report",
Description: "Reporte de evento con LISTA DE PARTICIPANTES (nombre, teléfono, etapa, notas, tags, mensajes WA). Úsalo siempre que pidan nombres, observaciones, cuadro de participantes o datos individuales de un evento. Busca por nombre O fecha de sesión (DD/MM/YYYY).",
Parameters: map[string]interface{}{
"type": "object",
"properties": map[string]interface{}{
"event_name": map[string]interface{}{
"type":        "string",
"description": "Nombre o parte del nombre del evento (puede ser vacío si se busca solo por fecha)",
},
"date": map[string]interface{}{
"type":        "string",
"description": "Fecha de sesión en formato DD/MM/YYYY. Busca eventos que tengan una sesión (logbook) en esta fecha. Usar para 'evento de mañana', 'evento del viernes', etc.",
},
},
},
},
},
		{
			Type: "function",
			Function: groqFunction{
				Name:        "search_chat_messages",
				Description: "Busca un texto en TODOS los chats de WhatsApp. Devuelve los contactos/leads cuyos mensajes contienen el texto buscado, con snippet del mensaje. Úsalo cuando pidan buscar un nombre, palabra o frase en los chats.",
				Parameters: map[string]interface{}{
					"type": "object",
					"properties": map[string]interface{}{
						"query": map[string]interface{}{
							"type":        "string",
							"description": "Texto a buscar en los mensajes (nombre, palabra clave, frase)",
						},
					},
					"required": []string{"query"},
				},
			},
		},
	}
}

// --- Tool Execution ---

func (s *Server) executeTool(ctx context.Context, toolName string, args map[string]interface{}, accountID string) (interface{}, error) {
	switch toolName {
	case "search_leads":
		return s.toolSearchLeads(ctx, args, accountID)
	case "search_chat_messages":
		return s.toolSearchChatMessages(ctx, args, accountID)
	case "get_lead_details":
return s.toolGetLeadDetails(ctx, args, accountID)
case "get_chat_messages":
return s.toolGetChatMessages(ctx, args, accountID)
case "get_event_details":
return s.toolGetEventDetails(ctx, args, accountID)
case "get_daily_activity":
return s.toolGetDailyActivity(ctx, args, accountID)
case "get_campaign_details":
return s.toolGetCampaignDetails(ctx, args, accountID)
case "get_unanswered_leads":
return s.toolGetUnansweredLeads(ctx, args, accountID)
case "get_event_report":
return s.toolGetEventReport(ctx, args, accountID)
default:
return nil, fmt.Errorf("unknown tool: %s", toolName)
}
}

func (s *Server) toolSearchLeads(ctx context.Context, args map[string]interface{}, accountID string) (interface{}, error) {
query := getStringArg(args, "query")
limit := getIntArg(args, "limit", 10)
if limit > 50 {
limit = 50
}

rows, err := s.repos.DB().Query(ctx, `
SELECT l.name, COALESCE(l.phone, ''), COALESCE(l.email, ''),
COALESCE(ps.name, 'Sin etapa'),
TO_CHAR(l.created_at, 'DD/MM/YYYY'),
COALESCE((SELECT STRING_AGG(t.name, ', ' ORDER BY t.name)
FROM lead_tags lt JOIN tags t ON t.id = lt.tag_id WHERE lt.lead_id = l.id), '')
FROM leads l
LEFT JOIN pipeline_stages ps ON ps.id = l.stage_id
WHERE l.account_id = $1
AND (l.name ILIKE '%' || $2 || '%'
OR l.phone ILIKE '%' || $2 || '%'
OR l.email ILIKE '%' || $2 || '%'
OR EXISTS (SELECT 1 FROM lead_tags lt2 JOIN tags t2 ON t2.id = lt2.tag_id
WHERE lt2.lead_id = l.id AND t2.name ILIKE '%' || $2 || '%'))
ORDER BY l.created_at DESC
LIMIT $3
`, accountID, query, limit)
if err != nil {
return nil, err
}
defer rows.Close()

var leads []map[string]interface{}
for rows.Next() {
var name, phone, email, stage, created, tags string
if err := rows.Scan(&name, &phone, &email, &stage, &created, &tags); err == nil {
leads = append(leads, map[string]interface{}{
"name": name, "phone": phone, "email": email,
"stage": stage, "created": created, "tags": tags,
})
}
}
return map[string]interface{}{"total": len(leads), "leads": leads}, nil
}

func (s *Server) toolGetLeadDetails(ctx context.Context, args map[string]interface{}, accountID string) (interface{}, error) {
query := getStringArg(args, "query")

row := s.repos.DB().QueryRow(ctx, `
SELECT l.id, l.name, COALESCE(l.phone, ''), COALESCE(l.email, ''),
COALESCE(ps.name, 'Sin etapa'),
TO_CHAR(l.created_at, 'DD/MM/YYYY'),
COALESCE((SELECT STRING_AGG(t.name, ', ' ORDER BY t.name)
FROM lead_tags lt JOIN tags t ON t.id = lt.tag_id WHERE lt.lead_id = l.id), '')
FROM leads l
LEFT JOIN pipeline_stages ps ON ps.id = l.stage_id
WHERE l.account_id = $1
AND (l.name ILIKE '%' || $2 || '%' OR l.phone ILIKE '%' || $2 || '%')
ORDER BY l.created_at DESC
LIMIT 1
`, accountID, query)

var id, name, phone, email, stage, created, tags string
if err := row.Scan(&id, &name, &phone, &email, &stage, &created, &tags); err != nil {
return map[string]interface{}{"error": "Lead no encontrado"}, nil
}

intRows, err := s.repos.DB().Query(ctx, `
SELECT i.type, COALESCE(i.notes, ''), TO_CHAR(i.created_at, 'DD/MM/YYYY HH24:MI')
FROM interactions i WHERE i.lead_id = $1
ORDER BY i.created_at DESC LIMIT 10
`, id)
var interactions []map[string]string
if err == nil {
defer intRows.Close()
for intRows.Next() {
var itype, notes, date string
if intRows.Scan(&itype, &notes, &date) == nil {
interactions = append(interactions, map[string]string{
"type": itype, "notes": notes, "date": date,
})
}
}
}

return map[string]interface{}{
"name": name, "phone": phone, "email": email,
"stage": stage, "created": created, "tags": tags,
"interactions": interactions,
}, nil
}

func (s *Server) toolGetChatMessages(ctx context.Context, args map[string]interface{}, accountID string) (interface{}, error) {
phone := getStringArg(args, "phone")
limit := getIntArg(args, "limit", 20)
if limit > 100 {
limit = 100
}

phone = strings.TrimSpace(phone)
if len(phone) == 9 && phone[0] == '9' {
phone = "51" + phone
}

rows, err := s.repos.DB().Query(ctx, `
SELECT COALESCE(m.from_jid, ''), COALESCE(m.body, ''), m.is_from_me,
TO_CHAR(m.timestamp, 'DD/MM/YYYY HH24:MI')
FROM messages m
JOIN chats ch ON ch.id = m.chat_id
WHERE ch.account_id = $1 AND ch.jid LIKE $2 || '%'
ORDER BY m.timestamp DESC
LIMIT $3
`, accountID, phone, limit)
if err != nil {
return nil, err
}
defer rows.Close()

var msgs []map[string]interface{}
for rows.Next() {
var sender, body, date string
var fromMe bool
if rows.Scan(&sender, &body, &fromMe, &date) == nil {
direction := "recibido"
if fromMe {
direction = "enviado"
}
msgs = append(msgs, map[string]interface{}{
"direction": direction, "body": body, "date": date,
})
}
}
return map[string]interface{}{"total": len(msgs), "messages": msgs}, nil
}

func (s *Server) toolSearchChatMessages(ctx context.Context, args map[string]interface{}, accountID string) (interface{}, error) {
	query := getStringArg(args, "query")
	if query == "" {
		return map[string]interface{}{"error": "Se requiere un texto de búsqueda"}, nil
	}

	rows, err := s.repos.DB().Query(ctx, `
		SELECT
			COALESCE(ct.name, ct.jid, ch.jid) AS contact_name,
			COALESCE(ct.phone, REPLACE(SPLIT_PART(ch.jid, '@', 1), '+', '')) AS phone,
			m.body,
			m.is_from_me,
			TO_CHAR(m.timestamp, 'DD/MM/YYYY HH24:MI') AS date
		FROM messages m
		JOIN chats ch ON ch.id = m.chat_id
		LEFT JOIN contacts ct ON ct.id = ch.contact_id
		WHERE ch.account_id = $1
			AND m.body ILIKE '%' || $2 || '%'
			AND m.body IS NOT NULL AND m.body != ''
		ORDER BY m.timestamp DESC
		LIMIT 25
	`, accountID, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	type matchResult struct {
		Contact   string `json:"contact"`
		Phone     string `json:"phone"`
		Snippet   string `json:"snippet"`
		Direction string `json:"direction"`
		Date      string `json:"date"`
	}

	var results []matchResult
	for rows.Next() {
		var contact, phone, body, date string
		var fromMe bool
		if rows.Scan(&contact, &phone, &body, &fromMe, &date) == nil {
			// Truncate body to ~150 chars for snippet
			snippet := body
			if len(snippet) > 150 {
				snippet = snippet[:150] + "..."
			}
			direction := "recibido"
			if fromMe {
				direction = "enviado"
			}
			results = append(results, matchResult{
				Contact: contact, Phone: phone, Snippet: snippet,
				Direction: direction, Date: date,
			})
		}
	}

	return map[string]interface{}{"total": len(results), "query": query, "matches": results}, nil
}

func (s *Server) toolGetEventDetails(ctx context.Context, args map[string]interface{}, accountID string) (interface{}, error) {
name := getStringArg(args, "name")

row := s.repos.DB().QueryRow(ctx, `
SELECT e.id, e.name, e.status,
COALESCE(TO_CHAR(e.event_date, 'DD/MM/YYYY'), 'Sin fecha'),
COALESCE(e.location, 'Sin ubicación'),
COALESCE(e.tag_formula, ''),
(SELECT COUNT(*) FROM event_participants ep WHERE ep.event_id = e.id)
FROM events e
WHERE e.account_id = $1 AND e.name ILIKE '%' || $2 || '%'
ORDER BY e.created_at DESC LIMIT 1
`, accountID, name)

var eid, ename, status, date, location, formula string
var participants int
if err := row.Scan(&eid, &ename, &status, &date, &location, &formula, &participants); err != nil {
return map[string]interface{}{"error": "Evento no encontrado"}, nil
}

// Include logbook sessions
var sessions []map[string]interface{}
sessRows, err := s.repos.DB().Query(ctx, `
SELECT lb.title, TO_CHAR(lb.date, 'DD/MM/YYYY'), lb.status, lb.total_participants
FROM event_logbooks lb WHERE lb.event_id = $1 ORDER BY lb.date ASC
`, eid)
if err == nil {
defer sessRows.Close()
for sessRows.Next() {
var title, sdate, st string
var tp int
if sessRows.Scan(&title, &sdate, &st, &tp) == nil {
sessions = append(sessions, map[string]interface{}{
"title": title, "date": sdate, "status": st, "participants": tp,
})
}
}
}

// Participants by stage
var stages []map[string]interface{}
stRows, err := s.repos.DB().Query(ctx, `
SELECT COALESCE(eps.name, 'Sin etapa'), COUNT(ep.id)
FROM event_participants ep
LEFT JOIN event_pipeline_stages eps ON eps.id = ep.stage_id
WHERE ep.event_id = $1 GROUP BY eps.name ORDER BY COUNT(ep.id) DESC
`, eid)
if err == nil {
defer stRows.Close()
for stRows.Next() {
var sname string
var cnt int
if stRows.Scan(&sname, &cnt) == nil {
stages = append(stages, map[string]interface{}{"stage": sname, "count": cnt})
}
}
}

return map[string]interface{}{
"name": ename, "status": status, "date": date,
"location": location, "tag_formula": formula, "participants": participants,
"sessions": sessions, "participants_by_stage": stages,
}, nil
}

func (s *Server) toolGetDailyActivity(ctx context.Context, args map[string]interface{}, accountID string) (interface{}, error) {
dateStr := getStringArg(args, "date")
t, err := time.Parse("02/01/2006", dateStr)
if err != nil {
return map[string]interface{}{"error": "Fecha inválida, usa DD/MM/YYYY"}, nil
}
dayStart := t.Format("2006-01-02")
dayEnd := t.AddDate(0, 0, 1).Format("2006-01-02")

db := s.repos.DB()
result := map[string]interface{}{"date": dateStr}

var msgsSent, msgsRecv, leadsCreated, interactionsCount int
db.QueryRow(ctx, `SELECT COUNT(*) FROM messages m JOIN chats c ON c.id = m.chat_id WHERE c.account_id = $1 AND m.is_from_me = true AND m.timestamp >= $2 AND m.timestamp < $3`, accountID, dayStart, dayEnd).Scan(&msgsSent)
db.QueryRow(ctx, `SELECT COUNT(*) FROM messages m JOIN chats c ON c.id = m.chat_id WHERE c.account_id = $1 AND m.is_from_me = false AND m.timestamp >= $2 AND m.timestamp < $3`, accountID, dayStart, dayEnd).Scan(&msgsRecv)
db.QueryRow(ctx, `SELECT COUNT(*) FROM leads WHERE account_id = $1 AND created_at >= $2 AND created_at < $3`, accountID, dayStart, dayEnd).Scan(&leadsCreated)
db.QueryRow(ctx, `SELECT COUNT(*) FROM interactions i JOIN leads l ON l.id = i.lead_id WHERE l.account_id = $1 AND i.created_at >= $2 AND i.created_at < $3`, accountID, dayStart, dayEnd).Scan(&interactionsCount)

result["messages_sent"] = msgsSent
result["messages_received"] = msgsRecv
result["leads_created"] = leadsCreated
result["interactions"] = interactionsCount

return result, nil
}

func (s *Server) toolGetCampaignDetails(ctx context.Context, args map[string]interface{}, accountID string) (interface{}, error) {
name := getStringArg(args, "name")

row := s.repos.DB().QueryRow(ctx, `
SELECT c.name, c.status, c.total_recipients, c.sent_count, c.failed_count,
COALESCE(c.template_message, ''),
TO_CHAR(c.created_at, 'DD/MM/YYYY HH24:MI')
FROM campaigns c
WHERE c.account_id = $1 AND c.name ILIKE '%' || $2 || '%'
ORDER BY c.created_at DESC LIMIT 1
`, accountID, name)

var cname, status, template, created string
var total, sent, failed int
if err := row.Scan(&cname, &status, &total, &sent, &failed, &template, &created); err != nil {
return map[string]interface{}{"error": "Campaña no encontrada"}, nil
}

pct := 0
if total > 0 {
pct = sent * 100 / total
}
return map[string]interface{}{
"name": cname, "status": status, "total": total,
"sent": sent, "failed": failed, "success_rate": fmt.Sprintf("%d%%", pct),
"template": template, "created": created,
}, nil
}

func (s *Server) toolGetUnansweredLeads(ctx context.Context, args map[string]interface{}, accountID string) (interface{}, error) {
daysBack := getIntArg(args, "days_back", 7)
limit := getIntArg(args, "limit", 30)
if limit > 100 {
limit = 100
}

rows, err := s.repos.DB().Query(ctx, `
SELECT DISTINCT l.name, COALESCE(l.phone, ''),
COALESCE(ps.name, 'Sin etapa'),
TO_CHAR(l.created_at, 'DD/MM/YYYY')
FROM leads l
LEFT JOIN pipeline_stages ps ON ps.id = l.stage_id
JOIN contacts c ON c.phone = l.phone AND c.account_id = $1
JOIN chats ch ON ch.jid = c.jid AND ch.account_id = $1
WHERE l.account_id = $1
AND EXISTS (
SELECT 1 FROM messages m WHERE m.chat_id = ch.id AND m.is_from_me = true
AND m.timestamp >= NOW() - ($2 || ' days')::interval
)
AND NOT EXISTS (
SELECT 1 FROM messages m2 WHERE m2.chat_id = ch.id AND m2.is_from_me = false
AND m2.timestamp >= NOW() - ($2 || ' days')::interval
)
ORDER BY l.created_at DESC
LIMIT $3
`, accountID, daysBack, limit)
if err != nil {
return nil, err
}
defer rows.Close()

var leads []map[string]string
for rows.Next() {
var name, phone, stage, created string
if rows.Scan(&name, &phone, &stage, &created) == nil {
leads = append(leads, map[string]string{
"name": name, "phone": phone, "stage": stage, "created": created,
})
}
}
return map[string]interface{}{"total": len(leads), "leads": leads}, nil
}

func (s *Server) toolGetEventReport(ctx context.Context, args map[string]interface{}, accountID string) (interface{}, error) {
eventName := getStringArg(args, "event_name")
dateStr := getStringArg(args, "date")

db := s.repos.DB()

var eid, ename, status, edate, location, formula string
var sessionTitle, sessionStatus string
found := false

// Strategy 1: Search by logbook date (for "evento de mañana" type queries)
if dateStr != "" {
t, err := time.Parse("02/01/2006", dateStr)
if err == nil {
dateFormatted := t.Format("2006-01-02")
var searchQuery string
var searchArgs []interface{}
if eventName != "" {
searchQuery = `
SELECT e.id, e.name, e.status, COALESCE(TO_CHAR(e.event_date, 'DD/MM/YYYY'), 'Sin fecha'),
COALESCE(e.location, ''), COALESCE(e.tag_formula, ''),
COALESCE(lb.title, ''), COALESCE(lb.status, '')
FROM events e
JOIN event_logbooks lb ON lb.event_id = e.id AND lb.date = $3
WHERE e.account_id = $1 AND e.name ILIKE '%' || $2 || '%'
LIMIT 1`
searchArgs = []interface{}{accountID, eventName, dateFormatted}
} else {
searchQuery = `
SELECT e.id, e.name, e.status, COALESCE(TO_CHAR(e.event_date, 'DD/MM/YYYY'), 'Sin fecha'),
COALESCE(e.location, ''), COALESCE(e.tag_formula, ''),
COALESCE(lb.title, ''), COALESCE(lb.status, '')
FROM events e
JOIN event_logbooks lb ON lb.event_id = e.id AND lb.date = $2
WHERE e.account_id = $1 AND e.status = 'active'
LIMIT 1`
searchArgs = []interface{}{accountID, dateFormatted}
}
if err := db.QueryRow(ctx, searchQuery, searchArgs...).Scan(&eid, &ename, &status, &edate, &location, &formula, &sessionTitle, &sessionStatus); err == nil {
found = true
}
}
}

// Strategy 2: Fallback to name search
if !found && eventName != "" {
query := `
SELECT e.id, e.name, e.status, COALESCE(TO_CHAR(e.event_date, 'DD/MM/YYYY'), 'Sin fecha'),
COALESCE(e.location, ''), COALESCE(e.tag_formula, '')
FROM events e
WHERE e.account_id = $1 AND e.name ILIKE '%' || $2 || '%'
ORDER BY e.created_at DESC LIMIT 1`
if err := db.QueryRow(ctx, query, accountID, eventName).Scan(&eid, &ename, &status, &edate, &location, &formula); err != nil {
return map[string]interface{}{"error": "Evento no encontrado"}, nil
}
found = true
}

if !found {
return map[string]interface{}{"error": "Evento no encontrado. Especifica nombre o fecha de sesión."}, nil
}

// Get all logbook sessions for context
var sessions []map[string]interface{}
sessRows, err := db.Query(ctx, `
SELECT lb.title, TO_CHAR(lb.date, 'DD/MM/YYYY'), lb.status, lb.total_participants,
COALESCE(lb.general_notes, '')
FROM event_logbooks lb
WHERE lb.event_id = $1
ORDER BY lb.date ASC
`, eid)
if err == nil {
defer sessRows.Close()
for sessRows.Next() {
var title, date, st, notes string
var totalP int
if sessRows.Scan(&title, &date, &st, &totalP, &notes) == nil {
sessions = append(sessions, map[string]interface{}{
"title": title, "date": date, "status": st,
"total_participants": totalP, "general_notes": notes,
})
}
}
}

// Get participants with stage info and tags
pRows, err := db.Query(ctx, `
SELECT ep.id, COALESCE(ep.name, ''), COALESCE(ep.phone, ''),
COALESCE(eps.name, 'Sin etapa'), COALESCE(eps.color, '#6b7280'),
COALESCE(ep.notes, ''),
COALESCE((
SELECT string_agg(t.name, ', ')
FROM lead_tags lt JOIN tags t ON t.id = lt.tag_id
WHERE lt.lead_id = ep.lead_id
), '')
FROM event_participants ep
LEFT JOIN event_pipeline_stages eps ON eps.id = ep.stage_id
WHERE ep.event_id = $1
ORDER BY eps.position, ep.name
LIMIT 50
`, eid)
if err != nil {
return map[string]interface{}{"error": fmt.Sprintf("Error consultando participantes: %v", err)}, nil
}
defer pRows.Close()

var participants []map[string]interface{}
var phones []string
for pRows.Next() {
var pid, pname, phone, stageName, stageColor, notes, tags string
if pRows.Scan(&pid, &pname, &phone, &stageName, &stageColor, &notes, &tags) == nil {
p := map[string]interface{}{
"name": pname, "phone": phone, "stage": stageName,
"stage_color": stageColor, "notes": notes, "tags": tags,
}
participants = append(participants, p)
if phone != "" {
phones = append(phones, phone)
}
}
}

// Get logbook entries for this event (latest logbook)
logbookEntries := make(map[string]string)
lbRows, err := db.Query(ctx, `
SELECT COALESCE(ep.phone, ''), COALESCE(le.notes, '')
FROM event_logbook_entries le
JOIN event_logbooks lb ON lb.id = le.logbook_id
JOIN event_participants ep ON ep.id = le.participant_id
WHERE lb.event_id = $1
ORDER BY lb.date DESC
`, eid)
if err == nil {
defer lbRows.Close()
for lbRows.Next() {
var phone, notes string
if lbRows.Scan(&phone, &notes) == nil && notes != "" {
if _, exists := logbookEntries[phone]; !exists {
logbookEntries[phone] = notes
}
}
}
}

// Get last 3 WhatsApp messages per participant (limit to first 15 with phones)
phonesToCheck := phones
if len(phonesToCheck) > 5 {
phonesToCheck = phonesToCheck[:5]
}
waMessages := make(map[string][]map[string]string)
for _, phone := range phonesToCheck {
mRows, err := db.Query(ctx, `
SELECT COALESCE(m.body, ''), m.is_from_me, TO_CHAR(m.timestamp, 'DD/MM HH24:MI')
FROM messages m
JOIN chats ch ON ch.id = m.chat_id
WHERE ch.account_id = $1 AND ch.jid LIKE $2 || '%'
ORDER BY m.timestamp DESC LIMIT 3
`, accountID, phone)
if err != nil {
continue
}
var msgs []map[string]string
for mRows.Next() {
var body, date string
var fromMe bool
if mRows.Scan(&body, &fromMe, &date) == nil && body != "" {
dir := "recibido"
if fromMe {
dir = "enviado"
}
msgs = append(msgs, map[string]string{"body": body, "direction": dir, "date": date})
}
}
mRows.Close()
if len(msgs) > 0 {
waMessages[phone] = msgs
}
}

// Enrich participants with logbook notes and WA messages
for i, p := range participants {
phone, _ := p["phone"].(string)
if notes, ok := logbookEntries[phone]; ok {
participants[i]["logbook_notes"] = notes
}
if msgs, ok := waMessages[phone]; ok {
participants[i]["recent_wa_messages"] = msgs
}
}

result := map[string]interface{}{
"event_name":   ename,
"status":       status,
"date":         edate,
"location":     location,
"tag_formula":  formula,
"total":        len(participants),
"participants": participants,
"sessions":     sessions,
}
if sessionTitle != "" {
result["target_session"] = map[string]string{
"title": sessionTitle, "status": sessionStatus, "date": dateStr,
}
}
return result, nil
}

// --- Arg helpers ---

func getStringArg(args map[string]interface{}, key string) string {
if v, ok := args[key]; ok {
if s, ok := v.(string); ok {
return s
}
}
return ""
}

func getIntArg(args map[string]interface{}, key string, defaultVal int) int {
if v, ok := args[key]; ok {
switch n := v.(type) {
case float64:
return int(n)
case int:
return n
case string:
var i int
if _, err := fmt.Sscanf(n, "%d", &i); err == nil {
return i
}
}
}
return defaultVal
}

// --- CRM Context Builder ---

func (s *Server) buildCRMContext(ctx context.Context, accountID string) (*crmContextData, error) {
cacheKey := fmt.Sprintf("ai_context:%s", accountID)

if s.cache != nil {
if cached, err := s.cache.Get(ctx, cacheKey); err == nil && len(cached) > 0 {
var data crmContextData
if err := json.Unmarshal(cached, &data); err == nil {
return &data, nil
}
}
}

data := &crmContextData{}
db := s.repos.DB()

row := db.QueryRow(ctx, `
SELECT
(SELECT COUNT(*) FROM leads WHERE account_id = $1),
(SELECT COUNT(*) FROM contacts WHERE account_id = $1),
(SELECT COUNT(*) FROM events WHERE account_id = $1),
(SELECT COUNT(*) FROM leads WHERE account_id = $1 AND created_at >= NOW() - INTERVAL '30 days'),
(SELECT COUNT(DISTINCT l.id) FROM leads l
 JOIN contacts c ON c.phone = l.phone AND c.account_id = $1
 WHERE l.account_id = $1 AND c.id IS NOT NULL)
`, accountID)
if err := row.Scan(
&data.TotalLeads, &data.TotalContacts, &data.TotalEvents,
&data.RecentLeads30d, &data.LeadsWithWA,
); err != nil {
log.Printf("[AI] error scanning totals: %v", err)
}

db.QueryRow(ctx, `SELECT COUNT(*) FROM campaigns WHERE account_id = $1 AND status = 'running'`, accountID).
Scan(&data.ActiveCampaigns)

rows, err := db.Query(ctx, `
SELECT ps.name, COUNT(l.id) as cnt
FROM leads l
JOIN pipeline_stages ps ON ps.id = l.stage_id
WHERE l.account_id = $1
GROUP BY ps.name
ORDER BY cnt DESC
LIMIT 5
`, accountID)
if err == nil {
defer rows.Close()
for rows.Next() {
var sc stageCount
if err := rows.Scan(&sc.Stage, &sc.Count); err == nil {
data.ByStage = append(data.ByStage, sc)
}
}
}

tagRows, err := db.Query(ctx, `
SELECT t.name, COUNT(lt.lead_id) as cnt
FROM tags t
JOIN lead_tags lt ON lt.tag_id = t.id
JOIN leads l ON l.id = lt.lead_id AND l.account_id = $1
WHERE t.account_id = $1
GROUP BY t.name
ORDER BY cnt DESC
LIMIT 5
`, accountID)
if err == nil {
defer tagRows.Close()
for tagRows.Next() {
var tc tagCount
if err := tagRows.Scan(&tc.Tag, &tc.Count); err == nil {
data.TopTags = append(data.TopTags, tc)
}
}
}

eventRows, err := db.Query(ctx, `
SELECT e.id, e.name, e.status,
COALESCE(TO_CHAR(e.event_date, 'DD/MM/YYYY'), 'Sin fecha'),
COALESCE(e.location, 'Sin ubicación'),
(SELECT COUNT(*) FROM event_participants ep WHERE ep.event_id = e.id),
COALESCE(e.tag_formula, '')
FROM events e
WHERE e.account_id = $1 AND e.status = 'active'
ORDER BY COALESCE(e.event_date, e.created_at) DESC
LIMIT 3
`, accountID)
if err == nil {
defer eventRows.Close()
for eventRows.Next() {
var eid string
var ev eventSummary
if err := eventRows.Scan(&eid, &ev.Name, &ev.Status, &ev.Date, &ev.Location, &ev.Participants, &ev.TagFormula); err == nil {
// Fetch logbook sessions for this event
sessRows, serr := db.Query(ctx, `
SELECT TO_CHAR(lb.date, 'DD/MM/YYYY'), lb.title, lb.status
FROM event_logbooks lb
WHERE lb.event_id = $1
ORDER BY lb.date ASC
`, eid)
if serr == nil {
for sessRows.Next() {
var si eventSessionInfo
if sessRows.Scan(&si.Date, &si.Title, &si.Status) == nil {
ev.Sessions = append(ev.Sessions, si)
}
}
sessRows.Close()
}
data.Events = append(data.Events, ev)
}
}
}

campRows, err := db.Query(ctx, `
SELECT name, status, total_recipients, sent_count, failed_count,
TO_CHAR(created_at, 'DD/MM/YYYY')
FROM campaigns
WHERE account_id = $1
ORDER BY created_at DESC
LIMIT 3
`, accountID)
if err == nil {
defer campRows.Close()
for campRows.Next() {
var c campaignSummary
if err := campRows.Scan(&c.Name, &c.Status, &c.Total, &c.Sent, &c.Failed, &c.CreatedAt); err == nil {
data.Campaigns = append(data.Campaigns, c)
}
}
}

progRows, err := db.Query(ctx, `
SELECT p.name, p.status,
(SELECT COUNT(*) FROM program_participants pp WHERE pp.program_id = p.id),
(SELECT COUNT(*) FROM program_sessions ps WHERE ps.program_id = p.id)
FROM programs p
WHERE p.account_id = $1
ORDER BY p.created_at DESC
LIMIT 3
`, accountID)
if err == nil {
defer progRows.Close()
for progRows.Next() {
var pr programSummary
if err := progRows.Scan(&pr.Name, &pr.Status, &pr.Participants, &pr.Sessions); err == nil {
data.Programs = append(data.Programs, pr)
}
}
}

pipeRows, err := db.Query(ctx, `
SELECT p.name,
COALESCE((
SELECT STRING_AGG(ps.name, ' → ' ORDER BY ps.position)
FROM pipeline_stages ps WHERE ps.pipeline_id = p.id
), '')
FROM pipelines p
WHERE p.account_id = $1
ORDER BY p.created_at
LIMIT 3
`, accountID)
if err == nil {
defer pipeRows.Close()
for pipeRows.Next() {
var pl pipelineSummary
if err := pipeRows.Scan(&pl.Name, &pl.Stages); err == nil {
data.Pipelines = append(data.Pipelines, pl)
}
}
}

if s.cache != nil {
if b, err := json.Marshal(data); err == nil {
_ = s.cache.Set(ctx, cacheKey, b, 5*time.Minute)
}
}
return data, nil
}

// --- System Prompt Builder ---

func buildSystemPrompt(crm *crmContextData, currentPage string) string {
var sb strings.Builder

currentDate := time.Now().Format("02/01/2006")
sb.WriteString(fmt.Sprintf("Eres Eros, gato blanco asistente de Clarin CRM. Fecha: %s. Español peruano, conciso, amigable, con emojis 🎯📊🐱. No inventes datos.\n\n", currentDate))

sb.WriteString("=== DATOS DEL CRM ===\n")
sb.WriteString(fmt.Sprintf("• Leads totales: %d | Contactos WhatsApp: %d | Eventos: %d\n", crm.TotalLeads, crm.TotalContacts, crm.TotalEvents))
sb.WriteString(fmt.Sprintf("• Leads nuevos (30 días): %d | Con WhatsApp: %d | Campañas activas: %d\n", crm.RecentLeads30d, crm.LeadsWithWA, crm.ActiveCampaigns))

if len(crm.ByStage) > 0 {
sb.WriteString("\nLeads por etapa: ")
parts := make([]string, 0, len(crm.ByStage))
for _, s := range crm.ByStage {
parts = append(parts, fmt.Sprintf("%s(%d)", s.Stage, s.Count))
}
sb.WriteString(strings.Join(parts, ", "))
sb.WriteString("\n")
}

if len(crm.TopTags) > 0 {
sb.WriteString("Tags más usadas: ")
parts := make([]string, 0, len(crm.TopTags))
for _, t := range crm.TopTags {
parts = append(parts, fmt.Sprintf("%s(%d)", t.Tag, t.Count))
}
sb.WriteString(strings.Join(parts, ", "))
sb.WriteString("\n")
}

if len(crm.Events) > 0 {
sb.WriteString("\nEventos recientes:\n")
for _, e := range crm.Events {
sb.WriteString(fmt.Sprintf("  • %s | %s | %s | %d participantes\n", e.Name, e.Status, e.Date, e.Participants))
if len(e.Sessions) > 0 {
for _, sess := range e.Sessions {
sb.WriteString(fmt.Sprintf("    → Sesión %s: \"%s\" (%s)\n", sess.Date, sess.Title, sess.Status))
}
}
}
}

if len(crm.Campaigns) > 0 {
sb.WriteString("\nCampañas recientes:\n")
for _, c := range crm.Campaigns {
pct := 0
if c.Total > 0 {
pct = c.Sent * 100 / c.Total
}
sb.WriteString(fmt.Sprintf("  • %s | %s | %d/%d enviados (%d%%)\n", c.Name, c.Status, c.Sent, c.Total, pct))
}
}

if len(crm.Programs) > 0 {
sb.WriteString("\nProgramas:\n")
for _, p := range crm.Programs {
sb.WriteString(fmt.Sprintf("  • %s | %s | %d participantes\n", p.Name, p.Status, p.Participants))
}
}

if len(crm.Pipelines) > 0 {
sb.WriteString("\nPipelines: ")
parts := make([]string, 0, len(crm.Pipelines))
for _, p := range crm.Pipelines {
parts = append(parts, fmt.Sprintf("%s [%s]", p.Name, p.Stages))
}
sb.WriteString(strings.Join(parts, " | "))
sb.WriteString("\n")
}

if currentPage != "" {
sb.WriteString(fmt.Sprintf("\nEl usuario está en la página: %s\n", currentPage))
}

sb.WriteString("\nINSTRUCCIONES: Usa herramientas para datos específicos. Saludos: responde como gato juguetón sin herramientas. Emojis siempre 😸🎯📈. Tablas: markdown. Eventos tienen SESIONES con fechas; para 'evento de mañana' usa get_event_report(date=DD/MM/YYYY). get_event_report devuelve NOMBRE, TELÉFONO, ETAPA, NOTAS y TAGS de cada participante — si piden nombres, cuadro de participantes u observaciones, USA get_event_report. search_chat_messages busca texto en TODOS los chats — úsalo cuando pidan buscar un nombre, palabra o frase en conversaciones de WhatsApp. Copywriting WA: corto, persuasivo, emojis, <300 chars.\n")

return sb.String()
}

// --- Groq API Call ---

func sendGroqRequest(ctx context.Context, apiKey string, messages []groqMessage, tools []groqTool) (*groqResponse, error) {
	maxTok := 768 // follow-up: synthesize response from tool results
	if tools != nil {
		maxTok = 768 // first call with tools: needs room for tool selection + possible direct answer
	}
	reqBody := groqRequest{
		Model:       "meta-llama/llama-4-scout-17b-16e-instruct",
		Messages:    messages,
		Tools:       tools,
		Temperature: 0.7,
		MaxTokens:   maxTok,
	}

	bodyBytes, err := json.Marshal(reqBody)
if err != nil {
return nil, fmt.Errorf("marshal groq request: %w", err)
}

// Retry up to 2 times on rate limit (429)
for attempt := 0; attempt < 2; attempt++ {
httpCtx, cancel := context.WithTimeout(ctx, 30*time.Second)

req, err := http.NewRequestWithContext(httpCtx, http.MethodPost, "https://api.groq.com/openai/v1/chat/completions", bytes.NewReader(bodyBytes))
if err != nil {
cancel()
return nil, fmt.Errorf("create groq request: %w", err)
}
req.Header.Set("Content-Type", "application/json")
req.Header.Set("Authorization", "Bearer "+apiKey)

resp, err := (&http.Client{}).Do(req)
if err != nil {
cancel()
return nil, fmt.Errorf("groq request: %w", err)
}

respBytes, err := io.ReadAll(resp.Body)
resp.Body.Close()
cancel()
if err != nil {
return nil, fmt.Errorf("read groq response: %w", err)
}

if resp.StatusCode == 429 {
if attempt == 0 {
log.Printf("[AI] Groq rate limited, retrying in 15s...")
time.Sleep(15 * time.Second)
continue
}
return nil, fmt.Errorf("groq rate limit exceeded")
}

var groqResp groqResponse
if err := json.Unmarshal(respBytes, &groqResp); err != nil {
return nil, fmt.Errorf("parse groq response: %w", err)
}

if groqResp.Error != nil {
return nil, fmt.Errorf("groq error: %s", groqResp.Error.Message)
}

		if groqResp.Usage != nil {
			log.Printf("[AI] Groq tokens: prompt=%d completion=%d total=%d", groqResp.Usage.PromptTokens, groqResp.Usage.CompletionTokens, groqResp.Usage.TotalTokens)
		}
return &groqResp, nil
}
return nil, fmt.Errorf("groq rate limit exceeded after retries")
}

// --- AI Config Handlers (per-user Groq key) ---

func (s *Server) handleGetAIConfig(c *fiber.Ctx) error {
	userID, _ := c.Locals("user_id").(uuid.UUID)
	if userID == uuid.Nil {
		return c.Status(401).JSON(fiber.Map{"success": false, "error": "unauthorized"})
	}
	key, err := s.repos.User.GetGroqAPIKey(c.Context(), userID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "internal error"})
	}
	return c.JSON(fiber.Map{
		"success": true,
		"has_key": key != "",
	})
}

func (s *Server) handleSetAIConfig(c *fiber.Ctx) error {
	userID, _ := c.Locals("user_id").(uuid.UUID)
	if userID == uuid.Nil {
		return c.Status(401).JSON(fiber.Map{"success": false, "error": "unauthorized"})
	}
	var body struct {
		GroqAPIKey string `json:"groq_api_key"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "invalid body"})
	}
	if err := s.repos.User.SetGroqAPIKey(c.Context(), userID, body.GroqAPIKey); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "could not save key"})
	}
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleValidateAIConfig(c *fiber.Ctx) error {
	var body struct {
		GroqAPIKey string `json:"groq_api_key"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "invalid body"})
	}
	if body.GroqAPIKey == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "API key is required"})
	}

	// Make a minimal test request to Groq to validate the key
	testContent := "Hi"
	testMessages := []groqMessage{
		{Role: "user", Content: &testContent},
	}
	testReq := groqRequest{
		Model:       "meta-llama/llama-4-scout-17b-16e-instruct",
		Messages:    testMessages,
		Temperature: 0.1,
		MaxTokens:   5,
	}
	bodyBytes, _ := json.Marshal(testReq)

	httpCtx, cancel := context.WithTimeout(c.Context(), 15*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(httpCtx, http.MethodPost, "https://api.groq.com/openai/v1/chat/completions", bytes.NewReader(bodyBytes))
	if err != nil {
		return c.JSON(fiber.Map{"success": false, "valid": false, "error": "could not create request"})
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+body.GroqAPIKey)

	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		return c.JSON(fiber.Map{"success": false, "valid": false, "error": "could not reach Groq API"})
	}
	defer resp.Body.Close()

	if resp.StatusCode == 401 {
		return c.JSON(fiber.Map{"success": true, "valid": false, "error": "API key inválida"})
	}
	if resp.StatusCode == 429 {
		// Rate limited but key is valid
		return c.JSON(fiber.Map{"success": true, "valid": true})
	}
	if resp.StatusCode >= 400 {
		return c.JSON(fiber.Map{"success": true, "valid": false, "error": fmt.Sprintf("Groq returned status %d", resp.StatusCode)})
	}

	return c.JSON(fiber.Map{"success": true, "valid": true})
}

// --- Main AI Chat Handler ---

func (s *Server) handleAIChat(c *fiber.Ctx) error {
accountID, ok := c.Locals("account_id").(uuid.UUID)
if !ok || accountID == uuid.Nil {
return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
"success": false,
"error":   "unauthorized",
})
}
accountIDStr := accountID.String()
userID, _ := c.Locals("user_id").(uuid.UUID)

var req aiChatRequest
if err := c.BodyParser(&req); err != nil {
return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
"success": false,
"error":   "invalid request body",
})
}

if strings.TrimSpace(req.Message) == "" {
return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
"success": false,
"error":   "message is required",
})
}

// Resolve conversation - create if needed
var convID uuid.UUID
if req.ConversationID != "" {
parsed, err := uuid.Parse(req.ConversationID)
if err == nil {
convID = parsed
}
}
if convID == uuid.Nil && userID != uuid.Nil {
// Auto-create a new conversation from first message
title := req.Message
if len(title) > 50 {
title = title[:50]
}
conv, err := s.repos.ErosConversation.Create(c.Context(), accountID, userID, title)
if err != nil {
log.Printf("[AI] Error creating conversation: %v", err)
} else {
convID = conv.ID
}
}

// Save user message
if convID != uuid.Nil {
_, _ = s.repos.ErosConversation.AddMessage(c.Context(), convID, "user", req.Message)
}

history := req.History
if len(history) > 10 {
history = history[len(history)-10:]
}

ctx := c.Context()

crmCtx, err := s.buildCRMContext(ctx, accountIDStr)
if err != nil {
log.Printf("[AI] buildCRMContext error for account %s: %v", accountIDStr, err)
crmCtx = &crmContextData{}
}

systemPrompt := buildSystemPrompt(crmCtx, req.CurrentPage)

apiKey, err := s.repos.User.GetGroqAPIKey(ctx, userID)
if err != nil || apiKey == "" {
return c.JSON(fiber.Map{
"success": false,
"error":   "no_key_configured",
})
}

// Build initial messages
systemContent := systemPrompt
messages := []groqMessage{
{Role: "system", Content: &systemContent},
}
for _, msg := range history {
content := msg.Content
messages = append(messages, groqMessage{Role: msg.Role, Content: &content})
}
userContent := req.Message
messages = append(messages, groqMessage{Role: "user", Content: &userContent})

tools := getToolDefinitions()

log.Printf("[AI] Groq request (account=%s): %q", accountIDStr, req.Message)

// First call — may return tool_calls or direct response
resp, err := sendGroqRequest(ctx, apiKey, messages, tools)
if err != nil {
log.Printf("[AI] Groq error: %v", err)
if strings.Contains(err.Error(), "rate limit") {
return c.JSON(fiber.Map{
"success": false,
"error":   "¡Miau! 😿 Se agotaron mis tokens por minuto. Espera unos 30 segundos e intenta de nuevo 🕐",
"rate_limited": true,
})
}
return c.JSON(fiber.Map{
"success": false,
"error":   "Eros no está disponible en este momento, intenta de nuevo 😿",
})
}

if len(resp.Choices) == 0 {
return c.JSON(fiber.Map{
"success": false,
"error":   "Eros no pudo generar una respuesta 😿",
})
}

choice := resp.Choices[0]

// Handle tool calls (up to 3 rounds)
for round := 0; round < 3 && choice.FinishReason == "tool_calls" && len(choice.Message.ToolCalls) > 0; round++ {
// Echo assistant message with tool_calls — ensure Content is not nil
assistantMsg := choice.Message
if assistantMsg.Content == nil {
empty := ""
assistantMsg.Content = &empty
}
messages = append(messages, assistantMsg)

for _, tc := range choice.Message.ToolCalls {
var args map[string]interface{}
if err := json.Unmarshal([]byte(tc.Function.Arguments), &args); err != nil {
log.Printf("[AI] Error parsing tool args for %s: %v", tc.Function.Name, err)
errContent := fmt.Sprintf("Error parsing arguments: %v", err)
messages = append(messages, groqMessage{
Role: "tool", Content: &errContent, Name: tc.Function.Name, ToolCallID: tc.ID,
})
continue
}

log.Printf("[AI] Tool call: %s(%v)", tc.Function.Name, args)
result, err := s.executeTool(ctx, tc.Function.Name, args, accountIDStr)
if err != nil {
log.Printf("[AI] Tool error %s: %v", tc.Function.Name, err)
errContent := fmt.Sprintf("Error: %v", err)
messages = append(messages, groqMessage{
Role: "tool", Content: &errContent, Name: tc.Function.Name, ToolCallID: tc.ID,
})
continue
}

resultJSON, _ := json.Marshal(result)
resultStr := string(resultJSON)
log.Printf("[AI] Tool result %s: %d chars", tc.Function.Name, len(resultStr))
messages = append(messages, groqMessage{
Role: "tool", Content: &resultStr, Name: tc.Function.Name, ToolCallID: tc.ID,
})
}

// Call Groq again with tool results
resp, err = sendGroqRequest(ctx, apiKey, messages, nil) // no tools on follow-up
if err != nil {
log.Printf("[AI] Groq follow-up error: %v", err)
if strings.Contains(err.Error(), "rate limit") {
return c.JSON(fiber.Map{
"success": false,
"error":   "¡Miau! 😿 Se agotaron mis tokens por minuto. Espera unos 30 segundos e intenta de nuevo 🕐",
"rate_limited": true,
})
}
return c.JSON(fiber.Map{
"success": false,
"error":   "Eros tuvo un error procesando los datos 😿",
})
}
if len(resp.Choices) == 0 {
break
}
choice = resp.Choices[0]
}

response := ""
if choice.Message.Content != nil {
response = *choice.Message.Content
}

if response == "" {
response = "No pude procesar tu consulta. ¿Puedes reformularla? 😿"
}

log.Printf("[AI] Groq response (account=%s): %d chars", accountIDStr, len(response))

// Save assistant response to conversation
if convID != uuid.Nil {
_, _ = s.repos.ErosConversation.AddMessage(c.Context(), convID, "assistant", response)
}

result := fiber.Map{
"success":  true,
"response": response,
}
if convID != uuid.Nil {
result["conversation_id"] = convID.String()
}
return c.JSON(result)
}

// --- Conversation CRUD Handlers ---

func (s *Server) handleListErosConversations(c *fiber.Ctx) error {
accountID, _ := c.Locals("account_id").(uuid.UUID)
userID, _ := c.Locals("user_id").(uuid.UUID)

convs, err := s.repos.ErosConversation.ListByUser(c.Context(), accountID, userID)
if err != nil {
return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
}
if convs == nil {
convs = []domain.ErosConversation{}
}
return c.JSON(fiber.Map{"success": true, "conversations": convs})
}

func (s *Server) handleGetErosConversation(c *fiber.Ctx) error {
accountID, _ := c.Locals("account_id").(uuid.UUID)
convID, err := uuid.Parse(c.Params("id"))
if err != nil {
return c.Status(400).JSON(fiber.Map{"success": false, "error": "invalid id"})
}

conv, err := s.repos.ErosConversation.GetWithMessages(c.Context(), accountID, convID)
if err != nil {
return c.Status(404).JSON(fiber.Map{"success": false, "error": "conversation not found"})
}
return c.JSON(fiber.Map{"success": true, "conversation": conv})
}

func (s *Server) handleDeleteErosConversation(c *fiber.Ctx) error {
accountID, _ := c.Locals("account_id").(uuid.UUID)
convID, err := uuid.Parse(c.Params("id"))
if err != nil {
return c.Status(400).JSON(fiber.Map{"success": false, "error": "invalid id"})
}

if err := s.repos.ErosConversation.Delete(c.Context(), accountID, convID); err != nil {
return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
}
return c.JSON(fiber.Map{"success": true})
}
