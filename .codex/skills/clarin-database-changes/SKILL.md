---
name: clarin-database-changes
description: Use when changing Clarin PostgreSQL schema, migrations, indexes, constraints, backfills, account-scoped repairs, or repository persistence contracts.
---

# Clarin Database Changes

## Migration Model

- Runtime migrations live in `backend/pkg/database/database.go` inside `InitDB()`.
- Required production schema must be in the main `Migrate()`/startup migration list. Do not put required schema only in `SeedAdmin`, seed helpers, admin bootstrap, or one-off setup.
- Migrations run repeatedly, so schema SQL must be idempotent: `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, and `CREATE INDEX IF NOT EXISTS`.
- Keep legacy columns only when compatibility requires them; do not treat legacy flags as active product configuration.

## Account Isolation

- Every table with tenant data needs an `account_id` boundary unless there is a documented global reason.
- Backfills, repairs, deletes, deduplication, and contact relinking must never connect data across accounts.
- Prefer explicit transactions for multi-table repairs and destructive operations.

## Contact / Lead / Chat Integrity

- `contacts` is the parent table. `leads` and `chats` should link to contacts in the same account.
- Do not create new flows that allow leads or chats without a valid contact.
- Before tightening constraints, repair existing same-account orphan rows by normalized phone or safely quarantine/delete only with clear criteria.

## Required Code Updates

- Update `backend/internal/domain/entities.go` when persisted fields change.
- Update repository SELECT/INSERT/UPDATE/scan code together with schema changes.
- Add indexes for new filters, joins, orderings, uniqueness constraints, or frequent lookups.
- Keep API DTOs and frontend types aligned when schema changes affect public responses.

## Verification

- Run backend tests after database changes:

```bash
GOCACHE=/tmp/go-build go test ./...
```

- For risky migrations, inspect startup logs or run the migration path in a local database before claiming it is verified.
- If the user asks to deploy a database change, run `make deploy` from the repository root and verify the real PostgreSQL container with a focused `docker exec clarin-postgres psql -U clarin -d clarin -c ...` check.
- Do not claim a table, column, index, or constraint exists in production unless it was verified in the live database after deployment.
