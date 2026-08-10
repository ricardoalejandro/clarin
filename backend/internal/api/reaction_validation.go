package api

import (
	"strings"
	"unicode/utf8"

	"github.com/rivo/uniseg"
)

func isEmojiRune(value rune) bool {
	return (value >= 0x1F000 && value <= 0x1FAFF) ||
		(value >= 0x2600 && value <= 0x27BF) ||
		(value >= 0x2300 && value <= 0x23FF) ||
		(value >= 0x2190 && value <= 0x21FF) ||
		(value >= 0x2B00 && value <= 0x2BFF) ||
		value == 0x00A9 || value == 0x00AE || value == 0x203C || value == 0x2049 ||
		value == 0x20E3 || value == 0x2122 || value == 0x2139 || value == 0x3030 ||
		value == 0x303D || value == 0x3297 || value == 0x3299
}

// normalizeReactionEmoji accepts an empty value for removing an own reaction,
// otherwise exactly one Unicode grapheme containing an emoji code point.
func normalizeReactionEmoji(value string) (string, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", true
	}
	if !utf8.ValidString(value) || len(value) > 64 {
		return "", false
	}
	graphemes := uniseg.NewGraphemes(value)
	count := 0
	for graphemes.Next() {
		count++
		if count > 1 {
			return "", false
		}
	}
	if count != 1 {
		return "", false
	}
	for _, item := range value {
		if isEmojiRune(item) {
			return value, true
		}
	}
	return "", false
}
