package utilities

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

type VaultInput struct {
	ID          uuid.UUID       `json:"id"`
	DocumentID  uuid.UUID       `json:"document_id"`
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Kind        string          `json:"kind"`
	Algorithm   string          `json:"algorithm"`
	Bits        *int            `json:"bits"`
	PublicData  string          `json:"public_data"`
	Material    string          `json:"material"`
	Metadata    json.RawMessage `json:"metadata"`
	OperationID uuid.UUID       `json:"operation_id"`
}
type VaultPatch struct {
	DocumentID  uuid.UUID `json:"document_id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Version     int64     `json:"version"`
	OperationID uuid.UUID `json:"operation_id"`
}
type VaultMaterialInput struct {
	DocumentID  uuid.UUID       `json:"document_id"`
	Version     int64           `json:"version"`
	Material    string          `json:"material"`
	PublicData  *string         `json:"public_data"`
	Metadata    json.RawMessage `json:"metadata"`
	OperationID uuid.UUID       `json:"operation_id"`
}

const vaultColumns = `id,document_id,name,description,kind,algorithm,bits,public_data,metadata,version,created_at,updated_at`

func scanVault(row scanner) (domain.UtilityVaultItem, error) {
	var v domain.UtilityVaultItem
	err := row.Scan(&v.ID, &v.DocumentID, &v.Name, &v.Description, &v.Kind, &v.Algorithm, &v.Bits, &v.PublicData, &v.Metadata, &v.Version, &v.CreatedAt, &v.UpdatedAt)
	return v, missing(err)
}

type vaultQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func requireVaultDocument(ctx context.Context, q vaultQuerier, account, owner, document uuid.UUID, lock bool) error {
	if document == uuid.Nil {
		return ErrInvalid
	}
	statement := `SELECT id FROM utility_documents WHERE account_id=$1 AND owner_id=$2 AND id=$3 AND type='criptografia'`
	if lock {
		var activeAccount uuid.UUID
		if err := q.QueryRow(ctx, `SELECT id FROM accounts WHERE id=$1 FOR KEY SHARE`, account).Scan(&activeAccount); err != nil {
			return missing(err)
		}
		statement += ` FOR UPDATE`
	}
	var found uuid.UUID
	return missing(q.QueryRow(ctx, statement, account, owner, document).Scan(&found))
}

func (s *Service) vaultOperation(ctx context.Context, tx pgx.Tx, account, owner, document, operation, resource uuid.UUID, input any) (json.RawMessage, error) {
	if err := requireVaultDocument(ctx, tx, account, owner, document, false); err != nil {
		return nil, err
	}
	previous, err := s.Store.operation(ctx, tx, account, owner, operation, resource, input)
	if err != nil || previous != nil {
		return previous, err
	}
	return nil, requireVaultDocument(ctx, tx, account, owner, document, true)
}

func (s *Service) GetVault(ctx context.Context, account, owner, document, id uuid.UUID) (domain.UtilityVaultItem, error) {
	if err := requireVaultDocument(ctx, s.Store.DB, account, owner, document, false); err != nil {
		return domain.UtilityVaultItem{}, err
	}
	return scanVault(s.Store.DB.QueryRow(ctx, `SELECT `+vaultColumns+` FROM utility_vault WHERE account_id=$1 AND owner_id=$2 AND id=$3 AND document_id=$4`, account, owner, id, document))
}

func (s *Service) GetLegacyVault(ctx context.Context, account, owner, id uuid.UUID) (domain.UtilityVaultItem, error) {
	return scanVault(s.Store.DB.QueryRow(ctx, `SELECT `+vaultColumns+` FROM utility_vault WHERE account_id=$1 AND owner_id=$2 AND id=$3 AND document_id IS NULL`, account, owner, id))
}

func validateVault(in *VaultInput) error {
	in.Name = strings.TrimSpace(in.Name)
	if !validName(in.Name, 200) || utf8.RuneCountInString(in.Description) > 2000 || strings.IndexByte(in.Description, 0) >= 0 || len(in.Material) == 0 || len(in.Material) > SecretLimit || !utf8.ValidString(in.Material) {
		return ErrInvalid
	}
	if in.Kind != "aes" && in.Kind != "rsa" && in.Kind != "ec" && in.Kind != "certificate" {
		return ErrInvalid
	}
	if !validName(in.Algorithm, 80) || len(in.PublicData) > SecretLimit || strings.Contains(in.PublicData, "PRIVATE KEY") || strings.IndexByte(in.PublicData, 0) >= 0 {
		return ErrInvalid
	}
	if !validPublicProjection(in.PublicData) {
		return ErrInvalid
	}
	if in.Bits != nil && (*in.Bits < 1 || *in.Bits > 16384) {
		return ErrInvalid
	}
	if len(in.Metadata) == 0 {
		in.Metadata = json.RawMessage(`{}`)
	}
	if len(in.Metadata) > ConfigLimit {
		return ErrInvalid
	}
	var metadata map[string]json.RawMessage
	if json.Unmarshal(in.Metadata, &metadata) != nil || metadata == nil {
		return ErrInvalid
	}
	for key, value := range metadata {
		switch key {
		case "fingerprint", "subject", "issuer", "not_before", "not_after", "san", "key_usage", "format", "curve":
		default:
			return ErrInvalid
		}
		if strings.Contains(string(value), "PRIVATE KEY") {
			return ErrInvalid
		}
		var scalar string
		if json.Unmarshal(value, &scalar) == nil {
			if utf8.RuneCountInString(scalar) > 4000 {
				return ErrInvalid
			}
			continue
		}
		var list []string
		if (key != "san" && key != "key_usage") || json.Unmarshal(value, &list) != nil || len(list) > 100 {
			return ErrInvalid
		}
		for _, s := range list {
			if utf8.RuneCountInString(s) > 512 {
				return ErrInvalid
			}
		}
	}
	// Material has its own encrypted endpoint. Public projections are never a
	// second path for a private JWK or secret key.
	var publicJWK map[string]json.RawMessage
	if json.Unmarshal([]byte(in.PublicData), &publicJWK) == nil {
		for _, key := range []string{"d", "p", "q", "dp", "dq", "qi", "k"} {
			if _, exists := publicJWK[key]; exists {
				return ErrInvalid
			}
		}
	}
	return nil
}

// Imported JWK/P12 material is normalized to public SPKI/certificate PEM by
// the browser. Parse that projection here so an accidentally supplied private
// container cannot bypass protection merely by changing its visible label.
func validPublicProjection(value string) bool {
	rest := []byte(strings.TrimSpace(value))
	for len(rest) > 0 {
		if !strings.HasPrefix(string(rest), "-----BEGIN ") {
			return false
		}
		block, next := pem.Decode(rest)
		if block == nil || len(block.Headers) > 0 {
			return false
		}
		switch block.Type {
		case "PUBLIC KEY":
			if _, err := x509.ParsePKIXPublicKey(block.Bytes); err != nil {
				return false
			}
		case "CERTIFICATE":
			if _, err := x509.ParseCertificate(block.Bytes); err != nil {
				return false
			}
		default:
			return false
		}
		rest = []byte(strings.TrimSpace(string(next)))
	}
	return true
}

func (s *Service) ListVault(ctx context.Context, account, owner, document uuid.UUID, q, cursorValue string) ([]domain.UtilityVaultItem, string, error) {
	if err := requireVaultDocument(ctx, s.Store.DB, account, owner, document, false); err != nil {
		return nil, "", err
	}
	return s.listVault(ctx, account, owner, &document, q, cursorValue)
}

func (s *Service) ListLegacyVault(ctx context.Context, account, owner uuid.UUID, q, cursorValue string) ([]domain.UtilityVaultItem, string, error) {
	return s.listVault(ctx, account, owner, nil, q, cursorValue)
}

func (s *Service) listVault(ctx context.Context, account, owner uuid.UUID, document *uuid.UUID, q, cursorValue string) ([]domain.UtilityVaultItem, string, error) {
	if utf8.RuneCountInString(q) > 128 {
		return nil, "", ErrInvalid
	}
	c, err := decodeCursor(cursorValue)
	if err != nil {
		return nil, "", err
	}
	var at *time.Time
	if c.Time != "" {
		v, e := time.Parse(time.RFC3339Nano, c.Time)
		if e != nil {
			return nil, "", ErrInvalid
		}
		at = &v
	}
	rows, err := s.Store.DB.Query(ctx, `SELECT `+vaultColumns+` FROM utility_vault WHERE account_id=$1 AND owner_id=$2 AND document_id IS NOT DISTINCT FROM $7::uuid
	 AND ($3='' OR name ILIKE $4 ESCAPE '\' OR description ILIKE $4 ESCAPE '\' OR metadata->>'fingerprint' ILIKE $4 ESCAPE '\')
	 AND ($5::timestamptz IS NULL OR (created_at,id)<($5::timestamptz,$6::uuid)) ORDER BY created_at DESC,id DESC LIMIT 51`, account, owner, q, escapedPattern(q), at, c.ID, document)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	items := []domain.UtilityVaultItem{}
	for rows.Next() {
		item, e := scanVault(rows)
		if e != nil {
			return nil, "", e
		}
		items = append(items, item)
	}
	if err = rows.Err(); err != nil {
		return nil, "", err
	}
	next := ""
	if len(items) > 50 {
		items = items[:50]
		v := items[49]
		next = encodeCursor(v.CreatedAt.Format(time.RFC3339Nano), v.ID)
	}
	return items, next, nil
}
func (s *Service) CreateVault(ctx context.Context, account, owner, document uuid.UUID, in VaultInput) (domain.UtilityVaultItem, error) {
	var result domain.UtilityVaultItem
	in.DocumentID = document
	if s.Cipher == nil {
		return result, ErrVaultUnavailable
	}
	if err := validateVault(&in); err != nil {
		return result, err
	}
	if in.ID == uuid.Nil {
		in.ID = uuid.NewSHA1(account, []byte(owner.String()+in.OperationID.String()))
	}
	tx, err := s.Store.DB.Begin(ctx)
	if err != nil {
		return result, err
	}
	defer tx.Rollback(ctx)
	previous, err := s.vaultOperation(ctx, tx, account, owner, document, in.OperationID, in.ID, in)
	if err != nil {
		return result, err
	}
	if previous != nil {
		err = json.Unmarshal(previous, &result)
		return result, err
	}
	keyID, wrapped, body, err := s.Cipher.Seal(account, owner, in.ID, []byte(in.Material))
	if err != nil {
		return result, err
	}
	defer clear(body)
	key, err := s.upload(ctx, account, owner, in.ID, body, "application/octet-stream", "secret")
	if err != nil {
		return result, err
	}
	result, err = scanVault(tx.QueryRow(ctx, `INSERT INTO utility_vault(id,account_id,owner_id,name,description,kind,algorithm,bits,public_data,metadata,object_key,master_key_id,wrapped_key,document_id)
	 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING `+vaultColumns, in.ID, account, owner, in.Name, in.Description, in.Kind, in.Algorithm, in.Bits, in.PublicData, in.Metadata, key, keyID, wrapped, document))
	if err != nil {
		return result, err
	}
	if err = activateObject(ctx, tx, account, key); err != nil {
		return result, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO security_events(type,account_id,user_id,metadata) VALUES('utility_vault_created',$1,$2,jsonb_build_object('entry_id',$3::text,'kind',$4::text))`, account, owner, in.ID.String(), in.Kind); err != nil {
		return result, err
	}
	if err = recordOperation(ctx, tx, account, owner, in.OperationID, in.ID, in, result); err != nil {
		return result, err
	}
	return result, tx.Commit(ctx)
}
func (s *Service) VaultMaterial(ctx context.Context, account, owner, document, id uuid.UUID) (string, string, json.RawMessage, error) {
	if err := requireVaultDocument(ctx, s.Store.DB, account, owner, document, false); err != nil {
		return "", "", nil, err
	}
	if s.Cipher == nil {
		return "", "", nil, ErrVaultUnavailable
	}
	var objectKey, keyID, public string
	var wrapped []byte
	var metadata json.RawMessage
	err := s.Store.DB.QueryRow(ctx, `SELECT object_key,master_key_id,wrapped_key,public_data,metadata FROM utility_vault WHERE account_id=$1 AND owner_id=$2 AND id=$3 AND document_id=$4`, account, owner, id, document).Scan(&objectKey, &keyID, &wrapped, &public, &metadata)
	if err != nil {
		return "", "", nil, missing(err)
	}
	if s.Objects == nil {
		return "", "", nil, ErrVaultUnavailable
	}
	body, err := s.Objects.GetFileLimited(ctx, objectKey, SecretLimit+1024)
	if err != nil {
		return "", "", nil, err
	}
	defer clear(body)
	plain, err := s.Cipher.Open(account, owner, id, keyID, wrapped, body)
	if err != nil {
		return "", "", nil, err
	}
	defer clear(plain)
	// Only the row-locked rotation worker changes the envelope. A reader can
	// overlap material replacement and must never rewrap an obsolete data key.
	if _, err = s.Store.DB.Exec(ctx, `INSERT INTO security_events(type,account_id,user_id,metadata) VALUES('utility_vault_accessed',$1,$2,jsonb_build_object('entry_id',$3::text))`, account, owner, id.String()); err != nil {
		return "", "", nil, err
	}
	return string(plain), public, metadata, nil
}

// Rotation is resumable from the canonical key id and never needs to rewrite
// private objects. Old masters stay configured until all retained backups no
// longer require them. No key material is logged or returned by maintenance.
func (s *Service) rotateVaultKeys(ctx context.Context) error {
	if s.Cipher == nil {
		return nil
	}
	tx, err := s.Store.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `SELECT account_id,owner_id,id,master_key_id,wrapped_key FROM utility_vault WHERE master_key_id<>$1 AND rotation_retry_at<=NOW() ORDER BY rotation_retry_at LIMIT 25 FOR UPDATE SKIP LOCKED`, s.Cipher.current)
	if err != nil {
		return err
	}
	type row struct {
		a, u, id uuid.UUID
		keyID    string
		wrapped  []byte
	}
	items := []row{}
	for rows.Next() {
		var item row
		if err = rows.Scan(&item.a, &item.u, &item.id, &item.keyID, &item.wrapped); err != nil {
			rows.Close()
			return err
		}
		items = append(items, item)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, item := range items {
		newID, wrapped, e := s.Cipher.Rewrap(item.a, item.u, item.id, item.keyID, item.wrapped)
		if e != nil {
			if _, err = tx.Exec(ctx, `UPDATE utility_vault SET rotation_attempts=rotation_attempts+1,rotation_error='master_key_unavailable',rotation_retry_at=NOW()+INTERVAL '1 minute' * least(60,rotation_attempts+1) WHERE account_id=$1 AND owner_id=$2 AND id=$3`, item.a, item.u, item.id); err != nil {
				return err
			}
			continue
		}
		if _, e = tx.Exec(ctx, `UPDATE utility_vault SET master_key_id=$4,wrapped_key=$5,rotation_error='',rotation_attempts=0 WHERE account_id=$1 AND owner_id=$2 AND id=$3`, item.a, item.u, item.id, newID, wrapped); e != nil {
			return e
		}
	}
	return tx.Commit(ctx)
}
func (s *Service) PatchVault(ctx context.Context, account, owner, document, id uuid.UUID, in VaultPatch) (domain.UtilityVaultItem, error) {
	var result domain.UtilityVaultItem
	in.DocumentID = document
	in.Name = strings.TrimSpace(in.Name)
	if !validName(in.Name, 200) || utf8.RuneCountInString(in.Description) > 2000 || strings.IndexByte(in.Description, 0) >= 0 {
		return result, ErrInvalid
	}
	if in.OperationID == uuid.Nil {
		in.OperationID = uuid.New()
	}
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
	result, err = scanVault(tx.QueryRow(ctx, `SELECT `+vaultColumns+` FROM utility_vault WHERE account_id=$1 AND owner_id=$2 AND id=$3 AND document_id=$4 FOR UPDATE`, account, owner, id, document))
	if err != nil {
		return result, err
	}
	if result.Version != in.Version {
		return result, ErrConflict
	}
	result, err = scanVault(tx.QueryRow(ctx, `UPDATE utility_vault SET name=$4,description=$5,version=version+1,updated_at=NOW() WHERE account_id=$1 AND owner_id=$2 AND id=$3 AND version=$6 AND document_id=$7 RETURNING `+vaultColumns, account, owner, id, in.Name, in.Description, in.Version, document))
	if errors.Is(err, ErrMissing) {
		return result, ErrConflict
	}
	if err != nil {
		return result, err
	}
	if err = recordOperation(ctx, tx, account, owner, in.OperationID, id, in, result); err != nil {
		return result, err
	}
	return result, tx.Commit(ctx)
}
func (s *Service) DeleteVault(ctx context.Context, account, owner, document, id uuid.UUID, version int64) error {
	tx, err := s.Store.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = requireVaultDocument(ctx, tx, account, owner, document, true); err != nil {
		return err
	}
	var current int64
	var key string
	err = tx.QueryRow(ctx, `SELECT version,object_key FROM utility_vault WHERE account_id=$1 AND owner_id=$2 AND id=$3 AND document_id=$4 FOR UPDATE`, account, owner, id, document).Scan(&current, &key)
	if err != nil {
		return missing(err)
	}
	if current != version {
		return ErrConflict
	}
	if err = deleteVaultEntries(ctx, tx, account, owner, []uuid.UUID{id}); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE utility_documents SET config=jsonb_set(config,'{key_id}','""'::jsonb),version=version+1,updated_at=NOW() WHERE account_id=$1 AND owner_id=$2 AND id=$3 AND config->>'key_id'=$4`, account, owner, document, id.String()); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) WriteVaultMaterial(ctx context.Context, account, owner, document, id uuid.UUID, in VaultMaterialInput) (domain.UtilityVaultItem, error) {
	var result domain.UtilityVaultItem
	in.DocumentID = document
	if s.Cipher == nil {
		return result, ErrVaultUnavailable
	}
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
	result, err = scanVault(tx.QueryRow(ctx, `SELECT `+vaultColumns+` FROM utility_vault WHERE account_id=$1 AND owner_id=$2 AND id=$3 AND document_id=$4 FOR UPDATE`, account, owner, id, document))
	if err != nil {
		return result, err
	}
	if result.Version != in.Version {
		return result, ErrConflict
	}
	public, metadata := result.PublicData, result.Metadata
	if in.PublicData != nil {
		public = *in.PublicData
	}
	if len(in.Metadata) > 0 {
		metadata = in.Metadata
	}
	validation := VaultInput{Name: result.Name, Description: result.Description, Kind: result.Kind, Algorithm: result.Algorithm, Bits: result.Bits, PublicData: public, Metadata: metadata, Material: in.Material}
	if err = validateVault(&validation); err != nil {
		return result, err
	}
	var old string
	if err = tx.QueryRow(ctx, `SELECT object_key FROM utility_vault WHERE account_id=$1 AND owner_id=$2 AND id=$3 AND document_id=$4`, account, owner, id, document).Scan(&old); err != nil {
		return result, err
	}
	keyID, wrapped, body, err := s.Cipher.Seal(account, owner, id, []byte(in.Material))
	if err != nil {
		return result, err
	}
	defer clear(body)
	key, err := s.upload(ctx, account, owner, id, body, "application/octet-stream", "secret")
	if err != nil {
		return result, err
	}
	result, err = scanVault(tx.QueryRow(ctx, `UPDATE utility_vault SET object_key=$4,master_key_id=$5,wrapped_key=$6,public_data=$7,metadata=$8,version=version+1,updated_at=NOW() WHERE account_id=$1 AND owner_id=$2 AND id=$3 AND document_id=$9 RETURNING `+vaultColumns, account, owner, id, key, keyID, wrapped, public, metadata, document))
	if err != nil {
		return result, err
	}
	if err = activateObject(ctx, tx, account, key); err != nil {
		return result, err
	}
	if err = scheduleObject(ctx, tx, account, old, false); err != nil {
		return result, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO security_events(type,account_id,user_id,metadata) VALUES('utility_vault_material_changed',$1,$2,jsonb_build_object('entry_id',$3::text))`, account, owner, id.String()); err != nil {
		return result, err
	}
	if err = recordOperation(ctx, tx, account, owner, in.OperationID, id, in, result); err != nil {
		return result, err
	}
	return result, tx.Commit(ctx)
}
