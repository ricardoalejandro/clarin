package api

import (
	"errors"
	"log"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

// Never include raw SQL, provider errors, uploaded bytes or identity values in
// diagnostics. A generated request reference links the UI with a safe SQLSTATE.
func contactFailure(c *fiber.Ctx, operation, message string, err error) error {
	requestID := uuid.NewString()
	sqlState := ""
	var databaseError *pgconn.PgError
	if errors.As(err, &databaseError) {
		sqlState = databaseError.Code
	}
	log.Printf("contact operation=%s request_id=%s account=%v error_type=%T sqlstate=%s", operation, requestID, c.Locals("account_id"), err, sqlState)
	c.Set("X-Request-ID", requestID)
	return c.Status(500).JSON(fiber.Map{"success": false, "error": message + ". Vuelve a intentarlo (referencia " + requestID + ")", "request_id": requestID, "code": "contact_operation_failed", "retryable": true})
}
