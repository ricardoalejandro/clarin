package api

import "testing"

func TestParseAgendaSourcesUsesExactAllowListedNames(t *testing.T) {
	tests := []struct {
		raw          string
		wantTasks    bool
		wantEvents   bool
		wantRejected bool
	}{
		{raw: "tasks,events", wantTasks: true, wantEvents: true},
		{raw: " events ", wantEvents: true},
		{raw: "tasks", wantTasks: true},
		{raw: "notasks", wantRejected: true},
		{raw: "events,calendar", wantRejected: true},
		{raw: "", wantRejected: true},
	}
	for _, test := range tests {
		t.Run(test.raw, func(t *testing.T) {
			tasks, events, err := parseAgendaSources(test.raw)
			if (err != nil) != test.wantRejected {
				t.Fatalf("parseAgendaSources(%q) error=%v", test.raw, err)
			}
			if tasks != test.wantTasks || events != test.wantEvents {
				t.Fatalf("parseAgendaSources(%q)=(%v,%v), want (%v,%v)", test.raw, tasks, events, test.wantTasks, test.wantEvents)
			}
		})
	}
}

func TestAgendaCursorRoundTripPreservesStableTieBreak(t *testing.T) {
	item := agendaResponseItem{Sort: "2026-08-10T09:30:00.123456789Z", Key: "event:series:occurrence"}
	decoded, err := decodeAgendaCursor(encodeAgendaCursor(item))
	if err != nil {
		t.Fatal(err)
	}
	if decoded.Sort != item.Sort || decoded.Key != item.Key {
		t.Fatalf("cursor=%#v want sort=%q key=%q", decoded, item.Sort, item.Key)
	}
}
