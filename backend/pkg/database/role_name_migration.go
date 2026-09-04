package database

// normalizedRoleNameMigrations deliberately refuses to merge or rename
// existing roles. Operators must resolve any ambiguous duplicates explicitly
// before startup can enforce the canonical global name invariant.
func normalizedRoleNameMigrations() []string {
	return []string{
		`DO $$
		BEGIN
			IF EXISTS (
				SELECT 1
				FROM roles
				GROUP BY LOWER(BTRIM(name))
				HAVING COUNT(*) > 1
			) THEN
				RAISE EXCEPTION USING
					ERRCODE = '23505',
					CONSTRAINT = 'uq_roles_name_normalized',
					MESSAGE = 'cannot enforce normalized role-name uniqueness: duplicate role names exist';
			END IF;
		END $$`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_roles_name_normalized ON roles (LOWER(BTRIM(name)))`,
	}
}
