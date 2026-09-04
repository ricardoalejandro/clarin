package api

import (
	"encoding/json"
	"errors"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/service"
)

func TestAdminAccountRequestPreservesOmittedSensitiveFields(t *testing.T) {
	t.Parallel()
	trialEnd := time.Date(2026, time.September, 1, 23, 59, 59, 0, time.UTC)
	periodEnd := time.Date(2027, time.January, 1, 23, 59, 59, 0, time.UTC)
	existing := &domain.Account{
		Name: "Anterior", Plan: "pro", MaxDevices: 8, KommoEnabled: true,
		SubscriptionStatus: domain.SubscriptionStatusTrialing,
		TrialEndsAt:        &trialEnd, CurrentPeriodEnd: &periodEnd,
	}
	name := "  Nueva cuenta  "
	request := adminAccountMutationRequest{Name: &name}
	account, inputErr := request.account(existing)
	if inputErr != nil {
		t.Fatal(inputErr.Message)
	}
	if !account.KommoEnabled || account.Plan != "pro" || account.SubscriptionStatus != domain.SubscriptionStatusTrialing {
		t.Fatalf("omitted managed state was overwritten: %#v", account)
	}
	if account.TrialEndsAt != &trialEnd || account.CurrentPeriodEnd != &periodEnd {
		t.Fatalf("omitted subscription dates were not preserved: %#v", account)
	}
}

func TestAdminAccountRequestCreateDefaultsActiveSubscription(t *testing.T) {
	t.Parallel()
	name := "Cuenta nueva"
	account, inputErr := (adminAccountMutationRequest{Name: &name}).account(nil)
	if inputErr != nil {
		t.Fatal(inputErr.Message)
	}
	if account.SubscriptionStatus != domain.SubscriptionStatusActive {
		t.Fatalf("subscription status = %q, want %q", account.SubscriptionStatus, domain.SubscriptionStatusActive)
	}
	if account.Plan != "basic" {
		t.Fatalf("plan = %q, want basic", account.Plan)
	}
}

func TestAdminAccountRequestEmptyDateClearsAndNullableLimitIsExplicit(t *testing.T) {
	t.Parallel()
	raw := []byte(`{"max_users_override":null,"trial_ends_at":"","current_period_end":""}`)
	var request adminAccountMutationRequest
	if err := json.Unmarshal(raw, &request); err != nil {
		t.Fatal(err)
	}
	oldDate := time.Now()
	limit := 12
	account, inputErr := request.account(&domain.Account{
		Name: "Cuenta", Plan: "basic", MaxDevices: 5, MaxUsersOverride: &limit,
		SubscriptionStatus: domain.SubscriptionStatusActive,
		TrialEndsAt:        &oldDate, CurrentPeriodEnd: &oldDate,
	})
	if inputErr != nil {
		t.Fatal(inputErr.Message)
	}
	if account.MaxUsersOverride != nil || account.TrialEndsAt != nil || account.CurrentPeriodEnd != nil {
		t.Fatalf("explicit clears were not retained: %#v", account)
	}
}

func TestAdminAccountRequestRejectsInvalidDates(t *testing.T) {
	t.Parallel()
	invalid := "tomorrow"
	_, inputErr := (adminAccountMutationRequest{TrialEndsAt: &invalid}).account(nil)
	if inputErr == nil || inputErr.Code != "invalid_trial_ends_at" || inputErr.Field != "trial_ends_at" {
		t.Fatalf("unexpected input error: %#v", inputErr)
	}
}

func TestAdminAccountUpdateMaskDistinguishesOmittedFromExplicitClear(t *testing.T) {
	t.Parallel()
	empty := ""
	request := adminAccountMutationRequest{TrialEndsAt: &empty}
	mask := request.updateMask()
	if !mask.TrialEndsAt || mask.CurrentPeriodEnd || mask.KommoEnabled || mask.MaxUsersOverride {
		t.Fatalf("unexpected update mask: %#v", mask)
	}
}

func TestAdminAccountTemplateSeedRunsAfterResponsePath(t *testing.T) {
	t.Parallel()
	started := make(chan string, 1)
	release := make(chan struct{})
	accountID := uuid.New()
	seedAdminAccountTemplatesAsyncWith(new(pgxpool.Pool), accountID, func(_ *pgxpool.Pool, id string) error {
		started <- id
		<-release
		return nil
	})
	select {
	case id := <-started:
		if id != accountID.String() {
			t.Fatalf("seed account id = %q, want %q", id, accountID)
		}
	case <-time.After(time.Second):
		t.Fatal("asynchronous template seed did not start")
	}
	close(release)
}

func TestWriteAdminAccountMutationErrorReturnsStableSafeCodes(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		err    error
		status int
		code   string
		field  string
	}{
		{name: "name", err: service.ErrAdminAccountNameRequired, status: fiber.StatusBadRequest, code: "account_name_required", field: "name"},
		{name: "plan", err: service.ErrSubscriptionPlanInvalid, status: fiber.StatusBadRequest, code: "invalid_plan", field: "plan"},
		{name: "status", err: service.ErrSubscriptionStatusInvalid, status: fiber.StatusBadRequest, code: "invalid_subscription_status", field: "subscription_status"},
		{name: "missing", err: pgx.ErrNoRows, status: fiber.StatusNotFound, code: "account_not_found"},
		{name: "unexpected", err: errors.New("raw database detail"), status: fiber.StatusInternalServerError, code: "account_save_failed"},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			app := fiber.New()
			app.Get("/", func(c *fiber.Ctx) error { return writeAdminAccountMutationError(c, test.err) })
			response, err := app.Test(httptest.NewRequest("GET", "/", nil))
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			var body map[string]any
			if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if response.StatusCode != test.status || body["code"] != test.code || body["error"] == test.err.Error() {
				t.Fatalf("status=%d body=%#v", response.StatusCode, body)
			}
			if test.field != "" && body["field"] != test.field {
				t.Fatalf("field=%#v, want %q", body["field"], test.field)
			}
		})
	}
}
