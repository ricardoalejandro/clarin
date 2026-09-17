package api

import (
	"testing"

	"github.com/google/uuid"
)

func TestOfflineProgramAttendancePatchIsStrict(t *testing.T) {
	sessionID, participantID := uuid.New(), uuid.New()
	valid := []byte(`{"session_id":"` + sessionID.String() + `","participant_id":"` + participantID.String() + `","status":"present","expected_status":""}`)
	patch, err := parseOfflineProgramAttendancePatch(valid)
	if err != nil || patch.SessionID != sessionID || patch.ParticipantID != participantID {
		t.Fatalf("valid patch rejected: %#v %v", patch, err)
	}
	unknown := []byte(`{"session_id":"` + sessionID.String() + `","participant_id":"` + participantID.String() + `","status":"present","delete_program":true}`)
	if _, err := parseOfflineProgramAttendancePatch(unknown); err == nil {
		t.Fatal("attendance patch accepted an unrelated program mutation")
	}
}
