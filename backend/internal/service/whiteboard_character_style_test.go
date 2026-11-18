package service

import (
	"encoding/json"
	"testing"
)

func TestClarinCharacterStyleValidation(t *testing.T) {
	text := "A😀BC"
	base := map[string]json.RawMessage{"fontSize": json.RawMessage(`20`), "type": json.RawMessage(`"text"`), "originalText": json.RawMessage(`"A😀BC"`)}
	for _, tc := range []struct {
		name  string
		runs  string
		valid bool
	}{
		{"mixed typography", `[{"from":1,"to":3,"color":"#AABBCC","fontFamily":10001,"fontScale":1.5}]`, true},
		{"legacy font", `[{"from":0,"to":1,"fontFamily":8}]`, true},
		{"grapheme split", `[{"from":1,"to":2,"color":"#FFFFFF"}]`, false},
		{"lowercase color", `[{"from":0,"to":1,"color":"#aabbcc"}]`, false},
		{"css color", `[{"from":0,"to":1,"color":"red"}]`, false},
		{"unknown font", `[{"from":0,"to":1,"fontFamily":10026}]`, false},
		{"tiny size", `[{"from":0,"to":1,"fontScale":0.01}]`, false},
		{"zero scale", `[{"from":0,"to":1,"fontScale":0}]`, false},
		{"empty style", `[{"from":0,"to":1}]`, false},
		{"missing start", `[{"to":1,"fontScale":1}]`, false},
		{"null optional", `[{"from":0,"to":1,"fontScale":1,"color":null}]`, false},
		{"unknown key", `[{"from":0,"to":1,"fontScale":1,"html":"x"}]`, false},
		{"overlap", `[{"from":0,"to":3,"fontScale":1},{"from":1,"to":4,"fontScale":2}]`, false},
		{"unmerged", `[{"from":0,"to":1,"fontScale":2},{"from":1,"to":3,"fontScale":2}]`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			format := map[string]any{"version": 1, "textLength": clarinUTF16Length(text), "textHash": clarinTextHash(text), "runs": json.RawMessage(tc.runs)}
			raw, _ := json.Marshal(format)
			_, err := validateClarinCharacterStyle(raw, base, text)
			if (err == nil) != tc.valid {
				t.Fatalf("valid=%v: %v", tc.valid, err)
			}
			custom, _ := json.Marshal(map[string]any{clarinCharacterStyleProperty: json.RawMessage(raw)})
			base["customData"] = custom
			_, err = validateClarinTextElementFormats(base, "text")
			if (err == nil) != tc.valid {
				t.Fatalf("element valid=%v: %v", tc.valid, err)
			}
			if _, err = validateClarinTextElementFormats(base, "rectangle"); err == nil {
				t.Fatal("style accepted outside text")
			}
		})
	}
}
