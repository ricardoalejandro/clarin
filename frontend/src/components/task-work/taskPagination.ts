import type { Task } from '@/types/task'

export const TASK_PAGE_SIZE = 50

export interface TaskPageResponse {
  tasks: Task[]
  total: number
  next_cursor?: string | null
  has_more?: boolean
}

export function taskPageParams(base: URLSearchParams, cursor?: string | null) {
  const params = new URLSearchParams(base)
  params.delete('offset')
  params.set('limit', String(TASK_PAGE_SIZE))
  if (cursor) params.set('cursor', cursor)
  else params.delete('cursor')
  return params
}

export function taskPageQueryKey(base: URLSearchParams) {
  const params = new URLSearchParams(base)
  params.delete('cursor')
  params.delete('limit')
  params.delete('offset')
  return Array.from(params.entries())
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&')
}

export type TaskPageItemResolution = 'accept' | 'preserve-current' | 'reject'

/**
 * Reconciles one paged row against realtime state. A tombstone always wins
 * over an older/equal page, and a stale page can only preserve an object that
 * is still present locally. This prevents "Cargar más" from resurrecting a
 * task that was deleted or revoked while the request was in flight.
 */
export function resolveTaskPageItem(
  incomingVersion: number,
  knownVersion: number,
  tombstoneVersion: number | undefined,
  hasCurrent: boolean,
): TaskPageItemResolution {
  if (tombstoneVersion !== undefined && incomingVersion <= tombstoneVersion) return 'reject'
  if (incomingVersion < knownVersion) return hasCurrent ? 'preserve-current' : 'reject'
  return 'accept'
}

function newerTask(left: Task, right: Task) {
  return (right.version || 0) >= (left.version || 0) ? right : left
}

/**
 * Merges one bounded server page without allowing duplicate IDs. A canonical
 * first-page refresh may preserve the already loaded tail, while a new query
 * replaces it completely. This keeps background reconciliation from making
 * rows disappear only because they live after the first cursor.
 */
export function mergeTaskPage(
  current: Task[],
  incoming: Task[],
  mode: 'replace' | 'refresh' | 'append',
  authoritativeMissingIDs: ReadonlySet<string> = new Set(),
) {
  if (mode === 'replace') return Array.from(new Map(incoming.map(task => [task.id, task])).values())

  if (mode === 'append') {
    const next = [...current]
    const indexes = new Map(next.map((task, index) => [task.id, index]))
    for (const task of incoming) {
      const index = indexes.get(task.id)
      if (index === undefined) {
        indexes.set(task.id, next.length)
        next.push(task)
      } else next[index] = newerTask(next[index], task)
    }
    return next
  }

  const incomingByID = new Map(incoming.map(task => [task.id, task]))
  const head = Array.from(incomingByID.values())
  const tail = current
    .filter(task => !incomingByID.has(task.id) && !authoritativeMissingIDs.has(task.id))
    .map(task => task)
  return [...head, ...tail]
}
