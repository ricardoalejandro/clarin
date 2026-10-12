package api

import (
	"github.com/gofiber/fiber/v2"
	"github.com/naperu/clarin/internal/repository"
	"net/http/httptest"
	"testing"
)

func TestWhatsAppCoveragePolicyConflictReturnsRetryableConflict(t *testing.T) {
	app := fiber.New()
	app.Get("/report", func(c *fiber.Ctx) error { return writeWhatsAppReportError(c, repository.ErrLeadPolicyConflict) })
	res, err := app.Test(httptest.NewRequest("GET", "/report", nil))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != fiber.StatusConflict {
		t.Fatalf("status=%d", res.StatusCode)
	}
}
