---
name: clarin-task-work-experience
description: Use when analyzing, designing, implementing, reviewing, testing, or deploying Clarin Work and task behavior, including Entornos and access control, Kanban drag and ordering, workflows/statuses, folders/lists, task filters and saved views, assignees/collaborators, task details, subtasks, comments, attachments, dependencies, Gantt/calendar views, activity history, optimistic updates, and task WebSocket reconciliation. Enforces account and actor isolation, durable manual order, honest multi-workflow behavior, complete controls, responsive polished UX, and production verification.
---

# Clarin Task Work Experience

Implement Clarin Work as one complete collaboration surface. Keep Entorno access, hierarchy, status workflow, ordering, realtime behavior, task detail, and visible UI mutually consistent.

## Load Required Context

1. Read repository `AGENTS.md`.
2. Read `../clarin-interface-design-system/SKILL.md` for every Clarin Work visual, control, window, drag, motion, or responsive change.
3. Read every matching layer skill: frontend, backend, database, storage, and quality assurance as applicable.
4. Read [product-contracts.md](references/product-contracts.md) before changing task behavior, persistence, ordering, layout, or realtime state.
5. Read [verification-matrix.md](references/verification-matrix.md) before finalizing tests, deployment, or a completion claim.

## Execute The Work

### 1. Trace The Complete Vertical Slice

- Start from the visible task control and trace component state, API request, handler/service/repository, PostgreSQL mutation, cache invalidation, WebSocket payload, and final rendering.
- Inspect the active scope: all authorized work inside the active Entorno, directly shared roots inside that same Entorno, folder, list, trash, parent task, or related CRM entity. Never treat account-wide work as an implicit cross-Entorno scope.
- Verify the actor's effective capabilities and the task's account, Entorno-derived list, workflow, status, parent, access revision, and version before choosing an implementation.
- Treat screenshots as product symptoms and generalize the invariant across empty, large, filtered, multi-workflow, touch, keyboard, and concurrent-user states.

### 2. Preserve Task Structure And Order

- Keep the hierarchy `Cuenta -> Entorno -> optional Folder -> List -> Task -> one-level Subtask`. Entorno is an account-scoped authorization boundary, not another tenant, and a task derives it exclusively from its list.
- Keep folders, lists, workflows and statuses inside one Entorno. Only tasks move across Entornos, through an explicit atomic operation that maps statuses by category and confirms participant grants when needed.
- Keep every task in one account-scoped list; use the account default list only when no explicit list exists.
- Resolve every status through the task list's workflow. Never write a status from another workflow.
- Persist manual task order inside the list, independently of the status currently rendering the task.
- Move status and order atomically with optimistic concurrency. Never compose a board move from unrelated reorder and update calls.
- Reorder by stable anchors or server-assigned positions; never rewrite only the currently filtered cards or let hidden cards collide.
- Allocate a safe position when creating, restoring, recurring, or moving a task to another list.
- Keep subtasks at one real task level, in the parent's list, with the parent's compatible workflow. Do not revive the legacy checklist model as a second truth.

### 3. Enforce Actor Access And Bounded Scale

- Require at least Ver on the Entorno before any child grant can become effective. Resolve access from most specific to broadest: account admin recovery, root-task grant, task privacy, list grant, list privacy, folder grant, folder privacy, Entorno grant, then Entorno default. A specific grant may raise, lower or deny inherited access; subtasks inherit the root and never own grants.
- Enforce the cumulative levels Ver, Comentar, Editar and Administrar in repositories/services as well as handlers. Keep access governance separate as `can_manage_access`, which requires Administrar. Return `404` for hidden resources and `403` only when the resource is visible but the requested action is forbidden.
- Do not infer access from owner/collaborator membership. Confirm and commit an Editar task grant in the same participant transaction when needed; removing a participant never silently removes that grant. Preserve at least one explicit manager for private resources while account admins retain recovery.
- Filter tasks, comments, attachments, dependencies, searches, counts, reports, calendar/Gantt, Trash, reminders and Eros in actor-scoped SQL. “Todo el Entorno” and “Compartidas conmigo” are both strictly bound to the active Entorno. The shared Hub lists only direct folder/list/root-task grants and never promotes inherited descendants into duplicate roots; hide any inaccessible parent breadcrumb.
- Page task and hierarchy collections by stable opaque cursors with default 50 and maximum 200. Load only the active Entorno, fetch folder children lazily, debounce remote searches exactly 500 ms, abort predecessors and reject stale completions.

### 4. Build A Complete Interaction

- Make drag work with mouse, long-press touch, keyboard, empty columns, auto-scroll, cancellation, optimistic preview, rollback, retry, and exact post-reload persistence.
- Keep folder expansion independent from selection: several folders may remain open, the active list's parent opens automatically, collapsed folders stay valid drag targets, and drag cancellation restores the expansion snapshot.
- Offer Ctrl+drag and middle-button horizontal panning on wide boards without allowing that gesture to open or move a task.
- Separate click from drag. Interactive card controls must not begin a drag or open the task accidentally after dropping.
- Expose only actions with real success, loading, empty, permission, conflict, and failure behavior.
- Keep one responsible owner and optional collaborators unless the product contract is intentionally migrated end to end.
- Keep comments, mentions, attachments, activity, dependencies, and subtasks available from the task detail without losing the task context.
- Treat List grouping as view state, not task truth. Persist grouping, direction and collapsed keys with saved views; a row drop may change exactly one represented property, while due-date groups require an explicit exact-date confirmation.
- Use one stable drag handle for List rows. Selection, completion and opening own their cursors; selection mode must never cause hover-driven pointer/grab flicker.
- Keep progress source explicit. Manual progress preserves its last manual value, automatic progress derives only from real child tasks, and neither progress nor completion can start Trash retention.
- Preview task attachments only through account-scoped attachment lookup. Word derivatives run in an isolated durable worker, are inventoried like other media, and anchored comments remain distinct from general task comments while appearing in activity.
- Treat each attachment opening as a disposable task-plus-attachment session. Abort fetch/poll, cancel PDF rendering, destroy parser/worker state, revoke object URLs, and clear canvas/comments when closing, switching, deleting, retrying, or unmounting.
- Default operational views to open work while keeping closed history available explicitly and in Resumen. Navigation badges represent open top-level tasks and explain total/completed/cancelled counts on demand.
- Use the shared task work-window shell for complex Filters and Configuration: draft/apply filters once, protect dirty inspectors, and support measured move, resize, dock, maximize and mobile modes.
- Measure the task surface itself for responsive layout. Keep docked/floating workspaces interactive and reserve modal blocking for maximized/mobile modes.
- Keep task windows legible through the shared contrast contract, and portal workspace menus outside clipping containers but below task windows. Long descriptions need a visible pointer/keyboard resize handle plus an expanded editor that shares the canonical draft and never hides a save error.
- In full creation, Ctrl/Command+Enter submits exactly once from either description surface, except during IME, invalid state, an open child picker or an active request. Preserve focus and the entire draft after failure or conflict.
- Queue validated pre-create attachments locally. File selection keeps the accepted catalog, clipboard paste accepts images only without stealing text paste, and partial upload failure retries only pending files without recreating the task.

### 5. Reconcile Safely In Realtime

- Include stable task IDs, versions, actions, access revisions, and operation IDs in authorized-recipient events.
- Derive recipients from the final actor-authorized resource set, not a global account broadcast or the union of unrelated resources. On revocation, send the removed user only a minimal tombstone; never leak a task payload, breadcrumb, count or sibling identity.
- Patch canonical task payloads and ordering without replacing a populated board with skeletons or resetting scroll, focus, filters, drafts, or selection.
- After any canonical task move, reconcile membership against the active list/folder/Entorno scope and filters as one batch; do not let moved IDs survive in a preserved paginated tail or let local operation deduplication suppress newer tasks or hierarchy counts.
- Keep folder identity visually fixed to the `folder` icon across creation, editing, API and database. Configurable catalog icon controls belong only to lists and Entornos.
- Recognize the initiating client's echo and queue conflicting remote events while a drag is active.
- Patch hierarchy inventory with the same optimistic task mutation, then apply account-scoped canonical `hierarchy_counts` from HTTP or WebSocket even when its operation ID originated locally. Deduplication must not leave stale badges.
- Abort obsolete filtered/search requests. A local create carries one operation ID through HTTP and WebSocket; when current filters would hide it, clear that query before inserting the canonical task, then highlight and scroll to exactly one card.
- Reload task hierarchy only for structural events; comments and task moves must not refetch folders or workflows.
- Guard every async task switch so a late response cannot replace the newly selected task.

### 6. Verify And Deploy

- Run the layer checks required by the quality skill and the focused cases in the verification reference.
- Validate migrations, Entorno backfill/composite constraints, access resolution and fragile order/filter SQL against PostgreSQL, not only Go compilation.
- Inspect the final diff for account isolation, stale legacy task paths, inert controls, and missing cache/WebSocket reconciliation.
- When deployment is requested, run `make deploy`, verify containers, backend health, frontend/backend logs, `/api/version`, and focused live PostgreSQL invariants.
- Never claim that ordering, migration, realtime behavior, or production health works without the corresponding check.

## Non-Negotiable Review Questions

- Can a task disappear because its list, workflow, or parent differs from the active scope?
- Can a direct task share reveal its Entorno/list breadcrumb, counts, siblings, dependencies, event payload or search inventory?
- Can a task query or mutation bypass actor access because only its handler checks permission?
- Can revocation leave stale counts/cache or continue sending payloads to the removed user?
- Can a filtered reorder overwrite hidden cards or create duplicate positions?
- Can a status from another workflow be assigned silently?
- Can a failed or conflicting move leave the optimistic board incorrect?
- Can WebSocket reconciliation flash skeletons, reset scroll, duplicate a card, or erase a draft?
- Can touch scrolling start a drag accidentally, or can keyboard users move a task?
- Can docked or floating detail unnecessarily block the board behind it?
- Can a visible filter, menu item, quick action, or detail control fail to work end to end?
- Can a bulk action write before the user confirms its prepared destination or canonical Trash phrase?
- Can an attachment preview, derivative, comment, mention, or cleanup cross an account boundary or outlive all references?
- Can Contact tags or another module's data be reused as task metadata without an explicit task model?
