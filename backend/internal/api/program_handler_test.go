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
