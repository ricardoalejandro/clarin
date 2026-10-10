package taskpreview

import (
	"context"
	"errors"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Exercises the actual publication gate against concurrent native PostgreSQL
// transactions. No converter or provider is needed to establish lock ordering.
func TestTaskPreviewPublicationConcurrencyIntegration(t *testing.T) {
	if os.Getenv("CLARIN_RUN_STORAGE_SELF_SERVICE_INTEGRATION") != "1" {
		t.Skip("native publication concurrency is enabled by the disposable storage QA runner")
	}
	parsed, err := url.Parse(os.Getenv("DATABASE_URL"))
	if err != nil || (parsed.Hostname() != "127.0.0.1" && parsed.Hostname() != "localhost") ||
		(parsed.Path != "/program_survey_integrity_test" && parsed.Path != "/clarin_storage_qa" && parsed.Path != "/clarin_storage_guard_qa") {
		t.Fatal("disposable loopback storage QA database required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cfg, err := pgxpool.ParseConfig(parsed.String())
	if err != nil {
		t.Fatal("invalid disposable database configuration")
	}
	schema := pgx.Identifier{"clarin_preview_lock_" + uuid.New().String()}.Sanitize()
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	db, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal("disposable database unavailable")
	}
	defer db.Close()
	if _, err := db.Exec(ctx, `CREATE SCHEMA `+schema); err != nil {
		t.Fatal(err)
	}
	defer func() {
		cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		_, _ = db.Exec(cleanup, `DROP SCHEMA `+schema+` CASCADE`)
	}()
	if _, err := db.Exec(ctx, `CREATE TABLE task_attachments(account_id UUID NOT NULL,id UUID PRIMARY KEY,storage_removed_at TIMESTAMPTZ,published BOOLEAN NOT NULL DEFAULT FALSE)`); err != nil {
		t.Fatal(err)
	}
	seed := func() (uuid.UUID, uuid.UUID) {
		t.Helper()
		account, attachment := uuid.New(), uuid.New()
		if _, err := db.Exec(ctx, `INSERT INTO task_attachments(account_id,id) VALUES($1,$2)`, account, attachment); err != nil {
			t.Fatal(err)
		}
		return account, attachment
	}
	waitForBarrier := func(t *testing.T, pid uint32) {
		t.Helper()
		deadline := time.NewTimer(3 * time.Second)
		defer deadline.Stop()
		tick := time.NewTicker(5 * time.Millisecond)
		defer tick.Stop()
		for {
			var blocked bool
			if err := db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted)`, pid).Scan(&blocked); err != nil {
				t.Fatal(err)
			}
			if blocked {
				return
			}
			select {
			case <-tick.C:
			case <-deadline.C:
				t.Fatal("transaction never waited on the account barrier")
			}
		}
	}
	t.Run("removal first blocks publication without holding the attachment", func(t *testing.T) {
		account, attachment := seed()
		removal, err := db.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer removal.Rollback(ctx)
		if _, err := removal.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('storage-self-service:'||$1::text,0))`, account); err != nil {
			t.Fatal(err)
		}
		publisher, err := db.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		publisherPID := publisher.Conn().PgConn().PID()
		result := make(chan error, 1)
		go func() {
			defer publisher.Rollback(ctx)
			err := lockPreviewPublication(ctx, publisher, account, attachment)
			if err == nil {
				_, err = publisher.Exec(ctx, `UPDATE task_attachments SET published=TRUE WHERE account_id=$1 AND id=$2`, account, attachment)
			}
			result <- err
		}()
		waitForBarrier(t, publisherPID)
		// NOWAIT detects the original inversion deterministically: a publisher
		// that locked the attachment before waiting would make this fail.
		if _, err := removal.Exec(ctx, `SELECT id FROM task_attachments WHERE account_id=$1 AND id=$2 FOR UPDATE NOWAIT`, account, attachment); err != nil {
			t.Fatalf("waiting publisher held attachment and inverted lock order: %v", err)
		}
		if _, err := removal.Exec(ctx, `UPDATE task_attachments SET storage_removed_at=NOW() WHERE account_id=$1 AND id=$2`, account, attachment); err != nil {
			t.Fatal(err)
		}
		if err := removal.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		if err := <-result; !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("removed attachment was publishable: %v", err)
		}
		var published bool
		if err := db.QueryRow(ctx, `SELECT published FROM task_attachments WHERE id=$1`, attachment).Scan(&published); err != nil || published {
			t.Fatalf("removed attachment published output: published=%v error=%v", published, err)
		}
	})
	t.Run("publication first completes before removal without deadlock", func(t *testing.T) {
		account, attachment := seed()
		publisher, err := db.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer publisher.Rollback(ctx)
		if err := lockPreviewPublication(ctx, publisher, account, attachment); err != nil {
			t.Fatal(err)
		}
		removal, err := db.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		removalPID := removal.Conn().PgConn().PID()
		result := make(chan error, 1)
		go func() {
			defer removal.Rollback(ctx)
			_, err := removal.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('storage-self-service:'||$1::text,0))`, account)
			if err == nil {
				_, err = removal.Exec(ctx, `UPDATE task_attachments SET storage_removed_at=NOW() WHERE account_id=$1 AND id=$2`, account, attachment)
			}
			if err == nil {
				err = removal.Commit(ctx)
			}
			result <- err
		}()
		waitForBarrier(t, removalPID)
		if _, err := publisher.Exec(ctx, `UPDATE task_attachments SET published=TRUE WHERE account_id=$1 AND id=$2`, account, attachment); err != nil {
			t.Fatal(err)
		}
		if err := publisher.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		if err := <-result; err != nil {
			t.Fatalf("removal failed after publication: %v", err)
		}
		var published, removed bool
		if err := db.QueryRow(ctx, `SELECT published,storage_removed_at IS NOT NULL FROM task_attachments WHERE id=$1`, attachment).Scan(&published, &removed); err != nil || !published || !removed {
			t.Fatalf("transactions did not serialize: published=%v removed=%v error=%v", published, removed, err)
		}
	})
}
