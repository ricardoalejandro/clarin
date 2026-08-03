# Clarin Work Verification Matrix

## Entornos, ACL, Pagination, And Realtime

- Migration: run startup migration twice; prove exactly one General per account, unchanged existing IDs/orders, no null `environment_id`, same-account/same-Entorno composite FKs, default uniqueness per Entorno and no orphan grants/audit rows.
- Provisioning: create a private Entorno and prove one atomic workflow/status/inbox/creator-manager grant. Reject a partially provisioned Entorno and archive while any non-deleted task remains.
- Authorization: exercise every Ver/Comentar/Editar/Administrar action, governance bit, account-admin recovery, missing `PermTasks`, task/list/folder/environment precedence, explicit raise/lower/deny, private resource, root/subtask inheritance and last explicit manager. Reject new child grants without Entorno Ver; preserve historical grants as inactive. Hidden returns `404`; visible-but-forbidden returns `403`.
- Peripheral surfaces: prove actor filtering for comments, comment attachments, task attachments, dependencies, reminders, search, summary/reporting, calendar, Gantt, Trash and Eros. Prove “Todo el Entorno” and the direct-share Hub never cross the active Entorno; the Hub contains only direct folder/list/root-task roots and hides inaccessible parent hierarchy/counts/siblings.
- Participant grants: adding an owner/collaborator without Editar first returns a confirmation contract, then commits participant plus task grant once. Removing participation leaves access unchanged. Reject stale access revision, duplicate operation ID, cross-account user and concurrent revoke/edit.
- Cross-Entorno move: require Administrar at source and Editar at destination, reject participants without destination Entorno Ver, map every parent/child status by category, confirm affected participant grants and verify exact all-or-nothing rollback for missing mapping, conflict or revocation.
- Pagination: validate opaque cursor ordering with ties, default 50/max 200, no duplicate/skip during progressive fetch, lazy folder-list loading, aborted stale requests, exact 500 ms search debounce and no N+1 or total-sized payload under stress.
- Realtime: test authorized, direct-share, revoked and foreign users. Resource recipients are intersected, ordinary updates contain no unauthorized hierarchy, revocation emits only a tombstone, and actor/Entorno caches and counts reconcile without F5.
- DTO contract: task, list, folder and Entorno responses serialize `effective_access_level`, `can_manage_access` and `capabilities` from the same actor-scoped result as the compatibility `permissions` object; verify an explicit false governance bit and omission on unscoped internal objects.

## Grouped List, progress, Gantt and previews

- Unit: all seven grouping modes, special empty keys, direction/collapse persistence, one stable drag cursor, relative-order insertion and exact-date confirmation before any due write.
- Backend: bulk property and Trash requests reject duplicates, stale versions, subtasks and cross-account IDs; lock in stable order, move children with parents, emit one operation event and roll back all rows on one failure.
- Progress: manual/automatic round trip, mode switching preserves manual value, child completion updates the derived count, zero-child open/done rules and proof that `deleted_at` remains null.
- Gantt: every fixed scale, flexible 8/120 clamps, virtual ranges, start/end/move validation, optional dependency-chain scheduling and complete `409`/error rollback.
- Preview: classify image/PDF/TXT/Word/unsupported, generate Word on demand in the isolated worker, retry idempotently, inventory derivative objects and deny cross-account attachment/comment/mention access.
- Anchors: normalized/clamped image coordinates, PDF page/point/quote, TXT line/offset/context, replies and mentions. Resolve/reopen only roots with an explicitly typed PostgreSQL UUID actor; resolved threads are read-only, edit/delete enforce author/admin plus version, a root with replies becomes a tombstone, and each mutation commits exactly one activity/event before realtime reconciliation without document reload.
- Browser: group and drag individual/stacked rows; stage move and protected bulk Trash; operate professional dates; zoom/resize Gantt; open and comment each supported preview; verify the filter veil, keyboard/focus order and absence of React errors.

## Bulk movement and calendar creation

- Unit: checkbox toggle, Shift range, dragging selected/unselected cards, maximum stack/ghost counts, reduced motion state, unique payload items, relative order and destination resolution.
- Backend: same-account top-level tasks only, optimistic versions, deterministic locks, parent/child workflow mapping, archived/incompatible/duplicate rejection and all-or-nothing rollback.
- Integration: one request per gesture to column/list/folder, one matching `operation_id` in HTTP/WebSocket, no duplicate cards, no React #185, Escape/error rollback and folder list choice.
- Scope reconciliation: Mauritius → Zambia disappears immediately while remaining on Mauritius, appears in Zambia without F5, remains visible with updated breadcrumbs in Todo el Entorno, and stays only when both lists belong to the active folder. Exercise HTTP-before-WebSocket and WebSocket-before-HTTP; the newer task version and canonical counts win in both orders.
- Pagination: after a move, refresh removes only authoritative moved IDs that the server no longer returns while preserving unrelated later pages. `409` and network failure leave rows, selection, order and totals untouched.
- Calendar: month all-day and week/day one-hour slots, direct creation, scope/remembered list selection, keyboard Enter/Escape and draft preservation into the full editor.
- Accessibility/layout: `aria-live` group counts and destination announcements, keyboard status/list pickers, reduced motion, sidebar expansion/restoration and widths 375, 917, 979, 1249 and 1284 px.
- Unit: main-row versus chevron accordion transitions, adaptive pointer/keyboard/touch selection, list-first lateral-target resolution, hysteresis, edge autoscroll, overlay ordering and measured Lista density.

## Database And API

- Run the task migration twice; confirm the second run preserves manual order.
- Verify duplicate/non-positive legacy positions normalize within the same account/list or parent only.
- Create concurrently at top and bottom; restore and move between lists; confirm stable positions.
- Race parent archive against child create/restore, folder archive against list create, workflow/status edits against task create/move/remap, and prove no orphan or cross-workflow task survives.
- Race dependency inserts that would jointly form a three-or-more-node cycle; exactly one path must be rejected.
- Move to beginning, middle, end, empty status, completed status, and back to active.
- Reject stale version, deleted task, subtask board move, cross-account anchor, wrong-list anchor, wrong-workflow status, and migrated Program task.
- Apply filters while hidden cards exist and prove their order is unchanged.
- Verify task counts, saved-view CRUD/account isolation, cache invalidation, activity, and canonical WebSocket payloads.
- Archive only empty lists/folders; restore children only under an active parent and active container chain.
- Move and reorder lists in root and folders, and reorder folders among folders; reject cross-account/wrong-container/archived/self anchors and every structural move of the default list. Verify one transaction performs workflow inheritance, complete category remapping, location and destination order, or leaves every row unchanged.
- Verify the default list is repaired to root order `0` and non-default root order starts after it. Run the migration twice, prove every folder is normalized to `folder`, its check constraint rejects all other values, create ignores a legacy custom icon, update returns `400 folder_icon_immutable`, and list icons still round-trip through the shared catalog.
- Complete and reopen a task and prove `deleted_at` remains null and no retention appears. Then explicitly archive that completed task and prove eligibility is based on `deleted_at`, never `completed_at`.
- Test account policies at exact 7, 30, and 365-day boundaries plus `NULL`/“Nunca”; changing policy recalculates displays without deleting rows or enqueueing purge work.
- Verify task users can archive/restore while only account administrators can update policy or purge. Reject incorrect exact names, stale versions, active/default containers, cross-account IDs, and too-young descendants under lock.
- Archive and restore folders with mixed child provenance: restore lists archived by the folder operation, preserve individually archived lists, and block an individual list restore while its original folder remains archived.
- Purge eligible task/list/folder trees atomically; one active or ineligible descendant must leave every row unchanged. Recheck shared media references before physical deletion and retain shared/protected objects.

## Board

- Fill a column with cards, open its action menu and assert the menu is portaled above the board, inside every viewport edge and below task windows. Verify flip, scroll/resize repositioning, Arrow/Home/End/Enter/Escape, outside close and trigger-focus restoration.
- Test mouse drag, touch long-press, normal touch scroll, keyboard pickup/drop, Escape, and drop outside.
- Drag across off-screen columns and long columns; verify horizontal and vertical auto-scroll.
- Move before the first card, between cards, to the end, and into an empty/collapsed column.
- Repeatedly cross the same column boundary in both directions before dropping, including populated, empty, and collapsed targets. Confirm there is no React maximum-update-depth error, page crash, flicker loop, duplicate card, or lost card.
- Hold a card over one populated destination for at least three seconds with small pointer jitter. Confirm the DOM order stops changing after the container transfer, the active card is never its own collision target, and the final drop emits exactly one move request with the correct status and stable anchor.
- Confirm click opens detail and card buttons do not drag.
- Simulate HTTP failure and `409`; verify exact rollback, retry, and reconciliation.
- Use two sessions; confirm no duplicate card, skeleton flash, scroll reset, or stale status/order.
- Deliver move/update/delete/restore events and their HTTP responses deliberately out of order; verify max-version/tombstone guards reject every older task and order payload.
- Verify aggregate scopes with same and different workflows.
- Pan a horizontally overflowing board with Ctrl+left-drag and middle-button drag; verify cursor feedback, no card click, no task move, and unchanged wheel/touch/keyboard behavior.
- Compare empty, short, and long columns: the droppable fills the canvas, the tint follows content, “Agregar tarea” follows the cards, long content scrolls vertically, and both board edges retain 12–16 px breathing room.

## Creation, Filters, And Views

- Create inline with title only and with responsible, due date, priority, and More options.
- Search for a non-matching term, create inline, and deliver HTTP plus the matching WebSocket echo in both orders. Assert one write, one card, cleared search/filters, unchanged scope, explanatory notice, highlight/scroll, and persistence after reload.
- Type several search values rapidly with fake timers and browser requests: no query before 500 ms, one final query, prior tasks/Gantt requests aborted, cancellation silent, and no stale response rendered.
- Verify 499/500 ms boundaries for every task catalog search, including local pickers. Clear/select remain immediate and the pending indicator exists only between raw and settled values.
- Create, move between lists, complete, reopen, restore and trash tasks; confirm open badges and breakdown tooltips update without F5, then accept canonical `hierarchy_counts` exactly once for local and remote operation IDs.
- Default Lista, Tablero, Calendario and Gantt to open work; enable Mostrar cerradas, explicitly select a completed/cancelled status, save/reload the view, and prove Resumen remains historically complete.
- Change several filter draft fields and assert zero task queries until one Apply. Cancel/Escape must preserve prior applied filters; move, resize, dock and maximize both Filters and Configuration on desktop and verify full-screen mobile behavior.
- Verify ambiguous folder/all scopes require a list and created tasks appear in the selected hierarchy.
- Combine multi-value filters, remove individual chips, clear all, and preserve visible data while loading.
- Create, apply, update, default, and delete a saved view from another session/device; deny another user/account.
- Visit Trash and return after initial default-view bootstrap; confirm the default does not reapply over the user's current scope.
- In Trash, verify Tareas and Listas y carpetas tabs, original location, archived date, countdown/“Nunca”, restore constraints, admin-only policy/purge controls, exact-name irreversible dialog, loading, retry, Escape, and WebSocket reconciliation.
- Confirm navigation renders the pinned default list first, then “Listas independientes” with its explanation, then folders in canonical order. Drag folders and lists with mouse, touch long-press, and keyboard; verify overlay/insertion target, one request per gesture, exact Escape/outside/`409`/`500` rollback, and workflow confirmation before a populated list changes workflow.
- Expand several folders independently by mouse and keyboard, reload persisted state, auto-open the active parent, autoexpand a collapsed drag target after an intentional pause, and restore expansion exactly on Escape/error. With enough folders, verify the themed scrollbar and top/bottom overflow shadows.
- Select a folder by its main row, collapse it while active, and confirm no scope effect reopens it; selecting one of its child lists must open it again. During task drag, verify the real pointer—not the translated card—selects the highlighted list/folder through navigation scroll and a folder drop opens the concrete-list chooser above the board.
- Rename a default list, root list, nested list, and folder; choose list colors/icons and folder colors by pointer and keyboard, then reload and prove the canonical values return. Folder creation/editing shows a fixed icon rather than a picker; list creation/editing retains the full picker and rejects icons outside the catalog.
- At 1398×504, 1024, 768, and 375 px—and with Eros open—verify full-bleed canvas, stable two-row header, primary view tabs, search expansion without height/layout shift, `/` focus, Escape retention, and clear/collapse behavior.

## Task Detail

- Verify docked, floating, resized, maximized, mobile, Escape, focus restoration, and board interaction behind non-modal modes. Assert the canonical 8%/1 px, 18%/2 px and 45%/3 px veil/blur values and modal blocking only for maximized/mobile.
- Resize Description with pointer and keyboard to both clamps, persist and reload its preferred height, double-click reset, then use the expanded editor through Listo, Ctrl/Command+Enter and Escape. A failed write must keep the shared draft open with visible retry.
- Apply the same matrix to creation. Verify double-click maximize, geometry persistence/clamping, clean Escape, dirty-draft confirmation, cancelled discard preservation, searchable grouped list selection, and portaled controls at every viewport edge.
- Verify desktop -> 320/375/mobile or 80–150% zoom -> desktop preserves the manually preferred floating size, discards unsafe legacy dimensions, never persists an effective responsive clamp and restores the documented defaults through Restablecer tamaño.
- In creation and expanded description, verify Ctrl/Cmd+Enter, IME, invalid form, open picker, double submission, `409` and transport failure. The task is created at most once and every rejected path preserves draft and focus.
- Paste ordinary text, one/many clipboard images and invalid/oversize MIME data. Verify queue deduplication, preview URL cleanup, 50 MB/quota/account-prefix enforcement, create-once upload order and partial retry without a second task.
- For comment uploads, verify Comentar succeeds, Ver fails, a draft is hidden before promotion, foreign/cross-account draft IDs fail, promotion is atomic with comment creation/update and abandoned drafts remain cleanup candidates.
- Open list, responsible, status and priority pickers from calendar/detail/list at narrow and wide widths; assert each menu is above its owner, at least 280 px when possible, keyboard-safe, unclipped, and restores focus. Floating dimming remains non-blocking while maximized/mobile modes remain modal.
- Edit every supported inline property and recover from version conflict without losing drafts.
- Operate the status and priority pickers with pointer and keyboard. Add collaborators through search, remove any chip, and remove the final collaborator while asserting `user_ids: []` and an explicitly empty canonical response.
- Create/open/complete a subtask and navigate parent-child without losing context.
- Add/edit/delete comments; mention, attach, send with keyboard, and use touch-visible actions.
- Create more than one comment page, load older pages without gaps/duplicates, preserve scroll while prepending, and reconcile remote create/edit/delete events across the loaded boundary.
- Merge activity/comments without duplicates and preserve scroll/composer during realtime events.
- Edit remotely a comment from an already-loaded older page and confirm its body updates without changing local edit/delete permissions.
- Open attachments and related dependency tasks; verify empty, loading, error, and retry states.
- Open a PDF, close during download/render and immediately open another task. Assert local worker configuration, abort/cancel/destroy/revoke cleanup, no previous canvas/comment residue, slow notice at 8 seconds, recoverable error at 30 seconds, and top-layer Escape semantics. Word polling exists only while open and failed conversion retries only by explicit idempotent action.
- Resolve and reopen an anchored root, edit root/reply, delete a reply and delete a root with replies. Verify per-thread pending prevents double submission, `409` reloads canonical comments while preserving the edit draft, Resueltos is collapsible/read-only, two sessions reconcile without F5, and closing/switching the viewer cancels residual comment operations without reloading PDF state.
- Collapse and expand Lista groups while measuring the 200 ms grid/opacity transition, `aria-expanded`, hidden-region inertness and reduced-motion fallback. Collapse the main sidebar and verify the brand is absent, one centered expansion control remains, and expansion restores the full header.

## Baseline And Production

- Run `GOCACHE=/tmp/go-build go test ./...` from `backend`.
- Run `npm run test:unit`, `npx tsc --noEmit`, and `npm run build` from `frontend`.
- Run `git diff --check` and inspect the complete diff for secrets or unrelated changes.
- After `make deploy`, verify Clarin containers, backend `/health`, `/api/version`, backend/frontend logs, live task schema/indexes, saved views, and absence of duplicate active order positions.
- When retiring a stateful module, create and verify a restricted off-repository database/volume backup before the first migration-capable restart. After deployment, verify the removed routes, permission, tables, service, volume, image and dependency are absent while similarly named unrelated features remain.
