# Clarin Codex Instructions

These instructions are the source of truth for Codex in this repository. Read them before making product, backend, frontend, database, storage, Kommo, MCP, QA, or documentation changes.

## Vocabulary And Product Truth

- Clarin uses `accounts` as cuentas/tenants. Say "cuenta" or "tenant"; do not say "empresa" unless quoting literal UI text or an existing database/API field.
- `Contact` is the parent entity. `Lead` and `Chat` are parallel children linked to a contact.
- Every account-scoped read, write, repair, import, cleanup, or MCP action must preserve `account_id` isolation.
- Kommo API communication is dormant. Do not start pollers, outbox jobs, webhooks, API sync, or frontend sync actions unless the user explicitly asks to reactivate Kommo API behavior.
- Local Kommo Excel import remains valid and may use Kommo compatibility metadata and phone normalization.

## Required Work Method

- Before editing, identify the requested outcome, current repository/runtime state, applicable local skills, affected layers, and non-negotiable product relationships.
- Inspect user screenshots/files and the current implementation that produced them. Treat reported examples as symptoms to generalize into a complete invariant, not as isolated pixels or one-off patches.
- Trace cross-layer features vertically from visible UI through state/API/backend/database/provider/storage/WebSocket and back to rendered UI before deciding that a control or flow works.
- Verify unstable assumptions against current code or runtime evidence. Do not rely on a previous plan, cached understanding, successful preview, or successful build as proof of end-to-end behavior.
- Distinguish analysis, implementation, and deployment scope. Do not mutate or deploy during a review-only request; do not stop at analysis/tests when the user explicitly asks to implement or deploy.
- When the user requests an exact historical appearance, find and compare the original implementation/asset before changing it.
- Preserve unrelated dirty work and state assumptions or remaining provider/session limitations clearly.

## Mandatory Local Skill Routing

Before changing any area below, read the matching local skill completely:

- Backend/API/services/repositories/domain/WhatsApp: `.codex/skills/clarin-backend-development/SKILL.md`
- Frontend/pages/components/API client/WebSocket UI state: `.codex/skills/clarin-frontend-development/SKILL.md`
- Database schema, migrations, indexes, backfills, data repairs: `.codex/skills/clarin-database-changes/SKILL.md`
- Verification, builds, test strategy, final confidence checks: `.codex/skills/clarin-quality-assurance/SKILL.md`
- MinIO/S3/media/storage cleanup or inventory: `.codex/skills/clarin-storage-management/SKILL.md`
- Kommo import/status tags/phone normalization/compatibility fields: `.codex/skills/clarin-kommo-integration/SKILL.md`
- MCP server, MCP admin UI, credentials, sessions, audit, tools, or docs: `.codex/skills/clarin-mcp-security/SKILL.md`
- Chats, WhatsApp devices/capabilities, messages/replies, chat details, contact avatars, statuses, stickers, or realtime chat UX: `.codex/skills/clarin-chat-whatsapp-experience/SKILL.md` plus every matching layer skill above.

If a task touches multiple areas, read all matching skills before editing.

## Chat And WhatsApp Product Invariants

- Treat `Contact` as the single identity parent. Render identity, phone, avatar, notes, and contact tags once. Opportunities may add commercial data but must not duplicate or contradict Contact data.
- Ship only controls that work end to end. A visible search, menu item, sync button, status action, sticker action, or delete action must have implemented success, loading, empty, and failure behavior; otherwise remove or explicitly disable it with an explanation.
- Base responsive chat layout on measured available width after sidebar, Eros, and other chrome—not on browser zoom or screen width alone. Preserve at least 480 px for the conversation whenever three columns are shown.
- Keep one vertical scroll owner in Details. Menus, pickers, and photo actions that can cross an overflow boundary must render through a viewport-aware portal.
- Never replace a populated chat list with skeletons because of WebSocket traffic. Patch the affected chat, deduplicate events, preserve stable keys/scroll/selection, and reconcile silently.
- Keep destructive chat actions visible through a row/menu control. Right-click may remain only as a shortcut, never as the sole discovery path.
- Treat device capability flags as product truth and enforce them in both UI and backend. Never expose unsupported WhatsApp Web or Cloud API behavior optimistically.
- Preserve reply/quote context across send, persistence, WebSocket reconciliation, history reload, and rendering. A reply must remain visibly recognizable as a reply.
- Keep historical branded visual assets, including the WhatsApp-style chat wallpaper, local and single-sourced. Do not replace an explicitly requested exact asset with a visual approximation.
- Fetch a WhatsApp avatar automatically only when creating the Contact. Later refreshes are explicit user actions with preview and confirmation; an empty/private WhatsApp result must never remove the current avatar automatically.
- Store only own WhatsApp statuses. Keep contact statuses out of Clarin, scope status events by account and device, reconcile remote deletion/revocation, and show viewer data only when supported by real receipts.
- Store avatar, status, sticker, and chat media under account-prefixed object keys with `media_assets`/`storage_objects` inventory. Delete physical media only after proving no live reference remains.

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
