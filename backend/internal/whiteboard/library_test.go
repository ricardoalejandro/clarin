package whiteboard

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestReferencedLibraryFileIDsSupportsCurrentAndLegacyItems(t *testing.T) {
	t.Parallel()
	library := json.RawMessage(`{
		"type":"excalidrawlib",
		"libraryItems":[
			{"id":"current","elements":[
				{"id":"one","type":"image","fileId":"file_b"},
				{"id":"deleted","type":"image","fileId":"ignored","isDeleted":true}
			]},
			[{"id":"legacy","type":"image","fileId":"file_a"}],
			{"id":"duplicate","elements":[{"id":"again","type":"image","fileId":"file_b"}]}
		],
		"files":{"orphan_metadata":{}}
	}`)
	got, err := ReferencedLibraryFileIDs(library)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"file_a", "file_b"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("file IDs=%v want=%v", got, want)
	}
}

func TestReferencedLibraryFileIDsRejectsMalformedItems(t *testing.T) {
	t.Parallel()
	for _, raw := range []json.RawMessage{
		json.RawMessage(`[]`),
		json.RawMessage(`{"libraryItems":{}}`),
		json.RawMessage(`{"libraryItems":[{"id":"missing-elements"}]}`),
		json.RawMessage(`{"libraryItems":[{"elements":{}}]}`),
	} {
		if _, err := ReferencedLibraryFileIDs(raw); err == nil {
			t.Fatalf("malformed library was accepted: %s", raw)
		}
	}
}
