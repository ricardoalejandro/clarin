package api

import (
	"testing"

	"github.com/google/uuid"
)

func TestParseTaskVersionInputsRejectsInvalidIdentityAndVersion(t *testing.T) {
	id := uuid.New()
	items, err := parseTaskVersionInputs([]taskBulkVersionRequest{{ID: id.String(), Version: 4}})
	if err != nil || len(items) != 1 || items[0].ID != id || items[0].Version != 4 {
		t.Fatalf("valid item was not normalized: items=%#v err=%v", items, err)
	}
	for _, input := range [][]taskBulkVersionRequest{
		{{ID: "not-a-uuid", Version: 1}},
		{{ID: id.String(), Version: 0}},
	} {
		if _, err := parseTaskVersionInputs(input); err == nil {
			t.Fatalf("invalid bulk item was accepted: %#v", input)
		}
	}
}
