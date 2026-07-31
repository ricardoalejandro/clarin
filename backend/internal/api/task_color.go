package api

import (
	"errors"
	"regexp"
	"strings"
)

var (
	taskHexColorPattern = regexp.MustCompile(`^#[0-9A-Fa-f]{6}$`)
	errTaskColorInvalid = errors.New("task color must use #RRGGBB")
)

// normalizeTaskColor is the shared persistence boundary for task folders,
// lists and statuses. It accepts only an opaque six-digit RGB color and stores
// a canonical uppercase value; alpha, gradients and arbitrary CSS stay out of
// account-scoped appearance data.
func normalizeTaskColor(raw, fallback string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		value = strings.TrimSpace(fallback)
	}
	if !taskHexColorPattern.MatchString(value) {
		return "", errTaskColorInvalid
	}
	return strings.ToUpper(value), nil
}

func normalizeOptionalTaskColor(value **string) error {
	if value == nil || *value == nil {
		return nil
	}
	normalized, err := normalizeTaskColor(**value, "")
	if err != nil {
		return err
	}
	*value = &normalized
	return nil
}
