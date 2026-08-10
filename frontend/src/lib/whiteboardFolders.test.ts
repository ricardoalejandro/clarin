import { describe, expect, it } from 'vitest'
import type { WhiteboardFolder, WhiteboardSummary } from './whiteboards'
import {
  activeWhiteboardFolders,
  archivedWhiteboardFolders,
  buildWhiteboardFolderRelocationPlan,
  buildWhiteboardFolderRenameInput,
  buildWhiteboardMoveInput,
  optimisticWhiteboardMove,
  settleWhiteboardFolderRelocation,
  settleWhiteboardMove,
  whiteboardFolderDestinationOptions,
} from './whiteboardFolders'
import { collectWhiteboardFolderPages } from './whiteboardsApi'

const board: WhiteboardSummary = {
  id: 'board-1',
  name: 'Mapa',
  description: 'Proceso',
  folder_id: 'folder-a',
  folder_name: 'A',
  created_at: '2026-08-09T00:00:00Z',
  updated_at: '2026-08-09T00:00:00Z',
  version: 7,
  scene_sequence: 3,
  effective_access: { level: 'edit', can_view: true, can_edit: true, can_manage_access: false },
}

const folders: WhiteboardFolder[] = [
  { id: 'folder-a', name: 'A', description: 'Origen', version: 2, sort_order: 1024 },
  { id: 'folder-b', name: 'B', version: 4, archived_at: '2026-08-09T01:00:00Z' },
]

describe('whiteboard folder contracts', () => {
  it('separates active and archived folders and preserves the rename concurrency contract', () => {
    expect(activeWhiteboardFolders(folders).map(folder => folder.id)).toEqual(['folder-a'])
    expect(archivedWhiteboardFolders(folders).map(folder => folder.id)).toEqual(['folder-b'])
    expect(buildWhiteboardFolderRenameInput(folders[0], '  Operaciones  ')).toEqual({
      parent_id: null,
      name: 'Operaciones',
      description: 'Origen',
      sort_order: 1024,
      expected_version: 2,
    })
  })

  it('moves with the complete versioned board contract and rolls back exactly on failure', () => {
    const destination = { id: 'folder-b', name: 'B' }
    expect(buildWhiteboardMoveInput(board, destination)).toEqual({
      name: 'Mapa',
      description: 'Proceso',
      folder_id: 'folder-b',
      expected_version: 7,
    })
    const optimistic = optimisticWhiteboardMove(board, destination)
    expect(optimistic).toMatchObject({ folder_id: 'folder-b', folder_name: 'B' })
    expect(settleWhiteboardMove([optimistic], board, null, 'folder-a')).toEqual([board])
  })

  it('removes a canonically moved board from the active folder in the same reconciliation', () => {
    const optimistic = optimisticWhiteboardMove(board, { id: null, name: null })
    const canonical = { ...optimistic, version: 8, updated_at: '2026-08-09T01:00:00Z' }
    expect(settleWhiteboardMove([optimistic], board, canonical, 'folder-a')).toEqual([])
  })

  it('collects every cursor-paged folder exactly once and rejects cursor cycles', async () => {
    const pages = new Map<string | null, { folders: WhiteboardFolder[]; next_cursor: string | null }>([
      [null, { folders: [folders[0]], next_cursor: 'next' }],
      ['next', { folders: [folders[0], folders[1]], next_cursor: null }],
    ])
    const complete = await collectWhiteboardFolderPages(async cursor => ({ success: true, data: pages.get(cursor)! }))
    expect(complete.data?.folders.map(folder => folder.id)).toEqual(['folder-a', 'folder-b'])

    let calls = 0
    const cycle = await collectWhiteboardFolderPages(async () => {
      calls += 1
      return { success: true, data: { folders: [], next_cursor: 'repeat' } }
    })
    expect(calls).toBe(2)
    expect(cycle.success).toBe(false)
    expect(cycle.error).toContain('cursor repetido')
  })

  it('builds one complete versioned relocation payload and preserves state exactly on failure', () => {
    const hierarchy: WhiteboardFolder[] = [
      { id: 'root-a', name: 'A', parent_id: null, sort_order: 1024, version: 1 },
      { id: 'root-b', name: 'B', description: 'Equipo', parent_id: null, sort_order: 2048, version: 7 },
      { id: 'child-a', name: 'Hija', parent_id: 'root-a', sort_order: 3072, version: 2 },
    ]
    expect(buildWhiteboardFolderRelocationPlan(hierarchy[1], hierarchy, 'root-a', 'last')).toEqual({
      changed: true,
      input: {
        parent_id: 'root-a',
        name: 'B',
        description: 'Equipo',
        sort_order: 4096,
        expected_version: 7,
      },
    })
    expect(buildWhiteboardFolderRelocationPlan(hierarchy[0], hierarchy, null, 'first').changed).toBe(false)
    expect(buildWhiteboardFolderRelocationPlan(hierarchy[1], hierarchy, null, 'first').input.sort_order).toBe(0)
    expect(() => buildWhiteboardFolderRelocationPlan({ ...hierarchy[0], id: 'stale' }, hierarchy, null, 'last')).toThrow('ya no está disponible')
    expect(settleWhiteboardFolderRelocation(hierarchy, null)).toEqual(hierarchy)

    const canonical = { ...hierarchy[1], parent_id: 'root-a', sort_order: 4096, version: 8 }
    expect(settleWhiteboardFolderRelocation(hierarchy, canonical)).toEqual([hierarchy[0], canonical, hierarchy[2]])
  })

  it('marks self, descendant, duplicate-name and excessive-depth destinations unavailable', () => {
    const hierarchy: WhiteboardFolder[] = [
      { id: 'target', name: 'Operaciones', parent_id: null, sort_order: 1024, version: 3 },
      { id: 'child', name: 'Hija', parent_id: 'target', sort_order: 1024, version: 1 },
      { id: 'other', name: 'Otro', parent_id: null, sort_order: 2048, version: 1 },
      { id: 'duplicate', name: 'operaciones', parent_id: 'other', sort_order: 1024, version: 1 },
    ]
    const options = whiteboardFolderDestinationOptions(hierarchy, hierarchy[0])
    expect(options.find(option => option.id === 'target')).toMatchObject({ disabled: true })
    expect(options.find(option => option.id === 'child')?.reason).toContain('subcarpetas')
    expect(options.find(option => option.id === 'other')?.reason).toContain('Ya existe')
    expect(() => buildWhiteboardFolderRelocationPlan(hierarchy[0], hierarchy, 'child', 'last')).toThrow('subcarpetas')

    const deep: WhiteboardFolder[] = [
      { id: 'moving', name: 'Mover', parent_id: null, sort_order: 1024, version: 1 },
      { id: 'moving-child', name: 'Contenido', parent_id: 'moving', sort_order: 1024, version: 1 },
      ...Array.from({ length: 19 }, (_, index) => ({
        id: `depth-${index + 1}`,
        name: `Nivel ${index + 1}`,
        parent_id: index === 0 ? null : `depth-${index}`,
        sort_order: 2048,
        version: 1,
      })),
    ]
    const deepest = whiteboardFolderDestinationOptions(deep, deep[0]).find(option => option.id === 'depth-19')
    expect(deepest?.reason).toContain('20 niveles')
  })
})
