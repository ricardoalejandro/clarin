package repository

import (
	"errors"
	"time"
)

var ErrEventConfigurationConflict = errors.New("EVENT_CONFIGURATION_CONFLICT")

func eventConfigurationMatches(expected *time.Time, current time.Time) bool {
	return expected == nil || expected.UTC().Truncate(time.Microsecond).Equal(current.UTC().Truncate(time.Microsecond))
}
