package database

// surveyPublicSlugReservationMigrations creates the permanent registry for
// public survey links. owner_account_id and survey_id intentionally have no
// foreign keys: these UUIDs are historical ownership evidence and must survive
// deletion of the account or survey that originally owned the URL.
func surveyPublicSlugReservationMigrations() []string {
	return []string{
		`CREATE TABLE IF NOT EXISTS survey_public_slug_reservations (
			slug TEXT PRIMARY KEY,
			owner_account_id UUID NOT NULL,
			survey_id UUID NOT NULL,
			reserved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			retired_at TIMESTAMPTZ
		)`,
		`COMMENT ON TABLE survey_public_slug_reservations IS
			'Permanent global survey URL registry. Historical UUID ownership deliberately survives survey/account deletion.'`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_survey_public_slug_active_survey
			ON survey_public_slug_reservations(survey_id) WHERE retired_at IS NULL`,
		`CREATE INDEX IF NOT EXISTS idx_survey_public_slug_owner
			ON survey_public_slug_reservations(owner_account_id,reserved_at DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_survey_public_slug_retired
			ON survey_public_slug_reservations(retired_at) WHERE retired_at IS NOT NULL`,
		`INSERT INTO survey_public_slug_reservations (
			slug,owner_account_id,survey_id,reserved_at,retired_at
		)
		SELECT s.slug,s.account_id,s.id,s.created_at,NULL
		FROM surveys s
		WHERE BTRIM(s.slug)<>''
		ON CONFLICT (slug) DO NOTHING`,
		`DO $$ BEGIN
			IF EXISTS (
				SELECT 1
				FROM surveys s
				LEFT JOIN survey_public_slug_reservations reservation
				  ON reservation.slug=s.slug
				 AND reservation.owner_account_id=s.account_id
				 AND reservation.survey_id=s.id
				 AND reservation.retired_at IS NULL
				WHERE BTRIM(s.slug)<>'' AND reservation.slug IS NULL
			) THEN
				RAISE EXCEPTION 'survey public slug reservation backfill mismatch';
			END IF;
		END $$`,
	}
}
