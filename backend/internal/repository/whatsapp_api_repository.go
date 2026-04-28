package repository

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
)

// WhatsAppAPIRepository handles Cloud API configuration, templates, webhooks and service windows.
type WhatsAppAPIRepository struct {
	db *pgxpool.Pool
}

type WhatsAppAPIOverview struct {
	CloudChannelCount int `json:"cloud_channel_count"`
	TemplateCount     int `json:"template_count"`
	ApprovedTemplates int `json:"approved_templates"`
	WebhookEventCount int `json:"webhook_event_count"`
	OpenWindowCount   int `json:"open_window_count"`
}

func (r *WhatsAppAPIRepository) GetCloudDeviceByPhoneNumberID(ctx context.Context, phoneNumberID string) (*domain.Device, error) {
	device := &domain.Device{}
	err := r.db.QueryRow(ctx, `
		SELECT id, account_id, name, phone, jid, status, qr_code, receive_messages, provider, waba_id,
			phone_number_id, api_display_phone, api_webhook_status, api_billing_status, api_sending_enabled,
			api_templates_enabled, capabilities, last_seen_at, created_at, updated_at
		FROM devices
		WHERE phone_number_id = $1 AND provider = $2
		LIMIT 1
	`, phoneNumberID, domain.DeviceProviderWhatsAppCloudAPI).Scan(
		&device.ID, &device.AccountID, &device.Name, &device.Phone, &device.JID,
		&device.Status, &device.QRCode, &device.ReceiveMessages, &device.Provider, &device.WABAID,
		&device.PhoneNumberID, &device.APIDisplayPhone, &device.APIWebhookStatus, &device.APIBillingStatus,
		&device.APISendingEnabled, &device.APITemplatesEnabled, &device.Capabilities, &device.LastSeenAt,
		&device.CreatedAt, &device.UpdatedAt,
	)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	return device, err
}

func (r *WhatsAppAPIRepository) UpdateDeviceWebhookStatus(ctx context.Context, deviceID uuid.UUID, status string) error {
	_, err := r.db.Exec(ctx, `
		UPDATE devices SET api_webhook_status = $1, updated_at = NOW() WHERE id = $2 AND provider = $3
	`, status, deviceID, domain.DeviceProviderWhatsAppCloudAPI)
	return err
}

func (r *WhatsAppAPIRepository) GetOverview(ctx context.Context, accountID uuid.UUID) (*WhatsAppAPIOverview, error) {
	overview := &WhatsAppAPIOverview{}
	err := r.db.QueryRow(ctx, `
		SELECT
			(SELECT COUNT(*) FROM devices WHERE account_id = $1 AND provider = 'whatsapp_cloud_api'),
			(SELECT COUNT(*) FROM whatsapp_message_templates WHERE account_id = $1),
			(SELECT COUNT(*) FROM whatsapp_message_templates WHERE account_id = $1 AND status = 'approved'),
			(SELECT COUNT(*) FROM whatsapp_webhook_events WHERE account_id = $1),
			(SELECT COUNT(*) FROM chats WHERE account_id = $1 AND customer_service_window_expires_at > NOW())
	`, accountID).Scan(&overview.CloudChannelCount, &overview.TemplateCount, &overview.ApprovedTemplates, &overview.WebhookEventCount, &overview.OpenWindowCount)
	return overview, err
}

func (r *WhatsAppAPIRepository) ListTemplates(ctx context.Context, accountID uuid.UUID) ([]*domain.WhatsAppMessageTemplate, error) {
	rows, err := r.db.Query(ctx, `
		SELECT id, account_id, device_id, name, language, category, status, components,
		       meta_template_id, rejection_reason, last_synced_at, created_at, updated_at
		FROM whatsapp_message_templates
		WHERE account_id = $1
		ORDER BY updated_at DESC
	`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var templates []*domain.WhatsAppMessageTemplate
	for rows.Next() {
		template, err := scanWhatsAppTemplate(rows)
		if err != nil {
			return nil, err
		}
		templates = append(templates, template)
	}
	return templates, rows.Err()
}

func (r *WhatsAppAPIRepository) GetTemplateByID(ctx context.Context, id, accountID uuid.UUID) (*domain.WhatsAppMessageTemplate, error) {
	template, err := scanWhatsAppTemplate(r.db.QueryRow(ctx, `
		SELECT id, account_id, device_id, name, language, category, status, components,
		       meta_template_id, rejection_reason, last_synced_at, created_at, updated_at
		FROM whatsapp_message_templates
		WHERE id = $1 AND account_id = $2
	`, id, accountID))
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	return template, err
}

func (r *WhatsAppAPIRepository) CreateTemplate(ctx context.Context, template *domain.WhatsAppMessageTemplate) error {
	components := template.Components
	if len(components) == 0 {
		components = json.RawMessage("[]")
	}
	return r.db.QueryRow(ctx, `
		INSERT INTO whatsapp_message_templates
			(account_id, device_id, name, language, category, status, components, meta_template_id, rejection_reason)
		VALUES ($1, $2, $3, $4, $5, COALESCE(NULLIF($6, ''), 'draft'), $7, $8, $9)
		RETURNING id, created_at, updated_at
	`, template.AccountID, template.DeviceID, template.Name, template.Language, template.Category, template.Status,
		components, template.MetaTemplateID, template.RejectionReason).Scan(&template.ID, &template.CreatedAt, &template.UpdatedAt)
}

func (r *WhatsAppAPIRepository) UpdateTemplate(ctx context.Context, template *domain.WhatsAppMessageTemplate) error {
	components := template.Components
	if len(components) == 0 {
		components = json.RawMessage("[]")
	}
	_, err := r.db.Exec(ctx, `
		UPDATE whatsapp_message_templates
		SET device_id = $1, name = $2, language = $3, category = $4, status = $5,
		    components = $6, meta_template_id = $7, rejection_reason = $8, updated_at = NOW()
		WHERE id = $9 AND account_id = $10
	`, template.DeviceID, template.Name, template.Language, template.Category, template.Status, components,
		template.MetaTemplateID, template.RejectionReason, template.ID, template.AccountID)
	return err
}

func (r *WhatsAppAPIRepository) DeleteTemplate(ctx context.Context, id, accountID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `DELETE FROM whatsapp_message_templates WHERE id = $1 AND account_id = $2`, id, accountID)
	return err
}

func (r *WhatsAppAPIRepository) CreateWebhookEvent(ctx context.Context, event *domain.WhatsAppWebhookEvent) error {
	payload := event.Payload
	if len(payload) == 0 {
		payload = json.RawMessage("{}")
	}
	_, err := r.db.Exec(ctx, `
		INSERT INTO whatsapp_webhook_events
			(account_id, device_id, phone_number_id, event_id, event_type, payload, processed, error_message)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		ON CONFLICT (event_id) DO NOTHING
	`, event.AccountID, event.DeviceID, event.PhoneNumberID, event.EventID, event.EventType, payload, event.Processed, event.ErrorMessage)
	return err
}

func (r *WhatsAppAPIRepository) ListWebhookEvents(ctx context.Context, accountID uuid.UUID, limit int) ([]*domain.WhatsAppWebhookEvent, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := r.db.Query(ctx, `
		SELECT id, account_id, device_id, phone_number_id, event_id, event_type, payload, processed, error_message, received_at
		FROM whatsapp_webhook_events
		WHERE account_id = $1
		ORDER BY received_at DESC
		LIMIT $2
	`, accountID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var events []*domain.WhatsAppWebhookEvent
	for rows.Next() {
		event := &domain.WhatsAppWebhookEvent{}
		if err := rows.Scan(&event.ID, &event.AccountID, &event.DeviceID, &event.PhoneNumberID, &event.EventID, &event.EventType,
			&event.Payload, &event.Processed, &event.ErrorMessage, &event.ReceivedAt); err != nil {
			return nil, err
		}
		events = append(events, event)
	}
	return events, rows.Err()
}

func (r *WhatsAppAPIRepository) UpdateChatServiceWindow(ctx context.Context, chatID uuid.UUID, provider string, inbound bool, at time.Time) error {
	if inbound {
		_, err := r.db.Exec(ctx, `
			UPDATE chats
			SET last_inbound_at = $1,
			    customer_service_window_expires_at = $2,
			    last_message_provider = $3,
			    updated_at = NOW()
			WHERE id = $4
		`, at, at.Add(24*time.Hour), provider, chatID)
		return err
	}
	_, err := r.db.Exec(ctx, `
		UPDATE chats
		SET last_outbound_at = $1,
		    last_message_provider = $2,
		    updated_at = NOW()
		WHERE id = $3
	`, at, provider, chatID)
	return err
}

func (r *WhatsAppAPIRepository) ListConversationWindows(ctx context.Context, accountID uuid.UUID, limit int) ([]*domain.WhatsAppConversationWindow, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := r.db.Query(ctx, `
		SELECT c.id, c.account_id, c.device_id, c.jid, c.name, d.name,
		       COALESCE(d.provider, c.last_message_provider, 'whatsapp_web') AS provider,
		       c.last_inbound_at, c.last_outbound_at, c.customer_service_window_expires_at,
		       COALESCE(c.customer_service_window_expires_at > NOW(), FALSE) AS can_reply
		FROM chats c
		LEFT JOIN devices d ON d.id = c.device_id
		WHERE c.account_id = $1
		  AND (d.provider = 'whatsapp_cloud_api' OR c.last_message_provider = 'whatsapp_cloud_api')
		ORDER BY c.customer_service_window_expires_at DESC NULLS LAST, c.updated_at DESC
		LIMIT $2
	`, accountID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var windows []*domain.WhatsAppConversationWindow
	for rows.Next() {
		window := &domain.WhatsAppConversationWindow{}
		if err := rows.Scan(&window.ChatID, &window.AccountID, &window.DeviceID, &window.JID, &window.Name, &window.DeviceName,
			&window.Provider, &window.LastInboundAt, &window.LastOutboundAt, &window.CustomerServiceWindowExpiresAt, &window.CanReply); err != nil {
			return nil, err
		}
		windows = append(windows, window)
	}
	return windows, rows.Err()
}

func scanWhatsAppTemplate(row pgx.Row) (*domain.WhatsAppMessageTemplate, error) {
	template := &domain.WhatsAppMessageTemplate{}
	err := row.Scan(&template.ID, &template.AccountID, &template.DeviceID, &template.Name, &template.Language,
		&template.Category, &template.Status, &template.Components, &template.MetaTemplateID,
		&template.RejectionReason, &template.LastSyncedAt, &template.CreatedAt, &template.UpdatedAt)
	return template, err
}
