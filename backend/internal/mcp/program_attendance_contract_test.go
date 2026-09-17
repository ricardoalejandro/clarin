package mcp

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestBuildProgramSessionResultExposesConfirmedSeparately(t *testing.T) {
	session := &domain.ProgramSession{
		ID:    uuid.New(),
		Date:  time.Date(2026, time.September, 7, 0, 0, 0, 0, time.UTC),
		Title: "Sesión",
		AttendanceStats: map[string]int{
			domain.AttendanceStatusConfirmed: 3,
			domain.AttendanceStatusPresent:   2,
			domain.AttendanceStatusAbsent:    1,
			domain.AttendanceStatusLate:      4,
		},
	}
	result := buildProgramSessionResult(session)
	if result.Confirmed != 3 || result.Present != 2 || result.Absent != 1 || result.Late != 4 {
		t.Fatalf("unexpected MCP attendance statistics: %#v", result)
	}
	payload, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["confirmed"] != float64(3) {
		t.Fatalf("confirmed was not exposed in MCP JSON: %s", payload)
	}
}
