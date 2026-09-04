package database

import (
	"context"
	"errors"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
)

func TestAdminAccountPasswordAndRoleIntegrity(t *testing.T) {
	if os.Getenv("CLARIN_RUN_ADMIN_ACCOUNT_INTEGRATION") != "1" {
		t.Skip("set CLARIN_RUN_ADMIN_ACCOUNT_INTEGRATION=1 in an isolated PostgreSQL environment")
	}
	rawURL := os.Getenv("DATABASE_URL")
	if rawURL == "" {
		t.Fatal("DATABASE_URL is required")
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	const databaseName = "clarin_admin_account_integrity_test"
	adminURL, testURL := *parsed, *parsed
	adminURL.Path = "/postgres"
	testURL.Path = "/" + databaseName
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, adminURL.String())
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	_, _ = admin.Exec(ctx, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, databaseName)
	_, _ = admin.Exec(ctx, `DROP DATABASE IF EXISTS `+databaseName)
	if _, err := admin.Exec(ctx, `CREATE DATABASE `+databaseName); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_, _ = admin.Exec(ctx, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, databaseName)
		_, _ = admin.Exec(ctx, `DROP DATABASE IF EXISTS `+databaseName)
	}()

	db, err := pgxpool.New(ctx, testURL.String())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := Migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	repos := repository.NewRepositories(db)
	services := service.NewServices(repos, nil, nil)

	invalidPlan := &domain.Account{
		Name: "Invalid Plan", Plan: "missing-plan", MaxDevices: 5, IsActive: true,
		SubscriptionStatus: domain.SubscriptionStatusActive,
	}
	if err := services.Account.CreateWithSubscription(ctx, invalidPlan); !errors.Is(err, service.ErrSubscriptionPlanInvalid) {
		t.Fatalf("unknown plan error=%v, want ErrSubscriptionPlanInvalid", err)
	}
	invalidStatus := &domain.Account{
		Name: "Invalid Status", Plan: "basic", MaxDevices: 5, IsActive: true,
		SubscriptionStatus: "unknown",
	}
	if err := services.Account.CreateWithSubscription(ctx, invalidStatus); !errors.Is(err, service.ErrSubscriptionStatusInvalid) {
		t.Fatalf("unknown status error=%v, want ErrSubscriptionStatusInvalid", err)
	}
	var invalidPreflightCount int
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM accounts WHERE name IN ('Invalid Plan','Invalid Status')`).Scan(&invalidPreflightCount); err != nil || invalidPreflightCount != 0 {
		t.Fatalf("preflight validation wrote accounts: count=%d err=%v", invalidPreflightCount, err)
	}

	failed := &domain.Account{
		Name: "Must Roll Back", Plan: "missing-plan", MaxDevices: 5, IsActive: true,
		SubscriptionStatus: domain.SubscriptionStatusActive,
	}
	if err := repos.Account.CreateWithSubscription(ctx, failed); err == nil {
		t.Fatal("account creation with an invalid subscription unexpectedly succeeded")
	}
	var failedCount int
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM accounts WHERE name='Must Roll Back'`).Scan(&failedCount); err != nil || failedCount != 0 {
		t.Fatalf("partial account survived subscription failure: count=%d err=%v", failedCount, err)
	}

	trialEnd := time.Date(2026, time.September, 15, 23, 59, 59, 0, time.UTC)
	periodEnd := time.Date(2026, time.October, 1, 23, 59, 59, 0, time.UTC)
	account := &domain.Account{
		Name: "Atomic Account", Slug: "atomic", Plan: "basic", MaxDevices: 5,
		StorageLimitBytes: 1024, IsActive: true, KommoEnabled: true,
		SubscriptionStatus: domain.SubscriptionStatusTrialing,
		TrialEndsAt:        &trialEnd,
		CurrentPeriodEnd:   &periodEnd,
	}
	if err := repos.Account.CreateWithSubscription(ctx, account); err != nil {
		t.Fatalf("create account: %v", err)
	}
	if _, err := db.Exec(ctx, `UPDATE subscriptions SET metadata='{"keep":"yes"}'::jsonb,billing_provider='manual' WHERE account_id=$1`, account.ID); err != nil {
		t.Fatal(err)
	}

	invalidUpdate := *account
	invalidUpdate.Name = "Must Not Commit"
	invalidUpdate.Plan = "missing-plan"
	if err := repos.Account.UpdateWithSubscription(ctx, &invalidUpdate, repository.AdminAccountUpdateMask{Name: true, Plan: true}); err == nil {
		t.Fatal("account update with an invalid subscription unexpectedly succeeded")
	}
	var nameAfterFailure string
	if err := db.QueryRow(ctx, `SELECT name FROM accounts WHERE id=$1`, account.ID).Scan(&nameAfterFailure); err != nil || nameAfterFailure != "Atomic Account" {
		t.Fatalf("account update was not rolled back: name=%q err=%v", nameAfterFailure, err)
	}

	validUpdate := *account
	validUpdate.Name = "Updated Atomically"
	validUpdate.Plan = "pro"
	validUpdate.CurrentPeriodEnd = nil
	if err := repos.Account.UpdateWithSubscription(ctx, &validUpdate, repository.AdminAccountUpdateMask{
		Name: true, Plan: true, CurrentPeriodEnd: true,
	}); err != nil {
		t.Fatalf("valid account update: %v", err)
	}
	var savedName, accountPlan, subscriptionPlan, savedStatus, metadataKeep, billingProvider string
	var kommoEnabled bool
	var savedTrialEnd, savedPeriodEnd *time.Time
	if err := db.QueryRow(ctx, `
		SELECT a.name,a.plan,a.kommo_enabled,s.plan_code,s.status,s.trial_ends_at,
			s.current_period_end,s.metadata->>'keep',s.billing_provider
		FROM accounts a JOIN subscriptions s ON s.account_id=a.id WHERE a.id=$1
	`, account.ID).Scan(&savedName, &accountPlan, &kommoEnabled, &subscriptionPlan, &savedStatus,
		&savedTrialEnd, &savedPeriodEnd, &metadataKeep, &billingProvider); err != nil {
		t.Fatal(err)
	}
	if savedName != "Updated Atomically" || accountPlan != "pro" || subscriptionPlan != "pro" ||
		savedStatus != domain.SubscriptionStatusTrialing || savedTrialEnd == nil || !savedTrialEnd.Equal(trialEnd) ||
		savedPeriodEnd != nil || !kommoEnabled || metadataKeep != "yes" || billingProvider != "manual" {
		t.Fatalf("combined update lost canonical state: name=%q account_plan=%q subscription_plan=%q status=%q trial_end=%v period_end=%v kommo=%v metadata=%q billing=%q",
			savedName, accountPlan, subscriptionPlan, savedStatus, savedTrialEnd, savedPeriodEnd,
			kommoEnabled, metadataKeep, billingProvider)
	}

	// A historical compatibility-mirror mismatch must resolve toward the locked
	// canonical subscription plan when a partial update omits plan.
	mirrorAccount := &domain.Account{
		Name: "Divergent Plan Mirror", Slug: "divergent-plan-mirror", Plan: "basic", MaxDevices: 5,
		IsActive: true, SubscriptionStatus: domain.SubscriptionStatusActive,
	}
	if err := repos.Account.CreateWithSubscription(ctx, mirrorAccount); err != nil {
		t.Fatalf("create divergent mirror account: %v", err)
	}
	if _, err := db.Exec(ctx, `UPDATE subscriptions SET plan_code='pro' WHERE account_id=$1`, mirrorAccount.ID); err != nil {
		t.Fatalf("prepare divergent mirror: %v", err)
	}
	partialUpdate := &domain.Account{ID: mirrorAccount.ID, Name: "Divergent Mirror Updated"}
	if err := repos.Account.UpdateWithSubscription(ctx, partialUpdate, repository.AdminAccountUpdateMask{Name: true}); err != nil {
		t.Fatalf("partial divergent mirror update: %v", err)
	}
	var preservedAccountPlan, preservedSubscriptionPlan string
	if err := db.QueryRow(ctx, `
		SELECT a.plan,s.plan_code
		FROM accounts a JOIN subscriptions s ON s.account_id=a.id
		WHERE a.id=$1
	`, mirrorAccount.ID).Scan(&preservedAccountPlan, &preservedSubscriptionPlan); err != nil {
		t.Fatal(err)
	}
	if preservedAccountPlan != "pro" || preservedSubscriptionPlan != "pro" {
		t.Fatalf("omitted plan did not preserve canonical subscription: account_plan=%q subscription_plan=%q",
			preservedAccountPlan, preservedSubscriptionPlan)
	}

	if err := repos.User.UpdatePassword(ctx, uuid.New(), "new-hash"); !errors.Is(err, repository.ErrUserNotFound) {
		t.Fatalf("missing user password update error=%v, want ErrUserNotFound", err)
	}
	userID := uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO users(id,account_id,username,email,password_hash) VALUES($1,$2,$3,$4,'old-hash')`,
		userID, account.ID, "admin-integrity-"+userID.String(), userID.String()+"@test.invalid"); err != nil {
		t.Fatal(err)
	}
	if err := repos.User.UpdatePassword(ctx, userID, "new-hash"); err != nil {
		t.Fatalf("update existing password: %v", err)
	}
	var passwordHash string
	if err := db.QueryRow(ctx, `SELECT password_hash FROM users WHERE id=$1`, userID).Scan(&passwordHash); err != nil || passwordHash != "new-hash" {
		t.Fatalf("password hash=%q err=%v", passwordHash, err)
	}

	if _, err := db.Exec(ctx, `INSERT INTO roles(name,description,is_system,permissions) VALUES(' Coordinador ','',FALSE,'{}')`); err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(ctx, `INSERT INTO roles(name,description,is_system,permissions) VALUES('coordinador','',FALSE,'{}')`)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23505" || pgErr.ConstraintName != "uq_roles_name_normalized" {
		t.Fatalf("normalized role duplicate error=%v, want uq_roles_name_normalized", err)
	}
}
