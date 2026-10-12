import { TASK_PAGE_SIZE, type TaskPageResponse } from './taskPagination'

/** Refresh the visible cursor window as a whole. Absence from just the first
 * page cannot distinguish a filtered-out row from one moved to the next page. */
export async function collectTaskWindow(
  load: (cursor?: string) => Promise<TaskPageResponse>,
  visibleCount: number,
): Promise<TaskPageResponse> {
  const pageCount = Math.max(1, Math.ceil(visibleCount / TASK_PAGE_SIZE))
  const rows = new Map<string, TaskPageResponse['tasks'][number]>()
  const seenCursors = new Set<string>()
  let cursor: string | undefined
  let response: TaskPageResponse = { tasks: [], total: 0 }
  for (let page = 0; page < pageCount; page++) {
    response = await load(cursor)
    for (const task of response.tasks) {
      const current = rows.get(task.id)
      if (!current || (task.version || 0) >= (current.version || 0)) rows.set(task.id, task)
    }
    cursor = response.next_cursor || undefined
    if (!cursor) break
    if (seenCursors.has(cursor)) throw new Error('El servidor repitió un cursor de tareas. Reintenta la carga.')
    seenCursors.add(cursor)
  }
  return { ...response, tasks: [...rows.values()] }
}
