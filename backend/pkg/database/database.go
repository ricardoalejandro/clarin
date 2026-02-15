package database

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/pkg/config"
	"golang.org/x/crypto/bcrypt"
)

func Connect(databaseURL string) (*pgxpool.Pool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	poolConfig, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("failed to parse database URL: %w", err)
	}

	poolConfig.MaxConns = 25
	poolConfig.MinConns = 5
	poolConfig.MaxConnLifetime = time.Hour
	poolConfig.MaxConnIdleTime = 30 * time.Minute

	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return nil, fmt.Errorf("failed to create connection pool: %w", err)
	}

	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("failed to ping database: %w", err)
	}

	return pool, nil
}

func Migrate(db *pgxpool.Pool) error {
	ctx := context.Background()

	migrations := []string{
		// Accounts table (multi-tenant)
		`CREATE TABLE IF NOT EXISTS accounts (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			name VARCHAR(255) NOT NULL,
			plan VARCHAR(50) DEFAULT 'free',
			max_devices INT DEFAULT 5,
			created_at TIMESTAMPTZ DEFAULT NOW(),
			updated_at TIMESTAMPTZ DEFAULT NOW()
		)`,

		// Users table
		`CREATE TABLE IF NOT EXISTS users (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			username VARCHAR(255) UNIQUE NOT NULL,
			email VARCHAR(255) UNIQUE NOT NULL,
			password_hash VARCHAR(255) NOT NULL,
			display_name VARCHAR(255),
			is_admin BOOLEAN DEFAULT FALSE,
			is_active BOOLEAN DEFAULT TRUE,
			created_at TIMESTAMPTZ DEFAULT NOW(),
			updated_at TIMESTAMPTZ DEFAULT NOW()
		)`,

		// Devices table (WhatsApp connections)
		`CREATE TABLE IF NOT EXISTS devices (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			name VARCHAR(255),
			phone VARCHAR(50),
			jid VARCHAR(255),
			status VARCHAR(50) DEFAULT 'disconnected',
			qr_code TEXT,
			last_seen_at TIMESTAMPTZ,
			created_at TIMESTAMPTZ DEFAULT NOW(),
			updated_at TIMESTAMPTZ DEFAULT NOW()
		)`,

		// Contacts table
		`CREATE TABLE IF NOT EXISTS contacts (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
			jid VARCHAR(255) NOT NULL,
			phone VARCHAR(50),
			name VARCHAR(255),
			push_name VARCHAR(255),
			avatar_url TEXT,
			is_group BOOLEAN DEFAULT FALSE,
			created_at TIMESTAMPTZ DEFAULT NOW(),
			updated_at TIMESTAMPTZ DEFAULT NOW(),
			UNIQUE(account_id, jid)
		)`,

		// Chats table
		`CREATE TABLE IF NOT EXISTS chats (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
			contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
			jid VARCHAR(255) NOT NULL,
			name VARCHAR(255),
			last_message TEXT,
			last_message_at TIMESTAMPTZ,
			unread_count INT DEFAULT 0,
			is_archived BOOLEAN DEFAULT FALSE,
			is_pinned BOOLEAN DEFAULT FALSE,
			created_at TIMESTAMPTZ DEFAULT NOW(),
			updated_at TIMESTAMPTZ DEFAULT NOW(),
			UNIQUE(account_id, jid)
		)`,

		// Messages table
		`CREATE TABLE IF NOT EXISTS messages (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
			chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
			message_id VARCHAR(255) NOT NULL,
			from_jid VARCHAR(255),
			from_name VARCHAR(255),
			body TEXT,
			message_type VARCHAR(50) DEFAULT 'text',
			media_url TEXT,
			media_mimetype VARCHAR(100),
			media_filename VARCHAR(255),
			media_size BIGINT,
			is_from_me BOOLEAN DEFAULT FALSE,
			is_read BOOLEAN DEFAULT FALSE,
			status VARCHAR(50) DEFAULT 'sent',
			timestamp TIMESTAMPTZ NOT NULL,
			created_at TIMESTAMPTZ DEFAULT NOW(),
			UNIQUE(account_id, device_id, message_id)
		)`,

		// Leads table
		`CREATE TABLE IF NOT EXISTS leads (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
			jid VARCHAR(255) NOT NULL,
			name VARCHAR(255),
			phone VARCHAR(50),
			email VARCHAR(255),
			status VARCHAR(50) DEFAULT 'new',
			source VARCHAR(100),
			notes TEXT,
			tags TEXT[],
			custom_fields JSONB DEFAULT '{}',
			assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
			created_at TIMESTAMPTZ DEFAULT NOW(),
			updated_at TIMESTAMPTZ DEFAULT NOW(),
			UNIQUE(account_id, jid)
		)`,

		// Pipelines table
		`CREATE TABLE IF NOT EXISTS pipelines (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			name VARCHAR(255) NOT NULL,
			description TEXT,
			is_default BOOLEAN DEFAULT FALSE,
			created_at TIMESTAMPTZ DEFAULT NOW(),
			updated_at TIMESTAMPTZ DEFAULT NOW()
		)`,

		// Pipeline stages table
		`CREATE TABLE IF NOT EXISTS pipeline_stages (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			pipeline_id UUID NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
			name VARCHAR(255) NOT NULL,
			color VARCHAR(50) DEFAULT '#6366f1',
			position INT DEFAULT 0,
			created_at TIMESTAMPTZ DEFAULT NOW()
		)`,

		// Lead pipeline assignments
		`CREATE TABLE IF NOT EXISTS lead_stages (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
			stage_id UUID NOT NULL REFERENCES pipeline_stages(id) ON DELETE CASCADE,
			entered_at TIMESTAMPTZ DEFAULT NOW(),
			UNIQUE(lead_id, stage_id)
		)`,

		// Contact device names table (per-device contact names)
		`CREATE TABLE IF NOT EXISTS contact_device_names (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
			device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
			name VARCHAR(255),
			push_name VARCHAR(255),
			business_name VARCHAR(255),
			synced_at TIMESTAMPTZ DEFAULT NOW(),
			UNIQUE(contact_id, device_id)
		)`,

		// Add new columns to contacts table
		`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS custom_name VARCHAR(255)`,
		`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email VARCHAR(255)`,
		`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company VARCHAR(255)`,
		`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS tags TEXT[]`,
		`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS notes TEXT`,
		`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS source VARCHAR(100) DEFAULT 'whatsapp'`,
		`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_name VARCHAR(255)`,
		`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS short_name VARCHAR(100)`,
		`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS age INTEGER`,

		// Indexes for performance
		`CREATE INDEX IF NOT EXISTS idx_users_account ON users(account_id)`,
		`CREATE INDEX IF NOT EXISTS idx_devices_account ON devices(account_id)`,
		`CREATE INDEX IF NOT EXISTS idx_contacts_account ON contacts(account_id)`,
		`CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone)`,
		`CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name)`,
		`CREATE INDEX IF NOT EXISTS idx_contact_device_names_contact ON contact_device_names(contact_id)`,
		`CREATE INDEX IF NOT EXISTS idx_contact_device_names_device ON contact_device_names(device_id)`,
		`CREATE INDEX IF NOT EXISTS idx_chats_account ON chats(account_id)`,
		`CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id)`,
		`CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_leads_account ON leads(account_id)`,
		`CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status)`,

		// Tags system
		`CREATE TABLE IF NOT EXISTS tags (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			name VARCHAR(100) NOT NULL,
			color VARCHAR(20) DEFAULT '#6366f1',
			created_at TIMESTAMPTZ DEFAULT NOW(),
			updated_at TIMESTAMPTZ DEFAULT NOW(),
			UNIQUE(account_id, name)
		)`,
		`CREATE TABLE IF NOT EXISTS contact_tags (
			contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
			tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
			PRIMARY KEY (contact_id, tag_id)
		)`,
		`CREATE TABLE IF NOT EXISTS lead_tags (
			lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
			tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
			PRIMARY KEY (lead_id, tag_id)
		)`,
		`CREATE TABLE IF NOT EXISTS chat_tags (
			chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
			tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
			PRIMARY KEY (chat_id, tag_id)
		)`,

		// Campaigns (mass messaging)
		`CREATE TABLE IF NOT EXISTS campaigns (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
			name VARCHAR(255) NOT NULL,
			message_template TEXT NOT NULL DEFAULT '',
			media_url TEXT,
			media_type VARCHAR(50),
			status VARCHAR(50) DEFAULT 'draft',
			scheduled_at TIMESTAMPTZ,
			started_at TIMESTAMPTZ,
			completed_at TIMESTAMPTZ,
			total_recipients INT DEFAULT 0,
			sent_count INT DEFAULT 0,
			failed_count INT DEFAULT 0,
			settings JSONB DEFAULT '{}',
			created_at TIMESTAMPTZ DEFAULT NOW(),
			updated_at TIMESTAMPTZ DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS campaign_recipients (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
			contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
			jid VARCHAR(255) NOT NULL,
			name VARCHAR(255),
			phone VARCHAR(50),
			status VARCHAR(50) DEFAULT 'pending',
			sent_at TIMESTAMPTZ,
			error_message TEXT
		)`,
		`CREATE INDEX IF NOT EXISTS idx_tags_account ON tags(account_id)`,
		`CREATE INDEX IF NOT EXISTS idx_campaigns_account ON campaigns(account_id)`,
		`CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status)`,
		`CREATE INDEX IF NOT EXISTS idx_campaign_recipients_campaign ON campaign_recipients(campaign_id)`,
		`CREATE INDEX IF NOT EXISTS idx_campaign_recipients_status ON campaign_recipients(status)`,

		// Events system (contact interaction tracking)
		`CREATE TABLE IF NOT EXISTS events (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			name VARCHAR(255) NOT NULL,
			description TEXT,
			event_date TIMESTAMPTZ,
			event_end TIMESTAMPTZ,
			location VARCHAR(500),
			status VARCHAR(50) DEFAULT 'active',
			color VARCHAR(20) DEFAULT '#3b82f6',
			created_by UUID REFERENCES users(id) ON DELETE SET NULL,
			created_at TIMESTAMPTZ DEFAULT NOW(),
			updated_at TIMESTAMPTZ DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS event_participants (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
			contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
			name VARCHAR(255) NOT NULL,
			last_name VARCHAR(255),
			phone VARCHAR(50),
			email VARCHAR(255),
			age INT,
			status VARCHAR(50) DEFAULT 'invited',
			notes TEXT,
			next_action TEXT,
			next_action_date TIMESTAMPTZ,
			invited_at TIMESTAMPTZ DEFAULT NOW(),
			confirmed_at TIMESTAMPTZ,
			attended_at TIMESTAMPTZ,
			created_at TIMESTAMPTZ DEFAULT NOW(),
			updated_at TIMESTAMPTZ DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS interactions (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
			event_id UUID REFERENCES events(id) ON DELETE SET NULL,
			participant_id UUID REFERENCES event_participants(id) ON DELETE SET NULL,
			type VARCHAR(50) NOT NULL,
			direction VARCHAR(20),
			outcome VARCHAR(50),
			notes TEXT,
			next_action TEXT,
			next_action_date TIMESTAMPTZ,
			created_by UUID REFERENCES users(id) ON DELETE SET NULL,
			created_at TIMESTAMPTZ DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_events_account ON events(account_id)`,
		`CREATE INDEX IF NOT EXISTS idx_events_status ON events(status)`,
		`CREATE INDEX IF NOT EXISTS idx_events_date ON events(event_date)`,
		`CREATE INDEX IF NOT EXISTS idx_event_participants_event ON event_participants(event_id)`,
		`CREATE INDEX IF NOT EXISTS idx_event_participants_contact ON event_participants(contact_id)`,
		`CREATE INDEX IF NOT EXISTS idx_event_participants_status ON event_participants(status)`,
		`CREATE INDEX IF NOT EXISTS idx_event_participants_next_action ON event_participants(next_action_date)`,
		`ALTER TABLE interactions ADD COLUMN IF NOT EXISTS lead_id UUID REFERENCES leads(id) ON DELETE SET NULL`,
		`CREATE INDEX IF NOT EXISTS idx_interactions_account ON interactions(account_id)`,
		`CREATE INDEX IF NOT EXISTS idx_interactions_contact ON interactions(contact_id)`,
		`CREATE INDEX IF NOT EXISTS idx_interactions_event ON interactions(event_id)`,
		`CREATE INDEX IF NOT EXISTS idx_interactions_participant ON interactions(participant_id)`,
		`CREATE INDEX IF NOT EXISTS idx_interactions_lead ON interactions(lead_id)`,
		`CREATE INDEX IF NOT EXISTS idx_interactions_created ON interactions(created_at DESC)`,

		// Participant tags
		`CREATE TABLE IF NOT EXISTS participant_tags (
			participant_id UUID NOT NULL REFERENCES event_participants(id) ON DELETE CASCADE,
			tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
			PRIMARY KEY (participant_id, tag_id)
		)`,

		// Campaign source tracking
		// Quoted/reply message fields
		`ALTER TABLE messages ADD COLUMN IF NOT EXISTS quoted_message_id VARCHAR(255)`,
		`ALTER TABLE messages ADD COLUMN IF NOT EXISTS quoted_body TEXT`,
		`ALTER TABLE messages ADD COLUMN IF NOT EXISTS quoted_sender VARCHAR(255)`,

		`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS event_id UUID REFERENCES events(id) ON DELETE SET NULL`,
		`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS source VARCHAR(50)`,
		`ALTER TABLE event_participants ADD COLUMN IF NOT EXISTS short_name VARCHAR(100)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_event_participants_unique_phone ON event_participants(event_id, phone) WHERE phone IS NOT NULL AND phone != ''`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_event_participants_unique_email ON event_participants(event_id, email) WHERE email IS NOT NULL AND email != ''`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_event_participants_unique_contact ON event_participants(event_id, contact_id) WHERE contact_id IS NOT NULL`,

		// Saved stickers
		`CREATE TABLE IF NOT EXISTS saved_stickers (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			media_url TEXT NOT NULL,
			created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_stickers_unique ON saved_stickers(account_id, media_url)`,

		// Multi-tenant management columns
		`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN DEFAULT FALSE`,
		`ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(50) DEFAULT 'admin'`,
		`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE`,
		`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS slug VARCHAR(255)`,
		`UPDATE users SET is_super_admin = TRUE, role = 'super_admin' WHERE is_admin = TRUE AND account_id = (SELECT id FROM accounts ORDER BY created_at LIMIT 1) AND is_super_admin = FALSE`,

		// Multi-account user assignments (user can belong to many accounts)
		`CREATE TABLE IF NOT EXISTS user_accounts (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			role VARCHAR(50) DEFAULT 'agent',
			is_default BOOLEAN DEFAULT FALSE,
			created_at TIMESTAMPTZ DEFAULT NOW()
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_accounts_unique ON user_accounts(user_id, account_id)`,
		`CREATE INDEX IF NOT EXISTS idx_user_accounts_user ON user_accounts(user_id)`,
		`CREATE INDEX IF NOT EXISTS idx_user_accounts_account ON user_accounts(account_id)`,
		// Seed existing user-account relationships into junction table
		`INSERT INTO user_accounts (user_id, account_id, role, is_default)
		 SELECT id, account_id, role, TRUE FROM users
		 ON CONFLICT (user_id, account_id) DO NOTHING`,

		// Campaign recipient timing tracking
		`ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS wait_time_ms INT`,

		// Message reactions table
		`CREATE TABLE IF NOT EXISTS message_reactions (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
			target_message_id VARCHAR(255) NOT NULL,
			sender_jid VARCHAR(255) NOT NULL,
			sender_name VARCHAR(255),
			emoji VARCHAR(50) NOT NULL,
			is_from_me BOOLEAN DEFAULT FALSE,
			timestamp TIMESTAMPTZ NOT NULL,
			created_at TIMESTAMPTZ DEFAULT NOW(),
			UNIQUE(chat_id, target_message_id, sender_jid)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_message_reactions_chat ON message_reactions(chat_id)`,
		`CREATE INDEX IF NOT EXISTS idx_message_reactions_target ON message_reactions(target_message_id)`,

		// Poll options table
		`CREATE TABLE IF NOT EXISTS poll_options (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
			name VARCHAR(255) NOT NULL,
			vote_count INT DEFAULT 0
		)`,
		`CREATE INDEX IF NOT EXISTS idx_poll_options_message ON poll_options(message_id)`,

		// Poll votes table
		`CREATE TABLE IF NOT EXISTS poll_votes (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
			voter_jid VARCHAR(255) NOT NULL,
			selected_names TEXT[] NOT NULL DEFAULT '{}',
			timestamp TIMESTAMPTZ NOT NULL,
			UNIQUE(message_id, voter_jid)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_poll_votes_message ON poll_votes(message_id)`,

		// Poll metadata on messages
		`ALTER TABLE messages ADD COLUMN IF NOT EXISTS poll_question TEXT`,
		`ALTER TABLE messages ADD COLUMN IF NOT EXISTS poll_max_selections INT DEFAULT 1`,

		// Campaign recipient metadata for custom variables
		`ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'`,

		// Lead contact fields sync
		`ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_name VARCHAR(255)`,
		`ALTER TABLE leads ADD COLUMN IF NOT EXISTS short_name VARCHAR(100)`,
		`ALTER TABLE leads ADD COLUMN IF NOT EXISTS company VARCHAR(255)`,
		`ALTER TABLE leads ADD COLUMN IF NOT EXISTS age INTEGER`,

		// Campaign attachments (multi-file support)
		`CREATE TABLE IF NOT EXISTS campaign_attachments (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
			media_url TEXT NOT NULL,
			media_type VARCHAR(50) NOT NULL,
			caption TEXT DEFAULT '',
			file_name VARCHAR(255) DEFAULT '',
			file_size BIGINT DEFAULT 0,
			position INT NOT NULL DEFAULT 0,
			created_at TIMESTAMPTZ DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_campaign_attachments_campaign ON campaign_attachments(campaign_id)`,

		// Quick replies (canned responses)
		`CREATE TABLE IF NOT EXISTS quick_replies (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			shortcut VARCHAR(100) NOT NULL,
			title VARCHAR(255) NOT NULL,
			body TEXT NOT NULL,
			created_at TIMESTAMPTZ DEFAULT NOW(),
			updated_at TIMESTAMPTZ DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_quick_replies_account ON quick_replies(account_id)`,

		// Lead pipeline linkage
		`ALTER TABLE leads ADD COLUMN IF NOT EXISTS pipeline_id UUID REFERENCES pipelines(id) ON DELETE SET NULL`,
		`ALTER TABLE leads ADD COLUMN IF NOT EXISTS stage_id UUID REFERENCES pipeline_stages(id) ON DELETE SET NULL`,
		`CREATE INDEX IF NOT EXISTS idx_leads_pipeline ON leads(pipeline_id)`,
		`CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(stage_id)`,

		// Kommo CRM integration
		`ALTER TABLE leads ADD COLUMN IF NOT EXISTS kommo_id BIGINT`,
		`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS kommo_id BIGINT`,
		`ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS kommo_id BIGINT`,
		`ALTER TABLE pipeline_stages ADD COLUMN IF NOT EXISTS kommo_id BIGINT`,
		`ALTER TABLE tags ADD COLUMN IF NOT EXISTS kommo_id BIGINT`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_kommo_id ON leads(account_id, kommo_id) WHERE kommo_id IS NOT NULL`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_kommo_id ON contacts(account_id, kommo_id) WHERE kommo_id IS NOT NULL`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_pipelines_kommo_id ON pipelines(account_id, kommo_id) WHERE kommo_id IS NOT NULL`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_stages_kommo_id ON pipeline_stages(kommo_id) WHERE kommo_id IS NOT NULL`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_kommo_id ON tags(account_id, kommo_id) WHERE kommo_id IS NOT NULL`,

		// Kommo connected pipelines (real-time sync tracking)
		`CREATE TABLE IF NOT EXISTS kommo_connected_pipelines (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			kommo_pipeline_id BIGINT NOT NULL,
			pipeline_id UUID REFERENCES pipelines(id) ON DELETE SET NULL,
			enabled BOOLEAN DEFAULT TRUE,
			last_synced_at TIMESTAMPTZ,
			created_at TIMESTAMPTZ DEFAULT NOW(),
			UNIQUE(account_id, kommo_pipeline_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_kommo_connected_pipelines_account ON kommo_connected_pipelines(account_id)`,
	}

	for _, migration := range migrations {
		if _, err := db.Exec(ctx, migration); err != nil {
			return fmt.Errorf("migration failed: %w\nSQL: %s", err, migration)
		}
	}

	return nil
}

func SeedAdmin(db *pgxpool.Pool, cfg *config.Config) error {
	ctx := context.Background()

	// Check if admin exists
	var count int
	err := db.QueryRow(ctx, "SELECT COUNT(*) FROM users WHERE username = $1", cfg.AdminUser).Scan(&count)
	if err != nil {
		return fmt.Errorf("failed to check admin existence: %w", err)
	}

	if count > 0 {
		return nil // Admin already exists
	}

	// Create default account
	var accountID string
	err = db.QueryRow(ctx, `
		INSERT INTO accounts (name, plan, max_devices) 
		VALUES ('Default Account', 'enterprise', 200) 
		ON CONFLICT DO NOTHING
		RETURNING id
	`).Scan(&accountID)
	if err != nil {
		// Try to get existing account
		err = db.QueryRow(ctx, "SELECT id FROM accounts WHERE name = 'Default Account'").Scan(&accountID)
		if err != nil {
			return fmt.Errorf("failed to create/get default account: %w", err)
		}
	}

	// Hash password
	hashedPassword, err := bcrypt.GenerateFromPassword([]byte(cfg.AdminPassword), bcrypt.DefaultCost)
	if err != nil {
		return fmt.Errorf("failed to hash password: %w", err)
	}

	// Create or update admin user (super_admin)
	_, err = db.Exec(ctx, `
		INSERT INTO users (account_id, username, email, password_hash, display_name, is_admin, is_super_admin, role)
		VALUES ($1, $2, $3, $4, 'Administrador', TRUE, TRUE, 'super_admin')
		ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, account_id = EXCLUDED.account_id, is_super_admin = TRUE, role = 'super_admin'
	`, accountID, cfg.AdminUser, cfg.AdminEmail, string(hashedPassword))
	if err != nil {
		return fmt.Errorf("failed to create admin user: %w", err)
	}

	// Create default pipeline (idempotent)
	var pipelineID string
	err = db.QueryRow(ctx, `
		SELECT id FROM pipelines WHERE account_id = $1 AND is_default = TRUE LIMIT 1
	`, accountID).Scan(&pipelineID)
	if err != nil {
		// No default pipeline exists, create one
		err = db.QueryRow(ctx, `
			INSERT INTO pipelines (account_id, name, description, is_default)
			VALUES ($1, 'Pipeline Principal', 'Pipeline por defecto para leads', TRUE)
			RETURNING id
		`, accountID).Scan(&pipelineID)
		if err != nil {
			return fmt.Errorf("failed to create default pipeline: %w", err)
		}

		// Create default stages
		stages := []struct {
			name  string
			color string
		}{
			{"Nuevo", "#6366f1"},
			{"Contactado", "#f59e0b"},
			{"En Negociación", "#3b82f6"},
			{"Propuesta", "#8b5cf6"},
			{"Cerrado", "#10b981"},
			{"Perdido", "#ef4444"},
		}

		for i, stage := range stages {
			_, err = db.Exec(ctx, `
				INSERT INTO pipeline_stages (pipeline_id, name, color, position)
				VALUES ($1, $2, $3, $4)
			`, pipelineID, stage.name, stage.color, i)
			if err != nil {
				return fmt.Errorf("failed to create stage %s: %w", stage.name, err)
			}
		}
	}

	// Assign existing leads without pipeline to the default pipeline's first stage
	var firstStageID string
	err = db.QueryRow(ctx, `
		SELECT id FROM pipeline_stages WHERE pipeline_id = $1 ORDER BY position LIMIT 1
	`, pipelineID).Scan(&firstStageID)
	if err == nil {
		_, _ = db.Exec(ctx, `
			UPDATE leads SET pipeline_id = $1, stage_id = $2
			WHERE account_id = $3 AND pipeline_id IS NULL
		`, pipelineID, firstStageID, accountID)
	}

	return nil
}
