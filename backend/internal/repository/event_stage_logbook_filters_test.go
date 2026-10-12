package repository

import (
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestEventLogbookStageMappingOnlyRemapsDurableChangedIdentities(t *testing.T) {
	from, to, unchanged := uuid.New(), uuid.New(), uuid.New()
	got := eventLogbookStageMapping(map[string]string{
		strings.ToUpper(from.String()): to.String(),
		unchanged.String():             unchanged.String(),
		"draft-stage":                  to.String(),
		uuid.NewString():               "draft-target",
		"unassigned":                   to.String(),
	})
	if len(got) != 1 || got[from.String()] != to.String() {
		t.Fatalf("unexpected operational stage mapping: %v", got)
	}
}
