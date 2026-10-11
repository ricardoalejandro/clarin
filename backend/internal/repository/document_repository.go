package repository

import (
	"context"
	"errors"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"time"
)

var ErrDocumentTemplateConflict = errors.New("document template revision changed")

type DocumentTemplateRepository struct{ db *pgxpool.Pool }
type DocumentTemplatePageFilter struct {
	Query    string
	Limit    int
	Before   *time.Time
	BeforeID uuid.UUID
}

const documentColumns = `id,account_id,name,description,canvas_json,thumbnail_url,page_width,page_height,page_orientation,fields_used,created_by,created_at,updated_at,revision`

func scanDocument(row pgx.Row, t *domain.DocumentTemplate) error {
	return row.Scan(&t.ID, &t.AccountID, &t.Name, &t.Description, &t.CanvasJSON, &t.ThumbnailURL, &t.PageWidth, &t.PageHeight, &t.PageOrientation, &t.FieldsUsed, &t.CreatedBy, &t.CreatedAt, &t.UpdatedAt, &t.Revision)
}
func (r *DocumentTemplateRepository) Create(ctx context.Context, t *domain.DocumentTemplate) error {
	return scanDocument(r.db.QueryRow(ctx, `INSERT INTO document_templates(account_id,name,description,canvas_json,thumbnail_url,page_width,page_height,page_orientation,fields_used,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING `+documentColumns, t.AccountID, t.Name, t.Description, t.CanvasJSON, t.ThumbnailURL, t.PageWidth, t.PageHeight, t.PageOrientation, t.FieldsUsed, t.CreatedBy), t)
}
func (r *DocumentTemplateRepository) GetByID(ctx context.Context, id, account uuid.UUID) (*domain.DocumentTemplate, error) {
	t := &domain.DocumentTemplate{}
	err := scanDocument(r.db.QueryRow(ctx, `SELECT `+documentColumns+` FROM document_templates WHERE id=$1 AND account_id=$2`, id, account), t)
	return t, err
}
func (r *DocumentTemplateRepository) List(ctx context.Context, account uuid.UUID) ([]*domain.DocumentTemplate, error) {
	values, _, _, err := r.ListPage(ctx, account, DocumentTemplatePageFilter{Limit: 50})
	return values, err
}
func (r *DocumentTemplateRepository) ListPage(ctx context.Context, account uuid.UUID, f DocumentTemplatePageFilter) ([]*domain.DocumentTemplate, int, bool, error) {
	if f.Limit < 1 || f.Limit > 200 {
		f.Limit = 50
	}
	var total int
	if err := r.db.QueryRow(ctx, `SELECT count(*) FROM document_templates WHERE account_id=$1 AND ($2::text='' OR strpos(lower(name),lower($2::text))>0 OR strpos(lower(description),lower($2::text))>0)`, account, f.Query).Scan(&total); err != nil {
		return nil, 0, false, err
	}
	rows, err := r.db.Query(ctx, `SELECT id,account_id,name,description,'{}'::jsonb,thumbnail_url,page_width,page_height,page_orientation,fields_used,created_by,created_at,updated_at,revision FROM document_templates WHERE account_id=$1 AND ($2::text='' OR strpos(lower(name),lower($2::text))>0 OR strpos(lower(description),lower($2::text))>0) AND ($3::timestamptz IS NULL OR (updated_at,id)<($3::timestamptz,$4::uuid)) ORDER BY updated_at DESC,id DESC LIMIT $5`, account, f.Query, f.Before, f.BeforeID, f.Limit+1)
	if err != nil {
		return nil, 0, false, err
	}
	defer rows.Close()
	result := []*domain.DocumentTemplate{}
	for rows.Next() {
		t := &domain.DocumentTemplate{}
		if err = scanDocument(rows, t); err != nil {
			return nil, 0, false, err
		}
		result = append(result, t)
	}
	if err = rows.Err(); err != nil {
		return nil, 0, false, err
	}
	more := len(result) > f.Limit
	if more {
		result = result[:f.Limit]
	}
	return result, total, more, nil
}
func (r *DocumentTemplateRepository) Update(ctx context.Context, t *domain.DocumentTemplate, expected int64) error {
	err := scanDocument(r.db.QueryRow(ctx, `UPDATE document_templates SET name=$1,description=$2,canvas_json=$3,thumbnail_url=$4,page_width=$5,page_height=$6,page_orientation=$7,fields_used=$8,updated_at=NOW(),revision=revision+1 WHERE id=$9 AND account_id=$10 AND revision=$11 RETURNING `+documentColumns, t.Name, t.Description, t.CanvasJSON, t.ThumbnailURL, t.PageWidth, t.PageHeight, t.PageOrientation, t.FieldsUsed, t.ID, t.AccountID, expected), t)
	if errors.Is(err, pgx.ErrNoRows) {
		if _, e := r.GetByID(ctx, t.ID, t.AccountID); e != nil {
			return e
		}
		return ErrDocumentTemplateConflict
	}
	return err
}
func (r *DocumentTemplateRepository) Delete(ctx context.Context, id, account uuid.UUID, expected int64) error {
	result, err := r.db.Exec(ctx, `DELETE FROM document_templates WHERE id=$1 AND account_id=$2 AND revision=$3`, id, account, expected)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		if _, e := r.GetByID(ctx, id, account); e != nil {
			return e
		}
		return ErrDocumentTemplateConflict
	}
	return nil
}
func (r *DocumentTemplateRepository) Duplicate(ctx context.Context, id, account uuid.UUID, createdBy *uuid.UUID) (*domain.DocumentTemplate, error) {
	t := &domain.DocumentTemplate{}
	err := scanDocument(r.db.QueryRow(ctx, `INSERT INTO document_templates(account_id,name,description,canvas_json,thumbnail_url,page_width,page_height,page_orientation,fields_used,created_by) SELECT account_id,left(name,190)||' (copia)',description,canvas_json,thumbnail_url,page_width,page_height,page_orientation,fields_used,$3 FROM document_templates WHERE id=$1 AND account_id=$2 RETURNING `+documentColumns, id, account, createdBy), t)
	return t, err
}
