package api

import (
	"errors"

	"github.com/gofiber/fiber/v2"
	"github.com/naperu/clarin/internal/whatsapp"
)

func audioSendError(err error) (int, string, string, bool) {
	var audioError *whatsapp.AudioPreparationError
	if !errors.As(err, &audioError) {
		return 0, "", "", false
	}
	status := fiber.StatusUnprocessableEntity
	if audioError.Code == "audio_processor_unavailable" || audioError.Code == "audio_preparation_timeout" {
		status = fiber.StatusServiceUnavailable
	}
	return status, audioError.Code, audioError.Error(), true
}
func writeAudioSendError(c *fiber.Ctx, err error) error {
	status, code, message, _ := audioSendError(err)
	return c.Status(status).JSON(fiber.Map{"success": false, "code": code, "error": message})
}
