package api

import (
	"encoding/json"
	"net/url"
	"reflect"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestMediaLegacyObjectIdentityPreservesExactFilename(t *testing.T) {
	account := uuid.New()
	for _, name := range []string{"Historia 17.11.41.mp4", "Niñez y canción.jpeg", "6392_0216(1)1.mp4", "la historia).mp4", "a+b.jpeg", "literal%20espacio.jpeg", "100% listo.jpeg", "pregunta?.jpeg", "fragmento#.jpeg", "una \"cita\".jpeg", "signos'\"]}.jpeg", "una \"cita\" & <foto>.jpeg", "separadores \"línea\" \u2028 y \u2029.jpeg"} {
		t.Run(name, func(t *testing.T) {
			key := account.String() + "/" + name
			canonical := (&url.URL{Path: "/api/media/file/" + key}).String()
			values := []string{key, canonical, "https://external.invalid/clarin-media/" + (&url.URL{Path: key}).String()}
			if !strings.ContainsAny(name, "%?#") {
				values = append(values, "/api/media/file/"+key)
			}
			for _, value := range values {
				payload, _ := json.Marshal([]string{value})
				if got := storageSelfServiceExtractKeys(account, string(payload)); !reflect.DeepEqual(got, []string{key}) {
					t.Errorf("extraction changed object identity: got %q want only %q", got, key)
				}
				refs := storageSelfServiceReferenceValues(account, string(payload))
				if len(refs) != 1 || refs[key] != (value == key || strings.HasPrefix(value, "/api/media/file/")) {
					t.Errorf("reference authority changed object identity: %v", refs)
				}
			}
			parsed, err := url.Parse(mediaProxyURLFromObjectKey(key))
			if err != nil || parsed.Path != "/api/media/file/"+key || parsed.RawQuery != "" || parsed.Fragment != "" {
				t.Error("proxy URL does not preserve the exact object key")
			}
		})
	}
}

func TestMediaLegacyLiteralUnicodeEscapeNeverAliasesUnicodeKey(t *testing.T) {
	account := uuid.New()
	key := account.String() + "/separador\u2028.jpeg"
	literal := account.String() + `/separador\u2028.jpeg`
	for _, value := range []string{literal, "/api/media/file/" + literal, "/api/media/file/" + strings.ReplaceAll(literal, `\`, "%5C")} {
		payload, _ := json.Marshal([]string{value})
		if refs := storageSelfServiceReferenceValues(account, string(payload)); refs[key] || refs[literal] {
			t.Fatal("literal backslash-u reference authorized a distinct Unicode key or bypassed key validation")
		}
	}
}

func TestMediaLegacyReferencesDoNotAuthorizeTruncatedAliases(t *testing.T) {
	account := uuid.New()
	for _, name := range []string{"photo (1).jpeg", "photo(1).jpeg", "photo,one.jpeg", "photo%20one.jpeg"} {
		key := account.String() + "/" + name
		value := (&url.URL{Path: "/api/media/file/" + key}).String()
		refs := storageSelfServiceReferenceValues(account, value)
		if len(refs) != 1 || !refs[key] {
			t.Errorf("URL generated extra readable object identities: %v", refs)
		}
	}
}
