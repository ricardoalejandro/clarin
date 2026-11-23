package utilities

import (
	"context"
	"encoding/json"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

// Callers lock documents before entry rows. Every writer follows this order;
// holding a document lock freezes its key set while duplicating or deleting it.
func deleteVaultEntries(ctx context.Context, tx pgx.Tx, account, owner uuid.UUID, ids []uuid.UUID) error {
	if len(ids) == 0 {
		return nil
	}
	for _, statement := range []string{
		`UPDATE utility_objects SET state='gc',available_at=NOW() WHERE account_id=$1 AND owner_id=$2 AND resource_id=ANY($3::uuid[])`,
		`INSERT INTO security_events(type,account_id,user_id,metadata) SELECT 'utility_vault_deleted',$1,$2,jsonb_build_object('entry_id',id::text,'document_id',document_id) FROM utility_vault WHERE account_id=$1 AND owner_id=$2 AND id=ANY($3::uuid[])`,
		`DELETE FROM utility_operations WHERE account_id=$1 AND owner_id=$2 AND resource_id=ANY($3::uuid[])`,
		`DELETE FROM utility_vault WHERE account_id=$1 AND owner_id=$2 AND id=ANY($3::uuid[])`,
	} {
		if _, err := tx.Exec(ctx, statement, account, owner, ids); err != nil {
			return err
		}
	}
	return nil
}

func deleteDocumentVault(ctx context.Context, tx pgx.Tx, account, owner, document uuid.UUID) error {
	rows, err := tx.Query(ctx, `SELECT id FROM utility_vault WHERE account_id=$1 AND owner_id=$2 AND document_id=$3 ORDER BY id FOR UPDATE`, account, owner, document)
	if err != nil {
		return err
	}
	ids := []uuid.UUID{}
	for rows.Next() {
		var id uuid.UUID
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	return deleteVaultEntries(ctx, tx, account, owner, ids)
}

type LegacyVaultImport struct {
	SourceID      uuid.UUID `json:"source_id"`
	SourceVersion int64     `json:"source_version"`
	OperationID   uuid.UUID `json:"operation_id"`
	DocumentID    uuid.UUID `json:"document_id"`
}

// cloneVaultEntry reads at most one bounded private object. It never copies an
// envelope to another identity: both the data key and body authenticate entry ID.
func (s *Service) cloneVaultEntry(ctx context.Context, tx pgx.Tx, account, owner, destination, sourceID, targetID uuid.UUID) (domain.UtilityVaultItem, error) {
	var result domain.UtilityVaultItem
	if s.Cipher == nil || s.Objects == nil {
		return result, ErrVaultUnavailable
	}
	source, err := scanVault(tx.QueryRow(ctx, `SELECT `+vaultColumns+` FROM utility_vault WHERE account_id=$1 AND owner_id=$2 AND id=$3 FOR UPDATE`, account, owner, sourceID))
	if err != nil {
		return result, err
	}
	var object, keyID string
	var wrapped []byte
	if err = tx.QueryRow(ctx, `SELECT object_key,master_key_id,wrapped_key FROM utility_vault WHERE account_id=$1 AND owner_id=$2 AND id=$3`, account, owner, sourceID).Scan(&object, &keyID, &wrapped); err != nil {
		return result, err
	}
	body, err := s.Objects.GetFileLimited(ctx, object, SecretLimit+1024)
	if err != nil {
		return result, err
	}
	defer clear(body)
	plain, err := s.Cipher.Open(account, owner, sourceID, keyID, wrapped, body)
	if err != nil {
		return result, err
	}
	defer clear(plain)
	master, encoded, sealed, err := s.Cipher.Seal(account, owner, targetID, plain)
	if err != nil {
		return result, err
	}
	defer clear(sealed)
	target, err := s.upload(ctx, account, owner, targetID, sealed, "application/octet-stream", "secret")
	if err != nil {
		return result, err
	}
	result, err = scanVault(tx.QueryRow(ctx, `INSERT INTO utility_vault(id,account_id,owner_id,document_id,name,description,kind,algorithm,bits,public_data,metadata,object_key,master_key_id,wrapped_key)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING `+vaultColumns, targetID, account, owner, destination, source.Name, source.Description, source.Kind, source.Algorithm, source.Bits, source.PublicData, source.Metadata, target, master, encoded))
	if err != nil {
		return result, err
	}
	if err = activateObject(ctx, tx, account, target); err != nil {
		return result, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO security_events(type,account_id,user_id,metadata) VALUES('utility_vault_copied',$1,$2,jsonb_build_object('entry_id',$3::text,'source_id',$4::text,'document_id',$5::text))`, account, owner, targetID.String(), sourceID.String(), destination.String())
	return result, err
}

func (s *Service) ImportLegacyVault(ctx context.Context, account, owner, document uuid.UUID, in LegacyVaultImport) (domain.UtilityVaultItem, error) {
	var result domain.UtilityVaultItem
	if in.SourceID == uuid.Nil || in.SourceVersion < 1 || in.OperationID == uuid.Nil {
		return result, ErrInvalid
	}
	in.DocumentID = document
	id := uuid.NewSHA1(document, []byte("legacy|"+in.OperationID.String()))
	tx, err := s.Store.DB.Begin(ctx)
	if err != nil {
		return result, err
	}
	defer tx.Rollback(ctx)
	previous, err := s.vaultOperation(ctx, tx, account, owner, document, in.OperationID, id, in)
	if err != nil {
		return result, err
	}
	if previous != nil {
		err = json.Unmarshal(previous, &result)
		return result, err
	}
	var version int64
	if err = tx.QueryRow(ctx, `SELECT version FROM utility_vault WHERE account_id=$1 AND owner_id=$2 AND id=$3 AND document_id IS NULL FOR UPDATE`, account, owner, in.SourceID).Scan(&version); err != nil {
		return result, missing(err)
	}
	if version != in.SourceVersion {
		return result, ErrConflict
	}
	result, err = s.cloneVaultEntry(ctx, tx, account, owner, document, in.SourceID, id)
	if err != nil {
		return result, err
	}
	if err = recordOperation(ctx, tx, account, owner, in.OperationID, id, in, result); err != nil {
		return result, err
	}
	return result, tx.Commit(ctx)
}

type DocumentDuplicate struct {
	BaseVersion int64           `json:"base_version"`
	OperationID uuid.UUID       `json:"operation_id"`
	Title       string          `json:"title"`
	Config      json.RawMessage `json:"config,omitempty"`
	SourceID    uuid.UUID       `json:"source_id"`
}

func (s *Service) DuplicateCryptoDocument(ctx context.Context, account, owner, sourceID uuid.UUID, in DocumentDuplicate) (domain.UtilityDocument, error) {
	var result domain.UtilityDocument
	if in.OperationID == uuid.Nil || in.BaseVersion < 1 || !validName(in.Title, 200) {
		return result, ErrInvalid
	}
	in.SourceID = sourceID
	id := uuid.NewSHA1(account, []byte(owner.String()+"duplicate|"+in.OperationID.String()))
	tx, err := s.Store.DB.Begin(ctx)
	if err != nil {
		return result, err
	}
	defer tx.Rollback(ctx)
	if err = requireVaultDocument(ctx, tx, account, owner, sourceID, false); err != nil {
		return result, err
	}
	previous, err := s.Store.operation(ctx, tx, account, owner, in.OperationID, id, in)
	if err != nil {
		return result, err
	}
	if previous != nil {
		err = json.Unmarshal(previous, &result)
		return result, err
	}
	if err = requireVaultDocument(ctx, tx, account, owner, sourceID, true); err != nil {
		return result, err
	}
	source, err := scanDocument(tx.QueryRow(ctx, `SELECT `+docColumns+` FROM utility_documents WHERE account_id=$1 AND owner_id=$2 AND id=$3 AND type='criptografia' FOR UPDATE`, account, owner, sourceID))
	if err != nil {
		return result, err
	}
	if source.Version != in.BaseVersion {
		return result, ErrConflict
	}
	config := source.Config
	if len(in.Config) > 0 {
		config = in.Config
	}
	if err = validateConfig("criptografia", config); err != nil {
		return result, err
	}
	// A selected legacy key is a public reference, not permission to import it.
	selected := configuredKey(config)
	if selected != "" && selected != configuredKey(source.Config) {
		if err = validateDocumentKey(ctx, tx, account, owner, sourceID, "criptografia", config); err != nil {
			return result, err
		}
	}
	var preferences map[string]json.RawMessage
	if err = json.Unmarshal(config, &preferences); err != nil {
		return result, ErrInvalid
	}
	preferences["key_id"] = json.RawMessage(`""`)
	clean, _ := json.Marshal(preferences)
	result, err = scanDocument(tx.QueryRow(ctx, `INSERT INTO utility_documents(id,account_id,owner_id,type,title,folder_id,config) VALUES($1,$2,$3,'criptografia',$4,$5,$6) RETURNING `+docColumns, id, account, owner, in.Title, source.FolderID, clean))
	if err != nil {
		return result, err
	}
	rows, err := tx.Query(ctx, `SELECT id FROM utility_vault WHERE account_id=$1 AND owner_id=$2 AND document_id=$3 ORDER BY id FOR UPDATE`, account, owner, sourceID)
	if err != nil {
		return result, err
	}
	ids := []uuid.UUID{}
	for rows.Next() {
		var key uuid.UUID
		if err = rows.Scan(&key); err != nil {
			rows.Close()
			return result, err
		}
		ids = append(ids, key)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return result, err
	}
	for _, key := range ids {
		copied := uuid.NewSHA1(id, []byte(key.String()))
		if _, err = s.cloneVaultEntry(ctx, tx, account, owner, id, key, copied); err != nil {
			return result, err
		}
		if key.String() == selected {
			preferences["key_id"], _ = json.Marshal(copied.String())
		}
	}
	config, _ = json.Marshal(preferences)
	result, err = scanDocument(tx.QueryRow(ctx, `UPDATE utility_documents SET config=$4 WHERE account_id=$1 AND owner_id=$2 AND id=$3 RETURNING `+docColumns, account, owner, id, config))
	if err != nil {
		return result, err
	}
	if err = recordOperation(ctx, tx, account, owner, in.OperationID, id, in, result); err != nil {
		return result, err
	}
	return result, tx.Commit(ctx)
}
