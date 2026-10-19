package domain

import (
	"net/url"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// MessageLinkPreview contains only provider-supplied display data. URLs are
// never fetched to create it. A thumbnail is an account-owned local asset.
type MessageLinkPreview struct {
	URL          string  `json:"url"`
	Title        string  `json:"title"`
	Description  string  `json:"description"`
	ThumbnailURL *string `json:"thumbnail_url"`
}

var messageHTTPURL = regexp.MustCompile("(?i)(?:https?://|www\\.)[^\\s<>\"'`]+")

func normalizedPreviewURL(raw string) string {
	if strings.HasPrefix(strings.ToLower(raw), "www.") {
		raw = "https://" + raw
	}
	if strings.Contains(raw, "\\") {
		return ""
	}
	if raw == "" || utf8.RuneCountInString(raw) > 4096 || strings.IndexFunc(raw, func(r rune) bool { return unicode.IsControl(r) || unicode.IsSpace(r) }) >= 0 {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Hostname() == "" || (strings.ToLower(u.Scheme) != "http" && strings.ToLower(u.Scheme) != "https") || u.Opaque != "" {
		return ""
	}
	decoded, err := url.PathUnescape(raw)
	if err != nil || strings.Contains(decoded, "\\") || strings.IndexFunc(decoded, unicode.IsControl) >= 0 {
		return ""
	}
	u.Scheme, u.Host = strings.ToLower(u.Scheme), strings.ToLower(u.Host)
	if u.Path == "" {
		u.Path = "/"
	}
	if (u.Scheme == "https" && u.Port() == "443") || (u.Scheme == "http" && u.Port() == "80") {
		u.Host = u.Hostname()
		if strings.Contains(u.Host, ":") {
			u.Host = "[" + u.Host + "]"
		}
	}
	return u.String()
}

func trimPreviewBodyURL(raw string) string {
	raw = strings.TrimRight(raw, ".,!?;:")
	for _, pair := range [][2]string{{"(", ")"}, {"[", "]"}, {"{", "}"}} {
		for strings.HasSuffix(raw, pair[1]) && strings.Count(raw, pair[1]) > strings.Count(raw, pair[0]) {
			raw = strings.TrimSuffix(raw, pair[1])
		}
	}
	return raw
}

func previewBodyURL(body string, start, end int) string {
	candidate := trimPreviewBodyURL(body[start:end])
	// Remove formatting only when the exact opening marker sequence directly
	// surrounds this URL. Underscores/stars belonging to a bare URL stay intact.
	opening := start
	for opening > 0 && start-opening < 6 && strings.ContainsRune("*_~", rune(body[opening-1])) {
		opening--
	}
	if opening < start {
		markers := body[opening:start]
		closing := make([]byte, len(markers))
		for i := range markers {
			closing[len(markers)-1-i] = markers[i]
		}
		if strings.HasSuffix(candidate, string(closing)) {
			candidate = strings.TrimSuffix(candidate, string(closing))
		}
	}
	return normalizedPreviewURL(candidate)
}

func previewText(raw string, max int) string {
	var out strings.Builder
	count := 0
	for _, r := range strings.TrimSpace(raw) {
		if count >= max {
			break
		}
		out.WriteRune(r)
		count++
	}
	return out.String()
}

// ReceivedMessageLinkPreview rejects misleading metadata for a different URL.
// Missing/invalid metadata leaves the original message completely untouched.
func ReceivedMessageLinkPreview(body, matched, title, description string) *MessageLinkPreview {
	target := normalizedPreviewURL(strings.TrimSpace(matched))
	if target == "" {
		return nil
	}
	found := false
	for _, candidate := range messageHTTPURL.FindAllStringIndex(body, -1) {
		if previewBodyURL(body, candidate[0], candidate[1]) == target {
			found = true
			break
		}
	}
	if !found {
		return nil
	}
	return &MessageLinkPreview{URL: target, Title: previewText(title, 256), Description: previewText(description, 1024)}
}

func CloneMessageLinkPreview(value *MessageLinkPreview) *MessageLinkPreview {
	if value == nil {
		return nil
	}
	copy := *value
	if value.ThumbnailURL != nil {
		thumbnail := *value.ThumbnailURL
		copy.ThumbnailURL = &thumbnail
	}
	return &copy
}
