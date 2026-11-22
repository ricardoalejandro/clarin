package repository

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/programtransfer"
)

var ErrProgramTransferRecordScope = errors.New("program transfer record no longer matches its target scope")

// WriteProgramTransferRecord performs one operation in the caller's import
// transaction. Record IDs and references are resolved into the receiving
// account before entry, and the statements recheck that scope at write time.
func WriteProgramTransferRecord(ctx context.Context, tx pgx.Tx, accountID, programID, actorID uuid.UUID, record programtransfer.Record, create bool) error {
	id, err := uuid.Parse(record.ID)
	if err != nil || id == uuid.Nil || accountID == uuid.Nil || programID == uuid.Nil {
		return ErrProgramTransferRecordScope
	}
	if record.Kind == "contact" {
		return writeProgramTransferContact(ctx, tx, accountID, id, record.Fields, create)
	}
	if record.Kind == "program" && id != programID {
		return ErrProgramTransferRecordScope
	}
	statements, ok := programTransferWriteSQL[record.Kind]
	if !ok {
		return ErrProgramTransferRecordScope
	}
	sql := statements.update
	if create {
		sql = statements.create
	}
	body, err := json.Marshal(record.Fields)
	if err != nil {
		return err
	}
	result, err := tx.Exec(ctx, programTransferWriteInput+sql, accountID, programID, id, actorID, body)
	if err != nil {
		return fmt.Errorf("write program transfer %s: %w", record.Kind, err)
	}
	if result.RowsAffected() != 1 {
		return fmt.Errorf("write program transfer %s: %w", record.Kind, ErrProgramTransferRecordScope)
	}
	return nil
}

type programTransferWriteStatement struct {
	create string
	update string
}

const programTransferWriteInput = `
	WITH r AS (
		SELECT $1::uuid account_id, $2::uuid program_id, $3::uuid id, $4::uuid actor_id, $5::jsonb f
	)
`

var programTransferWriteSQL = map[string]programTransferWriteStatement{
	"program": {
		create: `
			INSERT INTO programs (id,account_id,type,name,description,status,archived_from_status,color,created_by,
			                     schedule_start_date,schedule_end_date,schedule_days,schedule_start_time,schedule_end_time,health_view_columns)
			SELECT r.id,r.account_id,'course',x.name,x.description,x.status,x.archived_from_status,x.color,r.actor_id,
			       x.schedule_start_date,x.schedule_end_date,COALESCE(x.schedule_days,'{}'::int[]),x.schedule_start_time,x.schedule_end_time,
			       COALESCE(x.health_view_columns,ARRAY['health','attendance','signals']::text[])
			FROM r, LATERAL jsonb_populate_record(NULL::programs,r.f) x
			WHERE x.status IN ('active','completed','archived') AND NULLIF(BTRIM(x.name),'') IS NOT NULL
		`,
		update: `
			UPDATE programs p SET name=x.name,description=x.description,status=x.status,archived_from_status=x.archived_from_status,color=x.color,
			       schedule_start_date=x.schedule_start_date,schedule_end_date=x.schedule_end_date,schedule_days=COALESCE(x.schedule_days,'{}'::int[]),
			       schedule_start_time=x.schedule_start_time,schedule_end_time=x.schedule_end_time,
			       health_view_columns=COALESCE(x.health_view_columns,ARRAY['health','attendance','signals']::text[]),updated_at=NOW()
			FROM r, LATERAL jsonb_populate_record(NULL::programs,r.f) x
			WHERE p.account_id=r.account_id AND p.id=r.program_id AND p.type='course'
			  AND x.status IN ('active','completed','archived') AND NULLIF(BTRIM(x.name),'') IS NOT NULL
		`,
	},
	"goal": {
		create: `
			INSERT INTO program_goals (id,account_id,program_id,attendance_goal_percent,transfer_goal_percent)
			SELECT r.id,r.account_id,r.program_id,x.attendance_goal_percent,x.transfer_goal_percent
			FROM r JOIN programs p ON p.id=r.program_id AND p.account_id=r.account_id,
			     LATERAL jsonb_populate_record(NULL::program_goals,r.f) x
			WHERE x.attendance_goal_percent BETWEEN 0 AND 100 AND x.transfer_goal_percent BETWEEN 0 AND 100
		`,
		update: `
			UPDATE program_goals g SET attendance_goal_percent=x.attendance_goal_percent,transfer_goal_percent=x.transfer_goal_percent,updated_at=NOW()
			FROM r, LATERAL jsonb_populate_record(NULL::program_goals,r.f) x
			WHERE g.account_id=r.account_id AND g.program_id=r.program_id AND g.id=r.id
			  AND x.attendance_goal_percent BETWEEN 0 AND 100 AND x.transfer_goal_percent BETWEEN 0 AND 100
		`,
	},
	"course": {
		create: `
			INSERT INTO courses (id,account_id,name,description,status)
			SELECT r.id,r.account_id,x.name,x.description,x.status
			FROM r JOIN programs p ON p.id=r.program_id AND p.account_id=r.account_id,
			     LATERAL jsonb_populate_record(NULL::courses,r.f) x
			WHERE NULLIF(BTRIM(x.name),'') IS NOT NULL
		`,
		update: `
			UPDATE courses c SET name=x.name,description=x.description,status=x.status,updated_at=NOW()
			FROM r, LATERAL jsonb_populate_record(NULL::courses,r.f) x
			WHERE c.account_id=r.account_id AND c.id=r.id AND NULLIF(BTRIM(x.name),'') IS NOT NULL
		` + programTransferBoundCourse + programTransferPrivateCourse,
	},
	"course_topic": {
		create: `
			INSERT INTO course_topics (id,account_id,course_id,title,description,status,position)
			SELECT r.id,r.account_id,c.id,x.title,x.description,x.status,x.position
			FROM r
			CROSS JOIN LATERAL jsonb_populate_record(NULL::course_topics,r.f) x
			JOIN courses c ON c.account_id=r.account_id AND c.id=x.course_id
			WHERE NULLIF(BTRIM(x.title),'') IS NOT NULL
		` + programTransferPrivateCourse,
		update: `
			UPDATE course_topics ct SET title=x.title,description=x.description,status=x.status,position=x.position,updated_at=NOW()
			FROM r
			CROSS JOIN LATERAL jsonb_populate_record(NULL::course_topics,r.f) x
			JOIN courses c ON c.account_id=r.account_id AND c.id=x.course_id
			WHERE ct.account_id=r.account_id AND ct.id=r.id AND ct.course_id=c.id AND NULLIF(BTRIM(x.title),'') IS NOT NULL
		` + programTransferBoundCourse + programTransferPrivateCourse,
	},
	"program_course": {
		create: `
			INSERT INTO program_courses (account_id,program_id,course_id,position)
			SELECT r.account_id,r.program_id,x.course_id,x.position
			FROM r, LATERAL jsonb_populate_record(NULL::program_courses,r.f) x
		`,
		update: `
			UPDATE program_courses pc SET position=x.position
			FROM r, LATERAL jsonb_populate_record(NULL::program_courses,r.f) x
			WHERE pc.account_id=r.account_id AND pc.program_id=r.program_id AND pc.course_id=x.course_id
		`,
	},
	"instructor": {
		create: `
			INSERT INTO program_instructors (account_id,program_id,contact_id,position)
			SELECT r.account_id,r.program_id,c.id,x.position
			FROM r
			CROSS JOIN LATERAL jsonb_populate_record(NULL::program_instructors,r.f) x
			JOIN contacts c ON c.account_id=r.account_id AND c.id=x.contact_id AND c.is_group=FALSE
		`,
		update: `
			UPDATE program_instructors pi SET position=x.position
			FROM r, LATERAL jsonb_populate_record(NULL::program_instructors,r.f) x
			WHERE pi.account_id=r.account_id AND pi.program_id=r.program_id AND pi.contact_id=x.contact_id
		`,
	},
	"participant": {
		create: `
			INSERT INTO program_participants (id,program_id,contact_id,status,enrolled_at,dropped_at,drop_reason,drop_notes,completed_at,transferred_to_level,transferred_at)
			SELECT r.id,r.program_id,c.id,x.status,x.enrolled_at,x.dropped_at,COALESCE(x.drop_reason,''),COALESCE(x.drop_notes,''),
			       x.completed_at,COALESCE(x.transferred_to_level,''),x.transferred_at
			FROM r
			CROSS JOIN LATERAL jsonb_populate_record(NULL::program_participants,r.f) x
			JOIN contacts c ON c.account_id=r.account_id AND c.id=x.contact_id AND c.is_group=FALSE
			JOIN programs p ON p.id=r.program_id AND p.account_id=r.account_id
			WHERE TRUE
		` + programTransferParticipantDates,
		update: `
			UPDATE program_participants pp SET status=x.status,enrolled_at=x.enrolled_at,dropped_at=x.dropped_at,
			       drop_reason=COALESCE(x.drop_reason,''),drop_notes=COALESCE(x.drop_notes,''),completed_at=x.completed_at,
			       transferred_to_level=COALESCE(x.transferred_to_level,''),transferred_at=x.transferred_at
			FROM r
			CROSS JOIN LATERAL jsonb_populate_record(NULL::program_participants,r.f) x
			JOIN contacts c ON c.account_id=r.account_id AND c.id=x.contact_id AND c.is_group=FALSE
			JOIN programs p ON p.id=r.program_id AND p.account_id=r.account_id
			WHERE pp.program_id=r.program_id AND pp.id=r.id AND pp.contact_id=c.id
		` + programTransferParticipantDates,
	},
	"session": {
		create: `
			INSERT INTO program_sessions (id,account_id,program_id,date,title,topic,course_topic_id,session_type,start_time,end_time,location)
			SELECT r.id,r.account_id,r.program_id,x.date,x.title,x.topic,x.course_topic_id,x.session_type,x.start_time,x.end_time,x.location
			FROM r, LATERAL jsonb_populate_record(NULL::program_sessions,r.f) x
			WHERE x.session_type IN ('regular','recovery')
		`,
		update: `
			UPDATE program_sessions ps SET date=x.date,title=x.title,topic=x.topic,course_topic_id=x.course_topic_id,session_type=x.session_type,
			       start_time=x.start_time,end_time=x.end_time,location=x.location,updated_at=NOW()
			FROM r, LATERAL jsonb_populate_record(NULL::program_sessions,r.f) x
			WHERE ps.account_id=r.account_id AND ps.program_id=r.program_id AND ps.id=r.id AND x.session_type IN ('regular','recovery')
		`,
	},
	"session_topic": {
		create: `
			INSERT INTO program_session_topics (id,account_id,session_id,kind,course_id,course_topic_id,course_name_snapshot,topic_title_snapshot,position)
			SELECT r.id,r.account_id,ps.id,x.kind,x.course_id,x.course_topic_id,x.course_name_snapshot,x.topic_title_snapshot,x.position
			FROM r
			CROSS JOIN LATERAL jsonb_populate_record(NULL::program_session_topics,r.f) x
			JOIN program_sessions ps ON ps.account_id=r.account_id AND ps.program_id=r.program_id AND ps.id=x.session_id
		`,
		update: `
			UPDATE program_session_topics st SET kind=x.kind,course_id=x.course_id,course_topic_id=x.course_topic_id,
			       course_name_snapshot=x.course_name_snapshot,topic_title_snapshot=x.topic_title_snapshot,position=x.position
			FROM r
			CROSS JOIN LATERAL jsonb_populate_record(NULL::program_session_topics,r.f) x
			JOIN program_sessions ps ON ps.account_id=r.account_id AND ps.program_id=r.program_id AND ps.id=x.session_id
			WHERE st.account_id=r.account_id AND st.session_id=ps.id AND st.id=r.id
		`,
	},
	"attendance": {
		// Recorded attendance outside the enrollment window is retained
		// as history, never reinterpreted as an eligible or pending mark.
		create: `
			INSERT INTO program_attendance (id,session_id,participant_id,status,notes)
			SELECT r.id,ps.id,pp.id,x.status,x.notes
			FROM r
			CROSS JOIN LATERAL jsonb_populate_record(NULL::program_attendance,r.f) x
			JOIN program_sessions ps ON ps.account_id=r.account_id AND ps.program_id=r.program_id AND ps.id=x.session_id
			JOIN program_participants pp ON pp.program_id=r.program_id AND pp.id=x.participant_id
		`,
		update: `
			UPDATE program_attendance pa SET status=x.status,notes=x.notes,updated_at=NOW()
			FROM r
			CROSS JOIN LATERAL jsonb_populate_record(NULL::program_attendance,r.f) x
			JOIN program_sessions ps ON ps.account_id=r.account_id AND ps.program_id=r.program_id AND ps.id=x.session_id
			JOIN program_participants pp ON pp.program_id=r.program_id AND pp.id=x.participant_id
			WHERE pa.id=r.id AND pa.session_id=ps.id AND pa.participant_id=pp.id
		`,
	},
	"session_observation": {
		create: `
			INSERT INTO program_session_observations (id,account_id,session_id,notes,transfer_author_name,created_at,updated_at,is_pinned,pinned_at)
			SELECT r.id,r.account_id,ps.id,x.notes,NULLIF(r.f->>'author_name',''),x.created_at,x.created_at,x.is_pinned,
			       CASE WHEN x.is_pinned THEN x.pinned_at END
			FROM r
			CROSS JOIN LATERAL jsonb_populate_record(NULL::program_session_observations,r.f) x
			JOIN program_sessions ps ON ps.account_id=r.account_id AND ps.program_id=r.program_id AND ps.id=x.session_id
		`,
		update: `
			UPDATE program_session_observations o SET notes=x.notes,is_pinned=x.is_pinned,pinned_at=CASE WHEN x.is_pinned THEN x.pinned_at END,
			       pinned_by=CASE WHEN x.is_pinned AND o.is_pinned AND o.pinned_at IS NOT DISTINCT FROM x.pinned_at THEN o.pinned_by END,
			       updated_at=NOW(),updated_by=r.actor_id
			FROM r
			CROSS JOIN LATERAL jsonb_populate_record(NULL::program_session_observations,r.f) x
			JOIN program_sessions ps ON ps.account_id=r.account_id AND ps.program_id=r.program_id AND ps.id=x.session_id
			WHERE o.account_id=r.account_id AND o.session_id=ps.id AND o.id=r.id
		`,
	},
	"participant_note": {
		create: `
			INSERT INTO program_participant_notes (id,account_id,program_id,participant_id,contact_id,session_id,type,note,
			                                      outcome,follow_up_at,created_at,updated_at,transfer_author_name)
			SELECT r.id,r.account_id,r.program_id,pp.id,c.id,x.session_id,x.type,x.note,
			       x.outcome,x.follow_up_at,x.created_at,x.created_at,NULLIF(r.f->>'author_name','')
			FROM r
			CROSS JOIN LATERAL jsonb_populate_record(NULL::program_participant_notes,r.f) x
			JOIN programs p ON p.account_id=r.account_id AND p.id=r.program_id
			JOIN program_participants pp ON pp.program_id=r.program_id AND pp.id=x.participant_id
			JOIN contacts c ON c.account_id=r.account_id AND c.id=pp.contact_id
			LEFT JOIN program_sessions ps ON ps.account_id=r.account_id AND ps.program_id=r.program_id AND ps.id=x.session_id
			WHERE (x.session_id IS NULL OR ps.id IS NOT NULL)
		`,
		update: `
			UPDATE program_participant_notes pn SET type=x.type,note=x.note,outcome=x.outcome,follow_up_at=x.follow_up_at,updated_at=NOW()
			FROM r, LATERAL jsonb_populate_record(NULL::program_participant_notes,r.f) x
			WHERE pn.account_id=r.account_id AND pn.program_id=r.program_id AND pn.id=r.id
			  AND pn.participant_id=x.participant_id AND pn.session_id IS NOT DISTINCT FROM x.session_id
		`,
	},
	"interaction": {
		create: `
			INSERT INTO interactions (id,account_id,program_id,program_participant_id,contact_id,program_session_id,type,direction,
			                          outcome,notes,next_action,next_action_date,source_label,created_at,updated_at,transfer_author_name,is_pinned,pinned_at)
			SELECT r.id,r.account_id,r.program_id,pp.id,c.id,x.program_session_id,x.type,x.direction,x.outcome,x.notes,x.next_action,
			       x.next_action_date,COALESCE(x.source_label,''),x.created_at,x.created_at,NULLIF(r.f->>'author_name',''),x.is_pinned,
			       CASE WHEN x.is_pinned THEN x.pinned_at END
			FROM r
			CROSS JOIN LATERAL jsonb_populate_record(NULL::interactions,
				r.f || jsonb_build_object('program_session_id',r.f->'session_id','program_participant_id',r.f->'participant_id')) x
			JOIN programs p ON p.account_id=r.account_id AND p.id=r.program_id
			JOIN program_participants pp ON pp.program_id=r.program_id AND pp.id=x.program_participant_id
			JOIN contacts c ON c.account_id=r.account_id AND c.id=pp.contact_id
			LEFT JOIN program_sessions ps ON ps.account_id=r.account_id AND ps.program_id=r.program_id AND ps.id=x.program_session_id
			WHERE (x.program_session_id IS NULL OR ps.id IS NOT NULL)
			  AND (x.type<>'attendance' OR ps.id IS NOT NULL)
		`,
		update: `
			UPDATE interactions i SET direction=x.direction,outcome=x.outcome,notes=x.notes,next_action=x.next_action,next_action_date=x.next_action_date,
			       source_label=COALESCE(x.source_label,''),is_pinned=x.is_pinned,pinned_at=CASE WHEN x.is_pinned THEN x.pinned_at END,
			       pinned_by=CASE WHEN x.is_pinned AND i.is_pinned AND i.pinned_at IS NOT DISTINCT FROM x.pinned_at THEN i.pinned_by END,
			       updated_at=NOW(),updated_by=r.actor_id
			FROM r
			CROSS JOIN LATERAL jsonb_populate_record(NULL::interactions,
				r.f || jsonb_build_object('program_session_id',r.f->'session_id','program_participant_id',r.f->'participant_id')) x
			WHERE i.account_id=r.account_id AND i.program_id=r.program_id AND i.id=r.id AND i.type=x.type
			  AND i.event_id IS NULL AND i.participant_id IS NULL AND i.lead_id IS NULL
			  AND i.program_participant_id=x.program_participant_id AND i.program_session_id IS NOT DISTINCT FROM x.program_session_id
		`,
	},
}

const programTransferPrivateCourse = `
	AND NOT EXISTS (SELECT 1 FROM program_courses pc WHERE pc.account_id=r.account_id AND pc.course_id=c.id AND pc.program_id<>r.program_id)
	AND NOT EXISTS (
		SELECT 1 FROM program_sessions ps
		WHERE ps.account_id=r.account_id AND ps.program_id<>r.program_id
		  AND (EXISTS (SELECT 1 FROM course_topics ct WHERE ct.account_id=r.account_id AND ct.course_id=c.id AND ct.id=ps.course_topic_id)
		       OR EXISTS (SELECT 1 FROM program_session_topics st WHERE st.account_id=r.account_id AND st.course_id=c.id AND st.session_id=ps.id))
	)
`

const programTransferBoundCourse = `
	AND (
		EXISTS (SELECT 1 FROM program_courses pc WHERE pc.account_id=r.account_id AND pc.course_id=c.id AND pc.program_id=r.program_id)
		OR EXISTS (
			SELECT 1 FROM program_sessions ps
			WHERE ps.account_id=r.account_id AND ps.program_id=r.program_id
			  AND (EXISTS (SELECT 1 FROM course_topics ct WHERE ct.account_id=r.account_id AND ct.course_id=c.id AND ct.id=ps.course_topic_id)
			       OR EXISTS (SELECT 1 FROM program_session_topics st WHERE st.account_id=r.account_id AND st.course_id=c.id AND st.session_id=ps.id))
		)
	)
`

const programTransferParticipantDates = `
	AND x.status IN ('active','dropped','completed') AND x.enrolled_at IS NOT NULL
	AND (x.dropped_at IS NULL OR x.enrolled_at<=x.dropped_at)
	AND (x.completed_at IS NULL OR x.enrolled_at<=x.completed_at)
`

type transferContactPhone struct {
	Phone string `json:"phone"`
	Label string `json:"label"`
}

func writeProgramTransferContact(ctx context.Context, tx pgx.Tx, accountID, id uuid.UUID, fields map[string]any, create bool) error {
	body, err := json.Marshal(fields)
	if err != nil {
		return err
	}
	var identity struct {
		Name             *string                `json:"name"`
		Phone            *string                `json:"phone"`
		Email            *string                `json:"email"`
		AdditionalPhones []transferContactPhone `json:"additional_phones"`
	}
	if err := json.Unmarshal(body, &identity); err != nil {
		return ErrContactProfileCollectionInvalid
	}
	patch := ContactProfilePatch{}
	if identity.Name != nil && strings.TrimSpace(*identity.Name) != "" {
		patch.NameSet, patch.Name = true, identity.Name
	}
	if identity.Email != nil && strings.TrimSpace(*identity.Email) != "" {
		patch.EmailSet, patch.Email = true, identity.Email
	}
	phone := ""
	if identity.Phone != nil && strings.TrimSpace(*identity.Phone) != "" {
		phone, err = normalizeContactProfilePhone(*identity.Phone)
		if err != nil {
			return err
		}
		patch.PhoneSet, patch.Phone = true, &phone
	}
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1::text))`, accountID); err != nil {
		return err
	}
	if create {
		// A participation can belong to a Contact whose source identity is still
		// pending. Restore the relationship under a local-only identity without
		// fabricating a phone or copying a provider-specific identifier.
		jid := "manual_" + id.String() + "@clarin.contact"
		if phone != "" {
			jid = phone + "@s.whatsapp.net"
		}
		owner, err := findProgramTransferContactOwner(ctx, tx, accountID, jid, phone)
		if err != nil {
			return err
		}
		if owner != nil {
			return ErrContactIdentityConflict
		}
		if _, err := tx.Exec(ctx, `INSERT INTO contacts (id,account_id,jid,is_group,source) VALUES ($1,$2,$3,FALSE,'manual')`, id, accountID, jid); err != nil {
			return err
		}
	} else {
		var currentName, currentPhone, currentEmail *string
		err := tx.QueryRow(ctx, `
			SELECT COALESCE(NULLIF(custom_name,''),NULLIF(name,''),NULLIF(push_name,'')),phone,email
			FROM contacts WHERE account_id=$1 AND id=$2 AND is_group=FALSE FOR UPDATE
		`, accountID, id).Scan(&currentName, &currentPhone, &currentEmail)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrProgramTransferRecordScope
		}
		if err != nil {
			return err
		}
		// Existing personal fields are not overwritten by a Program import.
		// Well-formed extra numbers can augment the existing identity.
		if currentName != nil && strings.TrimSpace(*currentName) != "" {
			patch.NameSet = false
		}
		if currentPhone != nil && strings.TrimSpace(*currentPhone) != "" {
			patch.PhoneSet = false
			// Validate and compare new extra phones against the receiving
			// primary, not the unrelated primary of the imported record.
			if current, e := normalizeContactProfilePhone(*currentPhone); e == nil {
				phone = current
			}
		}
		if currentEmail != nil && strings.TrimSpace(*currentEmail) != "" {
			patch.EmailSet = false
		}
	}
	if patch.PhoneSet || len(identity.AdditionalPhones) != 0 {
		existing, err := loadProgramTransferExtraPhones(ctx, tx, accountID, id)
		if err != nil {
			return err
		}
		patch.ExtraPhones, patch.ExtraPhonesSet, err = mergeProgramTransferExtraPhones(existing, identity.AdditionalPhones, phone, patch.PhoneSet)
		if err != nil {
			return err
		}
	}
	if !patch.NameSet && !patch.EmailSet && !patch.PhoneSet && !patch.ExtraPhonesSet {
		return nil
	}
	_, err = (&ContactProfileRepository{}).UpdateTx(ctx, tx, accountID, id, patch)
	return err
}

func findProgramTransferContactOwner(ctx context.Context, tx pgx.Tx, accountID uuid.UUID, jid, phone string) (*uuid.UUID, error) {
	if phone != "" {
		return findContactAliasID(ctx, tx, accountID, jid, phone)
	}
	// The generic WhatsApp lookup may derive digits from a JID. The local
	// synthetic ID is not a phone, so test only the same-account JID alias.
	var owner uuid.UUID
	err := tx.QueryRow(ctx, `SELECT contact_id FROM contact_aliases
		WHERE account_id=$1 AND alias_type='jid' AND normalized_value=$2`, accountID, jid).Scan(&owner)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &owner, nil
}

func mergeProgramTransferExtraPhones(existing []ContactProfileExtraPhonePatch, incoming []transferContactPhone, primary string, promotePrimary bool) ([]ContactProfileExtraPhonePatch, bool, error) {
	seen := map[string]bool{primary: primary != ""}
	merged := make([]ContactProfileExtraPhonePatch, 0, len(existing)+len(incoming))
	changed := false
	for _, extra := range existing {
		if normalized, err := normalizeContactProfilePhone(extra.Phone); err == nil {
			if promotePrimary && normalized == primary {
				// The canonical profile update will remove the old secondary
				// row in the same transaction that promotes its number.
				changed = true
				continue
			}
			seen[normalized] = true
		}
		merged = append(merged, extra)
	}
	for _, extra := range incoming {
		normalized, err := normalizeContactProfilePhone(extra.Phone)
		if err != nil {
			return nil, false, err
		}
		if seen[normalized] {
			continue
		}
		seen[normalized] = true
		merged = append(merged, ContactProfileExtraPhonePatch{Phone: normalized, Label: extra.Label})
		changed = true
	}
	return merged, changed, nil
}

func loadProgramTransferExtraPhones(ctx context.Context, tx pgx.Tx, accountID, contactID uuid.UUID) ([]ContactProfileExtraPhonePatch, error) {
	rows, err := tx.Query(ctx, `
		SELECT cp.id,cp.phone,COALESCE(cp.label,'')
		FROM contact_phones cp JOIN contacts c ON c.id=cp.contact_id AND c.account_id=$1
		WHERE cp.contact_id=$2 ORDER BY cp.created_at,cp.id
	`, accountID, contactID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]ContactProfileExtraPhonePatch, 0)
	for rows.Next() {
		var phone ContactProfileExtraPhonePatch
		var id uuid.UUID
		if err := rows.Scan(&id, &phone.Phone, &phone.Label); err != nil {
			return nil, err
		}
		phone.ID = &id
		result = append(result, phone)
	}
	return result, rows.Err()
}
