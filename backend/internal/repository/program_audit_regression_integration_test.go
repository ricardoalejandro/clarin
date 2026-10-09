package repository

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestProgramCreateRejectsForeignAndMissingFolder(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	a, b := integrityProgram(t, pool), integrityProgram(t, pool)
	r := &ProgramRepository{db: pool}
	ctx := context.Background()
	folder := uuid.New()
	integrityExec(t, pool, `INSERT INTO program_folders(id,account_id,name) VALUES($1,$2,'Synthetic folder')`, folder, b.account)
	for _, folderID := range []uuid.UUID{folder, uuid.New()} {
		p := &domain.Program{AccountID: a.account, Name: "Rejected folder group", Type: "course", Status: "active", FolderID: &folderID, HealthViewColumns: []string{}}
		if err := r.Create(ctx, p); !errors.Is(err, ErrProgramFolderDestinationInvalid) {
			t.Fatalf("foreign/missing folder accepted: %v", err)
		}
		if p.ID != uuid.Nil {
			t.Fatal("rejected create must not create a program")
		}
	}
	p := &domain.Program{AccountID: b.account, Name: "Owned folder group", Type: "course", Status: "active", FolderID: &folder, HealthViewColumns: []string{}}
	if err := r.Create(ctx, p); err != nil {
		t.Fatalf("own folder rejected: %v", err)
	}
	integrityExec(t, pool, `DELETE FROM program_folders WHERE id=$1`, folder)
	var account uuid.UUID
	var attached *uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT account_id,folder_id FROM programs WHERE id=$1`, p.ID).Scan(&account, &attached); err != nil || account != b.account || attached != nil {
		t.Fatalf("folder deletion must detach only folder_id: %v", err)
	}
}

func TestLegacyAttendanceNotesPersistAcrossStatusWrites(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	f := integrityProgram(t, pool)
	participant := integrityParticipant(t, pool, f)
	session := uuid.New()
	integrityExec(t, pool, `INSERT INTO program_sessions(id,account_id,program_id,title,date) VALUES($1,$2,$3,'Synthetic session','2026-10-01')`, session, f.account, f.program)
	r := &ProgramRepository{db: pool}
	ctx := context.Background()
	note := "Synthetic legacy observation"
	a := &domain.ProgramAttendance{ParticipantID: participant, Status: "present", Notes: &note}
	for range 2 {
		if err := r.BatchMarkAttendance(ctx, f.account, f.user, f.program, session, []*domain.ProgramAttendance{a}); err != nil {
			t.Fatal(err)
		}
	}
	observations, err := r.ListAttendanceObservations(ctx, f.account, f.program, session, participant)
	if err != nil || len(observations) != 1 || observations[0].Notes != note || observations[0].CreatedBy == nil || *observations[0].CreatedBy != f.user {
		t.Fatalf("legacy note must be canonical and retries idempotent: %#v %v", observations, err)
	}
	for _, status := range []string{"absent", ""} {
		if err := r.BatchMarkAttendance(ctx, f.account, f.user, f.program, session, []*domain.ProgramAttendance{{ParticipantID: participant, Status: status}}); err != nil {
			t.Fatal(err)
		}
		var persisted string
		if err := pool.QueryRow(ctx, `SELECT notes FROM program_attendance WHERE session_id=$1 AND participant_id=$2`, session, participant).Scan(&persisted); err != nil || persisted != note {
			t.Fatalf("omitted notes/status clear must preserve observation: %v", err)
		}
	}
	foreignParticipant := uuid.New()
	nextNote := "This batch must roll back"
	if err := r.BatchMarkAttendance(ctx, f.account, f.user, f.program, session, []*domain.ProgramAttendance{{ParticipantID: participant, Status: "present", Notes: &nextNote}, {ParticipantID: foreignParticipant, Status: "absent"}}); !errors.Is(err, ErrProgramParticipantOutsideWindow) {
		t.Fatalf("foreign participant should reject entire batch: %v", err)
	}
	observations, err = r.ListAttendanceObservations(ctx, f.account, f.program, session, participant)
	if err != nil || len(observations) != 1 {
		t.Fatalf("failed batch wrote observation: %v", err)
	}
}

func TestProgramNoDataIsDistinctFromRecordedZero(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	f := integrityProgram(t, pool)
	participant := integrityParticipant(t, pool, f)
	session := uuid.New()
	integrityExec(t, pool, `INSERT INTO program_sessions(id,account_id,program_id,title,date) VALUES($1,$2,$3,'Pending session','2026-10-01')`, session, f.account, f.program)
	r := &ProgramRepository{db: pool}
	ctx := context.Background()
	assertRates := func(marked bool) {
		t.Helper()
		h, err := r.GetProgramHealth(ctx, f.account, f.program)
		if err != nil || h == nil || len(h.Participants) != 1 {
			t.Fatalf("health query: %v", err)
		}
		_, stats, err := r.GetAttendanceStats(ctx, f.account, f.program, nil)
		if err != nil || len(stats) != 1 {
			t.Fatalf("stats query: %v", err)
		}
		d, err := r.GetProgramsDashboard(ctx, f.account, nil, nil)
		if err != nil || len(d.Groups) != 1 {
			t.Fatalf("dashboard query: %v", err)
		}
		for _, rate := range []*float64{h.AttendanceRate, h.Participants[0].AttendanceRate, stats[0].Rate, d.AttendanceRate, d.Groups[0].AttendanceRate} {
			if marked && (rate == nil || *rate != 0) || !marked && rate != nil {
				t.Fatalf("missing attendance and measured zero were conflated: %#v", rate)
			}
		}
		if !marked && (h.Health != "no_data" || h.Participants[0].Health != "no_data" || d.Groups[0].Health != "no_data" || stats[0].Pending != 1) {
			t.Fatal("unmarked session should be pending and no_data")
		}
		if marked && (h.Health == "no_data" || h.Participants[0].Health == "no_data" || d.Groups[0].Health == "no_data") {
			t.Fatal("recorded absence has a real measurement")
		}
	}
	assertRates(false)
	integrityExec(t, pool, `INSERT INTO program_attendance(session_id,participant_id,status) VALUES($1,$2,'confirmed')`, session, participant)
	assertRates(false)
	integrityExec(t, pool, `UPDATE program_attendance SET status='absent' WHERE session_id=$1 AND participant_id=$2`, session, participant)
	assertRates(true)
}
