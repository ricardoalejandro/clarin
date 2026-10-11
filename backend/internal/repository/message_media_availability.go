package repository

import (
	"context"
	"github.com/google/uuid"
)

// DeletedMediaKeys reads explicit inventory facts, not inferred object absence.
// Callers pass one bounded page of keys belonging to the selected account.
func (r *MessageRepository) DeletedMediaKeys(ctx context.Context, accountID uuid.UUID, keys []string) (map[string]bool, error) {
	deleted := make(map[string]bool)
	if len(keys) == 0 {
		return deleted, nil
	}
	rows, err := r.db.Query(ctx, `SELECT object_key FROM storage_objects
 WHERE account_id=$1 AND object_key=ANY($2::text[]) AND status='deleted'`, accountID, keys)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			return nil, err
		}
		deleted[key] = true
	}
	return deleted, rows.Err()
}
