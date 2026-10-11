package api

import (
	"bytes"
	"encoding/json"
	"strings"

	"github.com/gofiber/fiber/v2"
)

// Rewrite whole JSON string values only. This preserves number precision and
// leaves embedded prose/HTML/documents, request bodies and external URLs intact.
func normalizeMediaJSON(body []byte, canonical func(string) string) []byte {
	if !json.Valid(body) {
		return body
	}
	var out bytes.Buffer
	changed := false
	for i := 0; i < len(body); {
		if body[i] != '"' {
			out.WriteByte(body[i])
			i++
			continue
		}
		start := i
		i++
		for i < len(body) {
			if body[i] == '\\' {
				i += 2
				continue
			}
			if body[i] == '"' {
				i++
				break
			}
			i++
		}
		raw := body[start:i]
		var value string
		if json.Unmarshal(raw, &value) == nil {
			// Keys are not media values; skip them even if a user named one like a URL.
			next := i
			for next < len(body) && (body[next] == ' ' || body[next] == '\n' || body[next] == '\r' || body[next] == '\t') {
				next++
			}
			if next == len(body) || body[next] != ':' {
				if normalized := canonical(value); normalized != value {
					encoded, _ := json.Marshal(normalized)
					out.Write(encoded)
					changed = true
					continue
				}
			}
		}
		out.Write(raw)
	}
	if !changed {
		return body
	}
	return out.Bytes()
}

func (s *Server) normalizeMediaResponse(c *fiber.Ctx) error {
	if err := c.Next(); err != nil {
		return err
	}
	if s.storage == nil || !strings.HasPrefix(c.GetRespHeader(fiber.HeaderContentType), fiber.MIMEApplicationJSON) {
		return nil
	}
	body := c.Response().Body()
	normalized := normalizeMediaJSON(body, s.storage.CanonicalMediaURL)
	if !bytes.Equal(body, normalized) {
		c.Response().SetBody(normalized)
	}
	return nil
}
