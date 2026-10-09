package database

import (
	"context"
	"errors"
	"net/url"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestProgramFolderIntegrityRepairsWithoutRemovingHistory(t *testing.T) {
	raw := os.Getenv("INTEGRITY_TEST_DATABASE_URL")
	if raw == "" {
		t.Skip("INTEGRITY_TEST_DATABASE_URL required for dedicated synthetic DB")
	}
	u, err := url.Parse(raw)
	if err != nil || u.Path != "/program_survey_integrity_test" {
		t.Fatal("folder migration tests require disposable program_survey_integrity_test")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, raw)
	if err != nil {
		t.Fatal("connect integration database")
	}
	defer admin.Close()
	schema := "folder_test_" + uuid.New().String()[:8]
	if _, err := admin.Exec(ctx, `CREATE SCHEMA `+schema); err != nil {
		t.Fatal(err)
	}
	defer admin.Exec(ctx, `DROP SCHEMA `+schema+` CASCADE`)
	cfg, err := pgxpool.ParseConfig(raw)
	if err != nil {
		t.Fatal("parse integration database")
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	db, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal("connect synthetic schema")
	}
	defer db.Close()
	if _, err := db.Exec(ctx, `
CREATE TABLE accounts(id uuid PRIMARY KEY);
CREATE TABLE program_folders(id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts(id));
CREATE TABLE programs(id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts(id), folder_id uuid REFERENCES program_folders(id) ON DELETE SET NULL);
CREATE TABLE retained_history(id uuid PRIMARY KEY,program_id uuid REFERENCES programs(id));
`); err != nil {
		t.Fatal(err)
	}
	a, b, ownFolder, foreignFolder, ownProgram, foreignProgram, history := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	for _, fixture := range []struct {
		query string
		args  []any
	}{
		{`INSERT INTO accounts VALUES($1),($2)`, []any{a, b}},
		{`INSERT INTO program_folders VALUES($1,$2),($3,$4)`, []any{ownFolder, a, foreignFolder, b}},
		{`INSERT INTO programs VALUES($1,$2,$3),($4,$2,$5)`, []any{ownProgram, a, ownFolder, foreignProgram, foreignFolder}},
		{`INSERT INTO retained_history VALUES($1,$2)`, []any{history, foreignProgram}},
	} {
		if _, err := db.Exec(ctx, fixture.query, fixture.args...); err != nil {
			t.Fatal(err)
		}
	}
	for range 2 {
		if err := migrateProgramFolderIntegrity(ctx, db); err != nil {
			t.Fatal(err)
		}
	}
	var detached bool
	var programs, histories int
	if err := db.QueryRow(ctx, `SELECT folder_id IS NULL FROM programs WHERE id=$1`, foreignProgram).Scan(&detached); err != nil || !detached {
		t.Fatalf("foreign historical folder must be detached: %v", err)
	}
	if err := db.QueryRow(ctx, `SELECT (SELECT count(*) FROM programs),(SELECT count(*) FROM retained_history)`).Scan(&programs, &histories); err != nil || programs != 2 || histories != 1 {
		t.Fatalf("migration removed retained rows: programs=%d history=%d err=%v", programs, histories, err)
	}
	_, err = db.Exec(ctx, `UPDATE programs SET folder_id=$1 WHERE id=$2`, foreignFolder, ownProgram)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23503" {
		t.Fatalf("database must reject foreign folder even for direct writes: %v", err)
	}
	if _, err := db.Exec(ctx, `DELETE FROM program_folders WHERE id=$1`, ownFolder); err != nil {
		t.Fatal(err)
	}
	var account uuid.UUID
	if err := db.QueryRow(ctx, `SELECT account_id,folder_id IS NULL FROM programs WHERE id=$1`, ownProgram).Scan(&account, &detached); err != nil || account != a || !detached {
		t.Fatalf("deleting folder must preserve program account: %v", err)
	}
}
