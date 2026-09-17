package api

import (
	"encoding/json"
	"errors"
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
)

func TestWriteAttendanceBatchErrorReturnsTypedConflict(t *testing.T) {
	participantID := uuid.New()
	app := fiber.New()
	app.Get("/", func(c *fiber.Ctx) error {
		return writeAttendanceBatchError(c, &repository.ProgramAttendanceConflictError{
			Conflicts: []domain.ProgramAttendanceStatusConflict{{
				ParticipantID: participantID,
				CurrentStatus: domain.AttendanceStatusConfirmed,
			}},
		})
	})

	response, err := app.Test(httptest.NewRequest(fiber.MethodGet, "/", nil))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != fiber.StatusConflict {
		t.Fatalf("status = %d, want %d", response.StatusCode, fiber.StatusConflict)
	}
	var payload struct {
		Success   bool                                     `json:"success"`
		Code      string                                   `json:"code"`
		Error     string                                   `json:"error"`
		Message   string                                   `json:"message"`
		Conflicts []domain.ProgramAttendanceStatusConflict `json:"conflicts"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload.Success || payload.Code != "attendance_conflict" || payload.Error == "" || payload.Message != payload.Error || len(payload.Conflicts) != 1 {
		t.Fatalf("unexpected payload: %#v", payload)
	}
	if payload.Conflicts[0].ParticipantID != participantID || payload.Conflicts[0].CurrentStatus != domain.AttendanceStatusConfirmed {
		t.Fatalf("unexpected conflict: %#v", payload.Conflicts[0])
	}
}

func TestWriteAttendanceBatchErrorKeepsValidationAtBadRequest(t *testing.T) {
	app := fiber.New()
	app.Get("/", func(c *fiber.Ctx) error {
		return writeAttendanceBatchError(c, errors.New("invalid attendance status"))
	})
	response, err := app.Test(httptest.NewRequest(fiber.MethodGet, "/", nil))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != fiber.StatusBadRequest {
		t.Fatalf("status = %d, want %d", response.StatusCode, fiber.StatusBadRequest)
	}
}
