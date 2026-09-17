package service

import (
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func attendanceStatusPointer(status string) *string {
	return &status
}

func TestValidateAttendanceBatchAcceptsCanonicalStatusesAndExpectedEmpty(t *testing.T) {
	sessionID := uuid.New()
	statuses := []string{
		"",
		domain.AttendanceStatusConfirmed,
		domain.AttendanceStatusPresent,
		domain.AttendanceStatusAbsent,
		domain.AttendanceStatusLate,
	}
	records := make([]*domain.ProgramAttendance, 0, len(statuses))
	for _, status := range statuses {
		records = append(records, &domain.ProgramAttendance{
			ParticipantID:  uuid.New(),
			Status:         status,
			ExpectedStatus: attendanceStatusPointer(""),
		})
	}

	if err := validateAttendanceBatch(sessionID, records); err != nil {
		t.Fatalf("validate attendance batch: %v", err)
	}
	for _, record := range records {
		if record.SessionID != sessionID {
			t.Fatalf("session id = %s, want %s", record.SessionID, sessionID)
		}
	}
}

func TestValidateAttendanceBatchRejectsInvalidExpectedStatusAndDuplicates(t *testing.T) {
	participantID := uuid.New()
	for _, test := range []struct {
		name    string
		records []*domain.ProgramAttendance
		want    string
	}{
		{
			name: "invalid status",
			records: []*domain.ProgramAttendance{{
				ParticipantID: participantID,
				Status:        "excused",
			}},
			want: "invalid attendance status",
		},
		{
			name: "invalid expected status",
			records: []*domain.ProgramAttendance{{
				ParticipantID:  participantID,
				Status:         domain.AttendanceStatusConfirmed,
				ExpectedStatus: attendanceStatusPointer("excused"),
			}},
			want: "invalid expected attendance status",
		},
		{
			name: "duplicate participant",
			records: []*domain.ProgramAttendance{
				{ParticipantID: participantID, Status: domain.AttendanceStatusPresent},
				{ParticipantID: participantID, Status: domain.AttendanceStatusLate},
			},
			want: "duplicate participant",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			if err := validateAttendanceBatch(uuid.New(), test.records); err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error = %v, want containing %q", err, test.want)
			}
		})
	}
}

func TestProgramAttendanceFilterStatusValidation(t *testing.T) {
	for _, status := range []string{"unmarked", domain.AttendanceStatusConfirmed, domain.AttendanceStatusPresent, domain.AttendanceStatusAbsent, domain.AttendanceStatusLate} {
		if !isValidProgramAttendanceFilterStatus(status) {
			t.Fatalf("canonical filter status %q was rejected", status)
		}
	}
	for _, status := range []string{"", "excused", "CONFIRMED"} {
		if isValidProgramAttendanceFilterStatus(status) {
			t.Fatalf("invalid filter status %q was accepted", status)
		}
	}
}
