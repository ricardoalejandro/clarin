package database

import (
	"context"
	"errors"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
)

// TestProgramAcademicMigrationAndAttendance runs only against a disposable,
// explicitly enabled PostgreSQL database. It exercises the real startup
// migration twice and the account-scoped attendance query with legacy notes,
// multiple observations, nullable contact names and malformed cross-account
// relationships. It must never target the application database directly.
func TestProgramAcademicMigrationAndAttendance(t *testing.T) {
	if os.Getenv("CLARIN_RUN_PROGRAM_MIGRATION_INTEGRATION") != "1" {
		t.Skip("set CLARIN_RUN_PROGRAM_MIGRATION_INTEGRATION=1 in an isolated PostgreSQL environment")
	}
	rawURL := os.Getenv("DATABASE_URL")
	if rawURL == "" {
		t.Fatal("DATABASE_URL is required")
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		t.Fatalf("parse DATABASE_URL: %v", err)
	}

	const databaseName = "clarin_program_migration_test"
	adminURL := *parsed
	adminURL.Path = "/postgres"
	testURL := *parsed
	testURL.Path = "/" + databaseName
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, adminURL.String())
	if err != nil {
		t.Fatalf("connect admin database: %v", err)
	}
	defer admin.Close()
	_, _ = admin.Exec(ctx, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, databaseName)
	_, _ = admin.Exec(ctx, `DROP DATABASE IF EXISTS `+databaseName)
	if _, err := admin.Exec(ctx, `CREATE DATABASE `+databaseName); err != nil {
		t.Fatalf("create disposable database: %v", err)
	}
	defer func() {
		_, _ = admin.Exec(ctx, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, databaseName)
		_, _ = admin.Exec(ctx, `DROP DATABASE IF EXISTS `+databaseName)
	}()

	db, err := pgxpool.New(ctx, testURL.String())
	if err != nil {
		t.Fatalf("connect disposable database: %v", err)
	}
	defer db.Close()
	if err := Migrate(db); err != nil {
		t.Fatalf("initial migrate: %v", err)
	}

	accountID, otherAccountID := uuid.New(), uuid.New()
	programID, otherProgramID := uuid.New(), uuid.New()
	contactID, legacyContactID, otherContactID := uuid.New(), uuid.New(), uuid.New()
	participantID, legacyParticipantID := uuid.New(), uuid.New()
	crossContactParticipantID := uuid.New()
	sessionID, emptySessionID, otherSessionID := uuid.New(), uuid.New(), uuid.New()
	courseID, firstCourseTopicID, secondCourseTopicID := uuid.New(), uuid.New(), uuid.New()
	userID := uuid.New()

	for _, fixture := range []struct {
		query string
		args  []any
	}{
		{`INSERT INTO accounts (id,name) VALUES ($1,'Cuenta A'),($2,'Cuenta B')`, []any{accountID, otherAccountID}},
		{`INSERT INTO users (id,account_id,username,email,password_hash,display_name) VALUES ($1,$2,$3,$4,'test','Instructora histórica')`, []any{userID, otherAccountID, "program-migration-" + userID.String(), userID.String() + "@example.test"}},
		{`INSERT INTO programs (id,account_id,name,type) VALUES ($1,$2,'Grupo A','course'),($3,$4,'Grupo B','course')`, []any{programID, accountID, otherProgramID, otherAccountID}},
		{`INSERT INTO contacts (id,account_id,jid,phone,name,custom_name) VALUES
			($1,$2,$3,'+51999000111',NULL,'Ana visible'),
			($4,$2,$5,'+51999000222',NULL,NULL),
			($6,$7,$8,'+51999000999','Otra cuenta',NULL)`, []any{
			contactID, accountID, contactID.String() + "@test", legacyContactID, legacyContactID.String() + "@test",
			otherContactID, otherAccountID, otherContactID.String() + "@test",
		}},
		{`INSERT INTO program_participants (id,program_id,contact_id,enrolled_at) VALUES
			($1,$2,$3,'2026-07-15T00:00:00Z'),($4,$2,$5,'2026-07-15T00:00:00Z')`, []any{
			participantID, programID, contactID, legacyParticipantID, legacyContactID,
		}},
		{`INSERT INTO courses (id,account_id,name,status) VALUES ($1,$2,'Plan histórico','active')`, []any{courseID, accountID}},
		{`INSERT INTO course_topics (id,account_id,course_id,title,status,position) VALUES
			($1,$2,$3,'Tema uno','active',0),($4,$2,$3,'Tema dos','active',1)`, []any{
			firstCourseTopicID, accountID, courseID, secondCourseTopicID,
		}},
		{`INSERT INTO program_courses (account_id,program_id,course_id,position) VALUES ($1,$2,$3,0)`, []any{accountID, programID, courseID}},
	} {
		if _, err := db.Exec(ctx, fixture.query, fixture.args...); err != nil {
			t.Fatalf("seed fixture: %v", err)
		}
	}

	// Recreate an upgraded installation whose sessions predate the title
	// column. The first session has an immutable topic snapshot, while the
	// second must receive its deterministic ordinal fallback.
	if _, err := db.Exec(ctx, `ALTER TABLE program_sessions DROP COLUMN title`); err != nil {
		t.Fatalf("drop title to simulate legacy schema: %v", err)
	}
	if _, err := db.Exec(ctx, `
		INSERT INTO program_sessions (id,account_id,program_id,date,topic,start_time)
		VALUES
			($1,$2,$3,'2026-07-21','Tema legacy','09:00'),
			($4,$2,$3,'2026-07-21',NULL,'10:00'),
			($5,$6,$7,'2026-07-21','Tema de otra cuenta','08:00')
	`, sessionID, accountID, programID, emptySessionID, otherSessionID, otherAccountID, otherProgramID); err != nil {
		t.Fatalf("insert legacy sessions: %v", err)
	}
	if _, err := db.Exec(ctx, `
		INSERT INTO program_session_topics (account_id,session_id,kind,topic_title_snapshot,position)
		VALUES ($1,$2,'free','Clase de apertura',0)
	`, accountID, sessionID); err != nil {
		t.Fatalf("insert legacy session snapshot: %v", err)
	}
	if err := Migrate(db); err != nil {
		t.Fatalf("migrate legacy sessions: %v", err)
	}
	if err := Migrate(db); err != nil {
		t.Fatalf("idempotent migrate: %v", err)
	}

	assertProgramSessionTitle(t, db, sessionID, "Clase de apertura")
	assertProgramSessionTitle(t, db, emptySessionID, "Sesión 2")
	assertProgramSessionTitle(t, db, otherSessionID, "Tema de otra cuenta")
	if _, err := db.Exec(ctx, `INSERT INTO program_sessions (account_id,program_id,date,topic) VALUES ($1,$2,'2026-07-22','Tema')`, accountID, programID); err == nil {
		t.Fatal("program_sessions.title accepted NULL after migration")
	}
	if _, err := db.Exec(ctx, `UPDATE program_sessions SET title='   ' WHERE id=$1`, sessionID); err == nil {
		t.Fatal("program_sessions.title accepted a blank value")
	}
	if _, err := db.Exec(ctx, `UPDATE program_sessions SET title=$2 WHERE id=$1`, sessionID, strings.Repeat("a", 256)); err == nil {
		t.Fatal("program_sessions.title accepted more than 255 characters")
	}
	repos := repository.NewRepositories(db)
	correctedEnrollment := time.Date(2026, time.July, 15, 0, 0, 0, 0, time.UTC)
	updatedEnrollment, err := repos.Program.UpdateParticipantEnrollmentDate(ctx, accountID, programID, participantID, correctedEnrollment)
	if err != nil || updatedEnrollment.Format("2006-01-02") != "2026-07-15" {
		t.Fatalf("correct participant enrollment date: %v, %s", err, updatedEnrollment)
	}
	if _, err := repos.Program.UpdateParticipantEnrollmentDate(ctx, otherAccountID, programID, participantID, correctedEnrollment); !errors.Is(err, repository.ErrProgramParticipantNotFound) {
		t.Fatalf("cross-account enrollment update must be hidden as not found, got %v", err)
	}
	if _, err := db.Exec(ctx, `UPDATE program_participants SET completed_at='2026-07-14' WHERE id=$1`, participantID); err != nil {
		t.Fatalf("set participant completion fixture: %v", err)
	}
	if _, err := repos.Program.UpdateParticipantEnrollmentDate(ctx, accountID, programID, participantID, correctedEnrollment); !errors.Is(err, repository.ErrProgramParticipantEnrollmentAfterEnd) {
		t.Fatalf("enrollment after completion must be rejected, got %v", err)
	}
	if _, err := db.Exec(ctx, `UPDATE program_participants SET completed_at=NULL WHERE id=$1`, participantID); err != nil {
		t.Fatalf("clear participant completion fixture: %v", err)
	}
	var enrollmentIndexExists bool
	if err := db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_indexes WHERE indexname='idx_program_sessions_account_program_date')`).Scan(&enrollmentIndexExists); err != nil || !enrollmentIndexExists {
		t.Fatalf("attendance period index missing: exists=%v err=%v", enrollmentIndexExists, err)
	}
	sameCourse := &domain.ProgramSession{
		ProgramID:     programID,
		Date:          time.Date(2026, time.July, 22, 0, 0, 0, 0, time.UTC),
		Title:         "Agregado inválido",
		TitleProvided: true,
		Topics: []*domain.ProgramSessionTopic{
			{Kind: "course", CourseTopicID: &firstCourseTopicID},
			{Kind: "course", CourseTopicID: &secondCourseTopicID},
		},
	}
	if err := repos.Program.CreateSession(ctx, accountID, sameCourse); !errors.Is(err, repository.ErrInvalidSessionTopic) {
		t.Fatalf("two topics from the same course were not rejected transactionally: %v", err)
	}
	mixedModes := &domain.ProgramSession{
		ProgramID:     programID,
		Date:          time.Date(2026, time.July, 22, 0, 0, 0, 0, time.UTC),
		Title:         "Mezcla inválida",
		TitleProvided: true,
		Topics: []*domain.ProgramSessionTopic{
			{Kind: "course", CourseTopicID: &firstCourseTopicID},
			{Kind: "free", TopicTitleSnapshot: "Tema libre"},
		},
	}
	if err := repos.Program.CreateSession(ctx, accountID, mixedModes); !errors.Is(err, repository.ErrInvalidSessionTopic) {
		t.Fatalf("free and course topics were not rejected transactionally: %v", err)
	}

	snapshotSession := &domain.ProgramSession{
		ProgramID:     programID,
		Date:          time.Date(2026, time.July, 22, 0, 0, 0, 0, time.UTC),
		Title:         "Nombre independiente",
		TitleProvided: true,
		Topics: []*domain.ProgramSessionTopic{
			{Kind: "course", CourseTopicID: &firstCourseTopicID},
		},
	}
	if err := repos.Program.CreateSession(ctx, accountID, snapshotSession); err != nil {
		t.Fatalf("create course-backed session: %v", err)
	}
	if _, err := db.Exec(ctx, `UPDATE courses SET name='Plan renombrado' WHERE id=$1`, courseID); err != nil {
		t.Fatalf("rename source course: %v", err)
	}
	if _, err := db.Exec(ctx, `UPDATE course_topics SET title='Tema renombrado' WHERE id=$1`, firstCourseTopicID); err != nil {
		t.Fatalf("rename source course topic: %v", err)
	}
	listedSessions, err := repos.Program.ListSessions(ctx, accountID, programID)
	if err != nil {
		t.Fatalf("list sessions with historical snapshots: %v", err)
	}
	var listedSnapshot *domain.ProgramSession
	for _, listed := range listedSessions {
		if listed.ID == snapshotSession.ID {
			listedSnapshot = listed
			break
		}
	}
	if listedSnapshot == nil || listedSnapshot.Title != "Nombre independiente" || len(listedSnapshot.Topics) != 1 ||
		listedSnapshot.Topics[0].TopicTitleSnapshot != "Tema uno" || listedSnapshot.Topics[0].CourseNameSnapshot == nil ||
		*listedSnapshot.Topics[0].CourseNameSnapshot != "Plan histórico" {
		t.Fatalf("course/topic historical snapshots were not preserved: %#v", listedSnapshot)
	}

	createdFromLegacyPayload := &domain.ProgramSession{
		ProgramID: programID,
		Date:      time.Date(2026, time.July, 22, 0, 0, 0, 0, time.UTC),
		Topics: []*domain.ProgramSessionTopic{{
			Kind:               "free",
			TopicTitleSnapshot: "Tema enviado por cliente legacy",
		}},
	}
	if err := repos.Program.CreateSession(ctx, accountID, createdFromLegacyPayload); err != nil {
		t.Fatalf("create session without title: %v", err)
	}
	if createdFromLegacyPayload.Title != "Tema enviado por cliente legacy" {
		t.Fatalf("legacy create did not derive resolved first topic: %#v", createdFromLegacyPayload)
	}
	updateWithoutTitle := &domain.ProgramSession{
		ID:          sessionID,
		ProgramID:   programID,
		Date:        time.Date(2026, time.July, 21, 0, 0, 0, 0, time.UTC),
		SessionType: "regular",
		Topics: []*domain.ProgramSessionTopic{{
			Kind:               "free",
			TopicTitleSnapshot: "Contenido actualizado",
		}},
	}
	if err := repos.Program.UpdateSession(ctx, accountID, updateWithoutTitle); err != nil {
		t.Fatalf("update session without title: %v", err)
	}
	assertProgramSessionTitle(t, db, sessionID, "Clase de apertura")

	// Deliberately bypass product validation to prove the read refuses a
	// participant whose Contact belongs to another account.
	if _, err := db.Exec(ctx, `INSERT INTO program_participants (id,program_id,contact_id) VALUES ($1,$2,$3)`, crossContactParticipantID, programID, otherContactID); err != nil {
		t.Fatalf("insert cross-account participant fixture: %v", err)
	}
	if _, err := db.Exec(ctx, `
		INSERT INTO program_attendance (session_id,participant_id,status,notes) VALUES
			($1,$2,'present','legacy reemplazable'),
			($1,$3,'late','solo legacy'),
			($1,$4,'present','no debe filtrarse a la cuenta A')
	`, sessionID, participantID, legacyParticipantID, crossContactParticipantID); err != nil {
		t.Fatalf("insert attendance fixtures: %v", err)
	}
	if rows, err := repos.Program.GetAttendanceBySession(ctx, accountID, emptySessionID); err != nil || len(rows) != 0 {
		t.Fatalf("empty attendance: rows=%#v err=%v", rows, err)
	}
	firstObservation, err := repos.Program.CreateAttendanceObservation(ctx, accountID, userID, programID, sessionID, participantID, "primera observación")
	if err != nil {
		t.Fatalf("create first observation: %v", err)
	}
	secondObservation, err := repos.Program.CreateAttendanceObservation(ctx, accountID, userID, programID, sessionID, participantID, "última observación")
	if err != nil {
		t.Fatalf("create second observation: %v", err)
	}
	if err := repos.Program.BatchMarkAttendance(ctx, accountID, userID, programID, sessionID, []*domain.ProgramAttendance{{
		SessionID: sessionID, ParticipantID: participantID, Status: "",
	}}); err != nil {
		t.Fatalf("clear attendance while retaining observations: %v", err)
	}
	retainedObservations, err := repos.Program.ListAttendanceObservations(ctx, accountID, programID, sessionID, participantID)
	if err != nil || len(retainedObservations) != 2 {
		t.Fatalf("clearing attendance removed observations: observations=%#v err=%v", retainedObservations, err)
	}
	clearedAttendance, err := repos.Program.GetAttendanceBySession(ctx, accountID, sessionID)
	if err != nil {
		t.Fatalf("read cleared attendance: %v", err)
	}
	var clearedRecord *domain.ProgramAttendance
	for _, record := range clearedAttendance {
		if record.ParticipantID == participantID {
			clearedRecord = record
			break
		}
	}
	if clearedRecord == nil || clearedRecord.Status != "" || clearedRecord.ObservationCount != 2 {
		t.Fatalf("cleared attendance lost its observation aggregate: %#v", clearedRecord)
	}
	if err := repos.Program.BatchMarkAttendance(ctx, accountID, userID, programID, sessionID, []*domain.ProgramAttendance{{
		SessionID: sessionID, ParticipantID: participantID, Status: domain.AttendanceStatusPresent,
	}}); err != nil {
		t.Fatalf("restore present attendance: %v", err)
	}
	if _, err := db.Exec(ctx, `UPDATE program_attendance SET status='excused' WHERE session_id=$1 AND participant_id=$2`, sessionID, participantID); err == nil {
		t.Fatal("program_attendance accepted the removed excused status")
	}
	if firstObservation.SourceLabel != "Grupo A · Clase de apertura · 21/07/2026" || secondObservation.SourceLabel != firstObservation.SourceLabel {
		t.Fatalf("source label does not use independent session title: first=%q second=%q", firstObservation.SourceLabel, secondObservation.SourceLabel)
	}
	if _, err := db.Exec(ctx, `
		INSERT INTO interactions (
			account_id,contact_id,type,notes,program_id,program_session_id,program_participant_id,source_label,created_at
		) VALUES ($1,$2,'attendance','fuga entre cuentas',$3,$4,$5,'otra cuenta',NOW()+INTERVAL '1 day')
	`, otherAccountID, otherContactID, programID, sessionID, participantID); err != nil {
		t.Fatalf("insert cross-account interaction fixture: %v", err)
	}

	attendance, err := repos.Program.GetAttendanceBySession(ctx, accountID, sessionID)
	if err != nil {
		t.Fatalf("get attendance: %v", err)
	}
	if len(attendance) != 2 {
		t.Fatalf("attendance returned %d rows, want 2 account-valid participants: %#v", len(attendance), attendance)
	}
	byParticipant := make(map[uuid.UUID]int, len(attendance))
	for index, record := range attendance {
		byParticipant[record.ParticipantID] = index
	}
	observed := attendance[byParticipant[participantID]]
	if observed.ParticipantName != "Ana visible" || observed.ObservationCount != 2 || len(observed.ObservationPreview) != 1 {
		t.Fatalf("unexpected observed attendance: %#v", observed)
	}
	if observed.Notes == nil || *observed.Notes != "última observación" || observed.ObservationPreview[0].ID != secondObservation.ID {
		t.Fatalf("latest observation was not selected: %#v", observed)
	}
	if observed.ObservationPreview[0].CreatedByName == nil || *observed.ObservationPreview[0].CreatedByName != "Instructora histórica" {
		t.Fatalf("historical author from another primary account was lost: %#v", observed.ObservationPreview[0])
	}
	legacy := attendance[byParticipant[legacyParticipantID]]
	if legacy.ParticipantName != "+51999000222" || legacy.Notes == nil || *legacy.Notes != "solo legacy" || legacy.ObservationCount != 0 {
		t.Fatalf("legacy attendance fallback failed: %#v", legacy)
	}
	listedSessions, err = repos.Program.ListSessions(ctx, accountID, programID)
	if err != nil {
		t.Fatalf("list sessions with attendance stats: %v", err)
	}
	var listedAttendanceStats map[string]int
	for _, listed := range listedSessions {
		if listed.ID == sessionID {
			listedAttendanceStats = listed.AttendanceStats
			break
		}
	}
	if listedAttendanceStats[domain.AttendanceStatusPresent] != 1 || listedAttendanceStats[domain.AttendanceStatusLate] != 1 || listedAttendanceStats[domain.AttendanceStatusAbsent] != 0 {
		t.Fatalf("session card stats counted malformed cross-account attendance: %#v", listedAttendanceStats)
	}
	sessionStats, participantStats, err := repos.Program.GetAttendanceStats(ctx, accountID, programID, []time.Time{
		time.Date(2026, time.July, 1, 0, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatalf("get P/F/T attendance stats: %v", err)
	}
	var targetSessionStat *domain.ProgramSessionAttendanceStat
	for _, stat := range sessionStats {
		if stat.SessionID == sessionID {
			targetSessionStat = stat
			break
		}
	}
	if targetSessionStat == nil || targetSessionStat.Present != 1 || targetSessionStat.Late != 1 || targetSessionStat.Absent != 0 || targetSessionStat.Excused != 0 {
		t.Fatalf("unexpected P/F/T session statistics: %#v", targetSessionStat)
	}
	if len(participantStats) != 2 {
		t.Fatalf("attendance participant statistics leaked malformed account data: %#v", participantStats)
	}
	if isolated, err := repos.Program.GetAttendanceBySession(ctx, otherAccountID, sessionID); err != nil || len(isolated) != 0 {
		t.Fatalf("cross-account session read leaked rows: rows=%#v err=%v", isolated, err)
	}

	// The individual timeline counts only held sessions inside the inclusive
	// enrollment window. Real records on either side remain visible as history
	// and must never change the P/F/T summary.
	beforeEnrollmentSessionID, afterEnrollmentSessionID := uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `
		UPDATE program_participants
		SET enrolled_at='2026-07-20T00:00:00Z',status='dropped',dropped_at='2026-07-21T23:59:59Z'
		WHERE id=$1 AND program_id=$2
	`, participantID, programID); err != nil {
		t.Fatalf("set attendance-history enrollment window: %v", err)
	}
	if _, err := db.Exec(ctx, `
		INSERT INTO program_sessions (id,account_id,program_id,title,date,start_time) VALUES
			($1,$3,$4,'Antes de la inscripción','2026-07-19','08:00'),
			($2,$3,$4,'Después del retiro','2026-07-22','08:00')
	`, beforeEnrollmentSessionID, afterEnrollmentSessionID, accountID, programID); err != nil {
		t.Fatalf("insert out-of-window history sessions: %v", err)
	}
	if _, err := db.Exec(ctx, `
		INSERT INTO program_attendance (session_id,participant_id,status) VALUES
			($1,$3,'absent'),($2,$3,'late')
	`, beforeEnrollmentSessionID, afterEnrollmentSessionID, participantID); err != nil {
		t.Fatalf("insert out-of-window attendance: %v", err)
	}
	historyCounts, historyRows, err := repos.Program.GetParticipantAttendanceHistory(
		ctx, accountID, programID, participantID, nil, 26,
	)
	if err != nil {
		t.Fatalf("get individual attendance history: %v", err)
	}
	if historyCounts.EligibleSessions != 2 || historyCounts.MarkedSessions != 1 ||
		historyCounts.Present != 1 || historyCounts.Absent != 0 || historyCounts.Late != 0 {
		t.Fatalf("out-of-window attendance polluted summary: %#v", historyCounts)
	}
	eligibleRows, historicalRows := 0, 0
	historicalStatuses := map[string]bool{}
	for _, row := range historyRows {
		if row.Historical {
			historicalRows++
			if row.Status != nil {
				historicalStatuses[*row.Status] = true
			}
		} else {
			eligibleRows++
		}
	}
	if eligibleRows != 2 || historicalRows != 2 ||
		!historicalStatuses[domain.AttendanceStatusAbsent] || !historicalStatuses[domain.AttendanceStatusLate] {
		t.Fatalf("unexpected individual timeline split: eligible=%d historical=%d statuses=%#v rows=%#v", eligibleRows, historicalRows, historicalStatuses, historyRows)
	}
	if _, _, err := repos.Program.GetParticipantAttendanceHistory(ctx, otherAccountID, programID, participantID, nil, 26); !errors.Is(err, repository.ErrProgramParticipantNotFound) {
		t.Fatalf("cross-account attendance history must look missing, got %v", err)
	}
}

func assertProgramSessionTitle(t *testing.T, db *pgxpool.Pool, sessionID uuid.UUID, want string) {
	t.Helper()
	var got string
	if err := db.QueryRow(context.Background(), `SELECT title FROM program_sessions WHERE id=$1`, sessionID).Scan(&got); err != nil {
		t.Fatalf("read session title: %v", err)
	}
	if got != want {
		t.Fatalf("session %s title = %q, want %q", sessionID, got, want)
	}
}
