package api

import (
	"strings"

	"github.com/gofiber/fiber/v2"
)

// This application guard bounds parsing, decompression and downstream work.
// The ingress must additionally enforce its 2 MiB bound before fasthttp buffers
// a request: the global 52 MiB allowance remains necessary for other uploads.
func offlineV4RequestLimit(path string) int {
	path = strings.ToLower(strings.TrimRight(path, "/"))
	apiPrefix, adminPrefix := "/api/offline/v4", "/api/admin/offline-v4"
	if path == "/api/offline/v5" || strings.HasPrefix(path, "/api/offline/v5/") || path == "/api/admin/offline-v5" || strings.HasPrefix(path, "/api/admin/offline-v5/") {
		apiPrefix, adminPrefix = "/api/offline/v5", "/api/admin/offline-v5"
	}
	if path != apiPrefix && !strings.HasPrefix(path, apiPrefix+"/") && path != adminPrefix && !strings.HasPrefix(path, adminPrefix+"/") {
		return 0
	}
	if path == apiPrefix+"/sync" {
		return 2 << 20
	}
	if path == apiPrefix+"/enrollment/requests" || strings.HasPrefix(path, apiPrefix+"/grants/") && strings.HasSuffix(path, "/keys") {
		return 16 << 10
	}
	if strings.HasPrefix(path, apiPrefix+"/grants/") && strings.HasSuffix(path, "/selection") || strings.HasPrefix(path, adminPrefix+"/enrollment-requests/") && strings.HasSuffix(path, "/approve") {
		return 32 << 10
	}
	return 4 << 10
}

func guardOfflineV4Request(c *fiber.Ctx) error {
	limit := offlineV4RequestLimit(c.Path())
	if limit == 0 {
		return c.Next()
	}
	c.Set("X-Clarin-Response", "1")
	protocol := "4"
	if strings.HasPrefix(strings.ToLower(c.Path()), "/api/offline/v5") || strings.HasPrefix(strings.ToLower(c.Path()), "/api/admin/offline-v5") {
		protocol = "5"
	}
	c.Set("X-Clarin-Offline-Protocol", protocol)
	c.Set("Cache-Control", "no-store, private")
	// c.Body() transparently decompresses gzip/deflate/br. Reject every encoded
	// representation before even consulting BodyRaw so compressed input cannot
	// evade the wire-size budget and allocate its expanded form.
	encoded := false
	c.Request().Header.VisitAll(func(key, value []byte) {
		// Inspect every occurrence: selecting only the first duplicate header
		// must not differ from the decoder's interpretation of a later value.
		if strings.EqualFold(string(key), fiber.HeaderContentEncoding) && strings.TrimSpace(string(value)) != "" {
			encoded = true
		}
	})
	if encoded {
		return c.Status(fiber.StatusUnsupportedMediaType).JSON(fiber.Map{
			"error": "offline_content_encoding_unsupported", "message": "La compresión del cuerpo no está permitida para solicitudes offline.",
		})
	}
	if c.Request().Header.ContentLength() > limit || len(c.BodyRaw()) > limit {
		return c.Status(fiber.StatusRequestEntityTooLarge).JSON(fiber.Map{
			"error": "offline_payload_too_large", "message": "La solicitud offline supera el tamaño permitido.", "max_bytes": limit,
		})
	}
	return c.Next()
}
