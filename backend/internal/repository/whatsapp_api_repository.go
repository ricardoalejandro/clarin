package repository

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
)

type whatsAppAPIDatabase interface {
	Exec(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// WhatsAppAPIRepository handles Cloud API configuration, templates, webhooks and service windows.
type WhatsAppAPIRepository struct {
	db whatsAppAPIDatabase
}

var _ whatsAppAPIDatabase = (*pgxpool.Pool)(nil)

type WhatsAppAPIOverview struct {
	CloudChannelCount int `json:"cloud_channel_count"`
	TemplateCount     int `json:"template_count"`
	ApprovedTemplates int `json:"approved_templates"`
	WebhookEventCount int `json:"webhook_event_count"`
	OpenWindowCount   int `json:"open_window_count"`
}

var ErrCloudChannelOwnedByAnotherAccount = errors.New("WhatsApp Cloud channel belongs to another account")

type WhatsAppCloudCredential struct {
	DeviceID             uuid.UUID
	AccountID            uuid.UUID
	AccessTokenEncrypted []byte
	TokenExpiresAt       *time.Time
	GrantedScopes        []string
}

func (r *WhatsAppAPIRepository) UpsertCloudDevice(ctx context.Context, device *domain.Device) (*domain.Device, error) {
	if device.ID == uuid.Nil {
		device.ID = uuid.New()
	}
	result := &domain.Device{}
	err := r.db.QueryRow(ctx, `
		INSERT INTO devices (
			id, account_id, name, phone, jid, status, qr_code, receive_messages, provider,
			waba_id, phone_number_id, api_display_phone, api_webhook_status, api_billing_status,
			api_sending_enabled, api_templates_enabled, capabilities, last_seen_at
		)
		VALUES (
			$1, $2, $3, $4, $5, 'connecting', NULL, TRUE, $6,
			$7, $8, $9, 'pending', 'customer_managed', FALSE, FALSE,
			'["cloud_api","embedded_signup","coexistence"]'::jsonb, NOW()
		)
		ON CONFLICT (phone_number_id)
			WHERE provider = 'whatsapp_cloud_api' AND phone_number_id IS NOT NULL
		DO UPDATE SET
			name = EXCLUDED.name,
			phone = EXCLUDED.phone,
			jid = EXCLUDED.jid,
			status = 'connecting',
			waba_id = EXCLUDED.waba_id,
			api_display_phone = EXCLUDED.api_display_phone,
			api_webhook_status = 'pending',
			api_billing_status = 'customer_managed',
			api_sending_enabled = FALSE,
			api_templates_enabled = FALSE,
			capabilities = EXCLUDED.capabilities,
			last_seen_at = NOW(),
			updated_at = NOW()
		WHERE devices.account_id = EXCLUDED.account_id
		RETURNING id, account_id, name, phone, jid, status, qr_code, receive_messages, provider, waba_id,
			phone_number_id, api_display_phone, api_webhook_status, api_billing_status, api_sending_enabled,
			api_templates_enabled, capabilities, last_seen_at, created_at, updated_at
	`, device.ID, device.AccountID, device.Name, device.Phone, device.JID,
		domain.DeviceProviderWhatsAppCloudAPI, device.WABAID, device.PhoneNumberID, device.APIDisplayPhone).Scan(
		&result.ID, &result.AccountID, &result.Name, &result.Phone, &result.JID,
		&result.Status, &result.QRCode, &result.ReceiveMessages, &result.Provider, &result.WABAID,
		&result.PhoneNumberID, &result.APIDisplayPhone, &result.APIWebhookStatus, &result.APIBillingStatus,
		&result.APISendingEnabled, &result.APITemplatesEnabled, &result.Capabilities, &result.LastSeenAt,
		&result.CreatedAt, &result.UpdatedAt,
	)
	if err == pgx.ErrNoRows {
		return nil, ErrCloudChannelOwnedByAnotherAccount
	}
	return result, err
}

func (r *WhatsAppAPIRepository) UpsertCloudCredential(ctx context.Context, credential *WhatsAppCloudCredential) error {
	command, err := r.db.Exec(ctx, `
		INSERT INTO whatsapp_cloud_credentials
			(device_id, account_id, access_token_encrypted, token_expires_at, granted_scopes)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (device_id) DO UPDATE SET
			access_token_encrypted = EXCLUDED.access_token_encrypted,
			token_expires_at = EXCLUDED.token_expires_at,
			granted_scopes = EXCLUDED.granted_scopes,
			updated_at = NOW()
		WHERE whatsapp_cloud_credentials.account_id = EXCLUDED.account_id
	`, credential.DeviceID, credential.AccountID, credential.AccessTokenEncrypted,
		credential.TokenExpiresAt, credential.GrantedScopes)
	if err != nil {
		return err
	}
	if command.RowsAffected() != 1 {
		return ErrCloudChannelOwnedByAnotherAccount
	}
	return nil
}

func (r *WhatsAppAPIRepository) GetCloudCredential(ctx context.Context, accountID, deviceID uuid.UUID) (*WhatsAppCloudCredential, error) {
	credential := &WhatsAppCloudCredential{}
	err := r.db.QueryRow(ctx, `
		SELECT device_id, account_id, access_token_encrypted, token_expires_at, granted_scopes
		FROM whatsapp_cloud_credentials
		WHERE account_id = $1 AND device_id = $2
	`, accountID, deviceID).Scan(
		&credential.DeviceID, &credential.AccountID, &credential.AccessTokenEncrypted,
		&credential.TokenExpiresAt, &credential.GrantedScopes,
	)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	return credential, err
}

func (r *WhatsAppAPIRepository) ActivateCloudDevice(ctx context.Context, accountID, deviceID uuid.UUID, webhookStatus string, templatesEnabled bool) error {
	command, err := r.db.Exec(ctx, `
		UPDATE devices
		SET status = $1,
		    api_webhook_status = $2,
		    api_sending_enabled = TRUE,
		    api_templates_enabled = $6,
		    last_seen_at = NOW(),
		    updated_at = NOW()
		WHERE id = $3 AND account_id = $4 AND provider = $5
	`, domain.DeviceStatusConnected, webhookStatus, deviceID, accountID, domain.DeviceProviderWhatsAppCloudAPI, templatesEnabled)
	if err != nil {
		return err
	}
	if command.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	return nil
}

func (r *WhatsAppAPIRepository) MarkCloudDeviceError(ctx context.Context, accountID, deviceID uuid.UUID, webhookStatus string) error {
	_, err := r.db.Exec(ctx, `
		UPDATE devices
		SET status = $1, api_webhook_status = $2, api_sending_enabled = FALSE,
		    api_templates_enabled = FALSE, updated_at = NOW()
		WHERE id = $3 AND account_id = $4 AND provider = $5
	`, domain.DeviceStatusDisconnected, webhookStatus, deviceID, accountID, domain.DeviceProviderWhatsAppCloudAPI)
	return err
}

func (r *WhatsAppAPIRepository) CanSendFreeform(ctx context.Context, accountID, chatID uuid.UUID) (bool, *time.Time, error) {
	var expiresAt *time.Time
	var canSend bool
	err := r.db.QueryRow(ctx, `
		SELECT customer_service_window_expires_at,
		       COALESCE(customer_service_window_expires_at > NOW(), FALSE)
		FROM chats
		WHERE id = $1 AND account_id = $2 AND channel_key LIKE 'whatsapp_cloud_api:%'
	`, chatID, accountID).Scan(&expiresAt, &canSend)
	if err == pgx.ErrNoRows {
		return false, nil, nil
	}
	return canSend, expiresAt, err
}

func (r *WhatsAppAPIRepository) RecordOptIn(ctx context.Context, accountID uuid.UUID, contactID *uuid.UUID, phone, source, proofNote string, consentedAt time.Time, createdBy *uuid.UUID) error {
	_, err := r.db.Exec(ctx, `
		INSERT INTO whatsapp_opt_ins
			(account_id, contact_id, phone, source, proof_note, consented_at, revoked_at, created_by)
		VALUES ($1,$2,$3,$4,$5,$6,NULL,$7)
		ON CONFLICT (account_id, phone) DO UPDATE SET
			contact_id = COALESCE(EXCLUDED.contact_id, whatsapp_opt_ins.contact_id),
			source = EXCLUDED.source,
			proof_note = EXCLUDED.proof_note,
			consented_at = EXCLUDED.consented_at,
			revoked_at = NULL,
			created_by = EXCLUDED.created_by,
			updated_at = NOW()
	`, accountID, contactID, phone, source, proofNote, consentedAt, createdBy)
	return err
}

func (r *WhatsAppAPIRepository) RecordInboundOptIn(ctx context.Context, accountID uuid.UUID, contactID *uuid.UUID, phone, proofNote string, consentedAt time.Time) error {
	_, err := r.db.Exec(ctx, `
		INSERT INTO whatsapp_opt_ins
			(account_id, contact_id, phone, source, proof_note, consented_at, revoked_at, created_by)
		VALUES ($1,$2,$3,'whatsapp_inbound',$4,$5,NULL,NULL)
		ON CONFLICT (account_id, phone) DO NOTHING
	`, accountID, contactID, phone, proofNote, consentedAt)
	return err
}

func (r *WhatsAppAPIRepository) HasActiveOptIn(ctx context.Context, accountID uuid.UUID, phone string) (bool, error) {
	var active bool
	err := r.db.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM whatsapp_opt_ins
			WHERE account_id = $1 AND phone = $2 AND revoked_at IS NULL
		)
	`, accountID, phone).Scan(&active)
	return active, err
}

func (r *WhatsAppAPIRepository) LatestInboundCloudMessageID(ctx context.Context, accountID, deviceID, chatID uuid.UUID) (string, error) {
	var messageID string
	err := r.db.QueryRow(ctx, `
		SELECT message_id
		FROM messages
		WHERE account_id = $1 AND device_id = $2 AND chat_id = $3
		  AND provider = $4 AND is_from_me = FALSE
		ORDER BY timestamp DESC, created_at DESC
		LIMIT 1
	`, accountID, deviceID, chatID, domain.DeviceProviderWhatsAppCloudAPI).Scan(&messageID)
	if err == pgx.ErrNoRows {
		return "", nil
	}
	return messageID, err
}

func (r *WhatsAppAPIRepository) UpsertSyncedTemplate(ctx context.Context, template *domain.WhatsAppMessageTemplate) error {
	if template.DeviceID == nil {
		return errors.New("synced template requires a Cloud device")
	}
	components := template.Components
	if len(components) == 0 {
		components = json.RawMessage("[]")
	}
	return r.db.QueryRow(ctx, `
		INSERT INTO whatsapp_message_templates
			(account_id, device_id, name, language, category, status, components,
			 meta_template_id, rejection_reason, last_synced_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
		ON CONFLICT (account_id, device_id, name, language)
			WHERE device_id IS NOT NULL
		DO UPDATE SET
			category = EXCLUDED.category,
			status = EXCLUDED.status,
			components = EXCLUDED.components,
			meta_template_id = EXCLUDED.meta_template_id,
			rejection_reason = EXCLUDED.rejection_reason,
			last_synced_at = NOW(),
			updated_at = NOW()
		RETURNING id, created_at, updated_at, last_synced_at
	`, template.AccountID, template.DeviceID, template.Name, template.Language,
		template.Category, template.Status, components, template.MetaTemplateID,
		template.RejectionReason).Scan(&template.ID, &template.CreatedAt, &template.UpdatedAt, &template.LastSyncedAt)
}

func (r *WhatsAppAPIRepository) DeleteStaleSyncedTemplates(ctx context.Context, accountID, deviceID uuid.UUID, activeMetaIDs []string) error {
	_, err := r.db.Exec(ctx, `
		DELETE FROM whatsapp_message_templates
		WHERE account_id = $1 AND device_id = $2 AND meta_template_id IS NOT NULL
		  AND NOT (meta_template_id = ANY($3::text[]))
	`, accountID, deviceID, activeMetaIDs)
	return err
}

func (r *WhatsAppAPIRepository) UpdateCloudMessageStatus(ctx context.Context, accountID, deviceID uuid.UUID, messageID, status string, at time.Time) error {
	_, err := r.db.Exec(ctx, `
		UPDATE messages
		SET status = CASE
		      WHEN $4 = 'failed' THEN 'failed'
		      WHEN $4 = 'read' AND status <> 'failed' THEN 'read'
		      WHEN $4 = 'delivered' AND status NOT IN ('read','failed') THEN 'delivered'
		      WHEN $4 = 'sent' AND status NOT IN ('read','delivered','failed') THEN 'sent'
		      ELSE status
		    END,
		    delivered_at = CASE WHEN $4 = 'delivered' AND status <> 'failed' THEN COALESCE(delivered_at, $5) ELSE delivered_at END,
		    read_at = CASE WHEN $4 = 'read' AND status <> 'failed' THEN COALESCE(read_at, $5) ELSE read_at END
		WHERE account_id = $1 AND device_id = $2 AND message_id = $3
		  AND provider = $6 AND is_from_me = TRUE
	`, accountID, deviceID, messageID, status, at, domain.DeviceProviderWhatsAppCloudAPI)
	return err
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
			(SELECT COUNT(*) FROM chats WHERE account_id = $1 AND channel_key LIKE 'whatsapp_cloud_api:%' AND customer_service_window_expires_at > NOW())
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

// ClaimWebhookEvent atomically records an event before any externally visible
// processing. A false result means another delivery already claimed the same
// provider event ID and the caller must not repeat its side effects.
func (r *WhatsAppAPIRepository) ClaimWebhookEvent(ctx context.Context, event *domain.WhatsAppWebhookEvent) (bool, error) {
	payload := event.Payload
	if len(payload) == 0 {
		payload = json.RawMessage("{}")
	}
	err := r.db.QueryRow(ctx, `
		INSERT INTO whatsapp_webhook_events
			(account_id, device_id, phone_number_id, event_id, event_type, payload, processed, error_message)
		VALUES ($1, $2, $3, $4, $5, $6, FALSE, $7)
		ON CONFLICT (event_id) DO UPDATE SET
			account_id = COALESCE(whatsapp_webhook_events.account_id, EXCLUDED.account_id),
			device_id = COALESCE(whatsapp_webhook_events.device_id, EXCLUDED.device_id),
			phone_number_id = EXCLUDED.phone_number_id,
			payload = EXCLUDED.payload,
			error_message = NULL,
			received_at = NOW()
		WHERE whatsapp_webhook_events.processed = FALSE
		  AND (whatsapp_webhook_events.error_message IS NOT NULL
		       OR whatsapp_webhook_events.received_at < NOW() - INTERVAL '5 minutes')
		RETURNING id, received_at
	`, event.AccountID, event.DeviceID, event.PhoneNumberID, event.EventID, event.EventType, payload, event.ErrorMessage).
		Scan(&event.ID, &event.ReceivedAt)
	if err == pgx.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// CompleteWebhookEvent records the outcome for a previously claimed event.
func (r *WhatsAppAPIRepository) CompleteWebhookEvent(ctx context.Context, id uuid.UUID, processed bool, errorMessage *string) error {
	_, err := r.db.Exec(ctx, `
		UPDATE whatsapp_webhook_events
		SET processed = $2, error_message = $3
		WHERE id = $1
	`, id, processed, errorMessage)
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
