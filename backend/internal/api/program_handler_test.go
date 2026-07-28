package api

import (
	"testing"
	"time"
)

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

func TestParseProgramOptionalLifecycleDateUsesLimaCalendarDay(t *testing.T) {
	exact, err := parseProgramOptionalLifecycleDate("2026-07-27")
	if err != nil || exact == nil || exact.In(time.FixedZone("PET", -5*60*60)).Format("2006-01-02") != "2026-07-27" {
		t.Fatalf("exact lifecycle date changed day: value=%v err=%v", exact, err)
	}
	instant, err := parseProgramOptionalLifecycleDate("2026-07-27T02:00:00Z")
	if err != nil || instant == nil || instant.Format("2006-01-02") != "2026-07-26" {
		t.Fatalf("RFC3339 lifecycle date did not use Lima: value=%v err=%v", instant, err)
	}
	if _, err := parseProgramOptionalLifecycleDate("27/07/2026"); err == nil {
		t.Fatal("invalid lifecycle date was accepted")
	}
}

func TestResolveSessionTitlePrefixSupportsLegacyAlias(t *testing.T) {
	tests := []struct {
		name        string
		titlePrefix string
		topicPrefix string
		want        string
	}{
		{name: "new field wins", titlePrefix: "  Clase  ", topicPrefix: "Tema", want: "Clase"},
		{name: "legacy alias", topicPrefix: "  Encuentro  ", want: "Encuentro"},
		{name: "default", want: "Sesión"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := resolveSessionTitlePrefix(test.titlePrefix, test.topicPrefix); got != test.want {
				t.Fatalf("resolveSessionTitlePrefix() = %q, want %q", got, test.want)
			}
		})
	}
}
