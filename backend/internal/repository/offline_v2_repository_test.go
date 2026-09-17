package repository

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
)

func TestOfflineSelectionKeySeparatesModuleTypeAndResource(t *testing.T) {
	id := uuid.New()
	base := offlineSelectionKey("tasks", "task_list", id)
	if base == offlineSelectionKey("contacts", "task_list", id) || base == offlineSelectionKey("tasks", "contact", id) || base == offlineSelectionKey("tasks", "task_list", uuid.New()) {
		t.Fatal("offline selection key collapsed distinct resources")
	}
}

func TestOfflineSelectionAuditMetadataUsesConcreteJSONValues(t *testing.T) {
	encoded, err := offlineSelectionAuditMetadata(4, 7)
	if err != nil {
		t.Fatalf("encode offline selection audit metadata: %v", err)
	}
	var metadata struct {
		Count             int   `json:"count"`
		SelectionRevision int64 `json:"selection_revision"`
	}
	if err := json.Unmarshal(encoded, &metadata); err != nil {
		t.Fatalf("decode offline selection audit metadata: %v", err)
	}
	if metadata.Count != 4 || metadata.SelectionRevision != 7 {
		t.Fatalf("unexpected metadata: %+v", metadata)
	}
}
