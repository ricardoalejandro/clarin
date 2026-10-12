package repository

import (
	"errors"
	"github.com/naperu/clarin/internal/domain"
	"time"
)

var ErrWorkEventAgendaCapacity = errors.New("agenda candidate capacity exceeded")

func workEventAgendaOrder(occurrence *domain.WorkEventOccurrence) (time.Time, string) {
	var start time.Time
	if occurrence.StartDate != nil {
		start, _ = time.Parse("2006-01-02", *occurrence.StartDate)
	} else if occurrence.StartAt != nil {
		start = occurrence.StartAt.UTC()
	}
	return start, "event:" + occurrence.Event.ID.String() + ":" + occurrence.OccurrenceKey
}
