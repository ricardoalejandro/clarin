package repository

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestParseWorkEventRecurrenceRejectsUnsafeOrUnboundedShapes(t *testing.T) {
	loc := time.FixedZone("test", -5*60*60)
	for _, raw := range []string{
		"FREQ=HOURLY", "FREQ=DAILY", "FREQ=DAILY;COUNT=731", "FREQ=DAILY;COUNT=2;UNTIL=20270101",
		"FREQ=MONTHLY;BYDAY=MO", "FREQ=DAILY;INTERVAL=0", "FREQ=DAILY;X-CSS=red",
	} {
		if _, err := ParseWorkEventRecurrence(raw, loc); err == nil {
			t.Fatalf("expected %q to be rejected", raw)
		}
	}
}

func TestExpandWorkEventYearlyLeapSeriesUsesOccurrenceBoundNotDailyScan(t *testing.T) {
	start := time.Date(2024, 2, 29, 9, 0, 0, 0, time.UTC)
	end := start.Add(time.Hour)
	event := &domain.WorkEvent{ID: uuid.New(), StartAt: &start, EndAt: &end, Timezone: "UTC",
		RecurrenceRule: "FREQ=YEARLY;INTERVAL=1;COUNT=4"}
	items, err := ExpandWorkEvent(event, start.Add(-time.Hour), time.Date(2040, 1, 1, 0, 0, 0, 0, time.UTC))
	if err != nil || len(items) != 4 {
		t.Fatalf("expand leap series: count=%d err=%v", len(items), err)
	}
	wantYears := []int{2024, 2028, 2032, 2036}
	for index, item := range items {
		if item.StartAt.Year() != wantYears[index] || item.StartAt.Month() != time.February || item.StartAt.Day() != 29 {
			t.Fatalf("occurrence %d=%s want leap day in %d", index, item.StartAt, wantYears[index])
		}
	}
}

func TestExpandWorkEventRangeCanStartAfterOldSeriesBase(t *testing.T) {
	start := time.Date(2020, 1, 1, 9, 0, 0, 0, time.UTC)
	end := start.Add(time.Hour)
	event := &domain.WorkEvent{ID: uuid.New(), StartAt: &start, EndAt: &end, Timezone: "UTC",
		RecurrenceRule: "FREQ=MONTHLY;INTERVAL=1;COUNT=120"}
	from := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	items, err := ExpandWorkEvent(event, from, from.AddDate(0, 2, 0))
	if err != nil || len(items) != 2 {
		t.Fatalf("expand later window: count=%d err=%v", len(items), err)
	}
	if items[0].StartAt.Before(from) {
		t.Fatalf("returned occurrence before visible range: %s", items[0].StartAt)
	}
}

func TestExpandWorkEventAllDayKeepsExactCalendarDates(t *testing.T) {
	start, end := "2026-03-07", "2026-03-08"
	event := &domain.WorkEvent{ID: uuid.New(), IsAllDay: true, StartDate: &start, EndDateExclusive: &end,
		Timezone: "America/New_York", RecurrenceRule: "FREQ=DAILY;COUNT=4"}
	from := time.Date(2026, 3, 6, 0, 0, 0, 0, time.UTC)
	to := time.Date(2026, 3, 12, 0, 0, 0, 0, time.UTC)
	items, err := ExpandWorkEvent(event, from, to)
	if err != nil || len(items) != 4 {
		t.Fatalf("expand all-day event: count=%d err=%v", len(items), err)
	}
	if *items[2].StartDate != "2026-03-09" || *items[2].EndDateExclusive != "2026-03-10" {
		t.Fatalf("date-only recurrence shifted: %#v", items[2])
	}
}

func TestExpandWorkEventWeekdays(t *testing.T) {
	start := time.Date(2026, 8, 7, 14, 0, 0, 0, time.UTC) // Friday
	end := start.Add(time.Hour)
	event := &domain.WorkEvent{ID: uuid.New(), StartAt: &start, EndAt: &end, Timezone: "UTC",
		RecurrenceRule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;COUNT=4"}
	items, err := ExpandWorkEvent(event, start.Add(-time.Hour), start.AddDate(0, 0, 10))
	if err != nil || len(items) != 4 {
		t.Fatalf("expand weekdays: count=%d err=%v", len(items), err)
	}
	want := []time.Weekday{time.Friday, time.Monday, time.Tuesday, time.Wednesday}
	for index, item := range items {
		if item.StartAt.Weekday() != want[index] {
			t.Fatalf("occurrence %d weekday=%s want=%s", index, item.StartAt.Weekday(), want[index])
		}
	}
}

func TestExpandWorkEventDailyPreservesWallTimeAcrossDST(t *testing.T) {
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	localStart := time.Date(2026, 3, 7, 9, 0, 0, 0, loc)
	localEnd := localStart.Add(time.Hour)
	start, end := localStart.UTC(), localEnd.UTC()
	event := &domain.WorkEvent{ID: uuid.New(), StartAt: &start, EndAt: &end, Timezone: "America/New_York",
		RecurrenceRule: "FREQ=DAILY;COUNT=4"}
	items, err := ExpandWorkEvent(event, start.Add(-time.Hour), start.AddDate(0, 0, 6))
	if err != nil || len(items) != 4 {
		t.Fatalf("expand DST recurrence: count=%d err=%v", len(items), err)
	}
	for index, item := range items {
		local := item.StartAt.In(loc)
		if local.Hour() != 9 {
			t.Fatalf("occurrence %d shifted to %s", index, local)
		}
	}
}

func TestSplitWorkEventRulesPreservesPastAndRemainingCount(t *testing.T) {
	start := time.Date(2026, 8, 10, 14, 0, 0, 0, time.UTC)
	end := start.Add(time.Hour)
	event := &domain.WorkEvent{ID: uuid.New(), StartAt: &start, EndAt: &end, Timezone: "UTC", RecurrenceRule: "FREQ=WEEKLY;INTERVAL=1;COUNT=8"}
	target := start.AddDate(0, 0, 21)
	key := workEventOccurrenceKey(false, target)
	before, after, occurrence, ordinal, err := splitWorkEventRules(event, key)
	if err != nil {
		t.Fatal(err)
	}
	if ordinal != 3 || occurrence.OccurrenceKey != key {
		t.Fatalf("target ordinal=%d occurrence=%s", ordinal, occurrence.OccurrenceKey)
	}
	if before != "FREQ=WEEKLY;INTERVAL=1;UNTIL=20260831T135959Z" {
		t.Fatalf("unexpected prior rule %q", before)
	}
	if after != "FREQ=WEEKLY;INTERVAL=1;COUNT=5" {
		t.Fatalf("unexpected following rule %q", after)
	}
}
