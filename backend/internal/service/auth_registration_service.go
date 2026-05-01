package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/naperu/clarin/internal/domain"
	"golang.org/x/crypto/bcrypt"
)

type RegisterAccountInput struct {
	AccountName string
	DisplayName string
	Email       string
	Password    string
	PlanCode    string
}

type RegisterAccountResult struct {
	Account      *domain.Account
	User         *domain.User
	Subscription *domain.Subscription
}

var signupSlugPattern = regexp.MustCompile(`[^a-z0-9]+`)

func (s *AuthService) RegisterAccount(ctx context.Context, input RegisterAccountInput) (*RegisterAccountResult, error) {
	accountName := strings.TrimSpace(input.AccountName)
	displayName := strings.TrimSpace(input.DisplayName)
	email := strings.ToLower(strings.TrimSpace(input.Email))
	planCode := strings.TrimSpace(input.PlanCode)

	if accountName == "" {
		return nil, fmt.Errorf("el nombre de la empresa es obligatorio")
	}
	if displayName == "" {
		displayName = accountName
	}
	if email == "" || !strings.Contains(email, "@") {
		return nil, fmt.Errorf("ingresa un correo válido")
	}
	if len(input.Password) < 8 {
		return nil, fmt.Errorf("la contraseña debe tener al menos 8 caracteres")
	}
	if planCode == "" {
		planCode = "starter"
	}

	plan, err := s.repos.Subscription.GetPlan(ctx, planCode)
	if err != nil {
		return nil, err
	}
	if plan == nil || !plan.IsPublic || !isSelfServicePlan(plan.Code) {
		return nil, fmt.Errorf("plan no disponible para registro automático")
	}
	trialDays := plan.TrialDays
	if trialDays <= 0 {
		trialDays = 14
	}

	passwordHash, err := bcrypt.GenerateFromPassword([]byte(input.Password), bcrypt.DefaultCost)
	if err != nil {
		return nil, fmt.Errorf("failed to hash password: %w", err)
	}

	now := time.Now()
	trialEnd := now.AddDate(0, 0, trialDays)
	account := &domain.Account{
		ID:         uuid.New(),
		Name:       accountName,
		Slug:       signupSlug(accountName),
		Plan:       plan.Code,
		MaxDevices: signupPlanInt(plan, "max_devices", 2),
		IsActive:   true,
	}
	user := &domain.User{
		ID:           uuid.New(),
		AccountID:    account.ID,
		Username:     email,
		Email:        email,
		PasswordHash: string(passwordHash),
		DisplayName:  displayName,
		Role:         domain.RoleAdmin,
		IsAdmin:      true,
		IsSuperAdmin: false,
		IsActive:     true,
	}
	subscription := &domain.Subscription{
		ID:                 uuid.New(),
		AccountID:          account.ID,
		PlanCode:           plan.Code,
		Status:             domain.SubscriptionStatusTrialing,
		TrialStartedAt:     &now,
		TrialEndsAt:        &trialEnd,
		CurrentPeriodStart: &now,
		Metadata:           json.RawMessage(`{"source":"public_signup"}`),
	}

	databaseTx, err := s.repos.DB().Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer databaseTx.Rollback(ctx)

	err = databaseTx.QueryRow(ctx, `
		INSERT INTO accounts (id, name, slug, plan, max_devices, is_active)
		VALUES ($1, $2, $3, $4, $5, TRUE)
		RETURNING created_at, updated_at
	`, account.ID, account.Name, account.Slug, account.Plan, account.MaxDevices).Scan(&account.CreatedAt, &account.UpdatedAt)
	if err != nil {
		return nil, registrationError(err)
	}

	err = databaseTx.QueryRow(ctx, `
		INSERT INTO users (id, account_id, username, email, password_hash, display_name, is_admin, is_super_admin, role, is_active)
		VALUES ($1, $2, $3, $4, $5, $6, TRUE, FALSE, $7, TRUE)
		RETURNING created_at, updated_at
	`, user.ID, user.AccountID, user.Username, user.Email, user.PasswordHash, user.DisplayName, user.Role).Scan(&user.CreatedAt, &user.UpdatedAt)
	if err != nil {
		return nil, registrationError(err)
	}

	_, err = databaseTx.Exec(ctx, `
		INSERT INTO user_accounts (user_id, account_id, role, is_default)
		VALUES ($1, $2, $3, TRUE)
	`, user.ID, account.ID, domain.RoleAdmin)
	if err != nil {
		return nil, registrationError(err)
	}

	err = databaseTx.QueryRow(ctx, `
		INSERT INTO subscriptions (id, account_id, plan_code, status, trial_started_at, trial_ends_at, current_period_start, metadata)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
		RETURNING created_at, updated_at
	`, subscription.ID, subscription.AccountID, subscription.PlanCode, subscription.Status, subscription.TrialStartedAt,
		subscription.TrialEndsAt, subscription.CurrentPeriodStart, string(subscription.Metadata)).Scan(&subscription.CreatedAt, &subscription.UpdatedAt)
	if err != nil {
		return nil, registrationError(err)
	}

	if err := databaseTx.Commit(ctx); err != nil {
		return nil, err
	}

	user.AccountName = account.Name
	return &RegisterAccountResult{Account: account, User: user, Subscription: subscription}, nil
}

func isSelfServicePlan(planCode string) bool {
	switch planCode {
	case "trial", "starter", "pro", "business":
		return true
	default:
		return false
	}
}

func signupSlug(value string) string {
	slug := strings.ToLower(strings.TrimSpace(value))
	slug = signupSlugPattern.ReplaceAllString(slug, "-")
	slug = strings.Trim(slug, "-")
	if slug == "" {
		return "cuenta"
	}
	if len(slug) > 60 {
		slug = strings.Trim(slug[:60], "-")
	}
	return fmt.Sprintf("%s-%s", slug, uuid.New().String()[:8])
}

func signupPlanInt(plan *domain.Plan, key string, fallback int) int {
	if plan == nil || plan.Entitlements == nil {
		return fallback
	}
	value, ok := plan.Entitlements[key]
	if !ok {
		return fallback
	}
	var number int
	if err := json.Unmarshal(value, &number); err == nil && number > 0 {
		return number
	}
	return fallback
}

func registrationError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		constraint := strings.ToLower(pgErr.ConstraintName)
		if strings.Contains(constraint, "username") || strings.Contains(constraint, "email") {
			return fmt.Errorf("ya existe un usuario con ese correo")
		}
		return fmt.Errorf("ya existe un registro con esos datos")
	}
	return err
}
