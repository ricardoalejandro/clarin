# Clarin Work Product Contracts

## Group movement and list transfer

- A task list transfer is one account-scoped transaction: lock the parent task, its one-level children, source/destination lists, workflows, statuses and durable destination order; map every status by category or reject everything.
- Bulk movement accepts unique top-level task IDs and optimistic versions only. Sort locks by stable UUID, preserve request-relative order, carry subtasks with parents and emit one `bulk_moved` event with one `operation_id`.
- A selected group is represented by one lightweight `DragOverlay`; never mount duplicate sortable cards in the overlay. Render at most three stack layers and eight convergence ghosts, while the badge reports the true total.
- Dropping on a folder never assigns its first list implicitly. A concrete list choice is required. Column drops map each real workflow by category; list drops preserve each task's current category.
- Escape, incompatible workflow, `409`, network failure and invalid targets restore the captured task/order/selection state without partial backend writes.

## Calendar creation

- Month cells and Week/Day hour slots may open a compact task composer. A concrete list, responsible user, compatible initial status and explicit start/due interval are required before creation.
- “More options” must preserve title, list, owner, all-day mode and exact dates/times in the full editor.

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

## Trash, Completion And Retention

- Completion and trash are independent lifecycles. A task in `done`, its `completed_at`, progress, due date, or appearance in a report never starts retention and never hides or archives it.
- Retention starts only after an explicit “Mover a Papelera” mutation writes `tasks.deleted_at`, `task_lists.archived_at`, or `task_folders.archived_at`. The account policy is 7–365 days or `NULL` for “Nunca”; policy changes recalculate eligibility and never schedule or execute automatic purge.
- Users with task access may archive and restore. Only account administrators may configure retention or permanently purge, and every irreversible action requires the exact canonical title/name under the same transaction lock used for eligibility.
- The default list cannot be archived or purged. Lists and folders may enter Trash only without active tasks; completed-but-active tasks still count as active because they have no `deleted_at`.
- Folder archive marks only the child lists archived by that folder operation. Folder restore restores those lists together but preserves lists that were archived individually; an individual list whose original folder is archived must wait for the folder restore.
- List/folder purge locks the account policy, target, descendants, and anchors, and commits only when every descendant is archived/deleted and every relevant timestamp has reached the cutoff. One ineligible or active descendant rolls back the entire tree.
- Attachment candidates are enqueued transactionally and deleted from object storage only by durable cleanup after rechecking every live media reference and the account-scoped object key.
- Archive, restore, purge, and policy WebSocket events remain account-scoped and carry an operation ID so the initiating client can ignore its own echo.

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
- Ctrl+drag and middle-button drag pan the wide board horizontally with open/closed-hand cursor feedback. These gestures suppress card click and task drag while preserving normal wheel, touch, keyboard, and sortable behavior.
- The full-height column remains a drop target, but its tinted visual surface grows only with real content up to the available height. Empty columns stay compact, and “Agregar tarea” follows the last card rather than floating above it.

## Task Cards And Creation

- Prioritize title, overdue date, high/urgent priority, responsible owner, subtask progress, comments, and attachments.
- Do not repeat status inside a card already grouped by that status. Show list/origin only in aggregate views.
- Inline creation inherits an unambiguous list and real status. If the scope contains multiple possible lists, require a list selection.
- Enter saves a valid title; Escape cancels; More options preserves the draft in the full editor.
- Insert inline-created tasks at a deterministic server position and patch them without losing board scroll.
- Every create may carry one optional UUID `operation_id`; the response and `task_update/created` event return the same value. The initiating client deduplicates the HTTP result and WebSocket echo by ID, version, and operation ID.
- If search or filters would hide a task just created by the current user, clear both while preserving the current folder/list scope, insert the canonical task once, scroll to it, highlight it temporarily, and explain why the query was cleared.
- Full task creation uses the same window behavior as detail: floating and docked desktop modes leave the workspace interactive, maximized and mobile modes are modal, and the remembered geometry is clamped to the measured viewport. Support header drag, edge/corner resize, right docking, maximize/restore, and double-click maximize.
- Escape closes an untouched creation form immediately. Once the user changes any field, Escape/close must offer “continue editing” or explicit discard and preserve the complete draft when discard is cancelled.
- List, folder, workflow, recurrence, reminder, category, color, and icon choices use accessible viewport-aware portaled pickers. The task-list picker is searchable and grouped by default list, independent lists, and folders with a real breadcrumb.

## Filters And Saved Views

- Combine different fields with AND and multiple choices inside one field with OR.
- Keep search directly accessible without displacing the primary view tabs. A compact search may expand in place on click or `/`; Escape collapses without deleting the query, while its clear action deletes and collapses. Show active filters as removable chips only while filters exist.
- Debounce task search for exactly 500 ms and expose the pending state quietly. Abort prior task/Gantt requests whenever query, filters, scope, or view changes; cancellation is not an error and an older response can never replace the latest result.
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
- The hierarchy navigation is independently scrollable with a quiet theme-aware scrollbar and edge shadows only when overflow exists. Folder accordions allow multiple open folders and remember expansion locally while always auto-opening the active list's parent.

## Activity, Comments, And Realtime

- Merge comments and activity chronologically while hiding a `comment_created` event when the corresponding comment is already rendered.
- Load the latest bounded comment page first and page older comments explicitly. Preserve chronological rendering and scroll position when prepending; do not silently truncate long conversations.
- Preserve mentions, attachments, author permissions, composer draft, edit draft, scroll proximity, and keyboard shortcuts during realtime updates.
- Page boundaries remain correct when comments are created or deleted. A canonical remote edit must update an already-loaded older comment by ID without replacing the recipient's locally-authorized edit/delete permissions.
- Events include account scope, stable task ID, action, canonical version, and operation ID when initiated optimistically.
- Under an active search or filter, remote create/update events never flash an unverified task into the UI; reconcile against the latest abortable canonical server response instead.
- Keep a maximum accepted version and versioned delete tombstone per task in the workspace. Reject older task/order/HTTP payloads, and clear a tombstone only with a strictly compatible canonical restore, so out-of-order update/delete/restore delivery cannot resurrect or hide work.
- Patch task moves and ordinary updates. Reload folders/lists/workflows only for structural events.
- A late response from a previous task must never replace the currently selected task.

## Unsupported Controls

- Do not expose task AI, time tracking, sprint points, custom fields, public sharing, assigned comments, followers, or status automation until each exists end to end.
- Keep Gantt, calendar, dependencies, recurrence, reminders, files, and comments honest to their implemented backend semantics.
- Gantt must never truncate silently: page supported result sets or return a visible, actionable size limit.
