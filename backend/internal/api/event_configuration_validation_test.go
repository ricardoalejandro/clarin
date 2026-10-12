package api

import (
	"strings"
	"testing"
)

func TestValidateEventIdentity(t *testing.T) {
	for _, row := range []struct {
		name, color string
		valid       bool
	}{{"Encuentro", "#aabbCC", true}, {"   ", "#AABBCC", false}, {"Evento", "red", false}, {strings.Repeat("ñ", 256), "#AABBCC", false}, {"Evento", "#abc", false}} {
		if (validateEventIdentity(row.name, row.color) == nil) != row.valid {
			t.Fatalf("invalid validation: %q %q", row.name, row.color)
		}
	}
}
