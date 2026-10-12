package database

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
)

func migrateTaskCreateReceipts(ctx context.Context, db *pgxpool.Pool) error {
	_, err := db.Exec(ctx, `CREATE TABLE IF NOT EXISTS task_create_receipts (
	 account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
	 actor_id UUID NOT NULL,
	 operation_id UUID NOT NULL,
	 payload_hash TEXT NOT NULL,
	 task_id UUID NOT NULL,
	 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	 PRIMARY KEY(account_id,actor_id,operation_id)
	)`)
	return err
}
