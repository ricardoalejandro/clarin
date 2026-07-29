# Clarin Work Verification Matrix

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

## Board

- Test mouse drag, touch long-press, normal touch scroll, keyboard pickup/drop, Escape, and drop outside.
- Drag across off-screen columns and long columns; verify horizontal and vertical auto-scroll.
- Move before the first card, between cards, to the end, and into an empty/collapsed column.
- Repeatedly cross the same column boundary in both directions before dropping, including populated, empty, and collapsed targets. Confirm there is no React maximum-update-depth error, page crash, flicker loop, duplicate card, or lost card.
- Confirm click opens detail and card buttons do not drag.
- Simulate HTTP failure and `409`; verify exact rollback, retry, and reconciliation.
- Use two sessions; confirm no duplicate card, skeleton flash, scroll reset, or stale status/order.
- Deliver move/update/delete/restore events and their HTTP responses deliberately out of order; verify max-version/tombstone guards reject every older task and order payload.
- Verify aggregate scopes with same and different workflows.

## Creation, Filters, And Views

- Create inline with title only and with responsible, due date, priority, and More options.
- Verify ambiguous folder/all scopes require a list and created tasks appear in the selected hierarchy.
- Combine multi-value filters, remove individual chips, clear all, and preserve visible data while loading.
- Create, apply, update, default, and delete a saved view from another session/device; deny another user/account.
- Visit Trash and return after initial default-view bootstrap; confirm the default does not reapply over the user's current scope.

## Task Detail

- Verify docked, floating, resized, maximized, mobile, Escape, focus restoration, and board interaction behind non-modal modes.
- Edit every supported inline property and recover from version conflict without losing drafts.
- Create/open/complete a subtask and navigate parent-child without losing context.
- Add/edit/delete comments; mention, attach, send with keyboard, and use touch-visible actions.
- Create more than one comment page, load older pages without gaps/duplicates, preserve scroll while prepending, and reconcile remote create/edit/delete events across the loaded boundary.
- Merge activity/comments without duplicates and preserve scroll/composer during realtime events.
- Edit remotely a comment from an already-loaded older page and confirm its body updates without changing local edit/delete permissions.
- Open attachments and related dependency tasks; verify empty, loading, error, and retry states.

## Baseline And Production

- Run `GOCACHE=/tmp/go-build go test ./...` from `backend`.
- Run `npx tsc --noEmit` and `npm run build` from `frontend`.
- Run `git diff --check` and inspect the complete diff for secrets or unrelated changes.
- After `make deploy`, verify Clarin containers, backend `/health`, `/api/version`, backend/frontend logs, live task schema/indexes, saved views, and absence of duplicate active order positions.
