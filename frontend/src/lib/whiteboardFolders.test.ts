import { describe, expect, it } from 'vitest'
import type { WhiteboardFolder, WhiteboardSummary } from './whiteboards'
import {
  activeWhiteboardFolders,
  archivedWhiteboardFolders,
  buildWhiteboardFolderPlacementPlan,
  buildWhiteboardFolderRelocationPlan,
  buildWhiteboardFolderRenameInput,
  buildWhiteboardMoveInput,
  optimisticWhiteboardFolderCounts,
  optimisticWhiteboardFolderPlacement,
  optimisticWhiteboardMove,
  settleWhiteboardFolderRelocation,
  settleWhiteboardMove,
  whiteboardFolderPositionOptions,
  whiteboardFolderDestinationOptions,
  whiteboardMoveDestinationOptions,
} from './whiteboardFolders'
import { collectWhiteboardFolderPages } from './whiteboardsApi'

const board: WhiteboardSummary = {
  id: 'board-1',
  name: 'Mapa',
  description: 'Proceso',
  folder_id: 'folder-a',
  folder_name: 'A',
  owner_name: 'Ana',
  updated_by_name: 'Bruno',
  shared: true,
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
      name: 'Operaciones',
      description: 'Origen',
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
    expect(settleWhiteboardMove([optimistic], board, null, destination, 'folder-a')).toEqual([board])
  })

  it('removes a canonically moved board from the active folder in the same reconciliation', () => {
    const destination = { id: null, name: null }
    const optimistic = optimisticWhiteboardMove(board, destination)
    const canonical = { ...optimistic, version: 8, updated_at: '2026-08-09T01:00:00Z' }
    expect(settleWhiteboardMove([optimistic], board, canonical, destination, 'folder-a')).toEqual([])
  })

  it('merges a partial canonical move response without losing list metadata', () => {
    const destination = { id: 'folder-c', name: 'Campañas' }
    const optimistic = optimisticWhiteboardMove(board, destination)
    const partialCanonical = {
      id: board.id,
      version: 8,
      updated_at: '2026-08-09T01:00:00Z',
      scene_sequence: 3,
    } as WhiteboardSummary

    expect(settleWhiteboardMove([optimistic], board, partialCanonical, destination, null)).toEqual([{
      ...board,
      version: 8,
      updated_at: '2026-08-09T01:00:00Z',
      folder_id: 'folder-c',
      folder_name: 'Campañas',
      owner_name: 'Ana',
      updated_by_name: 'Bruno',
      shared: true,
    }])
  })

  it('builds searchable board destinations with a visible root and hierarchical paths', () => {
    const hierarchy: WhiteboardFolder[] = [
      { id: 'marketing', name: 'Marketing', parent_id: null, sort_order: 1024, version: 1 },
      { id: 'campaigns', name: 'Campañas', parent_id: 'marketing', sort_order: 1024, version: 1 },
      { id: 'operations', name: 'Operaciones', parent_id: null, sort_order: 2048, version: 1 },
      { id: 'archived', name: 'Archivada', parent_id: null, sort_order: 3072, version: 1, archived_at: '2026-08-09T01:00:00Z' },
    ]

    expect(whiteboardMoveDestinationOptions(hierarchy)).toEqual([
      { id: null, name: null, label: 'Sin carpeta', path: 'Nivel principal de Pizarras', depth: 0 },
      { id: 'marketing', name: 'Marketing', label: 'Marketing', path: 'Marketing', depth: 0 },
      { id: 'campaigns', name: 'Campañas', label: 'Campañas', path: 'Marketing / Campañas', depth: 1 },
      { id: 'operations', name: 'Operaciones', label: 'Operaciones', path: 'Operaciones', depth: 0 },
    ])
    expect(whiteboardMoveDestinationOptions(hierarchy, 'marketing').map(option => option.id)).toEqual(['marketing', 'campaigns'])
    expect(whiteboardMoveDestinationOptions(hierarchy, 'nivel principal').map(option => option.id)).toEqual([null])
    expect(whiteboardMoveDestinationOptions(hierarchy, 'ARCHIVADA')).toEqual([])
  })

  it('updates available folder counters optimistically without inventing missing counts', () => {
    const counted: WhiteboardFolder[] = [
      { id: 'source', name: 'Origen', whiteboard_count: 2, version: 1 },
      { id: 'destination', name: 'Destino', whiteboard_count: 4, version: 1 },
      { id: 'unknown', name: 'Sin contador', version: 1 },
    ]

    expect(optimisticWhiteboardFolderCounts(counted, 'source', 'destination')).toEqual([
      { ...counted[0], whiteboard_count: 1 },
      { ...counted[1], whiteboard_count: 5 },
      counted[2],
    ])
    expect(optimisticWhiteboardFolderCounts([{ ...counted[0], whiteboard_count: 0 }], 'source', null)[0].whiteboard_count).toBe(0)
    expect(optimisticWhiteboardFolderCounts(counted, 'source', 'source')).toEqual(counted)
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
        name: 'B',
        description: 'Equipo',
        placement: { parent_id: 'root-a', before_folder_id: null },
        expected_version: 7,
      },
    })
    expect(buildWhiteboardFolderRelocationPlan(hierarchy[0], hierarchy, null, 'first').changed).toBe(false)
    expect(buildWhiteboardFolderRelocationPlan(hierarchy[1], hierarchy, null, 'first').input.placement.before_folder_id).toBe('root-a')
    expect(() => buildWhiteboardFolderRelocationPlan({ ...hierarchy[0], id: 'stale' }, hierarchy, null, 'last')).toThrow('ya no está disponible')
    expect(settleWhiteboardFolderRelocation(hierarchy, null)).toEqual(hierarchy)

    const canonical = { ...hierarchy[1], parent_id: 'root-a', sort_order: 4096, version: 8 }
    expect(settleWhiteboardFolderRelocation(hierarchy, canonical)).toEqual([hierarchy[0], canonical, hierarchy[2]])
  })

  it('plans exact before-sibling placement and reorders the optimistic tree without losing descendants', () => {
    const hierarchy: WhiteboardFolder[] = [
      { id: 'root-a', name: 'A', parent_id: null, sort_order: 1024, version: 1 },
      { id: 'child-a', name: 'Hija', parent_id: 'root-a', sort_order: 1024, version: 2 },
      { id: 'root-b', name: 'B', parent_id: null, sort_order: 2048, version: 3 },
    ]
    expect(buildWhiteboardFolderPlacementPlan(hierarchy[1], hierarchy, null, 'root-b')).toEqual({
      changed: true,
      input: {
        name: 'Hija',
        description: '',
        placement: { parent_id: null, before_folder_id: 'root-b' },
        expected_version: 2,
      },
    })
    expect(whiteboardFolderPositionOptions(hierarchy, hierarchy[1], null)).toEqual([
      { beforeFolderID: 'root-a', label: 'Primera' },
      { beforeFolderID: 'root-b', label: 'Después de A' },
      { beforeFolderID: null, label: 'Después de B' },
    ])
    const optimistic = optimisticWhiteboardFolderPlacement(hierarchy, 'child-a', null, 'root-b')
    expect(optimistic.find(folder => folder.id === 'child-a')).toMatchObject({ parent_id: null, sort_order: 2048 })
    expect(optimistic.find(folder => folder.id === 'root-b')?.sort_order).toBe(3072)
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
