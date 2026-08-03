import { describe, expect, it } from 'vitest'
import type { Task } from '@/types/task'
import {
  ensureExpandedFolder,
  folderAutoExpandedForScope,
  hasActiveTaskQuery,
  normalizeExpandedFolders,
  reconcileCanonicalTaskBatch,
  taskBelongsToWorkspaceScope,
  taskMatchesWorkspaceFilters,
  toggleExpandedFolder,
  upsertCanonicalTask,
} from './taskWorkspaceState'
import { EMPTY_TASK_FILTERS } from './TaskFilters'

const task = (id: string, version: number): Task => ({ id, version, title: id } as Task)

describe('task workspace reconciliation', () => {
  it('detecta búsqueda o filtros activos sin falsos positivos por espacios', () => {
    expect(hasActiveTaskQuery('   ', 0)).toBe(false)
    expect(hasActiveTaskQuery('finaz', 0)).toBe(true)
    expect(hasActiveTaskQuery('', 2)).toBe(true)
  })

  it('retira del alcance de lista la tarea movida y conserva la versión canónica en Todo el Entorno', () => {
    const before = { ...task('moving', 1), environment_id: 'environment', list_id: 'mauritius', title: 'Finalizar pruebas' } as Task
    const moved = { ...before, version: 2, list_id: 'zambia', list_name: 'Zambia' }
    const base = { filters: EMPTY_TASK_FILTERS, view: 'list' as const, folders: [], activeEnvironmentID: 'environment' }
    expect(reconcileCanonicalTaskBatch([before], [moved], { ...base, scope: { type: 'list', id: 'mauritius' } })).toEqual([])
    expect(reconcileCanonicalTaskBatch([before], [moved], { ...base, scope: { type: 'environment', id: 'environment' } })[0])
      .toMatchObject({ version: 2, list_id: 'zambia', list_name: 'Zambia' })
  })

  it('mantiene un movimiento dentro de la misma carpeta y retira el que sale de ella', () => {
    const before = { ...task('moving', 1), environment_id: 'environment', list_id: 'a', priority: 'medium', type: 'reminder' } as Task
    const folders = [{ id: 'folder', lists: [{ id: 'a' }, { id: 'b' }] }]
    expect(taskBelongsToWorkspaceScope({ ...before, list_id: 'b' }, { type: 'folder', id: 'folder' }, 'environment', folders as never)).toBe(true)
    expect(taskBelongsToWorkspaceScope({ ...before, list_id: 'outside' }, { type: 'folder', id: 'folder' }, 'environment', folders as never)).toBe(false)
  })

  it('reevalúa filtros canónicos antes de conservar una fila', () => {
    const moving = { ...task('moving', 2), environment_id: 'environment', list_id: 'list', assigned_to: 'user-b', priority: 'medium', type: 'reminder', created_at: '2026-08-01T10:00:00Z' } as Task
    const filters = { ...EMPTY_TASK_FILTERS, assigned_to_ids: ['user-a'] }
    expect(taskMatchesWorkspaceFilters(moving, filters, 'list')).toBe(false)
    expect(reconcileCanonicalTaskBatch([moving], [moving], { scope: { type: 'list', id: 'list' }, activeEnvironmentID: 'environment', folders: [], filters, view: 'list' })).toEqual([])
  })

  it('retira una tarea canónica que dejó de coincidir con el estado filtrado', () => {
    const before = { ...task('moving', 1), environment_id: 'environment', list_id: 'mauritius', status_id: 'open', priority: 'medium', type: 'reminder' } as Task
    const moved = { ...before, list_id: 'zambia', status_id: 'done', version: 2 }
    const filters = { ...EMPTY_TASK_FILTERS, status_ids: ['open'] }
    expect(reconcileCanonicalTaskBatch([before], [moved], { scope: { type: 'environment', id: 'environment' }, activeEnvironmentID: 'environment', folders: [], filters, view: 'list' })).toEqual([])
  })

  it('reconcilia un lote en una sola colección sin duplicar tareas', () => {
    const first = { ...task('a', 1), environment_id: 'environment', list_id: 'source', priority: 'medium', type: 'reminder' } as Task
    const second = { ...task('b', 1), environment_id: 'environment', list_id: 'source', priority: 'medium', type: 'reminder' } as Task
    const moved = [{ ...first, version: 2, list_id: 'target' }, { ...second, version: 2, list_id: 'target' }]
    const result = reconcileCanonicalTaskBatch([first, second], moved, { scope: { type: 'list', id: 'source' }, activeEnvironmentID: 'environment', folders: [], filters: EMPTY_TASK_FILTERS, view: 'list' })
    expect(result).toEqual([])
  })

  it('deduplica HTTP y WebSocket por id y conserva la versión más nueva', () => {
    expect(upsertCanonicalTask([task('a', 2)], task('a', 1))[0].version).toBe(2)
    const updated = upsertCanonicalTask([task('a', 1)], task('a', 2))
    expect(updated).toHaveLength(1)
    expect(updated[0].version).toBe(2)
    expect(upsertCanonicalTask(updated, task('b', 1)).map(item => item.id)).toEqual(['b', 'a'])
  })
})

describe('folder accordion state', () => {
  it('admite varias carpetas, persiste solo ids válidos y abre la activa', () => {
    expect(Array.from(normalizeExpandedFolders(null, ['a', 'b']))).toEqual(['a', 'b'])
    expect(Array.from(normalizeExpandedFolders('["a","missing"]', ['a', 'b']))).toEqual(['a'])
    const both = toggleExpandedFolder(new Set(['a']), 'b')
    expect(Array.from(both)).toEqual(['a', 'b'])
    expect(Array.from(ensureExpandedFolder(toggleExpandedFolder(both, 'a'), 'a'))).toEqual(['b', 'a'])
  })

  it('restaura una instantánea sin compartir referencias mutables', () => {
    const snapshot = new Set(['a'])
    const changed = toggleExpandedFolder(snapshot, 'b')
    expect(Array.from(snapshot)).toEqual(['a'])
    expect(Array.from(changed)).toEqual(['a', 'b'])
  })

  it('abre automáticamente solo el padre de una lista, no una carpeta activa contraída', () => {
    const lists = [{ id: 'list', folder_id: 'folder' }]
    expect(folderAutoExpandedForScope({ type: 'list', id: 'list' }, lists)).toBe('folder')
    expect(folderAutoExpandedForScope({ type: 'folder', id: 'folder' }, lists)).toBeUndefined()
  })
})
