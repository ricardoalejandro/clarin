package repository

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/programtransfer"
)

func transferTestExport(t *testing.T, pool *pgxpool.Pool, account, program uuid.UUID) programtransfer.File {
	t.Helper()
	file, err := ExportProgramTransfer(context.Background(), pool, account, program)
	if err != nil {
		t.Fatalf("export synthetic program: %v", err)
	}
	if file.Version != 1 || len(file.Records) == 0 {
		t.Fatalf("invalid export shape: version %d, records %d", file.Version, len(file.Records))
	}
	return file
}

func transferTestPreview(t *testing.T, pool *pgxpool.Pool, account uuid.UUID, request programtransfer.Request) programtransfer.Preview {
	t.Helper()
	preview, err := PreviewProgramTransfer(context.Background(), pool, account, request)
	if err != nil {
		t.Fatalf("preview synthetic program: %v", err)
	}
	if preview.Digest == "" {
		t.Fatal("preview was not bound to a destination snapshot")
	}
	return preview
}

func transferTestApply(t *testing.T, pool *pgxpool.Pool, f integrityProgramFixture, request programtransfer.Request, preview programtransfer.Preview, decisions map[string]string) uuid.UUID {
	t.Helper()
	result, err := ConfirmProgramTransfer(context.Background(), pool, f.account, f.user, programtransfer.ConfirmRequest{Request: request, Decisions: decisions}, preview.Digest, ProgramTransferContactQuota{})
	if err != nil {
		t.Fatalf("confirm synthetic program: %v", err)
	}
	id, err := uuid.Parse(result.ProgramID)
	if err != nil {
		t.Fatalf("invalid destination program: %v", err)
	}
	return id
}

func transferTestCount(t *testing.T, pool *pgxpool.Pool, want int, query string, args ...any) {
	t.Helper()
	var count int
	if err := pool.QueryRow(context.Background(), query, args...).Scan(&count); err != nil || count != want {
		t.Fatalf("expected %d rows, got %d: %v", want, count, err)
	}
}

func TestProgramTransferRoundTripAndAttendanceConflict(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	a, b := integrityProgram(t, pool), integrityProgram(t, pool)
	ctx := context.Background()
	repo := &ProgramRepository{db: pool}
	participantA := integrityParticipant(t, pool, a)
	const author = "Synthetic Origin Professor"
	const unrelated = "Synthetic note outside any program; do not transfer"
	const dateAuthored = "2026-10-02T20:03:00Z"
	const attendanceNotes = "Synthetic attendance observation"
	const followUp = "Synthetic participant follow-up"
	const classNote = "Synthetic whole-class observation"
	const returnNote = "Synthetic class observation added in B"
	const primary = "51999000001"
	const additional = "51999000002"
	const email = "synthetic-participant@transfer.test.invalid"
	authored := time.Date(2026, 10, 2, 20, 3, 0, 0, time.UTC)

	integrityExec(t, pool, `UPDATE users SET display_name=$2 WHERE id=$1`, a.user, author)
	integrityExec(t, pool, `UPDATE contacts SET phone=$2,email=$3 WHERE id=$1`, a.contact, primary, email)
	integrityExec(t, pool, `INSERT INTO contact_phones(contact_id,phone,label) VALUES($1,$2,'mobile')`, a.contact, additional)
	integrityExec(t, pool, `INSERT INTO interactions(account_id,contact_id,type,notes,created_by) VALUES($1,$2,'note',$3,$4)`, a.account, a.contact, unrelated, a.user)
	integrityExec(t, pool, `INSERT INTO program_goals(account_id,program_id,attendance_goal_percent,transfer_goal_percent) VALUES($1,$2,95,78)`, a.account, a.program)
	integrityExec(t, pool, `INSERT INTO program_goals(account_id,attendance_goal_percent) VALUES($1,3)`, a.account)
	// Both accounts have the same instructor. Reuse B's Contact, but the participant must be created.
	instructorA := uuid.New()
	integrityExec(t, pool, `INSERT INTO contacts(id,account_id,jid,name,phone) VALUES($1,$2,$3,'Shared synthetic instructor','51999000003')`, instructorA, a.account, instructorA.String()+"@test.invalid")
	integrityExec(t, pool, `UPDATE contacts SET name='Shared synthetic instructor',phone='51999000003' WHERE id=$1`, b.contact)
	integrityExec(t, pool, `INSERT INTO program_instructors(account_id,program_id,contact_id,position) VALUES($1,$2,$3,0)`, a.account, a.program, instructorA)
	// Never copy unrelated courses or overwrite a local same-name course.
	courseA, topicA := uuid.New(), uuid.New()
	integrityExec(t, pool, `INSERT INTO courses(id,account_id,name) VALUES($1,$2,'Synthetic academic plan')`, courseA, a.account)
	integrityExec(t, pool, `INSERT INTO courses(account_id,name) VALUES($1,'Unrelated synthetic course')`, a.account)
	integrityExec(t, pool, `INSERT INTO course_topics(id,account_id,course_id,title) VALUES($1,$2,$3,'Synthetic topic')`, topicA, a.account, courseA)
	integrityExec(t, pool, `INSERT INTO program_courses(account_id,program_id,course_id) VALUES($1,$2,$3)`, a.account, a.program, courseA)

	sessionA, otherSameDayA, olderA := uuid.New(), uuid.New(), uuid.New()
	integrityExec(t, pool, `INSERT INTO program_sessions(id,account_id,program_id,date,title,start_time,end_time,course_topic_id) VALUES($1,$2,$3,'2026-10-02','Synthetic class','08:00','09:00',$4)`, sessionA, a.account, a.program, topicA)
	integrityExec(t, pool, `INSERT INTO program_sessions(id,account_id,program_id,date,title,start_time,end_time) VALUES($1,$2,$3,'2026-10-02','Synthetic class','20:00','21:00'),($4,$2,$3,'2026-09-30','Synthetic legacy class','20:00','21:00')`, otherSameDayA, a.account, a.program, olderA)
	integrityExec(t, pool, `INSERT INTO program_session_topics(account_id,session_id,kind,course_id,course_topic_id,course_name_snapshot,topic_title_snapshot) VALUES($1,$2,'course',$3,$4,'Synthetic academic plan','Original topic title')`, a.account, sessionA, courseA, topicA)
	integrityExec(t, pool, `INSERT INTO program_attendance(session_id,participant_id,status,notes) VALUES($1,$2,'late',NULL),($3,$2,'present','Preserve out-of-window history')`, sessionA, participantA, olderA)
	integrityExec(t, pool, `INSERT INTO program_session_observations(account_id,session_id,notes,created_by,created_at,is_pinned,pinned_at,pinned_by) VALUES($1,$2,$3,$4,$5::timestamptz,TRUE,$5::timestamptz,$4)`, a.account, sessionA, classNote, a.user, authored)
	integrityExec(t, pool, `INSERT INTO program_participant_notes(account_id,program_id,participant_id,contact_id,session_id,note,created_by,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::timestamptz)`, a.account, a.program, participantA, a.contact, sessionA, followUp, a.user, authored)
	integrityExec(t, pool, `INSERT INTO interactions(account_id,contact_id,program_id,program_session_id,program_participant_id,type,notes,created_by,source_label,created_at) VALUES($1,$2,$3,$4,$5,'attendance',$6,$7,'Synthetic origin label',$8::timestamptz)`, a.account, a.contact, a.program, sessionA, participantA, attendanceNotes, a.user, authored)

	if _, err := ExportProgramTransfer(ctx, pool, b.account, a.program); !errors.Is(err, programtransfer.ErrNotFound) {
		t.Fatalf("foreign program export: %v", err)
	}
	initial := transferTestExport(t, pool, a.account, a.program)
	serialized, err := json.Marshal(initial)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(serialized), unrelated) || strings.Contains(string(serialized), "Unrelated synthetic course") || strings.Contains(string(serialized), a.user.String()) || strings.Contains(string(serialized), a.account.String()) {
		t.Fatal("portable export exposed unrelated history/catalog or account/user authority")
	}
	// Test the same JSON encoding/decoding path as the uploaded file.
	var upload programtransfer.File
	if err := json.Unmarshal(serialized, &upload); err != nil {
		t.Fatal(err)
	}
	requestB := programtransfer.Request{File: upload}
	if _, err := PreviewProgramTransfer(ctx, pool, b.account, programtransfer.Request{File: upload, TargetProgramID: a.program.String()}); !errors.Is(err, programtransfer.ErrNotFound) {
		t.Fatalf("foreign program preview: %v", err)
	}
	first := transferTestPreview(t, pool, b.account, requestB)
	if len(first.Conflicts) != 0 {
		t.Fatalf("unambiguous copy unexpectedly has %d conflicts", len(first.Conflicts))
	}
	transferTestCount(t, pool, 1, `SELECT count(*) FROM programs WHERE account_id=$1`, b.account)
	transferTestCount(t, pool, 1, `SELECT count(*) FROM contacts WHERE account_id=$1`, b.account)
	programB := transferTestApply(t, pool, b, requestB, first, nil)
	if programB == a.program || programB == b.program {
		t.Fatal("new import reused a foreign or unrelated program identity")
	}
	var participantB, contactB, sessionB uuid.UUID
	err = pool.QueryRow(ctx, `SELECT pp.id,c.id,ps.id FROM program_participants pp JOIN contacts c ON c.id=pp.contact_id AND c.account_id=$1 JOIN program_sessions ps ON ps.program_id=pp.program_id AND ps.account_id=c.account_id WHERE pp.program_id=$2 AND ps.date='2026-10-02' AND ps.start_time='08:00' AND pp.enrolled_at='2026-10-01' AND c.email=$3`, b.account, programB, email).Scan(&participantB, &contactB, &sessionB)
	if err != nil || participantB == participantA || contactB == a.contact || sessionB == sessionA {
		t.Fatalf("missing local contact/participant/session mapping: %v", err)
	}
	transferTestCount(t, pool, 2, `SELECT count(*) FROM contacts WHERE account_id=$1`, b.account)
	transferTestCount(t, pool, 1, `SELECT count(*) FROM contact_phones WHERE contact_id=$1 AND regexp_replace(phone,'[^0-9]','','g')=$2`, contactB, additional)
	transferTestCount(t, pool, 1, `SELECT count(*) FROM program_instructors WHERE account_id=$1 AND program_id=$2 AND contact_id=$3`, b.account, programB, b.contact)
	transferTestCount(t, pool, 2, `SELECT count(*) FROM program_sessions WHERE account_id=$1 AND program_id=$2 AND date='2026-10-02'`, b.account, programB)
	transferTestCount(t, pool, 1, `SELECT count(*) FROM program_goals WHERE account_id=$1 AND program_id=$2 AND attendance_goal_percent=95 AND transfer_goal_percent=78`, b.account, programB)
	transferTestCount(t, pool, 1, `SELECT count(*) FROM program_session_topics pst JOIN courses c ON c.account_id=pst.account_id AND c.id=pst.course_id JOIN course_topics ct ON ct.account_id=pst.account_id AND ct.id=pst.course_topic_id AND ct.course_id=c.id WHERE pst.session_id=$1 AND pst.account_id=$2 AND c.id<>$3 AND ct.id<>$4 AND pst.topic_title_snapshot='Original topic title'`, sessionB, b.account, courseA, topicA)
	transferTestCount(t, pool, 0, `SELECT count(*) FROM interactions WHERE account_id=$1 AND notes=$2`, b.account, unrelated)

	observations, err := repo.ListSessionObservations(ctx, b.account, programB, sessionB, b.user, false)
	if err != nil || len(observations) != 1 || observations[0].Notes != classNote || !observations[0].IsPinned || observations[0].CreatedBy != nil || observations[0].CreatedByName == nil || *observations[0].CreatedByName != author || observations[0].CreatedAt.UTC().Format(time.RFC3339) != dateAuthored || observations[0].CanEdit {
		t.Fatalf("class observation lost provenance or gained authority: %v", err)
	}
	attendanceObs, err := repo.ListAttendanceObservations(ctx, b.account, programB, sessionB, participantB)
	if err != nil || len(attendanceObs) != 1 || attendanceObs[0].Notes != attendanceNotes || attendanceObs[0].CreatedByName == nil || *attendanceObs[0].CreatedByName != author || attendanceObs[0].CreatedBy != nil {
		t.Fatalf("attendance observation unavailable or lost provenance: %v", err)
	}
	transferTestCount(t, pool, 1, `SELECT count(*) FROM program_participant_notes WHERE account_id=$1 AND program_id=$2 AND participant_id=$3 AND session_id=$4 AND contact_id=$5 AND note=$6 AND created_by IS NULL AND transfer_author_name=$7`, b.account, programB, participantB, sessionB, contactB, followUp, author)
	counts, history, err := repo.GetParticipantAttendanceHistory(ctx, b.account, programB, participantB, nil, 10)
	if err != nil || counts.EligibleSessions != 2 || counts.MarkedSessions != 1 || counts.Late != 1 || counts.Present != 0 {
		t.Fatalf("attendance window or pending state changed: %+v, %v", counts, err)
	}
	var historical, pending bool
	for _, session := range history {
		historical = historical || (session.Date == "2026-09-30" && session.Historical && session.Status != nil && *session.Status == "present")
		pending = pending || (session.Date == "2026-10-02" && !session.Historical && session.Status == nil)
	}
	if !historical || !pending {
		t.Fatal("missing out-of-window history or pending class")
	}

	replay := transferTestPreview(t, pool, b.account, requestB)
	if replay.Summary.Create != 0 || replay.Summary.Update != 0 || len(replay.Conflicts) != 0 {
		t.Fatalf("exact replay not a no-op: %+v, conflicts=%d", replay.Summary, len(replay.Conflicts))
	}
	if id := transferTestApply(t, pool, b, requestB, replay, nil); id != programB {
		t.Fatal("exact replay created another program")
	}
	transferTestCount(t, pool, 2, `SELECT count(*) FROM programs WHERE account_id=$1`, b.account)

	newSession := &domain.ProgramSession{ProgramID: programB, Date: time.Date(2026, 10, 4, 0, 0, 0, 0, time.UTC), Title: "Synthetic return class"}
	if err := repo.CreateSession(ctx, b.account, newSession); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.CreateSessionObservation(ctx, b.account, programB, newSession.ID, b.user, returnNote); err != nil {
		t.Fatal(err)
	}
	requestA := programtransfer.Request{File: transferTestExport(t, pool, b.account, programB), TargetProgramID: a.program.String()}
	returned := transferTestPreview(t, pool, a.account, requestA)
	if len(returned.Conflicts) != 0 {
		t.Fatalf("return trip unexpectedly has %d conflicts", len(returned.Conflicts))
	}
	if id := transferTestApply(t, pool, a, requestA, returned, nil); id != a.program {
		t.Fatal("return trip did not update A")
	}
	transferTestCount(t, pool, 4, `SELECT count(*) FROM program_sessions WHERE account_id=$1 AND program_id=$2`, a.account, a.program)
	transferTestCount(t, pool, 1, `SELECT count(*) FROM program_session_observations o JOIN program_sessions s ON s.account_id=o.account_id AND s.id=o.session_id WHERE o.account_id=$1 AND s.program_id=$2 AND o.notes=$3`, a.account, a.program, returnNote)
	transferTestCount(t, pool, 2, `SELECT count(*) FROM contacts WHERE account_id=$1`, a.account)

	// Both copies independently change the same status from late. Preview, failed apply,
	// and resolving the conflict must leave the other account untouched.
	integrityExec(t, pool, `UPDATE program_attendance SET status='present' WHERE session_id=$1 AND participant_id=$2`, sessionA, participantA)
	integrityExec(t, pool, `UPDATE program_attendance SET status='absent' WHERE session_id=$1 AND participant_id=$2`, sessionB, participantB)
	diverged := programtransfer.Request{File: transferTestExport(t, pool, b.account, programB), TargetProgramID: a.program.String()}
	conflict := transferTestPreview(t, pool, a.account, diverged)
	if len(conflict.Conflicts) != 1 || conflict.Conflicts[0].Kind != "attendance" || conflict.Conflicts[0].Field != "status" || conflict.Conflicts[0].Local != "present" || conflict.Conflicts[0].Incoming != "absent" {
		t.Fatalf("expected one precise attendance conflict, got %d", len(conflict.Conflicts))
	}
	if _, err := ConfirmProgramTransfer(ctx, pool, a.account, a.user, programtransfer.ConfirmRequest{Request: diverged}, conflict.Digest, ProgramTransferContactQuota{}); !errors.Is(err, programtransfer.ErrConflict) {
		t.Fatalf("unresolved conflict allowed write: %v", err)
	}
	transferTestCount(t, pool, 1, `SELECT count(*) FROM program_attendance WHERE session_id=$1 AND participant_id=$2 AND status='present'`, sessionA, participantA)
	transferTestApply(t, pool, a, diverged, conflict, map[string]string{conflict.Conflicts[0].Key: "incoming"})
	transferTestCount(t, pool, 1, `SELECT count(*) FROM program_attendance WHERE session_id=$1 AND participant_id=$2 AND status='absent'`, sessionA, participantA)
	old := programtransfer.Request{File: initial, TargetProgramID: programB.String()}
	staleFile := transferTestPreview(t, pool, b.account, old)
	if len(staleFile.Conflicts) != 0 {
		t.Fatal("old file should not reopen a conflict or revert a descendant")
	}
	transferTestApply(t, pool, b, old, staleFile, nil)
	transferTestCount(t, pool, 1, `SELECT count(*) FROM program_attendance WHERE session_id=$1 AND participant_id=$2 AND status='absent'`, sessionB, participantB)
}

func TestProgramTransferStalePreviewAndAtomicCommitFailure(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	a, b := integrityProgram(t, pool), integrityProgram(t, pool)
	ctx := context.Background()
	integrityExec(t, pool, `UPDATE programs SET name='Linked synthetic classroom' WHERE id IN ($1,$2)`, a.program, b.program)
	participantA := integrityParticipant(t, pool, a)
	integrityExec(t, pool, `UPDATE contacts SET phone='51999000009' WHERE id=$1`, a.contact)
	sessionA := uuid.New()
	integrityExec(t, pool, `INSERT INTO program_sessions(id,account_id,program_id,date,title) VALUES($1,$2,$3,'2026-10-02','Synthetic transactional class')`, sessionA, a.account, a.program)
	integrityExec(t, pool, `INSERT INTO program_attendance(session_id,participant_id,status) VALUES($1,$2,'present')`, sessionA, participantA)

	request := programtransfer.Request{File: transferTestExport(t, pool, a.account, a.program), TargetProgramID: b.program.String()}
	preview := transferTestPreview(t, pool, b.account, request)
	if len(preview.Conflicts) != 0 {
		t.Fatalf("identical independent target was not linkable: %d conflicts", len(preview.Conflicts))
	}
	integrityExec(t, pool, `UPDATE programs SET description='Synthetic concurrent description' WHERE account_id=$1 AND id=$2`, b.account, b.program)
	if _, err := ConfirmProgramTransfer(ctx, pool, b.account, b.user, programtransfer.ConfirmRequest{Request: request}, preview.Digest, ProgramTransferContactQuota{}); !errors.Is(err, programtransfer.ErrStale) {
		t.Fatalf("stale confirmed preview: %v", err)
	}
	transferTestCount(t, pool, 0, `SELECT count(*) FROM program_sessions WHERE account_id=$1 AND program_id=$2`, b.account, b.program)
	transferTestCount(t, pool, 1, `SELECT count(*) FROM contacts WHERE account_id=$1`, b.account)
	// Reset only the synthetic concurrent change; no import state may have persisted.
	integrityExec(t, pool, `UPDATE programs SET description=NULL WHERE account_id=$1 AND id=$2`, b.account, b.program)
	preview = transferTestPreview(t, pool, b.account, request)

	// Fail at the audit write, after entity writes and links were attempted in the same transaction.
	trigger := "qa_reject_transfer_audit_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	integrityExec(t, pool, `CREATE FUNCTION `+trigger+`() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic transfer audit failure'; END $$`)
	t.Cleanup(func() {
		integrityExec(t, pool, `DROP TRIGGER IF EXISTS `+trigger+` ON program_transfer_imports`)
		integrityExec(t, pool, `DROP FUNCTION IF EXISTS `+trigger+`() `)
	})
	integrityExec(t, pool, `CREATE TRIGGER `+trigger+` BEFORE INSERT ON program_transfer_imports FOR EACH ROW WHEN (NEW.account_id='`+b.account.String()+`'::uuid) EXECUTE FUNCTION `+trigger+`() `)
	if _, err := ConfirmProgramTransfer(ctx, pool, b.account, b.user, programtransfer.ConfirmRequest{Request: request}, preview.Digest, ProgramTransferContactQuota{}); err == nil {
		t.Fatal("injected audit failure succeeded")
	}
	transferTestCount(t, pool, 0, `SELECT count(*) FROM program_sessions WHERE account_id=$1 AND program_id=$2`, b.account, b.program)
	transferTestCount(t, pool, 0, `SELECT count(*) FROM program_participants WHERE program_id=$1`, b.program)
	transferTestCount(t, pool, 0, `SELECT count(*) FROM program_transfer_links WHERE account_id=$1 AND program_id=$2`, b.account, b.program)
	transferTestCount(t, pool, 0, `SELECT count(*) FROM program_transfer_imports WHERE account_id=$1 AND program_id=$2`, b.account, b.program)
	transferTestCount(t, pool, 1, `SELECT count(*) FROM contacts WHERE account_id=$1`, b.account)
	transferTestCount(t, pool, 1, `SELECT count(*) FROM program_attendance WHERE session_id=$1 AND participant_id=$2 AND status='present'`, sessionA, participantA)

	integrityExec(t, pool, `DROP TRIGGER `+trigger+` ON program_transfer_imports`)
	if id := transferTestApply(t, pool, b, request, transferTestPreview(t, pool, b.account, request), nil); id != b.program {
		t.Fatal("retry created a duplicate local program")
	}
	transferTestCount(t, pool, 1, `SELECT count(*) FROM program_sessions WHERE account_id=$1 AND program_id=$2`, b.account, b.program)
	transferTestCount(t, pool, 1, `SELECT count(*) FROM program_transfer_imports WHERE account_id=$1 AND program_id=$2 AND actor_id=$3`, b.account, b.program, b.user)
}

func TestProgramTransferMapsExistingSessionWithoutCollapsingSameDayClasses(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	a, b := integrityProgram(t, pool), integrityProgram(t, pool)
	morningA, eveningA, morningB := uuid.New(), uuid.New(), uuid.New()
	integrityExec(t, pool, `
		INSERT INTO program_sessions(id,account_id,program_id,date,title,start_time,end_time)
		VALUES($1,$2,$3,'2026-10-02','Synthetic repeated title','08:00','09:00'),
		      ($4,$2,$3,'2026-10-02','Synthetic repeated title','20:00','21:00'),
		      ($5,$6,$7,'2026-10-02','Synthetic repeated title','08:00','09:00')`,
		morningA, a.account, a.program, eveningA, morningB, b.account, b.program)
	oldB := transferTestExport(t, pool, b.account, b.program)
	request := programtransfer.Request{File: transferTestExport(t, pool, a.account, a.program), TargetProgramID: b.program.String()}
	preview := transferTestPreview(t, pool, b.account, request)
	candidates := map[string]bool{}
	for _, conflict := range preview.Conflicts {
		if conflict.Kind != "session" || conflict.MappingKey == "" {
			t.Fatalf("expected independent session mapping review, got kind %q", conflict.Kind)
		}
		var existing, create bool
		for _, choice := range conflict.Choices {
			existing = existing || choice.Value == morningB.String()
			create = create || choice.Value == "create"
		}
		candidates[conflict.MappingKey] = existing && create
	}
	if !candidates[morningA.String()] || !candidates[eveningA.String()] {
		t.Fatal("similar sessions lacked distinct keep/create decisions")
	}
	request.Mappings = map[string]string{morningA.String(): morningB.String(), eveningA.String(): "create"}
	preview = transferTestPreview(t, pool, b.account, request)
	if len(preview.Conflicts) != 0 {
		t.Fatalf("mapping exact session and creating new session still has %d conflicts", len(preview.Conflicts))
	}
	if id := transferTestApply(t, pool, b, request, preview, nil); id != b.program {
		t.Fatal("merging into independent program created another program")
	}
	transferTestCount(t, pool, 1, `SELECT count(*) FROM program_sessions WHERE id=$1 AND account_id=$2 AND program_id=$3 AND start_time='08:00'`, morningB, b.account, b.program)
	transferTestCount(t, pool, 1, `SELECT count(*) FROM program_sessions WHERE id<>$1 AND account_id=$2 AND program_id=$3 AND start_time='20:00'`, morningB, b.account, b.program)
	transferTestCount(t, pool, 2, `SELECT count(*) FROM program_sessions WHERE account_id=$1 AND program_id=$2`, b.account, b.program)

	// Both previous identifiers must survive re-export; an older B file does not
	// create a third class or delete the evening class omitted from its snapshot.
	returned := programtransfer.Request{File: transferTestExport(t, pool, b.account, b.program), TargetProgramID: a.program.String()}
	transferTestApply(t, pool, a, returned, transferTestPreview(t, pool, a.account, returned), nil)
	older := programtransfer.Request{File: oldB}
	if id := transferTestApply(t, pool, a, older, transferTestPreview(t, pool, a.account, older), nil); id != a.program {
		t.Fatal("older linked file resolved to another program")
	}
	transferTestCount(t, pool, 2, `SELECT count(*) FROM program_sessions WHERE account_id=$1 AND program_id=$2`, a.account, a.program)
}

func TestProgramTransferPreservesParticipationWithPendingContactIdentity(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	source, destination := integrityProgram(t, pool), integrityProgram(t, pool)
	const providerIdentity = "100000001234567@lid"
	integrityExec(t, pool, `UPDATE contacts SET jid=$3,name=NULL,custom_name=NULL,push_name=NULL,phone=NULL,email=NULL WHERE account_id=$1 AND id=$2`, source.account, source.contact, providerIdentity)
	integrityParticipant(t, pool, source)
	file := transferTestExport(t, pool, source.account, source.program)
	encoded, err := json.Marshal(file)
	if err != nil || strings.Contains(string(encoded), providerIdentity) {
		t.Fatalf("provider identity must not be included in the transfer: %v", err)
	}
	request := programtransfer.Request{File: file}
	imported := transferTestApply(t, pool, destination, request, transferTestPreview(t, pool, destination.account, request), nil)
	transferTestCount(t, pool, 1, `
		SELECT count(*) FROM program_participants pp
		JOIN programs p ON p.id=pp.program_id AND p.account_id=$1
		JOIN contacts c ON c.id=pp.contact_id AND c.account_id=p.account_id
		WHERE p.id=$2 AND c.id<>$3 AND c.jid=('manual_' || c.id::text || '@clarin.contact')
		  AND c.phone IS NULL AND c.email IS NULL AND COALESCE(c.name, '')=''`, destination.account, imported, source.contact)
	if got := transferTestApply(t, pool, destination, request, transferTestPreview(t, pool, destination.account, request), nil); got != imported {
		t.Fatal("replaying the pending identity file created another program")
	}
	transferTestCount(t, pool, 1, `SELECT count(*) FROM program_participants pp JOIN programs p ON p.id=pp.program_id AND p.account_id=$1 WHERE p.id=$2`, destination.account, imported)
}

func TestProgramTransferReusesSamePendingContactAcrossTwoPrograms(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	source, destination := integrityProgram(t, pool), integrityProgram(t, pool)
	integrityExec(t, pool, `UPDATE contacts SET name=NULL,custom_name=NULL,push_name=NULL,phone=NULL,email=NULL WHERE account_id=$1 AND id=$2`, source.account, source.contact)
	integrityParticipant(t, pool, source)
	secondSource := uuid.New()
	integrityExec(t, pool, `INSERT INTO programs(id,account_id,type,name,status,created_by) VALUES($1,$2,'course','Second synthetic program','active',$3)`, secondSource, source.account, source.user)
	integrityExec(t, pool, `INSERT INTO program_participants(program_id,contact_id,status,enrolled_at) VALUES($1,$2,'active','2026-10-01')`, secondSource, source.contact)
	first := programtransfer.Request{File: transferTestExport(t, pool, source.account, source.program)}
	firstDestination := transferTestApply(t, pool, destination, first, transferTestPreview(t, pool, destination.account, first), nil)
	second := programtransfer.Request{File: transferTestExport(t, pool, source.account, secondSource)}
	preview := transferTestPreview(t, pool, destination.account, second)
	if len(preview.Conflicts) != 0 {
		t.Fatalf("an exact known portable Contact identity should not need fuzzy matching: %+v", preview.Conflicts)
	}
	secondDestination := transferTestApply(t, pool, destination, second, preview, nil)
	if firstDestination == secondDestination {
		t.Fatal("two distinct Programs were collapsed")
	}
	transferTestCount(t, pool, 2, `SELECT count(*) FROM contacts WHERE account_id=$1`, destination.account)
	transferTestCount(t, pool, 1, `SELECT count(DISTINCT pp.contact_id) FROM program_participants pp JOIN programs p ON p.id=pp.program_id AND p.account_id=$1 WHERE p.id IN ($2,$3)`, destination.account, firstDestination, secondDestination)
	transferTestCount(t, pool, 1, `SELECT count(*) FROM program_transfer_links WHERE account_id=$1 AND program_id=$2 AND kind='contact' AND portable_id=$3`, destination.account, secondDestination, source.contact)
	replay := transferTestPreview(t, pool, destination.account, second)
	if replay.Summary.Create != 0 || replay.Summary.Update != 0 || len(replay.Conflicts) != 0 {
		t.Fatalf("second Program replay must not duplicate the shared Contact: %+v", replay)
	}
	if got := transferTestApply(t, pool, destination, second, replay, nil); got != secondDestination {
		t.Fatal("replay created another second Program")
	}
	transferTestCount(t, pool, 2, `SELECT count(*) FROM contacts WHERE account_id=$1`, destination.account)
}
