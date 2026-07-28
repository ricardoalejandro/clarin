package service

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestNextRecurringDue(t *testing.T) {
	friday := time.Date(2026, time.July, 31, 9, 30, 0, 0, time.UTC)
	tests := []struct {
		rule string
		want time.Time
		ok   bool
	}{
		{"daily", time.Date(2026, time.August, 1, 9, 30, 0, 0, time.UTC), true},
		{"weekdays", time.Date(2026, time.August, 3, 9, 30, 0, 0, time.UTC), true},
		{"weekly", time.Date(2026, time.August, 7, 9, 30, 0, 0, time.UTC), true},
		{"monthly", time.Date(2026, time.August, 31, 9, 30, 0, 0, time.UTC), true},
		{"unsupported", friday, false},
	}
	for _, test := range tests {
		got, ok := nextRecurringDue(friday, test.rule)
		if ok != test.ok || !got.Equal(test.want) {
			t.Fatalf("rule %s: got %s,%v; want %s,%v", test.rule, got, ok, test.want, test.ok)
		}
	}
}

func TestTaskReminderScheduleChanged(t *testing.T) {
	due := time.Date(2026, time.August, 1, 12, 0, 0, 0, time.UTC)
	minutes := 15
	owner := uuid.New()
	before := &domain.Task{AssignedTo: owner, DueAt: &due, ReminderMinutes: &minutes, Title: "Antes"}
	after := *before
	after.Title = "Sólo cambió el título"
	if taskReminderScheduleChanged(before, &after) {
		t.Fatal("an unrelated title edit would recreate an already delivered reminder")
	}
	newDue := due.Add(time.Hour)
	after.DueAt = &newDue
	if !taskReminderScheduleChanged(before, &after) {
		t.Fatal("a due-date change must recreate the reminder schedule")
	}
}
