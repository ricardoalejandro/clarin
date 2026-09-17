import { describe, expect, it } from 'vitest'
import { offlineTaskCanComplete, offlineTaskIsCompleted, offlineTaskPriorityLabels } from './taskReadModel'
import type { OfflineTask } from './types'

const task: OfflineTask = { id: 't', title: 'Tarea', description: '', list_id: 'l', version: 2, priority: 'urgent', is_all_day: false, can_complete: true, status_category: 'active' }

describe('canonical offline task read model', () => {
  it('uses the workflow category even when a legacy field disagrees', () => {
    expect(offlineTaskIsCompleted({ ...task, status_category: 'done', status: 'pending' })).toBe(true)
    expect(offlineTaskIsCompleted({ ...task, status: 'completed' })).toBe(false)
    expect(offlineTaskPriorityLabels.urgent).toBe('Urgente')
  })
  it('intersects grant, resource and local state rather than exposing inert actions', () => {
    expect(offlineTaskCanComplete(task, true)).toBe(true)
    expect(offlineTaskCanComplete({ ...task, version: 0, local_confirmation: 'pending' }, true)).toBe(true)
    for (const row of [{ ...task, can_complete: undefined }, { ...task, can_complete: false }, { ...task, status_category: 'done' as const }, { ...task, local_confirmation: 'pending' as const }]) {
      expect(offlineTaskCanComplete(row, true)).toBe(false)
    }
    expect(offlineTaskCanComplete(task, false)).toBe(false)
  })
})
