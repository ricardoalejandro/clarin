package database

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// migrateTaskEvents adds calendar-native Work events and item identity colors.
// Work events deliberately do not reuse the CRM events table: CRM events own
// participants and campaign stages, while these rows inherit Clarin Work list
// hierarchy and authorization.
func migrateTaskEvents(ctx context.Context, db *pgxpool.Pool) error {
	statements := []string{
		`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS color VARCHAR(7)`,
		`DO $$ BEGIN ALTER TABLE tasks ADD CONSTRAINT tasks_color_check
			CHECK (color IS NULL OR color ~ '^#[0-9A-F]{6}$');
			EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`CREATE TABLE IF NOT EXISTS work_events (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			list_id UUID NOT NULL,
			organizer_id UUID NOT NULL,
			title VARCHAR(255) NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			location VARCHAR(500) NOT NULL DEFAULT '',
			meeting_url TEXT NOT NULL DEFAULT '',
			color VARCHAR(7),
			availability VARCHAR(10) NOT NULL DEFAULT 'busy',
			is_all_day BOOLEAN NOT NULL DEFAULT FALSE,
			start_at TIMESTAMPTZ,
			end_at TIMESTAMPTZ,
			start_date DATE,
			end_date_exclusive DATE,
			timezone VARCHAR(100) NOT NULL DEFAULT 'America/Lima',
			recurrence_rule TEXT NOT NULL DEFAULT '',
			series_root_id UUID,
			status VARCHAR(16) NOT NULL DEFAULT 'scheduled',
			cancelled_at TIMESTAMPTZ,
			cancelled_by UUID REFERENCES users(id) ON DELETE SET NULL,
			deleted_at TIMESTAMPTZ,
			deleted_by UUID REFERENCES users(id) ON DELETE SET NULL,
			version BIGINT NOT NULL DEFAULT 1,
			operation_id UUID,
			created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			CONSTRAINT work_events_color_check CHECK (color IS NULL OR color ~ '^#[0-9A-F]{6}$'),
			CONSTRAINT work_events_availability_check CHECK (availability IN ('busy','free')),
			CONSTRAINT work_events_status_check CHECK (status IN ('scheduled','cancelled')),
			CONSTRAINT work_events_dates_check CHECK (
				(is_all_day AND start_at IS NULL AND end_at IS NULL AND start_date IS NOT NULL AND end_date_exclusive > start_date)
				OR
				(NOT is_all_day AND start_date IS NULL AND end_date_exclusive IS NULL AND start_at IS NOT NULL AND end_at > start_at)
			),
			UNIQUE(account_id,id),
			CONSTRAINT work_events_list_account_fk FOREIGN KEY(account_id,list_id)
				REFERENCES task_lists(account_id,id) ON DELETE RESTRICT,
			CONSTRAINT work_events_organizer_membership_fk FOREIGN KEY(account_id,organizer_id)
				REFERENCES user_accounts(account_id,user_id) ON DELETE RESTRICT
		)`,
		`ALTER TABLE work_events DROP CONSTRAINT IF EXISTS work_events_series_root_account_fk`,
		`DO $$ BEGIN
			IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='work_events'::regclass AND conname='work_events_series_root_fk'
				AND pg_get_constraintdef(oid) NOT LIKE 'FOREIGN KEY (account_id, series_root_id)%') THEN
				ALTER TABLE work_events DROP CONSTRAINT work_events_series_root_fk;
			END IF;
			IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='work_events'::regclass AND conname='work_events_series_root_fk') THEN
				ALTER TABLE work_events ADD CONSTRAINT work_events_series_root_fk
					FOREIGN KEY(account_id,series_root_id) REFERENCES work_events(account_id,id) ON DELETE SET NULL (series_root_id);
			END IF;
		END $$`,
		`CREATE INDEX IF NOT EXISTS idx_work_events_timed_range
			ON work_events(account_id,list_id,start_at,end_at,id)
			WHERE NOT is_all_day AND deleted_at IS NULL`,
		`CREATE INDEX IF NOT EXISTS idx_work_events_all_day_range
			ON work_events(account_id,list_id,start_date,end_date_exclusive,id)
			WHERE is_all_day AND deleted_at IS NULL`,
		`CREATE INDEX IF NOT EXISTS idx_work_events_series
			ON work_events(account_id,COALESCE(series_root_id,id),created_at)`,
		`CREATE TABLE IF NOT EXISTS work_event_attendees (
			account_id UUID NOT NULL,
			event_id UUID NOT NULL,
			user_id UUID NOT NULL,
			attendance_type VARCHAR(10) NOT NULL DEFAULT 'required',
			rsvp VARCHAR(10) NOT NULL DEFAULT 'pending',
			reminder_minutes INTEGER,
			version BIGINT NOT NULL DEFAULT 1,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			PRIMARY KEY(account_id,event_id,user_id),
			CONSTRAINT work_event_attendees_event_fk FOREIGN KEY(account_id,event_id)
				REFERENCES work_events(account_id,id) ON DELETE CASCADE,
			CONSTRAINT work_event_attendees_membership_fk FOREIGN KEY(account_id,user_id)
				REFERENCES user_accounts(account_id,user_id) ON DELETE CASCADE,
			CONSTRAINT work_event_attendees_type_check CHECK (attendance_type IN ('required','optional')),
			CONSTRAINT work_event_attendees_rsvp_check CHECK (rsvp IN ('pending','accepted','tentative','declined')),
			CONSTRAINT work_event_attendees_reminder_check CHECK (reminder_minutes IS NULL OR reminder_minutes BETWEEN 0 AND 525600)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_work_event_attendees_user
			ON work_event_attendees(account_id,user_id,event_id)`,
		`CREATE TABLE IF NOT EXISTS work_event_occurrence_overrides (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL,
			event_id UUID NOT NULL,
			occurrence_key VARCHAR(64) NOT NULL,
			is_cancelled BOOLEAN NOT NULL DEFAULT FALSE,
			title VARCHAR(255),
			description TEXT,
			location VARCHAR(500),
			meeting_url TEXT,
			color VARCHAR(7),
			availability VARCHAR(10),
			is_all_day BOOLEAN,
			start_at TIMESTAMPTZ,
			end_at TIMESTAMPTZ,
			start_date DATE,
			end_date_exclusive DATE,
			timezone VARCHAR(100),
			version BIGINT NOT NULL DEFAULT 1,
			operation_id UUID,
			created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			UNIQUE(account_id,event_id,occurrence_key),
			CONSTRAINT work_event_overrides_event_fk FOREIGN KEY(account_id,event_id)
				REFERENCES work_events(account_id,id) ON DELETE CASCADE,
			CONSTRAINT work_event_overrides_color_check CHECK (color IS NULL OR color ~ '^#[0-9A-F]{6}$'),
			CONSTRAINT work_event_overrides_availability_check CHECK (availability IS NULL OR availability IN ('busy','free'))
		)`,
		`CREATE INDEX IF NOT EXISTS idx_work_event_overrides_event
			ON work_event_occurrence_overrides(account_id,event_id,occurrence_key)`,
		`ALTER TABLE work_event_occurrence_overrides ADD COLUMN IF NOT EXISTS color_set BOOLEAN NOT NULL DEFAULT FALSE`,
		`CREATE TABLE IF NOT EXISTS work_event_reminder_jobs (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL,
			event_id UUID NOT NULL,
			occurrence_key VARCHAR(64) NOT NULL,
			user_id UUID NOT NULL,
			reminder_at TIMESTAMPTZ NOT NULL,
			delivered_at TIMESTAMPTZ,
			cancelled_at TIMESTAMPTZ,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			UNIQUE(account_id,event_id,occurrence_key,user_id),
			CONSTRAINT work_event_reminders_event_fk FOREIGN KEY(account_id,event_id)
				REFERENCES work_events(account_id,id) ON DELETE CASCADE,
			CONSTRAINT work_event_reminders_membership_fk FOREIGN KEY(account_id,user_id)
				REFERENCES user_accounts(account_id,user_id) ON DELETE CASCADE
		)`,
		`CREATE INDEX IF NOT EXISTS idx_work_event_reminders_pending
			ON work_event_reminder_jobs(reminder_at,id)
			WHERE delivered_at IS NULL AND cancelled_at IS NULL`,
	}

	for _, statement := range statements {
		if _, err := db.Exec(ctx, statement); err != nil {
			return fmt.Errorf("task event schema migration failed: %w\nSQL: %s", err, statement)
		}
	}
	return nil
}
