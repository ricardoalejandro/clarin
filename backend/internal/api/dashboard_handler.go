package api

import (
	"errors"
	"log"
	"math"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/service"
)

const dashboardTimezone = "America/Lima"

type dashboardPeriod struct {
	Preset       string    `json:"preset"`
	From         time.Time `json:"from"`
	To           time.Time `json:"to"`
	PreviousFrom time.Time `json:"previous_from"`
	PreviousTo   time.Time `json:"previous_to"`
}

type dashboardSections struct {
	Leads   bool `json:"leads"`
	Chats   bool `json:"chats"`
	Tasks   bool `json:"tasks"`
	Events  bool `json:"events"`
	Devices bool `json:"devices"`
}

type dashboardComparison struct {
	Current       int      `json:"current"`
	Previous      int      `json:"previous"`
	ChangePercent *float64 `json:"change_percent"`
}

type dashboardConversion struct {
	CurrentPercent  *float64 `json:"current_percent"`
	PreviousPercent *float64 `json:"previous_percent"`
	ChangePoints    *float64 `json:"change_points"`
}

type dashboardTrendPoint struct {
	Date string `json:"date"`
	New  int    `json:"new"`
	Won  int    `json:"won"`
	Lost int    `json:"lost"`
}

type dashboardPipelineStage struct {
	ID    uuid.UUID `json:"id"`
	Name  string    `json:"name"`
	Color string    `json:"color"`
	Count int       `json:"count"`
}

type dashboardPipeline struct {
	ID              uuid.UUID                `json:"id"`
	Name            string                   `json:"name"`
	UnassignedCount int                      `json:"unassigned_count"`
	Stages          []dashboardPipelineStage `json:"stages"`
}

type dashboardLeadSummary struct {
	Open       int                   `json:"open"`
	New        dashboardComparison   `json:"new"`
	Won        dashboardComparison   `json:"won"`
	Conversion dashboardConversion   `json:"conversion"`
	Trend      []dashboardTrendPoint `json:"trend"`
	Pipeline   *dashboardPipeline    `json:"pipeline,omitempty"`
}

type dashboardChatItem struct {
	ID            uuid.UUID  `json:"id"`
	DisplayName   string     `json:"display_name"`
	LastMessage   *string    `json:"last_message"`
	LastMessageAt *time.Time `json:"last_message_at"`
	LastInboundAt *time.Time `json:"last_inbound_at"`
	UnreadCount   int        `json:"unread_count"`
}

type dashboardChatSummary struct {
	Total         int                 `json:"total"`
	UnreadTotal   int                 `json:"unread_total"`
	AwaitingReply int                 `json:"awaiting_reply"`
	Items         []dashboardChatItem `json:"items"`
}

type dashboardTaskItem struct {
	ID     uuid.UUID  `json:"id"`
	Title  string     `json:"title"`
	DueAt  *time.Time `json:"due_at"`
	Status string     `json:"status"`
	Type   string     `json:"type"`
}

type dashboardTaskSummary struct {
	Overdue  int                 `json:"overdue"`
	DueToday int                 `json:"due_today"`
	Items    []dashboardTaskItem `json:"items"`
}

type dashboardEventItem struct {
	ParticipantID   uuid.UUID `json:"participant_id"`
	EventID         uuid.UUID `json:"event_id"`
	EventName       string    `json:"event_name"`
	ParticipantName string    `json:"participant_name"`
	NextAction      *string   `json:"next_action"`
	NextActionDate  time.Time `json:"next_action_date"`
}

type dashboardEventSummary struct {
	OverdueFollowups int                  `json:"overdue_followups"`
	DueNext7Days     int                  `json:"due_next_7_days"`
	Items            []dashboardEventItem `json:"items"`
}

type dashboardDeviceItem struct {
	ID     uuid.UUID `json:"id"`
	Name   string    `json:"name"`
	Phone  *string   `json:"phone"`
	Status string    `json:"status"`
}

type dashboardDeviceSummary struct {
	Total        int                   `json:"total"`
	Connected    int                   `json:"connected"`
	Connecting   int                   `json:"connecting"`
	Disconnected int                   `json:"disconnected"`
	Issues       []dashboardDeviceItem `json:"issues"`
}

type dashboardSummary struct {
	GeneratedAt time.Time               `json:"generated_at"`
	Timezone    string                  `json:"timezone"`
	Period      dashboardPeriod         `json:"period"`
	Sections    dashboardSections       `json:"sections"`
	Leads       *dashboardLeadSummary   `json:"leads,omitempty"`
	Chats       *dashboardChatSummary   `json:"chats,omitempty"`
	Tasks       *dashboardTaskSummary   `json:"tasks,omitempty"`
	Events      *dashboardEventSummary  `json:"events,omitempty"`
	Devices     *dashboardDeviceSummary `json:"devices,omitempty"`
}

func dashboardLocation() *time.Location {
	location, err := time.LoadLocation(dashboardTimezone)
	if err != nil {
		return time.FixedZone(dashboardTimezone, -5*60*60)
	}
	return location
}

func resolveDashboardPeriod(raw string, now time.Time) (dashboardPeriod, error) {
	preset := strings.ToLower(strings.TrimSpace(raw))
	if preset == "" {
		preset = "30d"
	}

	days := 0
	switch preset {
	case "7d":
		days = 7
	case "30d":
		days = 30
	case "90d":
		days = 90
	default:
		return dashboardPeriod{}, errors.New("invalid dashboard period")
	}

	location := dashboardLocation()
	localNow := now.In(location)
	today := time.Date(localNow.Year(), localNow.Month(), localNow.Day(), 0, 0, 0, 0, location)
	from := today.AddDate(0, 0, -(days - 1))
	to := today.AddDate(0, 0, 1)
	previousFrom := from.AddDate(0, 0, -days)

	return dashboardPeriod{
		Preset:       preset,
		From:         from,
		To:           to,
		PreviousFrom: previousFrom,
		PreviousTo:   from,
	}, nil
}

func dashboardPercentChange(current, previous int) *float64 {
	if previous == 0 {
		return nil
	}
	value := math.Round(((float64(current-previous)/float64(previous))*100)*10) / 10
	return &value
}

func dashboardConversionRate(won, lost int) *float64 {
	total := won + lost
	if total == 0 {
		return nil
	}
	value := math.Round((float64(won)/float64(total)*100)*10) / 10
	return &value
}

func dashboardPointDifference(current, previous *float64) *float64 {
	if current == nil || previous == nil {
		return nil
	}
	value := math.Round((*current-*previous)*10) / 10
	return &value
}

func dashboardHasPermission(claims *service.JWTClaims, module string) bool {
	if claims == nil {
		return false
	}
	if claims.IsAdmin || claims.IsSuperAdmin || claims.Role == domain.RoleAdmin || claims.Role == domain.RoleSuperAdmin {
		return true
	}
	for _, permission := range claims.Permissions {
		if permission == domain.PermAll || permission == module {
			return true
		}
	}
	return false
}

func dashboardClaimsAreAdmin(claims *service.JWTClaims) bool {
	return claims != nil && (claims.IsAdmin || claims.IsSuperAdmin || claims.Role == domain.RoleAdmin || claims.Role == domain.RoleSuperAdmin)
}

func (s *Server) handleGetDashboardSummary(c *fiber.Ctx) error {
	claims, ok := c.Locals("claims").(*service.JWTClaims)
	if !ok || claims == nil {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"success": false, "error": "Unauthorized"})
	}

	period, err := resolveDashboardPeriod(c.Query("period"), time.Now())
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success": false,
			"error":   "El periodo debe ser 7d, 30d o 90d",
		})
	}

	isAdmin := dashboardClaimsAreAdmin(claims)
	if !isAdmin {
		var currentRole string
		if roleErr := s.repos.DB().QueryRow(c.Context(), `
			SELECT role FROM user_accounts WHERE user_id=$1 AND account_id=$2
		`, claims.UserID, claims.AccountID).Scan(&currentRole); roleErr == nil {
			isAdmin = currentRole == domain.RoleAdmin || currentRole == domain.RoleSuperAdmin
		}
	}
	sections := dashboardSections{
		Leads:   isAdmin || dashboardHasPermission(claims, domain.PermLeads),
		Chats:   isAdmin || dashboardHasPermission(claims, domain.PermChats),
		Tasks:   isAdmin || dashboardHasPermission(claims, domain.PermTasks),
		Events:  isAdmin || dashboardHasPermission(claims, domain.PermEvents),
		Devices: isAdmin || dashboardHasPermission(claims, domain.PermDevices),
	}
	summary := &dashboardSummary{
		GeneratedAt: time.Now().UTC(),
		Timezone:    dashboardTimezone,
		Period:      period,
		Sections:    sections,
	}

	if sections.Leads {
		summary.Leads, err = s.getDashboardLeadSummary(c, claims.AccountID, period)
		if err != nil {
			return dashboardLoadError(c, "leads", err)
		}
	}
	if sections.Chats {
		summary.Chats, err = s.getDashboardChatSummary(c, claims.AccountID)
		if err != nil {
			return dashboardLoadError(c, "chats", err)
		}
	}
	if sections.Tasks {
		summary.Tasks, err = s.getDashboardTaskSummary(c, claims.AccountID, claims.UserID)
		if err != nil {
			return dashboardLoadError(c, "tasks", err)
		}
	}
	if sections.Events {
		summary.Events, err = s.getDashboardEventSummary(c, claims.AccountID)
		if err != nil {
			return dashboardLoadError(c, "events", err)
		}
	}
	if sections.Devices {
		summary.Devices, err = s.getDashboardDeviceSummary(c, claims.AccountID)
		if err != nil {
			return dashboardLoadError(c, "devices", err)
		}
	}

	return c.JSON(fiber.Map{"success": true, "dashboard": summary})
}

func dashboardLoadError(c *fiber.Ctx, section string, err error) error {
	log.Printf("dashboard summary %s query failed: %v", section, err)
	return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
		"success": false,
		"error":   "No se pudo cargar el resumen del dashboard",
	})
}

func (s *Server) getDashboardLeadSummary(c *fiber.Ctx, accountID uuid.UUID, period dashboardPeriod) (*dashboardLeadSummary, error) {
	var open, currentNew, previousNew, currentWon, previousWon, currentLost, previousLost int
	err := s.repos.DB().QueryRow(c.Context(), `
		SELECT
			COUNT(*) FILTER (WHERE l.deleted_at IS NULL AND l.is_archived=FALSE AND l.status='open'),
			COUNT(*) FILTER (WHERE l.deleted_at IS NULL AND l.created_at >= $2 AND l.created_at < $3),
			COUNT(*) FILTER (WHERE l.deleted_at IS NULL AND l.created_at >= $4 AND l.created_at < $5),
			COUNT(*) FILTER (WHERE l.deleted_at IS NULL AND l.is_archived=FALSE AND l.status='won' AND l.closed_at >= $2 AND l.closed_at < $3),
			COUNT(*) FILTER (WHERE l.deleted_at IS NULL AND l.is_archived=FALSE AND l.status='won' AND l.closed_at >= $4 AND l.closed_at < $5),
			COUNT(*) FILTER (WHERE l.deleted_at IS NULL AND l.is_archived=FALSE AND l.status='lost' AND l.closed_at >= $2 AND l.closed_at < $3),
			COUNT(*) FILTER (WHERE l.deleted_at IS NULL AND l.is_archived=FALSE AND l.status='lost' AND l.closed_at >= $4 AND l.closed_at < $5)
		FROM leads l
		JOIN contacts contact ON contact.id=l.contact_id AND contact.account_id=l.account_id
		WHERE l.account_id=$1 AND l.contact_id IS NOT NULL
	`, accountID, period.From, period.To, period.PreviousFrom, period.PreviousTo).Scan(
		&open, &currentNew, &previousNew, &currentWon, &previousWon, &currentLost, &previousLost,
	)
	if err != nil {
		return nil, err
	}

	currentConversion := dashboardConversionRate(currentWon, currentLost)
	previousConversion := dashboardConversionRate(previousWon, previousLost)
	summary := &dashboardLeadSummary{
		Open: open,
		New: dashboardComparison{
			Current:       currentNew,
			Previous:      previousNew,
			ChangePercent: dashboardPercentChange(currentNew, previousNew),
		},
		Won: dashboardComparison{
			Current:       currentWon,
			Previous:      previousWon,
			ChangePercent: dashboardPercentChange(currentWon, previousWon),
		},
		Conversion: dashboardConversion{
			CurrentPercent:  currentConversion,
			PreviousPercent: previousConversion,
			ChangePoints:    dashboardPointDifference(currentConversion, previousConversion),
		},
		Trend: make([]dashboardTrendPoint, 0),
	}

	trendByDate := make(map[string]*dashboardTrendPoint)
	for cursor := period.From; cursor.Before(period.To); cursor = cursor.AddDate(0, 0, 1) {
		date := cursor.Format("2006-01-02")
		trendByDate[date] = &dashboardTrendPoint{Date: date}
	}
	rows, err := s.repos.DB().Query(c.Context(), `
		SELECT day, SUM(new_count)::int, SUM(won_count)::int, SUM(lost_count)::int
		FROM (
			SELECT (l.created_at AT TIME ZONE $4)::date AS day, COUNT(*)::int AS new_count, 0::int AS won_count, 0::int AS lost_count
			FROM leads l
			JOIN contacts contact ON contact.id=l.contact_id AND contact.account_id=l.account_id
			WHERE l.account_id=$1 AND l.contact_id IS NOT NULL AND l.deleted_at IS NULL AND l.created_at >= $2 AND l.created_at < $3
			GROUP BY day
			UNION ALL
			SELECT (l.closed_at AT TIME ZONE $4)::date AS day, 0::int AS new_count,
				COUNT(*) FILTER (WHERE l.status='won')::int AS won_count,
				COUNT(*) FILTER (WHERE l.status='lost')::int AS lost_count
			FROM leads l
			JOIN contacts contact ON contact.id=l.contact_id AND contact.account_id=l.account_id
			WHERE l.account_id=$1 AND l.contact_id IS NOT NULL AND l.deleted_at IS NULL AND l.is_archived=FALSE
				AND l.status IN ('won','lost') AND l.closed_at >= $2 AND l.closed_at < $3
			GROUP BY day
		) activity
		GROUP BY day
		ORDER BY day
	`, accountID, period.From, period.To, dashboardTimezone)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var day time.Time
		var newCount, wonCount, lostCount int
		if err := rows.Scan(&day, &newCount, &wonCount, &lostCount); err != nil {
			return nil, err
		}
		date := day.Format("2006-01-02")
		if point, exists := trendByDate[date]; exists {
			point.New = newCount
			point.Won = wonCount
			point.Lost = lostCount
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for cursor := period.From; cursor.Before(period.To); cursor = cursor.AddDate(0, 0, 1) {
		summary.Trend = append(summary.Trend, *trendByDate[cursor.Format("2006-01-02")])
	}

	summary.Pipeline, err = s.getDashboardPipeline(c, accountID)
	if err != nil {
		return nil, err
	}
	return summary, nil
}

func (s *Server) getDashboardPipeline(c *fiber.Ctx, accountID uuid.UUID) (*dashboardPipeline, error) {
	pipeline := &dashboardPipeline{Stages: make([]dashboardPipelineStage, 0)}
	err := s.repos.DB().QueryRow(c.Context(), `
		SELECT id, name
		FROM pipelines
		WHERE account_id=$1
		ORDER BY is_default DESC, created_at ASC
		LIMIT 1
	`, accountID).Scan(&pipeline.ID, &pipeline.Name)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	rows, err := s.repos.DB().Query(c.Context(), `
		SELECT ps.id, ps.name, COALESCE(ps.color, '#94a3b8'), COUNT(l.id) FILTER (WHERE contact.id IS NOT NULL)::int
		FROM pipeline_stages ps
		LEFT JOIN leads l ON l.stage_id=ps.id AND l.account_id=$1 AND l.pipeline_id=$2
			AND l.deleted_at IS NULL AND l.is_archived=FALSE AND l.status='open'
		LEFT JOIN contacts contact ON contact.id=l.contact_id AND contact.account_id=l.account_id
		WHERE ps.pipeline_id=$2
		GROUP BY ps.id, ps.name, ps.color, ps.position
		ORDER BY ps.position ASC, ps.name ASC
	`, accountID, pipeline.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		stage := dashboardPipelineStage{}
		if err := rows.Scan(&stage.ID, &stage.Name, &stage.Color, &stage.Count); err != nil {
			return nil, err
		}
		pipeline.Stages = append(pipeline.Stages, stage)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	err = s.repos.DB().QueryRow(c.Context(), `
		SELECT COUNT(*)
		FROM leads l
		JOIN contacts contact ON contact.id=l.contact_id AND contact.account_id=l.account_id
		WHERE l.account_id=$1 AND l.pipeline_id=$2 AND l.stage_id IS NULL
			AND l.contact_id IS NOT NULL AND l.deleted_at IS NULL AND l.is_archived=FALSE AND l.status='open'
	`, accountID, pipeline.ID).Scan(&pipeline.UnassignedCount)
	if err != nil {
		return nil, err
	}
	return pipeline, nil
}

func (s *Server) getDashboardChatSummary(c *fiber.Ctx, accountID uuid.UUID) (*dashboardChatSummary, error) {
	summary := &dashboardChatSummary{Items: make([]dashboardChatItem, 0)}
	rows, err := s.repos.DB().Query(c.Context(), `
		WITH message_activity AS (
			SELECT m.chat_id,
				MAX(m.timestamp) FILTER (WHERE m.is_from_me=FALSE) AS last_inbound_at,
				MAX(m.timestamp) FILTER (WHERE m.is_from_me=TRUE) AS last_outbound_at
			FROM messages m
			WHERE m.account_id=$1 AND NOT COALESCE(m.is_revoked,FALSE)
			GROUP BY m.chat_id
		), eligible AS (
			SELECT ch.id, ch.contact_id, ch.name, ch.last_message, ch.last_message_at, ch.unread_count,
				GREATEST(ch.last_inbound_at, message_activity.last_inbound_at) AS effective_last_inbound_at,
				GREATEST(ch.last_outbound_at, message_activity.last_outbound_at) AS effective_last_outbound_at
			FROM chats ch
			LEFT JOIN message_activity ON message_activity.chat_id=ch.id
			WHERE ch.account_id=$1 AND ch.is_archived=FALSE
				AND ch.jid NOT LIKE '%@g.us' AND ch.jid NOT LIKE '%@newsletter'
				AND ch.jid NOT LIKE '%@broadcast' AND ch.jid NOT LIKE '%@lid'
		), totals AS (
			SELECT COUNT(*)::int AS total, COALESCE(SUM(unread_count),0)::int AS unread_total,
			COUNT(*) FILTER (WHERE effective_last_inbound_at IS NOT NULL AND (effective_last_outbound_at IS NULL OR effective_last_inbound_at > effective_last_outbound_at))::int
				AS awaiting_reply
			FROM eligible
		), ranked AS (
			SELECT eligible.id,
				CASE WHEN eligible.contact_id IS NULL
				  THEN COALESCE(NULLIF(BTRIM(eligible.name),''),'Sin nombre')
				  ELSE COALESCE(NULLIF(BTRIM(contact.custom_name),''),NULLIF(BTRIM(contact.name),''),NULLIF(BTRIM(contact.push_name),''),NULLIF(BTRIM(contact.phone),''),'Sin nombre')
				END AS display_name,
				eligible.last_message, eligible.last_message_at, eligible.effective_last_inbound_at, eligible.unread_count,
				ROW_NUMBER() OVER (ORDER BY eligible.effective_last_inbound_at ASC, eligible.id ASC) AS row_number
			FROM eligible
			LEFT JOIN contacts contact ON contact.id=eligible.contact_id AND contact.account_id=$1
			WHERE eligible.effective_last_inbound_at IS NOT NULL
				AND (eligible.effective_last_outbound_at IS NULL OR eligible.effective_last_inbound_at > eligible.effective_last_outbound_at)
		)
		SELECT totals.total, totals.unread_total, totals.awaiting_reply,
			ranked.id, ranked.display_name, ranked.last_message, ranked.last_message_at,
			ranked.effective_last_inbound_at, ranked.unread_count
		FROM totals
		LEFT JOIN ranked ON ranked.row_number <= 5
		ORDER BY ranked.row_number NULLS LAST
	`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id *uuid.UUID
		var displayName, lastMessage *string
		var lastMessageAt, lastInboundAt *time.Time
		var unreadCount *int
		if err := rows.Scan(
			&summary.Total, &summary.UnreadTotal, &summary.AwaitingReply,
			&id, &displayName, &lastMessage, &lastMessageAt, &lastInboundAt, &unreadCount,
		); err != nil {
			return nil, err
		}
		if id != nil {
			item := dashboardChatItem{ID: *id, LastMessage: lastMessage, LastMessageAt: lastMessageAt, LastInboundAt: lastInboundAt}
			if displayName != nil {
				item.DisplayName = *displayName
			}
			if unreadCount != nil {
				item.UnreadCount = *unreadCount
			}
			summary.Items = append(summary.Items, item)
		}
	}
	return summary, rows.Err()
}

func (s *Server) getDashboardTaskSummary(c *fiber.Ctx, accountID, userID uuid.UUID) (*dashboardTaskSummary, error) {
	summary := &dashboardTaskSummary{Items: make([]dashboardTaskItem, 0)}
	now := time.Now()
	localNow := now.In(dashboardLocation())
	tomorrow := time.Date(localNow.Year(), localNow.Month(), localNow.Day(), 0, 0, 0, 0, dashboardLocation()).AddDate(0, 0, 1)

	err := s.repos.DB().QueryRow(c.Context(), `
		SELECT
			COUNT(*) FILTER (WHERE due_at < $3)::int,
			COUNT(*) FILTER (WHERE due_at >= $3 AND due_at < $4)::int
		FROM tasks
		WHERE account_id=$1 AND assigned_to=$2 AND status IN ('pending','overdue') AND due_at IS NOT NULL
	`, accountID, userID, now, tomorrow).Scan(&summary.Overdue, &summary.DueToday)
	if err != nil {
		return nil, err
	}

	rows, err := s.repos.DB().Query(c.Context(), `
		SELECT id, title, due_at, status, type
		FROM tasks
		WHERE account_id=$1 AND assigned_to=$2 AND status IN ('pending','overdue')
			AND due_at IS NOT NULL AND due_at < $3
		ORDER BY due_at ASC, id ASC
		LIMIT 5
	`, accountID, userID, tomorrow)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		item := dashboardTaskItem{}
		if err := rows.Scan(&item.ID, &item.Title, &item.DueAt, &item.Status, &item.Type); err != nil {
			return nil, err
		}
		summary.Items = append(summary.Items, item)
	}
	return summary, rows.Err()
}

func (s *Server) getDashboardEventSummary(c *fiber.Ctx, accountID uuid.UUID) (*dashboardEventSummary, error) {
	summary := &dashboardEventSummary{Items: make([]dashboardEventItem, 0)}
	now := time.Now()
	next7Days := now.AddDate(0, 0, 7)
	err := s.repos.DB().QueryRow(c.Context(), `
		SELECT
			COUNT(*) FILTER (WHERE ep.next_action_date < $2)::int,
			COUNT(*) FILTER (WHERE ep.next_action_date >= $2 AND ep.next_action_date < $3)::int
		FROM event_participants ep
		JOIN events e ON e.id=ep.event_id AND e.account_id=$1
		WHERE ep.membership_state='active' AND ep.next_action_date IS NOT NULL
			AND ep.status NOT IN ('attended','no_show','declined') AND e.status NOT IN ('completed','cancelled')
	`, accountID, now, next7Days).Scan(&summary.OverdueFollowups, &summary.DueNext7Days)
	if err != nil {
		return nil, err
	}

	rows, err := s.repos.DB().Query(c.Context(), `
		SELECT ep.id,e.id,e.name,
			CASE WHEN COALESCE(ep.contact_id,l.contact_id) IS NULL
			  THEN COALESCE(NULLIF(BTRIM(ep.name),''),'Sin nombre')
			  ELSE COALESCE(NULLIF(BTRIM(contact.custom_name),''),NULLIF(BTRIM(contact.name),''),NULLIF(BTRIM(contact.push_name),''),'Sin nombre')
			END,
			ep.next_action, ep.next_action_date
		FROM event_participants ep
		JOIN events e ON e.id=ep.event_id AND e.account_id=$1
		LEFT JOIN leads l ON l.id=ep.lead_id AND l.account_id=e.account_id
		LEFT JOIN contacts contact ON contact.id=COALESCE(ep.contact_id,l.contact_id) AND contact.account_id=e.account_id
		WHERE ep.membership_state='active' AND ep.next_action_date IS NOT NULL AND ep.next_action_date < $2
			AND ep.status NOT IN ('attended','no_show','declined') AND e.status NOT IN ('completed','cancelled')
		ORDER BY ep.next_action_date ASC, ep.id ASC
		LIMIT 5
	`, accountID, next7Days)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		item := dashboardEventItem{}
		if err := rows.Scan(&item.ParticipantID, &item.EventID, &item.EventName, &item.ParticipantName, &item.NextAction, &item.NextActionDate); err != nil {
			return nil, err
		}
		summary.Items = append(summary.Items, item)
	}
	return summary, rows.Err()
}

func (s *Server) getDashboardDeviceSummary(c *fiber.Ctx, accountID uuid.UUID) (*dashboardDeviceSummary, error) {
	summary := &dashboardDeviceSummary{Issues: make([]dashboardDeviceItem, 0)}
	err := s.repos.DB().QueryRow(c.Context(), `
		SELECT COUNT(*)::int,
			COUNT(*) FILTER (WHERE status='connected')::int,
			COUNT(*) FILTER (WHERE status='connecting')::int,
			COUNT(*) FILTER (WHERE status IS NULL OR status NOT IN ('connected','connecting'))::int
		FROM devices
		WHERE account_id=$1
	`, accountID).Scan(&summary.Total, &summary.Connected, &summary.Connecting, &summary.Disconnected)
	if err != nil {
		return nil, err
	}

	rows, err := s.repos.DB().Query(c.Context(), `
		SELECT id, COALESCE(NULLIF(BTRIM(name),''), 'Dispositivo'), phone, COALESCE(status, 'disconnected')
		FROM devices
		WHERE account_id=$1 AND (status IS NULL OR status <> 'connected')
		ORDER BY CASE WHEN status='connecting' THEN 1 ELSE 0 END, name ASC, id ASC
		LIMIT 5
	`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		item := dashboardDeviceItem{}
		if err := rows.Scan(&item.ID, &item.Name, &item.Phone, &item.Status); err != nil {
			return nil, err
		}
		summary.Issues = append(summary.Issues, item)
	}
	return summary, rows.Err()
}
