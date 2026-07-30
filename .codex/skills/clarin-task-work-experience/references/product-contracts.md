# Clarin Work Product Contracts

Read the sections relevant to the requested task change before editing.

## Hierarchy And Workflow

- A task belongs to one `account_id` and one task list. The default account list is a compatibility fallback, not permission to create invisible unscoped tasks.
- Folders contain lists; lists resolve one workflow; workflows own ordered statuses.
- A status is valid only for a task whose list resolves the same workflow.
- In aggregate views, group heterogeneous workflows by category and map a drop to the equivalent real status for each task. Disable a destination when no equivalent exists.
- Renaming or changing a status affects every list sharing that workflow; explain that scope before saving.
- Changing a list or folder workflow must be one transaction: lock the affected containers and destination statuses, prove a category-equivalent mapping for every active task, remap every task, and only then persist the new workflow.
- The root hierarchy is presented in this order: the pinned default list, “Listas independientes” (lists without a folder), then ordered folders and their ordered child lists. During a list drag, the independent-list heading becomes the explicit root drop zone; never use the ambiguous label “Sin carpeta” as a navigation action.
- Lists may move between folders, reorder inside one folder, or return to the explicit root container. Folders may reorder only among folders. Capture the complete hierarchy at drag start, preview locally, and emit at most one account-scoped structural write with the destination plus optional `before_list_id`/`before_folder_id`; Escape, an invalid drop, an incompatible workflow, `409`, or transport failure restores that exact snapshot.
- A structural list move must lock the source and destination folders, every active list in both ordering scopes, and the destination anchor before writing. The anchor must be active, same-account, and already inside the final folder/root scope. Workflow inheritance, task-status remapping, location, and normalized destination order commit or roll back together.
- The default account list is fixed at the root with `sort_order=0` and cannot be dragged, reparented, reordered, or archived. It may still be renamed and use a validated catalog color/icon; its safe default icon is `inbox`.
- Folder/list icons are stable catalog identifiers rather than arbitrary components, paths, or markup. Validate the same allowlist in the API and database, return icons in every hierarchy response, and render a safe fallback for legacy data.
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
- Keep sortable item arrays, droppable metadata, and scope-derived lists referentially stable between unrelated renders. A multi-column board must use a container-aware collision strategy; global `closestCenter` alone is not sufficient, and the active draggable must never be returned as its own collision target.
- Never change sortable topology from a collision callback. `onDragOver` may transfer the active task exactly once when its source and destination containers differ, but it must not physically reorder tasks already in the same column; calculate and persist that final order once in `onDragEnd`, deduplicate identical arrays, and disable derived layout animation for the one render in which container membership changes.
- A completed drop sends at most one atomic move request. Dropping outside, pressing Escape, hitting an incompatible workflow, or receiving an HTTP failure/conflict restores the exact drag-start snapshot without duplicating or losing the task.
- Use the entire card as a discoverable drag surface while keeping an accessible handle and excluding buttons, inputs, links, menus, and selects.
- A short click opens the detail. Completing, starring, editing, archiving, and adding a subtask never initiate drag.
- Keep status columns compact, colored from the real status, collapsible, and droppable. Collapsed columns must remain understandable and expand on intentional drag hover.

## Task Cards And Creation

- Prioritize title, overdue date, high/urgent priority, responsible owner, subtask progress, comments, and attachments.
- Do not repeat status inside a card already grouped by that status. Show list/origin only in aggregate views.
- Inline creation inherits an unambiguous list and real status. If the scope contains multiple possible lists, require a list selection.
- Enter saves a valid title; Escape cancels; More options preserves the draft in the full editor.
- Insert inline-created tasks at a deterministic server position and patch them without losing board scroll.
- Full task creation uses the same window behavior as detail: floating and docked desktop modes leave the workspace interactive, maximized and mobile modes are modal, and the remembered geometry is clamped to the measured viewport. Support header drag, edge/corner resize, right docking, maximize/restore, and double-click maximize.
- Escape closes an untouched creation form immediately. Once the user changes any field, Escape/close must offer “continue editing” or explicit discard and preserve the complete draft when discard is cancelled.
- List, folder, workflow, recurrence, reminder, category, color, and icon choices use accessible viewport-aware portaled pickers. The task-list picker is searchable and grouped by default list, independent lists, and folders with a real breadcrumb.

## Filters And Saved Views

- Combine different fields with AND and multiple choices inside one field with OR.
- Keep search directly accessible without displacing the primary view tabs. A compact search may expand in place on click or `/`; Escape collapses without deleting the query, while its clear action deletes and collapses. Show active filters as removable chips only while filters exist.
- Validate every saved-view JSON field server-side; keep views private to the current account/user unless shared views are explicitly designed.
- Apply a user's default saved view only during the workspace bootstrap. Remounting the toolbar after visiting Trash or changing scope must not overwrite the user's current navigation.
- A filtered reorder must use server anchors and must never submit a replacement order composed only of filtered cards.
- Task labels require a dedicated account-scoped task label model. Never reuse Contact tags silently.

## Responsibility, Subtasks, And Detail

- One user is the responsible owner. Collaborators are participants, not co-owners or notification subscribers unless explicitly implemented.
- Collaborator controls show only selected participants as removable chips and add through bounded search by name, username, or role. Exclude the owner. The canonical collaborator response is authoritative even when it is an explicit empty collection; never retain a stale final chip because an omitted task field was merged locally.
- Status and priority property controls must use accessible, viewport-aware portaled pickers with real status/category and priority semantics. They support pointer and keyboard operation and expose saving, conflict, rollback, and retry behavior.
- A real subtask is a child task with the same list as its parent and no further child level.
- Use one canonical child-task API; do not expose the legacy `subtasks` checklist as a second editable surface.
- Child create/update/archive/restore must invalidate top-level task caches and publish a canonical parent/subtask reconciliation event so counts and progress cannot remain stale.
- Wide task surfaces show main work plus an activity/conversation rail. Narrow docked/mobile surfaces may use Details and Activity views.
- Docked/floating modes must leave the workspace usable; maximized/mobile modes may use modal focus and dimming.
- Inline property writes use task versions and preserve local drafts across conflict recovery.

## Workspace Density

- `/dashboard/tasks` is a full-bleed workspace. Do not add dashboard padding around the task shell or a hard-coded minimum height that creates dead space.
- Keep title/actions and views/tools in two compact header rows. Lista, Tablero, Calendario, Gantt, and Resumen remain primary navigation and do not move when search expands.
- Board, calendar, and Gantt use the complete measured canvas. Reading views may retain only an 8–12 px breathing margin. Empty states fill the available surface instead of rendering as an inset card.
- Base responsive decisions on the measured workspace container after dashboard navigation and Eros chrome, not on browser width alone.

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
