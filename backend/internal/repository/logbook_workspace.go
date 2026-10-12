package repository

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/formula"
	"strings"
	"time"
)

var ErrLogbookCompleted = errors.New("logbook is completed")
var ErrLogbookVersion = errors.New("logbook changed")
var ErrLogbookTransition = errors.New("invalid logbook transition")

type LogbookWriteOptions struct {
	ExpectedVersion int64
	ActorID         *uuid.UUID
}

func logbookWriteOption(options []LogbookWriteOptions) LogbookWriteOptions {
	if len(options) > 0 {
		return options[0]
	}
	return LogbookWriteOptions{}
}

// One query predicate for preview and capture. Never ignore invalid input and
// accidentally broaden a historical capture. Contact is the live identity owner.
const logbookNameSQL = `CASE WHEN ep.contact_id IS NULL THEN COALESCE(ep.name,'') ELSE COALESCE(NULLIF(BTRIM(c.custom_name),''),NULLIF(BTRIM(c.name),''),NULLIF(BTRIM(c.push_name),''),NULLIF(BTRIM(c.short_name),''),NULLIF(BTRIM(c.phone),''),c.jid,'') END`
const logbookPhoneSQL = `CASE WHEN ep.contact_id IS NULL THEN ep.phone ELSE c.phone END`
const logbookEmailSQL = `CASE WHEN ep.contact_id IS NULL THEN ep.email ELSE c.email END`
const logbookParticipantFrom = ` FROM event_participants ep JOIN events scope ON scope.id=ep.event_id LEFT JOIN contacts c ON c.id=ep.contact_id AND c.account_id=scope.account_id LEFT JOIN event_pipeline_stages eps ON eps.id=ep.stage_id AND eps.pipeline_id=scope.pipeline_id `

func snapshotPredicate(eventID uuid.UUID, filter *SnapshotFilter) (string, []interface{}, error) {
	args := []interface{}{eventID}
	where := []string{"ep.event_id=$1", "ep.membership_state='active'"}
	add := func(sql string, value interface{}) {
		args = append(args, value)
		where = append(where, fmt.Sprintf(sql, len(args)))
	}
	if filter == nil {
		return strings.Join(where, " AND "), args, nil
	}
	tagMode := strings.ToUpper(filter.TagMode)
	if tagMode != "" && tagMode != "AND" && tagMode != "OR" {
		return "", nil, ErrLogbookInvalid
	}
	if filter.TagFormula != "" {
		ast, err := formula.Parse(filter.TagFormula)
		if err != nil || ast == nil {
			return "", nil, ErrLogbookInvalid
		}
		sql, values, err := formula.BuildSQLForParticipants(ast, eventID)
		if err != nil || sql == "" {
			return "", nil, ErrLogbookInvalid
		}
		where = append(where, "ep.id IN ("+formula.RemapSQLParams(sql, len(values), len(args)+1)+")")
		args = append(args, values...)
	} else {
		if len(filter.TagNames) > 0 {
			sql := `ep.contact_id IN (SELECT ct.contact_id FROM contact_tags ct JOIN tags t ON t.id=ct.tag_id WHERE t.account_id=scope.account_id AND t.name=ANY($%d::text[])`
			if tagMode == "AND" {
				sql += fmt.Sprintf(" GROUP BY ct.contact_id HAVING COUNT(DISTINCT t.name)=%d", len(filter.TagNames))
			}
			sql += ")"
			add(sql, filter.TagNames)
		}
		if len(filter.ExcludeTagNames) > 0 {
			add(`NOT EXISTS(SELECT 1 FROM contact_tags ct JOIN tags t ON t.id=ct.tag_id WHERE ct.contact_id=ep.contact_id AND t.account_id=scope.account_id AND t.name=ANY($%d::text[]))`, filter.ExcludeTagNames)
		}
	}
	if filter.StageIDs != "" {
		ids := []uuid.UUID{}
		none := false
		for _, raw := range strings.Split(filter.StageIDs, ",") {
			if raw == "unassigned" {
				none = true
				continue
			}
			id, err := uuid.Parse(strings.TrimSpace(raw))
			if err != nil {
				return "", nil, ErrLogbookInvalid
			}
			ids = append(ids, id)
		}
		if len(ids) > 0 {
			sql := "ep.stage_id=ANY($%d::uuid[])"
			if none {
				sql = "(" + sql + " OR ep.stage_id IS NULL)"
			}
			add(sql, ids)
		} else if none {
			where = append(where, "ep.stage_id IS NULL")
		}
	}
	if filter.HasPhone {
		where = append(where, "NULLIF("+logbookPhoneSQL+",'') IS NOT NULL")
	}
	if filter.TextSearch != "" {
		args = append(args, "%"+filter.TextSearch+"%")
		n := len(args)
		where = append(where, fmt.Sprintf("((%s) ILIKE $%d OR (%s) ILIKE $%d OR (%s) ILIKE $%d)", logbookNameSQL, n, logbookPhoneSQL, n, logbookEmailSQL, n))
	}
	if filter.DateField != "" || filter.DateFrom != "" || filter.DateTo != "" {
		if !snapshotDateFields[filter.DateField] {
			return "", nil, ErrLogbookInvalid
		}
		var start, end time.Time
		for _, bound := range []struct{ value, operator string }{{filter.DateFrom, ">="}, {filter.DateTo, "<"}} {
			if bound.value != "" {
				value, err := time.Parse(time.RFC3339, bound.value)
				if err != nil {
					return "", nil, ErrLogbookInvalid
				}
				if bound.operator == ">=" {
					start = value
				} else {
					end = value
				}
				add("ep."+filter.DateField+bound.operator+"$%d", value)
			}
		}
		if !start.IsZero() && !end.IsZero() && !end.After(start) {
			return "", nil, ErrLogbookInvalid
		}
	}
	return strings.Join(where, " AND "), args, nil
}
func savedSnapshotFilter(raw json.RawMessage) (*SnapshotFilter, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var f SnapshotFilter
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&f); err != nil {
		return nil, ErrLogbookInvalid
	}
	return &f, nil
}
func lockLogbook(ctx context.Context, tx pgx.Tx, accountID, eventID, id uuid.UUID, expected int64, allowCompleted bool) (string, *time.Time, error) {
	if err := lockWritableLogbookEvent(ctx, tx, accountID, eventID); err != nil {
		return "", nil, err
	}
	var status string
	var captured *time.Time
	var version int64
	if err := tx.QueryRow(ctx, `SELECT status,captured_at,version FROM event_logbooks WHERE id=$1 AND account_id=$2 AND event_id=$3 FOR UPDATE`, id, accountID, eventID).Scan(&status, &captured, &version); err != nil {
		return "", nil, err
	}
	if expected > 0 && version != expected {
		return "", nil, ErrLogbookVersion
	}
	if status == domain.LogbookStatusCompleted && !allowCompleted {
		return "", nil, ErrLogbookCompleted
	}
	return status, captured, nil
}
func recordLogbookAction(ctx context.Context, tx pgx.Tx, accountID, eventID, id uuid.UUID, action string, actor *uuid.UUID) error {
	_, err := tx.Exec(ctx, `INSERT INTO event_logbook_actions(account_id,event_id,logbook_id,action,actor_id,version) SELECT account_id,event_id,id,$4,$5,version FROM event_logbooks WHERE id=$1 AND account_id=$2 AND event_id=$3`, id, accountID, eventID, action, actor)
	return err
}
func logbookTransition(status string, captured bool, action string) (string, error) {
	if action == "complete" && status == domain.LogbookStatusActive && captured {
		return domain.LogbookStatusCompleted, nil
	}
	if action == "reopen" && status == domain.LogbookStatusCompleted {
		if captured {
			return domain.LogbookStatusActive, nil
		}
		return domain.LogbookStatusPending, nil
	}
	return "", ErrLogbookTransition
}
func (r *LogbookRepository) Transition(ctx context.Context, accountID, eventID, id uuid.UUID, action string, options LogbookWriteOptions) (*domain.EventLogbook, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	status, captured, err := lockLogbook(ctx, tx, accountID, eventID, id, options.ExpectedVersion, true)
	if err != nil {
		return nil, err
	}
	next, err := logbookTransition(status, captured != nil, action)
	if err != nil {
		return nil, err
	}
	_, err = tx.Exec(ctx, `UPDATE event_logbooks SET status=$4::text,completed_at=CASE WHEN $4::text='completed' THEN NOW() ELSE NULL END,completed_by=CASE WHEN $4::text='completed' THEN $5::uuid ELSE NULL END,version=version+1,updated_at=NOW() WHERE id=$1 AND account_id=$2 AND event_id=$3`, id, accountID, eventID, next, options.ActorID)
	if err != nil {
		return nil, err
	}
	if err = recordLogbookAction(ctx, tx, accountID, eventID, id, action, options.ActorID); err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return r.GetByIDForEvent(ctx, accountID, eventID, id)
}

type LogbookPageOptions struct {
	Limit                            int
	Cursor, Search, Status, StageKey string
	NotesOnly                        bool
}
type LogbookPage struct {
	Items      []*domain.EventLogbook `json:"items"`
	Total      int                    `json:"total"`
	NextCursor string                 `json:"next_cursor,omitempty"`
}
type LogbookEntriesPage struct {
	Items      []*domain.EventLogbookEntry `json:"items"`
	Total      int                         `json:"total"`
	NextCursor string                      `json:"next_cursor,omitempty"`
}
type logbookCursor struct {
	Date     string    `json:"d,omitempty"`
	Position int       `json:"p,omitempty"`
	Key      string    `json:"k,omitempty"`
	ID       uuid.UUID `json:"i"`
}

func logbookLimit(limit int) int {
	if limit <= 0 {
		return 50
	}
	if limit > 200 {
		return 200
	}
	return limit
}
func encodeLogbookCursor(c logbookCursor) string {
	b, _ := json.Marshal(c)
	return base64.RawURLEncoding.EncodeToString(b)
}
func decodeLogbookCursor(raw string) (logbookCursor, error) {
	var c logbookCursor
	if raw == "" {
		return c, nil
	}
	b, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return c, ErrLogbookInvalid
	}
	if json.Unmarshal(b, &c) != nil || c.ID == uuid.Nil {
		return c, ErrLogbookInvalid
	}
	return c, nil
}
func (r *LogbookRepository) ListPage(ctx context.Context, accountID, eventID uuid.UUID, o LogbookPageOptions) (*LogbookPage, error) {
	if o.Status != "" && !validLogbookStatus(o.Status) {
		return nil, ErrLogbookInvalid
	}
	cursor, err := decodeLogbookCursor(o.Cursor)
	if err != nil {
		return nil, err
	}
	result := &LogbookPage{Items: []*domain.EventLogbook{}}
	args := []interface{}{accountID, eventID, "%" + o.Search + "%", o.Status}
	where := `l.account_id=$1 AND l.event_id=$2 AND (l.title ILIKE $3 OR l.date::text ILIKE $3) AND ($4::text='' OR l.status=$4)`
	if err = r.db.QueryRow(ctx, `SELECT COUNT(*) FROM event_logbooks l WHERE `+where, args...).Scan(&result.Total); err != nil {
		return nil, err
	}
	if cursor.ID != uuid.Nil {
		date, parseErr := time.Parse("2006-01-02", cursor.Date)
		if parseErr != nil {
			return nil, ErrLogbookInvalid
		}
		args = append(args, date, cursor.ID)
		where += ` AND (l.date,l.id)<($5::date,$6::uuid)`
	}
	args = append(args, logbookLimit(o.Limit)+1)
	rows, err := r.db.Query(ctx, logbookSelect+` WHERE `+where+fmt.Sprintf(` ORDER BY l.date DESC,l.id DESC LIMIT $%d`, len(args)), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		lb, err := scanLogbook(rows)
		if err != nil {
			return nil, err
		}
		result.Items = append(result.Items, lb)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	if len(result.Items) > logbookLimit(o.Limit) {
		result.Items = result.Items[:logbookLimit(o.Limit)]
		last := result.Items[len(result.Items)-1]
		result.NextCursor = encodeLogbookCursor(logbookCursor{Date: last.Date.Format("2006-01-02"), ID: last.ID})
	}
	return result, nil
}

const logbookSelect = `SELECT l.id,l.event_id,l.account_id,l.date,l.title,l.status,l.general_notes,l.stage_snapshot,l.total_participants,l.captured_at,l.created_by,l.created_at,l.updated_at,u.display_name,l.saved_filter,l.version,l.captured_by,l.completed_at,l.completed_by,l.captured_filter FROM event_logbooks l JOIN events event_scope ON event_scope.id=l.event_id AND event_scope.account_id=l.account_id LEFT JOIN users u ON u.id=l.created_by`

func scanLogbook(row pgx.Row) (*domain.EventLogbook, error) {
	lb := &domain.EventLogbook{}
	var stages, saved []byte
	err := row.Scan(&lb.ID, &lb.EventID, &lb.AccountID, &lb.Date, &lb.Title, &lb.Status, &lb.GeneralNotes, &stages, &lb.TotalParticipants, &lb.CapturedAt, &lb.CreatedBy, &lb.CreatedAt, &lb.UpdatedAt, &lb.CreatedByName, &saved, &lb.Version, &lb.CapturedBy, &lb.CompletedAt, &lb.CompletedBy, &lb.CapturedFilter)
	if err != nil {
		return nil, err
	}
	_ = json.Unmarshal(stages, &lb.StageSnapshot)
	lb.SavedFilter = saved
	return lb, nil
}

const logbookEntrySelect = `SELECT e.id,e.logbook_id,e.participant_id,e.stage_id,e.stage_name,e.stage_color,e.notes,e.created_at,COALESCE(e.capture_stage_key,'unassigned'),e.stage_position,` + logbookNameSQL + `,` + logbookPhoneSQL + ` FROM event_logbook_entries e JOIN event_logbooks lb ON lb.id=e.logbook_id JOIN events scope ON scope.id=lb.event_id AND scope.account_id=lb.account_id JOIN event_participants ep ON ep.id=e.participant_id AND ep.event_id=lb.event_id LEFT JOIN contacts c ON c.id=ep.contact_id AND c.account_id=lb.account_id `

func scanLogbookEntry(row pgx.Row) (*domain.EventLogbookEntry, error) {
	e := &domain.EventLogbookEntry{}
	err := row.Scan(&e.ID, &e.LogbookID, &e.ParticipantID, &e.StageID, &e.StageName, &e.StageColor, &e.Notes, &e.CreatedAt, &e.CaptureStageKey, &e.StagePosition, &e.ParticipantName, &e.ParticipantPhone)
	return e, err
}
func (r *LogbookRepository) EntriesPage(ctx context.Context, accountID, eventID, id uuid.UUID, o LogbookPageOptions) (*LogbookEntriesPage, error) {
	cursor, err := decodeLogbookCursor(o.Cursor)
	if err != nil {
		return nil, err
	}
	out := &LogbookEntriesPage{Items: []*domain.EventLogbookEntry{}}
	args := []interface{}{id, accountID, eventID, "%" + o.Search + "%", o.StageKey, o.NotesOnly}
	where := `e.logbook_id=$1 AND lb.account_id=$2 AND lb.event_id=$3 AND ((` + logbookNameSQL + `) ILIKE $4 OR (` + logbookPhoneSQL + `) ILIKE $4 OR e.notes ILIKE $4) AND ($5::text='' OR e.capture_stage_key=$5) AND (NOT $6::bool OR e.notes<>'')`
	from := logbookEntrySelect[strings.Index(logbookEntrySelect, " FROM "):]
	if err = r.db.QueryRow(ctx, `SELECT COUNT(*)`+from+` WHERE `+where, args...).Scan(&out.Total); err != nil {
		return nil, err
	}
	if cursor.ID != uuid.Nil {
		args = append(args, cursor.Position, cursor.Key, cursor.ID)
		where += ` AND (COALESCE(e.stage_position,2147483647),e.capture_stage_key,e.id)>($7::int,$8::text,$9::uuid)`
	}
	args = append(args, logbookLimit(o.Limit)+1)
	rows, err := r.db.Query(ctx, logbookEntrySelect+` WHERE `+where+fmt.Sprintf(` ORDER BY COALESCE(e.stage_position,2147483647),e.capture_stage_key,e.id LIMIT $%d`, len(args)), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		entry, err := scanLogbookEntry(rows)
		if err != nil {
			return nil, err
		}
		out.Items = append(out.Items, entry)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	if len(out.Items) > logbookLimit(o.Limit) {
		out.Items = out.Items[:logbookLimit(o.Limit)]
		last := out.Items[len(out.Items)-1]
		position := 2147483647
		if last.StagePosition != nil {
			position = *last.StagePosition
		}
		out.NextCursor = encodeLogbookCursor(logbookCursor{Position: position, Key: last.CaptureStageKey, ID: last.ID})
	}
	return out, nil
}

// StreamEntries holds one repeatable-read transaction for a consistent export,
// while reading bounded pages through a server-side cursor rather than loading all rows.
func (r *LogbookRepository) StreamEntries(ctx context.Context, accountID, eventID, id uuid.UUID, expected int64, visit func(*domain.EventLogbookEntry) error) error {
	tx, err := r.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var version int64
	if err = tx.QueryRow(ctx, `SELECT version FROM event_logbooks WHERE id=$1 AND account_id=$2 AND event_id=$3`, id, accountID, eventID).Scan(&version); err != nil {
		return err
	}
	if expected > 0 && expected != version {
		return ErrLogbookVersion
	}
	rows, err := tx.Query(ctx, logbookEntrySelect+` WHERE e.logbook_id=$1 AND lb.account_id=$2 AND lb.event_id=$3 ORDER BY COALESCE(e.stage_position,2147483647),e.capture_stage_key,e.id`, id, accountID, eventID)
	if err != nil {
		return err
	}
	for rows.Next() {
		entry, err := scanLogbookEntry(rows)
		if err != nil {
			rows.Close()
			return err
		}
		if err = visit(entry); err != nil {
			rows.Close()
			return err
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (r *LogbookRepository) PreviewPage(ctx context.Context, accountID, eventID, id uuid.UUID, o LogbookPageOptions) (*LogbookEntriesPage, error) {
	lb, err := r.Summary(ctx, accountID, eventID, id)
	if err != nil {
		return nil, err
	}
	if lb.Status == domain.LogbookStatusCompleted {
		return nil, ErrLogbookCompleted
	}
	filter, err := savedSnapshotFilter(lb.SavedFilter)
	if err != nil {
		return nil, err
	}
	where, args, err := snapshotPredicate(eventID, filter)
	if err != nil {
		return nil, err
	}
	args = append(args, accountID)
	where += fmt.Sprintf(` AND scope.account_id=$%d`, len(args))
	out := &LogbookEntriesPage{Items: []*domain.EventLogbookEntry{}}
	if err = r.db.QueryRow(ctx, `SELECT COUNT(*)`+logbookParticipantFrom+` WHERE `+where, args...).Scan(&out.Total); err != nil {
		return nil, err
	}
	cursor, err := decodeLogbookCursor(o.Cursor)
	if err != nil {
		return nil, err
	}
	if cursor.ID != uuid.Nil {
		args = append(args, cursor.ID)
		where += fmt.Sprintf(` AND ep.id>$%d::uuid`, len(args))
	}
	args = append(args, logbookLimit(o.Limit)+1)
	rows, err := r.db.Query(ctx, `SELECT ep.id,ep.stage_id,COALESCE(eps.name,''),COALESCE(eps.color,''),eps.position,`+logbookNameSQL+`,`+logbookPhoneSQL+logbookParticipantFrom+` WHERE `+where+fmt.Sprintf(` ORDER BY ep.id LIMIT $%d`, len(args)), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		e := &domain.EventLogbookEntry{LogbookID: id}
		if err = rows.Scan(&e.ParticipantID, &e.StageID, &e.StageName, &e.StageColor, &e.StagePosition, &e.ParticipantName, &e.ParticipantPhone); err != nil {
			return nil, err
		}
		e.ID = e.ParticipantID
		e.CaptureStageKey = "unassigned"
		if e.StageID != nil {
			e.CaptureStageKey = e.StageID.String()
		}
		out.Items = append(out.Items, e)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	if len(out.Items) > logbookLimit(o.Limit) {
		out.Items = out.Items[:logbookLimit(o.Limit)]
		out.NextCursor = encodeLogbookCursor(logbookCursor{ID: out.Items[len(out.Items)-1].ParticipantID})
	}
	return out, nil
}
func (r *LogbookRepository) Summary(ctx context.Context, accountID, eventID, id uuid.UUID) (*domain.EventLogbook, error) {
	return scanLogbook(r.db.QueryRow(ctx, logbookSelect+` WHERE l.id=$1 AND l.account_id=$2 AND l.event_id=$3`, id, accountID, eventID))
}

func (r *LogbookRepository) AutoCreatePreview(ctx context.Context, account, event uuid.UUID, start, end time.Time) (map[string]interface{}, error) {
	if start.IsZero() || end.Before(start) || end.Sub(start) > 366*24*time.Hour {
		return nil, ErrLogbookInvalid
	}
	first := time.Date(start.Year(), start.Month(), start.Day(), 0, 0, 0, 0, time.UTC)
	last := time.Date(end.Year(), end.Month(), end.Day(), 0, 0, 0, 0, time.UTC)
	rows, err := r.db.Query(ctx, `SELECT date FROM event_logbooks WHERE account_id=$1 AND event_id=$2 AND date>=$3 AND date<=$4`, account, event, first, last)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	existing := map[string]bool{}
	for rows.Next() {
		var d time.Time
		if err = rows.Scan(&d); err != nil {
			return nil, err
		}
		existing[d.Format("2006-01-02")] = true
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	dates := []string{}
	for d := first; !d.After(last); d = d.AddDate(0, 0, 1) {
		if !existing[d.Format("2006-01-02")] {
			dates = append(dates, d.Format("2006-01-02"))
		}
	}
	return map[string]interface{}{"dates": dates, "existing": len(existing), "total": len(dates)}, nil
}
func (r *LogbookRepository) History(ctx context.Context, account, event, id uuid.UUID, before int) ([]map[string]interface{}, error) {
	rows, err := r.db.Query(ctx, `SELECT a.id,a.action,a.version,a.created_at,COALESCE(NULLIF(u.display_name,''),NULLIF(u.username,''),'Usuario no disponible') FROM event_logbook_actions a LEFT JOIN users u ON u.id=a.actor_id WHERE a.account_id=$1 AND a.event_id=$2 AND a.logbook_id=$3 AND ($4::bigint=0 OR a.version<$4::bigint) ORDER BY a.version DESC,a.id DESC LIMIT 50`, account, event, id, before)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]interface{}{}
	for rows.Next() {
		var action, author string
		var rowID uuid.UUID
		var version int64
		var at time.Time
		if err = rows.Scan(&rowID, &action, &version, &at, &author); err != nil {
			return nil, err
		}
		out = append(out, map[string]interface{}{"id": rowID, "action": action, "version": version, "created_at": at, "author": author})
	}
	return out, rows.Err()
}
