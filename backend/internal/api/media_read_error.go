package api

import "github.com/gofiber/fiber/v2"

// Absence is a confirmed provider result. A timeout or provider outage must not
// tell the UI that the user lost access or that the stored file disappeared.
func storageObjectReadError(c *fiber.Ctx, err error) error {
	if storageSelfServiceObjectMissing(err) {
		return storageSelfServiceError(c, 404, "storage_not_found", "Archivo no disponible.")
	}
	return storageSelfServiceError(c, 503, "storage_unavailable", "No se pudo leer el archivo. Inténtalo de nuevo.")
}
