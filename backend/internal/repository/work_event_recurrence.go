package repository

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/naperu/clarin/internal/domain"
)

const maxWorkEventOccurrences = 730

var ErrWorkEventRecurrenceInvalid = errors.New("work event recurrence rule is invalid")

type WorkEventRecurrence struct {
	Frequency string
	Interval  int
	ByDay     map[time.Weekday]bool
	Count     int
	Until     *time.Time
}

var workEventWeekdays = map[string]time.Weekday{
	"SU": time.Sunday, "MO": time.Monday, "TU": time.Tuesday, "WE": time.Wednesday,
	"TH": time.Thursday, "FR": time.Friday, "SA": time.Saturday,
}

func ParseWorkEventRecurrence(raw string, loc *time.Location) (*WorkEventRecurrence, error) {
	raw = strings.TrimSpace(strings.ToUpper(raw))
	if raw == "" {
		return nil, nil
	}
	if loc == nil {
		return nil, ErrWorkEventRecurrenceInvalid
	}
	rule := &WorkEventRecurrence{Interval: 1, ByDay: map[time.Weekday]bool{}}
	seen := map[string]bool{}
	for _, part := range strings.Split(raw, ";") {
		pair := strings.SplitN(part, "=", 2)
		if len(pair) != 2 || pair[0] == "" || pair[1] == "" || seen[pair[0]] {
			return nil, ErrWorkEventRecurrenceInvalid
		}
		seen[pair[0]] = true
		switch pair[0] {
		case "FREQ":
			switch pair[1] {
			case "DAILY", "WEEKLY", "MONTHLY", "YEARLY":
				rule.Frequency = pair[1]
			default:
				return nil, ErrWorkEventRecurrenceInvalid
			}
		case "INTERVAL":
			value, err := strconv.Atoi(pair[1])
			if err != nil || value < 1 || value > 365 {
				return nil, ErrWorkEventRecurrenceInvalid
			}
			rule.Interval = value
		case "BYDAY":
			for _, token := range strings.Split(pair[1], ",") {
				weekday, ok := workEventWeekdays[token]
				if !ok || rule.ByDay[weekday] {
					return nil, ErrWorkEventRecurrenceInvalid
				}
				rule.ByDay[weekday] = true
			}
		case "COUNT":
			value, err := strconv.Atoi(pair[1])
			if err != nil || value < 1 || value > maxWorkEventOccurrences {
				return nil, ErrWorkEventRecurrenceInvalid
			}
			rule.Count = value
		case "UNTIL":
			var value time.Time
			var err error
			if len(pair[1]) == 8 {
				value, err = time.ParseInLocation("20060102", pair[1], loc)
				if err == nil {
					value = value.AddDate(0, 0, 1).Add(-time.Nanosecond)
				}
			} else {
				value, err = time.Parse("20060102T150405Z", pair[1])
			}
			if err != nil {
				return nil, ErrWorkEventRecurrenceInvalid
			}
			rule.Until = &value
		default:
			return nil, ErrWorkEventRecurrenceInvalid
		}
	}
	if rule.Frequency == "" || (rule.Count > 0 && rule.Until != nil) || (rule.Count == 0 && rule.Until == nil) {
		return nil, ErrWorkEventRecurrenceInvalid
	}
	if len(rule.ByDay) > 0 && rule.Frequency != "WEEKLY" {
		return nil, ErrWorkEventRecurrenceInvalid
	}
	return rule, nil
}

func workEventOccurrenceKey(allDay bool, start time.Time) string {
	if allDay {
		return start.Format("2006-01-02")
	}
	return start.UTC().Format("20060102T150405Z")
}

func eventDateValue(raw *string, loc *time.Location) (time.Time, error) {
	if raw == nil {
		return time.Time{}, ErrWorkEventRecurrenceInvalid
	}
	value, err := time.ParseInLocation("2006-01-02", *raw, loc)
	if err != nil {
		return time.Time{}, fmt.Errorf("%w: invalid date", ErrWorkEventRecurrenceInvalid)
	}
	return value, nil
}

func workEventRecurrenceMatches(rule *WorkEventRecurrence, base, candidate time.Time) bool {
	calendarDays := func(left, right time.Time) int {
		leftDate := time.Date(left.Year(), left.Month(), left.Day(), 0, 0, 0, 0, time.UTC)
		rightDate := time.Date(right.Year(), right.Month(), right.Day(), 0, 0, 0, 0, time.UTC)
		return int(rightDate.Sub(leftDate) / (24 * time.Hour))
	}
	days := calendarDays(base, candidate)
	if days < 0 {
		return false
	}
	switch rule.Frequency {
	case "DAILY":
		return days%rule.Interval == 0
	case "WEEKLY":
		baseMonday := base.AddDate(0, 0, -((int(base.Weekday()) + 6) % 7))
		candidateMonday := candidate.AddDate(0, 0, -((int(candidate.Weekday()) + 6) % 7))
		weeks := calendarDays(baseMonday, candidateMonday) / 7
		if weeks < 0 || weeks%rule.Interval != 0 {
			return false
		}
		if len(rule.ByDay) == 0 {
			return candidate.Weekday() == base.Weekday()
		}
		return rule.ByDay[candidate.Weekday()]
	case "MONTHLY":
		months := (candidate.Year()-base.Year())*12 + int(candidate.Month()-base.Month())
		return months >= 0 && months%rule.Interval == 0 && candidate.Day() == base.Day()
	case "YEARLY":
		return candidate.Year() >= base.Year() && (candidate.Year()-base.Year())%rule.Interval == 0 &&
			candidate.Month() == base.Month() && candidate.Day() == base.Day()
	default:
		return false
	}
}

func occurrenceOverlapsRange(start, end, from, to time.Time) bool {
	return start.Before(to) && end.After(from)
}

type workEventSeriesGeometry struct {
	loc        *time.Location
	baseStart  time.Time
	baseEnd    time.Time
	duration   time.Duration
	allDaySpan int
	rule       *WorkEventRecurrence
}

func workEventGeometry(event *domain.WorkEvent) (*workEventSeriesGeometry, error) {
	if event == nil {
		return nil, ErrWorkEventRecurrenceInvalid
	}
	loc, err := time.LoadLocation(event.Timezone)
	if err != nil {
		return nil, ErrWorkEventRecurrenceInvalid
	}
	geometry := &workEventSeriesGeometry{loc: loc}
	if event.IsAllDay {
		geometry.baseStart, err = eventDateValue(event.StartDate, loc)
		if err != nil {
			return nil, err
		}
		geometry.baseEnd, err = eventDateValue(event.EndDateExclusive, loc)
		if err != nil || !geometry.baseStart.Before(geometry.baseEnd) {
			return nil, ErrWorkEventRecurrenceInvalid
		}
		for cursor := geometry.baseStart; cursor.Before(geometry.baseEnd); cursor = cursor.AddDate(0, 0, 1) {
			geometry.allDaySpan++
		}
	} else {
		if event.StartAt == nil || event.EndAt == nil || !event.StartAt.Before(*event.EndAt) {
			return nil, ErrWorkEventRecurrenceInvalid
		}
		geometry.baseStart = event.StartAt.In(loc)
		geometry.baseEnd = event.EndAt.In(loc)
	}
	geometry.duration = geometry.baseEnd.Sub(geometry.baseStart)
	geometry.rule, err = ParseWorkEventRecurrence(event.RecurrenceRule, loc)
	if err != nil {
		return nil, err
	}
	return geometry, nil
}

func workEventCandidateStarts(geometry *workEventSeriesGeometry) []time.Time {
	if geometry.rule == nil {
		return []time.Time{geometry.baseStart}
	}
	rule := geometry.rule
	limit := maxWorkEventOccurrences
	if rule.Count > 0 {
		limit = rule.Count
	}
	result := make([]time.Time, 0, limit)
	appendCandidate := func(candidate time.Time) bool {
		if candidate.Before(geometry.baseStart) {
			return true
		}
		if rule.Until != nil && candidate.After(rule.Until.In(geometry.loc)) {
			return false
		}
		result = append(result, candidate)
		return len(result) < limit
	}
	wallTime := func(day time.Time) time.Time {
		return time.Date(day.Year(), day.Month(), day.Day(), geometry.baseStart.Hour(), geometry.baseStart.Minute(), geometry.baseStart.Second(), geometry.baseStart.Nanosecond(), geometry.loc)
	}

	switch rule.Frequency {
	case "DAILY":
		for index := 0; len(result) < limit; index++ {
			if !appendCandidate(geometry.baseStart.AddDate(0, 0, index*rule.Interval)) {
				break
			}
		}
	case "WEEKLY":
		if len(rule.ByDay) == 0 {
			for index := 0; len(result) < limit; index++ {
				if !appendCandidate(geometry.baseStart.AddDate(0, 0, index*rule.Interval*7)) {
					break
				}
			}
			break
		}
		weekdays := []time.Weekday{time.Monday, time.Tuesday, time.Wednesday, time.Thursday, time.Friday, time.Saturday, time.Sunday}
		baseDay := time.Date(geometry.baseStart.Year(), geometry.baseStart.Month(), geometry.baseStart.Day(), 0, 0, 0, 0, geometry.loc)
		baseMonday := baseDay.AddDate(0, 0, -((int(baseDay.Weekday()) + 6) % 7))
		stop := false
		for week := 0; len(result) < limit && !stop; week++ {
			weekStart := baseMonday.AddDate(0, 0, week*rule.Interval*7)
			for _, weekday := range weekdays {
				if !rule.ByDay[weekday] {
					continue
				}
				candidate := wallTime(weekStart.AddDate(0, 0, (int(weekday)+6)%7))
				if !appendCandidate(candidate) {
					stop = true
					break
				}
			}
		}
	case "MONTHLY":
		for period := 0; len(result) < limit; period++ {
			monthStart := time.Date(geometry.baseStart.Year(), geometry.baseStart.Month()+time.Month(period*rule.Interval), 1,
				geometry.baseStart.Hour(), geometry.baseStart.Minute(), geometry.baseStart.Second(), geometry.baseStart.Nanosecond(), geometry.loc)
			candidate := time.Date(monthStart.Year(), monthStart.Month(), geometry.baseStart.Day(), geometry.baseStart.Hour(), geometry.baseStart.Minute(), geometry.baseStart.Second(), geometry.baseStart.Nanosecond(), geometry.loc)
			if candidate.Month() != monthStart.Month() {
				if rule.Until != nil && monthStart.After(rule.Until.In(geometry.loc)) {
					break
				}
				continue
			}
			if !appendCandidate(candidate) {
				break
			}
		}
	case "YEARLY":
		for period := 0; len(result) < limit; period++ {
			year := geometry.baseStart.Year() + period*rule.Interval
			candidate := time.Date(year, geometry.baseStart.Month(), geometry.baseStart.Day(), geometry.baseStart.Hour(), geometry.baseStart.Minute(), geometry.baseStart.Second(), geometry.baseStart.Nanosecond(), geometry.loc)
			if candidate.Year() != year || candidate.Month() != geometry.baseStart.Month() {
				continue
			}
			if !appendCandidate(candidate) {
				break
			}
		}
	}
	return result
}

func expandAllWorkEventOccurrences(event *domain.WorkEvent) ([]*domain.WorkEventOccurrence, error) {
	geometry, err := workEventGeometry(event)
	if err != nil {
		return nil, err
	}
	starts := workEventCandidateStarts(geometry)
	result := make([]*domain.WorkEventOccurrence, 0, len(starts))
	for _, start := range starts {
		end := start.Add(geometry.duration)
		if event.IsAllDay {
			end = start.AddDate(0, 0, geometry.allDaySpan)
		}
		occurrence := &domain.WorkEventOccurrence{Event: event, SeriesID: event.ID, OccurrenceKey: workEventOccurrenceKey(event.IsAllDay, start)}
		if event.IsAllDay {
			startDate, endDate := start.Format("2006-01-02"), end.Format("2006-01-02")
			occurrence.StartDate, occurrence.EndDateExclusive = &startDate, &endDate
		} else {
			startUTC, endUTC := start.UTC(), end.UTC()
			occurrence.StartAt, occurrence.EndAt = &startUTC, &endUTC
		}
		result = append(result, occurrence)
	}
	return result, nil
}

// ExpandWorkEvent produces at most 730 occurrences and preserves local wall
// time across timezone/DST changes. Date-only values never pass through UTC.
func ExpandWorkEvent(event *domain.WorkEvent, from, to time.Time) ([]*domain.WorkEventOccurrence, error) {
	if event == nil || !from.Before(to) {
		return nil, ErrWorkEventRecurrenceInvalid
	}
	all, err := expandAllWorkEventOccurrences(event)
	if err != nil {
		return nil, err
	}
	result := make([]*domain.WorkEventOccurrence, 0, len(all))
	for _, occurrence := range all {
		var start, end time.Time
		if occurrence.StartAt != nil && occurrence.EndAt != nil {
			start, end = *occurrence.StartAt, *occurrence.EndAt
		} else {
			loc, _ := time.LoadLocation(event.Timezone)
			start, _ = time.ParseInLocation("2006-01-02", *occurrence.StartDate, loc)
			end, _ = time.ParseInLocation("2006-01-02", *occurrence.EndDateExclusive, loc)
		}
		if occurrenceOverlapsRange(start, end, from, to) {
			result = append(result, occurrence)
		}
	}
	return result, nil
}
