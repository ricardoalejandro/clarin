package repository

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
)

type DynamicRepository struct {
	db *pgxpool.Pool
}

// ─── Dynamic CRUD ─────────────────────────────────────────────────────────────

func (r *DynamicRepository) Create(ctx context.Context, d *domain.Dynamic) error {
	configJSON, _ := json.Marshal(d.Config)
	return r.db.QueryRow(ctx, `
		INSERT INTO dynamics (account_id, type, name, slug, description, config, is_active)
		VALUES ($1,$2,$3,$4,$5,$6,$7)
		RETURNING id, created_at, updated_at
	`, d.AccountID, d.Type, d.Name, d.Slug, d.Description, configJSON, d.IsActive,
	).Scan(&d.ID, &d.CreatedAt, &d.UpdatedAt)
}

func (r *DynamicRepository) GetByID(ctx context.Context, id, accountID uuid.UUID) (*domain.Dynamic, error) {
	d := &domain.Dynamic{}
	var configJSON []byte
	err := r.db.QueryRow(ctx, `
		SELECT d.id, d.account_id, d.type, d.name, d.slug, d.description, d.config, d.is_active, d.created_at, d.updated_at,
			(SELECT COUNT(*) FROM dynamic_items WHERE dynamic_id = d.id) AS item_count
		FROM dynamics d
		WHERE d.id = $1 AND d.account_id = $2
	`, id, accountID).Scan(
		&d.ID, &d.AccountID, &d.Type, &d.Name, &d.Slug, &d.Description, &configJSON, &d.IsActive, &d.CreatedAt, &d.UpdatedAt,
		&d.ItemCount,
	)
	if err != nil {
		return nil, err
	}
	_ = json.Unmarshal(configJSON, &d.Config)
	return d, nil
}

func (r *DynamicRepository) List(ctx context.Context, accountID uuid.UUID) ([]*domain.Dynamic, error) {
	rows, err := r.db.Query(ctx, `
		SELECT d.id, d.account_id, d.type, d.name, d.slug, d.description, d.config, d.is_active, d.created_at, d.updated_at,
			(SELECT COUNT(*) FROM dynamic_items WHERE dynamic_id = d.id) AS item_count
		FROM dynamics d
		WHERE d.account_id = $1
		ORDER BY d.created_at DESC
	`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var dynamics []*domain.Dynamic
	for rows.Next() {
		d := &domain.Dynamic{}
		var configJSON []byte
		if err := rows.Scan(
			&d.ID, &d.AccountID, &d.Type, &d.Name, &d.Slug, &d.Description, &configJSON, &d.IsActive, &d.CreatedAt, &d.UpdatedAt,
			&d.ItemCount,
		); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(configJSON, &d.Config)
		dynamics = append(dynamics, d)
	}
	return dynamics, nil
}

func (r *DynamicRepository) Update(ctx context.Context, d *domain.Dynamic) error {
	configJSON, _ := json.Marshal(d.Config)
	_, err := r.db.Exec(ctx, `
		UPDATE dynamics SET name=$1, description=$2, slug=$3, config=$4, is_active=$5, updated_at=NOW()
		WHERE id=$6 AND account_id=$7
	`, d.Name, d.Description, d.Slug, configJSON, d.IsActive, d.ID, d.AccountID)
	return err
}

func (r *DynamicRepository) Delete(ctx context.Context, id, accountID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `DELETE FROM dynamics WHERE id=$1 AND account_id=$2`, id, accountID)
	return err
}

func (r *DynamicRepository) SetActive(ctx context.Context, id, accountID uuid.UUID, active bool) error {
	_, err := r.db.Exec(ctx, `UPDATE dynamics SET is_active=$1, updated_at=NOW() WHERE id=$2 AND account_id=$3`, active, id, accountID)
	return err
}

func (r *DynamicRepository) SlugExists(ctx context.Context, slug string, excludeID *uuid.UUID) (bool, error) {
	var exists bool
	if excludeID != nil {
		err := r.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM dynamics WHERE slug=$1 AND id!=$2)`, slug, *excludeID).Scan(&exists)
		return exists, err
	}
	err := r.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM dynamics WHERE slug=$1)`, slug).Scan(&exists)
	return exists, err
}

func (r *DynamicRepository) GetBySlug(ctx context.Context, slug string) (*domain.Dynamic, error) {
	d := &domain.Dynamic{}
	var configJSON []byte
	err := r.db.QueryRow(ctx, `
		SELECT d.id, d.account_id, d.type, d.name, d.slug, d.description, d.config, d.is_active, d.created_at, d.updated_at,
			(SELECT COUNT(*) FROM dynamic_items WHERE dynamic_id = d.id) AS item_count
		FROM dynamics d
		WHERE d.slug = $1 AND d.is_active = TRUE
	`, slug).Scan(
		&d.ID, &d.AccountID, &d.Type, &d.Name, &d.Slug, &d.Description, &configJSON, &d.IsActive, &d.CreatedAt, &d.UpdatedAt,
		&d.ItemCount,
	)
	if err != nil {
		return nil, err
	}
	_ = json.Unmarshal(configJSON, &d.Config)
	return d, nil
}

// ─── Dynamic Items ────────────────────────────────────────────────────────────

func (r *DynamicRepository) CreateItem(ctx context.Context, item *domain.DynamicItem) error {
	return r.db.QueryRow(ctx, `
		INSERT INTO dynamic_items (dynamic_id, image_url, thought_text, author, tipo, file_size, sort_order, is_active)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
		RETURNING id, created_at
	`, item.DynamicID, item.ImageURL, item.ThoughtText, item.Author, item.Tipo, item.FileSize, item.SortOrder, item.IsActive,
	).Scan(&item.ID, &item.CreatedAt)
}

func (r *DynamicRepository) ListItems(ctx context.Context, dynamicID uuid.UUID) ([]*domain.DynamicItem, error) {
	rows, err := r.db.Query(ctx, `
		SELECT di.id, di.dynamic_id, di.image_url, di.thought_text, di.author, di.tipo, di.file_size, di.sort_order, di.is_active, di.created_at,
			COALESCE(array_agg(dio.option_id) FILTER (WHERE dio.option_id IS NOT NULL), '{}') AS option_ids
		FROM dynamic_items di
		LEFT JOIN dynamic_item_options dio ON dio.item_id = di.id
		WHERE di.dynamic_id = $1
		GROUP BY di.id
		ORDER BY di.sort_order ASC, di.created_at ASC
	`, dynamicID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var items []*domain.DynamicItem
	for rows.Next() {
		item := &domain.DynamicItem{}
		if err := rows.Scan(&item.ID, &item.DynamicID, &item.ImageURL, &item.ThoughtText, &item.Author, &item.Tipo, &item.FileSize, &item.SortOrder, &item.IsActive, &item.CreatedAt, &item.OptionIDs); err != nil {
			return nil, err
		}
		if item.OptionIDs == nil {
			item.OptionIDs = []uuid.UUID{}
		}
		items = append(items, item)
	}
	return items, nil
}

func (r *DynamicRepository) UpdateItem(ctx context.Context, item *domain.DynamicItem) error {
	_, err := r.db.Exec(ctx, `
		UPDATE dynamic_items SET image_url=$1, thought_text=$2, author=$3, tipo=$4, sort_order=$5, is_active=$6
		WHERE id=$7 AND dynamic_id=$8
	`, item.ImageURL, item.ThoughtText, item.Author, item.Tipo, item.SortOrder, item.IsActive, item.ID, item.DynamicID)
	return err
}

func (r *DynamicRepository) DeleteItem(ctx context.Context, id, dynamicID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `DELETE FROM dynamic_items WHERE id=$1 AND dynamic_id=$2`, id, dynamicID)
	return err
}

func (r *DynamicRepository) DeleteItems(ctx context.Context, dynamicID uuid.UUID, itemIDs []uuid.UUID) error {
	_, err := r.db.Exec(ctx, `DELETE FROM dynamic_items WHERE dynamic_id=$1 AND id = ANY($2)`, dynamicID, itemIDs)
	return err
}

func (r *DynamicRepository) ReorderItems(ctx context.Context, dynamicID uuid.UUID, itemIDs []uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	for i, id := range itemIDs {
		if _, err := tx.Exec(ctx, `UPDATE dynamic_items SET sort_order=$1 WHERE id=$2 AND dynamic_id=$3`, i, id, dynamicID); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (r *DynamicRepository) ListActiveItems(ctx context.Context, dynamicID uuid.UUID) ([]*domain.DynamicItem, error) {
	rows, err := r.db.Query(ctx, `
		SELECT di.id, di.dynamic_id, di.image_url, di.thought_text, di.author, di.tipo, di.file_size, di.sort_order, di.is_active, di.created_at,
			COALESCE(array_agg(dio.option_id) FILTER (WHERE dio.option_id IS NOT NULL), '{}') AS option_ids
		FROM dynamic_items di
		LEFT JOIN dynamic_item_options dio ON dio.item_id = di.id
		WHERE di.dynamic_id = $1 AND di.is_active = TRUE
		GROUP BY di.id
		ORDER BY di.sort_order ASC, di.created_at ASC
	`, dynamicID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var items []*domain.DynamicItem
	for rows.Next() {
		item := &domain.DynamicItem{}
		if err := rows.Scan(&item.ID, &item.DynamicID, &item.ImageURL, &item.ThoughtText, &item.Author, &item.Tipo, &item.FileSize, &item.SortOrder, &item.IsActive, &item.CreatedAt, &item.OptionIDs); err != nil {
			return nil, err
		}
		if item.OptionIDs == nil {
			item.OptionIDs = []uuid.UUID{}
		}
		items = append(items, item)
	}
	return items, nil
}

// ─── Dynamic Options ──────────────────────────────────────────────────────────

func (r *DynamicRepository) CreateOption(ctx context.Context, opt *domain.DynamicOption) error {
	return r.db.QueryRow(ctx, `
		INSERT INTO dynamic_options (dynamic_id, name, emoji, sort_order)
		VALUES ($1,$2,$3,$4)
		RETURNING id, created_at
	`, opt.DynamicID, opt.Name, opt.Emoji, opt.SortOrder).Scan(&opt.ID, &opt.CreatedAt)
}

func (r *DynamicRepository) ListOptions(ctx context.Context, dynamicID uuid.UUID) ([]*domain.DynamicOption, error) {
	rows, err := r.db.Query(ctx, `
		SELECT o.id, o.dynamic_id, o.name, o.emoji, o.sort_order, o.created_at,
			(SELECT COUNT(DISTINCT dio.item_id) FROM dynamic_item_options dio
			 JOIN dynamic_items di ON di.id = dio.item_id
			 WHERE dio.option_id = o.id AND di.is_active = TRUE) AS item_count
		FROM dynamic_options o
		WHERE o.dynamic_id = $1
		ORDER BY o.sort_order ASC, o.created_at ASC
	`, dynamicID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var opts []*domain.DynamicOption
	for rows.Next() {
		o := &domain.DynamicOption{}
		if err := rows.Scan(&o.ID, &o.DynamicID, &o.Name, &o.Emoji, &o.SortOrder, &o.CreatedAt, &o.ItemCount); err != nil {
			return nil, err
		}
		opts = append(opts, o)
	}
	return opts, nil
}

func (r *DynamicRepository) UpdateOption(ctx context.Context, opt *domain.DynamicOption) error {
	_, err := r.db.Exec(ctx, `
		UPDATE dynamic_options SET name=$1, emoji=$2, sort_order=$3
		WHERE id=$4 AND dynamic_id=$5
	`, opt.Name, opt.Emoji, opt.SortOrder, opt.ID, opt.DynamicID)
	return err
}

func (r *DynamicRepository) DeleteOption(ctx context.Context, id, dynamicID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `DELETE FROM dynamic_options WHERE id=$1 AND dynamic_id=$2`, id, dynamicID)
	return err
}

func (r *DynamicRepository) ReorderOptions(ctx context.Context, dynamicID uuid.UUID, optionIDs []uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	for i, id := range optionIDs {
		if _, err := tx.Exec(ctx, `UPDATE dynamic_options SET sort_order=$1 WHERE id=$2 AND dynamic_id=$3`, i, id, dynamicID); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// ─── Dynamic Links ────────────────────────────────────────────────────────────

func (r *DynamicRepository) CreateLink(ctx context.Context, link *domain.DynamicLink) error {
	return r.db.QueryRow(ctx, `
		INSERT INTO dynamic_links (dynamic_id, slug, whatsapp_enabled, whatsapp_message, extra_message_text, extra_message_media_url, extra_message_media_type, is_active, starts_at, ends_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
		RETURNING id, created_at
	`, link.DynamicID, link.Slug, link.WhatsAppEnabled, link.WhatsAppMessage, link.ExtraMessageText, link.ExtraMessageMediaURL, link.ExtraMessageMediaType, link.IsActive, link.StartsAt, link.EndsAt,
	).Scan(&link.ID, &link.CreatedAt)
}

func (r *DynamicRepository) ListLinks(ctx context.Context, dynamicID uuid.UUID) ([]*domain.DynamicLink, error) {
	rows, err := r.db.Query(ctx, `
		SELECT id, dynamic_id, slug, whatsapp_enabled, whatsapp_message, extra_message_text, extra_message_media_url, extra_message_media_type, is_active, created_at, starts_at, ends_at
		FROM dynamic_links
		WHERE dynamic_id = $1
		ORDER BY created_at ASC
	`, dynamicID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var links []*domain.DynamicLink
	for rows.Next() {
		l := &domain.DynamicLink{}
		if err := rows.Scan(&l.ID, &l.DynamicID, &l.Slug, &l.WhatsAppEnabled, &l.WhatsAppMessage, &l.ExtraMessageText, &l.ExtraMessageMediaURL, &l.ExtraMessageMediaType, &l.IsActive, &l.CreatedAt, &l.StartsAt, &l.EndsAt); err != nil {
			return nil, err
		}
		links = append(links, l)
	}
	// Hydrate extra media for each link so edit forms and UI can display them.
	for _, l := range links {
		if media, mErr := r.ListExtraMedia(ctx, l.ID); mErr == nil {
			l.ExtraMedia = media
		}
	}
	return links, nil
}

func (r *DynamicRepository) UpdateLink(ctx context.Context, link *domain.DynamicLink) error {
	_, err := r.db.Exec(ctx, `
		UPDATE dynamic_links SET slug=$1, whatsapp_enabled=$2, whatsapp_message=$3, extra_message_text=$4, extra_message_media_url=$5, extra_message_media_type=$6, is_active=$7, starts_at=$8, ends_at=$9
		WHERE id=$10 AND dynamic_id=$11
	`, link.Slug, link.WhatsAppEnabled, link.WhatsAppMessage, link.ExtraMessageText, link.ExtraMessageMediaURL, link.ExtraMessageMediaType, link.IsActive, link.StartsAt, link.EndsAt, link.ID, link.DynamicID)
	return err
}

func (r *DynamicRepository) DeleteLink(ctx context.Context, id, dynamicID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `DELETE FROM dynamic_links WHERE id=$1 AND dynamic_id=$2`, id, dynamicID)
	return err
}

func (r *DynamicRepository) CountLinks(ctx context.Context, dynamicID uuid.UUID) (int, error) {
	var count int
	err := r.db.QueryRow(ctx, `SELECT COUNT(*) FROM dynamic_links WHERE dynamic_id=$1`, dynamicID).Scan(&count)
	return count, err
}

func (r *DynamicRepository) LinkSlugExists(ctx context.Context, slug string, excludeID *uuid.UUID) (bool, error) {
	var exists bool
	if excludeID != nil {
		err := r.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM dynamic_links WHERE slug=$1 AND id!=$2)`, slug, *excludeID).Scan(&exists)
		return exists, err
	}
	err := r.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM dynamic_links WHERE slug=$1)`, slug).Scan(&exists)
	return exists, err
}

// GetLinkBySlug resolves a public link by slug, returning the link + its parent dynamic
func (r *DynamicRepository) GetLinkBySlug(ctx context.Context, slug string) (*domain.DynamicLink, *domain.Dynamic, error) {
	// First try dynamic_links
	link := &domain.DynamicLink{}
	err := r.db.QueryRow(ctx, `
		SELECT id, dynamic_id, slug, whatsapp_enabled, whatsapp_message, extra_message_text, extra_message_media_url, extra_message_media_type, is_active, created_at, starts_at, ends_at
		FROM dynamic_links WHERE slug = $1 AND is_active = TRUE
	`, slug).Scan(&link.ID, &link.DynamicID, &link.Slug, &link.WhatsAppEnabled, &link.WhatsAppMessage, &link.ExtraMessageText, &link.ExtraMessageMediaURL, &link.ExtraMessageMediaType, &link.IsActive, &link.CreatedAt, &link.StartsAt, &link.EndsAt)
	if err != nil {
		return nil, nil, err
	}

	d := &domain.Dynamic{}
	var configJSON []byte
	err = r.db.QueryRow(ctx, `
		SELECT d.id, d.account_id, d.type, d.name, d.slug, d.description, d.config, d.is_active, d.created_at, d.updated_at,
			(SELECT COUNT(*) FROM dynamic_items WHERE dynamic_id = d.id) AS item_count
		FROM dynamics d WHERE d.id = $1 AND d.is_active = TRUE
	`, link.DynamicID).Scan(
		&d.ID, &d.AccountID, &d.Type, &d.Name, &d.Slug, &d.Description, &configJSON, &d.IsActive, &d.CreatedAt, &d.UpdatedAt,
		&d.ItemCount,
	)
	if err != nil {
		return nil, nil, err
	}
	_ = json.Unmarshal(configJSON, &d.Config)
	if media, mErr := r.ListExtraMedia(ctx, link.ID); mErr == nil {
		link.ExtraMedia = media
	}
	return link, d, nil
}

// GetLinkByID returns a link and its parent dynamic by link ID
func (r *DynamicRepository) GetLinkByID(ctx context.Context, linkID uuid.UUID) (*domain.DynamicLink, *domain.Dynamic, error) {
	link := &domain.DynamicLink{}
	err := r.db.QueryRow(ctx, `
		SELECT id, dynamic_id, slug, whatsapp_enabled, whatsapp_message, extra_message_text, extra_message_media_url, extra_message_media_type, is_active, created_at, starts_at, ends_at
		FROM dynamic_links WHERE id = $1
	`, linkID).Scan(&link.ID, &link.DynamicID, &link.Slug, &link.WhatsAppEnabled, &link.WhatsAppMessage, &link.ExtraMessageText, &link.ExtraMessageMediaURL, &link.ExtraMessageMediaType, &link.IsActive, &link.CreatedAt, &link.StartsAt, &link.EndsAt)
	if err != nil {
		return nil, nil, err
	}

	d := &domain.Dynamic{}
	var configJSON []byte
	err = r.db.QueryRow(ctx, `
		SELECT d.id, d.account_id, d.type, d.name, d.slug, d.description, d.config, d.is_active, d.created_at, d.updated_at,
			(SELECT COUNT(*) FROM dynamic_items WHERE dynamic_id = d.id) AS item_count
		FROM dynamics d WHERE d.id = $1
	`, link.DynamicID).Scan(
		&d.ID, &d.AccountID, &d.Type, &d.Name, &d.Slug, &d.Description, &configJSON, &d.IsActive, &d.CreatedAt, &d.UpdatedAt,
		&d.ItemCount,
	)
	if err != nil {
		return nil, nil, err
	}
	_ = json.Unmarshal(configJSON, &d.Config)
	if media, mErr := r.ListExtraMedia(ctx, link.ID); mErr == nil {
		link.ExtraMedia = media
	}
	return link, d, nil
}

// ─── Dynamic WhatsApp Queue ──────────────────────────────────────────────────

func (r *DynamicRepository) EnqueueWhatsApp(ctx context.Context, q *domain.DynamicWhatsAppQueue) error {
	return r.db.QueryRow(ctx, `
		INSERT INTO dynamic_whatsapp_queue (dynamic_id, account_id, link_id, phone, item_id, image_url, caption, extra_text, extra_media_url, extra_media_type, status)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending')
		RETURNING id, created_at
	`, q.DynamicID, q.AccountID, q.LinkID, q.Phone, q.ItemID, q.ImageURL, q.Caption, q.ExtraText, q.ExtraMediaURL, q.ExtraMediaType,
	).Scan(&q.ID, &q.CreatedAt)
}

// GetPendingWhatsApp returns up to `limit` pending messages for a given account, ordered by creation time
func (r *DynamicRepository) GetPendingWhatsApp(ctx context.Context, limit int) ([]*domain.DynamicWhatsAppQueue, error) {
	rows, err := r.db.Query(ctx, `
		SELECT id, dynamic_id, account_id, link_id, phone, item_id, image_url, caption, extra_text, extra_media_url, extra_media_type, status, created_at
		FROM dynamic_whatsapp_queue
		WHERE status = 'pending'
		ORDER BY created_at ASC
		LIMIT $1
	`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var items []*domain.DynamicWhatsAppQueue
	for rows.Next() {
		q := &domain.DynamicWhatsAppQueue{}
		if err := rows.Scan(&q.ID, &q.DynamicID, &q.AccountID, &q.LinkID, &q.Phone, &q.ItemID, &q.ImageURL, &q.Caption, &q.ExtraText, &q.ExtraMediaURL, &q.ExtraMediaType, &q.Status, &q.CreatedAt); err != nil {
			return nil, err
		}
		items = append(items, q)
	}
	return items, nil
}

func (r *DynamicRepository) UpdateWhatsAppStatus(ctx context.Context, id uuid.UUID, status, errorMsg string) error {
	if status == "sent" {
		now := time.Now()
		_, err := r.db.Exec(ctx, `
			UPDATE dynamic_whatsapp_queue SET status=$1, error_msg=$2, sent_at=$3 WHERE id=$4
		`, status, errorMsg, now, id)
		return err
	}
	_, err := r.db.Exec(ctx, `
		UPDATE dynamic_whatsapp_queue SET status=$1, error_msg=$2 WHERE id=$3
	`, status, errorMsg, id)
	return err
}

func (r *DynamicRepository) GetItemByID(ctx context.Context, id uuid.UUID) (*domain.DynamicItem, error) {
	item := &domain.DynamicItem{}
	err := r.db.QueryRow(ctx, `
		SELECT di.id, di.dynamic_id, di.image_url, di.thought_text, di.author, di.tipo, di.file_size, di.sort_order, di.is_active, di.created_at,
			COALESCE(array_agg(dio.option_id) FILTER (WHERE dio.option_id IS NOT NULL), '{}') AS option_ids
		FROM dynamic_items di
		LEFT JOIN dynamic_item_options dio ON dio.item_id = di.id
		WHERE di.id = $1
		GROUP BY di.id
	`, id).Scan(&item.ID, &item.DynamicID, &item.ImageURL, &item.ThoughtText, &item.Author, &item.Tipo, &item.FileSize, &item.SortOrder, &item.IsActive, &item.CreatedAt, &item.OptionIDs)
	if err != nil {
		return nil, err
	}
	if item.OptionIDs == nil {
		item.OptionIDs = []uuid.UUID{}
	}
	return item, nil
}

// SetItemOptions replaces all option associations for an item
func (r *DynamicRepository) SetItemOptions(ctx context.Context, itemID uuid.UUID, optionIDs []uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	_, err = tx.Exec(ctx, `DELETE FROM dynamic_item_options WHERE item_id = $1`, itemID)
	if err != nil {
		return err
	}

	for _, optID := range optionIDs {
		_, err = tx.Exec(ctx, `INSERT INTO dynamic_item_options (item_id, option_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, itemID, optID)
		if err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// BulkAssignOption adds or removes an option from multiple items at once
func (r *DynamicRepository) BulkAssignOption(ctx context.Context, itemIDs []uuid.UUID, optionID uuid.UUID, add bool) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if add {
		for _, itemID := range itemIDs {
			_, err = tx.Exec(ctx, `INSERT INTO dynamic_item_options (item_id, option_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, itemID, optionID)
			if err != nil {
				return err
			}
		}
	} else {
		_, err = tx.Exec(ctx, `DELETE FROM dynamic_item_options WHERE item_id = ANY($1) AND option_id = $2`, itemIDs, optionID)
		if err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// ─── Dynamic Link Registrations ──────────────────────────────────────────────

func (r *DynamicRepository) CreateRegistration(ctx context.Context, reg *domain.DynamicLinkRegistration) error {
	return r.db.QueryRow(ctx, `
		INSERT INTO dynamic_link_registrations (link_id, full_name, phone, age, contact_id, lead_id, whatsapp_status, whatsapp_error, session_token, shared_by_registration_id)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
		RETURNING id, created_at
	`, reg.LinkID, reg.FullName, reg.Phone, reg.Age, reg.ContactID, reg.LeadID, reg.WhatsAppStatus, reg.WhatsAppError, nullIfEmpty(reg.SessionToken), reg.SharedByRegistrationID,
	).Scan(&reg.ID, &reg.CreatedAt)
}

func nullIfEmpty(s string) interface{} {
	if s == "" {
		return nil
	}
	return s
}

func (r *DynamicRepository) RegistrationExistsByPhone(ctx context.Context, linkID uuid.UUID, phone string) (bool, error) {
	var exists bool
	err := r.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM dynamic_link_registrations WHERE link_id=$1 AND phone=$2)`, linkID, phone).Scan(&exists)
	return exists, err
}

func (r *DynamicRepository) GetRegistrationByPhone(ctx context.Context, linkID uuid.UUID, phone string) (*domain.DynamicLinkRegistration, error) {
	reg := &domain.DynamicLinkRegistration{}
	var sessionToken *string
	err := r.db.QueryRow(ctx, `
		SELECT id, link_id, full_name, phone, age, contact_id, lead_id, whatsapp_status, whatsapp_error, session_token, shared_by_registration_id, created_at
		FROM dynamic_link_registrations
		WHERE link_id=$1 AND phone=$2 AND shared_by_registration_id IS NULL
	`, linkID, phone).Scan(&reg.ID, &reg.LinkID, &reg.FullName, &reg.Phone, &reg.Age, &reg.ContactID, &reg.LeadID, &reg.WhatsAppStatus, &reg.WhatsAppError, &sessionToken, &reg.SharedByRegistrationID, &reg.CreatedAt)
	if err != nil {
		return nil, err
	}
	if sessionToken != nil {
		reg.SessionToken = *sessionToken
	}
	return reg, nil
}

func (r *DynamicRepository) GetRegistrationBySessionToken(ctx context.Context, token string) (*domain.DynamicLinkRegistration, error) {
	reg := &domain.DynamicLinkRegistration{}
	var sessionToken *string
	err := r.db.QueryRow(ctx, `
		SELECT id, link_id, full_name, phone, age, contact_id, lead_id, whatsapp_status, whatsapp_error, session_token, shared_by_registration_id, created_at
		FROM dynamic_link_registrations
		WHERE session_token=$1
	`, token).Scan(&reg.ID, &reg.LinkID, &reg.FullName, &reg.Phone, &reg.Age, &reg.ContactID, &reg.LeadID, &reg.WhatsAppStatus, &reg.WhatsAppError, &sessionToken, &reg.SharedByRegistrationID, &reg.CreatedAt)
	if err != nil {
		return nil, err
	}
	if sessionToken != nil {
		reg.SessionToken = *sessionToken
	}
	return reg, nil
}

func (r *DynamicRepository) UpdateRegistrationWhatsAppStatus(ctx context.Context, id uuid.UUID, status, errMsg string) error {
	_, err := r.db.Exec(ctx, `
		UPDATE dynamic_link_registrations SET whatsapp_status=$1, whatsapp_error=$2 WHERE id=$3
	`, status, errMsg, id)
	return err
}

func (r *DynamicRepository) ListRegistrationsByLink(ctx context.Context, linkID uuid.UUID) ([]*domain.DynamicLinkRegistration, error) {
	rows, err := r.db.Query(ctx, `
		SELECT id, link_id, full_name, phone, age, contact_id, lead_id, whatsapp_status, whatsapp_error, session_token, shared_by_registration_id, created_at
		FROM dynamic_link_registrations
		WHERE link_id = $1
		ORDER BY created_at DESC
	`, linkID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var regs []*domain.DynamicLinkRegistration
	for rows.Next() {
		reg := &domain.DynamicLinkRegistration{}
		var sessionToken *string
		if err := rows.Scan(&reg.ID, &reg.LinkID, &reg.FullName, &reg.Phone, &reg.Age, &reg.ContactID, &reg.LeadID, &reg.WhatsAppStatus, &reg.WhatsAppError, &sessionToken, &reg.SharedByRegistrationID, &reg.CreatedAt); err != nil {
			return nil, err
		}
		if sessionToken != nil {
			reg.SessionToken = *sessionToken
		}
		regs = append(regs, reg)
	}
	return regs, nil
}

func (r *DynamicRepository) CountRegistrationsByLink(ctx context.Context, linkID uuid.UUID) (int, error) {
	var count int
	err := r.db.QueryRow(ctx, `SELECT COUNT(*) FROM dynamic_link_registrations WHERE link_id=$1`, linkID).Scan(&count)
	return count, err
}

func (r *DynamicRepository) DeleteRegistration(ctx context.Context, id uuid.UUID) error {
	_, err := r.db.Exec(ctx, `DELETE FROM dynamic_link_registrations WHERE id=$1`, id)
	return err
}

// ─── Dynamic Link Extra Media (multi-image with captions) ────────────────────

func (r *DynamicRepository) ListExtraMedia(ctx context.Context, linkID uuid.UUID) ([]*domain.DynamicLinkExtraMedia, error) {
	rows, err := r.db.Query(ctx, `
		SELECT id, link_id, url, media_type, caption, sort_order, created_at
		FROM dynamic_link_extra_media
		WHERE link_id = $1
		ORDER BY sort_order ASC, created_at ASC
	`, linkID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var items []*domain.DynamicLinkExtraMedia
	for rows.Next() {
		m := &domain.DynamicLinkExtraMedia{}
		if err := rows.Scan(&m.ID, &m.LinkID, &m.URL, &m.MediaType, &m.Caption, &m.SortOrder, &m.CreatedAt); err != nil {
			return nil, err
		}
		items = append(items, m)
	}
	return items, nil
}

func (r *DynamicRepository) CountExtraMedia(ctx context.Context, linkID uuid.UUID) (int, error) {
	var n int
	err := r.db.QueryRow(ctx, `SELECT COUNT(*) FROM dynamic_link_extra_media WHERE link_id=$1`, linkID).Scan(&n)
	return n, err
}

func (r *DynamicRepository) CreateExtraMedia(ctx context.Context, m *domain.DynamicLinkExtraMedia) error {
	return r.db.QueryRow(ctx, `
		INSERT INTO dynamic_link_extra_media (link_id, url, media_type, caption, sort_order)
		VALUES ($1,$2,$3,$4,$5)
		RETURNING id, created_at
	`, m.LinkID, m.URL, m.MediaType, m.Caption, m.SortOrder,
	).Scan(&m.ID, &m.CreatedAt)
}

func (r *DynamicRepository) UpdateExtraMediaCaption(ctx context.Context, id, linkID uuid.UUID, caption string) error {
	_, err := r.db.Exec(ctx, `UPDATE dynamic_link_extra_media SET caption=$1 WHERE id=$2 AND link_id=$3`, caption, id, linkID)
	return err
}

func (r *DynamicRepository) GetExtraMediaByID(ctx context.Context, id, linkID uuid.UUID) (*domain.DynamicLinkExtraMedia, error) {
	m := &domain.DynamicLinkExtraMedia{}
	err := r.db.QueryRow(ctx, `
		SELECT id, link_id, url, media_type, caption, sort_order, created_at
		FROM dynamic_link_extra_media WHERE id=$1 AND link_id=$2
	`, id, linkID).Scan(&m.ID, &m.LinkID, &m.URL, &m.MediaType, &m.Caption, &m.SortOrder, &m.CreatedAt)
	if err != nil {
		return nil, err
	}
	return m, nil
}

func (r *DynamicRepository) DeleteExtraMedia(ctx context.Context, id, linkID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `DELETE FROM dynamic_link_extra_media WHERE id=$1 AND link_id=$2`, id, linkID)
	return err
}

// ReorderExtraMedia updates sort_order for each given id in sequence (0..N-1).
func (r *DynamicRepository) ReorderExtraMedia(ctx context.Context, linkID uuid.UUID, ids []uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	for i, id := range ids {
		if _, err := tx.Exec(ctx, `UPDATE dynamic_link_extra_media SET sort_order=$1 WHERE id=$2 AND link_id=$3`, i, id, linkID); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
