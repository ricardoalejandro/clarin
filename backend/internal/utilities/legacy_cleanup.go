package utilities

import (
	"context"
	"encoding/json"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// This maintenance contract contains identifiers, versions and byte counts
// only. It never reads ciphertext, wrapped keys or decrypted material.
type LegacyCleanupEntry struct {
	ID        uuid.UUID `json:"id"`
	Version   int64     `json:"version"`
	ObjectKey string    `json:"object_key"`
}
type LegacyCleanupReference struct {
	ID      uuid.UUID `json:"id"`
	Version int64     `json:"version"`
	KeyID   string    `json:"key_id"`
}
type LegacyCleanupObject struct {
	Key   string `json:"key"`
	Bytes int64  `json:"bytes"`
	State string `json:"state"`
}
type LegacyCleanupAccount struct {
	AccountID  uuid.UUID                `json:"account_id"`
	Entries    []LegacyCleanupEntry     `json:"entries"`
	References []LegacyCleanupReference `json:"references"`
	Objects    []LegacyCleanupObject    `json:"objects"`
}
type LegacyCleanupManifest struct {
	Version     int                    `json:"version"`
	OperationID uuid.UUID              `json:"operation_id"`
	OwnerID     uuid.UUID              `json:"owner_id"`
	Username    string                 `json:"username"`
	Accounts    []LegacyCleanupAccount `json:"accounts"`
}
type LegacyCleanupResult struct {
	Deleted           int  `json:"deleted"`
	ReferencesCleared int  `json:"references_cleared"`
	CleanupPending    bool `json:"cleanup_pending"`
}

func (m LegacyCleanupManifest) Digest() string { return fingerprint(m) }

func cleanupAuthority(ctx context.Context, q vaultQuerier, owner, account uuid.UUID, username string) error {
	if owner == uuid.Nil || username == "" {
		return ErrInvalid
	}
	var allowed bool
	err := q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM users u WHERE u.id=$1 AND u.username=$3 AND u.is_active AND
 (u.is_super_admin OR EXISTS(SELECT 1 FROM user_accounts ua LEFT JOIN roles r ON r.id=ua.role_id WHERE ua.user_id=u.id AND ua.account_id=$2
 AND (ua.role IN ('admin','super_admin') OR '*'=ANY(COALESCE(r.permissions,'{}'::text[])) OR 'utilities'=ANY(COALESCE(r.permissions,'{}'::text[]))))))`, owner, account, username).Scan(&allowed)
	if err != nil {
		return err
	}
	if !allowed {
		return ErrMissing
	}
	return nil
}

type cleanupQuerier interface {
	vaultQuerier
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

func cleanupSnapshot(ctx context.Context, q cleanupQuerier, account, owner uuid.UUID, lock bool) (LegacyCleanupAccount, error) {
	result := LegacyCleanupAccount{AccountID: account, Entries: []LegacyCleanupEntry{}, References: []LegacyCleanupReference{}, Objects: []LegacyCleanupObject{}}
	// Reference/document locks precede key locks, matching ordinary vault writes.
	suffix := ""
	if lock {
		suffix = " FOR UPDATE"
	}
	rows, err := q.Query(ctx, `SELECT id,version,config->>'key_id' FROM utility_documents WHERE account_id=$1 AND owner_id=$2 AND type='criptografia'
 AND config->>'key_id' IN (SELECT id::text FROM utility_vault WHERE account_id=$1 AND owner_id=$2 AND document_id IS NULL) ORDER BY id`+suffix, account, owner)
	if err != nil {
		return result, err
	}
	for rows.Next() {
		var r LegacyCleanupReference
		if err = rows.Scan(&r.ID, &r.Version, &r.KeyID); err != nil {
			rows.Close()
			return result, err
		}
		result.References = append(result.References, r)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return result, err
	}
	rows, err = q.Query(ctx, `SELECT id,version,object_key FROM utility_vault WHERE account_id=$1 AND owner_id=$2 AND document_id IS NULL ORDER BY id`+suffix, account, owner)
	if err != nil {
		return result, err
	}
	ids := []uuid.UUID{}
	for rows.Next() {
		var entry LegacyCleanupEntry
		if err = rows.Scan(&entry.ID, &entry.Version, &entry.ObjectKey); err != nil {
			rows.Close()
			return result, err
		}
		result.Entries = append(result.Entries, entry)
		ids = append(ids, entry.ID)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return result, err
	}
	rows, err = q.Query(ctx, `SELECT object_key,bytes,state FROM utility_objects WHERE account_id=$1 AND owner_id=$2 AND resource_id=ANY($3::uuid[]) ORDER BY object_key`+suffix, account, owner, ids)
	if err != nil {
		return result, err
	}
	for rows.Next() {
		var object LegacyCleanupObject
		if err = rows.Scan(&object.Key, &object.Bytes, &object.State); err != nil {
			rows.Close()
			return result, err
		}
		result.Objects = append(result.Objects, object)
	}
	err = rows.Err()
	rows.Close()
	return result, err
}

func (s *Store) PrepareLegacyCleanup(ctx context.Context, owner uuid.UUID, expectedUsername string) (LegacyCleanupManifest, error) {
	result := LegacyCleanupManifest{Version: 1, OperationID: uuid.New(), OwnerID: owner, Username: expectedUsername, Accounts: []LegacyCleanupAccount{}}
	if owner == uuid.Nil || expectedUsername == "" {
		return result, ErrInvalid
	}
	tx, err := s.DB.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return result, err
	}
	defer tx.Rollback(ctx)
	var valid bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE id=$1 AND username=$2 AND is_active)`, owner, expectedUsername).Scan(&valid); err != nil {
		return result, err
	}
	if !valid {
		return result, ErrMissing
	}
	// Include owned legacy records outside membership for a global superadmin;
	// authorization is resolved separately for every account, never inferred.
	rows, err := tx.Query(ctx, `SELECT account_id FROM user_accounts WHERE user_id=$1 UNION SELECT account_id FROM utility_vault WHERE owner_id=$1 AND document_id IS NULL ORDER BY account_id`, owner)
	if err != nil {
		return result, err
	}
	accounts := []uuid.UUID{}
	for rows.Next() {
		var id uuid.UUID
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return result, err
		}
		accounts = append(accounts, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return result, err
	}
	for _, account := range accounts {
		if err = cleanupAuthority(ctx, tx, owner, account, expectedUsername); err != nil {
			return result, err
		}
		snapshot, e := cleanupSnapshot(ctx, tx, account, owner, false)
		if e != nil {
			return result, e
		}
		result.Accounts = append(result.Accounts, snapshot)
	}
	return result, tx.Commit(ctx)
}

// Apply is intentionally per account. Its deterministic operation record makes
// a multi-account run resumable without widening any query's tenant boundary.
func (s *Store) ApplyLegacyCleanupAccount(ctx context.Context, manifest LegacyCleanupManifest, account LegacyCleanupAccount) (LegacyCleanupResult, error) {
	var result LegacyCleanupResult
	if manifest.Version != 1 || manifest.OperationID == uuid.Nil || manifest.OwnerID == uuid.Nil {
		return result, ErrInvalid
	}
	found := false
	for _, expected := range manifest.Accounts {
		if expected.AccountID == account.AccountID && fingerprint(expected) == fingerprint(account) {
			found = true
			break
		}
	}
	if !found {
		return result, ErrInvalid
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return result, err
	}
	defer tx.Rollback(ctx)
	if err = cleanupAuthority(ctx, tx, manifest.OwnerID, account.AccountID, manifest.Username); err != nil {
		return result, err
	}
	// Prevent concurrent identity/authority removal while committing this scope.
	var actor uuid.UUID
	if err = tx.QueryRow(ctx, `SELECT id FROM users WHERE id=$1 AND username=$2 AND is_active FOR SHARE`, manifest.OwnerID, manifest.Username).Scan(&actor); err != nil {
		return result, missing(err)
	}
	operation := uuid.NewSHA1(manifest.OperationID, account.AccountID[:])
	resource := uuid.NewSHA1(manifest.OwnerID, []byte("legacy-cleanup|"+account.AccountID.String()))
	value := struct {
		Owner   uuid.UUID
		Account LegacyCleanupAccount
	}{manifest.OwnerID, account}
	previous, err := s.operation(ctx, tx, account.AccountID, manifest.OwnerID, operation, resource, value)
	if err != nil {
		return result, err
	}
	if previous != nil {
		err = json.Unmarshal(previous, &result)
		return result, err
	}
	var retainedAccount uuid.UUID
	if err = tx.QueryRow(ctx, `SELECT id FROM accounts WHERE id=$1 FOR KEY SHARE`, account.AccountID).Scan(&retainedAccount); err != nil {
		return result, missing(err)
	}
	current, err := cleanupSnapshot(ctx, tx, account.AccountID, manifest.OwnerID, true)
	if err != nil {
		return result, err
	}
	if fingerprint(current) != fingerprint(account) {
		return result, ErrConflict
	}
	ids := make([]uuid.UUID, 0, len(current.Entries))
	for _, entry := range current.Entries {
		ids = append(ids, entry.ID)
	}
	for _, reference := range current.References {
		updated, e := tx.Exec(ctx, `UPDATE utility_documents SET config=jsonb_set(config,'{key_id}','""'::jsonb),version=version+1,updated_at=NOW() WHERE account_id=$1 AND owner_id=$2 AND id=$3 AND version=$4 AND config->>'key_id'=$5`, account.AccountID, manifest.OwnerID, reference.ID, reference.Version, reference.KeyID)
		if e != nil {
			return result, e
		}
		if updated.RowsAffected() != 1 {
			return result, ErrConflict
		}
	}
	if err = deleteVaultEntries(ctx, tx, account.AccountID, manifest.OwnerID, ids); err != nil {
		return result, err
	}
	result = LegacyCleanupResult{Deleted: len(ids), ReferencesCleared: len(current.References), CleanupPending: len(current.Objects) > 0}
	if _, err = tx.Exec(ctx, `INSERT INTO security_events(type,account_id,user_id,metadata) VALUES('utility_vault_legacy_cleanup',$1,$2,jsonb_build_object('operation_id',$3::text,'deleted',$4::integer,'references_cleared',$5::integer))`, account.AccountID, manifest.OwnerID, operation.String(), result.Deleted, result.ReferencesCleared); err != nil {
		return result, err
	}
	if err = recordOperation(ctx, tx, account.AccountID, manifest.OwnerID, operation, resource, value, result); err != nil {
		return result, err
	}
	return result, tx.Commit(ctx)
}
