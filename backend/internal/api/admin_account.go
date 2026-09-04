package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"log"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
	"github.com/naperu/clarin/pkg/database"
)

type optionalNullableInt struct {
	Set   bool
	Value *int
}

func (value *optionalNullableInt) UnmarshalJSON(data []byte) error {
	value.Set = true
	data = bytes.TrimSpace(data)
	if bytes.Equal(data, []byte("null")) {
		value.Value = nil
		return nil
	}
	var parsed int
	if err := json.Unmarshal(data, &parsed); err != nil {
		return err
	}
	value.Value = &parsed
	return nil
}

type adminAccountMutationRequest struct {
	Name               *string             `json:"name"`
	Slug               *string             `json:"slug"`
	Plan               *string             `json:"plan"`
	MaxDevices         *int                `json:"max_devices"`
	MaxUsersOverride   optionalNullableInt `json:"max_users_override"`
	StorageLimitBytes  *int64              `json:"storage_limit_bytes"`
	KommoEnabled       *bool               `json:"kommo_enabled"`
	SubscriptionStatus *string             `json:"subscription_status"`
	TrialEndsAt        *string             `json:"trial_ends_at"`
	CurrentPeriodEnd   *string             `json:"current_period_end"`
}

type adminAccountInputError struct {
	Code    string
	Field   string
	Message string
}

func (request adminAccountMutationRequest) updateMask() repository.AdminAccountUpdateMask {
	return repository.AdminAccountUpdateMask{
		Name:               request.Name != nil,
		Slug:               request.Slug != nil,
		Plan:               request.Plan != nil,
		MaxDevices:         request.MaxDevices != nil,
		MaxUsersOverride:   request.MaxUsersOverride.Set,
		StorageLimitBytes:  request.StorageLimitBytes != nil,
		KommoEnabled:       request.KommoEnabled != nil,
		SubscriptionStatus: request.SubscriptionStatus != nil,
		TrialEndsAt:        request.TrialEndsAt != nil,
		CurrentPeriodEnd:   request.CurrentPeriodEnd != nil,
	}
}

func (request adminAccountMutationRequest) account(existing *domain.Account) (*domain.Account, *adminAccountInputError) {
	creating := existing == nil
	account := &domain.Account{
		Plan:               "basic",
		MaxDevices:         5,
		IsActive:           true,
		SubscriptionStatus: domain.SubscriptionStatusActive,
	}
	if existing != nil {
		copy := *existing
		account = &copy
	}
	if request.Name != nil {
		account.Name = *request.Name
	}
	if request.Slug != nil {
		account.Slug = *request.Slug
	}
	if request.Plan != nil {
		account.Plan = *request.Plan
	}
	if request.MaxDevices != nil {
		account.MaxDevices = *request.MaxDevices
	}
	if creating && account.MaxDevices <= 0 {
		account.MaxDevices = 5
	}
	if request.MaxUsersOverride.Set {
		account.MaxUsersOverride = request.MaxUsersOverride.Value
	}
	if account.MaxUsersOverride != nil && *account.MaxUsersOverride < 0 {
		return nil, &adminAccountInputError{
			Code: "invalid_max_users_override", Field: "max_users_override",
			Message: "El límite de usuarios debe ser cero o mayor.",
		}
	}
	if request.StorageLimitBytes != nil {
		account.StorageLimitBytes = *request.StorageLimitBytes
	}
	if request.KommoEnabled != nil {
		account.KommoEnabled = *request.KommoEnabled
	}
	if request.SubscriptionStatus != nil {
		account.SubscriptionStatus = *request.SubscriptionStatus
	}
	if request.TrialEndsAt != nil {
		parsed, err := parseSubscriptionTime(*request.TrialEndsAt)
		if err != nil {
			return nil, &adminAccountInputError{
				Code: "invalid_trial_ends_at", Field: "trial_ends_at",
				Message: "La fecha de fin de prueba no es válida.",
			}
		}
		account.TrialEndsAt = parsed
	}
	if request.CurrentPeriodEnd != nil {
		parsed, err := parseSubscriptionTime(*request.CurrentPeriodEnd)
		if err != nil {
			return nil, &adminAccountInputError{
				Code: "invalid_current_period_end", Field: "current_period_end",
				Message: "La fecha de fin del periodo no es válida.",
			}
		}
		account.CurrentPeriodEnd = parsed
	}
	if creating && request.CurrentPeriodEnd == nil {
		status := strings.TrimSpace(account.SubscriptionStatus)
		if status == "" || status == domain.SubscriptionStatusActive {
			periodEnd := time.Now().UTC().AddDate(1, 0, 0)
			account.CurrentPeriodEnd = &periodEnd
		}
	}
	return account, nil
}

type adminAccountTemplateSeeder func(*pgxpool.Pool, string) error

func seedAdminAccountTemplatesAsync(db *pgxpool.Pool, accountID uuid.UUID) {
	seedAdminAccountTemplatesAsyncWith(db, accountID, database.SeedTemplateSurveysForAccount)
}

func seedAdminAccountTemplatesAsyncWith(db *pgxpool.Pool, accountID uuid.UUID, seed adminAccountTemplateSeeder) {
	if db == nil || accountID == uuid.Nil || seed == nil {
		return
	}
	go func(databasePool *pgxpool.Pool, id uuid.UUID, seeder adminAccountTemplateSeeder) {
		defer func() {
			if recovered := recover(); recovered != nil {
				log.Printf("[AdminAccounts] template seed panicked: account_id=%s panic_type=%T", id, recovered)
			}
		}()
		if err := seeder(databasePool, id.String()); err != nil {
			log.Printf("[AdminAccounts] template seed failed: account_id=%s error_type=%T", id, err)
		}
	}(db, accountID, seed)
}

func writeAdminAccountInputError(c *fiber.Ctx, inputErr *adminAccountInputError) error {
	return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
		"success": false,
		"code":    inputErr.Code,
		"field":   inputErr.Field,
		"error":   inputErr.Message,
	})
}

func writeAdminAccountMutationError(c *fiber.Ctx, err error) error {
	switch {
	case errors.Is(err, service.ErrAdminAccountNameRequired):
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success": false, "code": "account_name_required", "field": "name",
			"error": "Ingresa el nombre de la cuenta.",
		})
	case errors.Is(err, service.ErrSubscriptionPlanInvalid):
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success": false, "code": "invalid_plan", "field": "plan",
			"error": "El plan seleccionado no existe.",
		})
	case errors.Is(err, service.ErrSubscriptionStatusInvalid):
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success": false, "code": "invalid_subscription_status", "field": "subscription_status",
			"error": "El estado de suscripción no es válido.",
		})
	case errors.Is(err, pgx.ErrNoRows):
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{
			"success": false, "code": "account_not_found", "error": "La cuenta ya no existe.",
		})
	default:
		log.Printf("[AdminAccounts] write failed: error_type=%T", err)
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"success": false, "code": "account_save_failed",
			"error": "No se pudo guardar la cuenta. Inténtalo nuevamente.",
		})
	}
}
