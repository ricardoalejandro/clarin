package repository

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
)

type APIKeyRepository struct {
	db *pgxpool.Pool
}

func (r *APIKeyRepository) Create(ctx context.Context, key *domain.APIKey) error {
	_, err := r.db.Exec(ctx, `
		INSERT INTO api_keys (id, account_id, name, key_hash, key_prefix, permissions, is_active, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
	`, key.ID, key.AccountID, key.Name, key.KeyHash, key.KeyPrefix, key.Permissions, key.IsActive, key.CreatedAt, key.UpdatedAt)
	return err
}

func (r *APIKeyRepository) ListByAccountID(ctx context.Context, accountID uuid.UUID) ([]*domain.APIKey, error) {
	rows, err := r.db.Query(ctx, `
		SELECT id, account_id, name, key_prefix, permissions, is_active, last_used_at, created_at, updated_at
		FROM api_keys WHERE account_id = $1
		ORDER BY created_at DESC
	`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var keys []*domain.APIKey
	for rows.Next() {
		k := &domain.APIKey{}
		if err := rows.Scan(&k.ID, &k.AccountID, &k.Name, &k.KeyPrefix, &k.Permissions, &k.IsActive, &k.LastUsedAt, &k.CreatedAt, &k.UpdatedAt); err != nil {
			return nil, err
		}
		keys = append(keys, k)
	}
	return keys, nil
}

func (r *APIKeyRepository) GetByKeyHash(ctx context.Context, keyHash string) (*domain.APIKey, error) {
	k := &domain.APIKey{}
	err := r.db.QueryRow(ctx, `
		SELECT id, account_id, name, key_hash, key_prefix, permissions, is_active, last_used_at, created_at, updated_at
		FROM api_keys WHERE key_hash = $1 AND is_active = true
	`, keyHash).Scan(&k.ID, &k.AccountID, &k.Name, &k.KeyHash, &k.KeyPrefix, &k.Permissions, &k.IsActive, &k.LastUsedAt, &k.CreatedAt, &k.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return k, nil
}

func (r *APIKeyRepository) Delete(ctx context.Context, id uuid.UUID, accountID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `DELETE FROM api_keys WHERE id = $1 AND account_id = $2`, id, accountID)
	return err
}

func (r *APIKeyRepository) UpdateLastUsed(ctx context.Context, id uuid.UUID) {
	_, _ = r.db.Exec(ctx, `UPDATE api_keys SET last_used_at = $1 WHERE id = $2`, time.Now(), id)
}

// ValidateKeyHash looks up an active API key by its SHA-256 hash.
// Returns the key record or nil if not found / inactive.
func (r *APIKeyRepository) ValidateKeyHash(ctx context.Context, keyHash string) (*domain.APIKey, error) {
	return r.GetByKeyHash(ctx, keyHash)
}
