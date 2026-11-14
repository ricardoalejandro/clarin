package utilities

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
)

type Store struct{ DB *pgxpool.Pool }
type Query struct {
	Search, Type, Folder, Cursor string
	Favorite                     bool
	Limit                        int
}
type DocumentInput struct {
	ID          uuid.UUID       `json:"id"`
	Type        string          `json:"type"`
	Title       string          `json:"title"`
	FolderID    *uuid.UUID      `json:"folder_id"`
	Config      json.RawMessage `json:"config"`
	OperationID uuid.UUID       `json:"operation_id"`
}
type DocumentPatch struct {
	BaseVersion int64           `json:"base_version"`
	Title       *string         `json:"title"`
	FolderID    json.RawMessage `json:"folder_id"`
	Favorite    *bool           `json:"favorite"`
	Config      json.RawMessage `json:"config"`
	OperationID uuid.UUID       `json:"operation_id"`
}

const docColumns = `id,type,title,folder_id,favorite,version,config,created_at,updated_at`

type scanner interface{ Scan(...any) error }
type contentQuerier interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

func fillDocumentSlots(ctx context.Context, q contentQuerier, account, owner uuid.UUID, d *domain.UtilityDocument) error {
	d.Slots = []domain.UtilityContent{}
	rows, err := q.Query(ctx, `SELECT c.slot,c.version,c.bytes,c.content_type,c.indexed_version<c.version FROM utility_content c WHERE c.account_id=$1 AND c.owner_id=$2 AND c.document_id=$3 ORDER BY c.slot`, account, owner, d.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var content domain.UtilityContent
		if err = rows.Scan(&content.Slot, &content.Version, &content.Bytes, &content.ContentType, &content.Indexing); err != nil {
			return err
		}
		d.Slots = append(d.Slots, content)
	}
	return rows.Err()
}

func scanDocument(row scanner) (domain.UtilityDocument, error) {
	var d domain.UtilityDocument
	d.Slots = []domain.UtilityContent{}
	err := row.Scan(&d.ID, &d.Type, &d.Title, &d.FolderID, &d.Favorite, &d.Version, &d.Config, &d.CreatedAt, &d.UpdatedAt)
	return d, missing(err)
}
func missing(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrMissing
	}
	return err
}

func (s *Store) Get(ctx context.Context, account, owner, id uuid.UUID) (domain.UtilityDocument, error) {
	d, err := scanDocument(s.DB.QueryRow(ctx, `SELECT `+docColumns+` FROM utility_documents WHERE account_id=$1 AND owner_id=$2 AND id=$3`, account, owner, id))
	if err != nil {
		return d, err
	}
	rows, err := s.DB.Query(ctx, `SELECT slot,version,bytes,content_type,indexed_version<version FROM utility_content WHERE account_id=$1 AND owner_id=$2 AND document_id=$3 ORDER BY slot`, account, owner, id)
	if err != nil {
		return d, err
	}
	defer rows.Close()
	for rows.Next() {
		var c domain.UtilityContent
		if err = rows.Scan(&c.Slot, &c.Version, &c.Bytes, &c.ContentType, &c.Indexing); err != nil {
			return d, err
		}
		d.Slots = append(d.Slots, c)
	}
	return d, rows.Err()
}

func (s *Store) List(ctx context.Context, account, owner uuid.UUID, q Query) ([]domain.UtilityDocument, string, error) {
	result := []domain.UtilityDocument{}
	if q.Limit <= 0 {
		q.Limit = 50
	}
	q.Limit = min(q.Limit, 200)
	if utf8.RuneCountInString(q.Search) > 128 {
		return nil, "", ErrInvalid
	}
	if q.Type != "" && !validType(q.Type) {
		return nil, "", ErrInvalid
	}
	c, err := decodeCursor(q.Cursor)
	if err != nil {
		return nil, "", err
	}
	var cursorTime *time.Time
	if c.Time != "" {
		parsed, e := time.Parse(time.RFC3339Nano, c.Time)
		if e != nil {
			return nil, "", ErrInvalid
		}
		cursorTime = &parsed
	}
	var folder *uuid.UUID
	if q.Folder != "" && q.Folder != "root" {
		parsed, e := uuid.Parse(q.Folder)
		if e != nil {
			return nil, "", ErrInvalid
		}
		folder = &parsed
	}
	pattern := escapedPattern(q.Search)
	rows, err := s.DB.Query(ctx, `SELECT d.id,d.type,d.title,d.folder_id,d.favorite,d.version,d.config,d.created_at,d.updated_at,
	 COALESCE((SELECT substring(c.body FROM greatest(1,strpos(lower(c.body),lower($3))-40) FOR 180)
	 FROM utility_search_chunks c WHERE c.account_id=d.account_id AND c.owner_id=d.owner_id AND c.document_id=d.id
	 AND length($3)>=3 AND c.body ILIKE $4 ESCAPE '\' ORDER BY c.slot,c.position LIMIT 1),'')
	 FROM utility_documents d WHERE d.account_id=$1 AND d.owner_id=$2
	 AND ($3='' OR d.title ILIKE $4 ESCAPE '\' OR (length($3)>=3 AND EXISTS(SELECT 1 FROM utility_search_chunks c
	 WHERE c.account_id=d.account_id AND c.owner_id=d.owner_id AND c.document_id=d.id AND c.body ILIKE $4 ESCAPE '\')))
	 AND ($5='' OR d.type=$5) AND (NOT $6 OR d.favorite)
	 AND ($7='' OR ($7='root' AND d.folder_id IS NULL) OR d.folder_id=$8)
	 AND ($9::timestamptz IS NULL OR (d.updated_at,d.id)<($9::timestamptz,$10::uuid))
	 ORDER BY d.updated_at DESC,d.id DESC LIMIT $11`, account, owner, q.Search, pattern, q.Type, q.Favorite, q.Folder, folder, cursorTime, c.ID, q.Limit+1)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	for rows.Next() {
		var d domain.UtilityDocument
		d.Slots = []domain.UtilityContent{}
		if err = rows.Scan(&d.ID, &d.Type, &d.Title, &d.FolderID, &d.Favorite, &d.Version, &d.Config, &d.CreatedAt, &d.UpdatedAt, &d.Snippet); err != nil {
			return nil, "", err
		}
		result = append(result, d)
	}
	if err = rows.Err(); err != nil {
		return nil, "", err
	}
	next := ""
	if len(result) > q.Limit {
		result = result[:q.Limit]
		last := result[len(result)-1]
		next = encodeCursor(last.UpdatedAt.Format(time.RFC3339Nano), last.ID)
	}
	return result, next, nil
}

func (s *Store) operation(ctx context.Context, tx pgx.Tx, account, owner, op, resource uuid.UUID, value any) (json.RawMessage, error) {
	if op == uuid.Nil {
		return nil, ErrInvalid
	}
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, account.String()+owner.String()+op.String()); err != nil {
		return nil, err
	}
	var result json.RawMessage
	var hash string
	var existing uuid.UUID
	err := tx.QueryRow(ctx, `SELECT resource_id,fingerprint,result FROM utility_operations WHERE account_id=$1 AND owner_id=$2 AND operation_id=$3`, account, owner, op).Scan(&existing, &hash, &result)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if hash != fingerprint(value) || existing != resource {
		return nil, ErrConflict
	}
	return result, nil
}
func recordOperation(ctx context.Context, tx pgx.Tx, account, owner, op, resource uuid.UUID, value, result any) error {
	data, err := json.Marshal(result)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO utility_operations(account_id,owner_id,operation_id,resource_id,fingerprint,result) VALUES($1,$2,$3,$4,$5,$6)`, account, owner, op, resource, fingerprint(value), data)
	return err
}
func validateFolder(ctx context.Context, tx pgx.Tx, account, owner uuid.UUID, id *uuid.UUID) error {
	if id == nil {
		return nil
	}
	var found uuid.UUID
	return missing(tx.QueryRow(ctx, `SELECT id FROM utility_folders WHERE account_id=$1 AND owner_id=$2 AND id=$3 FOR KEY SHARE`, account, owner, id).Scan(&found))
}

func validateDocumentKey(ctx context.Context, tx pgx.Tx, account, owner uuid.UUID, kind string, config json.RawMessage) error {
	if kind != "criptografia" {
		return nil
	}
	var values map[string]json.RawMessage
	_ = json.Unmarshal(config, &values)
	var key string
	if json.Unmarshal(values["key_id"], &key) != nil || key == "" {
		return nil
	}
	var found uuid.UUID
	return missing(tx.QueryRow(ctx, `SELECT id FROM utility_vault WHERE account_id=$1 AND owner_id=$2 AND id=$3::uuid FOR KEY SHARE`, account, owner, key).Scan(&found))
}

func configuredKey(config json.RawMessage) string {
	var value struct {
		KeyID string `json:"key_id"`
	}
	_ = json.Unmarshal(config, &value)
	return value.KeyID
}
func (s *Store) Create(ctx context.Context, account, owner uuid.UUID, in DocumentInput) (domain.UtilityDocument, error) {
	var result domain.UtilityDocument
	in.Title = strings.TrimSpace(in.Title)
	if !validType(in.Type) || !validName(in.Title, 200) {
		return result, ErrInvalid
	}
	if len(in.Config) == 0 {
		in.Config = json.RawMessage(`{}`)
	}
	if err := validateConfig(in.Type, in.Config); err != nil {
		return result, err
	}
	if in.ID == uuid.Nil {
		in.ID = uuid.NewSHA1(account, []byte(owner.String()+in.OperationID.String()))
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return result, err
	}
	defer tx.Rollback(ctx)
	previous, err := s.operation(ctx, tx, account, owner, in.OperationID, in.ID, in)
	if err != nil {
		return result, err
	}
	if previous != nil {
		err = json.Unmarshal(previous, &result)
		return result, err
	}
	if err = validateFolder(ctx, tx, account, owner, in.FolderID); err != nil {
		return result, err
	}
	if err = validateDocumentKey(ctx, tx, account, owner, in.Type, in.Config); err != nil {
		return result, err
	}
	result, err = scanDocument(tx.QueryRow(ctx, `INSERT INTO utility_documents(id,account_id,owner_id,type,title,folder_id,config) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING `+docColumns, in.ID, account, owner, in.Type, in.Title, in.FolderID, in.Config))
	if err != nil {
		return result, err
	}
	if err = recordOperation(ctx, tx, account, owner, in.OperationID, in.ID, in, result); err != nil {
		return result, err
	}
	return result, tx.Commit(ctx)
}
func (s *Store) Patch(ctx context.Context, account, owner, id uuid.UUID, in DocumentPatch) (domain.UtilityDocument, error) {
	var result domain.UtilityDocument
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return result, err
	}
	defer tx.Rollback(ctx)
	previous, err := s.operation(ctx, tx, account, owner, in.OperationID, id, in)
	if err != nil {
		return result, err
	}
	if previous != nil {
		err = json.Unmarshal(previous, &result)
		return result, err
	}
	result, err = scanDocument(tx.QueryRow(ctx, `SELECT `+docColumns+` FROM utility_documents WHERE account_id=$1 AND owner_id=$2 AND id=$3 FOR UPDATE`, account, owner, id))
	if err != nil {
		return result, err
	}
	if in.BaseVersion != result.Version {
		return result, ErrConflict
	}
	previousKey := configuredKey(result.Config)
	if in.Title != nil {
		value := strings.TrimSpace(*in.Title)
		if !validName(value, 200) {
			return result, ErrInvalid
		}
		result.Title = value
	}
	if len(in.FolderID) > 0 {
		if string(in.FolderID) == "null" {
			result.FolderID = nil
		} else {
			var folder uuid.UUID
			if json.Unmarshal(in.FolderID, &folder) != nil {
				return result, ErrInvalid
			}
			result.FolderID = &folder
		}
		if err = validateFolder(ctx, tx, account, owner, result.FolderID); err != nil {
			return result, err
		}
	}
	if in.Favorite != nil {
		result.Favorite = *in.Favorite
	}
	if len(in.Config) > 0 {
		if err = validateConfig(result.Type, in.Config); err != nil {
			return result, err
		}
		result.Config = in.Config
	}
	if configuredKey(result.Config) != previousKey {
		if err = validateDocumentKey(ctx, tx, account, owner, result.Type, result.Config); err != nil {
			return result, err
		}
	}
	result, err = scanDocument(tx.QueryRow(ctx, `UPDATE utility_documents SET title=$4,folder_id=$5,favorite=$6,config=$7,version=version+1,updated_at=NOW() WHERE account_id=$1 AND owner_id=$2 AND id=$3 RETURNING `+docColumns, account, owner, id, result.Title, result.FolderID, result.Favorite, result.Config))
	if err != nil {
		return result, err
	}
	if err = fillDocumentSlots(ctx, tx, account, owner, &result); err != nil {
		return result, err
	}
	if err = recordOperation(ctx, tx, account, owner, in.OperationID, id, in, result); err != nil {
		return result, err
	}
	return result, tx.Commit(ctx)
}
func (s *Store) Delete(ctx context.Context, account, owner, id uuid.UUID, version int64) error {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var current int64
	if err = tx.QueryRow(ctx, `SELECT version FROM utility_documents WHERE account_id=$1 AND owner_id=$2 AND id=$3 FOR UPDATE`, account, owner, id).Scan(&current); err != nil {
		return missing(err)
	}
	if current != version {
		return ErrConflict
	}
	if _, err = tx.Exec(ctx, `UPDATE utility_objects SET state='gc',available_at=NOW() WHERE account_id=$1 AND owner_id=$2 AND resource_id=$3`, account, owner, id); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM utility_operations WHERE account_id=$1 AND owner_id=$2 AND resource_id=$3`, account, owner, id); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM utility_documents WHERE account_id=$1 AND owner_id=$2 AND id=$3`, account, owner, id); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE utility_workspace SET open_ids=array_remove(open_ids,$3),active_id=CASE WHEN active_id=$3 THEN NULL ELSE active_id END,version=version+1 WHERE account_id=$1 AND owner_id=$2 AND $3=ANY(open_ids)`, account, owner, id); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (s *Store) Folders(ctx context.Context, account, owner uuid.UUID) ([]domain.UtilityFolder, error) {
	result := []domain.UtilityFolder{}
	rows, err := s.DB.Query(ctx, `SELECT id,name,version FROM utility_folders WHERE account_id=$1 AND owner_id=$2 ORDER BY name,id LIMIT 200`, account, owner)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var f domain.UtilityFolder
		if err = rows.Scan(&f.ID, &f.Name, &f.Version); err != nil {
			return nil, err
		}
		result = append(result, f)
	}
	return result, rows.Err()
}
func (s *Store) SaveFolder(ctx context.Context, account, owner, id uuid.UUID, name string, version int64) (domain.UtilityFolder, error) {
	var f domain.UtilityFolder
	name = strings.TrimSpace(name)
	if !validName(name, 160) {
		return f, ErrInvalid
	}
	if id == uuid.Nil {
		id = uuid.New()
		err := s.DB.QueryRow(ctx, `INSERT INTO utility_folders(id,account_id,owner_id,name) SELECT $3,$1,$2,$4 WHERE (SELECT count(*) FROM utility_folders WHERE account_id=$1 AND owner_id=$2)<200 RETURNING id,name,version`, account, owner, id, name).Scan(&f.ID, &f.Name, &f.Version)
		return f, missing(err)
	}
	err := s.DB.QueryRow(ctx, `UPDATE utility_folders SET name=$4,version=version+1 WHERE account_id=$1 AND owner_id=$2 AND id=$3 AND version=$5 RETURNING id,name,version`, account, owner, id, name, version).Scan(&f.ID, &f.Name, &f.Version)
	if errors.Is(err, pgx.ErrNoRows) {
		return f, ErrConflict
	}
	return f, err
}
func (s *Store) DeleteFolder(ctx context.Context, account, owner, id uuid.UUID, version int64) error {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var current int64
	if err = tx.QueryRow(ctx, `SELECT version FROM utility_folders WHERE account_id=$1 AND owner_id=$2 AND id=$3 FOR UPDATE`, account, owner, id).Scan(&current); err != nil {
		return missing(err)
	}
	if current != version {
		return ErrConflict
	}
	var used bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM utility_documents WHERE account_id=$1 AND owner_id=$2 AND folder_id=$3)`, account, owner, id).Scan(&used); err != nil {
		return err
	}
	if used {
		return ErrConflict
	}
	_, err = tx.Exec(ctx, `DELETE FROM utility_folders WHERE account_id=$1 AND owner_id=$2 AND id=$3`, account, owner, id)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (s *Store) Workspace(ctx context.Context, account, owner uuid.UUID) (domain.UtilityWorkspace, error) {
	w := domain.UtilityWorkspace{OpenIDs: []uuid.UUID{}}
	err := s.DB.QueryRow(ctx, `SELECT open_ids,active_id,version FROM utility_workspace WHERE account_id=$1 AND owner_id=$2`, account, owner).Scan(&w.OpenIDs, &w.ActiveID, &w.Version)
	if errors.Is(err, pgx.ErrNoRows) {
		err = nil
	}
	return w, err
}
func (s *Store) SaveWorkspace(ctx context.Context, account, owner uuid.UUID, w domain.UtilityWorkspace) (domain.UtilityWorkspace, error) {
	if len(w.OpenIDs) > 100 {
		return w, ErrInvalid
	}
	unique := map[uuid.UUID]bool{}
	for _, id := range w.OpenIDs {
		if id == uuid.Nil || unique[id] {
			return w, ErrInvalid
		}
		unique[id] = true
	}
	if w.ActiveID != nil && !unique[*w.ActiveID] {
		return w, ErrInvalid
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return w, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `INSERT INTO utility_workspace(account_id,owner_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, account, owner); err != nil {
		return w, err
	}
	var current int64
	if err = tx.QueryRow(ctx, `SELECT version FROM utility_workspace WHERE account_id=$1 AND owner_id=$2 FOR UPDATE`, account, owner).Scan(&current); err != nil {
		return w, err
	}
	if current != w.Version {
		return w, ErrConflict
	}
	var count int
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM utility_documents WHERE account_id=$1 AND owner_id=$2 AND id=ANY($3::uuid[])`, account, owner, w.OpenIDs).Scan(&count); err != nil {
		return w, err
	}
	if count != len(w.OpenIDs) {
		return w, ErrMissing
	}
	err = tx.QueryRow(ctx, `UPDATE utility_workspace SET open_ids=$3,active_id=$4,version=version+1 WHERE account_id=$1 AND owner_id=$2 RETURNING version`, account, owner, w.OpenIDs, w.ActiveID).Scan(&w.Version)
	if err != nil {
		return w, err
	}
	return w, tx.Commit(ctx)
}

func parseVersion(s string) (int64, error) {
	v, err := strconv.ParseInt(strings.Trim(s, `"`), 10, 64)
	if err != nil || v < 0 {
		return 0, fmt.Errorf("%w: version", ErrInvalid)
	}
	return v, nil
}
