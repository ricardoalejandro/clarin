# Clarin Work Product Contracts

## Group movement and list transfer

- A task list transfer is one account-scoped transaction: lock the parent task, its one-level children, source/destination lists, workflows, statuses and durable destination order; map every status by category or reject everything.
- Bulk movement accepts unique top-level task IDs and optimistic versions only. Sort locks by stable UUID, preserve request-relative order, carry subtasks with parents and emit one `bulk_moved` event with one `operation_id`.
- A selected group is represented by one lightweight `DragOverlay`; never mount duplicate sortable cards in the overlay. Render at most three stack layers and eight convergence ghosts, while the badge reports the true total.
- Dropping on a folder never assigns its first list implicitly. A concrete list choice is required. Column drops map each real workflow by category; list drops preserve each task's current category.
- Escape, incompatible workflow, `409`, network failure and invalid targets restore the captured task/order/selection state without partial backend writes.
- Resolve navigation targets from the real pointer coordinates and current measured list/folder rectangles, never from the translated card rectangle. Prefer a concrete list over its containing folder, use hysteresis at narrow boundaries, highlight destinations declaratively, and keep one write per completed gesture.
- Reconcile every canonical move response as one batch against the active scope. A task leaves its source-list view, remains in a folder only when its destination list is still inside that folder, and remains visible with its new location in Todo el Entorno. Reevaluate filters and closed visibility, clear selection only after success, and mark moved IDs authoritative so a paginated refresh cannot preserve an absent task as stale tail data.
- HTTP and WebSocket echoes share the same canonical reducer. Deduplicate side effects by `operation_id`, but always apply newer task versions and `hierarchy_counts`; a `409` or network failure preserves the exact source rows, selection and order for retry.
- Ordinary cards expose only completion persistently. Selection is adaptive through hover/focus actions, Ctrl/Cmd click, Shift range, stationary touch hold, or an already-active selection; Escape clears selection without mutating tasks.

## Calendar creation

- Month cells and Week/Day hour slots may open a compact task composer. A concrete list, responsible user, compatible initial status and explicit start/due interval are required before creation.
- “More options” must preserve title, list, owner, all-day mode and exact dates/times in the full editor.

Read the sections relevant to the requested task change before editing.

## Environments, Access, And Scale

- The canonical hierarchy is `Cuenta -> Entorno -> optional Folder -> List -> Task -> one-level Subtask`. Entorno is an account-scoped collaboration boundary and never a second tenant. A task has one environment truth derived from its list; folders, lists, workflows and statuses each belong to one Entorno.
- Every account has one migrated General Entorno that preserves existing functional task access and IDs/order. A new Entorno is private and atomically creates its default workflow, statuses, pinned inbox and an explicit Administrar grant with access governance for its creator.
- Entorno Ver is a hard prerequisite for every folder, list and task grant. Effective access resolves in strict order from most specific to broadest: account admin recovery, root-task grant, private-task boundary, list grant, list privacy, folder grant, folder privacy, Entorno grant and Entorno default. Specific grants may raise, lower or deny inheritance. Subtasks inherit their root task and cannot own grants.
- Ver reads visible work and files; Comentar additionally comments, mentions and attaches to comments; Editar additionally creates/changes tasks, order, participants and task attachments; Administrar additionally controls structure, workflows, archive/Trash/restore and privacy. `can_manage_access` is a separate governance bit requiring Administrar.
- Hidden resources return `404`; visible resources with insufficient action return `403`. Actor-aware SQL must filter every task surface, including comments, files, dependencies, reminders, reports, summary, calendar, Gantt, Trash, Eros, search and counts. Handler-only authorization is insufficient.
- Owner/collaborator membership does not silently grant access. Adding a participant without Editar requires a confirmed, atomic task grant. Removing the participant preserves that grant until access is explicitly edited. A private resource must retain one explicit manager; account admins retain recovery.
- “Todo el Entorno” never mixes tasks from another Entorno. “Compartidas conmigo” is a Hub scoped to the active Entorno and shows only directly granted folder, list and root-task resources; inherited descendants do not become duplicate Hub roots. A directly shared child hides every inaccessible parent breadcrumb, sibling and hierarchy count. Realtime uses authorized recipient sets and a revocation gives the removed user only a minimal tombstone.
- Creating a folder/list/task grant for a user without Entorno Ver is rejected. Historical child grants remain durable for audit but inactive, and may be preserved by later ACL edits without bypassing the Entorno boundary.
- Only tasks may move across Entornos. Require Administrar at origin and Editar at destination, require every participant retained by the task to see the destination Entorno, map status by workflow category, confirm only valid child grants and roll back the task, children, order and access together on any incompatibility.
- Entorno/list/task collections use stable opaque cursors, default 50 and maximum 200. Load one active hierarchy at a time, fetch folder children lazily, and debounce searchable remote catalogs exactly 500 ms with cancellation and stale-response rejection.
- Actor-scoped task, list, folder and Entorno DTOs expose `effective_access_level`, explicit `can_manage_access` (including `false`) and `capabilities`. The legacy `permissions` object remains a compatibility alias of the same canonical capability result; neither field may be derived from role names or visibility in the client.

## Hierarchy And Workflow

- A task belongs to one `account_id` and one task list inside one Entorno. The default Entorno inbox is a compatibility fallback, not permission to create invisible unscoped tasks.
- Folders contain lists; lists resolve one same-Entorno workflow; workflows own ordered statuses.
- A status is valid only for a task whose list resolves the same workflow.
- In aggregate views, group heterogeneous workflows by category and map a drop to the equivalent real status for each task. Disable a destination when no equivalent exists.
- Renaming or changing a status affects every list sharing that workflow; explain that scope before saving.
- Changing a list or folder workflow must be one transaction: lock the affected containers and destination statuses, prove a category-equivalent mapping for every active task, remap every task, and only then persist the new workflow.
- The root hierarchy is presented in this order: the pinned default list, “Listas independientes” (lists without a folder), then ordered folders and their ordered child lists. During a list drag, the independent-list heading becomes the explicit root drop zone; never use the ambiguous label “Sin carpeta” as a navigation action.
- Lists may move between folders, reorder inside one folder, or return to the explicit root container. Folders may reorder only among folders. Capture the complete hierarchy at drag start, preview locally, and emit at most one account-scoped structural write with the destination plus optional `before_list_id`/`before_folder_id`; Escape, an invalid drop, an incompatible workflow, `409`, or transport failure restores that exact snapshot.
- A structural list move must lock the source and destination folders, every active list in both ordering scopes, and the destination anchor before writing. The anchor must be active, same-account, and already inside the final folder/root scope. Workflow inheritance, task-status remapping, location, and normalized destination order commit or roll back together.
- The default account list is fixed at the root with `sort_order=0` and cannot be dragged, reparented, reordered, or archived. It may still be renamed and use a validated catalog color/icon; its safe default icon is `inbox`.
- Clicking a folder's main row selects its aggregate scope and toggles that accordion. Its chevron changes expansion only. An active folder may remain collapsed; navigation to a concrete child list is the only scope change that forces its parent open.
- Folder icons are always the immutable identifier `folder`; creation ignores legacy custom values, updates accept only `folder` as a compatibility no-op, and the database constraint normalizes and rejects every other value. List icons remain configurable stable catalog identifiers validated by the same API/database allowlist and rendered with a safe fallback.
- Archiving a list or folder is allowed only when it contains no active tasks. Restoring a child task requires an active parent and an active list/folder chain.
- Create, restore, move, archive, and workflow-remap paths must lock and revalidate their parent/list/folder/status dependencies after waiting; a pre-lock read is never sufficient proof under concurrency.

## Trash, Completion And Retention

- Completion and trash are independent lifecycles. A task in `done`, its `completed_at`, progress, due date, or appearance in a report never starts retention and never hides or archives it.
- Retention starts only after an explicit “Mover a Papelera” mutation writes `tasks.deleted_at`, `task_lists.archived_at`, or `task_folders.archived_at`. The account policy is 7–365 days or `NULL` for “Nunca”; policy changes recalculate eligibility and never schedule or execute automatic purge.
- Users with effective Administrar may archive and restore visible task resources. Only account administrators may configure retention or permanently purge, and every irreversible action requires the exact canonical title/name under the same transaction lock used for eligibility.
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
- Column and workspace action menus that can cross a board overflow boundary render through the shared `workspacePopover` portal layer. They flip/clamp to the viewport, reposition on scroll or resize, support full keyboard navigation and restore focus, while remaining below task windows and their child pickers.

## Task Cards And Creation

- Prioritize title, overdue date, high/urgent priority, responsible owner, subtask progress, comments, and attachments.
- Do not repeat status inside a card already grouped by that status. Show list/origin only in aggregate views.
- Inline creation inherits an unambiguous list and real status. If the scope contains multiple possible lists, require a list selection.
- Enter saves a valid title; Escape cancels; More options preserves the draft in the full editor.
- Insert inline-created tasks at a deterministic server position and patch them without losing board scroll.
- Every create may carry one optional UUID `operation_id`; the response and `task_update/created` event return the same value. The initiating client deduplicates the HTTP result and WebSocket echo by ID, version, and operation ID.
- If search or filters would hide a task just created by the current user, clear both while preserving the current folder/list scope, insert the canonical task once, scroll to it, highlight it temporarily, and explain why the query was cleared.
- Full task creation uses the same window behavior as detail: floating and docked desktop modes leave the workspace interactive, maximized and mobile modes are modal, and the remembered geometry is clamped to the measured viewport. Support header drag, edge/corner resize, right docking, maximize/restore, and double-click maximize.
- Keep preferred floating geometry separate from its effective viewport clamp. Persist only manual floating drag/resize with keys scoped by account, user and surface; docking, maximize, responsive layout and zoom never overwrite the preference. Discard unsafe legacy geometry, preserve only its mode, and expose Restablecer tamaño.
- Escape closes an untouched creation form immediately. Once the user changes any field, Escape/close must offer “continue editing” or explicit discard and preserve the complete draft when discard is cancelled.
- Ctrl/Command+Enter creates exactly once from the form or expanded description editor. Ignore IME composition, an invalid form, an open portaled picker and repeats during the active request; any failure or `409` preserves window, focus and the complete draft.
- Pre-create attachments live in a local validated queue with previews, removal and object-URL cleanup. Clipboard paste accepts image files only and never steals ordinary text paste. Create the task once, then upload the queue; a partial failure exposes pending attachments and retries only those files.
- List, folder, workflow, recurrence, reminder, category, color, and icon choices use accessible viewport-aware portaled pickers. The task-list picker is searchable and grouped by default list, independent lists, and folders with a real breadcrumb.
- Task dialogs, workspace popovers, confirmations, picker backdrops, picker menus, drag overlays and notifications use one monotonic layer contract. A child picker must always render above its owning dialog, restore focus, reposition on scroll/resize and stay within the viewport.

## Filters And Saved Views

- Combine different fields with AND and multiple choices inside one field with OR.
- Keep search directly accessible without displacing the primary view tabs. A compact search may expand in place on click or `/`; Escape collapses without deleting the query, while its clear action deletes and collapses. Show active filters as removable chips only while filters exist.
- Debounce task search for exactly 500 ms and expose the pending state quietly. Abort prior task/Gantt requests whenever query, filters, scope, or view changes; cancellation is not an error and an older response can never replace the latest result.
- Operational Lista, Tablero, Calendario and Gantt hide completed/cancelled work unless `include_closed=true` or an explicit status filter requests it. Resumen always retains historical metrics. Saved views normalize a missing `include_closed` to false.
- Navigation badges show open top-level tasks. Their accessible tooltip explains total, completed and cancelled counts. Create, move, complete, reopen, restore and Trash update list/folder/global counts optimistically and then reconcile `hierarchy_counts`; never wait for F5 or suppress the snapshot for a local operation.
- Filters are a draft inside the shared task work-window shell. Apply performs one state commit/query; Cancel/Escape discard; Clear edits the draft. Structure/Configuration uses the same movable, resizable, dockable, maximizable shell with protected contextual editing.
- Validate every saved-view JSON field server-side; keep views private to the current account/user unless shared views are explicitly designed.
- Apply a user's default saved view only during the workspace bootstrap. Remounting the toolbar after visiting Trash or changing scope must not overwrite the user's current navigation.
- A filtered reorder must use server anchors and must never submit a replacement order composed only of filtered cards.
- Task labels require a dedicated account-scoped task label model. Never reuse Contact tags silently.
- Lista starts grouped by status only for compatibility; users may choose none, status, list, responsible, priority, type or due date, plus direction and independently collapsed group keys. Saved views and local fallback preserve those fields. Dropping into a due bucket never invents a date: require an exact picker confirmation, including explicit confirmation before clearing a due date.
- A List row has one stable reorder handle. Reordering sends a complete selected set plus one same-list server anchor, preserves hidden rows and relative selection order, and results in one atomic write. A group-property drop changes only the represented property or remaps workflow category through the existing bulk move contract.
- Bulk destination pickers stage the operation. Selecting a list is not a write; show task count, destination, subtask movement and workflow remapping before Confirm. Bulk Trash requires the exact phrase `MOVER N TAREAS`, archives parents and their real subtasks atomically, and never exposes bulk permanent deletion.

## Progress, Dates, Gantt, And Attachment Proofing

- `progress_mode=manual` uses `manual_progress`; `automatic` derives the effective percentage from real one-level child tasks. Automatic tasks without children are 100 only when completed and 0 otherwise. Switching modes preserves manual progress, and completion remains independent from Trash.
- Clarin Work dates use one viewport-aware portaled picker with calendar, time, all-day, timezone, quick values, removal and linked range validation. Do not reintroduce native date fields into task detail, full creation, filters, inline creation or precise Gantt editing.
- Gantt supports day, week, month, quarter, year and flexible scales. Flexible zoom clamps to 8–120 px/day, wide ranges virtualize calendar cells, visible handles own start/end resize, and optional dependency cascading is one versioned transaction with complete rollback.
- Image, PDF, text and converted Word previews are account-scoped. Word conversion runs headless as non-root with bounded resources and no public port, records durable idempotent jobs, inventories derivatives in `media_assets` and `storage_objects`, and rechecks references before physical cleanup.
- Each attachment opening is a session keyed by task and attachment. Closing, switching, deleting, retrying or unmounting aborts fetch/poll, cancels PDF render, destroys loading task/document/worker state, revokes object URLs and clears annotations/canvas. PDF.js uses its installed compatible local worker; never rely on removed `disableWorker` behavior. Slow and failed phases end in actionable Retry/Download states.
- Attachment comments use anchors appropriate to the medium: normalized image point; PDF/converted page, point and quote; text line, offset and context. Replies, mentions and resolution are versioned and appear in task activity without being merged into the general comment thread.
- Only an anchored root may be resolved or reopened. A resolved root and all its replies remain readable but immutable and accept no new replies until reopened. Author or account administrator may edit/delete an open comment; deleting a root with live replies preserves its anchor and replies behind the canonical “Comentario eliminado” tombstone. Resolve, reopen, edit and delete write task activity in the same transaction, emit one account-scoped event after commit, and reconcile by version plus `operation_id` without reloading the attachment document.

## Responsibility, Subtasks, And Detail

- One user is the responsible owner. Collaborators are participants, not co-owners or notification subscribers unless explicitly implemented.
- Collaborator controls show only selected participants as removable chips and add through bounded search by name, username, or role. Exclude the owner. The canonical collaborator response is authoritative even when it is an explicit empty collection; never retain a stale final chip because an omitted task field was merged locally.
- Status and priority property controls must use accessible, viewport-aware portaled pickers with real status/category and priority semantics. They support pointer and keyboard operation and expose saving, conflict, rollback, and retry behavior.
- A real subtask is a child task with the same list as its parent and no further child level.
- Use one canonical child-task API; do not expose the legacy `subtasks` checklist as a second editable surface.
- Child create/update/archive/restore must invalidate top-level task caches and publish a canonical parent/subtask reconciliation event so counts and progress cannot remain stale.
- Wide task surfaces show main work plus an activity/conversation rail. Narrow docked/mobile surfaces may use Details and Activity views.
- Docked/floating modes must leave the workspace usable. Use the shared visual contract: floating uses an 18% veil and 2 px blur, docked uses 8% and 1 px, while maximized/mobile uses 45%, 3 px and modal blocking.
- A long description exposes a visible resize handle for pointer and keyboard, clamps and remembers its preferred height, and can open a wide editor that shares the exact same draft. Listo, Ctrl/Command+Enter and Escape attempt the same save; a failure keeps the editor open with actionable retry.
- Inline property writes use task versions and preserve local drafts across conflict recovery.

## Workspace Density

- `/dashboard/tasks` is a full-bleed workspace. Do not add dashboard padding around the task shell or a hard-coded minimum height that creates dead space.
- Keep title/actions and views/tools in two compact header rows. Lista, Tablero, Calendario, Gantt, and Resumen remain primary navigation and do not move when search expands.
- Board, calendar, and Gantt use the complete measured canvas. Reading views may retain only an 8–12 px breathing margin. Empty states fill the available surface instead of rendering as an inset card.
- Base responsive decisions on the measured workspace container after dashboard navigation and Eros chrome, not on browser width alone.
- In Lista, size the status control from the measured view width: show full semantics when comfortable, a compact trigger at medium width, and a separate property row when narrow. The portaled menu remains at least 280 px when the viewport permits it; tooltips appear only for actually truncated text.
- The hierarchy navigation is independently scrollable with a quiet theme-aware scrollbar and edge shadows only when overflow exists. Folder accordions allow multiple open folders and remember expansion locally while always auto-opening the active list's parent.
- Lista status groups remain mounted while collapsed, animate grid height, opacity and chevron for 200 ms, remove hidden controls from keyboard focus, and switch immediately under reduced-motion preferences.
- When the main dashboard sidebar is collapsed, hide the brand artwork completely and expose one centered, labelled expansion control with a portaled tooltip; expanded and mobile-open modes restore the full brand and collapse control.

## Activity, Comments, And Realtime

- Merge comments and activity chronologically while hiding a `comment_created` event when the corresponding comment is already rendered.
- Load the latest bounded comment page first and page older comments explicitly. Preserve chronological rendering and scroll position when prepending; do not silently truncate long conversations.
- Preserve mentions, attachments, author permissions, composer draft, edit draft, scroll proximity, and keyboard shortcuts during realtime updates.
- A comment image upload may create an owner-scoped expiring `comment_draft`, but task attachment lists must hide it. Creating/updating the comment validates account, task, actor and attachment IDs and promotes the drafts in the same transaction; abandoned or failed drafts remain inventoried durable cleanup candidates.
- Page boundaries remain correct when comments are created or deleted. A canonical remote edit must update an already-loaded older comment by ID without replacing the recipient's locally-authorized edit/delete permissions.
- Events include account scope, stable task ID, action, canonical version, access revision and operation ID when initiated optimistically, and are delivered only to the intersection of users authorized for every represented resource.
- Under an active search or filter, remote create/update events never flash an unverified task into the UI; reconcile against the latest abortable canonical server response instead.
- Keep a maximum accepted version and versioned delete tombstone per task in the workspace. Reject older task/order/HTTP payloads, and clear a tombstone only with a strictly compatible canonical restore, so out-of-order update/delete/restore delivery cannot resurrect or hide work.
- Patch task moves and ordinary updates. Reload folders/lists/workflows only for structural events.
- A late response from a previous task must never replace the currently selected task.

## Unsupported Controls

- Do not expose task AI, time tracking, sprint points, custom fields, public sharing, assigned comments, followers, or status automation until each exists end to end.
- Keep Gantt, calendar, dependencies, recurrence, reminders, files, and comments honest to their implemented backend semantics.
- Gantt must never truncate silently: page supported result sets or return a visible, actionable size limit.
