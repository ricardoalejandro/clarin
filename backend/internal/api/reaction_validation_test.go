package api

import "testing"

func TestNormalizeReactionEmoji(t *testing.T) {
	for _, value := range []string{"👍", "❤️", "👨‍👩‍👧‍👦", "🏳️‍🌈", "1️⃣", "©️", ""} {
		if normalized, ok := normalizeReactionEmoji(value); !ok || normalized != value {
			t.Fatalf("expected %q to be accepted, got %q ok=%v", value, normalized, ok)
		}
	}
	for _, value := range []string{"A", "👍👍", "hola", "👍 hola"} {
		if _, ok := normalizeReactionEmoji(value); ok {
			t.Fatalf("expected %q to be rejected", value)
		}
	}
}
