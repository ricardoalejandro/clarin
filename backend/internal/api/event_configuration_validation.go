package api

import (
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"
)

var eventIdentityColorPattern = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

func validateEventIdentity(name, color string) error {
	if strings.TrimSpace(name) == "" || utf8.RuneCountInString(name) > 255 {
		return fmt.Errorf("El nombre debe tener entre 1 y 255 caracteres")
	}
	if !eventIdentityColorPattern.MatchString(color) {
		return fmt.Errorf("El color debe usar el formato #RRGGBB")
	}
	return nil
}
