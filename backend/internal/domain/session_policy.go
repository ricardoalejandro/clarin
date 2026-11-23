package domain

const DefaultSessionIdleTimeoutMinutes = 30

func ValidSessionIdleTimeoutMinutes(minutes int) bool {
	return minutes >= 5 && minutes <= 1440
}
