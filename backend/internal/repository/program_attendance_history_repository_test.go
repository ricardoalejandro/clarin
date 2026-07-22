package repository

import (
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

type programAttendanceHistoryRowStub struct {
	scan func(dest ...any) error
}

func (r programAttendanceHistoryRowStub) Scan(dest ...any) error {
	return r.scan(dest...)
}

func TestScanProgramAttendanceHistorySessionHydratesTopicsAndObservation(t *testing.T) {
	sessionID, topicID, observationID, authorID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	date := time.Date(2026, 7, 21, 0, 0, 0, 0, time.UTC)
	createdAt := time.Date(2026, 7, 1, 10, 0, 0, 0, time.UTC)
	observationAt := time.Date(2026, 7, 21, 18, 0, 0, 0, time.UTC)
	start, end, status := "09:00", "10:00", "late"
	notes, authorName, sourceLabel := "Llegó después del inicio", "Docente", "Programa · Sesión"
	topics := `[{"id":"` + topicID.String() + `","session_id":"` + sessionID.String() + `","kind":"free","title":"Ética aplicada","position":0,"created_at":"2026-07-01T10:00:00Z"}]`

	row, err := scanProgramAttendanceHistorySession(programAttendanceHistoryRowStub{scan: func(dest ...any) error {
		*dest[0].(*int) = 4
		*dest[1].(*uuid.UUID) = sessionID
		*dest[2].(*string) = "Debate"
		*dest[3].(*time.Time) = date
		*dest[4].(**string) = &start
		*dest[5].(**string) = &end
		*dest[6].(*string) = "regular"
		*dest[7].(*[]byte) = []byte(topics)
		*dest[8].(**string) = &status
		*dest[9].(*int) = 2
		*dest[10].(**uuid.UUID) = &observationID
		*dest[11].(**string) = &notes
		*dest[12].(**uuid.UUID) = &authorID
		*dest[13].(**string) = &authorName
		*dest[14].(**time.Time) = &observationAt
		*dest[15].(**string) = &sourceLabel
		*dest[16].(*bool) = false
		*dest[17].(*string) = start
		*dest[18].(*time.Time) = createdAt
		return nil
	}})
	if err != nil {
		t.Fatalf("scan history row: %v", err)
	}
	if row.SessionID != sessionID || row.Date != "2026-07-21" || row.Status == nil || *row.Status != status {
		t.Fatalf("unexpected session: %#v", row)
	}
	if len(row.Topics) != 1 || row.Topics[0].TopicTitleSnapshot != "Ética aplicada" {
		t.Fatalf("unexpected topics: %#v", row.Topics)
	}
	if row.ObservationCount != 2 || row.ObservationPreview == nil || row.ObservationPreview.ID != observationID || row.ObservationPreview.Notes != notes {
		t.Fatalf("unexpected observation: %#v", row.ObservationPreview)
	}
	if row.CursorStartTime != start || !row.CursorCreatedAt.Equal(createdAt) {
		t.Fatalf("unexpected cursor fields: %#v", row)
	}
}

func TestParticipantAttendanceHistoryQueriesAreAccountScopedAndSetBased(t *testing.T) {
	summaryFragments := []string{
		"p.account_id = $1",
		"p.id = $2",
		"pp.id = $3",
		"ps.account_id = pc.account_id",
		"ps.date <= CURRENT_DATE",
		"ps.date >= pc.enrolled_on",
		"COUNT(es.status)",
	}
	for _, fragment := range summaryFragments {
		if !strings.Contains(getParticipantAttendanceHistorySummaryQuery, fragment) {
			t.Errorf("summary query missing %q", fragment)
		}
	}
	pageFragments := []string{
		"pc.account_id = ps.account_id",
		"pc.account_id = i.account_id",
		"pc.participant_id = i.program_participant_id",
		"pst.account_id",
		"OR pa.id IS NOT NULL",
		"OR COALESCE(lo.observation_count, 0) > 0",
		"$4::date IS NULL",
		"LIMIT $8",
	}
	for _, fragment := range pageFragments {
		if !strings.Contains(getParticipantAttendanceHistoryPageQuery, fragment) {
			t.Errorf("page query missing %q", fragment)
		}
	}
	combined := getParticipantAttendanceHistorySummaryQuery + getParticipantAttendanceHistoryPageQuery
	if strings.Contains(combined, "excused") {
		t.Fatal("history queries must not expose legacy excused attendance")
	}
}
