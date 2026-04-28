package repository

import (
	"context"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
)

type IntegrationRepository struct {
	db *pgxpool.Pool
}

type EnvKommoInstance struct {
	Name          string
	Subdomain     string
	ClientID      string
	ClientSecret  string
	AccessToken   string
	RedirectURI   string
	WebhookSecret string
}

func scanIntegrationInstance(row pgx.Row) (*domain.IntegrationInstance, error) {
	instance := &domain.IntegrationInstance{}
	err := row.Scan(
		&instance.ID,
		&instance.Provider,
		&instance.Scope,
		&instance.Name,
		&instance.Status,
		&instance.IsActive,
		&instance.Subdomain,
		&instance.ClientID,
		&instance.ClientSecret,
		&instance.AccessToken,
		&instance.RefreshToken,
		&instance.RedirectURI,
		&instance.WebhookSecret,
		&instance.Config,
		&instance.LastSyncAt,
		&instance.CreatedAt,
		&instance.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	return instance, nil
}

func integrationInstanceSelect() string {
	return `id, provider, scope, name, status, is_active, subdomain, client_id, client_secret, access_token, refresh_token, redirect_uri, webhook_secret, config, last_sync_at, created_at, updated_at`
}

func (r *IntegrationRepository) List(ctx context.Context, provider string) ([]*domain.IntegrationInstance, error) {
	query := `SELECT ` + integrationInstanceSelect() + ` FROM integration_instances`
	args := []interface{}{}
	if strings.TrimSpace(provider) != "" {
		query += ` WHERE provider = $1`
		args = append(args, provider)
	}
	query += ` ORDER BY provider ASC, created_at DESC`
	rows, err := r.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	instances := []*domain.IntegrationInstance{}
	for rows.Next() {
		instance, err := scanIntegrationInstance(rows)
		if err != nil {
			return nil, err
		}
		accounts, _ := r.GetAccounts(ctx, instance.ID)
		instance.Accounts = accounts
		instances = append(instances, instance)
	}
	return instances, rows.Err()
}

func (r *IntegrationRepository) GetByID(ctx context.Context, id uuid.UUID) (*domain.IntegrationInstance, error) {
	instance, err := scanIntegrationInstance(r.db.QueryRow(ctx, `SELECT `+integrationInstanceSelect()+` FROM integration_instances WHERE id = $1`, id))
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	accounts, _ := r.GetAccounts(ctx, instance.ID)
	instance.Accounts = accounts
	return instance, nil
}

func (r *IntegrationRepository) GetActiveByProvider(ctx context.Context, provider string) ([]*domain.IntegrationInstance, error) {
	rows, err := r.db.Query(ctx, `
		SELECT `+integrationInstanceSelect()+`
		FROM integration_instances
		WHERE provider = $1 AND is_active = TRUE AND status = $2
		ORDER BY created_at ASC
	`, provider, domain.IntegrationStatusActive)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	instances := []*domain.IntegrationInstance{}
	for rows.Next() {
		instance, err := scanIntegrationInstance(rows)
		if err != nil {
			return nil, err
		}
		instances = append(instances, instance)
	}
	return instances, rows.Err()
}

func (r *IntegrationRepository) GetForAccount(ctx context.Context, provider string, accountID uuid.UUID) (*domain.IntegrationInstance, error) {
	instance, err := scanIntegrationInstance(r.db.QueryRow(ctx, `
		SELECT i.`+strings.ReplaceAll(integrationInstanceSelect(), ", ", ", i.")+`
		FROM integration_instances i
		JOIN integration_instance_accounts ia ON ia.integration_instance_id = i.id
		WHERE i.provider = $1 AND ia.account_id = $2 AND ia.enabled = TRUE AND i.is_active = TRUE AND i.status = $3
		ORDER BY ia.created_at ASC
		LIMIT 1
	`, provider, accountID, domain.IntegrationStatusActive))
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	return instance, err
}

func (r *IntegrationRepository) GetByWebhookSecret(ctx context.Context, provider, secret string) (*domain.IntegrationInstance, error) {
	instance, err := scanIntegrationInstance(r.db.QueryRow(ctx, `
		SELECT `+integrationInstanceSelect()+`
		FROM integration_instances
		WHERE provider = $1 AND webhook_secret = $2 AND webhook_secret <> '' AND is_active = TRUE
		LIMIT 1
	`, provider, secret))
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	return instance, err
}

func (r *IntegrationRepository) Create(ctx context.Context, instance *domain.IntegrationInstance) error {
	if len(instance.Config) == 0 {
		instance.Config = []byte(`{}`)
	}
	return r.db.QueryRow(ctx, `
		INSERT INTO integration_instances
			(provider, scope, name, status, is_active, subdomain, client_id, client_secret, access_token, refresh_token, redirect_uri, webhook_secret, config)
		VALUES ($1, $2, $3, COALESCE(NULLIF($4, ''), 'active'), $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
		RETURNING id, created_at, updated_at
	`, instance.Provider, instance.Scope, instance.Name, instance.Status, instance.IsActive, instance.Subdomain, instance.ClientID, instance.ClientSecret, instance.AccessToken, instance.RefreshToken, instance.RedirectURI, instance.WebhookSecret, instance.Config).Scan(&instance.ID, &instance.CreatedAt, &instance.UpdatedAt)
}

func (r *IntegrationRepository) Update(ctx context.Context, instance *domain.IntegrationInstance) error {
	if len(instance.Config) == 0 {
		instance.Config = []byte(`{}`)
	}
	_, err := r.db.Exec(ctx, `
		UPDATE integration_instances
		SET scope = $2,
		    name = $3,
		    status = COALESCE(NULLIF($4, ''), status),
		    is_active = $5,
		    subdomain = $6,
		    client_id = $7,
		    client_secret = CASE WHEN $8 = '' THEN client_secret ELSE $8 END,
		    access_token = CASE WHEN $9 = '' THEN access_token ELSE $9 END,
		    refresh_token = CASE WHEN $10 = '' THEN refresh_token ELSE $10 END,
		    redirect_uri = $11,
		    webhook_secret = CASE WHEN $12 = '' THEN webhook_secret ELSE $12 END,
		    config = $13::jsonb,
		    updated_at = NOW()
		WHERE id = $1
	`, instance.ID, instance.Scope, instance.Name, instance.Status, instance.IsActive, instance.Subdomain, instance.ClientID, instance.ClientSecret, instance.AccessToken, instance.RefreshToken, instance.RedirectURI, instance.WebhookSecret, instance.Config)
	return err
}

func (r *IntegrationRepository) Delete(ctx context.Context, id uuid.UUID) error {
	_, err := r.db.Exec(ctx, `DELETE FROM integration_instances WHERE id = $1`, id)
	return err
}

func (r *IntegrationRepository) AssignAccount(ctx context.Context, instanceID, accountID uuid.UUID, enabled bool) error {
	_, err := r.db.Exec(ctx, `
		INSERT INTO integration_instance_accounts (integration_instance_id, account_id, enabled)
		VALUES ($1, $2, $3)
		ON CONFLICT (integration_instance_id, account_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()
	`, instanceID, accountID, enabled)
	return err
}

func (r *IntegrationRepository) RemoveAccount(ctx context.Context, instanceID, accountID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `DELETE FROM integration_instance_accounts WHERE integration_instance_id = $1 AND account_id = $2`, instanceID, accountID)
	return err
}

func (r *IntegrationRepository) GetAccounts(ctx context.Context, instanceID uuid.UUID) ([]domain.IntegrationInstanceAccount, error) {
	rows, err := r.db.Query(ctx, `
		SELECT ia.id, ia.integration_instance_id, ia.account_id, ia.enabled, ia.last_synced_at, ia.created_at, ia.updated_at,
		       a.name, COALESCE(a.slug, '')
		FROM integration_instance_accounts ia
		JOIN accounts a ON a.id = ia.account_id
		WHERE ia.integration_instance_id = $1
		ORDER BY a.name ASC
	`, instanceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	accounts := []domain.IntegrationInstanceAccount{}
	for rows.Next() {
		var account domain.IntegrationInstanceAccount
		if err := rows.Scan(&account.ID, &account.IntegrationInstanceID, &account.AccountID, &account.Enabled, &account.LastSyncedAt, &account.CreatedAt, &account.UpdatedAt, &account.AccountName, &account.AccountSlug); err != nil {
			return nil, err
		}
		accounts = append(accounts, account)
	}
	return accounts, rows.Err()
}

func (r *IntegrationRepository) EnsureDefaultKommoInstance(ctx context.Context, env EnvKommoInstance) (*uuid.UUID, error) {
	if strings.TrimSpace(env.Subdomain) == "" || strings.TrimSpace(env.AccessToken) == "" {
		return nil, nil
	}

	// If any Kommo integration already exists in the DB, it is managed via the
	// Admin UI. Never overwrite DB-managed credentials with env vars so that
	// token refreshes and manual edits survive restarts.
	var existing int
	if err := r.db.QueryRow(ctx, `SELECT COUNT(*) FROM integration_instances WHERE provider = $1`, domain.IntegrationProviderKommo).Scan(&existing); err != nil {
		return nil, err
	}
	if existing > 0 {
		return nil, nil
	}

	// First boot — no integration in DB yet; seed from env vars.
	name := strings.TrimSpace(env.Name)
	if name == "" {
		name = "Kommo " + strings.TrimSpace(env.Subdomain)
	}
	var instanceID uuid.UUID
	err := r.db.QueryRow(ctx, `
		INSERT INTO integration_instances
			(provider, scope, name, status, is_active, subdomain, client_id, client_secret, access_token, redirect_uri, webhook_secret, config)
		VALUES ($1, $2, $3, $4, TRUE, $5, $6, $7, $8, $9, $10, '{}'::jsonb)
		ON CONFLICT (provider, name) DO NOTHING
		RETURNING id
	`, domain.IntegrationProviderKommo, domain.IntegrationScopeMultiAccount, name, domain.IntegrationStatusActive, env.Subdomain, env.ClientID, env.ClientSecret, env.AccessToken, env.RedirectURI, env.WebhookSecret).Scan(&instanceID)
	if err != nil {
		return nil, err
	}

	_, err = r.db.Exec(ctx, `
		INSERT INTO integration_instance_accounts (integration_instance_id, account_id, enabled)
		SELECT $1, a.id, TRUE
		FROM accounts a
		WHERE COALESCE(a.kommo_enabled, FALSE) = TRUE
		   OR EXISTS (SELECT 1 FROM kommo_connected_pipelines kcp WHERE kcp.account_id = a.id)
		ON CONFLICT (integration_instance_id, account_id) DO UPDATE SET enabled = TRUE, updated_at = NOW()
	`, instanceID)
	if err != nil {
		return nil, err
	}

	_, err = r.db.Exec(ctx, `UPDATE kommo_connected_pipelines SET integration_instance_id = $1 WHERE integration_instance_id IS NULL`, instanceID)
	if err != nil {
		return nil, err
	}
	return &instanceID, nil
}
