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

- Visual design, layouts, controls, forms, tables, cards, sidebars, windows, dialogs, comboboxes, dates, overlays, drag interaction, motion, responsive behavior, or aesthetic consistency: `.codex/skills/clarin-interface-design-system/SKILL.md` plus the frontend, quality-assurance, and affected module skills.
- Backend/API/services/repositories/domain/WhatsApp: `.codex/skills/clarin-backend-development/SKILL.md`
- Frontend/pages/components/API client/WebSocket UI state: `.codex/skills/clarin-frontend-development/SKILL.md`
- Database schema, migrations, indexes, backfills, data repairs: `.codex/skills/clarin-database-changes/SKILL.md`
- Verification, builds, test strategy, final confidence checks: `.codex/skills/clarin-quality-assurance/SKILL.md`
- MinIO/S3/media/storage cleanup or inventory: `.codex/skills/clarin-storage-management/SKILL.md`
- Kommo import/status tags/phone normalization/compatibility fields: `.codex/skills/clarin-kommo-integration/SKILL.md`
- MCP server, MCP admin UI, credentials, sessions, audit, tools, or docs: `.codex/skills/clarin-mcp-security/SKILL.md`
- Chats, WhatsApp devices/capabilities, messages/replies, chat details, contact avatars, statuses, stickers, or realtime chat UX: `.codex/skills/clarin-chat-whatsapp-experience/SKILL.md` plus every matching layer skill above.
- Clarin Work, tasks, Kanban, task folders/lists/workflows/statuses, ordering, filters/saved views, task detail, subtasks, comments, dependencies, Gantt/calendar, or task realtime behavior: `.codex/skills/clarin-task-work-experience/SKILL.md` plus every matching layer skill above.
- Leads, CRM pipelines/stages, Eventos, event participants, their Kanban/list movement, Contact detail inside those modules, scoped observations, related task surfaces, or CRM realtime behavior: `.codex/skills/clarin-leads-events-experience/SKILL.md` plus every matching layer skill above. When the visible behavior creates, opens, updates, or reconciles real Clarin Work tasks, also read `.codex/skills/clarin-task-work-experience/SKILL.md`; do not apply Work-only Entorno or workflow rules to the surrounding CRM entity.

If a task touches multiple areas, read all matching skills before editing.

## Clarin Interface Design Invariants

- Treat visual quality and functional completeness as one requirement. A beautiful control that is ambiguous, clipped, inaccessible, inert, or unreliable is unfinished.
- Keep operational surfaces calm, dense, scannable, and proportional. Use measured available space, one deliberate scroll owner, progressive disclosure, and responsive reflow before truncation.
- Use professional viewport-aware portaled controls when choices need search, hierarchy, semantics, icons, colors, dates, time, or timezone; never let a picker render behind or outside its owning surface.
- Use simple modals for short blocking decisions and complete work-window behavior for complex creation/editing that benefits from drag, resize, docking, maximize/restore, remembered geometry, and mobile adaptation.
- Give click, completion, selection, drag, resize, and pan one stable gesture and cursor owner. Motion must explain state, avoid layout oscillation, and respect reduced-motion preferences.
- Design loading, empty, disabled, permission, validation, conflict, cancellation, rollback, retry, and canonical reconciliation states before calling a UI complete.
- Every user-typed search changes local results or starts remote work exactly 500 ms after the last keystroke. Text, clear, and selection feedback remain immediate; remote searches abort predecessors and reject stale completions.
- Derived counters and badges update with the source mutation and reconcile canonical server snapshots without requiring F5. A local `operation_id` may deduplicate echoes but must never suppress authoritative derived state.
- File viewers and other long async surfaces own a resource-scoped session and destroy fetches, polls, workers, documents, render tasks, URLs, canvas, and annotations when closed or switched.
- Complex filters and configuration surfaces use the same measured work-window contract when drag, resize, dock, maximize, draft/apply, or contextual inspection improves the workflow.
- Custom identity colors persist only as validated `#RRGGBB` values with contrast preview; icons remain allow-listed identifiers.

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

## Leads And Events Product Invariants

- Render Contact identity once. A Lead adds only commercial pipeline/lifecycle context, while an event participant adds only the selected Evento's stage, membership provenance and contextual activity; never adapt a participant into a fake Lead as a reusable identity model.
- Lead and event-participant detail use the measured operational-window contract: docked by default, movable/resizable floating mode, maximized mode and full-screen mobile. Docked/floating modes keep the board interactive; maximized/mobile modes may block it.
- Put context/stage in the window header, render Contact identity once, and order the single-scroll detail as Contact information, tags, direct observations, contextual data, related tasks, general Contact history, then integrations. The first three start open and the rest collapsed; do not replace this hierarchy with Summary/Activity tabs or a competing activity rail.
- Keep Observation, Message and Edit visible before scrolling; task creation belongs inside Related tasks. Direct Contact tag changes use bounded 500 ms remote search, permission-gated creation, pending feedback and exact rollback without opening the complete Contact editor.
- Label activity scope explicitly. Contact history is cross-module, Lead observations belong to one opportunity, and participant observations belong to one event participation; never present their union as one unqualified timeline.
- Direct observations preserve Nota/Llamada, author/origin and timestamp. Opening Message temporarily maximizes the CRM window and must restore the exact prior mode, geometry, scroll, accordion state and focus when chat closes.
- Related CRM tasks are real Clarin Work tasks. Query them through actor-authorized task paths and open/create them with the canonical task detail/editor, preserving Entorno, list, workflow, permission and realtime truth.
- Lead and participant drag changes stage only and uses the shared DndKit visual language from Tareas: explicit handle, 520 ms touch pickup, attenuated source, stable placeholder, highlighted destination, stacked overlay/count and roughly 180 ms drop. It snapshots complete visible state, emits at most one logical write, and restores cards, counts, selection and open detail exactly after cancellation, conflict or failure. Canonical HTTP/WebSocket state wins without skeleton flashes, duplicates or F5.
- If `Sin etapa` is rendered as a Lead or participant drop target, persist it as an explicit nullable stage (`stage_id: null`) and reconcile its cards, counts, stale stage labels, rollback and realtime payloads exactly; never expose a fake droppable bucket.
- Completed or cancelled Eventos preserve readable history but disable event-context mutations honestly. Contact-owned edits remain governed by Contact capabilities rather than event lifecycle.

## Survey Product Invariants

- A survey template is reusable design only and never receives responses or owns a public link. A survey application/instance is the immutable answerable copy created from one template revision.
- Program survey applications belong to one Program and freeze their recipient audience at launch. Link each recipient and response to the canonical Contact and the specific `program_participant_id` so the same Contact can participate independently in multiple Programs.
- Editing a template must never mutate published applications, questions, answers, exports or analytics. Preserve existing public slugs and legacy responses during migrations; do not use delete-and-reinsert question flows once answers exist.
- Results are instance-specific. Template-level analytics may compare or aggregate instances only with explicit origin/revision filters and must never silently mix incompatible question revisions.
- Permanently delete only a locked canonical application proven to have no session, response, recipient interaction or live file. Pending frozen recipients alone do not count as interaction. Applications with history are archived reversibly, close their public link with `410 survey_archived`, preserve analytics, and restore as closed rather than republished.
- Text-answer analytics are application- and question-scoped, account-isolated, completed-only and cursor-paged. Preserve multiline/Unicode content, exact Program participation identity and public anonymity; expose real answer-type labels instead of classifying dates, email, phone or files as free text.
- Reserve every public survey slug globally and historically. Archiving preserves the active reservation, permanent deletion retires it, and neither account deletion nor later creation may reuse it; a retired `/f/:slug` returns `410 survey_link_retired` without revealing its former account.
- XLSX result reports are application- and account-scoped, keep public responses anonymous, preserve exact Program participation identity, stream detailed response rows, and use editable charts backed only by hidden internal ranges. Treat every user-authored cell as text so formula-like content cannot execute.

## Clarin Work Product Invariants

- The hierarchy is `Cuenta -> Entorno -> optional Folder -> List -> Task -> one-level Subtask`. An Entorno is an account-scoped collaboration boundary, never another tenant. Workflows, statuses, folders and lists belong to exactly one Entorno; a task derives its Entorno only from its real list.
- General preserves the migrated account's prior functional access. New Entornos are private, atomically create their default workflow/statuses and pinned inbox, and grant their creator explicit Administrar plus access governance. Folder/list/workflow structure never moves across Entornos; only tasks may move explicitly with category remapping and complete rollback.
- Require at least Ver on the Entorno before any folder/list/task grant is effective. Resolve authorization as account admin recovery, root-task grant, task privacy, list grant, list privacy, folder grant, folder privacy, Entorno grant, then Entorno default. Specific grants may raise, lower or deny inherited access; subtasks always inherit the root task and cannot own grants. Hidden resources return `404`, while a visible resource with an insufficient action returns `403`.
- Treat Ver, Comentar, Editar and Administrar as fixed cumulative levels. `can_manage_access` is separate governance that requires Administrar. Participation never silently grants access: adding an owner/collaborator who cannot edit requires one confirmed transactional task grant, and removing participation does not revoke it.
- Every task query, count, search, report, calendar/Gantt result, Trash row, relation and realtime recipient set is actor-authorized in the repository/query layer. “Todo el Entorno” and “Compartidas conmigo” never cross the active Entorno. The shared Hub shows only direct folder/list/root-task grants; inherited descendants are not duplicate roots, and inaccessible parent breadcrumbs remain hidden. Revocation sends only a minimal tombstone and invalidates user/Entorno-specific caches and counts.
- Reject new folder/list/task grants to users without Entorno Ver. Keep historical child grants durable but inactive until Entorno access returns; participant confirmation and cross-Entorno movement must never bypass this boundary.
- Task and hierarchy collections use stable cursor pagination with default `50` and maximum `200`; total cardinality must not determine one response size. Searchable remote catalogs debounce exactly 500 ms, abort predecessors and reject stale results.
- Every task read, write, reorder, filter, saved view and WebSocket event is account-scoped. A task belongs to one real list; use the account default list only as a compatibility fallback.
- Folders contain lists, lists resolve workflows and workflows own statuses. Never assign a task a status from another workflow.
- Persist manual top-level task order inside its list and child order inside its parent. Creating, restoring, changing lists and moving on a board must allocate a safe durable position.
- Move task status and order atomically with optimistic concurrency. Never combine unrelated reorder and status calls or replace the order with only filtered/visible cards.
- Aggregate boards group heterogeneous workflows by category and map a drop to the task's real equivalent status. Disable destinations without a valid equivalent.
- Keep one responsible owner plus optional collaborators unless a deliberate full-stack migration introduces multi-owner semantics.
- Treat list hierarchy drag as one structural transaction: validate same-account folder/anchor, remap inherited workflows completely, persist destination order once, and roll back the whole operation on any incompatibility. The default task list remains fixed at the root.
- Present the root hierarchy as pinned default list, independent lists, then ordered folders. Every folder uses the immutable `folder` icon; only lists use validated configurable catalog icons. Structural drag of either kind produces at most one backend write and exact rollback.
- Reconcile a moved task against the active scope in the same render as the canonical HTTP/WebSocket result: remove it from a source list or departed folder, retain it with its new location in Todo el Entorno, reevaluate filters, selection and totals, and prevent authoritative moved IDs from surviving as a stale paginated tail. An `operation_id` deduplicates effects, never canonical task versions or hierarchy counts.
- Folder-row click selects and toggles its accordion; the chevron toggles only. Active folders may remain collapsed, while selecting a concrete child list opens its parent. Task drops into navigation use real pointer coordinates, list-first measured targets, declarative highlight and at most one atomic bulk write.
- An explicit empty collaborator collection is canonical. Frontend reconciliation must not preserve stale collaborators when the last participant is removed.
- Real subtasks are one-level child tasks in the parent's list and compatible workflow. Do not expose the legacy checklist table as a second editable source.
- Archive task lists/folders only when they contain no active tasks. Child restore requires an active parent; concurrent structure/task mutations must lock and revalidate their dependencies inside one transaction.
- Completing a task is never deletion. Trash retention starts only from an explicit task `deleted_at`, list `archived_at`, or folder `archived_at`; never derive retention from done status, `completed_at`, progress, due dates, or reports. Permanent purge is manual, admin-only, retention-gated, exact-name confirmed, and atomic across an archived container tree.
- Aggregate Kanban anchors are same-list and same workflow category, not necessarily the same concrete status. Workflow changes must remap every affected task by category atomically or reject without partial changes.
- Treat task comments, mentions, attachments, activity and dependencies as task-scoped account data. Keep comment drafts, scroll and edits stable during realtime reconciliation.
- An image pasted into task creation/detail follows the same validated account-prefixed attachment path as the file picker. Comment-level upload may create an owner-scoped expiring draft, but it stays invisible until the same comment transaction promotes it; abandoned drafts remain durable cleanup candidates.
- Page older task comments explicitly and preserve chronological order and scroll; never hide history behind a fixed unannounced limit.
- Patch task/order WebSocket events by stable ID/version/operation ID. Do not replace a populated board with skeletons or reload hierarchy for ordinary task/comment events.
- Base task detail layout on measured available surface width. Docked/floating modes leave the workspace interactive; maximized/mobile modes may block it.
- Apply the same measured window contract to full task creation. Preserve dirty drafts behind an explicit discard confirmation, and use viewport-aware portaled pickers for hierarchy/workflow choices.
- Keep task selection visually adaptive: completion is the only persistent card control, selection appears through hover/focus, modifiers, touch hold or active multi-select. Task dialogs and their portaled controls use one tested overlay order; floating dimming must not block the workspace.
- Treat Lista grouping as saved-view state. Group drops change only the represented property; due groups require an exact-date confirmation, row ordering uses a stable handle/server anchor, and bulk destination selection never writes before explicit confirmation.
- Keep progress source explicit: manual progress is preserved across mode changes, automatic progress derives only from real child tasks, and neither completion nor progress starts Trash retention.
- Task attachment previews and anchored comments are account-scoped task data. Converted derivatives require a bounded non-root worker, durable idempotent jobs, storage inventory and reference-safe cleanup.
- Resolve or reopen only anchored root comments. Resolved threads remain readable but immutable until reopened; author/admin edits and deletes are versioned, roots with replies become traceable tombstones, and each mutation writes activity transactionally before one account-scoped realtime event.
- Render task workspace menus that may cross overflow boundaries through the shared portal layer below task windows. Long task descriptions must provide an accessible visible resize handle and an expanded editor that preserves the same draft and exposes save failures without closing.
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
