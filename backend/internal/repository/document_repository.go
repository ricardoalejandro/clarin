package repository

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
)

type DocumentTemplateRepository struct {
	db *pgxpool.Pool
}

func (r *DocumentTemplateRepository) Create(ctx context.Context, t *domain.DocumentTemplate) error {
	return r.db.QueryRow(ctx, `
		INSERT INTO document_templates (account_id, name, description, canvas_json, thumbnail_url,
			page_width, page_height, page_orientation, fields_used, created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
		RETURNING id, created_at, updated_at
	`, t.AccountID, t.Name, t.Description, t.CanvasJSON, t.ThumbnailURL,
		t.PageWidth, t.PageHeight, t.PageOrientation, t.FieldsUsed, t.CreatedBy,
	).Scan(&t.ID, &t.CreatedAt, &t.UpdatedAt)
}

func (r *DocumentTemplateRepository) GetByID(ctx context.Context, id, accountID uuid.UUID) (*domain.DocumentTemplate, error) {
	t := &domain.DocumentTemplate{}
	err := r.db.QueryRow(ctx, `
		SELECT id, account_id, name, description, canvas_json, thumbnail_url,
			page_width, page_height, page_orientation, fields_used, created_by, created_at, updated_at
		FROM document_templates
		WHERE id = $1 AND account_id = $2
	`, id, accountID).Scan(
		&t.ID, &t.AccountID, &t.Name, &t.Description, &t.CanvasJSON, &t.ThumbnailURL,
		&t.PageWidth, &t.PageHeight, &t.PageOrientation, &t.FieldsUsed, &t.CreatedBy, &t.CreatedAt, &t.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	return t, nil
}

func (r *DocumentTemplateRepository) List(ctx context.Context, accountID uuid.UUID) ([]*domain.DocumentTemplate, error) {
	rows, err := r.db.Query(ctx, `
		SELECT id, account_id, name, description, thumbnail_url,
			page_width, page_height, page_orientation, fields_used, created_by, created_at, updated_at
		FROM document_templates
		WHERE account_id = $1
		ORDER BY updated_at DESC
	`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var templates []*domain.DocumentTemplate
	for rows.Next() {
		t := &domain.DocumentTemplate{}
		if err := rows.Scan(
			&t.ID, &t.AccountID, &t.Name, &t.Description, &t.ThumbnailURL,
			&t.PageWidth, &t.PageHeight, &t.PageOrientation, &t.FieldsUsed, &t.CreatedBy, &t.CreatedAt, &t.UpdatedAt,
		); err != nil {
			return nil, err
		}
		templates = append(templates, t)
	}
	return templates, nil
}

func (r *DocumentTemplateRepository) Update(ctx context.Context, t *domain.DocumentTemplate) error {
	_, err := r.db.Exec(ctx, `
		UPDATE document_templates
		SET name=$1, description=$2, canvas_json=$3, thumbnail_url=$4,
			page_width=$5, page_height=$6, page_orientation=$7, fields_used=$8, updated_at=NOW()
		WHERE id=$9 AND account_id=$10
	`, t.Name, t.Description, t.CanvasJSON, t.ThumbnailURL,
		t.PageWidth, t.PageHeight, t.PageOrientation, t.FieldsUsed, t.ID, t.AccountID,
	)
	return err
}

func (r *DocumentTemplateRepository) Delete(ctx context.Context, id, accountID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `DELETE FROM document_templates WHERE id=$1 AND account_id=$2`, id, accountID)
	return err
}

func (r *DocumentTemplateRepository) Duplicate(ctx context.Context, id, accountID uuid.UUID, createdBy *uuid.UUID) (*domain.DocumentTemplate, error) {
	t := &domain.DocumentTemplate{}
	err := r.db.QueryRow(ctx, `
		INSERT INTO document_templates (account_id, name, description, canvas_json, thumbnail_url,
			page_width, page_height, page_orientation, fields_used, created_by)
		SELECT account_id, name || ' (copia)', description, canvas_json, thumbnail_url,
			page_width, page_height, page_orientation, fields_used, $3
		FROM document_templates WHERE id=$1 AND account_id=$2
		RETURNING id, account_id, name, description, canvas_json, thumbnail_url,
			page_width, page_height, page_orientation, fields_used, created_by, created_at, updated_at
	`, id, accountID, createdBy).Scan(
		&t.ID, &t.AccountID, &t.Name, &t.Description, &t.CanvasJSON, &t.ThumbnailURL,
		&t.PageWidth, &t.PageHeight, &t.PageOrientation, &t.FieldsUsed, &t.CreatedBy, &t.CreatedAt, &t.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	return t, nil
}
