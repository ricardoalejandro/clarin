package mcp

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/mark3labs/mcp-go/mcp"
)

// ═══════════════════════════════════════════════════════════════
// Tools: Programs, Campaigns, Surveys, Automations, Contacts, Chats
// ═══════════════════════════════════════════════════════════════

// ──── list_programs ────
func (s *MCPServer) toolListPrograms(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	accountID, err := s.getAccountID(ctx)
	if err != nil {
		return errResult("no se pudo determinar la cuenta"), nil
	}

	status := stringArg(req, "status")

	programs, err := s.repos.Program.List(ctx, accountID)
	if err != nil {
		return errResult("error al obtener programas: " + err.Error()), nil
	}

	type programResult struct {
		ID               string `json:"id"`
		Name             string `json:"name"`
		Description      string `json:"description,omitempty"`
		Status           string `json:"status"`
		Color            string `json:"color,omitempty"`
		ParticipantCount int    `json:"participant_count"`
		SessionCount     int    `json:"session_count"`
		StartDate        string `json:"start_date,omitempty"`
		EndDate          string `json:"end_date,omitempty"`
	}

	var results []programResult
	for _, p := range programs {
		if status != "" && p.Status != status {
			continue
		}
		pr := programResult{
			ID:               p.ID.String(),
			Name:             p.Name,
			Status:           p.Status,
			ParticipantCount: p.ParticipantCount,
			SessionCount:     p.SessionCount,
		}
		if p.Description != nil {
			pr.Description = *p.Description
		}
		if p.Color != "" {
			pr.Color = p.Color
		}
		if p.ScheduleStartDate != nil {
			pr.StartDate = p.ScheduleStartDate.Format("2006-01-02")
		}
		if p.ScheduleEndDate != nil {
			pr.EndDate = p.ScheduleEndDate.Format("2006-01-02")
		}
		results = append(results, pr)
	}

	if results == nil {
		results = []programResult{}
	}

	return jsonResult(map[string]interface{}{
		"count":    len(results),
		"programs": results,
	}), nil
}

// ──── get_program_detail ────
func (s *MCPServer) toolGetProgramDetail(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	accountID, err := s.getAccountID(ctx)
	if err != nil {
		return errResult("no se pudo determinar la cuenta"), nil
	}

	programID, err := uuidArg(req, "program_id")
	if err != nil {
		return errResult("program_id inválido"), nil
	}

	program, err := s.repos.Program.GetByID(ctx, accountID, programID)
	if err != nil || program == nil {
		return errResult("programa no encontrado"), nil
	}

	detail := map[string]interface{}{
		"id":                program.ID.String(),
		"name":              program.Name,
		"status":            program.Status,
		"participant_count": program.ParticipantCount,
		"session_count":     program.SessionCount,
	}
	if program.Description != nil {
		detail["description"] = *program.Description
	}
	if program.Color != "" {
		detail["color"] = program.Color
	}
	if program.ScheduleStartDate != nil {
		detail["start_date"] = program.ScheduleStartDate.Format("2006-01-02")
	}
	if program.ScheduleEndDate != nil {
		detail["end_date"] = program.ScheduleEndDate.Format("2006-01-02")
	}

	// Participants
	participants, err := s.repos.Program.ListParticipants(ctx, programID)
	if err == nil {
		type partResult struct {
			ID          string `json:"id"`
			ContactName string `json:"contact_name"`
			Phone       string `json:"phone,omitempty"`
			Status      string `json:"status"`
		}
		parts := make([]partResult, 0, len(participants))
		for _, p := range participants {
			pr := partResult{
				ID:          p.ID.String(),
				ContactName: p.ContactName,
				Status:      p.Status,
			}
			if p.ContactPhone != nil {
				pr.Phone = *p.ContactPhone
			}
			parts = append(parts, pr)
		}
		detail["participants"] = parts
	}

	// Sessions
	sessions, err := s.repos.Program.ListSessions(ctx, programID)
	if err == nil {
		type sessResult struct {
			ID        string `json:"id"`
			Date      string `json:"date"`
			Topic     string `json:"topic,omitempty"`
			StartTime string `json:"start_time,omitempty"`
			EndTime   string `json:"end_time,omitempty"`
			Location  string `json:"location,omitempty"`
			Present   int    `json:"present"`
			Absent    int    `json:"absent"`
			Late      int    `json:"late"`
			Excused   int    `json:"excused"`
		}
		sessList := make([]sessResult, 0, len(sessions))
		for _, ss := range sessions {
			sr := sessResult{
				ID:   ss.ID.String(),
				Date: ss.Date.Format("2006-01-02"),
			}
			if ss.Topic != nil {
				sr.Topic = *ss.Topic
			}
			if ss.StartTime != nil {
				sr.StartTime = *ss.StartTime
			}
			if ss.EndTime != nil {
				sr.EndTime = *ss.EndTime
			}
			if ss.Location != nil {
				sr.Location = *ss.Location
			}
			if ss.AttendanceStats != nil {
				sr.Present = ss.AttendanceStats["present"]
				sr.Absent = ss.AttendanceStats["absent"]
				sr.Late = ss.AttendanceStats["late"]
				sr.Excused = ss.AttendanceStats["excused"]
			}
			sessList = append(sessList, sr)
		}
		detail["sessions"] = sessList
	}

	return jsonResult(detail), nil
}

// ──── get_program_attendance ────
func (s *MCPServer) toolGetProgramAttendance(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	sessionID, err := uuidArg(req, "session_id")
	if err != nil {
		return errResult("session_id inválido"), nil
	}

	attendance, err := s.repos.Program.GetAttendanceBySession(ctx, sessionID)
	if err != nil {
		return errResult("error al obtener asistencia: " + err.Error()), nil
	}

	type attResult struct {
		ID              string `json:"id"`
		ParticipantName string `json:"participant_name"`
		Phone           string `json:"phone,omitempty"`
		Status          string `json:"status"`
		Notes           string `json:"notes,omitempty"`
	}

	results := make([]attResult, 0, len(attendance))
	for _, a := range attendance {
		ar := attResult{
			ID:              a.ID.String(),
			ParticipantName: a.ParticipantName,
			Status:          a.Status,
		}
		if a.ParticipantPhone != nil {
			ar.Phone = *a.ParticipantPhone
		}
		if a.Notes != nil {
			ar.Notes = *a.Notes
		}
		results = append(results, ar)
	}

	return jsonResult(map[string]interface{}{
		"count":      len(results),
		"attendance": results,
	}), nil
}

// ──── list_campaigns ────
func (s *MCPServer) toolListCampaigns(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	accountID, err := s.getAccountID(ctx)
	if err != nil {
		return errResult("no se pudo determinar la cuenta"), nil
	}

	campaigns, err := s.repos.Campaign.GetByAccountID(ctx, accountID)
	if err != nil {
		return errResult("error al obtener campañas: " + err.Error()), nil
	}

	type campaignResult struct {
		ID              string `json:"id"`
		Name            string `json:"name"`
		Status          string `json:"status"`
		TotalRecipients int    `json:"total_recipients"`
		SentCount       int    `json:"sent_count"`
		FailedCount     int    `json:"failed_count"`
		CreatedAt       string `json:"created_at"`
	}

	results := make([]campaignResult, 0, len(campaigns))
	for _, c := range campaigns {
		cr := campaignResult{
			ID:              c.ID.String(),
			Name:            c.Name,
			Status:          c.Status,
			TotalRecipients: c.TotalRecipients,
			SentCount:       c.SentCount,
			FailedCount:     c.FailedCount,
			CreatedAt:       c.CreatedAt.Format("2006-01-02 15:04"),
		}
		results = append(results, cr)
	}

	return jsonResult(map[string]interface{}{
		"count":     len(results),
		"campaigns": results,
	}), nil
}

// ──── get_campaign_detail ────
func (s *MCPServer) toolGetCampaignDetail(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	accountID, err := s.getAccountID(ctx)
	if err != nil {
		return errResult("no se pudo determinar la cuenta"), nil
	}
	campaignID, err := uuidArg(req, "campaign_id")
	if err != nil {
		return errResult("campaign_id inválido"), nil
	}

	campaign, err := s.repos.Campaign.GetByID(ctx, campaignID)
	if err != nil || campaign == nil || campaign.AccountID != accountID {
		return errResult("campaña no encontrada"), nil
	}

	detail := map[string]interface{}{
		"id":               campaign.ID.String(),
		"name":             campaign.Name,
		"message_template": campaign.MessageTemplate,
		"status":           campaign.Status,
		"total_recipients": campaign.TotalRecipients,
		"sent_count":       campaign.SentCount,
		"failed_count":     campaign.FailedCount,
		"created_at":       campaign.CreatedAt.Format("2006-01-02 15:04"),
	}
	if campaign.MediaType != nil {
		detail["media_type"] = *campaign.MediaType
	}

	// Recipients
	recipients, err := s.repos.Campaign.GetRecipients(ctx, campaignID)
	if err == nil {
		recipientLimit := intArg(req, "recipient_limit", 50, 200)
		type recipResult struct {
			Name   string `json:"name"`
			Phone  string `json:"phone"`
			Status string `json:"status"`
			SentAt string `json:"sent_at,omitempty"`
			Error  string `json:"error,omitempty"`
		}
		recips := make([]recipResult, 0)
		for i, r := range recipients {
			if i >= recipientLimit {
				break
			}
			rr := recipResult{
				Status: r.Status,
			}
			if r.Name != nil {
				rr.Name = *r.Name
			}
			if r.Phone != nil {
				rr.Phone = *r.Phone
			}
			if r.SentAt != nil {
				rr.SentAt = r.SentAt.Format("2006-01-02 15:04")
			}
			if r.ErrorMessage != nil {
				rr.Error = *r.ErrorMessage
			}
			recips = append(recips, rr)
		}
		detail["recipients"] = recips
		detail["total_recipients_shown"] = len(recips)
	}

	return jsonResult(detail), nil
}

// ──── list_surveys ────
func (s *MCPServer) toolListSurveys(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	accountID, err := s.getAccountID(ctx)
	if err != nil {
		return errResult("no se pudo determinar la cuenta"), nil
	}

	surveys, err := s.repos.Survey.List(ctx, accountID)
	if err != nil {
		return errResult("error al obtener encuestas: " + err.Error()), nil
	}

	type surveyResult struct {
		ID            string `json:"id"`
		Name          string `json:"name"`
		Description   string `json:"description,omitempty"`
		Slug          string `json:"slug"`
		Status        string `json:"status"`
		QuestionCount int    `json:"question_count"`
		ResponseCount int    `json:"response_count"`
	}

	results := make([]surveyResult, 0, len(surveys))
	for _, sv := range surveys {
		sr := surveyResult{
			ID:            sv.ID.String(),
			Name:          sv.Name,
			Slug:          sv.Slug,
			Status:        sv.Status,
			QuestionCount: sv.QuestionCount,
			ResponseCount: sv.ResponseCount,
		}
		if sv.Description != "" {
			sr.Description = sv.Description
		}
		results = append(results, sr)
	}

	return jsonResult(map[string]interface{}{
		"count":   len(results),
		"surveys": results,
	}), nil
}

// ──── get_survey_detail ────
func (s *MCPServer) toolGetSurveyDetail(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	accountID, err := s.getAccountID(ctx)
	if err != nil {
		return errResult("no se pudo determinar la cuenta"), nil
	}

	surveyID, err := uuidArg(req, "survey_id")
	if err != nil {
		return errResult("survey_id inválido"), nil
	}

	survey, err := s.repos.Survey.GetByID(ctx, surveyID, accountID)
	if err != nil || survey == nil {
		return errResult("encuesta no encontrada"), nil
	}

	detail := map[string]interface{}{
		"id":             survey.ID.String(),
		"name":           survey.Name,
		"slug":           survey.Slug,
		"status":         survey.Status,
		"question_count": survey.QuestionCount,
		"response_count": survey.ResponseCount,
	}
	if survey.Description != "" {
		detail["description"] = survey.Description
	}

	// Questions
	questions, err := s.repos.Survey.GetQuestions(ctx, surveyID)
	if err == nil {
		type qResult struct {
			ID       string      `json:"id"`
			Order    int         `json:"order"`
			Type     string      `json:"type"`
			Title    string      `json:"title"`
			Required bool        `json:"required"`
			Config   interface{} `json:"config,omitempty"`
		}
		qs := make([]qResult, 0, len(questions))
		for _, q := range questions {
			qr := qResult{
				ID:       q.ID.String(),
				Order:    q.OrderIndex,
				Type:     q.Type,
				Title:    q.Title,
				Required: q.Required,
				Config:   q.Config,
			}
			qs = append(qs, qr)
		}
		detail["questions"] = qs
	}

	return jsonResult(detail), nil
}

// ──── get_survey_analytics ────
func (s *MCPServer) toolGetSurveyAnalytics(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	surveyID, err := uuidArg(req, "survey_id")
	if err != nil {
		return errResult("survey_id inválido"), nil
	}

	analytics, err := s.repos.Survey.GetAnalytics(ctx, surveyID)
	if err != nil {
		return errResult("error al obtener analytics: " + err.Error()), nil
	}

	return jsonResult(analytics), nil
}

// ──── list_automations ────
func (s *MCPServer) toolListAutomations(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	accountID, err := s.getAccountID(ctx)
	if err != nil {
		return errResult("no se pudo determinar la cuenta"), nil
	}

	automations, err := s.repos.Automation.List(ctx, accountID)
	if err != nil {
		return errResult("error al obtener automatizaciones: " + err.Error()), nil
	}

	type autoResult struct {
		ID             string `json:"id"`
		Name           string `json:"name"`
		TriggerType    string `json:"trigger_type"`
		IsActive       bool   `json:"is_active"`
		ExecutionCount int    `json:"execution_count"`
		LastTriggered  string `json:"last_triggered_at,omitempty"`
	}

	results := make([]autoResult, 0, len(automations))
	for _, a := range automations {
		ar := autoResult{
			ID:             a.ID.String(),
			Name:           a.Name,
			TriggerType:    a.TriggerType,
			IsActive:       a.IsActive,
			ExecutionCount: a.ExecutionCount,
		}
		if a.LastTriggeredAt != nil {
			ar.LastTriggered = a.LastTriggeredAt.Format("2006-01-02 15:04")
		}
		results = append(results, ar)
	}

	return jsonResult(map[string]interface{}{
		"count":       len(results),
		"automations": results,
	}), nil
}

// ──── get_automation_detail ────
func (s *MCPServer) toolGetAutomationDetail(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	accountID, err := s.getAccountID(ctx)
	if err != nil {
		return errResult("no se pudo determinar la cuenta"), nil
	}

	automationID, err := uuidArg(req, "automation_id")
	if err != nil {
		return errResult("automation_id inválido"), nil
	}

	automation, err := s.repos.Automation.GetByID(ctx, automationID, accountID)
	if err != nil || automation == nil {
		return errResult("automatización no encontrada"), nil
	}

	detail := map[string]interface{}{
		"id":              automation.ID.String(),
		"name":            automation.Name,
		"description":     automation.Description,
		"trigger_type":    automation.TriggerType,
		"is_active":       automation.IsActive,
		"execution_count": automation.ExecutionCount,
	}
	if automation.LastTriggeredAt != nil {
		detail["last_triggered_at"] = automation.LastTriggeredAt.Format("2006-01-02 15:04")
	}

	// Recent executions
	executions, err := s.repos.Automation.GetRecentExecutions(ctx, automationID, accountID, 20)
	if err == nil {
		type execResult struct {
			ID          string `json:"id"`
			Status      string `json:"status"`
			StartedAt   string `json:"started_at"`
			CompletedAt string `json:"completed_at,omitempty"`
			Error       string `json:"error,omitempty"`
		}
		execs := make([]execResult, 0, len(executions))
		for _, e := range executions {
			er := execResult{
				ID:        e.ID.String(),
				Status:    e.Status,
				StartedAt: e.StartedAt.Format("2006-01-02 15:04"),
			}
			if e.CompletedAt != nil {
				er.CompletedAt = e.CompletedAt.Format("2006-01-02 15:04")
			}
			if e.ErrorMessage != "" {
				er.Error = e.ErrorMessage
			}
			execs = append(execs, er)
		}
		detail["recent_executions"] = execs
	}

	// Stats
	stats, err := s.repos.Automation.GetStats(ctx, automationID)
	if err == nil && stats != nil {
		detail["stats"] = stats
	}

	return jsonResult(detail), nil
}

// ──── get_contact_detail ────
func (s *MCPServer) toolGetContactDetail(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	accountID, err := s.getAccountID(ctx)
	if err != nil {
		return errResult("no se pudo determinar la cuenta"), nil
	}

	contactIDStr := stringArg(req, "contact_id")
	phone := stringArg(req, "phone")

	if contactIDStr == "" && phone == "" {
		return errResult("debes proporcionar contact_id o phone"), nil
	}

	var contactID uuid.UUID

	if contactIDStr != "" {
		cID, parseErr := uuid.Parse(contactIDStr)
		if parseErr != nil {
			return errResult("contact_id inválido"), nil
		}
		contactID = cID
	} else {
		normalizedPhone := normalizePhone(phone)
		jid := normalizedPhone + "@s.whatsapp.net"
		c, findErr := s.repos.Contact.GetByJID(ctx, accountID, jid)
		if findErr != nil || c == nil {
			return errResult("contacto no encontrado con ese teléfono"), nil
		}
		contactID = c.ID
	}

	contact, err := s.repos.Contact.GetByID(ctx, contactID)
	if err != nil || contact == nil {
		return errResult("contacto no encontrado"), nil
	}

	// Verify account ownership
	if contact.AccountID != accountID {
		return errResult("contacto no encontrado"), nil
	}

	detail := map[string]interface{}{
		"id": contact.ID.String(),
	}
	if contact.Name != nil {
		detail["name"] = *contact.Name
	}
	if contact.CustomName != nil {
		detail["custom_name"] = *contact.CustomName
	}
	if contact.PushName != nil {
		detail["push_name"] = *contact.PushName
	}
	if contact.Phone != nil {
		detail["phone"] = *contact.Phone
	}
	if contact.Email != nil {
		detail["email"] = *contact.Email
	}
	if contact.Company != nil {
		detail["company"] = *contact.Company
	}
	if contact.Notes != nil {
		detail["notes"] = *contact.Notes
	}
	if contact.JID != "" {
		detail["jid"] = contact.JID
		detail["has_whatsapp"] = true
	}

	// Check linked lead
	var leadID *uuid.UUID
	_ = s.repos.DB().QueryRow(ctx, `SELECT id FROM leads WHERE contact_id = $1 AND account_id = $2 LIMIT 1`, contact.ID, accountID).Scan(&leadID)
	if leadID != nil {
		detail["linked_lead_id"] = leadID.String()
	}

	// Last message
	var lastMsg *string
	var lastMsgAt *time.Time
	_ = s.repos.DB().QueryRow(ctx, `
		SELECT m.body, m.timestamp
		FROM messages m
		JOIN chats ch ON ch.id = m.chat_id
		WHERE ch.contact_id = $1 AND ch.account_id = $2
		ORDER BY m.timestamp DESC LIMIT 1
	`, contact.ID, accountID).Scan(&lastMsg, &lastMsgAt)
	if lastMsg != nil {
		detail["last_message"] = *lastMsg
	}
	if lastMsgAt != nil {
		detail["last_message_at"] = lastMsgAt.Format("2006-01-02 15:04")
	}

	return jsonResult(detail), nil
}

// ──── list_chats ────
func (s *MCPServer) toolListChats(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	accountID, err := s.getAccountID(ctx)
	if err != nil {
		return errResult("no se pudo determinar la cuenta"), nil
	}

	limit := intArg(req, "limit", 30, 100)

	rows, err := s.repos.DB().Query(ctx, `
		SELECT ch.id, COALESCE(c.custom_name, c.name, c.push_name, ch.jid) as display_name,
		       COALESCE(c.phone, '') as phone,
		       ch.last_message, ch.last_message_at, ch.unread_count
		FROM chats ch
		LEFT JOIN contacts c ON c.id = ch.contact_id
		WHERE ch.account_id = $1 AND ch.is_group = false
		ORDER BY ch.last_message_at DESC NULLS LAST
		LIMIT $2
	`, accountID, limit)
	if err != nil {
		return errResult("error al obtener chats: " + err.Error()), nil
	}
	defer rows.Close()

	type chatResult struct {
		ID          string `json:"id"`
		ContactName string `json:"contact_name"`
		Phone       string `json:"phone,omitempty"`
		LastMessage string `json:"last_message,omitempty"`
		LastMsgAt   string `json:"last_message_at,omitempty"`
		UnreadCount int    `json:"unread_count"`
	}

	var results []chatResult
	for rows.Next() {
		var id uuid.UUID
		var displayName, phone string
		var lastMsg *string
		var lastMsgAt *time.Time
		var unread int
		if rows.Scan(&id, &displayName, &phone, &lastMsg, &lastMsgAt, &unread) != nil {
			continue
		}
		cr := chatResult{
			ID:          id.String(),
			ContactName: displayName,
			Phone:       phone,
			UnreadCount: unread,
		}
		if lastMsg != nil {
			msg := *lastMsg
			if len(msg) > 100 {
				msg = msg[:100] + "..."
			}
			cr.LastMessage = msg
		}
		if lastMsgAt != nil {
			cr.LastMsgAt = lastMsgAt.Format("2006-01-02 15:04")
		}
		results = append(results, cr)
	}

	if results == nil {
		results = []chatResult{}
	}

	return jsonResult(map[string]interface{}{
		"count": len(results),
		"chats": results,
	}), nil
}

// ──── search_chat_messages ────
func (s *MCPServer) toolSearchChatMessages(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	accountID, err := s.getAccountID(ctx)
	if err != nil {
		return errResult("no se pudo determinar la cuenta"), nil
	}

	query := stringArg(req, "query")
	if query == "" {
		return errResult("query es requerido"), nil
	}
	limit := intArg(req, "limit", 30, 50)

	rows, err := s.repos.DB().Query(ctx, `
		SELECT m.body, m.is_from_me, m.timestamp,
		       COALESCE(c.custom_name, c.name, c.push_name, ch.jid) as contact_name,
		       COALESCE(c.phone, '') as phone
		FROM messages m
		JOIN chats ch ON ch.id = m.chat_id AND ch.account_id = $1
		LEFT JOIN contacts c ON c.id = ch.contact_id
		WHERE m.body ILIKE $2
		ORDER BY m.timestamp DESC
		LIMIT $3
	`, accountID, "%"+query+"%", limit)
	if err != nil {
		return errResult("error en búsqueda: " + err.Error()), nil
	}
	defer rows.Close()

	type msgResult struct {
		Body        string `json:"body"`
		From        string `json:"from"`
		ContactName string `json:"contact_name"`
		Phone       string `json:"phone,omitempty"`
		Timestamp   string `json:"timestamp"`
	}

	var results []msgResult
	for rows.Next() {
		var body *string
		var isFromMe bool
		var timestamp time.Time
		var contactName, phone string
		if rows.Scan(&body, &isFromMe, &timestamp, &contactName, &phone) != nil {
			continue
		}
		mr := msgResult{
			ContactName: contactName,
			Phone:       phone,
			Timestamp:   timestamp.Format("2006-01-02 15:04"),
		}
		if body != nil {
			mr.Body = *body
		}
		if isFromMe {
			mr.From = "yo"
		} else {
			mr.From = contactName
		}
		results = append(results, mr)
	}

	if results == nil {
		results = []msgResult{}
	}

	return jsonResult(map[string]interface{}{
		"count":    len(results),
		"messages": results,
	}), nil
}
