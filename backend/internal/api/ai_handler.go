package api

import (
"bytes"
"context"
"encoding/json"
"fmt"
"io"
"log"
"net/http"
"regexp"
"strings"
"time"

"github.com/gofiber/fiber/v2"
"github.com/google/uuid"
"github.com/jackc/pgx/v5"
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
ID     string
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
MaxTokens   int           `json:"max_completion_tokens"`
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
Name:        "get_token_consumption",
Description: "Obtiene información sobre el consumo de tokens y el uso de la API de AI actual que tiene el usuario.",
Parameters: map[string]interface{}{
"type": "object",
"properties": map[string]interface{}{},
},
},
},
{
Type: "function",
Function: groqFunction{
Name:        "run_query",
Description: "Ejecuta consulta SQL SELECT read-only en PostgreSQL. $1=account_id. Máx 100 filas. IMPORTANTE: Para asistencia/asistentes SIEMPRE incluye AND le.stage_name='Asistieron' — sin ese filtro obtienes TODOS los registrados, no solo los que asistieron. Filtra sesiones por lb.id (UUID).",
Parameters: map[string]interface{}{
"type": "object",
"properties": map[string]interface{}{
"sql": map[string]interface{}{
"type":        "string",
"description": "Consulta SQL SELECT. Usa $1 para account_id en WHERE.",
},
},
"required": []string{"sql"},
},
},
},
{
Type: "function",
Function: groqFunction{
Name:        "get_chat_messages",
Description: "Obtiene los últimos mensajes de WhatsApp de un contacto por su número de teléfono. Devuelve mensajes con dirección (enviado/recibido), contenido y fecha.",
Parameters: map[string]interface{}{
"type": "object",
"properties": map[string]interface{}{
"phone": map[string]interface{}{
"type":        "string",
"description": "Número de teléfono del contacto (ej: 51926494721 o 926494721).",
},
"limit": map[string]interface{}{
"type":        "integer",
"description": "Cantidad máxima de mensajes a obtener (default 20, máx 100).",
},
},
"required": []string{"phone"},
},
},
},
{
Type: "function",
Function: groqFunction{
Name:        "search_chat_messages",
Description: "Busca mensajes de WhatsApp que contengan un texto específico en todas las conversaciones de la cuenta. Devuelve contacto, teléfono, fragmento del mensaje, dirección y fecha.",
Parameters: map[string]interface{}{
"type": "object",
"properties": map[string]interface{}{
"query": map[string]interface{}{
"type":        "string",
"description": "Texto a buscar en los mensajes.",
},
},
"required": []string{"query"},
},
},
},
}
}

// --- Tool Execution ---

func (s *Server) executeTool(ctx context.Context, toolName string, args map[string]interface{}, accountID string, userID ...string) (interface{}, error) {
	switch toolName {
	case "run_query":
		return s.toolRunQuery(ctx, args, accountID)
	case "get_token_consumption":
		u := ""
		if len(userID) > 0 { u = userID[0] }
		return s.toolGetTokenConsumption(ctx, args, accountID, u)
	case "get_chat_messages":
		return s.toolGetChatMessages(ctx, args, accountID)
	case "search_chat_messages":
		return s.toolSearchChatMessages(ctx, args, accountID)
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
SELECT COALESCE(c.name, l.name), COALESCE(c.phone, l.phone, ''), COALESCE(c.email, l.email, ''),
COALESCE(ps.name, 'Sin etapa'),
TO_CHAR(l.created_at, 'DD/MM/YYYY'),
COALESCE((SELECT STRING_AGG(t.name, ', ' ORDER BY t.name)
FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_id = l.contact_id), '')
FROM leads l
LEFT JOIN contacts c ON c.id = l.contact_id
LEFT JOIN pipeline_stages ps ON ps.id = l.stage_id
WHERE l.account_id = $1
AND (COALESCE(c.name, l.name) ILIKE '%' || $2 || '%'
OR COALESCE(c.phone, l.phone) ILIKE '%' || $2 || '%'
OR COALESCE(c.email, l.email) ILIKE '%' || $2 || '%'
OR EXISTS (SELECT 1 FROM contact_tags ct2 JOIN tags t2 ON t2.id = ct2.tag_id
WHERE ct2.contact_id = l.contact_id AND t2.name ILIKE '%' || $2 || '%'))
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
SELECT l.id, COALESCE(c.name, l.name), COALESCE(c.phone, l.phone, ''), COALESCE(c.email, l.email, ''),
COALESCE(ps.name, 'Sin etapa'),
TO_CHAR(l.created_at, 'DD/MM/YYYY'),
COALESCE((SELECT STRING_AGG(t.name, ', ' ORDER BY t.name)
FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_id = l.contact_id), '')
FROM leads l
LEFT JOIN contacts c ON c.id = l.contact_id
LEFT JOIN pipeline_stages ps ON ps.id = l.stage_id
WHERE l.account_id = $1
AND (COALESCE(c.name, l.name) ILIKE '%' || $2 || '%' OR COALESCE(c.phone, l.phone) ILIKE '%' || $2 || '%')
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
WHERE e.account_id = $1 AND e.status != 'cancelled' AND e.name ILIKE '%' || $2 || '%'
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
SELECT DISTINCT COALESCE(c.name, l.name), COALESCE(c.phone, l.phone, ''),
COALESCE(ps.name, 'Sin etapa'),
TO_CHAR(l.created_at, 'DD/MM/YYYY')
FROM leads l
LEFT JOIN contacts c ON c.id = l.contact_id
LEFT JOIN pipeline_stages ps ON ps.id = l.stage_id
JOIN chats ch ON ch.jid = l.jid AND ch.account_id = $1
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
var sessionTitle, sessionStatus, targetLogbookID string
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
lb.id::text, COALESCE(lb.title, ''), COALESCE(lb.status, '')
FROM events e
JOIN event_logbooks lb ON lb.event_id = e.id AND lb.date = $3
WHERE e.account_id = $1 AND e.status != 'cancelled' AND e.name ILIKE '%' || $2 || '%'
LIMIT 1`
searchArgs = []interface{}{accountID, eventName, dateFormatted}
} else {
searchQuery = `
SELECT e.id, e.name, e.status, COALESCE(TO_CHAR(e.event_date, 'DD/MM/YYYY'), 'Sin fecha'),
COALESCE(e.location, ''), COALESCE(e.tag_formula, ''),
lb.id::text, COALESCE(lb.title, ''), COALESCE(lb.status, '')
FROM events e
JOIN event_logbooks lb ON lb.event_id = e.id AND lb.date = $2
WHERE e.account_id = $1 AND e.status != 'cancelled'
LIMIT 1`
searchArgs = []interface{}{accountID, dateFormatted}
}
if err := db.QueryRow(ctx, searchQuery, searchArgs...).Scan(&eid, &ename, &status, &edate, &location, &formula, &targetLogbookID, &sessionTitle, &sessionStatus); err == nil {
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
FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id
WHERE ct.contact_id = ep.contact_id
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

// When a specific session date was targeted, return ONLY per-session attendance data
// Do NOT include global participants to prevent AI from mixing data sources
if targetLogbookID != "" {
var sessionAttendance []map[string]interface{}
saRows, saErr := db.Query(ctx, `
SELECT COALESCE(ep.name, ''), COALESCE(ep.phone, ''), le.stage_name, COALESCE(le.notes, '')
FROM event_logbook_entries le
JOIN event_participants ep ON ep.id = le.participant_id
WHERE le.logbook_id = $1
ORDER BY le.stage_name, ep.name
`, targetLogbookID)
if saErr == nil {
defer saRows.Close()
stageCount := make(map[string]int)
for saRows.Next() {
var saName, saPhone, saStageName, saNotes string
if saRows.Scan(&saName, &saPhone, &saStageName, &saNotes) == nil {
sessionAttendance = append(sessionAttendance, map[string]interface{}{
"name": saName, "phone": saPhone, "stage": saStageName, "notes": saNotes,
})
stageCount[saStageName]++
}
}
return map[string]interface{}{
"event_name":     ename,
"status":         status,
"date":           edate,
"location":       location,
"session":        map[string]string{"title": sessionTitle, "status": sessionStatus, "date": dateStr},
"participants":   sessionAttendance,
"total":          len(sessionAttendance),
"stage_summary":  stageCount,
"sessions":       sessions,
"NOTE": "Estos son los participantes registrados ESPECÍFICAMENTE en la sesión del " + dateStr + ". El campo 'stage' indica su estado en ESTA sesión (Asistieron=fueron, Confirmados=dijeron que irían, Declinados=no quisieron ir, Contactados=se les contactó). Usa stage_summary para conteos exactos.",
}, nil
}
}

// No session date targeted: return global event participants
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

return result, nil
}

// --- SQL Direct Query Tool ---

var sqlForbiddenPattern = regexp.MustCompile(`(?i)\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|EXECUTE|COPY|VACUUM|REINDEX|CLUSTER|COMMENT|LOCK|SET\s+ROLE|SET\s+SESSION)\b`)

func (s *Server) toolRunQuery(ctx context.Context, args map[string]interface{}, accountID string) (interface{}, error) {
	sql := getStringArg(args, "sql")
	if sql == "" {
		return map[string]interface{}{"error": "Se requiere una consulta SQL"}, nil
	}

	// Strip trailing JSON artifacts that GPT sometimes appends (}, ]}, etc)
	trimmed := strings.TrimSpace(sql)
	for len(trimmed) > 0 && (trimmed[len(trimmed)-1] == '}' || trimmed[len(trimmed)-1] == ']') {
		trimmed = strings.TrimSpace(trimmed[:len(trimmed)-1])
	}

	// Security: only allow SELECT statements
	if !strings.HasPrefix(strings.ToUpper(trimmed), "SELECT") && !strings.HasPrefix(strings.ToUpper(trimmed), "WITH") {
		return map[string]interface{}{"error": "Solo se permiten consultas SELECT o WITH (CTE)"}, nil
	}

	if sqlForbiddenPattern.MatchString(trimmed) {
		return map[string]interface{}{"error": "Consulta contiene operaciones no permitidas. Solo SELECT read-only."}, nil
	}

	// Enforce LIMIT if not present
	upperSQL := strings.ToUpper(trimmed)
	if !strings.Contains(upperSQL, "LIMIT") {
		sql = trimmed + " LIMIT 100"
	}

	// Execute with timeout
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	log.Printf("[AI-SQL] Executing: %s (account=%s)", trimmed, accountID)

	// Pass $1=accountID only if the query uses $1; PK-based queries may not need it
	var rows pgx.Rows
	var err error
	if strings.Contains(sql, "$1") {
		rows, err = s.repos.DB().Query(queryCtx, sql, accountID)
	} else {
		rows, err = s.repos.DB().Query(queryCtx, sql)
	}
	if err != nil {
		log.Printf("[AI-SQL] Error: %v", err)
		return map[string]interface{}{"error": fmt.Sprintf("Error SQL: %v", err)}, nil
	}
	defer rows.Close()

	fieldDescs := rows.FieldDescriptions()
	columns := make([]string, len(fieldDescs))
	for i, fd := range fieldDescs {
		columns[i] = string(fd.Name)
	}

	var results []map[string]interface{}
	rowCount := 0
	for rows.Next() && rowCount < 100 {
		values, err := rows.Values()
		if err != nil {
			continue
		}
		row := make(map[string]interface{}, len(columns))
		for i, col := range columns {
			if i < len(values) {
				switch v := values[i].(type) {
				case time.Time:
					row[col] = v.Format("02/01/2006 15:04")
				case []byte:
					row[col] = string(v)
				default:
					row[col] = v
				}
			}
		}
		results = append(results, row)
		rowCount++
	}

	if results == nil {
		results = []map[string]interface{}{}
	}

	log.Printf("[AI-SQL] Returned %d rows", len(results))

	result := map[string]interface{}{"columns": columns, "rows": results, "total": len(results)}

	// Server-side guardrail: warn if querying attendance without stage_name filter
	if strings.Contains(upperSQL, "EVENT_LOGBOOK_ENTRIES") && !strings.Contains(upperSQL, "STAGE_NAME") {
		result["warning"] = "⚠️ Esta consulta NO filtra por stage_name. Incluye TODOS los registrados (Asistieron, Confirmados, Declinados, etc). Si necesitas solo asistentes, DEBES agregar: AND le.stage_name='Asistieron'"
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
(SELECT COUNT(*) FROM events WHERE account_id = $1 AND status != 'cancelled'),
(SELECT COUNT(*) FROM leads WHERE account_id = $1 AND created_at >= NOW() - INTERVAL '30 days'),
(SELECT COUNT(DISTINCT l.id) FROM leads l
 WHERE l.account_id = $1 AND l.contact_id IS NOT NULL)
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
SELECT t.name, COUNT(ct.contact_id) as cnt
FROM tags t
JOIN contact_tags ct ON ct.tag_id = t.id
JOIN leads l ON l.contact_id = ct.contact_id AND l.account_id = $1
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
WHERE e.account_id = $1 AND e.status != 'cancelled'
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
SELECT lb.id, TO_CHAR(lb.date, 'DD/MM/YYYY'), lb.title, lb.status
FROM event_logbooks lb
WHERE lb.event_id = $1
ORDER BY lb.date ASC
`, eid)
if serr == nil {
for sessRows.Next() {
var si eventSessionInfo
if sessRows.Scan(&si.ID, &si.Date, &si.Title, &si.Status) == nil {
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

func buildSystemPrompt(crm *crmContextData, currentPage, customRole, customInstructions string) string {
	var sb strings.Builder

	currentDate := time.Now().Format("02/01/2006")

	if customRole != "" {
		sb.WriteString(fmt.Sprintf("%s\n\n", customRole))
		sb.WriteString(fmt.Sprintf("También eres Eros, gato blanco asistente de Clarin CRM. Fecha: %s. Español peruano, conciso, amigable, con emojis 🎯📊🐱. No inventes datos.\n\n", currentDate))
	} else {
		sb.WriteString(fmt.Sprintf("Eres Eros, gato blanco asistente de Clarin CRM. Fecha: %s. Español peruano, conciso, amigable, con emojis 🎯📊🐱. No inventes datos.\n\n", currentDate))
	}

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
totalSessions := 0
for _, e := range crm.Events {
totalSessions += len(e.Sessions)
}
sb.WriteString(fmt.Sprintf("\nEventos recientes (%d sesiones en total):\n", totalSessions))
for _, e := range crm.Events {
sb.WriteString(fmt.Sprintf("  • %s | %s | %s | %d participantes\n", e.Name, e.Status, e.Date, e.Participants))
if len(e.Sessions) > 0 {
for _, sess := range e.Sessions {
sb.WriteString(fmt.Sprintf("    → Sesión %s: \"%s\" [id:%s] (%s)\n", sess.Date, sess.Title, sess.ID, sess.Status))
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

if customInstructions != "" {
sb.WriteString(fmt.Sprintf("\n=== INSTRUCCIONES PERSONALIZADAS DEL USUARIO ===\n%s\n\n", customInstructions))
}

sb.WriteString(`
⚠️⚠️⚠️ REGLA #1 — ASISTENCIA (LEER PRIMERO):
- Cuando piden "asistentes"/"asistieron"/"los que fueron" → SQL DEBE tener: AND le.stage_name='Asistieron'
- SIN ese filtro obtienes TODOS los registrados (Asistieron + Confirmados + Declinados + etc). Eso es INCORRECTO.
- 'Confirmados' ≠ 'Asistieron'. Son categorías DISTINTAS. NUNCA las mezcles.
- Solo omite el filtro si piden explícitamente "todos los registrados" o "todos los participantes".

INSTRUCCIONES:
- Usa run_query para TODA consulta de datos. Genera SQL de nivel senior.
- Saludos: responde como gato juguetón sin herramientas 😸🎯📈.
- Tablas: markdown. Copywriting WA: corto, persuasivo, emojis, <300 chars.
- Si el resultado de run_query merece visualización, genera un gráfico usando <chart>.

=== GENERACIÓN DE GRÁFICOS ===
Puedes generar gráficos inline usando la etiqueta <chart>. El frontend los renderiza automáticamente.
Formato: <chart>{"type":"...","title":"...","data":[...],"keys":["..."],"indexBy":"..."}</chart>

Tipos disponibles: bar, pie, line, radar, scatter, area, stacked, heatmap, gauge
Campos:
- type (obligatorio): tipo de gráfico
- title (opcional): título del gráfico
- data (obligatorio excepto gauge): array de objetos, cada uno con el campo indexBy y los campos de keys
- keys (obligatorio para bar/stacked/line/area/radar): campos numéricos a graficar
- indexBy (obligatorio para bar/stacked/line/area/radar): campo categoría del eje X
- colors (opcional): array de colores hex, ej: ["#10b981","#3b82f6"]
- xLabel, yLabel (opcional): etiquetas de ejes
- layout (opcional): "vertical" u "horizontal"
- suggest (opcional): true = muestra botón "Ver gráfico" en vez de renderizar directo. Úsalo cuando el usuario NO pidió gráfico pero crees que sería útil.
- Gauge: usa value, min, max, unit en lugar de data/keys/indexBy.

Ejemplos:
1) Leads por etapa (bar):
<chart>{"type":"bar","title":"Leads por etapa","data":[{"etapa":"Calificado","total":45},{"etapa":"En progreso","total":32},{"etapa":"Nuevo","total":18}],"keys":["total"],"indexBy":"etapa"}</chart>

2) Distribución de asistencia (pie):
<chart>{"type":"pie","title":"Asistencia sesión","data":[{"id":"Asistieron","value":12},{"id":"Confirmados","value":5},{"id":"Declinados","value":3}]}</chart>

3) Tasa de conversión (gauge):
<chart>{"type":"gauge","title":"Tasa de conversión","value":68,"min":0,"max":100,"unit":"%"}</chart>

4) Sugerencia proactiva (no pedida por el usuario):
<chart>{"type":"bar","title":"Leads por etapa","data":[...],"keys":["total"],"indexBy":"etapa","suggest":true}</chart>

Cuándo generar gráficos:
- El usuario pide explícitamente un gráfico/chart/visualización → genera directo (suggest:false o no incluir suggest)
- Datos tabulares con 3+ filas numéricas → sugiere gráfico (suggest:true)
- Comparaciones, tendencias, distribuciones → sugiere gráfico (suggest:true)
- Respuestas simples de texto/lista corta → NO generes gráfico

=== PROTOCOLO DE DESAMBIGUACIÓN ===
Cuando hay ambigüedad (ej: 2 sesiones con nombre similar, múltiples leads con mismo nombre):
1. ⚠️ PREGUNTA POR FECHA: Si el usuario pregunta por una FECHA (ej: "07/03", "ayer", "el viernes") y hay múltiples sesiones ese día → INCLUYE TODAS. NO preguntes cuál. Filtra por lb.date, NO por lb.id. Muestra datos desglosados por sesión.
2. PREGUNTA POR SESIÓN ESPECÍFICA: Si nombra una sesión concreta (ej: "2da clase", "test01") → usa su UUID del contexto CRM.
3. Si los DATOS DEL CRM arriba ya tienen la info para resolver, úsala directo SIN preguntar.
4. Si NO puedes resolver, presenta opciones numeradas al usuario con la opción "Ambas/Todas".
5. SOLO pregunta cuando es estrictamente necesario. No preguntes cosas obvias.
6. NUNCA hagas preguntas abiertas. SIEMPRE da opciones.
7. Si el usuario ya dio suficiente contexto para resolver, NO preguntes — actúa.

=== HERRAMIENTA run_query (SQL DIRECTO) ===
Eres un experto senior en SQL PostgreSQL. Genera queries óptimas, precisas e indexadas.
El parámetro $1 = account_id (UUID). Inclúyelo siempre en WHERE.
Formato fechas en DB: timestamp/date. Usa TO_CHAR(col,'DD/MM/YYYY') para mostrar. Filtrar: col::date = 'YYYY-MM-DD'.

METODOLOGÍA SQL:
- SESIÓN ESPECÍFICA → PK (UUID): Cuando el usuario pregunta por UNA sesión concreta (ej: "resumen de la 2da clase"), filtra por lb.id='uuid' usando el [id:xxx] del contexto CRM. NUNCA filtres por lb.title ILIKE.
- PREGUNTA POR FECHA → lb.date: Cuando el usuario pregunta por una FECHA (ej: "cuántos asistieron el 07/03"), filtra por lb.date='YYYY-MM-DD'. Esto incluye TODAS las sesiones de esa fecha automáticamente. NUNCA elijas una sola sesión si hay varias en esa fecha.
- ⚠️ REGLA CLAVE: Si hay múltiples sesiones en la misma fecha y el usuario pregunta por la fecha, agrega TODAS — NO elijas una. Incluye lb.title y e.name en el SELECT para que el usuario sepa de qué sesión viene cada dato.
- JOINS EXPLÍCITOS: Siempre usa JOIN ... ON, nunca comas implícitas.
- ALIASES OBLIGATORIOS: Siempre cualifica columnas con alias de tabla (lb.date, ep.name, le.stage_name).
- CTEs PARA COMPLEJIDAD: Usa WITH ... AS para queries con 3+ JOINs o cuando necesites reusar un resultado.
- EXISTS SOBRE IN: Prefiere EXISTS(SELECT 1 FROM ...) sobre IN(SELECT ...) para subqueries correlacionadas.
- LIMIT SIEMPRE: Agrega LIMIT a toda query para evitar resultados masivos.

SCHEMA:
events(id uuid PK, account_id uuid, name text, status text, event_date timestamptz, location text, tag_formula text, pipeline_id uuid) -- status: 'active','draft','completed','cancelled'
event_logbooks(id uuid PK, event_id uuid FK→events, date date, title text, status text, total_participants int, general_notes text) -- SESIONES
event_logbook_entries(id uuid PK, logbook_id uuid FK→event_logbooks, participant_id uuid FK→event_participants, stage_name text, notes text) -- ASISTENCIA
event_participants(id uuid PK, event_id uuid FK→events, name text, phone text, email text, stage_id uuid, lead_id uuid, notes text, age int)
event_pipeline_stages(id uuid PK, pipeline_id uuid, name text, color text, position int)

leads(id uuid PK, account_id uuid, name text, phone text, email text, status text, source text, notes text, company text, age int, dni text, birth_date timestamptz, stage_id uuid, pipeline_id uuid)
contact_tags(contact_id uuid, tag_id uuid)
tags(id uuid PK, account_id uuid, name text, color text)
pipeline_stages(id uuid PK, pipeline_id uuid, name text, position int)

chats(id uuid PK, account_id uuid, contact_id uuid, jid text, name text, last_message text, unread_count int)
messages(id uuid PK, chat_id uuid FK→chats, body text, is_from_me bool, timestamp timestamptz, message_type text)
contacts(id uuid PK, account_id uuid, jid text, phone text, name text, email text, notes text, age int, dni text)

campaigns(id uuid PK, account_id uuid, name text, status text, total_recipients int, sent_count int, failed_count int, scheduled_at timestamptz)
campaign_recipients(id uuid PK, campaign_id uuid, name text, phone text, status text)

interactions(id uuid PK, account_id uuid, contact_id uuid, event_id uuid, participant_id uuid, type text, direction text, outcome text, notes text, lead_id uuid, created_at timestamptz)

programs(id uuid PK, account_id uuid, name text, status text)
program_sessions(id uuid PK, program_id uuid, date timestamptz, topic text, location text)
program_participants(id uuid PK, program_id uuid, contact_id uuid, status text, lead_id uuid)
program_attendance(id uuid PK, session_id uuid, participant_id uuid, status text, notes text)

RELACIONES CLAVE:
- events → event_logbooks (sesiones) via event_id
- event_logbooks → event_logbook_entries (asistencia) via logbook_id
- event_logbook_entries → event_participants via participant_id
- event_participants.stage_id → event_pipeline_stages.id (etapa GLOBAL)
- event_logbook_entries.stage_name = etapa EN ESA SESIÓN ('Asistieron','Confirmados','Declinados','Contactados','Interesados','Pre inscritos','Inscrito')
- leads → contacts → contact_tags → tags
- leads.stage_id → pipeline_stages.id
- chats → messages via chat_id; chats.jid formato: 51XXXXXXXXX@s.whatsapp.net
- contacts.phone = número sin prefijo jid

EJEMPLOS SQL (usando PK):
-- Asistentes de una sesión por UUID (FORMA CORRECTA — siempre incluye $1 via JOIN a events):
SELECT ep.phone, ep.name, le.notes, ep.age
FROM event_logbook_entries le
JOIN event_participants ep ON ep.id = le.participant_id
JOIN event_logbooks lb ON lb.id = le.logbook_id
JOIN events e ON e.id = lb.event_id
WHERE e.account_id = $1 AND le.logbook_id = 'UUID_DE_SESION' AND le.stage_name = 'Asistieron'
LIMIT 100

-- Resumen de asistencia de una sesión:
SELECT le.stage_name, COUNT(*) AS total
FROM event_logbook_entries le
JOIN event_logbooks lb ON lb.id = le.logbook_id
JOIN events e ON e.id = lb.event_id
WHERE e.account_id = $1 AND le.logbook_id = 'UUID_DE_SESION'
GROUP BY le.stage_name ORDER BY total DESC

-- Sesiones de un evento:
SELECT lb.id, lb.date, lb.title, lb.status, lb.total_participants
FROM event_logbooks lb
JOIN events e ON e.id = lb.event_id
WHERE e.account_id = $1 AND e.name ILIKE '%nombre%'
ORDER BY lb.date

-- Leads por etapa con CTE:
WITH lead_data AS (
  SELECT l.id, COALESCE(c.name, l.name) AS name, COALESCE(c.phone, l.phone) AS phone, ps.name AS etapa
  FROM leads l
  LEFT JOIN contacts c ON c.id = l.contact_id
  LEFT JOIN pipeline_stages ps ON ps.id = l.stage_id
  WHERE l.account_id = $1
)
SELECT etapa, COUNT(*) AS total FROM lead_data GROUP BY etapa ORDER BY total DESC

-- Buscar lead con tags:
SELECT COALESCE(c.name, l.name) AS name, COALESCE(c.phone, l.phone) AS phone, COALESCE(c.email, l.email) AS email, COALESCE(ps.name,'') AS etapa, STRING_AGG(t.name, ', ') AS tags
FROM leads l
LEFT JOIN contacts c ON c.id = l.contact_id
LEFT JOIN pipeline_stages ps ON ps.id = l.stage_id
LEFT JOIN contact_tags ct ON ct.contact_id = l.contact_id
LEFT JOIN tags t ON t.id = ct.tag_id
WHERE l.account_id = $1 AND COALESCE(c.name, l.name) ILIKE '%juan%'
GROUP BY l.id, c.name, l.name, c.phone, l.phone, c.email, l.email, ps.name LIMIT 50

-- Mensajes recientes:
SELECT m.body, m.is_from_me, TO_CHAR(m.timestamp, 'DD/MM/YYYY HH24:MI') AS fecha
FROM messages m
JOIN chats ch ON ch.id = m.chat_id
WHERE ch.account_id = $1 AND ch.jid LIKE '%993738489%'
ORDER BY m.timestamp DESC LIMIT 20

-- Reporte diario (UNION ALL):
SELECT 'leads_nuevos' AS tipo, COUNT(*) AS total FROM leads WHERE account_id=$1 AND created_at::date=CURRENT_DATE
UNION ALL SELECT 'msgs_enviados', COUNT(*) FROM messages m JOIN chats c ON c.id=m.chat_id WHERE c.account_id=$1 AND m.is_from_me=true AND m.timestamp::date=CURRENT_DATE
UNION ALL SELECT 'msgs_recibidos', COUNT(*) FROM messages m JOIN chats c ON c.id=m.chat_id WHERE c.account_id=$1 AND m.is_from_me=false AND m.timestamp::date=CURRENT_DATE

-- Interacciones con EXISTS:
SELECT i.type, i.direction, i.outcome, i.notes, TO_CHAR(i.created_at, 'DD/MM/YYYY HH24:MI') AS fecha
FROM interactions i
WHERE i.account_id = $1 AND EXISTS(SELECT 1 FROM contacts c WHERE c.id = i.contact_id AND c.phone LIKE '%993738489%')
ORDER BY i.created_at DESC LIMIT 50

-- Registrados entre fechas:
SELECT le.stage_name, COUNT(*) AS total, STRING_AGG(ep.name, ', ' ORDER BY ep.name) AS nombres
FROM event_logbook_entries le
JOIN event_participants ep ON ep.id = le.participant_id
JOIN event_logbooks lb ON lb.id = le.logbook_id
JOIN events e ON e.id = lb.event_id
WHERE e.account_id = $1 AND lb.date BETWEEN '2026-03-01' AND '2026-03-15'
GROUP BY le.stage_name ORDER BY total DESC

-- ⚠️ Asistentes de TODAS las sesiones de una fecha (FORMA CORRECTA para preguntas por fecha):
SELECT e.name AS evento, lb.title AS sesion, le.stage_name, COUNT(*) AS total
FROM event_logbook_entries le
JOIN event_logbooks lb ON lb.id = le.logbook_id
JOIN events e ON e.id = lb.event_id
WHERE e.account_id = $1 AND lb.date = '2026-03-07' AND le.stage_name = 'Asistieron'
GROUP BY e.name, lb.title, le.stage_name ORDER BY total DESC

-- Total asistentes en una fecha (cross-session):
SELECT COUNT(*) AS total_asistieron
FROM event_logbook_entries le
JOIN event_logbooks lb ON lb.id = le.logbook_id
JOIN events e ON e.id = lb.event_id
WHERE e.account_id = $1 AND lb.date = '2026-03-07' AND le.stage_name = 'Asistieron'

⚠️ REGLAS SQL OBLIGATORIAS:
1. SIEMPRE incluye account_id=$1 en WHERE (o via JOIN a tabla que lo tenga).
1b. ⚠️ EVENTOS: Por defecto SIEMPRE excluye eventos cancelados (e.status != 'cancelled') a menos que el usuario pida explícitamente ver cancelados/eliminados. Esto aplica a cualquier query que toque la tabla events.
2. Fechas: el usuario dice DD/MM/YYYY → convierte a YYYY-MM-DD en SQL.
3. stage_name valores: 'Asistieron', 'Confirmados', 'Declinados', 'Contactados', 'Interesados', 'Pre inscritos', 'Inscrito', 'Registrados'.
4. Teléfonos: LIKE '%XXXXXXXXX%' (últimos 9 dígitos).
5. Búsqueda texto: ILIKE para nombres, descripciones.
6. SIEMPRE devuelve name + phone al listar personas.
7. Usa COUNT(*) para conteos — NUNCA cuentes filas manualmente.
8. ⚠️ SESIÓN ESPECÍFICA: Filtra por lb.id='uuid' (del contexto CRM). FECHA: Filtra por lb.date='YYYY-MM-DD' (incluye TODAS las sesiones). NUNCA uses lb.title ILIKE.
9. ⚠️ Si hay MÚLTIPLES sesiones en una fecha y el usuario pregunta por esa fecha → agrega TODAS en UNA query con lb.date. Incluye e.name y lb.title en SELECT para desglosar.
10. Incluye lb.title o identificador en SELECT cuando consultes event_logbook_entries.
11. Cualifica TODAS las columnas con alias (ep.name, lb.date, le.stage_name). Nunca columnas ambiguas.
12. Usa CTEs (WITH) cuando el query tenga 3+ JOINs y lógica compleja.
13. SIEMPRE agrega LIMIT (máx 100). Usa LIMIT menor si es suficiente.

⚠️⚠️ REGLA CRÍTICA DE ASISTENCIA:
- 'asistentes'/'asistieron'/'los que fueron' = SOLO stage_name='Asistieron'. NUNCA incluyas 'Confirmados'.
- 'Confirmados' = dijeron que irían, NO necesariamente asistieron. Son categorías DISTINTAS.
- 'Declinados' = no quisieron ir. 'Contactados' = se les contactó.
- Si piden 'asistentes' → filtra EXCLUSIVAMENTE stage_name='Asistieron'.
- Si piden 'todos los registrados'/'participantes' → incluye TODOS los stage_name.
- NUNCA mezcles Asistieron con Confirmados a menos que lo pida explícitamente.
`)

return sb.String()
}

// --- AI Provider ---

const (
	openAIBaseURL    = "https://api.openai.com/v1/chat/completions"
	openAIModelsURL  = "https://api.openai.com/v1/models"
	defaultAIModel   = "gpt-4.1-nano"
)

// --- Groq API Call ---

func sendGroqRequest(ctx context.Context, apiKey string, model string, messages []groqMessage, tools []groqTool) (*groqResponse, error) {
	maxTok := 2048 // follow-up: synthesize response from tool results + charts
	if tools != nil {
		maxTok = 1024 // first call with tools: SQL generation + tool selection
	}

	if model == "" {
		model = defaultAIModel
	}

	reqBody := groqRequest{
		Model:       model,
		Messages:    messages,
		Tools:       tools,
		Temperature: 0.2,
		MaxTokens:   maxTok,
	}

	bodyBytes, err := json.Marshal(reqBody)
if err != nil {
return nil, fmt.Errorf("marshal groq request: %w", err)
}

// Retry up to 2 times on rate limit (429)
for attempt := 0; attempt < 2; attempt++ {
httpCtx, cancel := context.WithTimeout(ctx, 45*time.Second)

req, err := http.NewRequestWithContext(httpCtx, http.MethodPost, openAIBaseURL, bytes.NewReader(bodyBytes))
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
// If max_tokens reached but we got partial content, return it instead of failing
if len(groqResp.Choices) > 0 && groqResp.Choices[0].Message.Content != nil && *groqResp.Choices[0].Message.Content != "" {
log.Printf("[AI] Groq partial response (max_tokens reached), returning partial content")
return &groqResp, nil
}
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
	model, role, instructions, _ := s.repos.User.GetErosConfig(c.Context(), userID)
	if model == "" {
		model = defaultAIModel
	}
	return c.JSON(fiber.Map{
		"success":      true,
		"has_key":      key != "",
		"model":        model,
		"role":         role,
		"instructions": instructions,
	})
}

func (s *Server) handleSetAIConfig(c *fiber.Ctx) error {
	userID, _ := c.Locals("user_id").(uuid.UUID)
	if userID == uuid.Nil {
		return c.Status(401).JSON(fiber.Map{"success": false, "error": "unauthorized"})
	}
	var body struct {
		GroqAPIKey   string `json:"groq_api_key"`
		Model        string `json:"model"`
		Role         string `json:"role"`
		Instructions string `json:"instructions"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "invalid body"})
	}
	// Save API key if provided (even empty to disconnect)
	if err := s.repos.User.SetGroqAPIKey(c.Context(), userID, body.GroqAPIKey); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "could not save key"})
	}
	// Save Eros config (model, role, instructions)
	if err := s.repos.User.SetErosConfig(c.Context(), userID, body.Model, body.Role, body.Instructions); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "could not save config"})
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
	if !strings.HasPrefix(body.GroqAPIKey, "sk-") {
		return c.JSON(fiber.Map{"success": true, "valid": false, "error": "La API key debe comenzar con sk-"})
	}

	// Make a minimal test request to validate the key
	testContent := "Hi"
	testMessages := []groqMessage{
		{Role: "user", Content: &testContent},
	}

	testReq := groqRequest{
		Model:       defaultAIModel,
		Messages:    testMessages,
		Temperature: 0.1,
		MaxTokens:   5,
	}
	bodyBytes, _ := json.Marshal(testReq)

	httpCtx, cancel := context.WithTimeout(c.Context(), 15*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(httpCtx, http.MethodPost, openAIBaseURL, bytes.NewReader(bodyBytes))
	if err != nil {
		return c.JSON(fiber.Map{"success": false, "valid": false, "error": "could not create request"})
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+body.GroqAPIKey)

	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		return c.JSON(fiber.Map{"success": false, "valid": false, "error": "could not reach OpenAI API"})
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
		return c.JSON(fiber.Map{"success": true, "valid": false, "error": fmt.Sprintf("API returned status %d", resp.StatusCode)})
	}

	return c.JSON(fiber.Map{"success": true, "valid": true})
}

// --- List OpenAI Models ---

func (s *Server) handleListAIModels(c *fiber.Ctx) error {
	var body struct {
		APIKey string `json:"api_key"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "invalid body"})
	}
	if body.APIKey == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "API key is required"})
	}

	httpCtx, cancel := context.WithTimeout(c.Context(), 15*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(httpCtx, http.MethodGet, openAIModelsURL, nil)
	if err != nil {
		return c.JSON(fiber.Map{"success": false, "error": "could not create request"})
	}
	req.Header.Set("Authorization", "Bearer "+body.APIKey)

	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		return c.JSON(fiber.Map{"success": false, "error": "could not reach OpenAI API"})
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return c.JSON(fiber.Map{"success": false, "error": fmt.Sprintf("OpenAI returned status %d", resp.StatusCode)})
	}

	var modelsResp struct {
		Data []struct {
			ID      string `json:"id"`
			OwnedBy string `json:"owned_by"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&modelsResp); err != nil {
		return c.JSON(fiber.Map{"success": false, "error": "could not parse models response"})
	}

	// Filter to GPT/o models only, sort alphabetically
	var models []string
	for _, m := range modelsResp.Data {
		id := m.ID
		if strings.HasPrefix(id, "gpt-") || strings.HasPrefix(id, "o1") || strings.HasPrefix(id, "o3") || strings.HasPrefix(id, "o4") {
			// Skip realtime, audio, and search variants
			if strings.Contains(id, "realtime") || strings.Contains(id, "audio") || strings.Contains(id, "search") || strings.Contains(id, "transcribe") || strings.Contains(id, "tts") {
				continue
			}
			models = append(models, id)
		}
	}

	// Sort
	for i := 0; i < len(models); i++ {
		for j := i + 1; j < len(models); j++ {
			if models[i] > models[j] {
				models[i], models[j] = models[j], models[i]
			}
		}
	}

	return c.JSON(fiber.Map{"success": true, "models": models})
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

apiKey, err := s.repos.User.GetGroqAPIKey(ctx, userID)
if err != nil || apiKey == "" {
return c.JSON(fiber.Map{
"success": false,
"error":   "no_key_configured",
})
}

// Load Eros config (model, role, instructions)
erosModel, erosRole, erosInstructions, _ := s.repos.User.GetErosConfig(ctx, userID)
if erosModel == "" {
erosModel = defaultAIModel
}

systemPrompt := buildSystemPrompt(crmCtx, req.CurrentPage, erosRole, erosInstructions)

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
resp, err := sendGroqRequest(ctx, apiKey, erosModel, messages, tools)

if resp != nil && resp.Usage != nil {
    var apiKeyPreview string
    if len(apiKey) >= 8 {
        apiKeyPreview = apiKey[:8] + "..."
    }
    _ = s.repos.AIToken.Save(ctx, accountID, userID, apiKeyPreview, erosModel, resp.Usage.PromptTokens, resp.Usage.CompletionTokens, resp.Usage.TotalTokens)
}

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
result, err := s.executeTool(ctx, tc.Function.Name, args, accountIDStr, userID.String())
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

// Call Groq again with tool results (pass tools to allow multi-step queries)
resp, err = sendGroqRequest(ctx, apiKey, erosModel, messages, tools)

if resp != nil && resp.Usage != nil {
    var apiKeyPreview string
    if len(apiKey) >= 8 {
        apiKeyPreview = apiKey[:8] + "..."
    }
    _ = s.repos.AIToken.Save(ctx, accountID, userID, apiKeyPreview, erosModel, resp.Usage.PromptTokens, resp.Usage.CompletionTokens, resp.Usage.TotalTokens)
}

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

func (s *Server) toolGetTokenConsumption(ctx context.Context, args map[string]interface{}, accountIDStr, userIDStr string) (interface{}, error) {
if accountIDStr == "" || userIDStr == "" {
return nil, fmt.Errorf("Faltan parámetros de usuario/cuenta para ver consumos.")
}

accUUID, err := uuid.Parse(accountIDStr)
if err != nil { return nil, err }
userUUID, err := uuid.Parse(userIDStr)
if err != nil { return nil, err }

inTokens, outTokens, total, err := s.repos.AIToken.GetTotalTokensUsage(ctx, accUUID, userUUID)
if err != nil {
return nil, fmt.Errorf("No se pudo obtener el uso de la base de datos: %v", err)
}

return map[string]interface{}{
"message": "Tokens calculados correctamente",
"input_tokens": inTokens,
"output_tokens": outTokens,
"total_tokens_used": total,
"hint": "Comunica al usuario de forma amena cuántos tokens ha consumido. Puedes mencionar la suma total y el modelo usado.",
}, nil
}
