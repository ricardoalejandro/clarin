// utility-legacy-cleanup is an operator-run, dry-run-first maintenance command.
// It never runs from startup and never accepts a username in place of an ID.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/utilities"
	"os"
	"time"
)

func run() error {
	ownerText := flag.String("owner", "", "Exact verified user UUID")
	username := flag.String("expected-username", "", "Independent exact identity check")
	manifestPath := flag.String("manifest", "", "Private manifest file to write (dry run) or read (apply)")
	apply := flag.Bool("apply", false, "Apply the reviewed manifest; default is dry run")
	confirm := flag.String("confirm-owner", "", "Repeat the exact owner UUID to apply")
	digest := flag.String("expected-digest", "", "Reviewed manifest digest required to apply")
	flag.Parse()
	owner, err := uuid.Parse(*ownerText)
	if err != nil || owner == uuid.Nil || *username == "" || *manifestPath == "" {
		return fmt.Errorf("owner, expected-username and manifest are required")
	}
	if *apply && (*confirm != owner.String() || len(*digest) != 64) {
		return fmt.Errorf("apply requires exact confirm-owner and expected-digest")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	db, err := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		return fmt.Errorf("database connection unavailable")
	}
	defer db.Close()
	store := &utilities.Store{DB: db}
	if !*apply {
		manifest, e := store.PrepareLegacyCleanup(ctx, owner, *username)
		if e != nil {
			return fmt.Errorf("inventory failed; no changes applied")
		}
		data, e := json.MarshalIndent(manifest, "", "  ")
		if e != nil {
			return e
		}
		file, e := os.OpenFile(*manifestPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if e != nil {
			return fmt.Errorf("manifest must be a new private file")
		}
		_, e = file.Write(data)
		closeError := file.Close()
		if e != nil || closeError != nil {
			return fmt.Errorf("manifest write failed")
		}
		entries := 0
		for _, account := range manifest.Accounts {
			entries += len(account.Entries)
		}
		fmt.Printf("DRY_RUN=true accounts=%d legacy_entries=%d digest=%s\n", len(manifest.Accounts), entries, manifest.Digest())
		return nil
	}
	info, err := os.Stat(*manifestPath)
	if err != nil || info.Size() > 16*1024*1024 {
		return fmt.Errorf("manifest unavailable or too large")
	}
	if info.Mode().Perm()&0077 != 0 {
		return fmt.Errorf("manifest permissions must be private")
	}
	data, err := os.ReadFile(*manifestPath)
	if err != nil {
		return fmt.Errorf("manifest unavailable")
	}
	var manifest utilities.LegacyCleanupManifest
	if json.Unmarshal(data, &manifest) != nil || manifest.OwnerID != owner || manifest.Username != *username || manifest.Digest() != *digest {
		return fmt.Errorf("manifest identity or digest mismatch")
	}
	for _, account := range manifest.Accounts {
		result, e := store.ApplyLegacyCleanupAccount(ctx, manifest, account)
		if e != nil {
			return fmt.Errorf("account %s stopped; earlier committed scopes can be resumed with the same manifest", account.AccountID)
		}
		fmt.Printf("account=%s deleted=%d references_cleared=%d cleanup_pending=%t\n", account.AccountID, result.Deleted, result.ReferencesCleared, result.CleanupPending)
	}
	return nil
}
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
