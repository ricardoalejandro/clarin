package domain

import (
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestReceivedMessageLinkPreviewURLBoundary(t *testing.T) {
	for _, tc := range []struct{ name, body, matched, want string }{
		{"https", "See https://example.test/path?q=uno&x=dos#part", "https://example.test/path?q=uno&x=dos#part", "https://example.test/path?q=uno&x=dos#part"},
		{"case", "HTTPS://EXAMPLE.test/p", "https://example.test/p", "https://example.test/p"},
		{"www", "See www.example.test/p.", "www.example.test/p", "https://www.example.test/p"},
		{"origin", "https://example.test", "https://example.test/", "https://example.test/"},
		{"default-port", "https://example.test:443/p", "https://example.test/p", "https://example.test/p"},
		{"balanced", "(https://example.test/a_(b)).", "https://example.test/a_(b)", "https://example.test/a_(b)"},
		{"bold", "*https://example.test/path*", "https://example.test/path", "https://example.test/path"},
		{"double-bold", "**https://example.test/path**", "https://example.test/path", "https://example.test/path"},
		{"italic", "_https://example.test/snake_case_", "https://example.test/snake_case", "https://example.test/snake_case"},
		{"strike", "~https://example.test/path~", "https://example.test/path", "https://example.test/path"},
		{"nested-format", "*_https://example.test/path_*", "https://example.test/path", "https://example.test/path"},
		{"literal-underscore", "https://example.test/path_", "https://example.test/path_", "https://example.test/path_"},
		{"literal-star", "https://example.test/path*", "https://example.test/path*", "https://example.test/path*"},
		{"unmatched-marker", "https://example.test/path*", "https://example.test/path", ""},
		{"host-prefix", "https://example.test.evil/p", "https://example.test", ""},
		{"other-host", "https://example.test/p", "https://other.test/p", ""},
		{"userinfo", "https://user:pass@example.test/p", "https://user:pass@example.test/p", ""},
		{"javascript", "javascript:alert(1)", "javascript:alert(1)", ""},
		{"backslash", "https://example.test\\@other.test/p", "https://example.test\\@other.test/p", ""},
		{"control", "https://example.test/p", "https://example.test/\np", ""},
		{"space", "https://example.test/p", "https://example.test/a b", ""},
		{"encoded-control", "https://example.test/%0A", "https://example.test/%0A", ""},
		{"encoded-backslash", "https://example.test/%5C@other.test", "https://example.test/%5C@other.test", ""},
		{"path-mismatch", "https://example.test/path-other", "https://example.test/path", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := ReceivedMessageLinkPreview(tc.body, tc.matched, "Title", "Description")
			if tc.want == "" {
				if got != nil {
					t.Fatal("accepted unsafe/mismatched metadata")
				}
				return
			}
			if got == nil || got.URL != tc.want || got.ThumbnailURL != nil {
				t.Fatalf("preview=%+v", got)
			}
		})
	}
}

func TestMessageLinkPreviewLimitsAndCanonicalNull(t *testing.T) {
	link := "https://example.test/p"
	preview := ReceivedMessageLinkPreview(link, link, strings.Repeat("ñ", 300), strings.Repeat("界", 1100))
	if preview == nil || utf8.RuneCountInString(preview.Title) != 256 || utf8.RuneCountInString(preview.Description) != 1024 {
		t.Fatal("Unicode metadata limits")
	}
	large := ReceivedMessageLinkPreview(link, link, "  "+strings.Repeat("界", 100000)+"  ", strings.Repeat("ñ", 100000))
	if large == nil || large.Title != strings.Repeat("界", 256) || large.Description != strings.Repeat("ñ", 1024) {
		t.Fatal("large UTF8 provider metadata was not copied within bounds")
	}
	tooLong := link + strings.Repeat("x", 4096)
	if ReceivedMessageLinkPreview(tooLong, tooLong, "", "") != nil {
		t.Fatal("oversized URL accepted")
	}
	raw, _ := json.Marshal(&Message{})
	var data map[string]any
	_ = json.Unmarshal(raw, &data)
	if value, ok := data["link_preview"]; !ok || value != nil {
		t.Fatal("canonical no-preview must be explicit null")
	}
	if value, ok := data["link_preview_version"]; !ok || value != float64(0) {
		t.Fatal("canonical preview version must be explicit zero")
	}
	url := "/api/media/file/synthetic"
	preview.ThumbnailURL = &url
	copy := CloneMessageLinkPreview(preview)
	*copy.ThumbnailURL = "changed"
	if *preview.ThumbnailURL != url {
		t.Fatal("projection aliases thumbnail pointer")
	}
}
