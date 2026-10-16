import { OfflineV5Error, type OfflineV5Snapshot } from './types'

export type OfflineTaskRow = Record<string, unknown>
type Key = Array<string | number | null>
type Overlay = { entity_type: string; entity_id: string; value: unknown }
const row = (value: unknown): OfflineTaskRow | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as OfflineTaskRow : undefined
const rows = (value: unknown): OfflineTaskRow[] => Array.isArray(value) ? value.flatMap(item => row(item) ? [item as OfflineTaskRow] : []) : []
const text = (value: unknown) => typeof value === 'string' ? value : ''
const numeric = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0
const time = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : NaN
const unique = (items: OfflineTaskRow[]) => [...new Map(items.map(item => [String(item.id), item])).values()]
const values = (params: URLSearchParams, ...keys: string[]) => (keys.map(key => params.get(key)?.trim()).find(Boolean) || '').split(',').map(value => value.trim()).filter(Boolean)
const category = (task: OfflineTaskRow) => text(row(task.status_detail)?.category) || text(task.status_category) || (task.status === 'completed' ? 'done' : task.status === 'cancelled' ? 'cancelled' : 'not_started')
const closed = (task: OfflineTaskRow) => ['done', 'cancelled'].includes(category(task))
const limaDay = (milliseconds: number) => Math.floor((milliseconds - 5 * 60 * 60 * 1000) / 86400000)

export function offlineTaskCounts(tasks: OfflineTaskRow[]) {
  const roots = tasks.filter(task => !task.parent_task_id && !task.deleted_at)
  return { task_count: roots.length, open_task_count: roots.filter(task => !closed(task)).length, completed_task_count: roots.filter(task => category(task) === 'done').length, cancelled_task_count: roots.filter(task => category(task) === 'cancelled').length }
}

/** Match ListComments: newest bounded page, then chronological reading order. */
export function offlineTaskCommentPage(comments: OfflineTaskRow[], offset: number, limit: number) {
  const sorted = [...comments].sort((left, right) => time(right.created_at) - time(left.created_at) || text(right.id).localeCompare(text(left.id)))
  return { comments: sorted.slice(offset, offset + limit).reverse(), has_more: offset + limit < sorted.length, next_offset: Math.min(sorted.length, offset + limit) }
}

/** Project the selected, actor-authorized corpus into the existing Work DTOs.
 * Counts are intentionally limited to prepared data; never invent sibling rows. */
export function offlineTaskDataset(snapshots: OfflineV5Snapshot[], overlays: Overlay[]) {
  const lists = snapshots.flatMap(snapshot => {
    const list = row(snapshot.payload.list)
    return list ? [{ ...list, statuses: rows(snapshot.payload.statuses), selection_id: snapshot.root_selection_id }] : []
  }) as OfflineTaskRow[]
  const users = unique(snapshots.flatMap(snapshot => rows(snapshot.payload.users)))
  const dependencies = unique(snapshots.flatMap(snapshot => rows(snapshot.payload.dependencies)))
  const comments = new Map(snapshots.flatMap(snapshot => rows(snapshot.payload.comments)).map(comment => [String(comment.id), comment]))
  for (const overlay of overlays) if (overlay.entity_type === 'task_comment' && row(overlay.value)) comments.set(overlay.entity_id, overlay.value as OfflineTaskRow)
  const byID = new Map(snapshots.flatMap(snapshot => rows(snapshot.payload.tasks)).map(task => [String(task.id), task]))
  for (const overlay of overlays) if (overlay.entity_type === 'task' && row(overlay.value)) byID.set(overlay.entity_id, overlay.value as OfflineTaskRow)
  const tasks = [...byID.values()].flatMap(task => {
    const list = lists.find(list => list.id === task.list_id)
    if (!list) return []
    const status = rows(list.statuses).find(status => status.id === task.status_id)
    const owner = users.find(user => user.id === task.assigned_to), creator = users.find(user => user.id === task.created_by)
    return [{ ...task, environment_id: list.environment_id, list_name: list.name, folder_id: list.folder_id, folder_name: list.folder_name,
      status_detail: status || row(task.status_detail), status_category: status?.category || category(task),
      assigned_to_name: owner?.display_name || owner?.username || task.assigned_to_name,
      created_by_name: creator?.display_name || creator?.username || task.created_by_name,
      dependency_count: dependencies.filter(link => link.predecessor_task_id === task.id || link.successor_task_id === task.id).length,
    }]
  }) as OfflineTaskRow[]
  for (const task of tasks) {
    const children = tasks.filter(child => child.parent_task_id === task.id && !child.deleted_at)
    task.subtask_count = children.length
    task.completed_subtask_count = children.filter(child => category(child) === 'done').length
    if (snapshots.some(snapshot => snapshot.root_resource_id === task.list_id && Array.isArray(snapshot.payload.comments))) task.comment_count = [...comments.values()].filter(comment => comment.task_id === task.id).length
    task.progress = category(task) === 'done' ? 100 : task.progress_mode === 'automatic'
      ? children.length ? Math.round(100 * numeric(task.completed_subtask_count) / children.length) : 0
      : task.manual_progress ?? task.progress ?? 0
  }
  for (const list of lists) Object.assign(list, offlineTaskCounts(tasks.filter(task => task.list_id === list.id)))
  const folders = unique(snapshots.flatMap(snapshot => row(snapshot.payload.folder) ? [snapshot.payload.folder as OfflineTaskRow] : [])).map<OfflineTaskRow>(folder => {
    const children = lists.filter(list => list.folder_id === folder.id)
    return { ...folder, icon: 'folder', lists: children, ...offlineTaskCounts(tasks.filter(task => children.some(list => list.id === task.list_id))) }
  })
  // Legacy copies preserve a read-only environment label, never fabricated Editar.
  const environments = unique(snapshots.flatMap(snapshot => {
    const environment = row(snapshot.payload.environment), list = row(snapshot.payload.list)
    return environment ? [environment] : list?.environment_id ? [{ id: list.environment_id, name: list.environment_name, permissions: { can_view: true, can_edit: false, can_manage_access: false }, effective_access_level: 'view' }] : []
  })).map<OfflineTaskRow>(environment => ({ ...environment, folder_count: folders.filter(folder => folder.environment_id === environment.id).length, list_count: lists.filter(list => list.environment_id === environment.id).length, ...offlineTaskCounts(tasks.filter(task => task.environment_id === environment.id)) }))
  return { lists, tasks, users, dependencies, folders, environments }
}

/** Same AND-between-families / OR-within-family contract as taskCollectionPredicate. */
export function filterOfflineTasks(tasks: OfflineTaskRow[], params: URLSearchParams, now = Date.now()): OfflineTaskRow[] {
  const statuses = values(params, 'status_ids', 'status')
  const dueBuckets = values(params, 'due')
  const isOverdue = (task: OfflineTaskRow) => time(task.due_at) < now && !closed(task)
  const matchValues = (task: OfflineTaskRow, field: string, ...keys: string[]) => {
    const selected = values(params, ...keys)
    return !selected.length || selected.includes(text(task[field]))
  }
  return tasks.filter(task => {
    const lifecycle = params.get('lifecycle'), deleted = params.get('deleted') === 'true' || lifecycle === 'trash'
    if (Boolean(task.deleted_at) !== deleted) return false
    if (lifecycle === 'archive' ? !task.archived_at && !task.container_archived : task.archived_at || task.container_archived) return false
    if (!statuses.length && params.get('include_closed')?.toLowerCase() === 'false' && closed(task)) return false
    if (statuses.length && !statuses.some(value => value === task.status_id || value === task.status || value === 'overdue' && isOverdue(task))) return false
    for (const name of ['environment_id', 'folder_id', 'lead_id', 'event_id', 'program_id', 'contact_id']) if (params.get(name) && params.get(name) !== task[name]) return false
    if (params.get('shared_with_me') === 'true' && task.direct_shared !== true) return false
    if (!matchValues(task, 'list_id', 'list_id')) return false
    if (params.get('parent_task_id') ? task.parent_task_id !== params.get('parent_task_id') : params.get('include_subtasks') !== 'true' && task.parent_task_id) return false
    if (!matchValues(task, 'type', 'types', 'type') || !matchValues(task, 'assigned_to', 'assigned_to_ids', 'assigned_to') || !matchValues(task, 'priority', 'priorities', 'priority') || !matchValues(task, 'created_by', 'creator_ids', 'created_by')) return false
    const collaborators = values(params, 'collaborator_ids')
    if (collaborators.length && !rows(task.collaborators).some(person => collaborators.includes(text(person.user_id)))) return false
    for (const [key, field] of Object.entries({ starred: 'starred', has_subtasks: 'subtask_count', has_comments: 'comment_count', has_attachments: 'attachment_count', has_dependencies: 'dependency_count' })) {
      const requested = params.get(key)?.toLowerCase()
      if ((requested === 'true' || requested === 'false') && Boolean(task[field]) !== (requested === 'true')) return false
    }
    const due = time(task.due_at), day = limaDay(due), today = limaDay(now)
    if (dueBuckets.length && !dueBuckets.some(bucket => {
      switch (bucket) {
        case 'overdue': return isOverdue(task)
        case 'today': return day === today
        case 'tomorrow': return day === today + 1
        case 'this_week': return day >= today && day < today + 7
        case 'next_7_days': return day >= today && day <= today + 7
        case 'no_date': return !Number.isFinite(due)
        case 'with_date': return Number.isFinite(due)
        default: return false
      }
    })) return false
    for (const [key, field] of Object.entries({ from: 'due_at', to: 'due_at', created_from: 'created_at', created_to: 'created_at', completed_from: 'completed_at', completed_to: 'completed_at' })) {
      const value = params.get(key)
      if (!value) continue
      const actual = time(task[field]), end = key === 'to' || key.endsWith('_to'), dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value)
      const boundary = Date.parse(dateOnly ? `${value}T00:00:00-05:00` : value)
      if (!Number.isFinite(actual) || !Number.isFinite(boundary) || (end ? dateOnly ? actual >= boundary + 86400000 : actual > boundary : actual < boundary)) return false
    }
    const search = (params.get('search') || '').trim().toLocaleLowerCase('es')
    return !search || `${text(task.title)}\n${text(task.description)}`.toLocaleLowerCase('es').includes(search)
  })
}

const statusRank = (task: OfflineTaskRow) => { const rank = ['overdue', 'pending', 'completed', 'cancelled'].indexOf(text(task.status)); return rank < 0 ? 4 : rank }
export const offlineTaskKey = (task: OfflineTaskRow): Key => [statusRank(task), numeric(task.sort_order), Number.isFinite(time(task.due_at)) ? time(task.due_at) : null, text(task.id)]
export const offlineStructureKey = (value: OfflineTaskRow): Key => [numeric(value.sort_order), text(value.id)]
function compare(left: Key, right: Key) {
  for (let index = 0; index < left.length; index++) {
    const a = left[index], b = right[index]
    if (a === b) continue
    if (a === null) return 1
    if (b === null) return -1
    return a < b ? -1 : 1
  }
  return 0
}

export function offlineTaskPage(items: OfflineTaskRow[], url: URL, key = offlineTaskKey) {
  const params = new URLSearchParams(url.search)
  params.delete('cursor'); params.delete('limit'); params.delete('offset'); params.sort()
  const scope = `${url.pathname}?${params}`
  const sorted = [...items].sort((a, b) => compare(key(a), key(b)))
  let boundary: Key | undefined
  if (url.searchParams.get('cursor')) {
    try {
      const cursor = JSON.parse(decodeURIComponent(url.searchParams.get('cursor')!))
      if (cursor.version !== 1 || cursor.scope !== scope || !Array.isArray(cursor.key) || cursor.key.length !== (key === offlineTaskKey ? 4 : 2) || cursor.key.some((part: unknown) => part !== null && typeof part !== 'number' && typeof part !== 'string')) throw new Error('cursor')
      boundary = cursor.key
    } catch { throw new OfflineV5Error('invalid_cursor', 'La página local pertenece a otra consulta o ya no es válida. Actualiza esta vista.') }
  }
  const rawLimit = Number(url.searchParams.get('limit') || 50), limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50
  const after = boundary ? sorted.filter(item => compare(key(item), boundary!) > 0) : sorted
  const page = after.slice(0, limit)
  return { items: page, total: sorted.length, next_cursor: after.length > limit ? encodeURIComponent(JSON.stringify({ version: 1, scope, key: key(page[page.length - 1]) })) : null }
}

export function offlineTaskSummary(tasks: OfflineTaskRow[], now = Date.now()) {
  const statusGroups = new Map<string, { id: string; name: string; color: string; count: number }>()
  const ownerGroups = new Map<string, { id: string; name: string; count: number; overdue: number }>()
  let overdue = 0
  for (const task of tasks) {
    const status = row(task.status_detail), id = text(task.status_id) || 'none'
    const group = statusGroups.get(id) || { id, name: text(status?.name) || 'Sin estado', color: text(status?.color) || '#64748B', count: 0 }
    group.count++; statusGroups.set(id, group)
    const ownerID = text(task.assigned_to), owner = ownerGroups.get(ownerID) || { id: ownerID, name: text(task.assigned_to_name) || 'Sin responsable', count: 0, overdue: 0 }
    owner.count++
    if (time(task.due_at) < now && !closed(task)) { owner.overdue++; overdue++ }
    ownerGroups.set(ownerID, owner)
  }
  const included = tasks.filter(task => category(task) !== 'cancelled')
  const byName = (a: { name: string; id: string }, b: { name: string; id: string }) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
  return { total: tasks.length, done: tasks.filter(task => category(task) === 'done').length, active: tasks.filter(task => category(task) === 'active').length, overdue, owners: [...ownerGroups.keys()].filter(Boolean).length,
    progress: included.length ? included.reduce((total, task) => total + (category(task) === 'done' ? 100 : numeric(task.progress)), 0) / included.length : 0,
    by_status: [...statusGroups.values()].sort(byName), by_owner: [...ownerGroups.values()].sort(byName) }
}

/** Mirrors computeCriticalPath, using only endpoints in this prepared query. */
export function offlineTaskGantt(allTasks: OfflineTaskRow[], allDependencies: OfflineTaskRow[]) {
  const tasks = allTasks.filter(task => Number.isFinite(time(task.start_at)) && time(task.due_at) >= time(task.start_at))
  const ids = new Set(tasks.map(task => text(task.id))), dependencies = allDependencies.filter(link => ids.has(text(link.predecessor_task_id)) && ids.has(text(link.successor_task_id)))
  const duration = new Map(tasks.map(task => [text(task.id), (time(task.due_at) - time(task.start_at)) / 60000]))
  const degree = new Map([...ids].map(id => [id, 0])), edges = new Map<string, Array<{ to: string; lag: number }>>()
  for (const link of dependencies) {
    const from = text(link.predecessor_task_id), to = text(link.successor_task_id)
    edges.set(from, [...(edges.get(from) || []), { to, lag: numeric(link.lag_minutes) }]); degree.set(to, degree.get(to)! + 1)
  }
  const queue = [...ids].filter(id => degree.get(id) === 0).sort(), topo: string[] = []
  while (queue.length) {
    const id = queue.shift()!; topo.push(id)
    for (const edge of edges.get(id) || []) { degree.set(edge.to, degree.get(edge.to)! - 1); if (!degree.get(edge.to)) queue.push(edge.to) }
  }
  const earliest = new Map<string, number>(), parent = new Map<string, string>(), downstream = new Map<string, number>()
  let project = 0, end = ''
  for (const id of topo) {
    const finish = (earliest.get(id) || 0) + duration.get(id)!
    if (finish > project) { project = finish; end = id }
    for (const edge of edges.get(id) || []) if (finish + edge.lag > (earliest.get(edge.to) || 0)) { earliest.set(edge.to, finish + edge.lag); parent.set(edge.to, id) }
  }
  for (const id of [...topo].reverse()) downstream.set(id, duration.get(id)! + Math.max(0, ...(edges.get(id) || []).map(edge => edge.lag + (downstream.get(edge.to) || 0))))
  const critical: string[] = []
  while (end) { critical.unshift(end); end = parent.get(end) || '' }
  return { success: true, tasks, dependencies, critical_task_ids: critical, slack_minutes: Object.fromEntries(topo.map(id => [id, Math.round(Math.max(0, project - (earliest.get(id) || 0) - (downstream.get(id) || 0)))])), total_count: allTasks.length, scheduled_count: tasks.length, unscheduled_count: allTasks.length - tasks.length }
}

export function offlineTaskAgenda(tasks: OfflineTaskRow[], url: URL) {
  const from = time(url.searchParams.get('from')), to = time(url.searchParams.get('to'))
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 400 * 86400000) throw new OfflineV5Error('invalid_agenda_range', 'El rango del calendario no es válido.')
  const sources = values(url.searchParams, 'sources')
  if (sources.some(source => source !== 'tasks' && source !== 'events')) throw new OfflineV5Error('invalid_agenda_sources', 'Las fuentes del calendario no son válidas.')
  const params = new URLSearchParams(url.search); params.delete('from'); params.delete('to'); params.delete('lifecycle'); params.delete('deleted')
  if (!params.has('include_closed')) params.set('include_closed', 'false')
  const filtered = sources.length && !sources.includes('tasks') ? [] : filterOfflineTasks(tasks, params).filter(task => {
    const start = time(task.start_at || task.due_at), end = time(task.due_end_at || task.due_at || task.start_at)
    return start < to && (end > from || end === start && start >= from)
  })
  const page = offlineTaskPage(filtered, url, task => [time(task.start_at || task.due_at), text(task.id)])
  return { items: page.items.map(task => ({kind:'task', key:`task:${task.id}`, task})), next_cursor:page.next_cursor, offline_sources:{available:['tasks'],unavailable:['events']}, offline_notice:'Sin conexión, el calendario muestra las tareas preparadas. Los eventos requieren conexión.' }
}
