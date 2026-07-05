# Clarin Codex Instructions

These instructions are the source of truth for Codex in this repository. Read them before making product, backend, frontend, database, storage, Kommo, MCP, QA, or documentation changes.

## Vocabulary And Product Truth

- Clarin uses `accounts` as cuentas/tenants. Say "cuenta" or "tenant"; do not say "empresa" unless quoting literal UI text or an existing database/API field.
- `Contact` is the parent entity. `Lead` and `Chat` are parallel children linked to a contact.
- Every account-scoped read, write, repair, import, cleanup, or MCP action must preserve `account_id` isolation.
- Kommo API communication is dormant. Do not start pollers, outbox jobs, webhooks, API sync, or frontend sync actions unless the user explicitly asks to reactivate Kommo API behavior.
- Local Kommo Excel import remains valid and may use Kommo compatibility metadata and phone normalization.

## Mandatory Local Skill Routing

Before changing any area below, read the matching local skill completely:

- Backend/API/services/repositories/domain/WhatsApp: `.codex/skills/clarin-backend-development/SKILL.md`
- Frontend/pages/components/API client/WebSocket UI state: `.codex/skills/clarin-frontend-development/SKILL.md`
- Database schema, migrations, indexes, backfills, data repairs: `.codex/skills/clarin-database-changes/SKILL.md`
- Verification, builds, test strategy, final confidence checks: `.codex/skills/clarin-quality-assurance/SKILL.md`
- MinIO/S3/media/storage cleanup or inventory: `.codex/skills/clarin-storage-management/SKILL.md`
- Kommo import/status tags/phone normalization/compatibility fields: `.codex/skills/clarin-kommo-integration/SKILL.md`
- MCP server, MCP admin UI, credentials, sessions, audit, tools, or docs: `.codex/skills/clarin-mcp-security/SKILL.md`

If a task touches multiple areas, read all matching skills before editing.

## MCP Rules

- MCP is configured globally per connection from `Admin -> MCP Global`.
- The primary MCP endpoint is `/mcp`.
- `/mcp/sse` is legacy compatibility only.
- ChatGPT custom MCP connectors use OAuth: `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/oauth/authorize`, and `/oauth/token`.
- MCP OAuth uses manual user-defined clients with PKCE S256 and exact ChatGPT redirect URIs; do not enable open DCR unless explicitly requested.
- `mcp_enabled` on accounts is legacy and must not be treated as the global MCP switch.
- Account API Keys are legacy credentials for account-specific integrations; they do not configure or authenticate MCP Global.
- Every global MCP client must be unique, revocable, auditable, and tied to explicit allowed account IDs.
- MCP tools that expose account data must require a selected/allowed account context and must never leak data across accounts.

## Verification Baseline

- Backend changes: run `GOCACHE=/tmp/go-build go test ./...` from `backend`. Add `go build` or Docker build when the change affects startup, compile-time wiring, generated assets, or deployment behavior.
- Frontend changes: run `npx tsc --noEmit` from `frontend`; run `npm run build` when routes, components, API contracts, or production rendering can be affected.
- Database/storage/MCP/security changes need focused manual reasoning in addition to automated checks.
- Do not claim deployment or runtime health unless you actually ran the relevant deploy/log/health commands.

## Mandatory Deployment Rule

- If the user asks to deploy, says "despliega", "aplica en producción", "aplícalo", "main", or otherwise makes clear the change must reach the running system, do not stop at tests or builds.
- Deploy from `/root/proyect/clarin` with the repository deployment flow: `make deploy`.
- A deployment is not complete until runtime verification has actually run:
  - `docker ps --filter name=clarin`
  - `docker exec clarin-backend wget -qO- http://127.0.0.1:8080/health`
  - backend/frontend logs with `docker logs --tail=...`
  - `/api/version` when version/startup wiring is relevant
- For database or MCP schema changes, verify the real PostgreSQL container after deploy with `docker exec clarin-postgres psql -U clarin -d clarin -c ...`.
- For MCP changes, also verify `/mcp` without a bearer token returns `401 Unauthorized`.
- New runtime migrations must live in the main `Migrate()`/startup migration list in `backend/pkg/database/database.go`; never place required schema only in `SeedAdmin`, seed helpers, admin bootstrap, or one-off setup.
- Never tell the user something is deployed, migrated, healthy, or protected unless those exact runtime checks were performed in this session.

## Git And Safety

- Do not revert unrelated work in the tree. Treat existing dirty files as active user work unless the user explicitly asks to discard them.
- Do not print or commit secrets, `.env` contents, JWTs, cookies, API keys, MinIO credentials, WhatsApp session material, or raw imported personal data.
- Keep changes focused and explain any remaining risk or unverified area clearly.
