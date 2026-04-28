package repository

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
)

type CustomFieldRepository struct {
	db *pgxpool.Pool
}

// --- Definitions ---

func (r *CustomFieldRepository) CreateDefinition(ctx context.Context, d *domain.CustomFieldDefinition) error {
	return r.db.QueryRow(ctx, `
		INSERT INTO custom_field_definitions (account_id, name, slug, field_type, config, is_required, default_value, sort_order)
		VALUES ($1, $2, $3, $4, $5, $6, $7, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM custom_field_definitions WHERE account_id = $1))
		RETURNING id, sort_order, created_at, updated_at
	`, d.AccountID, d.Name, d.Slug, d.FieldType, d.Config, d.IsRequired, d.DefaultValue).Scan(
		&d.ID, &d.SortOrder, &d.CreatedAt, &d.UpdatedAt,
	)
}

func (r *CustomFieldRepository) GetDefinitionsByAccountID(ctx context.Context, accountID uuid.UUID) ([]*domain.CustomFieldDefinition, error) {
	rows, err := r.db.Query(ctx, `
		SELECT id, account_id, name, slug, field_type, config, is_required, default_value, sort_order, created_at, updated_at
		FROM custom_field_definitions
		WHERE account_id = $1
		ORDER BY sort_order ASC, created_at ASC
	`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var defs []*domain.CustomFieldDefinition
	for rows.Next() {
		d := &domain.CustomFieldDefinition{}
		if err := rows.Scan(&d.ID, &d.AccountID, &d.Name, &d.Slug, &d.FieldType, &d.Config, &d.IsRequired, &d.DefaultValue, &d.SortOrder, &d.CreatedAt, &d.UpdatedAt); err != nil {
			return nil, err
		}
		defs = append(defs, d)
	}
	return defs, nil
}

func (r *CustomFieldRepository) GetDefinitionByID(ctx context.Context, accountID, id uuid.UUID) (*domain.CustomFieldDefinition, error) {
	d := &domain.CustomFieldDefinition{}
	err := r.db.QueryRow(ctx, `
		SELECT id, account_id, name, slug, field_type, config, is_required, default_value, sort_order, created_at, updated_at
		FROM custom_field_definitions
		WHERE id = $1 AND account_id = $2
	`, id, accountID).Scan(&d.ID, &d.AccountID, &d.Name, &d.Slug, &d.FieldType, &d.Config, &d.IsRequired, &d.DefaultValue, &d.SortOrder, &d.CreatedAt, &d.UpdatedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	return d, err
}

func (r *CustomFieldRepository) UpdateDefinition(ctx context.Context, d *domain.CustomFieldDefinition) error {
	_, err := r.db.Exec(ctx, `
		UPDATE custom_field_definitions
		SET name = $1, config = $2, is_required = $3, default_value = $4, updated_at = NOW()
		WHERE id = $5 AND account_id = $6
	`, d.Name, d.Config, d.IsRequired, d.DefaultValue, d.ID, d.AccountID)
	return err
}

func (r *CustomFieldRepository) DeleteDefinition(ctx context.Context, accountID, id uuid.UUID) error {
	_, err := r.db.Exec(ctx, `
		DELETE FROM custom_field_definitions WHERE id = $1 AND account_id = $2
	`, id, accountID)
	return err
}

func (r *CustomFieldRepository) ReorderDefinitions(ctx context.Context, accountID uuid.UUID, orderedIDs []uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	for i, id := range orderedIDs {
		_, err := tx.Exec(ctx, `
			UPDATE custom_field_definitions SET sort_order = $1, updated_at = NOW()
			WHERE id = $2 AND account_id = $3
		`, i, id, accountID)
		if err != nil {
			return err
		}
	}

	return tx.Commit(ctx)
}

func (r *CustomFieldRepository) CountByAccountID(ctx context.Context, accountID uuid.UUID) (int, error) {
	var count int
	err := r.db.QueryRow(ctx, `
		SELECT COUNT(*) FROM custom_field_definitions WHERE account_id = $1
	`, accountID).Scan(&count)
	return count, err
}

func (r *CustomFieldRepository) NameExistsForAccount(ctx context.Context, accountID uuid.UUID, name string, excludeID *uuid.UUID) (bool, error) {
	var exists bool
	if excludeID != nil {
		err := r.db.QueryRow(ctx, `
			SELECT EXISTS(SELECT 1 FROM custom_field_definitions WHERE account_id = $1 AND LOWER(name) = LOWER($2) AND id != $3)
		`, accountID, name, *excludeID).Scan(&exists)
		return exists, err
	}
	err := r.db.QueryRow(ctx, `
		SELECT EXISTS(SELECT 1 FROM custom_field_definitions WHERE account_id = $1 AND LOWER(name) = LOWER($2))
	`, accountID, name).Scan(&exists)
	return exists, err
}

func (r *CustomFieldRepository) HasValues(ctx context.Context, fieldID uuid.UUID) (bool, error) {
	var exists bool
	err := r.db.QueryRow(ctx, `
		SELECT EXISTS(SELECT 1 FROM custom_field_values WHERE field_id = $1 LIMIT 1)
	`, fieldID).Scan(&exists)
	return exists, err
}

// --- Values ---

func (r *CustomFieldRepository) UpsertValue(ctx context.Context, v *domain.CustomFieldValue) error {
	return r.db.QueryRow(ctx, `
		INSERT INTO custom_field_values (field_id, contact_id, value_text, value_number, value_date, value_bool, value_json)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (field_id, contact_id) DO UPDATE SET
			value_text = EXCLUDED.value_text,
			value_number = EXCLUDED.value_number,
			value_date = EXCLUDED.value_date,
			value_bool = EXCLUDED.value_bool,
			value_json = EXCLUDED.value_json,
			updated_at = NOW()
		RETURNING id, created_at, updated_at
	`, v.FieldID, v.ContactID, v.ValueText, v.ValueNumber, v.ValueDate, v.ValueBool, v.ValueJSON).Scan(
		&v.ID, &v.CreatedAt, &v.UpdatedAt,
	)
}

func (r *CustomFieldRepository) GetValuesByContact(ctx context.Context, contactID uuid.UUID) ([]*domain.CustomFieldValue, error) {
	rows, err := r.db.Query(ctx, `
		SELECT v.id, v.field_id, v.contact_id, v.value_text, v.value_number, v.value_date, v.value_bool, v.value_json, v.created_at, v.updated_at,
			d.name AS field_name, d.slug AS field_slug, d.field_type
		FROM custom_field_values v
		JOIN custom_field_definitions d ON d.id = v.field_id
		WHERE v.contact_id = $1
		ORDER BY d.sort_order ASC
	`, contactID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var values []*domain.CustomFieldValue
	for rows.Next() {
		v := &domain.CustomFieldValue{}
		if err := rows.Scan(&v.ID, &v.FieldID, &v.ContactID, &v.ValueText, &v.ValueNumber, &v.ValueDate, &v.ValueBool, &v.ValueJSON, &v.CreatedAt, &v.UpdatedAt,
			&v.FieldName, &v.FieldSlug, &v.FieldType); err != nil {
			return nil, err
		}
		values = append(values, v)
	}
	return values, nil
}

func (r *CustomFieldRepository) GetValuesByContacts(ctx context.Context, contactIDs []uuid.UUID) (map[uuid.UUID][]*domain.CustomFieldValue, error) {
	if len(contactIDs) == 0 {
		return make(map[uuid.UUID][]*domain.CustomFieldValue), nil
	}

	// Build parameterized IN clause
	params := make([]interface{}, len(contactIDs))
	placeholders := make([]string, len(contactIDs))
	for i, id := range contactIDs {
		params[i] = id
		placeholders[i] = fmt.Sprintf("$%d", i+1)
	}

	query := fmt.Sprintf(`
		SELECT v.id, v.field_id, v.contact_id, v.value_text, v.value_number, v.value_date, v.value_bool, v.value_json, v.created_at, v.updated_at,
			d.name AS field_name, d.slug AS field_slug, d.field_type
		FROM custom_field_values v
		JOIN custom_field_definitions d ON d.id = v.field_id
		WHERE v.contact_id IN (%s)
		ORDER BY d.sort_order ASC
	`, strings.Join(placeholders, ","))

	rows, err := r.db.Query(ctx, query, params...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make(map[uuid.UUID][]*domain.CustomFieldValue)
	for rows.Next() {
		v := &domain.CustomFieldValue{}
		if err := rows.Scan(&v.ID, &v.FieldID, &v.ContactID, &v.ValueText, &v.ValueNumber, &v.ValueDate, &v.ValueBool, &v.ValueJSON, &v.CreatedAt, &v.UpdatedAt,
			&v.FieldName, &v.FieldSlug, &v.FieldType); err != nil {
			return nil, err
		}
		result[v.ContactID] = append(result[v.ContactID], v)
	}
	return result, nil
}

func (r *CustomFieldRepository) DeleteValue(ctx context.Context, fieldID, contactID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `
		DELETE FROM custom_field_values WHERE field_id = $1 AND contact_id = $2
	`, fieldID, contactID)
	return err
}

// --- Custom Field Filtering ---

// CustomFieldFilterParam represents a single filter condition for custom fields
type CustomFieldFilterParam struct {
	FieldID  uuid.UUID   `json:"field_id"`
	Operator string      `json:"operator"`
	Value    interface{} `json:"value"`
}

// BuildCustomFieldFilterSQL generates WHERE clauses and JOINs for custom field filtering.
// Returns the JOIN clause, WHERE conditions, and parameters starting from argNum.
func (r *CustomFieldRepository) BuildCustomFieldFilterSQL(filters []CustomFieldFilterParam, argNum int) (joins string, conditions []string, params []interface{}) {
	for i, f := range filters {
		alias := fmt.Sprintf("cfv%d", i)
		joins += fmt.Sprintf(" JOIN custom_field_values %s ON %s.contact_id = c.id AND %s.field_id = $%d", alias, alias, alias, argNum)
		params = append(params, f.FieldID)
		argNum++

		switch f.Operator {
		case "eq":
			conditions = append(conditions, fmt.Sprintf("(%s.value_text = $%d OR %s.value_number = $%d::numeric OR %s.value_bool = $%d::boolean)", alias, argNum, alias, argNum, alias, argNum))
			params = append(params, f.Value)
			argNum++
		case "neq":
			conditions = append(conditions, fmt.Sprintf("(%s.value_text IS DISTINCT FROM $%d AND %s.value_number IS DISTINCT FROM $%d::numeric)", alias, argNum, alias, argNum))
			params = append(params, f.Value)
			argNum++
		case "gt":
			conditions = append(conditions, fmt.Sprintf("(%s.value_number > $%d::numeric OR %s.value_date > $%d::timestamptz)", alias, argNum, alias, argNum))
			params = append(params, f.Value)
			argNum++
		case "lt":
			conditions = append(conditions, fmt.Sprintf("(%s.value_number < $%d::numeric OR %s.value_date < $%d::timestamptz)", alias, argNum, alias, argNum))
			params = append(params, f.Value)
			argNum++
		case "gte":
			conditions = append(conditions, fmt.Sprintf("(%s.value_number >= $%d::numeric OR %s.value_date >= $%d::timestamptz)", alias, argNum, alias, argNum))
			params = append(params, f.Value)
			argNum++
		case "lte":
			conditions = append(conditions, fmt.Sprintf("(%s.value_number <= $%d::numeric OR %s.value_date <= $%d::timestamptz)", alias, argNum, alias, argNum))
			params = append(params, f.Value)
			argNum++
		case "contains":
			conditions = append(conditions, fmt.Sprintf("%s.value_text ILIKE '%%' || $%d || '%%'", alias, argNum))
			params = append(params, f.Value)
			argNum++
		case "starts_with":
			conditions = append(conditions, fmt.Sprintf("%s.value_text ILIKE $%d || '%%'", alias, argNum))
			params = append(params, f.Value)
			argNum++
		case "in":
			// Value should be a JSON array of strings
			conditions = append(conditions, fmt.Sprintf("%s.value_text = ANY($%d::text[])", alias, argNum))
			params = append(params, f.Value)
			argNum++
		case "contains_any":
			// For multi_select: value_json has any of the given values
			conditions = append(conditions, fmt.Sprintf("%s.value_json ?| $%d::text[]", alias, argNum))
			params = append(params, f.Value)
			argNum++
		case "contains_all":
			// For multi_select: value_json has all of the given values
			conditions = append(conditions, fmt.Sprintf("%s.value_json ?& $%d::text[]", alias, argNum))
			params = append(params, f.Value)
			argNum++
		case "is_empty":
			conditions = append(conditions, fmt.Sprintf("(%s.value_text IS NULL AND %s.value_number IS NULL AND %s.value_date IS NULL AND %s.value_bool IS NULL AND %s.value_json IS NULL)", alias, alias, alias, alias, alias))
		case "is_not_empty":
			conditions = append(conditions, fmt.Sprintf("(%s.value_text IS NOT NULL OR %s.value_number IS NOT NULL OR %s.value_date IS NOT NULL OR %s.value_bool IS NOT NULL OR %s.value_json IS NOT NULL)", alias, alias, alias, alias, alias))
		}
	}
	return joins, conditions, params
}

// FindContactIDsByFilters returns contact IDs that match all custom field filter conditions.
func (r *CustomFieldRepository) FindContactIDsByFilters(ctx context.Context, accountID uuid.UUID, filters []CustomFieldFilterParam) ([]uuid.UUID, error) {
	if len(filters) == 0 {
		return nil, nil
	}

	query := "SELECT DISTINCT c.id FROM contacts c"
	args := []interface{}{accountID}
	argNum := 2

	joins, conditions, joinParams := r.BuildCustomFieldFilterSQL(filters, argNum)
	query += joins
	args = append(args, joinParams...)
	argNum += len(joinParams)

	query += " WHERE c.account_id = $1"
	for _, cond := range conditions {
		query += " AND " + cond
	}

	rows, err := r.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var ids []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, nil
}

// GetValueForDisplay returns the display-ready value based on field type
func GetValueForDisplay(v *domain.CustomFieldValue) interface{} {
	if v == nil {
		return nil
	}
	switch v.FieldType {
	case "text", "email", "phone", "url", "select":
		if v.ValueText != nil {
			return *v.ValueText
		}
	case "number", "currency":
		if v.ValueNumber != nil {
			return *v.ValueNumber
		}
	case "date":
		if v.ValueDate != nil {
			return v.ValueDate.Format(time.RFC3339)
		}
	case "checkbox":
		if v.ValueBool != nil {
			return *v.ValueBool
		}
	case "multi_select":
		if v.ValueJSON != nil {
			var arr []string
			if err := json.Unmarshal(v.ValueJSON, &arr); err == nil {
				return arr
			}
		}
	}
	return nil
}
