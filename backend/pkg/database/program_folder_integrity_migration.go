package database

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Programs retain their history when a stale or foreign folder is detached.
// The account column must never be nulled when deleting a folder.
const programFolderIntegrityMigration = `
LOCK TABLE program_folders, programs IN SHARE ROW EXCLUSIVE MODE;
UPDATE programs p SET folder_id = NULL
WHERE p.folder_id IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM program_folders f WHERE f.account_id=p.account_id AND f.id=p.folder_id
);
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='program_folders'::regclass AND conname='program_folders_account_id_id_key') THEN
  ALTER TABLE program_folders ADD CONSTRAINT program_folders_account_id_id_key UNIQUE(account_id,id);
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='programs'::regclass AND conname='programs_account_folder_fkey') THEN
  ALTER TABLE programs ADD CONSTRAINT programs_account_folder_fkey
   FOREIGN KEY(account_id,folder_id) REFERENCES program_folders(account_id,id) ON DELETE SET NULL(folder_id);
 END IF;
END $$;
ALTER TABLE programs DROP CONSTRAINT IF EXISTS programs_folder_id_fkey;
`

func migrateProgramFolderIntegrity(ctx context.Context, db *pgxpool.Pool) error {
	tx, err := db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin program folder integrity migration: %w", err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, programFolderIntegrityMigration); err != nil {
		return fmt.Errorf("migrate program folder integrity: %w", err)
	}
	return tx.Commit(ctx)
}
