import { describe, expect, it } from 'vitest'
import type { Task } from '@/types/task'
import { reconcileTaskDescriptionRealtime } from './taskDescriptionRealtime'

const task = {
  id: 'task-a',
  description: 'Anterior',
  version: 4,
  updated_at: '2026-08-25T10:00:00.000Z',
} as Task

describe('reconcileTaskDescriptionRealtime', () => {
  it('patches a newer authorized description event without replacing the collection', () => {
    const sibling = { ...task, id: 'task-b' }
    const result = reconcileTaskDescriptionRealtime([task, sibling], {
      action: 'description_updated',
      task_id: task.id,
      description: 'Versión remota',
      version: 5,
      updated_at: '2026-08-25T10:01:00.000Z',
    })

    expect(result.changed).toBe(true)
    expect(result.tasks[0]).toMatchObject({ description: 'Versión remota', version: 5 })
    expect(result.tasks[1]).toBe(sibling)
  })

  it('rejects stale, malformed and unrelated events', () => {
    for (const payload of [
      { action: 'description_updated', task_id: task.id, description: 'Vieja', version: 4 },
      { action: 'description_updated', task_id: task.id, description: 'Vieja', version: 3 },
      { action: 'description_updated', task_id: 'missing', description: 'Nueva', version: 5 },
      { action: 'updated', task_id: task.id, description: 'Nueva', version: 5 },
      { action: 'description_updated', task_id: task.id, version: 5 },
    ]) {
      const result = reconcileTaskDescriptionRealtime([task], payload)
      expect(result).toEqual({ tasks: [task], changed: false })
      expect(result.tasks[0]).toBe(task)
    }
  })
})
