package database

import (
	"context"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// This test is intentionally gated behind a dedicated disposable database URL.
// It exercises the real PostgreSQL parser, constraints, and idempotence; source
// string assertions are not sufficient evidence for a security boundary.
func TestOfflineV3MigrationIsIdempotentOnPostgres(t *testing.T) {
	rawURL := os.Getenv("OFFLINE_V3_TEST_DATABASE_URL")
	if rawURL == "" {
		t.Skip("OFFLINE_V3_TEST_DATABASE_URL is required")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, rawURL)
	if err != nil {
		t.Fatalf("connect disposable PostgreSQL: %v", err)
	}
	defer pool.Close()

	if err := Migrate(pool); err != nil {
		t.Fatalf("first full migration: %v", err)
	}
	if err := Migrate(pool); err != nil {
		t.Fatalf("second full migration: %v", err)
	}

	for _, table := range []string{
		"offline_v3_installations",
		"offline_v3_authorizations",
		"offline_v3_grants",
		"offline_v3_service_descriptors",
		"offline_v3_selections",
		"offline_v3_receipts",
		"offline_v3_controls",
	} {
		var exists bool
		if err := pool.QueryRow(ctx, `SELECT to_regclass('public.' || $1) IS NOT NULL`, table).Scan(&exists); err != nil {
			t.Fatalf("look up %s: %v", table, err)
		}
		if !exists {
			t.Fatalf("expected %s after migration", table)
		}
	}
}

func TestOfflineV3MembershipEpochTriggerPreservesParentCascadeDeletes(t *testing.T) {
	rawURL := os.Getenv("OFFLINE_V3_TEST_DATABASE_URL")
	if rawURL == "" {
		t.Skip("OFFLINE_V3_TEST_DATABASE_URL is required")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, rawURL)
	if err != nil {
		t.Fatalf("connect disposable PostgreSQL: %v", err)
	}
	defer pool.Close()
	if err := Migrate(pool); err != nil {
		t.Fatalf("full migration: %v", err)
	}

	seedMembership := func(prefix string) (uuid.UUID, uuid.UUID) {
		t.Helper()
		accountID, userID := uuid.New(), uuid.New()
		if _, err := pool.Exec(ctx, `INSERT INTO accounts(id,name) VALUES($1,$2)`, accountID, prefix+" account"); err != nil {
			t.Fatalf("insert %s account: %v", prefix, err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO users(id,account_id,username,email,password_hash,is_active)
			VALUES($1,$2,$3,$4,'test-hash',TRUE)`, userID, accountID, prefix+"-"+userID.String(), userID.String()+"@test.invalid"); err != nil {
			t.Fatalf("insert %s user: %v", prefix, err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO user_accounts(user_id,account_id,role,is_default)
			VALUES($1,$2,'agent',TRUE)`, userID, accountID); err != nil {
			t.Fatalf("insert %s membership: %v", prefix, err)
		}
		return accountID, userID
	}

	accountID, _ := seedMembership("offline-v3-user-cascade-owner")
	userID := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO users(id,account_id,username,email,password_hash,is_active)
		VALUES($1,$2,$3,$4,'test-hash',TRUE)`, userID, accountID,
		"offline-v3-user-cascade-target-"+userID.String(), userID.String()+"@test.invalid"); err != nil {
		t.Fatalf("insert user-cascade target: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO user_accounts(user_id,account_id,role,is_default)
		VALUES($1,$2,'agent',FALSE)`, userID, accountID); err != nil {
		t.Fatalf("insert user-cascade target membership: %v", err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM user_accounts WHERE user_id=$1 AND account_id=$2`, userID, accountID); err != nil {
		t.Fatalf("ordinary membership delete must retain a revoked epoch: %v", err)
	}
	var active bool
	if err := pool.QueryRow(ctx, `SELECT active FROM offline_v3_membership_epochs WHERE user_id=$1 AND account_id=$2`, userID, accountID).Scan(&active); err != nil {
		t.Fatalf("load revoked ordinary membership epoch: %v", err)
	}
	if active {
		t.Fatal("ordinary membership delete did not revoke the durable epoch")
	}
	if _, err := pool.Exec(ctx, `INSERT INTO user_accounts(user_id,account_id,role,is_default)
		VALUES($1,$2,'agent',TRUE)`, userID, accountID); err != nil {
		t.Fatalf("restore membership before parent user cascade: %v", err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, userID); err != nil {
		t.Fatalf("user parent cascade was blocked by offline v3 epoch trigger: %v", err)
	}
	var remaining int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM offline_v3_membership_epochs WHERE user_id=$1`, userID).Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if remaining != 0 {
		t.Fatalf("user cascade retained %d offline membership epochs", remaining)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM accounts WHERE id=$1`, accountID); err != nil {
		t.Fatalf("cleanup user-cascade account: %v", err)
	}

	accountID, userID = seedMembership("offline-v3-account-cascade")
	if _, err := pool.Exec(ctx, `DELETE FROM accounts WHERE id=$1`, accountID); err != nil {
		t.Fatalf("account parent cascade was blocked by offline v3 epoch trigger: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM offline_v3_membership_epochs
		WHERE user_id=$1 OR account_id=$2`, userID, accountID).Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if remaining != 0 {
		t.Fatalf("account cascade retained %d offline membership epochs", remaining)
	}
}
