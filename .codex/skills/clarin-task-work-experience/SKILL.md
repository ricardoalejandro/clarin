---
name: clarin-task-work-experience
description: Use when analyzing, designing, implementing, reviewing, testing, or deploying Clarin Work and task behavior, including Kanban drag and ordering, workflows/statuses, folders/lists, task filters and saved views, assignees/collaborators, task details, subtasks, comments, attachments, dependencies, Gantt/calendar views, activity history, optimistic updates, and task WebSocket reconciliation. Enforces account isolation, durable manual order, honest multi-workflow behavior, complete controls, responsive polished UX, and production verification.
---

# Clarin Task Work Experience

Implement Clarin Work as one complete collaboration surface. Keep hierarchy, status workflow, ordering, realtime behavior, task detail, and visible UI mutually consistent.

## Load Required Context

1. Read repository `AGENTS.md`.
2. Read every matching layer skill: frontend, backend, database, storage, and quality assurance as applicable.
3. Read [product-contracts.md](references/product-contracts.md) before changing task behavior, persistence, ordering, layout, or realtime state.
4. Read [verification-matrix.md](references/verification-matrix.md) before finalizing tests, deployment, or a completion claim.

## Execute The Work

### 1. Trace The Complete Vertical Slice

- Start from the visible task control and trace component state, API request, handler/service/repository, PostgreSQL mutation, cache invalidation, WebSocket payload, and final rendering.
- Inspect the active scope: all work, folder, list, trash, parent task, or related CRM entity.
- Verify the task's list, workflow, status, parent, version, and account before choosing an implementation.
- Treat screenshots as product symptoms and generalize the invariant across empty, large, filtered, multi-workflow, touch, keyboard, and concurrent-user states.

### 2. Preserve Task Structure And Order

- Keep every task in one account-scoped list; use the account default list only when no explicit list exists.
- Resolve every status through the task list's workflow. Never write a status from another workflow.
- Persist manual task order inside the list, independently of the status currently rendering the task.
- Move status and order atomically with optimistic concurrency. Never compose a board move from unrelated reorder and update calls.
- Reorder by stable anchors or server-assigned positions; never rewrite only the currently filtered cards or let hidden cards collide.
- Allocate a safe position when creating, restoring, recurring, or moving a task to another list.
- Keep subtasks at one real task level, in the parent's list, with the parent's compatible workflow. Do not revive the legacy checklist model as a second truth.

### 3. Build A Complete Interaction

- Make drag work with mouse, long-press touch, keyboard, empty columns, auto-scroll, cancellation, optimistic preview, rollback, retry, and exact post-reload persistence.
- Separate click from drag. Interactive card controls must not begin a drag or open the task accidentally after dropping.
- Expose only actions with real success, loading, empty, permission, conflict, and failure behavior.
- Keep one responsible owner and optional collaborators unless the product contract is intentionally migrated end to end.
- Keep comments, mentions, attachments, activity, dependencies, and subtasks available from the task detail without losing the task context.
- Measure the task surface itself for responsive layout. Keep docked/floating workspaces interactive and reserve modal blocking for maximized/mobile modes.

### 4. Reconcile Safely In Realtime

- Include stable task IDs, versions, actions, and operation IDs in account-scoped events.
- Patch canonical task payloads and ordering without replacing a populated board with skeletons or resetting scroll, focus, filters, drafts, or selection.
- Recognize the initiating client's echo and queue conflicting remote events while a drag is active.
- Reload task hierarchy only for structural events; comments and task moves must not refetch folders or workflows.
- Guard every async task switch so a late response cannot replace the newly selected task.

### 5. Verify And Deploy

- Run the layer checks required by the quality skill and the focused cases in the verification reference.
- Validate migrations and fragile order/filter SQL against PostgreSQL, not only Go compilation.
- Inspect the final diff for account isolation, stale legacy task paths, inert controls, and missing cache/WebSocket reconciliation.
- When deployment is requested, run `make deploy`, verify containers, backend health, frontend/backend logs, `/api/version`, and focused live PostgreSQL invariants.
- Never claim that ordering, migration, realtime behavior, or production health works without the corresponding check.

## Non-Negotiable Review Questions

- Can a task disappear because its list, workflow, or parent differs from the active scope?
- Can a filtered reorder overwrite hidden cards or create duplicate positions?
- Can a status from another workflow be assigned silently?
- Can a failed or conflicting move leave the optimistic board incorrect?
- Can WebSocket reconciliation flash skeletons, reset scroll, duplicate a card, or erase a draft?
- Can touch scrolling start a drag accidentally, or can keyboard users move a task?
- Can docked or floating detail unnecessarily block the board behind it?
- Can a visible filter, menu item, quick action, or detail control fail to work end to end?
- Can Contact tags or another module's data be reused as task metadata without an explicit task model?
