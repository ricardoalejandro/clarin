import type { Task } from '@/types/task'
import { mergeTaskPage, TASK_PAGE_SIZE, type TaskPageResponse } from './taskPagination'

export function taskStructuralRefreshPageCount(loadedCount: number) {
  return Math.max(1, Math.ceil(loadedCount / TASK_PAGE_SIZE))
}

/** Revalidates only the already loaded depth; total cardinality never expands a response or the request budget. */
export async function collectTaskStructuralSnapshot(
  firstPage: TaskPageResponse,
  loadedCount: number,
  fetchNext: (cursor: string) => Promise<TaskPageResponse>,
  isCurrent: () => boolean,
): Promise<TaskPageResponse | null> {
  const pageCount = taskStructuralRefreshPageCount(loadedCount)
  let snapshot = { ...firstPage, tasks: mergeTaskPage([], firstPage.tasks, 'replace') }
  const seenCursors = new Set<string>()
  for (let page = 1; page < pageCount && snapshot.next_cursor; page += 1) {
    if (!isCurrent()) return null
    const cursor = snapshot.next_cursor
    if (seenCursors.has(cursor)) throw new Error('No se pudo revalidar la paginación de tareas. Reintenta.')
    seenCursors.add(cursor)
    const next = await fetchNext(cursor)
    if (!isCurrent()) return null
    snapshot = { ...next, tasks: mergeTaskPage(snapshot.tasks, next.tasks, 'append') }
  }
  return isCurrent() ? snapshot : null
}

/** A structural snapshot is authoritative for the loaded population. Only newer, still-visible concurrent edits may survive an omission. */
export function mergeTaskStructuralSnapshot(
  current: Task[],
  canonical: Task[],
  versionsAtStart: ReadonlyMap<string, number>,
  stillVisible: (task: Task) => boolean,
  authoritativeMissingIDs: ReadonlySet<string> = new Set(),
) {
  const canonicalIDs = new Set(canonical.map(task => task.id))
  const concurrent = current.filter(task => !canonicalIDs.has(task.id)
    && !authoritativeMissingIDs.has(task.id)
    && (task.version || 0) > (versionsAtStart.get(task.id) || 0)
    && stillVisible(task))
  return mergeTaskPage([], [...canonical, ...concurrent], 'replace')
}
