import { describe, expect, it } from 'vitest'
import type { Task } from '@/types/task'
import {
  ensureExpandedFolder,
  hasActiveTaskQuery,
  normalizeExpandedFolders,
  toggleExpandedFolder,
  upsertCanonicalTask,
} from './taskWorkspaceState'

const task = (id: string, version: number): Task => ({ id, version, title: id } as Task)

describe('task workspace reconciliation', () => {
  it('detecta búsqueda o filtros activos sin falsos positivos por espacios', () => {
    expect(hasActiveTaskQuery('   ', 0)).toBe(false)
    expect(hasActiveTaskQuery('finaz', 0)).toBe(true)
    expect(hasActiveTaskQuery('', 2)).toBe(true)
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
})
