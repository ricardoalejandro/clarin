package api

import "testing"

func TestCanonicalProgramListCache(t *testing.T) {
	for _, input := range []string{"null", " \nnull\t", "[]", "[ {\"name\":\"A\"} ]"} {
		got, valid := canonicalProgramListCache([]byte(input))
		if !valid {
			t.Fatalf("valid list rejected: %q", input)
		}
		if (input == "null" || input == " \nnull\t") && string(got) != "[]" {
			t.Fatalf("legacy empty cache must return [], got %s", got)
		}
	}
	for _, input := range []string{"", "{}", "{\"error\":\"unavailable\"}", "[", "[]garbage"} {
		if _, valid := canonicalProgramListCache([]byte(input)); valid {
			t.Fatalf("invalid cache entry accepted: %q", input)
		}
	}
}
