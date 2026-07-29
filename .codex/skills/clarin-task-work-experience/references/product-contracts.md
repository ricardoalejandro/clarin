# Clarin Work Product Contracts

Read the sections relevant to the requested task change before editing.

## Hierarchy And Workflow

- A task belongs to one `account_id` and one task list. The default account list is a compatibility fallback, not permission to create invisible unscoped tasks.
- Folders contain lists; lists resolve one workflow; workflows own ordered statuses.
- A status is valid only for a task whose list resolves the same workflow.
- In aggregate views, group heterogeneous workflows by category and map a drop to the equivalent real status for each task. Disable a destination when no equivalent exists.
- Renaming or changing a status affects every list sharing that workflow; explain that scope before saving.
- Changing a list or folder workflow must be one transaction: lock the affected containers and destination statuses, prove a category-equivalent mapping for every active task, remap every task, and only then persist the new workflow.
- Archiving a list or folder is allowed only when it contains no active tasks. Restoring a child task requires an active parent and an active list/folder chain.
- Create, restore, move, archive, and workflow-remap paths must lock and revalidate their parent/list/folder/status dependencies after waiting; a pre-lock read is never sufficient proof under concurrency.

## Ordering And Concurrency

- `sort_order` is the durable manual order of top-level tasks inside a list and of child tasks inside one parent.
- Use spaced server positions and normalize only when legacy duplicates/non-positive values or exhausted gaps require it.
- Lock the owning list/order scope for create, restore, list transfer, reorder, and board move operations.
- A board move must validate the task version and atomically persist its real status plus order.
- A `before_task_id` anchor must be active, same-account, same-list, top-level, and in the target workflow category. Aggregate columns may contain several concrete statuses, so requiring the exact target status is incorrect. A missing anchor means append after the last task in that category in the task's own list.
- Never renumber only visible/filtered task IDs. Hidden tasks retain their relative order.
- Return the canonical task/version and affected order after a move; invalidate task caches and broadcast only after commit.
- All structural writers must use a consistent lock order. In particular, concurrent child creation/restoration cannot race a parent archive, and list creation cannot race folder archive.
- Serialize dependency-graph validation inside the account before testing reachability and inserting an edge. Locking only the two endpoint tasks cannot prevent two concurrent edges from completing a longer cycle.
- A task in a `done` status has `progress=100` plus completion metadata; leaving `done` clears completion metadata without inventing historical completion.

## Board Interaction

- Support mouse activation distance, touch long-press tolerance, keyboard pickup/drop, Escape cancellation, empty-column drop, insertion preview, and horizontal/vertical auto-scroll.
- Snapshot local board state at drag start. Update optimistically, then either reconcile the canonical response or restore the exact snapshot with retry feedback.
- Use the entire card as a discoverable drag surface while keeping an accessible handle and excluding buttons, inputs, links, menus, and selects.
- A short click opens the detail. Completing, starring, editing, archiving, and adding a subtask never initiate drag.
- Keep status columns compact, colored from the real status, collapsible, and droppable. Collapsed columns must remain understandable and expand on intentional drag hover.

## Task Cards And Creation

- Prioritize title, overdue date, high/urgent priority, responsible owner, subtask progress, comments, and attachments.
- Do not repeat status inside a card already grouped by that status. Show list/origin only in aggregate views.
- Inline creation inherits an unambiguous list and real status. If the scope contains multiple possible lists, require a list selection.
- Enter saves a valid title; Escape cancels; More options preserves the draft in the full editor.
- Insert inline-created tasks at a deterministic server position and patch them without losing board scroll.

## Filters And Saved Views

- Combine different fields with AND and multiple choices inside one field with OR.
- Keep search visible and show active filters as removable chips with a clear-all action.
- Validate every saved-view JSON field server-side; keep views private to the current account/user unless shared views are explicitly designed.
- Apply a user's default saved view only during the workspace bootstrap. Remounting the toolbar after visiting Trash or changing scope must not overwrite the user's current navigation.
- A filtered reorder must use server anchors and must never submit a replacement order composed only of filtered cards.
- Task labels require a dedicated account-scoped task label model. Never reuse Contact tags silently.

## Responsibility, Subtasks, And Detail

- One user is the responsible owner. Collaborators are participants, not co-owners or notification subscribers unless explicitly implemented.
- A real subtask is a child task with the same list as its parent and no further child level.
- Use one canonical child-task API; do not expose the legacy `subtasks` checklist as a second editable surface.
- Child create/update/archive/restore must invalidate top-level task caches and publish a canonical parent/subtask reconciliation event so counts and progress cannot remain stale.
- Wide task surfaces show main work plus an activity/conversation rail. Narrow docked/mobile surfaces may use Details and Activity views.
- Docked/floating modes must leave the workspace usable; maximized/mobile modes may use modal focus and dimming.
- Inline property writes use task versions and preserve local drafts across conflict recovery.

## Activity, Comments, And Realtime

- Merge comments and activity chronologically while hiding a `comment_created` event when the corresponding comment is already rendered.
- Load the latest bounded comment page first and page older comments explicitly. Preserve chronological rendering and scroll position when prepending; do not silently truncate long conversations.
- Preserve mentions, attachments, author permissions, composer draft, edit draft, scroll proximity, and keyboard shortcuts during realtime updates.
- Page boundaries remain correct when comments are created or deleted. A canonical remote edit must update an already-loaded older comment by ID without replacing the recipient's locally-authorized edit/delete permissions.
- Events include account scope, stable task ID, action, canonical version, and operation ID when initiated optimistically.
- Keep a maximum accepted version and versioned delete tombstone per task in the workspace. Reject older task/order/HTTP payloads, and clear a tombstone only with a strictly compatible canonical restore, so out-of-order update/delete/restore delivery cannot resurrect or hide work.
- Patch task moves and ordinary updates. Reload folders/lists/workflows only for structural events.
- A late response from a previous task must never replace the currently selected task.

## Unsupported Controls

- Do not expose task AI, time tracking, sprint points, custom fields, public sharing, assigned comments, followers, or status automation until each exists end to end.
- Keep Gantt, calendar, dependencies, recurrence, reminders, files, and comments honest to their implemented backend semantics.
- Gantt must never truncate silently: page supported result sets or return a visible, actionable size limit.
