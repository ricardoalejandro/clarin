package repository

import (
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

type programAttendanceRowStub struct {
	scan func(dest ...any) error
}

func (r programAttendanceRowStub) Scan(dest ...any) error {
	return r.scan(dest...)
}

func TestScanProgramAttendanceIncludesLatestObservationAndKeepsLegacyFallback(t *testing.T) {
	attendanceID := uuid.New()
	sessionID := uuid.New()
	participantID := uuid.New()
	observationID := uuid.New()
	createdBy := uuid.New()
	createdAt := time.Date(2026, time.July, 21, 10, 0, 0, 0, time.UTC)
	updatedAt := createdAt.Add(time.Hour)
	observationAt := updatedAt.Add(time.Hour)

	record, err := scanProgramAttendance(programAttendanceRowStub{scan: func(dest ...any) error {
		legacyNotes := "nota legacy"
		phone := "+51999000111"
		latestNotes := "observación más reciente"
		createdByName := "Instructora"
		sourceLabel := "Grupo A · Clase 5 · 21/07/2026"
		*(dest[0].(*uuid.UUID)) = attendanceID
		*(dest[1].(*uuid.UUID)) = sessionID
		*(dest[2].(*uuid.UUID)) = participantID
		*(dest[3].(*string)) = "present"
		*(dest[4].(**string)) = &legacyNotes
		*(dest[5].(*time.Time)) = createdAt
		*(dest[6].(*time.Time)) = updatedAt
		*(dest[7].(*string)) = "Participante"
		*(dest[8].(**string)) = &phone
		*(dest[9].(**uuid.UUID)) = &observationID
		*(dest[10].(**string)) = &latestNotes
		*(dest[11].(**uuid.UUID)) = &createdBy
		*(dest[12].(**string)) = &createdByName
		*(dest[13].(**time.Time)) = &observationAt
		*(dest[14].(**string)) = &sourceLabel
		*(dest[15].(*int)) = 3
		return nil
	}})
	if err != nil {
		t.Fatalf("scan attendance: %v", err)
	}
	if record.ID != attendanceID || record.SessionID != sessionID || record.ParticipantID != participantID {
		t.Fatalf("unexpected attendance identity: %#v", record)
	}
	if record.Notes == nil || *record.Notes != "observación más reciente" || record.ObservationCount != 3 {
		t.Fatalf("latest observation was not projected: %#v", record)
	}
	if len(record.ObservationPreview) != 1 || record.ObservationPreview[0].ID != observationID || record.ObservationPreview[0].CreatedByName == nil || *record.ObservationPreview[0].CreatedByName != "Instructora" {
		t.Fatalf("unexpected observation preview: %#v", record.ObservationPreview)
	}

	legacyOnly, err := scanProgramAttendance(programAttendanceRowStub{scan: func(dest ...any) error {
		legacyNotes := "solo legacy"
		*(dest[0].(*uuid.UUID)) = attendanceID
		*(dest[1].(*uuid.UUID)) = sessionID
		*(dest[2].(*uuid.UUID)) = participantID
		*(dest[3].(*string)) = "late"
		*(dest[4].(**string)) = &legacyNotes
		*(dest[5].(*time.Time)) = createdAt
		*(dest[6].(*time.Time)) = updatedAt
		*(dest[7].(*string)) = "Sin nombre"
		*(dest[8].(**string)) = nil
		*(dest[9].(**uuid.UUID)) = nil
		*(dest[10].(**string)) = nil
		*(dest[11].(**uuid.UUID)) = nil
		*(dest[12].(**string)) = nil
		*(dest[13].(**time.Time)) = nil
		*(dest[14].(**string)) = nil
		*(dest[15].(*int)) = 0
		return nil
	}})
	if err != nil {
		t.Fatalf("scan legacy attendance: %v", err)
	}
	if legacyOnly.Notes == nil || *legacyOnly.Notes != "solo legacy" || legacyOnly.ObservationCount != 0 || len(legacyOnly.ObservationPreview) != 0 {
		t.Fatalf("legacy note fallback was not preserved: %#v", legacyOnly)
	}
}

func TestAttendanceQueryIsSingleAccountScopedLateralRead(t *testing.T) {
	required := []string{
		"LEFT JOIN LATERAL",
		"ps.account_id = $1",
		"pp.program_id = p.id",
		"c.account_id = p.account_id",
		"i.account_id = p.account_id",
		"i.program_id = p.id",
		"COUNT(*) OVER ()",
		"LIMIT 1",
	}
	for _, fragment := range required {
		if !strings.Contains(getAttendanceBySessionQuery, fragment) {
			t.Fatalf("attendance query is missing %q", fragment)
		}
	}
	if strings.Contains(getAttendanceBySessionQuery, "ANY(") {
		t.Fatal("attendance query must not require a second participant observation result set")
	}
}

func TestAttendanceWriteRequiresAccountScopedInclusiveParticipationWindow(t *testing.T) {
	required := []string{
		"p.account_id = $1",
		"pp.program_id = $2",
		"pp.id = $3",
		"$4::date >= pp.enrolled_at::date",
		"WHEN pp.dropped_at IS NULL THEN pp.completed_at",
		"WHEN pp.completed_at IS NULL THEN pp.dropped_at",
		"ELSE LEAST(pp.dropped_at, pp.completed_at)",
		"'infinity'::date",
	}
	for _, fragment := range required {
		if !strings.Contains(participantEligibleForSessionQuery, fragment) {
			t.Fatalf("attendance eligibility query is missing %q", fragment)
		}
	}
}

func TestParticipantAnnulmentPreservesSurveyHistory(t *testing.T) {
	required := []string{
		"FROM survey_instance_recipients",
		"FROM survey_responses",
		"program_participant_id = $1",
		"account_id = $2 AND program_id = $3",
	}
	for _, fragment := range required {
		if !strings.Contains(programParticipantHasActivityQuery, fragment) {
			t.Fatalf("participant annulment guard is missing %q", fragment)
		}
	}
}

func TestProgramParticipantStageWritesAreAccountAndPipelineScoped(t *testing.T) {
	addRequired := []string{
		"p.account_id = $1",
		"c.account_id = p.account_id",
		"$4::uuid IS NULL OR",
		"p.type = 'event'",
		"pipeline.account_id = p.account_id",
		"stage.pipeline_id = p.pipeline_id",
	}
	for _, fragment := range addRequired {
		if !strings.Contains(addProgramParticipantQuery, fragment) {
			t.Fatalf("participant insert is missing stage isolation fragment %q", fragment)
		}
	}
	updateRequired := []string{
		"program.account_id = $2",
		"program.type = 'event'",
		"$1::uuid IS NULL OR EXISTS",
		"pipeline.account_id = program.account_id",
		"stage.pipeline_id = program.pipeline_id",
	}
	for _, fragment := range updateRequired {
		if !strings.Contains(updateProgramParticipantStageQuery, fragment) {
			t.Fatalf("participant stage update is missing isolation fragment %q", fragment)
		}
	}
}

func TestProgramParticipantStageProjectionCannotReadAnotherAccount(t *testing.T) {
	required := []string{
		"stage_pipeline.id = p.pipeline_id",
		"stage_pipeline.account_id = p.account_id",
		"s.pipeline_id = stage_pipeline.id",
	}
	for _, fragment := range required {
		if !strings.Contains(listProgramParticipantsQuery, fragment) {
			t.Fatalf("participant list is missing stage projection isolation fragment %q", fragment)
		}
	}
}

func TestCompatibleSessionTitleUsesResolvedFirstTopic(t *testing.T) {
	topicID := uuid.New()
	session := &domain.ProgramSession{Topics: []*domain.ProgramSessionTopic{{
		Kind:               "course",
		CourseTopicID:      &topicID,
		TopicTitleSnapshot: "Tema canónico",
	}}}
	applyLegacySessionTopic(session)
	applyCompatibleSessionTitle(session)
	if session.Title != "Tema canónico" {
		t.Fatalf("compatible title = %q, want resolved first topic", session.Title)
	}

	explicit := &domain.ProgramSession{
		Title:         "Nombre propio",
		TitleProvided: true,
		Topic:         session.Topic,
	}
	applyCompatibleSessionTitle(explicit)
	if explicit.Title != "Nombre propio" {
		t.Fatalf("explicit title was overwritten: %q", explicit.Title)
	}
}
