package service

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"math"
	"strings"
)

const clarinCharacterStyleProperty = "clarinCharacterStyle"

type clarinCharacterStyleRun struct {
	From       *int     `json:"from"`
	To         *int     `json:"to"`
	Color      *string  `json:"color,omitempty"`
	FontFamily *int     `json:"fontFamily,omitempty"`
	FontScale  *float64 `json:"fontScale,omitempty"`
}

func validClarinCharacterFont(font int) bool {
	return font == 1 || font == 2 || font == 3 || font >= 5 && font <= 9 || font >= 10001 && font <= 10025
}

func sameCharacterRunStyle(a, b clarinCharacterStyleRun) bool {
	equalString := func(a, b *string) bool { return a == nil && b == nil || a != nil && b != nil && *a == *b }
	equalInt := func(a, b *int) bool { return a == nil && b == nil || a != nil && b != nil && *a == *b }
	equalFloat := func(a, b *float64) bool { return a == nil && b == nil || a != nil && b != nil && *a == *b }
	return equalString(a.Color, b.Color) && equalInt(a.FontFamily, b.FontFamily) && equalFloat(a.FontScale, b.FontScale)
}

func validateClarinCharacterStyle(raw json.RawMessage, element map[string]json.RawMessage, text string) (int, error) {
	var keys map[string]json.RawMessage
	if json.Unmarshal(raw, &keys) != nil || len(keys) != 4 {
		return 0, ErrWhiteboardPayloadInvalid
	}
	var format struct {
		Version    int                       `json:"version"`
		TextLength int                       `json:"textLength"`
		TextHash   uint32                    `json:"textHash"`
		Runs       []clarinCharacterStyleRun `json:"runs"`
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&format) != nil || format.Version != 1 || format.TextLength != clarinUTF16Length(text) || format.TextHash != clarinTextHash(text) || format.Runs == nil || len(format.Runs) > MaxClarinTextRunsPerElement {
		return 0, ErrWhiteboardPayloadInvalid
	}
	var baseSize float64
	if json.Unmarshal(element["fontSize"], &baseSize) != nil || math.IsNaN(baseSize) || math.IsInf(baseSize, 0) || baseSize < 1 {
		return 0, ErrWhiteboardPayloadInvalid
	}
	boundaries := clarinGraphemeBoundaries(text)
	var rawRuns []map[string]json.RawMessage
	if json.Unmarshal(keys["runs"], &rawRuns) != nil {
		return 0, ErrWhiteboardPayloadInvalid
	}
	for index, run := range format.Runs {
		if run.From == nil || run.To == nil || *run.From < 0 || *run.From >= *run.To || *run.To > format.TextLength || run.Color == nil && run.FontFamily == nil && run.FontScale == nil {
			return 0, ErrWhiteboardPayloadInvalid
		}
		if _, ok := boundaries[*run.From]; !ok {
			return 0, ErrWhiteboardPayloadInvalid
		}
		if _, ok := boundaries[*run.To]; !ok {
			return 0, ErrWhiteboardPayloadInvalid
		}
		// Null is not an optional style value: omission alone means inheritance.
		for _, value := range rawRuns[index] {
			if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
				return 0, ErrWhiteboardPayloadInvalid
			}
		}
		if run.Color != nil {
			color := *run.Color
			if len(color) != 7 || color[0] != '#' || color != strings.ToUpper(color) {
				return 0, ErrWhiteboardPayloadInvalid
			}
			if _, err := hex.DecodeString(color[1:]); err != nil {
				return 0, ErrWhiteboardPayloadInvalid
			}
		}
		if run.FontFamily != nil && !validClarinCharacterFont(*run.FontFamily) {
			return 0, ErrWhiteboardPayloadInvalid
		}
		if run.FontScale != nil {
			effective := baseSize * *run.FontScale
			if *run.FontScale <= 0 || *run.FontScale == 1 || math.IsInf(effective, 0) || math.IsNaN(effective) || effective < 1 {
				return 0, ErrWhiteboardPayloadInvalid
			}
		}
		if index > 0 {
			previous := format.Runs[index-1]
			if *run.From < *previous.To || *run.From == *previous.To && sameCharacterRunStyle(previous, run) {
				return 0, ErrWhiteboardPayloadInvalid
			}
		}
	}
	return len(format.Runs), nil
}
