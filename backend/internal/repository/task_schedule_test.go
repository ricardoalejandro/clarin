package repository

import (
	"github.com/google/uuid"
	"testing"
	"time"
)

func TestTaskDateRangeRejectsReverseAndAllowsEqualityAndMissing(t *testing.T) {
	now := time.Now()
	before := now.Add(-time.Minute)
	if validTaskDateRange(&now, &before) || !validTaskDateRange(&now, &now) || !validTaskDateRange(&now, nil) {
		t.Fatal("invalid date range decision")
	}
}

func TestTaskSchedulePropagatesEndChangeLagAndDiamondWithoutAdvancing(t *testing.T) {
	a, b, c, d := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	base := time.Date(2026, 10, 12, 9, 0, 0, 0, time.UTC)
	at := func(hours int) *time.Time { value := base.Add(time.Duration(hours) * time.Hour); return &value }
	input := map[uuid.UUID]taskSchedule{a: {at(0), at(5)}, b: {at(2), at(3)}, c: {at(10), at(12)}, d: {at(4), at(6)}}
	out, err := propagateTaskSchedule(input, []taskScheduleEdge{{a, b, 30}, {a, c, 0}, {b, d, 0}, {c, d, 60}})
	if err != nil {
		t.Fatal(err)
	}
	if !out[b].Start.Equal(base.Add(330*time.Minute)) || out[b].Due.Sub(*out[b].Start) != time.Hour {
		t.Fatal("end resize did not preserve successor duration/lag")
	}
	if !out[c].Start.Equal(*input[c].Start) {
		t.Fatal("existing slack moved")
	}
	if !out[d].Start.Equal(*at(13)) || out[d].Due.Sub(*out[d].Start) != 2*time.Hour {
		t.Fatal("diamond did not use latest predecessor")
	}
	if !input[b].Start.Equal(*at(2)) {
		t.Fatal("input mutated")
	}
	if _, err := propagateTaskSchedule(input, []taskScheduleEdge{{a, b, 0}, {b, a, 0}}); err != ErrTaskDependencyCycle {
		t.Fatal("cycle accepted")
	}
}
