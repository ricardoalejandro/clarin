package api

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/ws"
)

type workEventAttendeeRequest struct {
	UserID         string `json:"user_id"`
	AttendanceType string `json:"attendance_type"`
}

type workEventMutationRequest struct {
	Title            *string                     `json:"title"`
	Description      *string                     `json:"description"`
	Location         *string                     `json:"location"`
	MeetingURL       *string                     `json:"meeting_url"`
	ListID           *string                     `json:"list_id"`
	Color            json.RawMessage             `json:"color"`
	Availability     *string                     `json:"availability"`
	IsAllDay         *bool                       `json:"is_all_day"`
	StartAt          *string                     `json:"start_at"`
	EndAt            *string                     `json:"end_at"`
	StartDate        *string                     `json:"start_date"`
	EndDateExclusive *string                     `json:"end_date_exclusive"`
	Timezone         *string                     `json:"timezone"`
	RecurrenceRule   *string                     `json:"recurrence_rule"`
	Attendees        *[]workEventAttendeeRequest `json:"attendees"`
	Version          int64                       `json:"version"`
	OperationID      string                      `json:"operation_id"`
	ConfirmConflicts bool                        `json:"confirm_conflicts"`
	Scope            string                      `json:"scope"`
	OccurrenceKey    string                      `json:"occurrence_key"`
	CancelOccurrence bool                        `json:"cancel_occurrence"`
}

func workEventError(c *fiber.Ctx, err error) error {
	var conflict *repository.WorkEventConflictConfirmationError
	switch {
	case errors.As(err, &conflict):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "code": "schedule_conflict_confirmation_required",
			"error": "El horario se cruza con otro compromiso", "conflicts": conflict.Conflicts})
	case errors.Is(err, repository.ErrWorkEventVersionConflict):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "code": "version_conflict", "error": "El evento cambió en otra sesión"})
	case errors.Is(err, repository.ErrWorkEventNotFound):
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"success": false, "error": "Evento no encontrado"})
	case errors.Is(err, repository.ErrWorkEventAccessDenied):
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"success": false, "error": "No tienes permiso para editar este evento"})
	case errors.Is(err, repository.ErrWorkEventCancelRequired):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "code": "event_cancel_required", "error": "Cancela el evento compartido antes de moverlo a Papelera"})
	case errors.Is(err, repository.ErrWorkEventPurgeForbidden):
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"success": false, "error": "El evento aún no puede eliminarse definitivamente"})
	case errors.Is(err, repository.ErrWorkEventInvalid), errors.Is(err, repository.ErrWorkEventRecurrenceInvalid):
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{"success": false, "error": "Los datos del evento no son válidos"})
	default:
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudo guardar el evento"})
	}
}

func parseNullableWorkColor(raw json.RawMessage, current *string) (*string, error) {
	if len(raw) == 0 {
		return current, nil
	}
	if string(raw) == "null" {
		return nil, nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, errTaskColorInvalid
	}
	normalized, err := normalizeTaskColor(value, "")
	if err != nil {
		return nil, err
	}
	return &normalized, nil
}

func parseWorkEventDate(raw string) (*string, error) {
	value := strings.TrimSpace(raw)
	parsed, err := time.Parse("2006-01-02", value)
	if err != nil || parsed.Format("2006-01-02") != value {
		return nil, repository.ErrWorkEventInvalid
	}
	return &value, nil
}

func applyWorkEventRequest(event *domain.WorkEvent, req workEventMutationRequest, accountID, actorID uuid.UUID, creating bool) error {
	if req.Title != nil {
		event.Title = strings.TrimSpace(*req.Title)
	}
	if event.Title == "" || len([]rune(event.Title)) > 255 {
		return repository.ErrWorkEventInvalid
	}
	if req.Description != nil {
		event.Description = *req.Description
	}
	if req.Location != nil {
		event.Location = strings.TrimSpace(*req.Location)
	}
	if len([]rune(event.Location)) > 500 {
		return repository.ErrWorkEventInvalid
	}
	if req.MeetingURL != nil {
		event.MeetingURL = strings.TrimSpace(*req.MeetingURL)
	}
	if event.MeetingURL != "" {
		parsed, err := url.ParseRequestURI(event.MeetingURL)
		if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Host == "" {
			return repository.ErrWorkEventInvalid
		}
	}
	if req.ListID != nil {
		listID, err := uuid.Parse(strings.TrimSpace(*req.ListID))
		if err != nil {
			return repository.ErrWorkEventInvalid
		}
		event.ListID = listID
	}
	if event.ListID == uuid.Nil {
		return repository.ErrWorkEventInvalid
	}
	color, err := parseNullableWorkColor(req.Color, event.Color)
	if err != nil {
		return repository.ErrWorkEventInvalid
	}
	event.Color = color
	if req.Availability != nil {
		event.Availability = strings.ToLower(strings.TrimSpace(*req.Availability))
	}
	if event.Availability == "" {
		event.Availability = domain.WorkEventAvailabilityBusy
	}
	if event.Availability != domain.WorkEventAvailabilityBusy && event.Availability != domain.WorkEventAvailabilityFree {
		return repository.ErrWorkEventInvalid
	}
	previousAllDay := event.IsAllDay
	if req.IsAllDay != nil {
		event.IsAllDay = *req.IsAllDay
	}
	if req.Timezone != nil {
		event.Timezone = strings.TrimSpace(*req.Timezone)
	}
	if event.Timezone == "" {
		event.Timezone = "America/Lima"
	}
	loc, err := time.LoadLocation(event.Timezone)
	if err != nil {
		return repository.ErrWorkEventInvalid
	}
	if event.IsAllDay {
		if creating || !previousAllDay || req.StartDate != nil {
			if req.StartDate == nil {
				return repository.ErrWorkEventInvalid
			}
			event.StartDate, err = parseWorkEventDate(*req.StartDate)
			if err != nil {
				return err
			}
		}
		if creating || !previousAllDay || req.EndDateExclusive != nil {
			if req.EndDateExclusive == nil {
				return repository.ErrWorkEventInvalid
			}
			event.EndDateExclusive, err = parseWorkEventDate(*req.EndDateExclusive)
			if err != nil {
				return err
			}
		}
		event.StartAt, event.EndAt = nil, nil
		startDate, _ := time.ParseInLocation("2006-01-02", *event.StartDate, loc)
		endDate, _ := time.ParseInLocation("2006-01-02", *event.EndDateExclusive, loc)
		if !startDate.Before(endDate) {
			return repository.ErrWorkEventInvalid
		}
	} else {
		if creating || previousAllDay || req.StartAt != nil {
			if req.StartAt == nil {
				return repository.ErrWorkEventInvalid
			}
			value, parseErr := time.Parse(time.RFC3339, strings.TrimSpace(*req.StartAt))
			if parseErr != nil {
				return repository.ErrWorkEventInvalid
			}
			event.StartAt = &value
		}
		if creating || previousAllDay || req.EndAt != nil {
			if req.EndAt == nil {
				return repository.ErrWorkEventInvalid
			}
			value, parseErr := time.Parse(time.RFC3339, strings.TrimSpace(*req.EndAt))
			if parseErr != nil {
				return repository.ErrWorkEventInvalid
			}
			event.EndAt = &value
		}
		event.StartDate, event.EndDateExclusive = nil, nil
		if event.StartAt == nil || event.EndAt == nil || !event.StartAt.Before(*event.EndAt) {
			return repository.ErrWorkEventInvalid
		}
	}
	if req.RecurrenceRule != nil {
		event.RecurrenceRule = strings.ToUpper(strings.TrimSpace(*req.RecurrenceRule))
	}
	if _, err := repository.ParseWorkEventRecurrence(event.RecurrenceRule, loc); err != nil {
		return err
	}
	if req.Attendees != nil {
		existingAttendees := make(map[uuid.UUID]*domain.WorkEventAttendee, len(event.Attendees))
		for _, attendee := range event.Attendees {
			if attendee != nil {
				existingAttendees[attendee.UserID] = attendee
			}
		}
		event.AttendeesSet = true
		event.Attendees = make([]*domain.WorkEventAttendee, 0, len(*req.Attendees))
		seen := map[uuid.UUID]bool{}
		for _, input := range *req.Attendees {
			userID, parseErr := uuid.Parse(strings.TrimSpace(input.UserID))
			if parseErr != nil || seen[userID] {
				return repository.ErrWorkEventInvalid
			}
			seen[userID] = true
			attendanceType := strings.ToLower(strings.TrimSpace(input.AttendanceType))
			if attendanceType == "" {
				attendanceType = "required"
			}
			rsvp := domain.WorkEventRSVPPending
			var reminderMinutes *int
			if existing := existingAttendees[userID]; existing != nil {
				rsvp = existing.RSVP
				reminderMinutes = existing.ReminderMinutes
			}
			if userID == event.OrganizerID || userID == actorID && creating {
				rsvp = domain.WorkEventRSVPAccepted
			}
			event.Attendees = append(event.Attendees, &domain.WorkEventAttendee{UserID: userID, AttendanceType: attendanceType, RSVP: rsvp, ReminderMinutes: reminderMinutes})
		}
	}
	event.AccountID = accountID
	return nil
}

func uuidQuery(value string) (*uuid.UUID, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, nil
	}
	parsed, err := uuid.Parse(value)
	if err != nil {
		return nil, err
	}
	return &parsed, nil
}

type agendaCursor struct {
	Sort string `json:"sort"`
	Key  string `json:"key"`
}

type agendaResponseItem struct {
	Kind  string                      `json:"kind"`
	Key   string                      `json:"key"`
	Sort  string                      `json:"-"`
	Task  *domain.Task                `json:"task,omitempty"`
	Event *domain.WorkEventOccurrence `json:"event,omitempty"`
}

func agendaItemSort(item agendaResponseItem) string {
	return item.Sort + "|" + item.Key
}

func encodeAgendaCursor(item agendaResponseItem) string {
	raw, _ := json.Marshal(agendaCursor{Sort: item.Sort, Key: item.Key})
	return base64.RawURLEncoding.EncodeToString(raw)
}

func decodeAgendaCursor(raw string) (*agendaCursor, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return nil, err
	}
	var cursor agendaCursor
	if err := json.Unmarshal(decoded, &cursor); err != nil || cursor.Sort == "" || cursor.Key == "" {
		return nil, errors.New("invalid cursor")
	}
	return &cursor, nil
}

func parseAgendaSources(raw string) (bool, bool, error) {
	includeTasks, includeEvents := false, false
	for _, source := range strings.Split(strings.ToLower(strings.TrimSpace(raw)), ",") {
		switch strings.TrimSpace(source) {
		case "tasks":
			includeTasks = true
		case "events":
			includeEvents = true
		case "":
		default:
			return false, false, errors.New("invalid agenda source")
		}
	}
	if !includeTasks && !includeEvents {
		return false, false, errors.New("empty agenda sources")
	}
	return includeTasks, includeEvents, nil
}

func (s *Server) handleGetTaskAgenda(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	actorID := c.Locals("user_id").(uuid.UUID)
	from, err := time.Parse(time.RFC3339, c.Query("from"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Rango inicial inválido"})
	}
	to, err := time.Parse(time.RFC3339, c.Query("to"))
	if err != nil || !from.Before(to) || to.Sub(from) > 400*24*time.Hour {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Rango final inválido"})
	}
	limit := 50
	if value, parseErr := strconv.Atoi(c.Query("limit", "50")); parseErr == nil {
		limit = value
	}
	if limit < 1 {
		limit = 1
	}
	if limit > 200 {
		limit = 200
	}
	cursor, err := decodeAgendaCursor(c.Query("cursor"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Cursor inválido"})
	}
	environmentID, err := uuidQuery(c.Query("environment_id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Entorno inválido"})
	}
	folderID, err := uuidQuery(c.Query("folder_id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Carpeta inválida"})
	}
	listID, err := uuidQuery(c.Query("list_id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Lista inválida"})
	}
	includeTasks, includeEvents, err := parseAgendaSources(c.Query("sources", "tasks,events"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Fuentes de agenda inválidas"})
	}
	items := make([]agendaResponseItem, 0, limit+1)
	var afterSort *time.Time
	afterKey := ""
	if cursor != nil {
		value, parseErr := time.Parse(time.RFC3339Nano, cursor.Sort)
		if parseErr != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Cursor inválido"})
		}
		afterSort, afterKey = &value, cursor.Key
	}
	if includeTasks {
		tasks, taskErr := s.repos.Task.GetAgendaRangeForActor(c.Context(), accountID, actorID, from, to, environmentID, folderID, listID,
			strings.EqualFold(c.Query("include_closed"), "true"), afterSort, afterKey, limit+1)
		if taskErr != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudo cargar la agenda"})
		}
		if err := s.repos.TaskWork.ApplyTaskAccess(c.Context(), accountID, actorID, tasks); err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudo autorizar la agenda"})
		}
		for _, task := range tasks {
			start := task.StartAt
			if start == nil {
				start = task.DueAt
			}
			if start == nil {
				continue
			}
			items = append(items, agendaResponseItem{Kind: "task", Key: "task:" + task.ID.String(), Sort: start.UTC().Format(time.RFC3339Nano), Task: task})
		}
	}
	if includeEvents {
		events, eventErr := s.repos.WorkEvent.ListAgenda(c.Context(), accountID, actorID, from, to, environmentID, folderID, listID, afterSort, afterKey, limit+1)
		if eventErr != nil {
			return workEventError(c, eventErr)
		}
		for _, occurrence := range events {
			sortValue := ""
			if occurrence.StartDate != nil {
				sortValue = *occurrence.StartDate + "T00:00:00.000000000Z"
			} else if occurrence.StartAt != nil {
				sortValue = occurrence.StartAt.UTC().Format(time.RFC3339Nano)
			}
			key := "event:" + occurrence.Event.ID.String() + ":" + occurrence.OccurrenceKey
			items = append(items, agendaResponseItem{Kind: "event", Key: key, Sort: sortValue, Event: occurrence})
		}
	}
	sort.Slice(items, func(i, j int) bool { return agendaItemSort(items[i]) < agendaItemSort(items[j]) })
	if cursor != nil {
		cursorKey := cursor.Sort + "|" + cursor.Key
		filtered := items[:0]
		for _, item := range items {
			if agendaItemSort(item) > cursorKey {
				filtered = append(filtered, item)
			}
		}
		items = filtered
	}
	hasMore := len(items) > limit
	if hasMore {
		items = items[:limit]
	}
	nextCursor := ""
	if hasMore && len(items) > 0 {
		nextCursor = encodeAgendaCursor(items[len(items)-1])
	}
	return c.JSON(fiber.Map{"success": true, "items": items, "next_cursor": nextCursor})
}

func (s *Server) broadcastWorkEvent(ctx *fiber.Ctx, accountID, eventID uuid.UUID, eventType, action string, previousViewers []uuid.UUID) {
	if s.hub == nil {
		return
	}
	viewers, err := s.repos.WorkEvent.ViewerUserIDs(ctx.Context(), accountID, eventID)
	if err != nil {
		return
	}
	current := make(map[uuid.UUID]bool, len(viewers))
	for _, viewerID := range viewers {
		current[viewerID] = true
		canonical, loadErr := s.repos.WorkEvent.GetByIDForActor(ctx.Context(), eventID, accountID, viewerID)
		if loadErr != nil {
			continue
		}
		recipientEventType := eventType
		if eventType == ws.EventWorkEventInvitation && (viewerID == canonical.OrganizerID || canonical.ActorRSVP == "") {
			recipientEventType = ws.EventWorkEventUpdate
		}
		s.hub.BroadcastToAccountUsersWithPermission(accountID, []uuid.UUID{viewerID}, domain.PermTasks, recipientEventType,
			fiber.Map{"action": action, "event": canonical, "operation_id": canonical.OperationID})
	}
	for _, viewerID := range previousViewers {
		if !current[viewerID] {
			s.hub.BroadcastToAccountUsersWithPermission(accountID, []uuid.UUID{viewerID}, domain.PermTasks, ws.EventWorkEventUpdate,
				fiber.Map{"action": "removed", "event_id": eventID})
		}
	}
}

func (s *Server) handleCreateWorkEvent(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	actorID := c.Locals("user_id").(uuid.UUID)
	var req workEventMutationRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
	}
	operationID, err := resolveTaskOperationID(req.OperationID)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "operation_id inválido"})
	}
	event := &domain.WorkEvent{AccountID: accountID, OrganizerID: actorID, CreatedBy: actorID,
		Status: domain.WorkEventStatusScheduled, Availability: domain.WorkEventAvailabilityBusy, Timezone: "America/Lima", OperationID: operationID}
	if err := applyWorkEventRequest(event, req, accountID, actorID, true); err != nil {
		return workEventError(c, err)
	}
	if err := s.repos.WorkEvent.Create(c.Context(), event, actorID, req.ConfirmConflicts); err != nil {
		return workEventError(c, err)
	}
	canonical, err := s.repos.WorkEvent.GetByIDForActor(c.Context(), event.ID, accountID, actorID)
	if err != nil {
		return workEventError(c, err)
	}
	s.broadcastWorkEvent(c, accountID, event.ID, ws.EventWorkEventInvitation, "created", nil)
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"success": true, "event": canonical, "operation_id": operationID})
}

func (s *Server) handleListWorkEventTrash(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	actorID := c.Locals("user_id").(uuid.UUID)
	environmentID, err := uuidQuery(c.Query("environment_id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Entorno inválido"})
	}
	events, err := s.repos.WorkEvent.ListTrashForActor(c.Context(), accountID, actorID, environmentID, 200)
	if err != nil {
		return workEventError(c, err)
	}
	return c.JSON(fiber.Map{"success": true, "events": events})
}

func (s *Server) handleGetWorkEvent(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	actorID := c.Locals("user_id").(uuid.UUID)
	eventID, err := uuid.Parse(c.Params("eventId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Evento inválido"})
	}
	event, err := s.repos.WorkEvent.GetByIDForActor(c.Context(), eventID, accountID, actorID)
	if err != nil {
		return workEventError(c, err)
	}
	return c.JSON(fiber.Map{"success": true, "event": event})
}

func (s *Server) handleUpdateWorkEvent(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	actorID := c.Locals("user_id").(uuid.UUID)
	eventID, err := uuid.Parse(c.Params("eventId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Evento inválido"})
	}
	baseEvent, err := s.repos.WorkEvent.GetByIDForActor(c.Context(), eventID, accountID, actorID)
	if err != nil {
		return workEventError(c, err)
	}
	if !baseEvent.Capabilities.CanEdit {
		return workEventError(c, repository.ErrWorkEventAccessDenied)
	}
	previousViewers, _ := s.repos.WorkEvent.ViewerUserIDs(c.Context(), accountID, eventID)
	var req workEventMutationRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
	}
	if req.Version < 1 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "La versión del evento es obligatoria"})
	}
	eventCopy := *baseEvent
	event := &eventCopy
	if req.Version != 0 {
		event.Version = req.Version
		baseEvent.Version = req.Version
	}
	operationID, err := resolveTaskOperationID(req.OperationID)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "operation_id inválido"})
	}
	event.OperationID = operationID
	if err := applyWorkEventRequest(event, req, accountID, actorID, false); err != nil {
		return workEventError(c, err)
	}
	scope := strings.ToLower(strings.TrimSpace(req.Scope))
	canonicalEventID := eventID
	if scope == "occurrence" {
		if req.OccurrenceKey == "" || req.Attendees != nil || req.RecurrenceRule != nil {
			return workEventError(c, repository.ErrWorkEventInvalid)
		}
		if err := s.repos.WorkEvent.UpdateOccurrence(c.Context(), baseEvent, event, req.OccurrenceKey, actorID, req.CancelOccurrence, req.ConfirmConflicts); err != nil {
			return workEventError(c, err)
		}
	} else if scope == "" || scope == "series" {
		if err := s.repos.WorkEvent.Update(c.Context(), event, actorID, req.ConfirmConflicts); err != nil {
			return workEventError(c, err)
		}
	} else if scope == "following" {
		if req.OccurrenceKey == "" || req.CancelOccurrence {
			return workEventError(c, repository.ErrWorkEventInvalid)
		}
		canonicalEventID, err = s.repos.WorkEvent.SplitFollowing(c.Context(), baseEvent, event, req.OccurrenceKey, actorID, req.ConfirmConflicts)
		if err != nil {
			return workEventError(c, err)
		}
	} else {
		return workEventError(c, repository.ErrWorkEventInvalid)
	}
	canonical, err := s.repos.WorkEvent.GetByIDForActor(c.Context(), canonicalEventID, accountID, actorID)
	if err != nil {
		return workEventError(c, err)
	}
	action := "updated"
	if scope == "occurrence" {
		action = "occurrence_updated"
	}
	s.broadcastWorkEvent(c, accountID, eventID, ws.EventWorkEventUpdate, action, previousViewers)
	if scope == "following" && canonicalEventID != eventID {
		s.broadcastWorkEvent(c, accountID, canonicalEventID, ws.EventWorkEventInvitation, "series_split", nil)
	}
	return c.JSON(fiber.Map{"success": true, "event": canonical, "operation_id": operationID,
		"affected_occurrence_keys": []string{req.OccurrenceKey}})
}

func (s *Server) handleUpdateWorkEventAppearance(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	actorID := c.Locals("user_id").(uuid.UUID)
	eventID, err := uuid.Parse(c.Params("eventId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Evento inválido"})
	}
	var req struct {
		Color       json.RawMessage `json:"color"`
		Version     int64           `json:"version"`
		OperationID string          `json:"operation_id"`
	}
	if err := c.BodyParser(&req); err != nil || len(req.Color) == 0 || req.Version < 1 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Color inválido"})
	}
	color, err := parseNullableWorkColor(req.Color, nil)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "El color debe usar #RRGGBB"})
	}
	operationID, err := resolveTaskOperationID(req.OperationID)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "operation_id inválido"})
	}
	if err := s.repos.WorkEvent.UpdateAppearance(c.Context(), accountID, eventID, actorID, color, req.Version, operationID); err != nil {
		return workEventError(c, err)
	}
	canonical, err := s.repos.WorkEvent.GetByIDForActor(c.Context(), eventID, accountID, actorID)
	if err != nil {
		return workEventError(c, err)
	}
	s.broadcastWorkEvent(c, accountID, eventID, ws.EventWorkEventUpdate, "appearance_updated", nil)
	return c.JSON(fiber.Map{"success": true, "event": canonical, "operation_id": operationID})
}

func workEventActionRequest(c *fiber.Ctx) (int64, *uuid.UUID, error) {
	var req struct {
		Version     int64  `json:"version"`
		OperationID string `json:"operation_id"`
	}
	if err := c.BodyParser(&req); err != nil || req.Version < 1 {
		return 0, nil, repository.ErrWorkEventInvalid
	}
	operationID, err := resolveTaskOperationID(req.OperationID)
	return req.Version, operationID, err
}

func (s *Server) handleCancelWorkEvent(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	actorID := c.Locals("user_id").(uuid.UUID)
	eventID, err := uuid.Parse(c.Params("eventId"))
	if err != nil {
		return workEventError(c, repository.ErrWorkEventNotFound)
	}
	version, operationID, err := workEventActionRequest(c)
	if err != nil {
		return workEventError(c, err)
	}
	if err := s.repos.WorkEvent.Cancel(c.Context(), accountID, eventID, actorID, version, operationID); err != nil {
		return workEventError(c, err)
	}
	s.broadcastWorkEvent(c, accountID, eventID, ws.EventWorkEventUpdate, "cancelled", nil)
	canonical, err := s.repos.WorkEvent.GetByIDForActor(c.Context(), eventID, accountID, actorID)
	if err != nil {
		return workEventError(c, err)
	}
	return c.JSON(fiber.Map{"success": true, "event": canonical, "operation_id": operationID})
}

func (s *Server) handleTrashWorkEvent(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	actorID := c.Locals("user_id").(uuid.UUID)
	eventID, err := uuid.Parse(c.Params("eventId"))
	if err != nil {
		return workEventError(c, repository.ErrWorkEventNotFound)
	}
	version, operationID, err := workEventActionRequest(c)
	if err != nil {
		return workEventError(c, err)
	}
	previous, _ := s.repos.WorkEvent.ViewerUserIDs(c.Context(), accountID, eventID)
	if err := s.repos.WorkEvent.Trash(c.Context(), accountID, eventID, actorID, version, operationID); err != nil {
		return workEventError(c, err)
	}
	if s.hub != nil {
		for _, viewer := range previous {
			s.hub.BroadcastToAccountUsersWithPermission(accountID, []uuid.UUID{viewer}, domain.PermTasks, ws.EventWorkEventUpdate,
				fiber.Map{"action": "trashed", "event_id": eventID})
		}
	}
	canonical, err := s.repos.WorkEvent.GetByIDIncludingDeletedForActor(c.Context(), eventID, accountID, actorID)
	if err != nil {
		return workEventError(c, err)
	}
	return c.JSON(fiber.Map{"success": true, "event": canonical, "operation_id": operationID})
}

func (s *Server) handleRestoreWorkEvent(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	actorID := c.Locals("user_id").(uuid.UUID)
	eventID, err := uuid.Parse(c.Params("eventId"))
	if err != nil {
		return workEventError(c, repository.ErrWorkEventNotFound)
	}
	version, operationID, err := workEventActionRequest(c)
	if err != nil {
		return workEventError(c, err)
	}
	if err := s.repos.WorkEvent.Restore(c.Context(), accountID, eventID, actorID, version, operationID); err != nil {
		return workEventError(c, err)
	}
	s.broadcastWorkEvent(c, accountID, eventID, ws.EventWorkEventUpdate, "restored", nil)
	canonical, err := s.repos.WorkEvent.GetByIDForActor(c.Context(), eventID, accountID, actorID)
	if err != nil {
		return workEventError(c, err)
	}
	return c.JSON(fiber.Map{"success": true, "event": canonical, "operation_id": operationID})
}

func (s *Server) handlePurgeWorkEvent(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	actorID := c.Locals("user_id").(uuid.UUID)
	eventID, err := uuid.Parse(c.Params("eventId"))
	if err != nil {
		return workEventError(c, repository.ErrWorkEventNotFound)
	}
	var req struct {
		ExactTitle string `json:"exact_title"`
		Version    int64  `json:"version"`
	}
	if err := c.BodyParser(&req); err != nil || req.Version < 1 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Confirmación inválida"})
	}
	if err := s.repos.WorkEvent.Purge(c.Context(), accountID, eventID, actorID, req.ExactTitle, req.Version); err != nil {
		return workEventError(c, err)
	}
	return c.JSON(fiber.Map{"success": true, "event_id": eventID})
}

func (s *Server) handleWorkEventRSVP(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	actorID := c.Locals("user_id").(uuid.UUID)
	eventID, err := uuid.Parse(c.Params("eventId"))
	if err != nil {
		return workEventError(c, repository.ErrWorkEventNotFound)
	}
	var req struct {
		RSVP        string `json:"rsvp"`
		Version     int64  `json:"version"`
		OperationID string `json:"operation_id"`
	}
	if err := c.BodyParser(&req); err != nil || req.Version < 1 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Respuesta inválida"})
	}
	operationID, err := resolveTaskOperationID(req.OperationID)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "operation_id inválido"})
	}
	if err := s.repos.WorkEvent.SetRSVP(c.Context(), accountID, eventID, actorID, strings.ToLower(req.RSVP), req.Version); err != nil {
		return workEventError(c, err)
	}
	s.broadcastWorkEvent(c, accountID, eventID, ws.EventWorkEventRSVP, "rsvp_updated", nil)
	canonical, err := s.repos.WorkEvent.GetByIDForActor(c.Context(), eventID, accountID, actorID)
	if err != nil {
		return workEventError(c, err)
	}
	return c.JSON(fiber.Map{"success": true, "event": canonical, "operation_id": operationID})
}

func (s *Server) handleWorkEventReminder(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	actorID := c.Locals("user_id").(uuid.UUID)
	eventID, err := uuid.Parse(c.Params("eventId"))
	if err != nil {
		return workEventError(c, repository.ErrWorkEventNotFound)
	}
	var req struct {
		Minutes     *int   `json:"minutes"`
		Version     int64  `json:"version"`
		OperationID string `json:"operation_id"`
	}
	if err := c.BodyParser(&req); err != nil || req.Version < 1 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Recordatorio inválido"})
	}
	operationID, err := resolveTaskOperationID(req.OperationID)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "operation_id inválido"})
	}
	if err := s.repos.WorkEvent.SetOwnReminder(c.Context(), accountID, eventID, actorID, req.Minutes, req.Version); err != nil {
		return workEventError(c, err)
	}
	canonical, err := s.repos.WorkEvent.GetByIDForActor(c.Context(), eventID, accountID, actorID)
	if err != nil {
		return workEventError(c, err)
	}
	return c.JSON(fiber.Map{"success": true, "event": canonical, "operation_id": operationID})
}

func (s *Server) handleWorkEventAvailability(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	actorID := c.Locals("user_id").(uuid.UUID)
	var req struct {
		UserIDs []string `json:"user_ids"`
		StartAt string   `json:"start_at"`
		EndAt   string   `json:"end_at"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Consulta inválida"})
	}
	start, startErr := time.Parse(time.RFC3339, req.StartAt)
	end, endErr := time.Parse(time.RFC3339, req.EndAt)
	if startErr != nil || endErr != nil || !start.Before(end) || end.Sub(start) > 400*24*time.Hour {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Rango inválido"})
	}
	userIDs := make([]uuid.UUID, 0, len(req.UserIDs)+1)
	seen := map[uuid.UUID]bool{}
	for _, raw := range append(req.UserIDs, actorID.String()) {
		id, parseErr := uuid.Parse(raw)
		if parseErr != nil || seen[id] {
			continue
		}
		valid, validationErr := s.repos.TaskWork.UserBelongsToAccount(c.Context(), accountID, id)
		if validationErr != nil || !valid {
			return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{"success": false, "error": "Usuario inválido"})
		}
		seen[id] = true
		userIDs = append(userIDs, id)
	}
	intervals, err := s.repos.WorkEvent.Availability(c.Context(), accountID, userIDs, start, end)
	if err != nil {
		return workEventError(c, err)
	}
	return c.JSON(fiber.Map{"success": true, "intervals": intervals})
}
