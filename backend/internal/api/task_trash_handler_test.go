package api

import (
	"testing"

	"github.com/google/uuid"
)

func TestParseTaskTrashEnvironmentID(t *testing.T) {
	want := uuid.New()
	got, err := parseTaskTrashEnvironmentID(want.String())
	if err != nil || got != want {
		t.Fatalf("expected %s, got %s, err=%v", want, got, err)
	}
	for _, value := range []string{"", "not-a-uuid", uuid.Nil.String()} {
		if _, err := parseTaskTrashEnvironmentID(value); err == nil {
			t.Fatalf("expected %q to be rejected", value)
		}
	}
}
