import type { Task, TaskFolder, TaskList, TaskStatusCategory } from '@/types/task'

export interface TaskCountValues {
  task_count: number
  open_task_count: number
  completed_task_count: number
  cancelled_task_count: number
}

export interface TaskHierarchyCounts extends TaskCountValues {
  /** Monotonic PostgreSQL transaction revision. Preferred over wall-clock time. */
  revision?: number
  captured_at?: string
  lists: Array<TaskCountValues & { id: string }>
  folders: Array<TaskCountValues & { id: string }>
}

export interface TaskHierarchyCountSnapshotCursor {
  revision?: number
  captured_at?: string
}

export interface TaskHierarchyState {
  folders: TaskFolder[]
  rootLists: TaskList[]
}

export type TaskHierarchyCountOperationState = 'optimistic' | 'canonical'

/** Apply a realtime count snapshot first, then suppress the matching task echo
 * when the HTTP mutation has already reconciled that operation locally. */
export function shouldIgnoreTaskOperationEcho(
  operationID: string | undefined,
  operationPending: boolean,
  operationKnownBeforeSnapshot: boolean,
) {
  return Boolean(operationID && (operationPending || operationKnownBeforeSnapshot))
}

export function taskHierarchyCountMutationDecision(
  previous: TaskHierarchyCountOperationState | undefined,
  hasCanonicalSnapshot: boolean,
): 'apply-canonical' | 'apply-optimistic' | 'none' {
  if (hasCanonicalSnapshot) return previous === 'canonical' ? 'none' : 'apply-canonical'
  if (previous) return 'none'
  return 'apply-optimistic'
}

const ZERO_COUNTS: TaskCountValues = {
  task_count: 0,
  open_task_count: 0,
  completed_task_count: 0,
  cancelled_task_count: 0,
}

function normalizedCounts(value?: Partial<TaskCountValues>): TaskCountValues {
  return {
    task_count: Math.max(0, Number(value?.task_count) || 0),
    open_task_count: Math.max(0, Number(value?.open_task_count) || 0),
    completed_task_count: Math.max(0, Number(value?.completed_task_count) || 0),
    cancelled_task_count: Math.max(0, Number(value?.cancelled_task_count) || 0),
  }
}

function withCounts<T extends object>(value: T, counts?: Partial<TaskCountValues>): T & TaskCountValues {
  return { ...value, ...normalizedCounts(counts) }
}

export function applyCanonicalHierarchyCounts(
  state: TaskHierarchyState,
  snapshot?: TaskHierarchyCounts | null,
): TaskHierarchyState {
  if (!snapshot) return state
  const listCounts = new Map(snapshot.lists.map(item => [item.id, item]))
  const folderCounts = new Map(snapshot.folders.map(item => [item.id, item]))
  const patchList = (list: TaskList) => withCounts(list, listCounts.get(list.id))
  return {
    rootLists: state.rootLists.map(patchList),
    folders: state.folders.map(folder => ({
      ...withCounts(folder, folderCounts.get(folder.id)),
      lists: folder.lists.map(patchList),
    })),
  }
}

/**
 * Keeps the freshest counters while accepting a separately loaded hierarchy
 * shape. This prevents a delayed GET /hierarchy response from restoring stale
 * badges after a newer mutation snapshot was already reconciled.
 */
export function preserveHierarchyCounts(
  incoming: TaskHierarchyState,
  current: TaskHierarchyState,
): TaskHierarchyState {
  const currentLists = new Map(
    [...current.rootLists, ...current.folders.flatMap(folder => folder.lists)]
      .map(list => [list.id, normalizedCounts(list)]),
  )
  const currentFolders = new Map(current.folders.map(folder => [folder.id, normalizedCounts(folder)]))
  const patchList = (list: TaskList) => currentLists.has(list.id) ? withCounts(list, currentLists.get(list.id)) : list
  return {
    rootLists: incoming.rootLists.map(patchList),
    folders: incoming.folders.map(folder => ({
      ...(currentFolders.has(folder.id) ? withCounts(folder, currentFolders.get(folder.id)) : folder),
      lists: folder.lists.map(patchList),
    })),
  }
}

function taskCategory(task: Task): TaskStatusCategory {
  if (task.status_detail?.category) return task.status_detail.category
  if (task.status === 'completed') return 'done'
  if (task.status === 'cancelled') return 'cancelled'
  return 'not_started'
}

function taskContribution(task?: Task | null): TaskCountValues {
  if (!task || task.parent_task_id || task.deleted_at || !task.list_id) return ZERO_COUNTS
  const category = taskCategory(task)
  return {
    task_count: 1,
    open_task_count: category === 'done' || category === 'cancelled' ? 0 : 1,
    completed_task_count: category === 'done' ? 1 : 0,
    cancelled_task_count: category === 'cancelled' ? 1 : 0,
  }
}

function addCounts(base: TaskCountValues, delta: TaskCountValues, direction: 1 | -1): TaskCountValues {
  return normalizedCounts({
    task_count: base.task_count + direction * delta.task_count,
    open_task_count: base.open_task_count + direction * delta.open_task_count,
    completed_task_count: base.completed_task_count + direction * delta.completed_task_count,
    cancelled_task_count: base.cancelled_task_count + direction * delta.cancelled_task_count,
  })
}

/**
 * Applies the visible mutation immediately. A following canonical snapshot may
 * safely replace these values, so HTTP and WebSocket reconciliation cannot
 * double-count a task.
 */
export function reduceHierarchyForTaskMutation(
  state: TaskHierarchyState,
  before?: Task | null,
  after?: Task | null,
): TaskHierarchyState {
  const beforeContribution = taskContribution(before)
  const afterContribution = taskContribution(after)
  const beforeListID = beforeContribution.task_count ? before?.list_id : undefined
  const afterListID = afterContribution.task_count ? after?.list_id : undefined
  if (!beforeListID && !afterListID) return state

  const patchList = (list: TaskList) => {
    let counts = normalizedCounts(list)
    if (beforeListID === list.id) counts = addCounts(counts, beforeContribution, -1)
    if (afterListID === list.id) counts = addCounts(counts, afterContribution, 1)
    return withCounts(list, counts)
  }
  const rootLists = state.rootLists.map(patchList)
  const folders = state.folders.map(folder => {
    const lists = folder.lists.map(patchList)
    const aggregate = lists.reduce<TaskCountValues>((total, list) => ({
      task_count: total.task_count + list.task_count,
      open_task_count: total.open_task_count + (list.open_task_count || 0),
      completed_task_count: total.completed_task_count + (list.completed_task_count || 0),
      cancelled_task_count: total.cancelled_task_count + (list.cancelled_task_count || 0),
    }), ZERO_COUNTS)
    return { ...withCounts(folder, aggregate), lists }
  })
  return { folders, rootLists }
}

export function hierarchyOpenCount(folders: TaskFolder[], rootLists: TaskList[]) {
  return [...rootLists, ...folders.flatMap(folder => folder.lists)]
    .reduce((total, list) => total + (list.open_task_count || 0), 0)
}

export function hierarchyItemOpenCount(value: Partial<TaskCountValues>) {
  return normalizedCounts(value).open_task_count
}

function snapshotRevision(value?: number) {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined
}

export function shouldApplyHierarchyCountSnapshot(
  previous: TaskHierarchyCountSnapshotCursor,
  snapshot?: TaskHierarchyCounts | null,
) {
  if (!snapshot) return false
  const previousRevision = snapshotRevision(previous.revision)
  const nextRevision = snapshotRevision(snapshot.revision)
  if (nextRevision !== undefined) return previousRevision === undefined || nextRevision > previousRevision
  // Once a monotonic revision has been observed, an unversioned response can
  // no longer prove freshness, even if its wall clock happens to be later.
  if (previousRevision !== undefined) return false
  if (!previous.captured_at) return true
  if (!snapshot.captured_at) return false
  return snapshot.captured_at > previous.captured_at
}

export function hierarchyCountSnapshotCursor(
  previous: TaskHierarchyCountSnapshotCursor,
  snapshot: TaskHierarchyCounts,
): TaskHierarchyCountSnapshotCursor {
  return {
    revision: snapshotRevision(snapshot.revision) ?? previous.revision,
    captured_at: snapshot.captured_at || previous.captured_at,
  }
}

export function hierarchyCountTooltip(value: Partial<TaskCountValues>) {
	const counts = normalizedCounts(value)
	return `${counts.open_task_count} abiertas · ${counts.completed_task_count} completadas · ${counts.cancelled_task_count} canceladas · ${counts.task_count} total`
}

const MINIMAL_TASK_EVENTS_REQUIRING_HIERARCHY = new Set([
	'created', 'updated', 'completed', 'moved', 'bulk_moved', 'bulk_deleted',
	'environment_moved', 'restored',
])

/**
 * ACL-safe realtime events intentionally omit task objects and hierarchy
 * snapshots because each recipient may see a different Entorno/breadcrumb.
 * These mutations can change navigation inventory, so the client silently
 * reloads its own actor-scoped hierarchy. Comments, attachments, stars and
 * pure ordering events stay on the cheaper task-only reconciliation path.
 */
export function shouldReloadHierarchyForMinimalTaskEvent(payload: {
	action?: string
	task?: unknown
	hierarchy_counts?: unknown
}) {
	if (payload.task || payload.hierarchy_counts) return false
	return MINIMAL_TASK_EVENTS_REQUIRING_HIERARCHY.has(payload.action || '')
}
