package api

import "testing"

func TestParseAttendanceStatsMonths(t *testing.T) {
	months, err := parseAttendanceStatsMonths("2026-07, 2026-06,2026-07")
	if err != nil {
		t.Fatalf("parse valid months: %v", err)
	}
	if len(months) != 2 || months[0].Format("2006-01") != "2026-07" || months[1].Format("2006-01") != "2026-06" {
		t.Fatalf("unexpected parsed months: %#v", months)
	}

	for _, value := range []string{"2026-7", "07-2026", "2026-13", "2026-07,bad"} {
		if _, err := parseAttendanceStatsMonths(value); err == nil {
			t.Fatalf("expected %q to be rejected", value)
		}
	}
}
