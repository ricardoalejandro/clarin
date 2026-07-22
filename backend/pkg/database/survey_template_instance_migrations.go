package database

// surveyTemplateInstanceMigrations separates reusable survey definitions from
// their published applications while keeping the legacy surveys table as the
// physical instance table. Keeping that table in place preserves every public
// slug, response and answer during the transition.
func surveyTemplateInstanceMigrations() []string {
	return []string{
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_surveys_account_id ON surveys(account_id, id)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_program_participants_program_id ON program_participants(program_id, id)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_program_participants_program_identity ON program_participants(program_id, id, contact_id)`,
		`CREATE TABLE IF NOT EXISTS survey_templates (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL DEFAULT 'active',
			welcome_title TEXT NOT NULL DEFAULT '',
			welcome_description TEXT NOT NULL DEFAULT '',
			thank_you_title TEXT NOT NULL DEFAULT '',
			thank_you_message TEXT NOT NULL DEFAULT '',
			thank_you_redirect_url TEXT NOT NULL DEFAULT '',
			branding JSONB NOT NULL DEFAULT '{}',
			revision INTEGER NOT NULL DEFAULT 1,
			system_key TEXT,
			legacy_survey_id UUID,
			created_by UUID REFERENCES users(id) ON DELETE SET NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			CONSTRAINT survey_templates_status_check CHECK (status IN ('active','archived')),
			CONSTRAINT survey_templates_revision_check CHECK (revision > 0)
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_survey_templates_account_id ON survey_templates(account_id, id)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_survey_templates_legacy ON survey_templates(account_id, legacy_survey_id) WHERE legacy_survey_id IS NOT NULL`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_survey_templates_system_key ON survey_templates(account_id, system_key) WHERE system_key IS NOT NULL`,
		`CREATE INDEX IF NOT EXISTS idx_survey_templates_account_status ON survey_templates(account_id, status, updated_at DESC)`,
		`CREATE TABLE IF NOT EXISTS survey_template_questions (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL,
			template_id UUID NOT NULL,
			order_index INTEGER NOT NULL DEFAULT 0,
			type TEXT NOT NULL,
			title TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			required BOOLEAN NOT NULL DEFAULT FALSE,
			config JSONB NOT NULL DEFAULT '{}',
			logic_rules JSONB NOT NULL DEFAULT '[]',
			is_active BOOLEAN NOT NULL DEFAULT TRUE,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			CONSTRAINT survey_template_questions_account_template_fkey
				FOREIGN KEY (account_id, template_id) REFERENCES survey_templates(account_id, id) ON DELETE CASCADE
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_survey_template_questions_account_id ON survey_template_questions(account_id, id)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_survey_template_questions_order ON survey_template_questions(account_id, template_id, order_index) WHERE is_active`,
		`CREATE INDEX IF NOT EXISTS idx_survey_template_questions_template ON survey_template_questions(account_id, template_id, is_active, order_index)`,
		`ALTER TABLE surveys ADD COLUMN IF NOT EXISTS template_id UUID`,
		`ALTER TABLE surveys ADD COLUMN IF NOT EXISTS template_revision INTEGER NOT NULL DEFAULT 1`,
		`ALTER TABLE surveys ADD COLUMN IF NOT EXISTS origin_type TEXT NOT NULL DEFAULT 'standalone'`,
		`ALTER TABLE surveys ADD COLUMN IF NOT EXISTS program_id UUID`,
		`ALTER TABLE surveys ADD COLUMN IF NOT EXISTS origin_label TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE surveys ADD COLUMN IF NOT EXISTS audience_mode TEXT NOT NULL DEFAULT 'public'`,
		`ALTER TABLE surveys ADD COLUMN IF NOT EXISTS opens_at TIMESTAMPTZ`,
		`ALTER TABLE surveys ADD COLUMN IF NOT EXISTS closes_at TIMESTAMPTZ`,
		`ALTER TABLE surveys ADD COLUMN IF NOT EXISTS legacy_instance BOOLEAN NOT NULL DEFAULT FALSE`,
		`DO $$ BEGIN
			IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='surveys_account_template_fkey') THEN
				ALTER TABLE surveys ADD CONSTRAINT surveys_account_template_fkey
				FOREIGN KEY (account_id, template_id) REFERENCES survey_templates(account_id, id) ON DELETE RESTRICT;
			END IF;
		END $$`,
		`DO $$ BEGIN
			IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='surveys_account_program_fkey') THEN
				ALTER TABLE surveys ADD CONSTRAINT surveys_account_program_fkey
				FOREIGN KEY (account_id, program_id) REFERENCES programs(account_id, id) ON DELETE SET NULL (program_id);
			END IF;
		END $$`,
		`DO $$ BEGIN
			IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='surveys_origin_shape_check') THEN
				ALTER TABLE surveys ADD CONSTRAINT surveys_origin_shape_check CHECK (
					(origin_type='standalone' AND program_id IS NULL) OR
					(origin_type='program' AND (program_id IS NOT NULL OR origin_label<>''))
				);
			END IF;
		END $$`,
		`CREATE INDEX IF NOT EXISTS idx_surveys_template_history ON surveys(account_id, template_id, created_at DESC) WHERE template_id IS NOT NULL`,
		`CREATE INDEX IF NOT EXISTS idx_surveys_program_history ON surveys(account_id, program_id, created_at DESC) WHERE program_id IS NOT NULL`,
		`ALTER TABLE survey_questions ADD COLUMN IF NOT EXISTS source_template_question_id UUID`,
		`ALTER TABLE survey_questions ADD COLUMN IF NOT EXISTS template_revision INTEGER NOT NULL DEFAULT 1`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_survey_questions_survey_id ON survey_questions(survey_id, id)`,
		`DO $$ BEGIN
			IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='survey_questions_source_template_fkey') THEN
				ALTER TABLE survey_questions ADD CONSTRAINT survey_questions_source_template_fkey
				FOREIGN KEY (source_template_question_id) REFERENCES survey_template_questions(id) ON DELETE SET NULL;
			END IF;
		END $$`,
		`CREATE INDEX IF NOT EXISTS idx_survey_questions_source_template ON survey_questions(source_template_question_id) WHERE source_template_question_id IS NOT NULL`,
		`CREATE TABLE IF NOT EXISTS survey_instance_recipients (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			survey_id UUID NOT NULL,
			program_id UUID,
			program_participant_id UUID,
			contact_id UUID,
			access_token UUID NOT NULL DEFAULT gen_random_uuid(),
			status TEXT NOT NULL DEFAULT 'pending',
			invited_at TIMESTAMPTZ,
			opened_at TIMESTAMPTZ,
			completed_at TIMESTAMPTZ,
			merged_into_recipient_id UUID,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			CONSTRAINT survey_instance_recipients_status_check CHECK (status IN ('pending','opened','completed')),
			CONSTRAINT survey_instance_recipients_program_shape_check CHECK (
				(program_participant_id IS NULL AND program_id IS NULL) OR
				(program_participant_id IS NOT NULL AND program_id IS NOT NULL AND contact_id IS NOT NULL)
			),
			CONSTRAINT survey_instance_recipients_account_survey_fkey
				FOREIGN KEY (account_id, survey_id) REFERENCES surveys(account_id, id) ON DELETE CASCADE,
			CONSTRAINT survey_instance_recipients_account_program_fkey
				FOREIGN KEY (account_id, program_id) REFERENCES programs(account_id, id) ON DELETE CASCADE,
			CONSTRAINT survey_instance_recipients_program_participant_fkey
				FOREIGN KEY (program_id, program_participant_id) REFERENCES program_participants(program_id, id) ON UPDATE CASCADE ON DELETE CASCADE,
			CONSTRAINT survey_instance_recipients_program_contact_fkey
				FOREIGN KEY (program_id, contact_id) REFERENCES program_participants(program_id, contact_id) ON UPDATE CASCADE ON DELETE CASCADE,
			CONSTRAINT survey_instance_recipients_program_identity_fkey
				FOREIGN KEY (program_id, program_participant_id, contact_id) REFERENCES program_participants(program_id, id, contact_id) ON UPDATE CASCADE ON DELETE CASCADE,
			CONSTRAINT survey_instance_recipients_account_contact_fkey
				FOREIGN KEY (account_id, contact_id) REFERENCES contacts(account_id, id) ON DELETE CASCADE
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_survey_instance_recipients_account_id ON survey_instance_recipients(account_id, id)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_survey_instance_recipients_account_survey_id ON survey_instance_recipients(account_id, survey_id, id)`,
		`ALTER TABLE survey_instance_recipients ADD COLUMN IF NOT EXISTS merged_into_recipient_id UUID`,
		`DO $$ BEGIN
			IF NOT EXISTS (
				SELECT 1 FROM pg_constraint
				WHERE conname='survey_instance_recipients_merge_shape_check'
				  AND conrelid='survey_instance_recipients'::regclass
			) THEN
				ALTER TABLE survey_instance_recipients ADD CONSTRAINT survey_instance_recipients_merge_shape_check CHECK (
					merged_into_recipient_id IS NULL OR (
						merged_into_recipient_id<>id AND program_id IS NULL
						AND program_participant_id IS NULL AND contact_id IS NULL
					)
				);
			END IF;
		END $$`,
		`DO $$ BEGIN
			IF NOT EXISTS (
				SELECT 1 FROM pg_constraint
				WHERE conname='survey_instance_recipients_merged_into_fkey'
				  AND conrelid='survey_instance_recipients'::regclass
			) THEN
				ALTER TABLE survey_instance_recipients ADD CONSTRAINT survey_instance_recipients_merged_into_fkey
				FOREIGN KEY (account_id,survey_id,merged_into_recipient_id)
				REFERENCES survey_instance_recipients(account_id,survey_id,id) ON DELETE CASCADE;
			END IF;
		END $$`,
		`CREATE INDEX IF NOT EXISTS idx_survey_instance_recipients_merged_into
			ON survey_instance_recipients(account_id,survey_id,merged_into_recipient_id)
			WHERE merged_into_recipient_id IS NOT NULL`,
		`DO $$ BEGIN
			IF NOT EXISTS (
				SELECT 1 FROM pg_constraint
				WHERE conname='survey_instance_recipients_program_participant_fkey'
				  AND conrelid='survey_instance_recipients'::regclass
			) THEN
				ALTER TABLE survey_instance_recipients ADD CONSTRAINT survey_instance_recipients_program_participant_fkey
				FOREIGN KEY (program_id, program_participant_id) REFERENCES program_participants(program_id, id) ON UPDATE CASCADE ON DELETE CASCADE;
			ELSIF EXISTS (
				SELECT 1 FROM pg_constraint
				WHERE conname='survey_instance_recipients_program_participant_fkey'
				  AND conrelid='survey_instance_recipients'::regclass AND confupdtype<>'c'
			) THEN
				ALTER TABLE survey_instance_recipients DROP CONSTRAINT survey_instance_recipients_program_participant_fkey;
				ALTER TABLE survey_instance_recipients ADD CONSTRAINT survey_instance_recipients_program_participant_fkey
				FOREIGN KEY (program_id, program_participant_id) REFERENCES program_participants(program_id, id) ON UPDATE CASCADE ON DELETE CASCADE;
			END IF;
		END $$`,
		`DO $$ BEGIN
			IF NOT EXISTS (
				SELECT 1 FROM pg_constraint
				WHERE conname='survey_instance_recipients_program_contact_fkey'
				  AND conrelid='survey_instance_recipients'::regclass
			) THEN
				ALTER TABLE survey_instance_recipients ADD CONSTRAINT survey_instance_recipients_program_contact_fkey
				FOREIGN KEY (program_id, contact_id) REFERENCES program_participants(program_id, contact_id) ON UPDATE CASCADE ON DELETE CASCADE;
			ELSIF EXISTS (
				SELECT 1 FROM pg_constraint
				WHERE conname='survey_instance_recipients_program_contact_fkey'
				  AND conrelid='survey_instance_recipients'::regclass AND confupdtype<>'c'
			) THEN
				ALTER TABLE survey_instance_recipients DROP CONSTRAINT survey_instance_recipients_program_contact_fkey;
				ALTER TABLE survey_instance_recipients ADD CONSTRAINT survey_instance_recipients_program_contact_fkey
				FOREIGN KEY (program_id, contact_id) REFERENCES program_participants(program_id, contact_id) ON UPDATE CASCADE ON DELETE CASCADE;
			END IF;
		END $$`,
		`DO $$ BEGIN
			IF NOT EXISTS (
				SELECT 1 FROM pg_constraint
				WHERE conname='survey_instance_recipients_program_identity_fkey'
				  AND conrelid='survey_instance_recipients'::regclass
			) THEN
				ALTER TABLE survey_instance_recipients ADD CONSTRAINT survey_instance_recipients_program_identity_fkey
				FOREIGN KEY (program_id, program_participant_id, contact_id) REFERENCES program_participants(program_id, id, contact_id) ON UPDATE CASCADE ON DELETE CASCADE;
			ELSIF EXISTS (
				SELECT 1 FROM pg_constraint
				WHERE conname='survey_instance_recipients_program_identity_fkey'
				  AND conrelid='survey_instance_recipients'::regclass AND confupdtype<>'c'
			) THEN
				ALTER TABLE survey_instance_recipients DROP CONSTRAINT survey_instance_recipients_program_identity_fkey;
				ALTER TABLE survey_instance_recipients ADD CONSTRAINT survey_instance_recipients_program_identity_fkey
				FOREIGN KEY (program_id, program_participant_id, contact_id) REFERENCES program_participants(program_id, id, contact_id) ON UPDATE CASCADE ON DELETE CASCADE;
			END IF;
		END $$`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_survey_instance_recipients_token ON survey_instance_recipients(access_token)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_survey_instance_recipients_participant ON survey_instance_recipients(account_id, survey_id, program_participant_id) WHERE program_participant_id IS NOT NULL`,
		`CREATE INDEX IF NOT EXISTS idx_survey_instance_recipients_status ON survey_instance_recipients(account_id, survey_id, status)`,
		`ALTER TABLE survey_responses ADD COLUMN IF NOT EXISTS recipient_id UUID`,
		`ALTER TABLE survey_responses ADD COLUMN IF NOT EXISTS contact_id UUID`,
		`ALTER TABLE survey_responses ADD COLUMN IF NOT EXISTS program_id UUID`,
		`ALTER TABLE survey_responses ADD COLUMN IF NOT EXISTS program_participant_id UUID`,
		`UPDATE survey_responses sr SET account_id=s.account_id
		 FROM surveys s WHERE sr.survey_id=s.id AND sr.account_id IS DISTINCT FROM s.account_id`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_survey_responses_survey_id ON survey_responses(survey_id, id)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_survey_responses_recipient ON survey_responses(recipient_id) WHERE recipient_id IS NOT NULL`,
		`DO $$ BEGIN
			IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='survey_responses_account_survey_fkey') THEN
				ALTER TABLE survey_responses ADD CONSTRAINT survey_responses_account_survey_fkey
				FOREIGN KEY (account_id, survey_id) REFERENCES surveys(account_id, id) ON DELETE CASCADE;
			END IF;
		END $$`,
		`DO $$ BEGIN
			IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='survey_responses_account_recipient_fkey') THEN
				ALTER TABLE survey_responses ADD CONSTRAINT survey_responses_account_recipient_fkey
				FOREIGN KEY (account_id, recipient_id) REFERENCES survey_instance_recipients(account_id, id) ON DELETE SET NULL (recipient_id);
			END IF;
		END $$`,
		`DO $$ BEGIN
			IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='survey_responses_account_survey_recipient_fkey') THEN
				ALTER TABLE survey_responses ADD CONSTRAINT survey_responses_account_survey_recipient_fkey
				FOREIGN KEY (account_id, survey_id, recipient_id) REFERENCES survey_instance_recipients(account_id, survey_id, id) ON DELETE SET NULL (recipient_id);
			END IF;
		END $$`,
		`DO $$ BEGIN
			IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='survey_responses_account_contact_fkey') THEN
				ALTER TABLE survey_responses ADD CONSTRAINT survey_responses_account_contact_fkey
				FOREIGN KEY (account_id, contact_id) REFERENCES contacts(account_id, id) ON DELETE SET NULL (contact_id);
			END IF;
		END $$`,
		`DO $$ BEGIN
			IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='survey_responses_account_program_fkey') THEN
				ALTER TABLE survey_responses ADD CONSTRAINT survey_responses_account_program_fkey
				FOREIGN KEY (account_id, program_id) REFERENCES programs(account_id, id) ON DELETE SET NULL (program_id);
			END IF;
		END $$`,
		`DO $$ BEGIN
			IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='survey_responses_program_participant_fkey') THEN
				ALTER TABLE survey_responses ADD CONSTRAINT survey_responses_program_participant_fkey
				FOREIGN KEY (program_id, program_participant_id) REFERENCES program_participants(program_id, id) ON DELETE SET NULL (program_participant_id);
			END IF;
		END $$`,
		`ALTER TABLE survey_answers ADD COLUMN IF NOT EXISTS survey_id UUID`,
		`UPDATE survey_answers sa SET survey_id=sr.survey_id FROM survey_responses sr WHERE sa.response_id=sr.id AND sa.survey_id IS NULL`,
		`ALTER TABLE survey_answers ALTER COLUMN survey_id SET NOT NULL`,
		`DO $$ BEGIN
			IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='survey_answers_survey_response_fkey') THEN
				ALTER TABLE survey_answers ADD CONSTRAINT survey_answers_survey_response_fkey
				FOREIGN KEY (survey_id, response_id) REFERENCES survey_responses(survey_id, id) ON DELETE CASCADE;
			END IF;
		END $$`,
		`DO $$ BEGIN
			IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='survey_answers_survey_question_fkey') THEN
				ALTER TABLE survey_answers ADD CONSTRAINT survey_answers_survey_question_fkey
				FOREIGN KEY (survey_id, question_id) REFERENCES survey_questions(survey_id, id) ON DELETE CASCADE;
			END IF;
		END $$`,
		`CREATE TABLE IF NOT EXISTS survey_file_uploads (
			id UUID PRIMARY KEY,
			account_id UUID NOT NULL,
			survey_id UUID NOT NULL,
			question_id UUID NOT NULL,
			recipient_id UUID,
			respondent_token TEXT NOT NULL,
			access_token UUID NOT NULL DEFAULT gen_random_uuid(),
			media_asset_id UUID NOT NULL,
			object_key TEXT NOT NULL,
			original_filename TEXT NOT NULL DEFAULT '',
			content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
			size_bytes BIGINT NOT NULL,
			status TEXT NOT NULL DEFAULT 'staged',
			expires_at TIMESTAMPTZ NOT NULL,
			response_id UUID,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			CONSTRAINT survey_file_uploads_status_check CHECK (status IN ('staged','deleting','attached','deleted')),
			CONSTRAINT survey_file_uploads_size_check CHECK (size_bytes > 0),
			CONSTRAINT survey_file_uploads_account_survey_fkey
				FOREIGN KEY (account_id,survey_id) REFERENCES surveys(account_id,id) ON DELETE CASCADE,
			CONSTRAINT survey_file_uploads_survey_question_fkey
				FOREIGN KEY (survey_id,question_id) REFERENCES survey_questions(survey_id,id) ON DELETE RESTRICT,
			CONSTRAINT survey_file_uploads_account_recipient_fkey
				FOREIGN KEY (account_id,survey_id,recipient_id) REFERENCES survey_instance_recipients(account_id,survey_id,id) ON DELETE CASCADE,
			CONSTRAINT survey_file_uploads_account_media_asset_fkey
				FOREIGN KEY (account_id,media_asset_id) REFERENCES media_assets(account_id,id) ON DELETE RESTRICT,
			CONSTRAINT survey_file_uploads_survey_response_fkey
				FOREIGN KEY (survey_id,response_id) REFERENCES survey_responses(survey_id,id) ON DELETE RESTRICT,
			UNIQUE(access_token),
			UNIQUE(account_id,object_key),
			UNIQUE(survey_id,id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_survey_file_uploads_gc
			ON survey_file_uploads(expires_at,id) WHERE status IN ('staged','deleting')`,
		`CREATE INDEX IF NOT EXISTS idx_survey_file_uploads_owner
			ON survey_file_uploads(account_id,survey_id,recipient_id,respondent_token,status)`,
		`ALTER TABLE survey_answers ADD COLUMN IF NOT EXISTS survey_upload_id UUID`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_survey_answers_upload
			ON survey_answers(survey_upload_id) WHERE survey_upload_id IS NOT NULL`,
		`DO $$ BEGIN
			IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='survey_answers_survey_upload_fkey') THEN
				ALTER TABLE survey_answers ADD CONSTRAINT survey_answers_survey_upload_fkey
				FOREIGN KEY (survey_id,survey_upload_id) REFERENCES survey_file_uploads(survey_id,id) ON DELETE RESTRICT;
			END IF;
		END $$`,
		`INSERT INTO survey_templates (
			account_id,name,description,status,welcome_title,welcome_description,
			thank_you_title,thank_you_message,thank_you_redirect_url,branding,revision,
			legacy_survey_id,created_by,created_at,updated_at
		)
		SELECT s.account_id,s.name,s.description,'active',s.welcome_title,s.welcome_description,
			s.thank_you_title,s.thank_you_message,s.thank_you_redirect_url,s.branding,1,
			s.id,s.created_by,s.created_at,s.updated_at
		FROM surveys s
		WHERE s.template_id IS NULL
		  AND NOT EXISTS (
			SELECT 1 FROM survey_templates st
			WHERE st.account_id=s.account_id AND st.legacy_survey_id=s.id
		)`,
		`INSERT INTO survey_template_questions (
			id,account_id,template_id,order_index,type,title,description,required,config,logic_rules,is_active,created_at,updated_at
		)
		SELECT sq.id,s.account_id,st.id,sq.order_index,sq.type,sq.title,sq.description,sq.required,sq.config,sq.logic_rules,TRUE,sq.created_at,sq.updated_at
		FROM survey_questions sq
		JOIN surveys s ON s.id=sq.survey_id
		JOIN survey_templates st ON st.account_id=s.account_id AND st.legacy_survey_id=s.id
		WHERE s.template_id IS NULL
		ON CONFLICT (id) DO NOTHING`,
		`UPDATE surveys s SET template_id=st.id,template_revision=1,origin_type='standalone',program_id=NULL,
			origin_label=CASE WHEN s.origin_label='' THEN 'Aplicación heredada' ELSE s.origin_label END,
			legacy_instance=TRUE
		FROM survey_templates st
		WHERE st.account_id=s.account_id AND st.legacy_survey_id=s.id
		  AND s.template_id IS NULL`,
		`UPDATE survey_questions sq SET source_template_question_id=stq.id,template_revision=1
		FROM surveys s
		JOIN survey_templates st ON st.account_id=s.account_id AND st.legacy_survey_id=s.id
		JOIN survey_template_questions stq ON stq.account_id=st.account_id AND stq.template_id=st.id
		WHERE sq.survey_id=s.id AND s.legacy_instance AND stq.id=sq.id
		  AND sq.source_template_question_id IS DISTINCT FROM stq.id`,
	}
}
