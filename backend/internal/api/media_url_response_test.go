package api

import (
	"strings"
	"testing"
)

func TestNormalizeMediaJSONPreservesNonMediaAndPrecision(t *testing.T) {
	old := "https://media.example/clarin-media/account/photo.png"
	replacement := "/api/media/file/account/photo.png"
	canonical := func(s string) string {
		if s == old {
			return replacement
		}
		return s
	}
	original := `{"url":"` + old + `","count":9223372036854775807,"nested":["` + old + `"],"text":"see ` + old + `","signed":"/api/media/file/a?media_access=abc","` + old + `":"unchanged","embedded":"{\"url\":\"` + old + `\"}"}`
	got := string(normalizeMediaJSON([]byte(original), canonical))
	if strings.Count(got, replacement) != 2 {
		t.Fatal("did not normalize only the two media values", got)
	}
	if !strings.Contains(got, `9223372036854775807`) || !strings.Contains(got, `"text":"see `+old) || !strings.Contains(got, `"signed":"/api/media/file/a?media_access=abc"`) || !strings.Contains(got, `"`+old+`":"unchanged"`) {
		t.Fatal("nonmedia response changed", got)
	}
	malformed := []byte(`{"broken"`)
	if string(normalizeMediaJSON(malformed, canonical)) != string(malformed) {
		t.Fatal("malformed JSON rewritten")
	}
}
