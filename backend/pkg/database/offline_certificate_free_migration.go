package database

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// migrateOfflineCertificateFree removes unused prototype PKI objects only when
// they contain no historical data. A database that ever used the prototype
// keeps those rows and columns for recovery, while all runtime paths remain on
// the certificate-free device-key protocol.
func migrateOfflineCertificateFree(ctx context.Context, db *pgxpool.Pool) error {
	statements := []string{
		`DO $$ DECLARE has_rows BOOLEAN; BEGIN
			IF to_regclass('public.offline_terminal_certificates') IS NOT NULL THEN
				EXECUTE 'SELECT EXISTS(SELECT 1 FROM offline_terminal_certificates)' INTO has_rows;
				IF NOT has_rows THEN EXECUTE 'DROP TABLE offline_terminal_certificates'; END IF;
			END IF;
			IF to_regclass('public.offline_pairing_sessions') IS NOT NULL THEN
				EXECUTE 'SELECT EXISTS(SELECT 1 FROM offline_pairing_sessions)' INTO has_rows;
				IF NOT has_rows THEN EXECUTE 'DROP TABLE offline_pairing_sessions'; END IF;
			END IF;
			IF to_regclass('public.offline_enrollments') IS NOT NULL THEN
				EXECUTE 'SELECT EXISTS(SELECT 1 FROM offline_enrollments)' INTO has_rows;
				IF NOT has_rows THEN EXECUTE 'DROP TABLE offline_enrollments'; END IF;
			END IF;
		END $$`,
		`DO $$ DECLARE has_identity BOOLEAN; BEGIN
			IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='offline_terminals' AND column_name='certificate_pem') THEN
				EXECUTE 'SELECT EXISTS(SELECT 1 FROM offline_terminals WHERE certificate_pem IS NOT NULL OR certificate_serial IS NOT NULL OR certificate_not_after IS NOT NULL)' INTO has_identity;
				IF NOT has_identity THEN
					ALTER TABLE offline_terminals DROP COLUMN IF EXISTS certificate_pem;
					ALTER TABLE offline_terminals DROP COLUMN IF EXISTS certificate_serial;
					ALTER TABLE offline_terminals DROP COLUMN IF EXISTS certificate_not_after;
				END IF;
			END IF;
			IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='offline_terminals' AND column_name='csr_pem') THEN
				EXECUTE 'SELECT EXISTS(SELECT 1 FROM offline_terminals WHERE csr_pem IS NOT NULL)' INTO has_identity;
				IF NOT has_identity THEN ALTER TABLE offline_terminals DROP COLUMN csr_pem; END IF;
			END IF;
		END $$`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(ctx, statement); err != nil {
			return fmt.Errorf("offline certificate-free migration: %w", err)
		}
	}
	return nil
}
