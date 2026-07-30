# Clarin Work Verification Matrix

## Bulk movement and calendar creation

- Unit: checkbox toggle, Shift range, dragging selected/unselected cards, maximum stack/ghost counts, reduced motion state, unique payload items, relative order and destination resolution.
- Backend: same-account top-level tasks only, optimistic versions, deterministic locks, parent/child workflow mapping, archived/incompatible/duplicate rejection and all-or-nothing rollback.
- Integration: one request per gesture to column/list/folder, one matching `operation_id` in HTTP/WebSocket, no duplicate cards, no React #185, Escape/error rollback and folder list choice.
- Calendar: month all-day and week/day one-hour slots, direct creation, scope/remembered list selection, keyboard Enter/Escape and draft preservation into the full editor.
- Accessibility/layout: `aria-live` group counts and destination announcements, keyboard status/list pickers, reduced motion, sidebar expansion/restoration and widths 375, 917, 979, 1249 and 1284 px.

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
- Verify the default list is repaired to root order `0`, non-default root order starts after it, and folder/list icons accept only the shared catalog while round-tripping through hierarchy APIs.
- Complete and reopen a task and prove `deleted_at` remains null and no retention appears. Then explicitly archive that completed task and prove eligibility is based on `deleted_at`, never `completed_at`.
- Test account policies at exact 7, 30, and 365-day boundaries plus `NULL`/“Nunca”; changing policy recalculates displays without deleting rows or enqueueing purge work.
- Verify task users can archive/restore while only account administrators can update policy or purge. Reject incorrect exact names, stale versions, active/default containers, cross-account IDs, and too-young descendants under lock.
- Archive and restore folders with mixed child provenance: restore lists archived by the folder operation, preserve individually archived lists, and block an individual list restore while its original folder remains archived.
- Purge eligible task/list/folder trees atomically; one active or ineligible descendant must leave every row unchanged. Recheck shared media references before physical deletion and retain shared/protected objects.

## Board

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
- Verify ambiguous folder/all scopes require a list and created tasks appear in the selected hierarchy.
- Combine multi-value filters, remove individual chips, clear all, and preserve visible data while loading.
- Create, apply, update, default, and delete a saved view from another session/device; deny another user/account.
- Visit Trash and return after initial default-view bootstrap; confirm the default does not reapply over the user's current scope.
- In Trash, verify Tareas and Listas y carpetas tabs, original location, archived date, countdown/“Nunca”, restore constraints, admin-only policy/purge controls, exact-name irreversible dialog, loading, retry, Escape, and WebSocket reconciliation.
- Confirm navigation renders the pinned default list first, then “Listas independientes” with its explanation, then folders in canonical order. Drag folders and lists with mouse, touch long-press, and keyboard; verify overlay/insertion target, one request per gesture, exact Escape/outside/`409`/`500` rollback, and workflow confirmation before a populated list changes workflow.
- Expand several folders independently by mouse and keyboard, reload persisted state, auto-open the active parent, autoexpand a collapsed drag target after an intentional pause, and restore expansion exactly on Escape/error. With enough folders, verify the themed scrollbar and top/bottom overflow shadows.
- Rename a default list, root list, nested list, and folder; choose every supported color/icon by pointer and keyboard, then reload and prove the canonical values return. Reject an icon outside the catalog.
- At 1398×504, 1024, 768, and 375 px—and with Eros open—verify full-bleed canvas, stable two-row header, primary view tabs, search expansion without height/layout shift, `/` focus, Escape retention, and clear/collapse behavior.

## Task Detail

- Verify docked, floating, resized, maximized, mobile, Escape, focus restoration, and board interaction behind non-modal modes.
- Apply the same matrix to creation. Verify double-click maximize, geometry persistence/clamping, clean Escape, dirty-draft confirmation, cancelled discard preservation, searchable grouped list selection, and portaled controls at every viewport edge.
- Edit every supported inline property and recover from version conflict without losing drafts.
- Operate the status and priority pickers with pointer and keyboard. Add collaborators through search, remove any chip, and remove the final collaborator while asserting `user_ids: []` and an explicitly empty canonical response.
- Create/open/complete a subtask and navigate parent-child without losing context.
- Add/edit/delete comments; mention, attach, send with keyboard, and use touch-visible actions.
- Create more than one comment page, load older pages without gaps/duplicates, preserve scroll while prepending, and reconcile remote create/edit/delete events across the loaded boundary.
- Merge activity/comments without duplicates and preserve scroll/composer during realtime events.
- Edit remotely a comment from an already-loaded older page and confirm its body updates without changing local edit/delete permissions.
- Open attachments and related dependency tasks; verify empty, loading, error, and retry states.

## Baseline And Production

- Run `GOCACHE=/tmp/go-build go test ./...` from `backend`.
- Run `npm run test:unit`, `npx tsc --noEmit`, and `npm run build` from `frontend`.
- Run `git diff --check` and inspect the complete diff for secrets or unrelated changes.
- After `make deploy`, verify Clarin containers, backend `/health`, `/api/version`, backend/frontend logs, live task schema/indexes, saved views, and absence of duplicate active order positions.
- When retiring a stateful module, create and verify a restricted off-repository database/volume backup before the first migration-capable restart. After deployment, verify the removed routes, permission, tables, service, volume, image and dependency are absent while similarly named unrelated features remain.
