package repository

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/programtransfer"
)

// ProgramTransferAssociationID gives a stable local identity to association rows
// whose primary key in PostgreSQL is the program and the referenced entity.
func ProgramTransferAssociationID(programID uuid.UUID, kind string, referenceID uuid.UUID) string {
	return uuid.NewSHA1(programID, []byte(kind+":"+referenceID.String())).String()
}

// ReadProgramTransfer returns a complete snapshot of one class program using
// the caller's transaction. It intentionally does not start a new transaction,
// so an export or import review can share a consistent database snapshot.
func ReadProgramTransfer(ctx context.Context, tx pgx.Tx, accountID, programID uuid.UUID) ([]programtransfer.Record, error) {
	rows, err := tx.Query(ctx, programTransferSnapshotSQL, accountID, programID, programtransfer.MaxRecords+1)
	if err != nil {
		return nil, err
	}
	records, err := collectProgramTransferRecords(rows, programID)
	if err != nil {
		return nil, err
	}
	if len(records) == 0 {
		return nil, pgx.ErrNoRows
	}
	return records, nil
}

// ReadProgramTransferContacts only returns same-account matching candidates or
// previously mapped/explicitly selected IDs. match_phone_aliases is private
// matcher evidence, not a portable field, and must be stripped by the caller.
func ReadProgramTransferContacts(ctx context.Context, tx pgx.Tx, accountID uuid.UUID, phones, emails []string, contactIDs []uuid.UUID) ([]programtransfer.Record, error) {
	if len(phones) == 0 && len(emails) == 0 && len(contactIDs) == 0 {
		return []programtransfer.Record{}, nil
	}
	rows, err := tx.Query(ctx, programTransferContactCandidatesSQL, accountID, phones, emails, contactIDs, programtransfer.MaxRecords+1)
	if err != nil {
		return nil, err
	}
	return collectProgramTransferRecords(rows, uuid.Nil)
}

// ReadProgramTransferSharedCourses returns only courses in the target snapshot
// that another Program also uses. Such catalog rows must not be changed by an
// import of the target alone. Historical class-topic references count as usage.
func ReadProgramTransferSharedCourses(ctx context.Context, tx pgx.Tx, accountID, programID uuid.UUID) ([]string, error) {
	rows, err := tx.Query(ctx, programTransferSharedCoursesSQL, accountID, programID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := make([]string, 0)
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id.String())
	}
	return ids, rows.Err()
}

func collectProgramTransferRecords(rows pgx.Rows, programID uuid.UUID) ([]programtransfer.Record, error) {
	defer rows.Close()
	records := make([]programtransfer.Record, 0)
	fieldBytes := 0
	for rows.Next() {
		if len(records) == programtransfer.MaxRecords {
			return nil, programtransfer.ErrTooLarge
		}
		var id uuid.UUID
		var kind string
		var fields []byte
		if err := rows.Scan(&kind, &id, &fields); err != nil {
			return nil, err
		}
		fieldBytes += len(fields)
		if fieldBytes > programtransfer.MaxFileBytes {
			return nil, programtransfer.ErrTooLarge
		}
		record, err := decodeProgramTransferRecord(kind, id, fields, programID)
		if err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	return records, rows.Err()
}

func decodeProgramTransferRecord(kind string, id uuid.UUID, rawFields []byte, programID uuid.UUID) (programtransfer.Record, error) {
	record := programtransfer.Record{Kind: kind, ID: id.String()}
	if kind == "program_course" || kind == "instructor" {
		record.ID = ProgramTransferAssociationID(programID, kind, id)
	}
	if err := json.Unmarshal(rawFields, &record.Fields); err != nil {
		return programtransfer.Record{}, fmt.Errorf("decode program transfer %s fields: %w", kind, err)
	}
	if kind == "contact" {
		canonicalizeProgramTransferContact(record.Fields)
	}
	// A database session's timezone setting must not generate different values
	// for the same instant. Date-only calendar fields intentionally stay strings.
	for _, field := range []string{"schedule_start_date", "schedule_end_date", "transferred_at", "created_at", "pinned_at", "follow_up_at", "next_action_date"} {
		if value, ok := record.Fields[field].(string); ok {
			instant, err := time.Parse(time.RFC3339Nano, value)
			if err != nil {
				return programtransfer.Record{}, fmt.Errorf("invalid program transfer timestamp %s.%s: %w", kind, field, err)
			}
			record.Fields[field] = instant.UTC().Format(time.RFC3339Nano)
		}
	}
	return record, nil
}

// Read phones in the same representation used by the Contact writer. A legacy
// spacing/prefix change made by the canonical writer must not look like a new
// edit on the next leg of a transfer.
func canonicalizeProgramTransferContact(fields map[string]any) {
	phone, _ := fields["phone"].(string)
	if normalized, err := normalizeContactProfilePhone(phone); err == nil {
		phone = normalized
		fields["phone"] = normalized
	}
	extra, _ := fields["additional_phones"].([]any)
	for _, raw := range extra {
		item, _ := raw.(map[string]any)
		value, _ := item["phone"].(string)
		if normalized, err := normalizeContactProfilePhone(value); err == nil {
			item["phone"] = normalized
		}
		label := strings.TrimSpace(programtransfer.String(item, "label"))
		if label == "" {
			label = "mobile"
		}
		if item != nil {
			item["label"] = label
		}
	}
	sort.SliceStable(extra, func(i, j int) bool {
		a, _ := extra[i].(map[string]any)
		b, _ := extra[j].(map[string]any)
		if ap, bp := programtransfer.String(a, "phone"), programtransfer.String(b, "phone"); ap != bp {
			return ap < bp
		}
		return programtransfer.String(a, "label") < programtransfer.String(b, "label")
	})
	seen := map[string]bool{phone: phone != ""}
	canonical := make([]any, 0, len(extra))
	for _, raw := range extra {
		item, _ := raw.(map[string]any)
		value := programtransfer.String(item, "phone")
		if seen[value] {
			continue
		}
		seen[value] = true
		canonical = append(canonical, raw)
	}
	fields["additional_phones"] = canonical
}

// This projection is shared by the exported program and current-account
// candidates. Provider identifiers, user IDs, aliases, and unrelated visibility
// settings are deliberately absent from the portable Contact data.
const programTransferContactFieldsSQL = `jsonb_build_object(
	'name', COALESCE(NULLIF(BTRIM(c.custom_name), ''), NULLIF(BTRIM(c.name), ''), NULLIF(BTRIM(c.push_name), '')),
	'phone', NULLIF(BTRIM(c.phone), ''), 'email', NULLIF(BTRIM(c.email), ''),
	'additional_phones', COALESCE((SELECT jsonb_agg(jsonb_build_object('phone', cp.phone, 'label', COALESCE(cp.label, 'mobile')) ORDER BY cp.phone, cp.label, cp.id)
		FROM contact_phones cp WHERE cp.contact_id=c.id AND NULLIF(BTRIM(cp.phone), '') IS NOT NULL), '[]'::jsonb))`

// Program authors may write under a secondary account membership. Restrict
// author lookup to the selected account even though the note already has a
// foreign key to a user. Only the display name goes into the portable file.
const programTransferAuthorAccountSQL = `(u.account_id=$1 OR EXISTS (
	SELECT 1 FROM user_accounts ua WHERE ua.user_id=u.id AND ua.account_id=$1))`

const programTransferSnapshotSQL = `
WITH selected_program AS MATERIALIZED (
	SELECT p.id, p.account_id, p.name, p.description, p.status, p.archived_from_status, p.color,
		p.schedule_start_date, p.schedule_end_date, p.schedule_days, p.schedule_start_time,
		p.schedule_end_time, p.health_view_columns
	FROM programs p WHERE p.account_id=$1 AND p.id=$2 AND p.type='course'
), sessions AS MATERIALIZED (
	SELECT s.id, s.account_id, s.date, s.title, s.topic, s.course_topic_id, s.session_type, s.start_time, s.end_time, s.location
	FROM program_sessions s JOIN selected_program p ON p.account_id=s.account_id AND p.id=s.program_id
), participants AS MATERIALIZED (
	SELECT pp.id, pp.contact_id, pp.status, pp.enrolled_at, pp.dropped_at, pp.drop_reason,
		pp.drop_notes, pp.completed_at, pp.transferred_to_level, pp.transferred_at
	FROM program_participants pp JOIN selected_program p ON p.id=pp.program_id
	JOIN contacts c ON c.account_id=p.account_id AND c.id=pp.contact_id AND NOT COALESCE(c.is_group, FALSE)
), instructor_assignments AS MATERIALIZED (
	SELECT pi.contact_id, pi.position FROM program_instructors pi
	JOIN selected_program p ON p.account_id=pi.account_id AND p.id=pi.program_id
	JOIN contacts c ON c.account_id=pi.account_id AND c.id=pi.contact_id AND NOT COALESCE(c.is_group, FALSE)
), contact_ids AS (
	SELECT contact_id FROM participants UNION SELECT contact_id FROM instructor_assignments
), course_assignments AS MATERIALIZED (
	SELECT pc.course_id, pc.position FROM program_courses pc
	JOIN selected_program p ON p.account_id=pc.account_id AND p.id=pc.program_id
	JOIN courses c ON c.account_id=pc.account_id AND c.id=pc.course_id
), session_topics AS MATERIALIZED (
	SELECT st.id, st.session_id, st.kind, st.course_id, st.course_topic_id,
		st.course_name_snapshot, st.topic_title_snapshot, st.position
	FROM program_session_topics st JOIN sessions s ON s.account_id=st.account_id AND s.id=st.session_id
), referenced_courses AS (
	SELECT course_id FROM course_assignments
	UNION SELECT course_id FROM session_topics WHERE course_id IS NOT NULL
	UNION SELECT ct.course_id FROM sessions s JOIN course_topics ct ON ct.account_id=s.account_id AND ct.id=s.course_topic_id
), referenced_topics AS (
	SELECT ct.id FROM course_assignments pc JOIN course_topics ct ON ct.account_id=$1 AND ct.course_id=pc.course_id
	UNION SELECT course_topic_id FROM session_topics WHERE course_topic_id IS NOT NULL
	UNION SELECT course_topic_id FROM sessions WHERE course_topic_id IS NOT NULL
), records AS (
	SELECT 'program'::text AS kind, p.id, jsonb_build_object(
		'name', p.name, 'description', p.description, 'status', COALESCE(p.status, 'active'),
		'archived_from_status', p.archived_from_status, 'color', COALESCE(p.color, '#10b981'),
		'schedule_start_date', p.schedule_start_date, 'schedule_end_date', p.schedule_end_date,
		'schedule_days', COALESCE(p.schedule_days, '{}'::int[]), 'schedule_start_time', p.schedule_start_time,
		'schedule_end_time', p.schedule_end_time, 'health_view_columns', p.health_view_columns) AS fields
	FROM selected_program p
	UNION ALL
	SELECT 'goal', g.id, jsonb_build_object('attendance_goal_percent',g.attendance_goal_percent,'transfer_goal_percent',g.transfer_goal_percent)
	FROM program_goals g JOIN selected_program p ON p.account_id=g.account_id AND p.id=g.program_id
	UNION ALL
	SELECT 'contact', c.id, ` + programTransferContactFieldsSQL + `
	FROM contact_ids x JOIN contacts c ON c.id=x.contact_id AND c.account_id=$1
	UNION ALL
	SELECT 'course', c.id, jsonb_build_object('name',c.name,'description',c.description,'status',c.status)
	FROM referenced_courses x JOIN courses c ON c.account_id=$1 AND c.id=x.course_id
	UNION ALL
	SELECT 'course_topic', ct.id, jsonb_build_object('course_id',ct.course_id,'title',ct.title,'description',ct.description,
		'status',ct.status,'position',ct.position)
	FROM referenced_topics x JOIN course_topics ct ON ct.account_id=$1 AND ct.id=x.id
	UNION ALL
	SELECT 'program_course', pc.course_id, jsonb_build_object('course_id',pc.course_id,'position',pc.position)
	FROM course_assignments pc
	UNION ALL
	SELECT 'instructor', pi.contact_id, jsonb_build_object('contact_id',pi.contact_id,'position',pi.position)
	FROM instructor_assignments pi
	UNION ALL
	SELECT 'participant', pp.id, jsonb_build_object('contact_id',pp.contact_id,'status',pp.status,'enrolled_at',pp.enrolled_at,
		'dropped_at',pp.dropped_at,'drop_reason',pp.drop_reason,'drop_notes',pp.drop_notes,'completed_at',pp.completed_at,
		'transferred_to_level',pp.transferred_to_level,'transferred_at',pp.transferred_at)
	FROM participants pp
	UNION ALL
	SELECT 'session', s.id, jsonb_build_object('date',s.date,'title',s.title,'topic',s.topic,'course_topic_id',s.course_topic_id,
		'session_type',s.session_type,'start_time',s.start_time,'end_time',s.end_time,'location',s.location)
	FROM sessions s
	UNION ALL
	SELECT 'session_topic', st.id, jsonb_build_object('session_id',st.session_id,'kind',st.kind,'course_id',st.course_id,
		'course_topic_id',st.course_topic_id,'course_name_snapshot',st.course_name_snapshot,
		'topic_title_snapshot',st.topic_title_snapshot,'position',st.position)
	FROM session_topics st
	UNION ALL
	SELECT 'attendance', a.id, jsonb_build_object('session_id',a.session_id,'participant_id',a.participant_id,'status',a.status,'notes',a.notes)
	FROM program_attendance a JOIN sessions s ON s.id=a.session_id JOIN participants pp ON pp.id=a.participant_id
	UNION ALL
	SELECT 'session_observation', o.id, jsonb_build_object('session_id',o.session_id,'notes',o.notes,'created_at',o.created_at,
		'author_name',COALESCE(o.transfer_author_name,NULLIF(BTRIM(u.display_name),'')),'is_pinned',o.is_pinned,'pinned_at',o.pinned_at)
	FROM program_session_observations o JOIN sessions s ON s.account_id=o.account_id AND s.id=o.session_id
	LEFT JOIN users u ON u.id=o.created_by AND ` + programTransferAuthorAccountSQL + `
	UNION ALL
	SELECT 'participant_note', pn.id, jsonb_build_object('participant_id',pn.participant_id,'session_id',s.id,
		'type',pn.type,'note',pn.note,'outcome',pn.outcome,'follow_up_at',pn.follow_up_at,'created_at',pn.created_at,
		'author_name',COALESCE(pn.transfer_author_name,NULLIF(BTRIM(u.display_name),'')))
	FROM program_participant_notes pn JOIN selected_program p ON p.account_id=pn.account_id AND p.id=pn.program_id
	JOIN participants pp ON pp.id=pn.participant_id AND pp.contact_id=pn.contact_id
	LEFT JOIN sessions s ON s.id=pn.session_id AND s.account_id=pn.account_id
	LEFT JOIN users u ON u.id=pn.created_by AND ` + programTransferAuthorAccountSQL + `
	WHERE pn.session_id IS NULL OR s.id IS NOT NULL
	UNION ALL
	SELECT 'interaction', i.id, jsonb_build_object('participant_id',i.program_participant_id,'session_id',s.id,
		'type',i.type,'direction',i.direction,'outcome',i.outcome,'notes',i.notes,'next_action',i.next_action,
		'next_action_date',i.next_action_date,'source_label',i.source_label,'created_at',i.created_at,
		'author_name',COALESCE(i.transfer_author_name,NULLIF(BTRIM(u.display_name),'')),'is_pinned',i.is_pinned,'pinned_at',i.pinned_at)
	FROM interactions i JOIN selected_program p ON p.account_id=i.account_id AND p.id=i.program_id
	JOIN participants pp ON pp.id=i.program_participant_id AND pp.contact_id=i.contact_id
	LEFT JOIN sessions s ON s.id=i.program_session_id AND s.account_id=i.account_id
	LEFT JOIN users u ON u.id=i.created_by AND ` + programTransferAuthorAccountSQL + `
	WHERE (i.program_session_id IS NULL OR s.id IS NOT NULL) AND i.lead_id IS NULL AND i.event_id IS NULL AND i.participant_id IS NULL
)
SELECT kind,id,fields FROM records ORDER BY kind,id LIMIT $3::int`

// These normalizations intentionally match other same-account Contact identity
// paths (including the historic 9-digit Peruvian mobile form). Binds only carry
// requested keys; there is no unscoped Contact catalog query or export.
const programTransferContactCandidatesSQL = `
SELECT 'contact',c.id,` + programTransferContactFieldsSQL + ` || jsonb_build_object(
	'match_phone_aliases', COALESCE((SELECT jsonb_agg(DISTINCT ca.normalized_value ORDER BY ca.normalized_value)
		FROM contact_aliases ca WHERE ca.account_id=c.account_id AND ca.contact_id=c.id AND ca.alias_type='phone'
			AND ca.normalized_value=ANY($2::text[])), '[]'::jsonb))
FROM contacts c
WHERE c.account_id=$1 AND NOT COALESCE(c.is_group,FALSE)
	AND (c.id=ANY($4::uuid[])
		OR LOWER(BTRIM(c.email))=ANY($3::text[])
		OR (CASE WHEN REGEXP_REPLACE(COALESCE(c.phone,''),'[^0-9]','','g') ~ '^9[0-9]{8}$'
			THEN '51'||REGEXP_REPLACE(COALESCE(c.phone,''),'[^0-9]','','g')
			ELSE REGEXP_REPLACE(COALESCE(c.phone,''),'[^0-9]','','g') END)=ANY($2::text[])
		OR EXISTS (SELECT 1 FROM contact_phones cp WHERE cp.contact_id=c.id
			AND (CASE WHEN REGEXP_REPLACE(cp.phone,'[^0-9]','','g') ~ '^9[0-9]{8}$'
				THEN '51'||REGEXP_REPLACE(cp.phone,'[^0-9]','','g')
				ELSE REGEXP_REPLACE(cp.phone,'[^0-9]','','g') END)=ANY($2::text[]))
		OR EXISTS (SELECT 1 FROM contact_aliases ca WHERE ca.account_id=c.account_id AND ca.contact_id=c.id
			AND ca.alias_type='phone' AND ca.normalized_value=ANY($2::text[])))
ORDER BY c.id LIMIT $5::int`

const programTransferSharedCoursesSQL = `
WITH selected_program AS (
	SELECT p.id,p.account_id FROM programs p WHERE p.account_id=$1 AND p.id=$2 AND p.type='course'
), target_sessions AS (
	SELECT s.id,s.account_id,s.course_topic_id FROM program_sessions s
	JOIN selected_program p ON p.account_id=s.account_id AND p.id=s.program_id
), target_courses AS (
	SELECT pc.course_id FROM program_courses pc JOIN selected_program p ON p.account_id=pc.account_id AND p.id=pc.program_id
	UNION SELECT st.course_id FROM program_session_topics st JOIN target_sessions s ON s.account_id=st.account_id AND s.id=st.session_id
		WHERE st.course_id IS NOT NULL
	UNION SELECT ct.course_id FROM course_topics ct JOIN target_sessions s ON s.account_id=ct.account_id AND s.course_topic_id=ct.id
)
SELECT c.id FROM target_courses x JOIN courses c ON c.account_id=$1 AND c.id=x.course_id
WHERE EXISTS (SELECT 1 FROM program_courses pc WHERE pc.account_id=c.account_id AND pc.course_id=c.id AND pc.program_id<>$2)
	OR EXISTS (
		SELECT 1 FROM program_sessions ps
		WHERE ps.account_id=c.account_id AND ps.program_id<>$2
			AND (EXISTS (SELECT 1 FROM course_topics ct WHERE ct.account_id=c.account_id AND ct.course_id=c.id AND ct.id=ps.course_topic_id)
				OR EXISTS (SELECT 1 FROM program_session_topics st WHERE st.account_id=c.account_id AND st.course_id=c.id AND st.session_id=ps.id))
	)
ORDER BY c.id`
