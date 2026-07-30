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
- Clarin Work, tasks, Kanban, task folders/lists/workflows/statuses, ordering, filters/saved views, task detail, subtasks, comments, dependencies, Gantt/calendar, or task realtime behavior: `.codex/skills/clarin-task-work-experience/SKILL.md` plus every matching layer skill above.

If a task touches multiple areas, read all matching skills before editing.

## Contact And Program Product Invariants

- `ContactDetailSurface` is the canonical identity surface for Contactos, Leads, Chats, Eventos and Programas. Keep identity, phones, email, photo, tags, notes, custom fields and contact history single-sourced from `Contact`; module sections must contain only contextual data.
- `program_participants.enrolled_at` represents the participant's real start date in the program. New participants receive it automatically, but authorized users must be able to correct it explicitly; never infer or move it automatically from attendance rows.
- Individual attendance counts only held sessions in the calendar-date window `enrolled_at <= session.date < earliest(dropped_at, completed_at)`. Enrollment is inclusive; withdrawal and completion are the first excluded day. Preserve real out-of-window attendance as clearly labelled history and never include it in rates.
- A Contact may participate in many Programs, but enrollment dates, lifecycle status, attendance, observations, outcomes and rates belong to the specific `program_participant_id`. Never merge or present one unqualified attendance score across Programs.
- Operational Program rosters default to active participants. Retired and completed participation remains available as history, is excluded from current headcount and current health, and still contributes to historical session metrics only when the session date was inside its participation window.
- `Retirar` is a lifecycle transition, not a deletion. Never physically delete a Program participation that has attendance, observations, notes or other activity; an administrative enrollment annulment is only valid for a proven empty enrollment created by mistake.
- Session attendance rosters and writes must enforce calendar-date eligibility in both frontend and backend. A session on the enrollment date is included; a session on the withdrawal/completion date is excluded. Corrections never delete attendance, and pending attendance is never an absence.
- Programs are groups of classes. New event workflows belong exclusively to the full Eventos module; do not reintroduce `type=event` creation inside Programas or duplicate Evento capabilities there.
- Contact tag editing must remain usable for very large catalogs: render assigned tags immediately, search a bounded server-side result set, and gate creation of global tags with `PermTags`; never load or render the entire tag catalog in every contact detail.
- Contact observation history must be user-expandable and lazy-loaded. Keep its count and add action available while collapsed, and keep the observation composer independent from the history list.

## Survey Product Invariants

- A survey template is reusable design only and never receives responses or owns a public link. A survey application/instance is the immutable answerable copy created from one template revision.
- Program survey applications belong to one Program and freeze their recipient audience at launch. Link each recipient and response to the canonical Contact and the specific `program_participant_id` so the same Contact can participate independently in multiple Programs.
- Editing a template must never mutate published applications, questions, answers, exports or analytics. Preserve existing public slugs and legacy responses during migrations; do not use delete-and-reinsert question flows once answers exist.
- Results are instance-specific. Template-level analytics may compare or aggregate instances only with explicit origin/revision filters and must never silently mix incompatible question revisions.

## Clarin Work Product Invariants

- Every task read, write, reorder, filter, saved view and WebSocket event is account-scoped. A task belongs to one real list; use the account default list only as a compatibility fallback.
- Folders contain lists, lists resolve workflows and workflows own statuses. Never assign a task a status from another workflow.
- Persist manual top-level task order inside its list and child order inside its parent. Creating, restoring, changing lists and moving on a board must allocate a safe durable position.
- Move task status and order atomically with optimistic concurrency. Never combine unrelated reorder and status calls or replace the order with only filtered/visible cards.
- Aggregate boards group heterogeneous workflows by category and map a drop to the task's real equivalent status. Disable destinations without a valid equivalent.
- Keep one responsible owner plus optional collaborators unless a deliberate full-stack migration introduces multi-owner semantics.
- Treat list hierarchy drag as one structural transaction: validate same-account folder/anchor, remap inherited workflows completely, persist destination order once, and roll back the whole operation on any incompatibility. The default task list remains fixed at the root.
- Present the root hierarchy as pinned default list, independent lists, then ordered folders. Folders and lists use validated catalog icon identifiers; structural drag of either kind produces at most one backend write and exact rollback.
- Folder-row click selects and toggles its accordion; the chevron toggles only. Active folders may remain collapsed, while selecting a concrete child list opens its parent. Task drops into navigation use real pointer coordinates, list-first measured targets, declarative highlight and at most one atomic bulk write.
- An explicit empty collaborator collection is canonical. Frontend reconciliation must not preserve stale collaborators when the last participant is removed.
- Real subtasks are one-level child tasks in the parent's list and compatible workflow. Do not expose the legacy checklist table as a second editable source.
- Archive task lists/folders only when they contain no active tasks. Child restore requires an active parent; concurrent structure/task mutations must lock and revalidate their dependencies inside one transaction.
- Completing a task is never deletion. Trash retention starts only from an explicit task `deleted_at`, list `archived_at`, or folder `archived_at`; never derive retention from done status, `completed_at`, progress, due dates, or reports. Permanent purge is manual, admin-only, retention-gated, exact-name confirmed, and atomic across an archived container tree.
- Aggregate Kanban anchors are same-list and same workflow category, not necessarily the same concrete status. Workflow changes must remap every affected task by category atomically or reject without partial changes.
- Treat task comments, mentions, attachments, activity and dependencies as task-scoped account data. Keep comment drafts, scroll and edits stable during realtime reconciliation.
- Page older task comments explicitly and preserve chronological order and scroll; never hide history behind a fixed unannounced limit.
- Patch task/order WebSocket events by stable ID/version/operation ID. Do not replace a populated board with skeletons or reload hierarchy for ordinary task/comment events.
- Base task detail layout on measured available surface width. Docked/floating modes leave the workspace interactive; maximized/mobile modes may block it.
- Apply the same measured window contract to full task creation. Preserve dirty drafts behind an explicit discard confirmation, and use viewport-aware portaled pickers for hierarchy/workflow choices.
- Keep task selection visually adaptive: completion is the only persistent card control, selection appears through hover/focus, modifiers, touch hold or active multi-select. Task dialogs and their portaled controls use one tested overlay order; floating dimming must not block the workspace.
- Keep task labels separate from Contact tags. Never reuse Contact identity metadata as task metadata without an explicit task model.
- Ship only task controls that work end to end across success, loading, empty, conflict, permission and failure states.

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

- Every functional modification must include or update a unit test in the nearest stable layer. Extract pure reducers/helpers when UI behavior otherwise depends on timing, geometry, drag state, reconciliation or payload construction. TypeScript, builds and browser tests complement this rule but do not replace it.

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
