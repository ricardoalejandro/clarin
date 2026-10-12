package repository

import (
	"time"

	"github.com/google/uuid"
)

type taskSchedule struct{ Start, Due *time.Time }
type taskScheduleEdge struct {
	From, To   uuid.UUID
	LagMinutes int
}

func validTaskDateRange(start, due *time.Time) bool {
	return start == nil || due == nil || !due.Before(*start)
}

// Propagate only the delay required by finish-to-start edges. Existing slack
// survives, shortening never pulls successors forward, and duration is stable.
func propagateTaskSchedule(schedules map[uuid.UUID]taskSchedule, edges []taskScheduleEdge) (map[uuid.UUID]taskSchedule, error) {
	result := make(map[uuid.UUID]taskSchedule, len(schedules))
	indegree := make(map[uuid.UUID]int, len(schedules))
	out := make(map[uuid.UUID][]taskScheduleEdge)
	for id, schedule := range schedules {
		result[id] = schedule
		indegree[id] = 0
	}
	for _, edge := range edges {
		if _, ok := schedules[edge.From]; !ok {
			continue
		}
		if _, ok := schedules[edge.To]; !ok {
			continue
		}
		indegree[edge.To]++
		out[edge.From] = append(out[edge.From], edge)
	}
	queue := make([]uuid.UUID, 0)
	for id, degree := range indegree {
		if degree == 0 {
			queue = append(queue, id)
		}
	}
	visited := 0
	for len(queue) > 0 {
		id := queue[0]
		queue = queue[1:]
		visited++
		for _, edge := range out[id] {
			before, next := result[id], result[edge.To]
			if before.Due != nil && next.Start != nil {
				minimum := before.Due.Add(time.Duration(edge.LagMinutes) * time.Minute)
				if next.Start.Before(minimum) {
					delta := minimum.Sub(*next.Start)
					next.Start = &minimum
					if next.Due != nil {
						due := next.Due.Add(delta)
						next.Due = &due
					}
					result[edge.To] = next
				}
			}
			indegree[edge.To]--
			if indegree[edge.To] == 0 {
				queue = append(queue, edge.To)
			}
		}
	}
	if visited != len(schedules) {
		return nil, ErrTaskDependencyCycle
	}
	return result, nil
}

func equalTaskScheduleTime(left, right *time.Time) bool {
	if left == nil || right == nil {
		return left == right
	}
	return left.Equal(*right)
}
