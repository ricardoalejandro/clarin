package repository

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
)

var (
	ErrWorkEventNotFound        = errors.New("work event not found")
	ErrWorkEventAccessDenied    = errors.New("work event access denied")
	ErrWorkEventVersionConflict = errors.New("work event version conflict")
	ErrWorkEventInvalid         = errors.New("work event is invalid")
	ErrWorkEventCancelRequired  = errors.New("shared future work event must be cancelled before trash")
	ErrWorkEventPurgeForbidden  = errors.New("work event cannot be purged")
)

type WorkEventRepository struct {
	db *pgxpool.Pool
}

type WorkEventBusyInterval struct {
	StartAt *time.Time `json:"start_at,omitempty"`
	EndAt   *time.Time `json:"end_at,omitempty"`
	State   string     `json:"state"`
}

type WorkEventConflictConfirmationError struct {
	Conflicts []WorkEventBusyInterval
}

func (e *WorkEventConflictConfirmationError) Error() string {
	return "schedule conflict confirmation required"
}

func workEventSelectFields(actorExpression string) string {
	return `event_item.id,event_item.account_id,event_item.list_id,list_item.environment_id,event_item.organizer_id,
		COALESCE(organizer.display_name,organizer.username,''),event_item.title,event_item.description,event_item.location,event_item.meeting_url,
		event_item.color,COALESCE(event_item.color,NULLIF(list_item.color,''),'#64748B'),
		CASE WHEN event_item.color IS NOT NULL THEN 'item' WHEN NULLIF(list_item.color,'') IS NOT NULL THEN 'list' ELSE 'default' END,
		COALESCE(NULLIF(list_item.color,''),'#64748B'),
		event_item.availability,event_item.is_all_day,event_item.start_at,event_item.end_at,
		TO_CHAR(event_item.start_date,'YYYY-MM-DD'),TO_CHAR(event_item.end_date_exclusive,'YYYY-MM-DD'),event_item.timezone,
		event_item.recurrence_rule,event_item.series_root_id,event_item.status,event_item.cancelled_at,event_item.cancelled_by,
		event_item.deleted_at,event_item.deleted_by,event_item.version,event_item.operation_id,event_item.created_by,event_item.created_at,event_item.updated_at,
		list_item.name,list_item.folder_id,COALESCE(folder.name,''),
		(` + taskActorListAccessRankSQL("list_item", actorExpression) + `),
		(` + taskActorEnvironmentAccessRankSQL("list_item", actorExpression) + `),
		EXISTS(SELECT 1 FROM work_event_attendees actor_attendee
			WHERE actor_attendee.account_id=event_item.account_id AND actor_attendee.event_id=event_item.id AND actor_attendee.user_id=` + actorExpression + `),
		COALESCE((SELECT actor_attendee.rsvp FROM work_event_attendees actor_attendee
			WHERE actor_attendee.account_id=event_item.account_id AND actor_attendee.event_id=event_item.id AND actor_attendee.user_id=` + actorExpression + `),'')`
}

const workEventJoins = `
	JOIN task_lists list_item ON list_item.account_id=event_item.account_id AND list_item.id=event_item.list_id
	JOIN task_environments environment ON environment.account_id=list_item.account_id AND environment.id=list_item.environment_id
	LEFT JOIN task_folders folder ON folder.account_id=list_item.account_id AND folder.id=list_item.folder_id
	JOIN users organizer ON organizer.id=event_item.organizer_id`

type workEventRow interface {
	Scan(dest ...any) error
}

func scanWorkEvent(row workEventRow, actorID uuid.UUID) (*domain.WorkEvent, error) {
	event := &domain.WorkEvent{}
	var listID uuid.UUID
	var listRank, environmentRank int
	var isAttendee bool
	if err := row.Scan(
		&event.ID, &event.AccountID, &listID, &event.EnvironmentID, &event.OrganizerID,
		&event.OrganizerName, &event.Title, &event.Description, &event.Location, &event.MeetingURL,
		&event.Color, &event.ResolvedColor, &event.ColorSource, &event.ListColor, &event.Availability, &event.IsAllDay,
		&event.StartAt, &event.EndAt, &event.StartDate, &event.EndDateExclusive, &event.Timezone,
		&event.RecurrenceRule, &event.SeriesRootID, &event.Status, &event.CancelledAt, &event.CancelledBy,
		&event.DeletedAt, &event.DeletedBy, &event.Version, &event.OperationID, &event.CreatedBy, &event.CreatedAt, &event.UpdatedAt,
		&event.ListName, &event.FolderID, &event.FolderName, &listRank, &environmentRank, &isAttendee, &event.ActorRSVP,
	); err != nil {
		return nil, err
	}
	event.ListID = listID
	event.ListVisible = listRank >= 1
	if event.ListVisible {
		event.VisibleListID = &listID
	} else {
		event.ListName = ""
		event.FolderID = nil
		event.FolderName = ""
	}
	canView := environmentRank >= 1 && (listRank >= 1 || isAttendee || actorID == event.OrganizerID)
	canEdit := canView && (actorID == event.OrganizerID || listRank >= 3)
	isActive := event.DeletedAt == nil
	event.Capabilities = domain.WorkEventCapabilities{
		CanView: canView, CanEdit: canEdit && isActive, CanInvite: canEdit && isActive,
		CanCancel: canEdit && isActive && event.Status != domain.WorkEventStatusCancelled,
		CanTrash:  canEdit && isActive, CanRestore: canEdit && event.DeletedAt != nil, CanPurge: canEdit && event.DeletedAt != nil,
		CanRespond:     isAttendee && actorID != event.OrganizerID && isActive,
		CanSetReminder: isAttendee && isActive,
	}
	return event, nil
}

func (r *WorkEventRepository) requireListAccessWith(ctx context.Context, q taskAccessQuerier, accountID, actorID, listID uuid.UUID, required string) (uuid.UUID, error) {
	var environmentID uuid.UUID
	var listRank, environmentRank int
	err := q.QueryRow(ctx, `SELECT list_item.environment_id,
		(`+taskActorListAccessRankSQL("list_item", "$3")+`),
		(`+taskActorEnvironmentAccessRankSQL("list_item", "$3")+`)
		FROM task_lists list_item
		JOIN task_environments environment ON environment.account_id=list_item.account_id AND environment.id=list_item.environment_id
		JOIN user_accounts membership ON membership.account_id=list_item.account_id AND membership.user_id=$3
		WHERE list_item.account_id=$1 AND list_item.id=$2
		  AND list_item.archived_at IS NULL AND list_item.deleted_at IS NULL
		  AND environment.archived_at IS NULL AND environment.deleted_at IS NULL`, accountID, listID, actorID).
		Scan(&environmentID, &listRank, &environmentRank)
	if errors.Is(err, pgx.ErrNoRows) || environmentRank < 1 {
		return uuid.Nil, ErrWorkEventNotFound
	}
	if err != nil {
		return uuid.Nil, err
	}
	if listRank < taskAccessRank(required) {
		return uuid.Nil, ErrWorkEventAccessDenied
	}
	return environmentID, nil
}

func canonicalWorkEventAttendees(event *domain.WorkEvent) []*domain.WorkEventAttendee {
	byUser := make(map[uuid.UUID]*domain.WorkEventAttendee, len(event.Attendees)+1)
	for _, attendee := range event.Attendees {
		if attendee == nil || attendee.UserID == uuid.Nil {
			continue
		}
		copyItem := *attendee
		copyItem.AttendanceType = strings.ToLower(strings.TrimSpace(copyItem.AttendanceType))
		if copyItem.AttendanceType == "" {
			copyItem.AttendanceType = "required"
		}
		copyItem.RSVP = strings.ToLower(strings.TrimSpace(copyItem.RSVP))
		if copyItem.RSVP == "" {
			copyItem.RSVP = domain.WorkEventRSVPPending
		}
		byUser[copyItem.UserID] = &copyItem
	}
	organizer := byUser[event.OrganizerID]
	if organizer == nil {
		organizer = &domain.WorkEventAttendee{UserID: event.OrganizerID, AttendanceType: "required"}
		byUser[event.OrganizerID] = organizer
	}
	organizer.RSVP = domain.WorkEventRSVPAccepted
	result := make([]*domain.WorkEventAttendee, 0, len(byUser))
	for _, attendee := range byUser {
		result = append(result, attendee)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].UserID.String() < result[j].UserID.String() })
	return result
}

func validateWorkEventAttendees(ctx context.Context, q taskAccessQuerier, accountID, environmentID uuid.UUID, attendees []*domain.WorkEventAttendee) error {
	for _, attendee := range attendees {
		if attendee.AttendanceType != "required" && attendee.AttendanceType != "optional" {
			return ErrWorkEventInvalid
		}
		switch attendee.RSVP {
		case domain.WorkEventRSVPPending, domain.WorkEventRSVPAccepted, domain.WorkEventRSVPTentative, domain.WorkEventRSVPDeclined:
		default:
			return ErrWorkEventInvalid
		}
		access, _, err := resolveEnvironmentAccessWith(ctx, q, accountID, attendee.UserID, environmentID)
		if err != nil || !TaskAccessAllows(access, domain.TaskAccessView) {
			return ErrWorkEventInvalid
		}
	}
	return nil
}

func workEventUTCInterval(event *domain.WorkEvent) (time.Time, time.Time, error) {
	loc, err := time.LoadLocation(event.Timezone)
	if err != nil {
		return time.Time{}, time.Time{}, ErrWorkEventInvalid
	}
	if event.IsAllDay {
		start, err := eventDateValue(event.StartDate, loc)
		if err != nil {
			return time.Time{}, time.Time{}, ErrWorkEventInvalid
		}
		end, err := eventDateValue(event.EndDateExclusive, loc)
		if err != nil || !start.Before(end) {
			return time.Time{}, time.Time{}, ErrWorkEventInvalid
		}
		return start.UTC(), end.UTC(), nil
	}
	if event.StartAt == nil || event.EndAt == nil || !event.StartAt.Before(*event.EndAt) {
		return time.Time{}, time.Time{}, ErrWorkEventInvalid
	}
	return event.StartAt.UTC(), event.EndAt.UTC(), nil
}

func (r *WorkEventRepository) busyIntervalsWith(ctx context.Context, q taskAccessQuerier, accountID uuid.UUID, userIDs []uuid.UUID, start, end time.Time, excludeEventID *uuid.UUID) ([]WorkEventBusyInterval, error) {
	if len(userIDs) == 0 {
		return []WorkEventBusyInterval{}, nil
	}
	rows, err := q.Query(ctx, `
		SELECT busy_start,busy_end,busy_state FROM (
			SELECT CASE WHEN event_item.is_all_day THEN event_item.start_date::timestamp AT TIME ZONE event_item.timezone ELSE event_item.start_at END AS busy_start,
				CASE WHEN event_item.is_all_day THEN event_item.end_date_exclusive::timestamp AT TIME ZONE event_item.timezone ELSE event_item.end_at END AS busy_end,
				CASE WHEN BOOL_OR(attendee.rsvp='accepted') THEN 'busy' ELSE 'tentative' END AS busy_state
			FROM work_events event_item
			JOIN work_event_attendees attendee ON attendee.account_id=event_item.account_id AND attendee.event_id=event_item.id
			WHERE event_item.account_id=$1 AND attendee.user_id=ANY($2::uuid[]) AND attendee.rsvp IN ('accepted','tentative')
			  AND event_item.availability='busy' AND event_item.status='scheduled' AND event_item.deleted_at IS NULL
			  AND event_item.recurrence_rule=''
			  AND ($5::uuid IS NULL OR event_item.id<>$5)
			GROUP BY event_item.id
			UNION ALL
			SELECT COALESCE(task.start_at,task.due_at),COALESCE(task.due_end_at,task.due_at,task.start_at),'busy'
			FROM tasks task
			WHERE task.account_id=$1 AND task.assigned_to=ANY($2::uuid[]) AND task.deleted_at IS NULL
			  AND COALESCE(task.start_at,task.due_at) IS NOT NULL
		) busy
		WHERE busy_start < $4 AND busy_end > $3
		ORDER BY busy_start,busy_end,busy_state LIMIT 1000`, accountID, userIDs, start, end, excludeEventID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]WorkEventBusyInterval, 0)
	for rows.Next() {
		var item WorkEventBusyInterval
		if err := rows.Scan(&item.StartAt, &item.EndAt, &item.State); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	recurringRows, err := q.Query(ctx, `SELECT event_item.id,event_item.list_id,event_item.organizer_id,event_item.title,event_item.is_all_day,
		event_item.start_at,event_item.end_at,TO_CHAR(event_item.start_date,'YYYY-MM-DD'),TO_CHAR(event_item.end_date_exclusive,'YYYY-MM-DD'),
		event_item.timezone,event_item.recurrence_rule,event_item.status,event_item.deleted_at,
		CASE WHEN BOOL_OR(attendee.rsvp='accepted') THEN 'busy' ELSE 'tentative' END
		FROM work_events event_item JOIN work_event_attendees attendee
		  ON attendee.account_id=event_item.account_id AND attendee.event_id=event_item.id
		WHERE event_item.account_id=$1 AND attendee.user_id=ANY($2::uuid[]) AND attendee.rsvp IN ('accepted','tentative')
		  AND event_item.availability='busy' AND event_item.status='scheduled' AND event_item.deleted_at IS NULL
		  AND event_item.recurrence_rule<>'' AND ($3::uuid IS NULL OR event_item.id<>$3)
		GROUP BY event_item.id`, accountID, userIDs, excludeEventID)
	if err != nil {
		return nil, err
	}
	defer recurringRows.Close()
	for recurringRows.Next() {
		event := &domain.WorkEvent{AccountID: accountID, Availability: domain.WorkEventAvailabilityBusy}
		var state string
		if err := recurringRows.Scan(&event.ID, &event.ListID, &event.OrganizerID, &event.Title, &event.IsAllDay,
			&event.StartAt, &event.EndAt, &event.StartDate, &event.EndDateExclusive, &event.Timezone,
			&event.RecurrenceRule, &event.Status, &event.DeletedAt, &state); err != nil {
			return nil, err
		}
		occurrences, err := expandWorkEventWithOverrides(ctx, q, event, start, end)
		if err != nil {
			return nil, err
		}
		for _, occurrence := range occurrences {
			if occurrence.StartAt != nil && occurrence.EndAt != nil {
				itemStart, itemEnd := occurrence.StartAt.UTC(), occurrence.EndAt.UTC()
				result = append(result, WorkEventBusyInterval{StartAt: &itemStart, EndAt: &itemEnd, State: state})
				continue
			}
			if occurrence.StartDate != nil && occurrence.EndDateExclusive != nil {
				loc, _ := time.LoadLocation(event.Timezone)
				itemStart, _ := time.ParseInLocation("2006-01-02", *occurrence.StartDate, loc)
				itemEnd, _ := time.ParseInLocation("2006-01-02", *occurrence.EndDateExclusive, loc)
				startUTC, endUTC := itemStart.UTC(), itemEnd.UTC()
				result = append(result, WorkEventBusyInterval{StartAt: &startUTC, EndAt: &endUTC, State: state})
			}
		}
	}
	if err := recurringRows.Err(); err != nil {
		return nil, err
	}
	sort.Slice(result, func(i, j int) bool { return result[i].StartAt.Before(*result[j].StartAt) })
	return result, nil
}

func occurrenceUTCInterval(event *domain.WorkEvent, occurrence *domain.WorkEventOccurrence) (time.Time, time.Time, error) {
	if occurrence.StartAt != nil && occurrence.EndAt != nil {
		return occurrence.StartAt.UTC(), occurrence.EndAt.UTC(), nil
	}
	if occurrence.StartDate == nil || occurrence.EndDateExclusive == nil {
		return time.Time{}, time.Time{}, ErrWorkEventInvalid
	}
	loc, err := time.LoadLocation(event.Timezone)
	if err != nil {
		return time.Time{}, time.Time{}, ErrWorkEventInvalid
	}
	start, err := time.ParseInLocation("2006-01-02", *occurrence.StartDate, loc)
	if err != nil {
		return time.Time{}, time.Time{}, ErrWorkEventInvalid
	}
	end, err := time.ParseInLocation("2006-01-02", *occurrence.EndDateExclusive, loc)
	if err != nil {
		return time.Time{}, time.Time{}, ErrWorkEventInvalid
	}
	return start.UTC(), end.UTC(), nil
}

func (r *WorkEventRepository) eventConflictsWith(ctx context.Context, q taskAccessQuerier, event *domain.WorkEvent, userIDs []uuid.UUID, excludeEventID *uuid.UUID) ([]WorkEventBusyInterval, error) {
	start, end, err := workEventUTCInterval(event)
	if err != nil {
		return nil, err
	}
	occurrences, err := expandAllWorkEventOccurrences(event)
	if err != nil {
		return nil, err
	}
	if len(occurrences) == 0 {
		return []WorkEventBusyInterval{}, nil
	}
	latest := end
	for _, occurrence := range occurrences {
		_, occurrenceEnd, err := occurrenceUTCInterval(event, occurrence)
		if err != nil {
			return nil, err
		}
		if occurrenceEnd.After(latest) {
			latest = occurrenceEnd
		}
	}
	busy, err := r.busyIntervalsWith(ctx, q, event.AccountID, userIDs, start, latest, excludeEventID)
	if err != nil {
		return nil, err
	}
	conflicts := make([]WorkEventBusyInterval, 0)
	seen := map[string]bool{}
	for _, occurrence := range occurrences {
		occurrenceStart, occurrenceEnd, _ := occurrenceUTCInterval(event, occurrence)
		for _, interval := range busy {
			if interval.StartAt == nil || interval.EndAt == nil || !occurrenceStart.Before(*interval.EndAt) || !occurrenceEnd.After(*interval.StartAt) {
				continue
			}
			key := interval.StartAt.UTC().Format(time.RFC3339Nano) + "/" + interval.EndAt.UTC().Format(time.RFC3339Nano)
			if !seen[key] {
				conflicts = append(conflicts, interval)
				seen[key] = true
			}
			if len(conflicts) >= 50 {
				return conflicts, nil
			}
		}
	}
	return conflicts, nil
}

func (r *WorkEventRepository) replaceAttendeesWith(ctx context.Context, tx pgx.Tx, event *domain.WorkEvent, attendees []*domain.WorkEventAttendee) error {
	if _, err := tx.Exec(ctx, `DELETE FROM work_event_attendees WHERE account_id=$1 AND event_id=$2`, event.AccountID, event.ID); err != nil {
		return err
	}
	for _, attendee := range attendees {
		if _, err := tx.Exec(ctx, `INSERT INTO work_event_attendees(account_id,event_id,user_id,attendance_type,rsvp,reminder_minutes)
			VALUES($1,$2,$3,$4,$5,$6)`, event.AccountID, event.ID, attendee.UserID, attendee.AttendanceType, attendee.RSVP, attendee.ReminderMinutes); err != nil {
			return err
		}
	}
	return nil
}

func (r *WorkEventRepository) rebuildRemindersWith(ctx context.Context, tx pgx.Tx, event *domain.WorkEvent, attendees []*domain.WorkEventAttendee) error {
	if _, err := tx.Exec(ctx, `UPDATE work_event_reminder_jobs SET cancelled_at=NOW(),updated_at=NOW()
		WHERE account_id=$1 AND event_id=$2 AND delivered_at IS NULL AND cancelled_at IS NULL`, event.AccountID, event.ID); err != nil {
		return err
	}
	if event.DeletedAt != nil || event.Status == domain.WorkEventStatusCancelled {
		return nil
	}
	from := time.Now().Add(-48 * time.Hour)
	to := from.AddDate(10, 0, 0)
	occurrences, err := expandWorkEventWithOverrides(ctx, tx, event, from, to)
	if err != nil {
		return err
	}
	for _, attendee := range attendees {
		if attendee.RSVP != domain.WorkEventRSVPAccepted && attendee.RSVP != domain.WorkEventRSVPTentative {
			continue
		}
		minutes := 15
		if attendee.ReminderMinutes != nil {
			minutes = *attendee.ReminderMinutes
		}
		for _, occurrence := range occurrences {
			var reminderAt time.Time
			if event.IsAllDay {
				loc, _ := time.LoadLocation(event.Timezone)
				startDate, parseErr := time.ParseInLocation("2006-01-02", *occurrence.StartDate, loc)
				if parseErr != nil {
					return parseErr
				}
				previous := startDate.AddDate(0, 0, -1)
				reminderAt = time.Date(previous.Year(), previous.Month(), previous.Day(), 9, 0, 0, 0, loc).UTC()
			} else {
				reminderAt = occurrence.StartAt.Add(-time.Duration(minutes) * time.Minute)
			}
			if reminderAt.Before(time.Now().Add(-time.Minute)) {
				continue
			}
			if _, err := tx.Exec(ctx, `INSERT INTO work_event_reminder_jobs(account_id,event_id,occurrence_key,user_id,reminder_at,cancelled_at,updated_at)
				VALUES($1,$2,$3,$4,$5,NULL,NOW())
				ON CONFLICT(account_id,event_id,occurrence_key,user_id) DO UPDATE SET reminder_at=EXCLUDED.reminder_at,
					cancelled_at=NULL,delivered_at=NULL,updated_at=NOW()`, event.AccountID, event.ID, occurrence.OccurrenceKey, attendee.UserID, reminderAt); err != nil {
				return err
			}
		}
	}
	return nil
}

func (r *WorkEventRepository) Create(ctx context.Context, event *domain.WorkEvent, actorID uuid.UUID, confirmConflicts bool) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	environmentID, err := r.requireListAccessWith(ctx, tx, event.AccountID, actorID, event.ListID, domain.TaskAccessEdit)
	if err != nil {
		return err
	}
	event.ID = uuid.New()
	event.OrganizerID = actorID
	event.CreatedBy = actorID
	event.EnvironmentID = environmentID
	event.Version = 1
	attendees := canonicalWorkEventAttendees(event)
	if err := validateWorkEventAttendees(ctx, tx, event.AccountID, environmentID, attendees); err != nil {
		return err
	}
	if _, _, err := workEventUTCInterval(event); err != nil {
		return err
	}
	userIDs := make([]uuid.UUID, 0, len(attendees))
	for _, attendee := range attendees {
		userIDs = append(userIDs, attendee.UserID)
	}
	if event.Availability == domain.WorkEventAvailabilityBusy {
		conflicts, conflictErr := r.eventConflictsWith(ctx, tx, event, userIDs, nil)
		if conflictErr != nil {
			return conflictErr
		}
		if len(conflicts) > 0 && !confirmConflicts {
			return &WorkEventConflictConfirmationError{Conflicts: conflicts}
		}
	}
	_, err = tx.Exec(ctx, `INSERT INTO work_events(id,account_id,list_id,organizer_id,title,description,location,meeting_url,color,availability,
		is_all_day,start_at,end_at,start_date,end_date_exclusive,timezone,recurrence_rule,series_root_id,status,operation_id,created_by)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::date,$15::date,$16,$17,$18,$19,$20,$21)`,
		event.ID, event.AccountID, event.ListID, event.OrganizerID, event.Title, event.Description, event.Location, event.MeetingURL,
		event.Color, event.Availability, event.IsAllDay, event.StartAt, event.EndAt, event.StartDate, event.EndDateExclusive,
		event.Timezone, event.RecurrenceRule, event.SeriesRootID, event.Status, event.OperationID, event.CreatedBy)
	if err != nil {
		return err
	}
	if err := r.replaceAttendeesWith(ctx, tx, event, attendees); err != nil {
		return err
	}
	if err := r.rebuildRemindersWith(ctx, tx, event, attendees); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	event.Attendees = attendees
	return nil
}

func (r *WorkEventRepository) getByIDForActor(ctx context.Context, eventID, accountID, actorID uuid.UUID, includeDeleted bool) (*domain.WorkEvent, error) {
	deletedPredicate := " AND event_item.deleted_at IS NULL"
	if includeDeleted {
		deletedPredicate = ""
	}
	row := r.db.QueryRow(ctx, `SELECT `+workEventSelectFields("$3")+` FROM work_events event_item `+workEventJoins+`
		WHERE event_item.account_id=$1 AND event_item.id=$2`+deletedPredicate+`
		  AND EXISTS(SELECT 1 FROM user_accounts membership WHERE membership.account_id=event_item.account_id AND membership.user_id=$3)`, accountID, eventID, actorID)
	event, err := scanWorkEvent(row, actorID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrWorkEventNotFound
	}
	if err != nil {
		return nil, err
	}
	if !event.Capabilities.CanView {
		return nil, ErrWorkEventNotFound
	}
	attendees, err := r.loadAttendees(ctx, accountID, []uuid.UUID{eventID})
	if err != nil {
		return nil, err
	}
	event.Attendees = attendees[eventID]
	if event.Attendees == nil {
		event.Attendees = []*domain.WorkEventAttendee{}
	}
	return event, nil
}

func (r *WorkEventRepository) GetByIDForActor(ctx context.Context, eventID, accountID, actorID uuid.UUID) (*domain.WorkEvent, error) {
	return r.getByIDForActor(ctx, eventID, accountID, actorID, false)
}

func (r *WorkEventRepository) GetByIDIncludingDeletedForActor(ctx context.Context, eventID, accountID, actorID uuid.UUID) (*domain.WorkEvent, error) {
	return r.getByIDForActor(ctx, eventID, accountID, actorID, true)
}

func (r *WorkEventRepository) ListTrashForActor(ctx context.Context, accountID, actorID uuid.UUID, environmentID *uuid.UUID, limit int) ([]*domain.WorkEvent, error) {
	if limit < 1 || limit > 200 {
		limit = 100
	}
	rows, err := r.db.Query(ctx, `SELECT `+workEventSelectFields("$2")+` FROM work_events event_item `+workEventJoins+`
		WHERE event_item.account_id=$1 AND event_item.deleted_at IS NOT NULL
		  AND ($3::uuid IS NULL OR list_item.environment_id=$3)
		  AND (`+taskActorEnvironmentAccessRankSQL("list_item", "$2")+`) >= 1
		  AND (event_item.organizer_id=$2 OR (`+taskActorListAccessRankSQL("list_item", "$2")+`) >= 3)
		ORDER BY event_item.deleted_at DESC,event_item.id LIMIT $4`, accountID, actorID, environmentID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]*domain.WorkEvent, 0)
	ids := make([]uuid.UUID, 0)
	for rows.Next() {
		event, err := scanWorkEvent(rows, actorID)
		if err != nil {
			return nil, err
		}
		result, ids = append(result, event), append(ids, event.ID)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	attendees, err := r.loadAttendees(ctx, accountID, ids)
	if err != nil {
		return nil, err
	}
	for _, event := range result {
		event.Attendees = attendees[event.ID]
		if event.Attendees == nil {
			event.Attendees = []*domain.WorkEventAttendee{}
		}
	}
	return result, nil
}

func (r *WorkEventRepository) loadAttendees(ctx context.Context, accountID uuid.UUID, eventIDs []uuid.UUID) (map[uuid.UUID][]*domain.WorkEventAttendee, error) {
	result := make(map[uuid.UUID][]*domain.WorkEventAttendee, len(eventIDs))
	if len(eventIDs) == 0 {
		return result, nil
	}
	rows, err := r.db.Query(ctx, `SELECT attendee.event_id,attendee.user_id,COALESCE(account_user.display_name,account_user.username,''),
		account_user.username,attendee.attendance_type,attendee.rsvp,attendee.reminder_minutes,attendee.version,attendee.created_at,attendee.updated_at
		FROM work_event_attendees attendee JOIN users account_user ON account_user.id=attendee.user_id
		WHERE attendee.account_id=$1 AND attendee.event_id=ANY($2::uuid[])
		ORDER BY attendee.event_id,CASE attendee.rsvp WHEN 'accepted' THEN 0 WHEN 'tentative' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END,
			COALESCE(account_user.display_name,account_user.username),attendee.user_id`, accountID, eventIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var eventID uuid.UUID
		attendee := &domain.WorkEventAttendee{}
		if err := rows.Scan(&eventID, &attendee.UserID, &attendee.DisplayName, &attendee.Username, &attendee.AttendanceType,
			&attendee.RSVP, &attendee.ReminderMinutes, &attendee.Version, &attendee.CreatedAt, &attendee.UpdatedAt); err != nil {
			return nil, err
		}
		result[eventID] = append(result[eventID], attendee)
	}
	return result, rows.Err()
}

type workEventOccurrenceOverride struct {
	EventID          uuid.UUID
	OccurrenceKey    string
	Cancelled        bool
	Title            *string
	Description      *string
	Location         *string
	MeetingURL       *string
	Color            *string
	ColorSet         bool
	Availability     *string
	IsAllDay         *bool
	StartAt          *time.Time
	EndAt            *time.Time
	StartDate        *string
	EndDateExclusive *string
	Timezone         *string
	Version          int64
	OperationID      *uuid.UUID
}

func loadWorkEventOverrides(ctx context.Context, q taskAccessQuerier, accountID uuid.UUID, eventIDs []uuid.UUID) (map[uuid.UUID]map[string]*workEventOccurrenceOverride, error) {
	result := make(map[uuid.UUID]map[string]*workEventOccurrenceOverride, len(eventIDs))
	if len(eventIDs) == 0 {
		return result, nil
	}
	rows, err := q.Query(ctx, `SELECT event_id,occurrence_key,is_cancelled,title,description,location,meeting_url,color,color_set,availability,
		is_all_day,start_at,end_at,TO_CHAR(start_date,'YYYY-MM-DD'),TO_CHAR(end_date_exclusive,'YYYY-MM-DD'),timezone,version,operation_id
		FROM work_event_occurrence_overrides WHERE account_id=$1 AND event_id=ANY($2::uuid[])`, accountID, eventIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		override := &workEventOccurrenceOverride{}
		if err := rows.Scan(&override.EventID, &override.OccurrenceKey, &override.Cancelled, &override.Title, &override.Description,
			&override.Location, &override.MeetingURL, &override.Color, &override.ColorSet, &override.Availability, &override.IsAllDay,
			&override.StartAt, &override.EndAt, &override.StartDate, &override.EndDateExclusive, &override.Timezone,
			&override.Version, &override.OperationID); err != nil {
			return nil, err
		}
		if result[override.EventID] == nil {
			result[override.EventID] = map[string]*workEventOccurrenceOverride{}
		}
		result[override.EventID][override.OccurrenceKey] = override
	}
	return result, rows.Err()
}

func applyWorkEventOverride(occurrence *domain.WorkEventOccurrence, override *workEventOccurrenceOverride) *domain.WorkEventOccurrence {
	if occurrence == nil || override == nil || override.Cancelled {
		return nil
	}
	eventCopy := *occurrence.Event
	if override.Title != nil {
		eventCopy.Title = *override.Title
	}
	if override.Description != nil {
		eventCopy.Description = *override.Description
	}
	if override.Location != nil {
		eventCopy.Location = *override.Location
	}
	if override.MeetingURL != nil {
		eventCopy.MeetingURL = *override.MeetingURL
	}
	if override.Availability != nil {
		eventCopy.Availability = *override.Availability
	}
	if override.Timezone != nil {
		eventCopy.Timezone = *override.Timezone
	}
	if override.ColorSet {
		eventCopy.Color = override.Color
		if override.Color != nil {
			eventCopy.ResolvedColor = *override.Color
			eventCopy.ColorSource = "item"
		} else {
			eventCopy.ResolvedColor = eventCopy.ListColor
			eventCopy.ColorSource = "list"
		}
	}
	if override.OperationID != nil {
		eventCopy.OperationID = override.OperationID
	}
	copyOccurrence := *occurrence
	copyOccurrence.Event = &eventCopy
	copyOccurrence.IsException = true
	copyOccurrence.OverrideVersion = override.Version
	if override.IsAllDay != nil {
		eventCopy.IsAllDay = *override.IsAllDay
		copyOccurrence.StartAt, copyOccurrence.EndAt = override.StartAt, override.EndAt
		copyOccurrence.StartDate, copyOccurrence.EndDateExclusive = override.StartDate, override.EndDateExclusive
	} else if override.StartAt != nil || override.StartDate != nil {
		copyOccurrence.StartAt, copyOccurrence.EndAt = override.StartAt, override.EndAt
		copyOccurrence.StartDate, copyOccurrence.EndDateExclusive = override.StartDate, override.EndDateExclusive
	}
	return &copyOccurrence
}

func expandWorkEventWithOverrides(ctx context.Context, q taskAccessQuerier, event *domain.WorkEvent, from, to time.Time) ([]*domain.WorkEventOccurrence, error) {
	occurrences, err := ExpandWorkEvent(event, from, to)
	if err != nil {
		return nil, err
	}
	overrides, err := loadWorkEventOverrides(ctx, q, event.AccountID, []uuid.UUID{event.ID})
	if err != nil {
		return nil, err
	}
	result := make([]*domain.WorkEventOccurrence, 0, len(occurrences))
	for _, occurrence := range occurrences {
		override := overrides[event.ID][occurrence.OccurrenceKey]
		if override == nil {
			result = append(result, occurrence)
			continue
		}
		if applied := applyWorkEventOverride(occurrence, override); applied != nil {
			result = append(result, applied)
		}
	}
	return result, nil
}

func workEventOccurrenceEnd(occurrence *domain.WorkEventOccurrence) (time.Time, error) {
	if occurrence == nil || occurrence.Event == nil {
		return time.Time{}, ErrWorkEventInvalid
	}
	if occurrence.EndAt != nil {
		return occurrence.EndAt.UTC(), nil
	}
	if occurrence.EndDateExclusive == nil {
		return time.Time{}, ErrWorkEventInvalid
	}
	loc, err := time.LoadLocation(occurrence.Event.Timezone)
	if err != nil {
		return time.Time{}, ErrWorkEventInvalid
	}
	end, err := time.ParseInLocation("2006-01-02", *occurrence.EndDateExclusive, loc)
	if err != nil {
		return time.Time{}, ErrWorkEventInvalid
	}
	return end, nil
}

// hasFutureScheduledWorkEventsWith uses the same recurrence and exception
// expansion as Agenda. Container lifecycle therefore cannot miss a future
// recurring occurrence or count a cancelled exception as active.
func hasFutureScheduledWorkEventsWith(ctx context.Context, q taskAccessQuerier, accountID uuid.UUID, listIDs []uuid.UUID, eventID *uuid.UUID, now time.Time) (bool, error) {
	if len(listIDs) == 0 {
		return false, nil
	}
	rows, err := q.Query(ctx, `SELECT id,is_all_day,start_at,end_at,TO_CHAR(start_date,'YYYY-MM-DD'),
		TO_CHAR(end_date_exclusive,'YYYY-MM-DD'),timezone,recurrence_rule FROM work_events
		WHERE account_id=$1 AND list_id=ANY($2::uuid[]) AND ($3::uuid IS NULL OR id=$3)
		  AND deleted_at IS NULL AND status='scheduled' ORDER BY id`, accountID, listIDs, eventID)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	events := make([]*domain.WorkEvent, 0)
	ids := make([]uuid.UUID, 0)
	for rows.Next() {
		event := &domain.WorkEvent{AccountID: accountID, Status: domain.WorkEventStatusScheduled}
		if err := rows.Scan(&event.ID, &event.IsAllDay, &event.StartAt, &event.EndAt, &event.StartDate,
			&event.EndDateExclusive, &event.Timezone, &event.RecurrenceRule); err != nil {
			return false, err
		}
		events, ids = append(events, event), append(ids, event.ID)
	}
	if err := rows.Err(); err != nil {
		return false, err
	}
	overrides, err := loadWorkEventOverrides(ctx, q, accountID, ids)
	if err != nil {
		return false, err
	}
	for _, event := range events {
		occurrences, err := expandAllWorkEventOccurrences(event)
		if err != nil {
			return false, err
		}
		for _, occurrence := range occurrences {
			if override := overrides[event.ID][occurrence.OccurrenceKey]; override != nil {
				occurrence = applyWorkEventOverride(occurrence, override)
				if occurrence == nil {
					continue
				}
			}
			end, err := workEventOccurrenceEnd(occurrence)
			if err != nil {
				return false, err
			}
			if end.After(now) {
				return true, nil
			}
		}
	}
	return false, nil
}

func (r *WorkEventRepository) ListAgenda(ctx context.Context, accountID, actorID uuid.UUID, from, to time.Time, environmentID, folderID, listID *uuid.UUID, after *time.Time, afterKey string, limit int) ([]*domain.WorkEventOccurrence, error) {
	if limit < 1 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	query := `SELECT ` + workEventSelectFields("$4") + ` FROM work_events event_item ` + workEventJoins + `
		WHERE event_item.account_id=$1 AND event_item.deleted_at IS NULL
		  AND environment.archived_at IS NULL AND environment.deleted_at IS NULL
		  AND list_item.archived_at IS NULL AND list_item.deleted_at IS NULL
		  AND (folder.id IS NULL OR (folder.archived_at IS NULL AND folder.deleted_at IS NULL))
		  AND ($5::uuid IS NULL OR list_item.environment_id=$5)
		  AND ($6::uuid IS NULL OR list_item.folder_id=$6)
		  AND ($7::uuid IS NULL OR list_item.id=$7)
		  AND (` + taskActorEnvironmentAccessRankSQL("list_item", "$4") + `) >= 1
		  AND ((` + taskActorListAccessRankSQL("list_item", "$4") + `) >= 1 OR event_item.organizer_id=$4 OR EXISTS(
			SELECT 1 FROM work_event_attendees direct_attendee WHERE direct_attendee.account_id=event_item.account_id
			AND direct_attendee.event_id=event_item.id AND direct_attendee.user_id=$4))
		  AND ((event_item.recurrence_rule<>'' AND CASE WHEN event_item.is_all_day THEN event_item.start_date::timestamp AT TIME ZONE event_item.timezone ELSE event_item.start_at END < $3)
			OR (CASE WHEN event_item.is_all_day THEN event_item.start_date::timestamp AT TIME ZONE event_item.timezone ELSE event_item.start_at END < $3
			AND CASE WHEN event_item.is_all_day THEN event_item.end_date_exclusive::timestamp AT TIME ZONE event_item.timezone ELSE event_item.end_at END > $2))
		ORDER BY COALESCE(event_item.start_at,event_item.start_date::timestamp AT TIME ZONE event_item.timezone),event_item.id
		LIMIT 5000`
	rows, err := r.db.Query(ctx, query, accountID, from, to, actorID, environmentID, folderID, listID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	events := make([]*domain.WorkEvent, 0)
	ids := make([]uuid.UUID, 0)
	for rows.Next() {
		event, err := scanWorkEvent(rows, actorID)
		if err != nil {
			return nil, err
		}
		events = append(events, event)
		ids = append(ids, event.ID)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	attendeesByEvent, err := r.loadAttendees(ctx, accountID, ids)
	if err != nil {
		return nil, err
	}
	overridesByEvent, err := loadWorkEventOverrides(ctx, r.db, accountID, ids)
	if err != nil {
		return nil, err
	}
	result := make([]*domain.WorkEventOccurrence, 0)
	for _, event := range events {
		event.Attendees = attendeesByEvent[event.ID]
		if event.Attendees == nil {
			event.Attendees = []*domain.WorkEventAttendee{}
		}
		occurrences, expandErr := ExpandWorkEvent(event, from, to)
		if expandErr != nil {
			return nil, expandErr
		}
		for _, occurrence := range occurrences {
			override := overridesByEvent[event.ID][occurrence.OccurrenceKey]
			if override == nil {
				result = append(result, occurrence)
				continue
			}
			if applied := applyWorkEventOverride(occurrence, override); applied != nil {
				result = append(result, applied)
			}
		}
	}
	sort.Slice(result, func(i, j int) bool {
		left, right := result[i], result[j]
		if left.StartAt != nil && right.StartAt != nil {
			if left.StartAt.Equal(*right.StartAt) {
				return left.OccurrenceKey < right.OccurrenceKey
			}
			return left.StartAt.Before(*right.StartAt)
		}
		if left.StartDate != nil && right.StartDate != nil {
			if *left.StartDate == *right.StartDate {
				return left.OccurrenceKey < right.OccurrenceKey
			}
			return *left.StartDate < *right.StartDate
		}
		return left.StartDate != nil
	})
	if after != nil {
		filtered := result[:0]
		for _, occurrence := range result {
			var start time.Time
			if occurrence.StartAt != nil {
				start = occurrence.StartAt.UTC()
			} else if occurrence.StartDate != nil {
				start, _ = time.Parse("2006-01-02", *occurrence.StartDate)
			}
			key := "event:" + occurrence.Event.ID.String() + ":" + occurrence.OccurrenceKey
			if start.After(*after) || (start.Equal(*after) && key > afterKey) {
				filtered = append(filtered, occurrence)
			}
		}
		result = filtered
	}
	if len(result) > limit {
		result = result[:limit]
	}
	return result, nil
}

func (r *WorkEventRepository) ViewerUserIDs(ctx context.Context, accountID, eventID uuid.UUID) ([]uuid.UUID, error) {
	rows, err := r.db.Query(ctx, `SELECT membership.user_id FROM work_events event_item
		JOIN task_lists list_item ON list_item.account_id=event_item.account_id AND list_item.id=event_item.list_id
		JOIN task_environments environment ON environment.account_id=list_item.account_id AND environment.id=list_item.environment_id
		JOIN user_accounts membership ON membership.account_id=event_item.account_id
		WHERE event_item.account_id=$1 AND event_item.id=$2
		  AND (`+taskActorEnvironmentAccessRankSQL("list_item", "membership.user_id")+`) >= 1
		  AND ((`+taskActorListAccessRankSQL("list_item", "membership.user_id")+`) >= 1 OR event_item.organizer_id=membership.user_id OR EXISTS(
			SELECT 1 FROM work_event_attendees attendee WHERE attendee.account_id=event_item.account_id
			AND attendee.event_id=event_item.id AND attendee.user_id=membership.user_id))
		ORDER BY membership.user_id`, accountID, eventID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]uuid.UUID, 0)
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		result = append(result, id)
	}
	return result, rows.Err()
}

func (r *WorkEventRepository) Update(ctx context.Context, event *domain.WorkEvent, actorID uuid.UUID, confirmConflicts bool) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var currentVersion int64
	var currentListID, organizerID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT version,list_id,organizer_id FROM work_events
		WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE`, event.AccountID, event.ID).
		Scan(&currentVersion, &currentListID, &organizerID); errors.Is(err, pgx.ErrNoRows) {
		return ErrWorkEventNotFound
	} else if err != nil {
		return err
	}
	if currentVersion != event.Version {
		return ErrWorkEventVersionConflict
	}
	_, listAccessErr := r.requireListAccessWith(ctx, tx, event.AccountID, actorID, currentListID, domain.TaskAccessEdit)
	if actorID != organizerID && listAccessErr != nil {
		return listAccessErr
	}
	environmentID, err := r.requireListAccessWith(ctx, tx, event.AccountID, actorID, event.ListID, domain.TaskAccessEdit)
	if actorID == organizerID && event.ListID == currentListID && errors.Is(err, ErrWorkEventAccessDenied) {
		environmentAccess, _, envErr := resolveEnvironmentAccessWith(ctx, tx, event.AccountID, actorID, event.EnvironmentID)
		if envErr == nil && TaskAccessAllows(environmentAccess, domain.TaskAccessView) {
			environmentID, err = event.EnvironmentID, nil
		}
	}
	if err != nil {
		return err
	}
	attendees := canonicalWorkEventAttendees(event)
	if !event.AttendeesSet {
		loaded, loadErr := r.loadAttendeesWith(ctx, tx, event.AccountID, event.ID)
		if loadErr != nil {
			return loadErr
		}
		attendees = loaded
	}
	if err := validateWorkEventAttendees(ctx, tx, event.AccountID, environmentID, attendees); err != nil {
		return err
	}
	if _, _, err := workEventUTCInterval(event); err != nil {
		return err
	}
	userIDs := make([]uuid.UUID, 0, len(attendees))
	for _, attendee := range attendees {
		userIDs = append(userIDs, attendee.UserID)
	}
	if event.Availability == domain.WorkEventAvailabilityBusy {
		conflicts, conflictErr := r.eventConflictsWith(ctx, tx, event, userIDs, &event.ID)
		if conflictErr != nil {
			return conflictErr
		}
		if len(conflicts) > 0 && !confirmConflicts {
			return &WorkEventConflictConfirmationError{Conflicts: conflicts}
		}
	}
	command, err := tx.Exec(ctx, `UPDATE work_events SET list_id=$3,title=$4,description=$5,location=$6,meeting_url=$7,color=$8,
		availability=$9,is_all_day=$10,start_at=$11,end_at=$12,start_date=$13::date,end_date_exclusive=$14::date,
		timezone=$15,recurrence_rule=$16,operation_id=$17,updated_at=NOW(),version=version+1
		WHERE account_id=$1 AND id=$2 AND version=$18`, event.AccountID, event.ID, event.ListID, event.Title, event.Description,
		event.Location, event.MeetingURL, event.Color, event.Availability, event.IsAllDay, event.StartAt, event.EndAt,
		event.StartDate, event.EndDateExclusive, event.Timezone, event.RecurrenceRule, event.OperationID, event.Version)
	if err != nil {
		return err
	}
	if command.RowsAffected() == 0 {
		return ErrWorkEventVersionConflict
	}
	if event.AttendeesSet {
		if err := r.replaceAttendeesWith(ctx, tx, event, attendees); err != nil {
			return err
		}
	}
	event.Version++
	event.EnvironmentID = environmentID
	if err := r.rebuildRemindersWith(ctx, tx, event, attendees); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	event.Attendees = attendees
	return nil
}

func findWorkEventOccurrence(event *domain.WorkEvent, occurrenceKey string) (*domain.WorkEventOccurrence, error) {
	if event == nil || strings.TrimSpace(event.RecurrenceRule) == "" {
		return nil, ErrWorkEventInvalid
	}
	loc, err := time.LoadLocation(event.Timezone)
	if err != nil {
		return nil, ErrWorkEventInvalid
	}
	var center time.Time
	if event.IsAllDay {
		center, err = time.ParseInLocation("2006-01-02", occurrenceKey, loc)
	} else {
		center, err = time.Parse("20060102T150405Z", occurrenceKey)
	}
	if err != nil {
		return nil, ErrWorkEventInvalid
	}
	items, err := ExpandWorkEvent(event, center.AddDate(0, 0, -2), center.AddDate(0, 0, 3))
	if err != nil {
		return nil, err
	}
	for _, item := range items {
		if item.OccurrenceKey == occurrenceKey {
			return item, nil
		}
	}
	return nil, ErrWorkEventNotFound
}

func splitWorkEventRules(event *domain.WorkEvent, occurrenceKey string) (string, string, *domain.WorkEventOccurrence, int, error) {
	target, err := findWorkEventOccurrence(event, occurrenceKey)
	if err != nil {
		return "", "", nil, 0, err
	}
	loc, _ := time.LoadLocation(event.Timezone)
	var baseStart, targetStart time.Time
	if event.IsAllDay {
		baseStart, err = eventDateValue(event.StartDate, loc)
		targetStart, _ = time.ParseInLocation("2006-01-02", *target.StartDate, loc)
	} else {
		baseStart = event.StartAt.In(loc)
		targetStart = target.StartAt.In(loc)
	}
	if err != nil {
		return "", "", nil, 0, err
	}
	items, err := ExpandWorkEvent(event, baseStart.AddDate(0, 0, -1), targetStart.AddDate(0, 0, 2))
	if err != nil {
		return "", "", nil, 0, err
	}
	ordinal := -1
	for index, item := range items {
		if item.OccurrenceKey == occurrenceKey {
			ordinal = index
			break
		}
	}
	if ordinal < 0 {
		return "", "", nil, 0, ErrWorkEventNotFound
	}
	rule, err := ParseWorkEventRecurrence(event.RecurrenceRule, loc)
	if err != nil || rule == nil {
		return "", "", nil, 0, ErrWorkEventInvalid
	}
	baseParts := make([]string, 0)
	var originalUntil string
	for _, part := range strings.Split(strings.ToUpper(event.RecurrenceRule), ";") {
		if strings.HasPrefix(part, "COUNT=") {
			continue
		}
		if strings.HasPrefix(part, "UNTIL=") {
			originalUntil = part
			continue
		}
		baseParts = append(baseParts, part)
	}
	beforeParts := append([]string{}, baseParts...)
	if event.IsAllDay {
		beforeParts = append(beforeParts, "UNTIL="+targetStart.AddDate(0, 0, -1).Format("20060102"))
	} else {
		beforeParts = append(beforeParts, "UNTIL="+targetStart.UTC().Add(-time.Second).Format("20060102T150405Z"))
	}
	afterParts := append([]string{}, baseParts...)
	if rule.Count > 0 {
		remaining := rule.Count - ordinal
		if remaining < 1 {
			return "", "", nil, 0, ErrWorkEventInvalid
		}
		afterParts = append(afterParts, fmt.Sprintf("COUNT=%d", remaining))
	} else if originalUntil != "" {
		afterParts = append(afterParts, originalUntil)
	}
	return strings.Join(beforeParts, ";"), strings.Join(afterParts, ";"), target, ordinal, nil
}

// UpdateOccurrence writes one complete exception snapshot and advances the
// series version so HTTP and realtime ordering remain canonical. The base
// series is never rewritten for a single-occurrence edit.
func (r *WorkEventRepository) UpdateOccurrence(ctx context.Context, base, changed *domain.WorkEvent, occurrenceKey string, actorID uuid.UUID, cancel, confirmConflicts bool) error {
	if base == nil || changed == nil || base.ID != changed.ID || base.AccountID != changed.AccountID || changed.ListID != base.ListID {
		return ErrWorkEventInvalid
	}
	if _, err := findWorkEventOccurrence(base, occurrenceKey); err != nil {
		return err
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var currentVersion int64
	var listID, organizerID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT version,list_id,organizer_id FROM work_events
		WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE`, base.AccountID, base.ID).Scan(&currentVersion, &listID, &organizerID); errors.Is(err, pgx.ErrNoRows) {
		return ErrWorkEventNotFound
	} else if err != nil {
		return err
	}
	if currentVersion != base.Version {
		return ErrWorkEventVersionConflict
	}
	if actorID != organizerID {
		if _, err := r.requireListAccessWith(ctx, tx, base.AccountID, actorID, listID, domain.TaskAccessEdit); err != nil {
			return err
		}
	}
	if !cancel {
		if _, _, err := workEventUTCInterval(changed); err != nil {
			return err
		}
		attendees, err := r.loadAttendeesWith(ctx, tx, base.AccountID, base.ID)
		if err != nil {
			return err
		}
		if changed.Availability == domain.WorkEventAvailabilityBusy {
			start, end, _ := workEventUTCInterval(changed)
			userIDs := make([]uuid.UUID, 0, len(attendees))
			for _, attendee := range attendees {
				userIDs = append(userIDs, attendee.UserID)
			}
			conflicts, err := r.busyIntervalsWith(ctx, tx, base.AccountID, userIDs, start, end, &base.ID)
			if err != nil {
				return err
			}
			if len(conflicts) > 0 && !confirmConflicts {
				return &WorkEventConflictConfirmationError{Conflicts: conflicts}
			}
		}
	}
	_, err = tx.Exec(ctx, `INSERT INTO work_event_occurrence_overrides(account_id,event_id,occurrence_key,is_cancelled,
		title,description,location,meeting_url,color,color_set,availability,is_all_day,start_at,end_at,start_date,end_date_exclusive,
		timezone,operation_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE,$10,$11,$12,$13,$14::date,$15::date,$16,$17,$18)
		ON CONFLICT(account_id,event_id,occurrence_key) DO UPDATE SET is_cancelled=EXCLUDED.is_cancelled,title=EXCLUDED.title,
		description=EXCLUDED.description,location=EXCLUDED.location,meeting_url=EXCLUDED.meeting_url,color=EXCLUDED.color,color_set=TRUE,
		availability=EXCLUDED.availability,is_all_day=EXCLUDED.is_all_day,start_at=EXCLUDED.start_at,end_at=EXCLUDED.end_at,
		start_date=EXCLUDED.start_date,end_date_exclusive=EXCLUDED.end_date_exclusive,timezone=EXCLUDED.timezone,
		operation_id=EXCLUDED.operation_id,version=work_event_occurrence_overrides.version+1,updated_at=NOW()`,
		base.AccountID, base.ID, occurrenceKey, cancel, changed.Title, changed.Description, changed.Location, changed.MeetingURL,
		changed.Color, changed.Availability, changed.IsAllDay, changed.StartAt, changed.EndAt, changed.StartDate,
		changed.EndDateExclusive, changed.Timezone, changed.OperationID, actorID)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE work_events SET version=version+1,operation_id=$3,updated_at=NOW()
		WHERE account_id=$1 AND id=$2 AND version=$4`, base.AccountID, base.ID, changed.OperationID, base.Version); err != nil {
		return err
	}
	changed.Version = base.Version + 1
	reminderEvent, attendees, err := r.loadEventForReminderWith(ctx, tx, base.AccountID, base.ID)
	if err != nil {
		return err
	}
	if err := r.rebuildRemindersWith(ctx, tx, reminderEvent, attendees); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// SplitFollowing closes the original rule immediately before the selected
// occurrence and creates a new series for that occurrence and its future.
// Historical rows and occurrence keys remain untouched.
func (r *WorkEventRepository) SplitFollowing(ctx context.Context, base, changed *domain.WorkEvent, occurrenceKey string, actorID uuid.UUID, confirmConflicts bool) (uuid.UUID, error) {
	if base == nil || changed == nil || base.ID != changed.ID || base.AccountID != changed.AccountID {
		return uuid.Nil, ErrWorkEventInvalid
	}
	beforeRule, afterRule, _, ordinal, err := splitWorkEventRules(base, occurrenceKey)
	if err != nil {
		return uuid.Nil, err
	}
	if ordinal == 0 {
		changed.RecurrenceRule = afterRule
		if err := r.Update(ctx, changed, actorID, confirmConflicts); err != nil {
			return uuid.Nil, err
		}
		return changed.ID, nil
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return uuid.Nil, err
	}
	defer tx.Rollback(ctx)
	var currentVersion int64
	var currentListID, organizerID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT version,list_id,organizer_id FROM work_events
		WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE`, base.AccountID, base.ID).Scan(&currentVersion, &currentListID, &organizerID); errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, ErrWorkEventNotFound
	} else if err != nil {
		return uuid.Nil, err
	}
	if currentVersion != base.Version {
		return uuid.Nil, ErrWorkEventVersionConflict
	}
	if actorID != organizerID {
		if _, err := r.requireListAccessWith(ctx, tx, base.AccountID, actorID, currentListID, domain.TaskAccessEdit); err != nil {
			return uuid.Nil, err
		}
	}
	environmentID, err := r.requireListAccessWith(ctx, tx, base.AccountID, actorID, changed.ListID, domain.TaskAccessEdit)
	if err != nil {
		return uuid.Nil, err
	}
	var futureOverrides int
	if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM work_event_occurrence_overrides
		WHERE account_id=$1 AND event_id=$2 AND occurrence_key >= $3`, base.AccountID, base.ID, occurrenceKey).Scan(&futureOverrides); err != nil {
		return uuid.Nil, err
	}
	if futureOverrides > 0 {
		return uuid.Nil, ErrWorkEventInvalid
	}
	attendees := canonicalWorkEventAttendees(changed)
	if !changed.AttendeesSet {
		attendees, err = r.loadAttendeesWith(ctx, tx, base.AccountID, base.ID)
		if err != nil {
			return uuid.Nil, err
		}
	}
	if err := validateWorkEventAttendees(ctx, tx, base.AccountID, environmentID, attendees); err != nil {
		return uuid.Nil, err
	}
	start, end, err := workEventUTCInterval(changed)
	if err != nil {
		return uuid.Nil, err
	}
	if changed.Availability == domain.WorkEventAvailabilityBusy {
		userIDs := make([]uuid.UUID, 0, len(attendees))
		for _, attendee := range attendees {
			userIDs = append(userIDs, attendee.UserID)
		}
		conflicts, err := r.busyIntervalsWith(ctx, tx, base.AccountID, userIDs, start, end, &base.ID)
		if err != nil {
			return uuid.Nil, err
		}
		if len(conflicts) > 0 && !confirmConflicts {
			return uuid.Nil, &WorkEventConflictConfirmationError{Conflicts: conflicts}
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE work_events SET recurrence_rule=$3,version=version+1,operation_id=$4,updated_at=NOW()
		WHERE account_id=$1 AND id=$2 AND version=$5`, base.AccountID, base.ID, beforeRule, changed.OperationID, base.Version); err != nil {
		return uuid.Nil, err
	}
	newID := uuid.New()
	rootID := base.ID
	if base.SeriesRootID != nil {
		rootID = *base.SeriesRootID
	}
	changed.ID, changed.SeriesRootID, changed.RecurrenceRule = newID, &rootID, afterRule
	changed.OrganizerID, changed.CreatedBy, changed.EnvironmentID, changed.Version = organizerID, actorID, environmentID, 1
	_, err = tx.Exec(ctx, `INSERT INTO work_events(id,account_id,list_id,organizer_id,title,description,location,meeting_url,color,availability,
		is_all_day,start_at,end_at,start_date,end_date_exclusive,timezone,recurrence_rule,series_root_id,status,operation_id,created_by)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::date,$15::date,$16,$17,$18,'scheduled',$19,$20)`,
		newID, base.AccountID, changed.ListID, organizerID, changed.Title, changed.Description, changed.Location, changed.MeetingURL,
		changed.Color, changed.Availability, changed.IsAllDay, changed.StartAt, changed.EndAt, changed.StartDate,
		changed.EndDateExclusive, changed.Timezone, afterRule, rootID, changed.OperationID, actorID)
	if err != nil {
		return uuid.Nil, err
	}
	if err := r.replaceAttendeesWith(ctx, tx, changed, attendees); err != nil {
		return uuid.Nil, err
	}
	oldReminderEvent, oldAttendees, err := r.loadEventForReminderWith(ctx, tx, base.AccountID, base.ID)
	if err != nil {
		return uuid.Nil, err
	}
	if err := r.rebuildRemindersWith(ctx, tx, oldReminderEvent, oldAttendees); err != nil {
		return uuid.Nil, err
	}
	if err := r.rebuildRemindersWith(ctx, tx, changed, attendees); err != nil {
		return uuid.Nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return uuid.Nil, err
	}
	return newID, nil
}

func (r *WorkEventRepository) UpdateAppearance(ctx context.Context, accountID, eventID, actorID uuid.UUID, color *string, version int64, operationID *uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var currentVersion int64
	var listID, organizerID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT version,list_id,organizer_id FROM work_events
		WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE`, accountID, eventID).
		Scan(&currentVersion, &listID, &organizerID); errors.Is(err, pgx.ErrNoRows) {
		return ErrWorkEventNotFound
	} else if err != nil {
		return err
	}
	if version != currentVersion {
		return ErrWorkEventVersionConflict
	}
	if actorID != organizerID {
		if _, err := r.requireListAccessWith(ctx, tx, accountID, actorID, listID, domain.TaskAccessEdit); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE work_events SET color=$3,operation_id=$4,version=version+1,updated_at=NOW()
		WHERE account_id=$1 AND id=$2`, accountID, eventID, color, operationID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *WorkEventRepository) loadAttendeesWith(ctx context.Context, q taskAccessQuerier, accountID, eventID uuid.UUID) ([]*domain.WorkEventAttendee, error) {
	rows, err := q.Query(ctx, `SELECT attendee.user_id,attendee.attendance_type,attendee.rsvp,attendee.reminder_minutes,attendee.version,
		attendee.created_at,attendee.updated_at FROM work_event_attendees attendee
		WHERE attendee.account_id=$1 AND attendee.event_id=$2 ORDER BY attendee.user_id`, accountID, eventID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]*domain.WorkEventAttendee, 0)
	for rows.Next() {
		item := &domain.WorkEventAttendee{}
		if err := rows.Scan(&item.UserID, &item.AttendanceType, &item.RSVP, &item.ReminderMinutes, &item.Version, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (r *WorkEventRepository) SetRSVP(ctx context.Context, accountID, eventID, actorID uuid.UUID, rsvp string, version int64) error {
	if rsvp != domain.WorkEventRSVPAccepted && rsvp != domain.WorkEventRSVPTentative && rsvp != domain.WorkEventRSVPDeclined {
		return ErrWorkEventInvalid
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var organizerID uuid.UUID
	var eventVersion int64
	if err := tx.QueryRow(ctx, `SELECT organizer_id,version FROM work_events WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE`, accountID, eventID).
		Scan(&organizerID, &eventVersion); errors.Is(err, pgx.ErrNoRows) {
		return ErrWorkEventNotFound
	} else if err != nil {
		return err
	}
	if actorID == organizerID {
		return ErrWorkEventAccessDenied
	}
	command, err := tx.Exec(ctx, `UPDATE work_event_attendees SET rsvp=$4,version=version+1,updated_at=NOW()
		WHERE account_id=$1 AND event_id=$2 AND user_id=$3 AND version=$5`, accountID, eventID, actorID, rsvp, version)
	if err != nil {
		return err
	}
	if command.RowsAffected() == 0 {
		return ErrWorkEventVersionConflict
	}
	event, attendees, err := r.loadEventForReminderWith(ctx, tx, accountID, eventID)
	if err != nil {
		return err
	}
	if err := r.rebuildRemindersWith(ctx, tx, event, attendees); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *WorkEventRepository) SetOwnReminder(ctx context.Context, accountID, eventID, actorID uuid.UUID, minutes *int, version int64) error {
	if minutes != nil && (*minutes < 0 || *minutes > 525600) {
		return ErrWorkEventInvalid
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	command, err := tx.Exec(ctx, `UPDATE work_event_attendees SET reminder_minutes=$4,version=version+1,updated_at=NOW()
		WHERE account_id=$1 AND event_id=$2 AND user_id=$3 AND version=$5`, accountID, eventID, actorID, minutes, version)
	if err != nil {
		return err
	}
	if command.RowsAffected() == 0 {
		return ErrWorkEventVersionConflict
	}
	event, attendees, err := r.loadEventForReminderWith(ctx, tx, accountID, eventID)
	if err != nil {
		return err
	}
	if err := r.rebuildRemindersWith(ctx, tx, event, attendees); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *WorkEventRepository) loadEventForReminderWith(ctx context.Context, q taskAccessQuerier, accountID, eventID uuid.UUID) (*domain.WorkEvent, []*domain.WorkEventAttendee, error) {
	event := &domain.WorkEvent{ID: eventID, AccountID: accountID}
	if err := q.QueryRow(ctx, `SELECT list_id,organizer_id,title,is_all_day,start_at,end_at,TO_CHAR(start_date,'YYYY-MM-DD'),
		TO_CHAR(end_date_exclusive,'YYYY-MM-DD'),timezone,recurrence_rule,status,deleted_at FROM work_events
		WHERE account_id=$1 AND id=$2`, accountID, eventID).Scan(&event.ListID, &event.OrganizerID, &event.Title, &event.IsAllDay,
		&event.StartAt, &event.EndAt, &event.StartDate, &event.EndDateExclusive, &event.Timezone, &event.RecurrenceRule, &event.Status, &event.DeletedAt); err != nil {
		return nil, nil, err
	}
	attendees, err := r.loadAttendeesWith(ctx, q, accountID, eventID)
	return event, attendees, err
}

func (r *WorkEventRepository) transition(ctx context.Context, accountID, eventID, actorID uuid.UUID, version int64, operationID *uuid.UUID, action string) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var currentVersion int64
	var listID, organizerID uuid.UUID
	var status string
	var deletedAt *time.Time
	var otherAttendees int
	if err := tx.QueryRow(ctx, `SELECT event_item.version,event_item.list_id,event_item.organizer_id,event_item.status,event_item.deleted_at,
		(SELECT COUNT(*) FROM work_event_attendees attendee WHERE attendee.account_id=event_item.account_id AND attendee.event_id=event_item.id AND attendee.user_id<>event_item.organizer_id)
		FROM work_events event_item WHERE event_item.account_id=$1 AND event_item.id=$2 FOR UPDATE`, accountID, eventID).
		Scan(&currentVersion, &listID, &organizerID, &status, &deletedAt, &otherAttendees); errors.Is(err, pgx.ErrNoRows) {
		return ErrWorkEventNotFound
	} else if err != nil {
		return err
	}
	if currentVersion != version {
		return ErrWorkEventVersionConflict
	}
	if actorID != organizerID {
		if _, err := r.requireListAccessWith(ctx, tx, accountID, actorID, listID, domain.TaskAccessEdit); err != nil {
			return err
		}
	}
	switch action {
	case "cancel":
		if deletedAt != nil {
			return ErrWorkEventNotFound
		}
		_, err = tx.Exec(ctx, `UPDATE work_events SET status='cancelled',cancelled_at=NOW(),cancelled_by=$3,
			operation_id=$4,version=version+1,updated_at=NOW() WHERE account_id=$1 AND id=$2`, accountID, eventID, actorID, operationID)
	case "trash":
		if deletedAt != nil {
			return ErrWorkEventNotFound
		}
		future, futureErr := hasFutureScheduledWorkEventsWith(ctx, tx, accountID, []uuid.UUID{listID}, &eventID, time.Now())
		if futureErr != nil {
			return futureErr
		}
		if future && otherAttendees > 0 && status != domain.WorkEventStatusCancelled {
			return ErrWorkEventCancelRequired
		}
		_, err = tx.Exec(ctx, `UPDATE work_events SET deleted_at=NOW(),deleted_by=$3,operation_id=$4,version=version+1,updated_at=NOW()
			WHERE account_id=$1 AND id=$2`, accountID, eventID, actorID, operationID)
	case "restore":
		if deletedAt == nil {
			return ErrWorkEventNotFound
		}
		if _, accessErr := r.requireListAccessWith(ctx, tx, accountID, actorID, listID, domain.TaskAccessEdit); accessErr != nil {
			return accessErr
		}
		_, err = tx.Exec(ctx, `UPDATE work_events SET deleted_at=NULL,deleted_by=NULL,operation_id=$3,version=version+1,updated_at=NOW()
			WHERE account_id=$1 AND id=$2`, accountID, eventID, operationID)
	default:
		return ErrWorkEventInvalid
	}
	if err != nil {
		return err
	}
	event, attendees, loadErr := r.loadEventForReminderWith(ctx, tx, accountID, eventID)
	if loadErr != nil {
		return loadErr
	}
	if err := r.rebuildRemindersWith(ctx, tx, event, attendees); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *WorkEventRepository) Cancel(ctx context.Context, accountID, eventID, actorID uuid.UUID, version int64, operationID *uuid.UUID) error {
	return r.transition(ctx, accountID, eventID, actorID, version, operationID, "cancel")
}

func (r *WorkEventRepository) Trash(ctx context.Context, accountID, eventID, actorID uuid.UUID, version int64, operationID *uuid.UUID) error {
	return r.transition(ctx, accountID, eventID, actorID, version, operationID, "trash")
}

func (r *WorkEventRepository) Restore(ctx context.Context, accountID, eventID, actorID uuid.UUID, version int64, operationID *uuid.UUID) error {
	return r.transition(ctx, accountID, eventID, actorID, version, operationID, "restore")
}

func (r *WorkEventRepository) Purge(ctx context.Context, accountID, eventID, actorID uuid.UUID, exactTitle string, version int64) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var title string
	var eligible bool
	var currentVersion int64
	if err := tx.QueryRow(ctx, `SELECT event_item.title,event_item.version,
		(event_item.deleted_at IS NOT NULL AND account.task_trash_retention_days IS NOT NULL
		 AND event_item.deleted_at + account.task_trash_retention_days * INTERVAL '1 day' <= NOW())
		FROM work_events event_item JOIN accounts account ON account.id=event_item.account_id
		JOIN user_accounts membership ON membership.account_id=event_item.account_id AND membership.user_id=$3
		JOIN users actor ON actor.id=membership.user_id
		WHERE event_item.account_id=$1 AND event_item.id=$2
		  AND (membership.role IN ('admin','super_admin') OR actor.is_super_admin)
		FOR UPDATE OF event_item`, accountID, eventID, actorID).Scan(&title, &currentVersion, &eligible); errors.Is(err, pgx.ErrNoRows) {
		return ErrWorkEventPurgeForbidden
	} else if err != nil {
		return err
	}
	if currentVersion != version {
		return ErrWorkEventVersionConflict
	}
	if title != exactTitle || !eligible {
		return ErrWorkEventPurgeForbidden
	}
	if _, err := tx.Exec(ctx, `DELETE FROM work_events WHERE account_id=$1 AND id=$2`, accountID, eventID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *WorkEventRepository) Availability(ctx context.Context, accountID uuid.UUID, userIDs []uuid.UUID, start, end time.Time) ([]WorkEventBusyInterval, error) {
	return r.busyIntervalsWith(ctx, r.db, accountID, userIDs, start, end, nil)
}

func (r *WorkEventRepository) ClaimPendingReminders(ctx context.Context) ([]domain.WorkEventReminderJob, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `SELECT job.id,job.account_id,job.event_id,job.occurrence_key,job.user_id,job.reminder_at,
		COALESCE(occurrence_override.title,event_item.title),
		CASE WHEN COALESCE(occurrence_override.is_all_day,event_item.is_all_day) THEN NULL ELSE occurrence_override.start_at END,
		CASE WHEN COALESCE(occurrence_override.is_all_day,event_item.is_all_day)
			THEN COALESCE(TO_CHAR(occurrence_override.start_date,'YYYY-MM-DD'),job.occurrence_key) ELSE NULL END
		FROM work_event_reminder_jobs job JOIN work_events event_item ON event_item.account_id=job.account_id AND event_item.id=job.event_id
		JOIN work_event_attendees attendee ON attendee.account_id=job.account_id AND attendee.event_id=job.event_id AND attendee.user_id=job.user_id
		LEFT JOIN work_event_occurrence_overrides occurrence_override ON occurrence_override.account_id=job.account_id
		  AND occurrence_override.event_id=job.event_id AND occurrence_override.occurrence_key=job.occurrence_key
		WHERE job.delivered_at IS NULL AND job.cancelled_at IS NULL AND job.reminder_at<=NOW()
		  AND event_item.deleted_at IS NULL AND event_item.status='scheduled' AND attendee.rsvp IN ('accepted','tentative')
		ORDER BY job.reminder_at,job.id LIMIT 200 FOR UPDATE OF job SKIP LOCKED`)
	if err != nil {
		return nil, err
	}
	result := make([]domain.WorkEventReminderJob, 0)
	ids := make([]uuid.UUID, 0)
	for rows.Next() {
		var item domain.WorkEventReminderJob
		if err := rows.Scan(&item.ID, &item.AccountID, &item.EventID, &item.OccurrenceKey, &item.UserID, &item.ReminderAt,
			&item.Title, &item.StartAt, &item.StartDate); err != nil {
			rows.Close()
			return nil, err
		}
		if item.StartDate == nil {
			if startAt, parseErr := time.Parse("20060102T150405Z", item.OccurrenceKey); parseErr == nil {
				item.StartAt = &startAt
			}
		}
		result = append(result, item)
		ids = append(ids, item.ID)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if len(ids) > 0 {
		command, err := tx.Exec(ctx, `UPDATE work_event_reminder_jobs SET delivered_at=NOW(),updated_at=NOW()
			WHERE id=ANY($1::uuid[]) AND delivered_at IS NULL AND cancelled_at IS NULL`, ids)
		if err != nil {
			return nil, err
		}
		if command.RowsAffected() != int64(len(ids)) {
			return nil, errors.New("work event reminder claim changed concurrently")
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return result, nil
}
