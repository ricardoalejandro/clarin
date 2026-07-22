package repository

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

var ErrProgramParticipantNotFound = errors.New("program participant not found")

// ProgramAttendanceHistoryCursor is the decoded keyset used by the repository.
// The service binds its opaque representation to both Program and participant.
type ProgramAttendanceHistoryCursor struct {
	Date      time.Time
	StartTime string
	CreatedAt time.Time
	SessionID uuid.UUID
}

// ProgramAttendanceHistoryCounts contains the unpaginated counters used to
// build rates and health without making an unmarked session an absence.
type ProgramAttendanceHistoryCounts struct {
	GoalPercent      int
	EligibleSessions int
	MarkedSessions   int
	Present          int
	Absent           int
	Late             int
}

const getParticipantAttendanceHistorySummaryQuery = `
	WITH participant_context AS (
		SELECT p.account_id, p.id AS program_id, pp.id AS participant_id,
		       pp.enrolled_at::date AS enrolled_on,
		       CASE
		         WHEN pp.dropped_at IS NULL THEN pp.completed_at
		         WHEN pp.completed_at IS NULL THEN pp.dropped_at
		         ELSE LEAST(pp.dropped_at, pp.completed_at)
		       END::date AS ended_on
		FROM programs p
		JOIN program_participants pp ON pp.program_id = p.id
		JOIN contacts c ON c.account_id = p.account_id AND c.id = pp.contact_id
		WHERE p.account_id = $1 AND p.id = $2 AND pp.id = $3
	), eligible_sessions AS (
		SELECT ps.id AS session_id,
		       CASE WHEN pa.status IN ('present', 'absent', 'late') THEN pa.status END AS status
		FROM participant_context pc
		JOIN program_sessions ps
		  ON ps.account_id = pc.account_id AND ps.program_id = pc.program_id
		LEFT JOIN program_attendance pa
		  ON pa.session_id = ps.id AND pa.participant_id = pc.participant_id
		WHERE ps.date <= CURRENT_DATE
		  AND ps.date >= pc.enrolled_on
		  AND (pc.ended_on IS NULL OR ps.date <= pc.ended_on)
	)
	SELECT COALESCE(
	         (SELECT pg.attendance_goal_percent
	          FROM program_goals pg
	          WHERE pg.account_id = pc.account_id AND pg.program_id = pc.program_id
	          LIMIT 1),
	         (SELECT gg.attendance_goal_percent
	          FROM program_goals gg
	          WHERE gg.account_id = pc.account_id AND gg.program_id IS NULL
	          LIMIT 1),
	         80
	       )::int AS goal_percent,
	       COUNT(es.session_id)::int AS eligible_sessions,
	       COUNT(es.status)::int AS marked_sessions,
	       COUNT(*) FILTER (WHERE es.status = 'present')::int AS present,
	       COUNT(*) FILTER (WHERE es.status = 'absent')::int AS absent,
	       COUNT(*) FILTER (WHERE es.status = 'late')::int AS late
	FROM participant_context pc
	LEFT JOIN eligible_sessions es ON TRUE
	GROUP BY pc.account_id, pc.program_id
`

const getParticipantAttendanceHistoryPageQuery = `
	WITH participant_context AS (
		SELECT p.account_id, p.id AS program_id, pp.id AS participant_id,
		       pp.enrolled_at::date AS enrolled_on,
		       CASE
		         WHEN pp.dropped_at IS NULL THEN pp.completed_at
		         WHEN pp.completed_at IS NULL THEN pp.dropped_at
		         ELSE LEAST(pp.dropped_at, pp.completed_at)
		       END::date AS ended_on
		FROM programs p
		JOIN program_participants pp ON pp.program_id = p.id
		JOIN contacts c ON c.account_id = p.account_id AND c.id = pp.contact_id
		WHERE p.account_id = $1 AND p.id = $2 AND pp.id = $3
	), ranked_sessions AS (
		SELECT ps.*,
		       ROW_NUMBER() OVER (
		         ORDER BY ps.date ASC,
		                  COALESCE(NULLIF(BTRIM(ps.start_time), ''), '00:00') ASC,
		                  ps.created_at ASC, ps.id ASC
		       )::int AS ordinal,
		       COALESCE(NULLIF(BTRIM(ps.start_time), ''), '00:00') AS sort_start_time
		FROM program_sessions ps
		JOIN participant_context pc
		  ON pc.account_id = ps.account_id AND pc.program_id = ps.program_id
	), topic_rollup AS (
		SELECT pst.session_id,
		       JSONB_AGG(
		         JSONB_BUILD_OBJECT(
		           'id', pst.id,
		           'session_id', pst.session_id,
		           'kind', pst.kind,
		           'course_id', pst.course_id,
		           'course_topic_id', pst.course_topic_id,
		           'course_name', pst.course_name_snapshot,
		           'title', pst.topic_title_snapshot,
		           'position', pst.position,
		           'created_at', pst.created_at
		         ) ORDER BY pst.position ASC, pst.created_at ASC, pst.id ASC
		       ) AS topics
		FROM program_session_topics pst
		JOIN ranked_sessions rs ON rs.account_id = pst.account_id AND rs.id = pst.session_id
		GROUP BY pst.session_id
	), observation_ranked AS (
		SELECT i.program_session_id AS session_id, i.id,
		       COALESCE(i.notes, '') AS notes, i.created_by,
		       u.display_name AS created_by_name, i.created_at,
		       COALESCE(i.source_label, '') AS source_label,
		       COUNT(*) OVER (PARTITION BY i.program_session_id)::int AS observation_count,
		       ROW_NUMBER() OVER (
		         PARTITION BY i.program_session_id
		         ORDER BY i.created_at DESC, i.id DESC
		       ) AS observation_position
		FROM interactions i
		JOIN participant_context pc
		  ON pc.account_id = i.account_id
		 AND pc.program_id = i.program_id
		 AND pc.participant_id = i.program_participant_id
		LEFT JOIN users u ON u.id = i.created_by
		WHERE i.type = 'attendance' AND i.program_session_id IS NOT NULL
	), latest_observation AS (
		SELECT * FROM observation_ranked WHERE observation_position = 1
	)
	SELECT rs.ordinal, rs.id,
	       COALESCE(NULLIF(BTRIM(rs.title), ''), 'Sesión ' || rs.ordinal::text) AS title,
	       rs.date, rs.start_time, rs.end_time,
	       COALESCE(NULLIF(BTRIM(rs.session_type), ''), 'regular') AS session_type,
	       COALESCE(tr.topics, '[]'::jsonb) AS topics,
	       CASE WHEN pa.status IN ('present', 'absent', 'late') THEN pa.status END AS status,
	       COALESCE(lo.observation_count, 0)::int AS observation_count,
	       lo.id, lo.notes, lo.created_by, lo.created_by_name, lo.created_at, lo.source_label,
	       NOT (
	         rs.date >= pc.enrolled_on
	         AND (pc.ended_on IS NULL OR rs.date <= pc.ended_on)
	       ) AS historical,
	       rs.sort_start_time, rs.created_at
	FROM ranked_sessions rs
	JOIN participant_context pc ON TRUE
	LEFT JOIN program_attendance pa
	  ON pa.session_id = rs.id AND pa.participant_id = pc.participant_id
	LEFT JOIN topic_rollup tr ON tr.session_id = rs.id
	LEFT JOIN latest_observation lo ON lo.session_id = rs.id
	WHERE rs.date <= CURRENT_DATE
	  AND (
	    (
	      rs.date >= pc.enrolled_on
	      AND (pc.ended_on IS NULL OR rs.date <= pc.ended_on)
	    )
	    OR pa.id IS NOT NULL
	    OR COALESCE(lo.observation_count, 0) > 0
	  )
	  AND (
	    $4::date IS NULL
	    OR (rs.date, rs.sort_start_time, rs.created_at, rs.id)
	       < ($4::date, $5::text, $6::timestamptz, $7::uuid)
	  )
	ORDER BY rs.date DESC, rs.sort_start_time DESC, rs.created_at DESC, rs.id DESC
	LIMIT $8
`

type programAttendanceHistoryRowScanner interface {
	Scan(dest ...any) error
}

func scanProgramAttendanceHistorySession(row programAttendanceHistoryRowScanner) (*domain.ProgramParticipantAttendanceHistorySession, error) {
	session := &domain.ProgramParticipantAttendanceHistorySession{
		Topics: make([]*domain.ProgramSessionTopic, 0),
	}
	var topicsJSON []byte
	var observationID *uuid.UUID
	var observationNotes *string
	var observationCreatedBy *uuid.UUID
	var observationCreatedByName *string
	var observationCreatedAt *time.Time
	var observationSourceLabel *string
	if err := row.Scan(
		&session.Ordinal, &session.SessionID, &session.Title,
		&session.CursorDate, &session.StartTime, &session.EndTime,
		&session.SessionType, &topicsJSON, &session.Status,
		&session.ObservationCount,
		&observationID, &observationNotes, &observationCreatedBy,
		&observationCreatedByName, &observationCreatedAt, &observationSourceLabel,
		&session.Historical, &session.CursorStartTime, &session.CursorCreatedAt,
	); err != nil {
		return nil, err
	}
	session.Date = session.CursorDate.Format("2006-01-02")
	if len(topicsJSON) > 0 {
		if err := json.Unmarshal(topicsJSON, &session.Topics); err != nil {
			return nil, err
		}
	}
	if session.Topics == nil {
		session.Topics = make([]*domain.ProgramSessionTopic, 0)
	}
	if observationID != nil {
		observation := &domain.ProgramAttendanceObservation{
			ID:            *observationID,
			CreatedBy:     observationCreatedBy,
			CreatedByName: observationCreatedByName,
		}
		if observationNotes != nil {
			observation.Notes = *observationNotes
		}
		if observationCreatedAt != nil {
			observation.CreatedAt = *observationCreatedAt
		}
		if observationSourceLabel != nil {
			observation.SourceLabel = *observationSourceLabel
		}
		session.ObservationPreview = observation
	}
	return session, nil
}

// GetParticipantAttendanceHistory performs a fixed number of set-based,
// account-scoped queries. limit includes the service's one-row lookahead.
func (r *ProgramRepository) GetParticipantAttendanceHistory(
	ctx context.Context,
	accountID, programID, participantID uuid.UUID,
	cursor *ProgramAttendanceHistoryCursor,
	limit int,
) (ProgramAttendanceHistoryCounts, []*domain.ProgramParticipantAttendanceHistorySession, error) {
	counts := ProgramAttendanceHistoryCounts{}
	err := r.db.QueryRow(ctx, getParticipantAttendanceHistorySummaryQuery, accountID, programID, participantID).Scan(
		&counts.GoalPercent, &counts.EligibleSessions, &counts.MarkedSessions,
		&counts.Present, &counts.Absent, &counts.Late,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return counts, nil, ErrProgramParticipantNotFound
		}
		return counts, nil, err
	}

	var cursorDate any
	var cursorStartTime any
	var cursorCreatedAt any
	var cursorSessionID any
	if cursor != nil {
		cursorDate = cursor.Date
		cursorStartTime = cursor.StartTime
		cursorCreatedAt = cursor.CreatedAt
		cursorSessionID = cursor.SessionID
	}
	rows, err := r.db.Query(ctx, getParticipantAttendanceHistoryPageQuery,
		accountID, programID, participantID,
		cursorDate, cursorStartTime, cursorCreatedAt, cursorSessionID, limit,
	)
	if err != nil {
		return counts, nil, err
	}
	defer rows.Close()

	sessions := make([]*domain.ProgramParticipantAttendanceHistorySession, 0, limit)
	for rows.Next() {
		session, scanErr := scanProgramAttendanceHistorySession(rows)
		if scanErr != nil {
			return counts, nil, scanErr
		}
		sessions = append(sessions, session)
	}
	if err := rows.Err(); err != nil {
		return counts, nil, err
	}
	return counts, sessions, nil
}
