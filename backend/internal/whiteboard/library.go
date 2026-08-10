package whiteboard

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
)

const MaxLibraryDescriptionRunes = 1000

// ReferencedLibraryFileIDs returns the exact durable image references used by
// live elements in an Excalidraw library. It supports both the current item
// envelope ({"elements": [...]}) and the legacy bare element-array shape.
// Top-level files are metadata only and are deliberately not treated as live
// references: an upload becomes durable only when a library item uses it.
func ReferencedLibraryFileIDs(library json.RawMessage) ([]string, error) {
	if len(library) == 0 || !json.Valid(library) {
		return nil, fmt.Errorf("%w: library", ErrInvalidRealtimeMessage)
	}
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(library, &envelope); err != nil {
		return nil, fmt.Errorf("%w: library", ErrInvalidRealtimeMessage)
	}
	var items []json.RawMessage
	if rawItems, ok := envelope["libraryItems"]; !ok || json.Unmarshal(rawItems, &items) != nil {
		return nil, fmt.Errorf("%w: library items", ErrInvalidRealtimeMessage)
	}
	unique := make(map[string]struct{})
	for _, rawItem := range items {
		trimmed := bytes.TrimSpace(rawItem)
		var rawElements json.RawMessage
		if len(trimmed) > 0 && trimmed[0] == '[' {
			rawElements = trimmed
		} else {
			var item map[string]json.RawMessage
			if json.Unmarshal(trimmed, &item) != nil || len(item["elements"]) == 0 {
				return nil, fmt.Errorf("%w: library item", ErrInvalidRealtimeMessage)
			}
			rawElements = item["elements"]
		}
		var elements []json.RawMessage
		if json.Unmarshal(rawElements, &elements) != nil {
			return nil, fmt.Errorf("%w: library item elements", ErrInvalidRealtimeMessage)
		}
		for _, rawElement := range elements {
			var element struct {
				FileID    *string `json:"fileId"`
				IsDeleted bool    `json:"isDeleted"`
			}
			if json.Unmarshal(rawElement, &element) != nil {
				return nil, fmt.Errorf("%w: library element", ErrInvalidRealtimeMessage)
			}
			if element.IsDeleted || element.FileID == nil || *element.FileID == "" {
				continue
			}
			unique[*element.FileID] = struct{}{}
		}
	}
	ids := make([]string, 0, len(unique))
	for fileID := range unique {
		ids = append(ids, fileID)
	}
	sort.Strings(ids)
	return ids, nil
}
