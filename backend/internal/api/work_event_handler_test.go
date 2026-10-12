package api

import (
	"sort"
	"testing"
)

func TestAgendaOrderUsesChronologicalInstantAndStableKey(t *testing.T) {
	items := []agendaResponseItem{
		{Sort: "2026-08-10T09:30:00.1Z", Key: "task:b"},
		{Sort: "2026-08-10T09:30:00Z", Key: "task:a"},
		{Sort: "2026-08-10T04:30:00.100-05:00", Key: "event:a"},
	}
	sort.Slice(items, func(i, j int) bool { return agendaItemSort(items[i]) < agendaItemSort(items[j]) })
	if items[0].Key != "task:a" || items[1].Key != "event:a" || items[2].Key != "task:b" {
		t.Fatalf("fraction/offset/tie order incorrect: %#v", items)
	}
}

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
