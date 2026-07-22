---
name: clarin-database-changes
description: Use when changing Clarin PostgreSQL schema, migrations, indexes, constraints, backfills, account-scoped repairs, or repository persistence contracts.
---

# Clarin Database Changes

## Migration Model

- Runtime migrations live in the main `Migrate()` path in `backend/pkg/database/database.go`, invoked during startup by `InitDB()`.
- Required production schema must be in that main `Migrate()`/startup migration list. Do not put required schema only in `SeedAdmin`, seed helpers, admin bootstrap, tests, or one-off setup.
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

## Program Participation Integrity

- `program_participants.enrolled_at` is the real participation start, not an immutable row-created timestamp. Keep automatic defaults, but support explicit account-scoped updates without rewriting attendance.
- Attendance eligibility uses session calendar dates inside the inclusive range from `enrolled_at` through the earliest non-null `dropped_at`/`completed_at`. Keep recorded attendance outside that range as historical data.
- Never backfill or infer `enrolled_at` from the earliest attendance automatically. Ambiguous historical corrections require an explicit user action.
- Preserve withdrawn/completed Program participation rows and dependent attendance/notes. Physical annulment is allowed only after a same-account transaction proves that no historical activity exists.
- Survey schema migrations must preserve legacy slugs, questions, responses and answers. Template revisions and answerable instances are separate account-scoped records; editing a template cannot cascade into historical answers.
- Index account/program/participant/date paths used by attendance summaries and verify period-boundary queries against PostgreSQL.

## Required Code Updates

- Update `backend/internal/domain/entities.go` when persisted fields change.
- Update repository SELECT/INSERT/UPDATE/scan code together with schema changes.
- Add indexes for new filters, joins, orderings, uniqueness constraints, or frequent lookups.
- Keep API DTOs and frontend types aligned when schema changes affect public responses.
- Cast reused PostgreSQL parameters explicitly when one placeholder appears in different inference contexts such as VARCHAR assignment plus TEXT comparison, CASE branches, arrays, JSON, or nullable expressions.
- For media ownership, prefer composite account-scoped foreign keys or equivalent checks so a valid ID from another account can never attach to the current account.

## Verification

- Run backend tests after database changes:

```bash
GOCACHE=/tmp/go-build go test ./...
```

- For risky migrations, inspect startup logs or run the migration path in a local database before claiming it is verified.
- Prepare or execute fragile repository SQL against PostgreSQL when parameter typing, constraints, triggers, or transaction behavior are part of the change; Go compilation and mocks do not cover PostgreSQL inference.
- If the user asks to deploy a database change, run `make deploy` from the repository root and verify the real PostgreSQL container with a focused `docker exec clarin-postgres psql -U clarin -d clarin -c ...` check.
- Do not claim a table, column, index, or constraint exists in production unless it was verified in the live database after deployment.
