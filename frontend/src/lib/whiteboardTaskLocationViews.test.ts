import { describe, expect, it } from 'vitest'
import type { TaskLocationView } from '@/types/task'
import {
  createTaskLocationViewOperationAttempt,
  normalizeTaskBuiltinView,
  splitTaskLocationViewTabs,
  taskContainerPurgeDescription,
  taskContainerWhiteboardCount,
  taskLocationViewBreadcrumb,
  taskLocationViewCopyName,
  taskLocationViewMutationContextKey,
  taskLocationViewMutationResponseIsCurrent,
  taskLocationViewName,
  taskLocationViewNameDraft,
  taskLocationViewRequiresProtectedRemount,
  taskLocationViewSelectionError,
  taskLocationViewTabCapacity,
  taskPurgedWhiteboardCount,
} from './taskLocationViews'
import { collectTaskLocationViewPages } from './taskLocationViewsApi'

function view(id: string, sortOrder: number, name = id): TaskLocationView {
  return {
    id,
    type: 'whiteboard',
    environment_id: 'environment-1',
    scope: { scope_type: 'list', scope_id: 'list-1', scope_name: 'Lista', breadcrumb: [{ type: 'environment', id: 'environment-1', name: 'General' }, { type: 'list', id: 'list-1', name: 'Lista' }] },
    sort_order: sortOrder,
    version: 1,
    access_revision: 1,
    lifecycle: 'active',
    created_by: 'user-1',
    resource: { whiteboard: { id: `board-${id}`, name, version: 1, scene_sequence: 0, updated_at: '2026-08-25T00:00:00Z' } },
    capabilities: { can_view: true, can_comment: true, can_edit: true, can_manage: true, can_manage_access: false },
  }
}

describe('task location whiteboard views', () => {
  it('keeps TaskViewMode bounded to known built-in views', () => {
    expect(normalizeTaskBuiltinView('gantt')).toBe('gantt')
    expect(normalizeTaskBuiltinView('whiteboard')).toBe('list')
  })

  it('keeps the active contextual view visible when tabs overflow', () => {
    const result = splitTaskLocationViewTabs([view('a', 10), view('b', 20), view('c', 30), view('d', 40)], 'd', 2)
    expect(result.visible.map(item => item.id)).toEqual(['a', 'd'])
    expect(result.overflow.map(item => item.id)).toEqual(['b', 'c'])
  })

  it('sorts contextual tabs deterministically and derives responsive capacity', () => {
    const result = splitTaskLocationViewTabs([view('b', 20), view('a', 10)], null, 4)
    expect(result.visible.map(item => item.id)).toEqual(['a', 'b'])
    expect(taskLocationViewTabCapacity(559)).toBe(0)
    expect(taskLocationViewTabCapacity(1_280)).toBe(5)
  })

  it('moves contextual tabs into overflow at narrow widths while keeping the active one visible', () => {
    const views = [view('a', 10), view('b', 20)]
    expect(splitTaskLocationViewTabs(views, null, 0)).toEqual({ visible: [], overflow: views })
    expect(splitTaskLocationViewTabs(views, 'b', 0).visible.map(item => item.id)).toEqual(['b'])
  })

  it('renders an authorized breadcrumb and normalizes bounded names', () => {
    expect(taskLocationViewBreadcrumb(view('a', 1))).toBe('General / Lista')
    expect(taskLocationViewName(`  ${'x'.repeat(240)}  `)).toHaveLength(200)
    expect(Array.from(taskLocationViewName(`  ${'🧠'.repeat(240)}  `))).toHaveLength(200)
    expect(Array.from(taskLocationViewNameDraft(` ${'🧠'.repeat(240)} `))).toHaveLength(200)
    expect(taskLocationViewNameDraft(' Mapa ')).toBe(' Mapa ')
    expect(Array.from(taskLocationViewCopyName('🧠'.repeat(240)))).toHaveLength(200)
    expect(taskLocationViewCopyName('Mapa')).toBe('Mapa (copia)')
  })

  it('keeps old container payloads safe and warns about contextual whiteboards when counted', () => {
    expect(taskContainerWhiteboardCount(undefined)).toBe(0)
    expect(taskContainerWhiteboardCount(-1)).toBe(0)
    expect(taskContainerPurgeDescription(undefined)).not.toContain('pizarra contextual')
    expect(taskContainerPurgeDescription(1)).toContain('También se eliminarán 1 pizarra contextual vinculada.')
    expect(taskContainerPurgeDescription(3)).toContain('También se eliminarán 3 pizarras contextuales vinculadas.')
    expect(taskPurgedWhiteboardCount({ purged: { whiteboards: 4 } })).toBe(4)
    expect(taskPurgedWhiteboardCount({ whiteboards: 2 })).toBe(2)
    expect(taskPurgedWhiteboardCount({ purged: { whiteboards: -1 } })).toBe(0)
  })

  it('keeps one operation id for every retry of the same mutation attempt', () => {
    const attempt = createTaskLocationViewOperationAttempt('duplicate', 'view-a')
    const retry = attempt
    expect(retry.operationID).toBe(attempt.operationID)
    expect(retry.targetID).toBe('view-a')
    expect(createTaskLocationViewOperationAttempt('duplicate', 'view-a').operationID).not.toBe(attempt.operationID)
  })

  it('rejects mutation responses after the user changes location or invalidates the active view', () => {
    const listA = taskLocationViewMutationContextKey('environment-1', { type: 'list', id: 'list-a' })
    const listB = taskLocationViewMutationContextKey('environment-1', { type: 'list', id: 'list-b' })
    const otherEnvironment = taskLocationViewMutationContextKey('environment-2', { type: 'list', id: 'list-a' })
    const started = { contextKey: listA, generation: 7 }

    expect(taskLocationViewMutationResponseIsCurrent(started, { contextKey: listA, generation: 7 })).toBe(true)
    expect(taskLocationViewMutationResponseIsCurrent(started, { contextKey: listB, generation: 7 })).toBe(false)
    expect(taskLocationViewMutationResponseIsCurrent(started, { contextKey: otherEnvironment, generation: 7 })).toBe(false)
    expect(taskLocationViewMutationResponseIsCurrent(started, { contextKey: listA, generation: 8 })).toBe(false)
  })

  it('explains a current stale tab without surfacing errors from obsolete navigation', () => {
    const requested = view('a', 10)
    expect(taskLocationViewSelectionError(requested, undefined, true)).toMatch(/dejó de estar disponible/i)
    expect(taskLocationViewSelectionError(requested, { ...requested, access_revision: 2 }, true)).toMatch(/cambió/i)
    expect(taskLocationViewSelectionError(requested, { ...requested, lifecycle: 'trash' }, true)).toMatch(/cambió/i)
    expect(taskLocationViewSelectionError(requested, undefined, false)).toBeNull()
    expect(taskLocationViewSelectionError(requested, requested, true)).toBeNull()
  })

  it('protects every remount that could replace an open editor session', () => {
    const current = view('a', 10)
    expect(taskLocationViewRequiresProtectedRemount(current, { ...current, access_revision: 2 })).toBe(true)
    expect(taskLocationViewRequiresProtectedRemount(current, { ...current, lifecycle: 'location_archived' })).toBe(true)
    expect(taskLocationViewRequiresProtectedRemount(current, {
      ...current,
      resource: { whiteboard: { ...current.resource.whiteboard, name: 'Nombre actualizado' } },
    })).toBe(false)
  })

  it('collects every authorized page, preserves order and removes duplicate rows', async () => {
    const cursors: Array<string | null> = []
    const result = await collectTaskLocationViewPages(async cursor => {
      cursors.push(cursor)
      return cursor === null
        ? { success: true, data: { location_views: [view('a', 10), view('b', 20)], next_cursor: 'page-2', feature_enabled: true } }
        : { success: true, data: { location_views: [view('b', 20), view('c', 30)], next_cursor: null, feature_enabled: true } }
    })
    expect(cursors).toEqual([null, 'page-2'])
    expect(result.success).toBe(true)
    expect(result.data?.location_views.map(item => item.id)).toEqual(['a', 'b', 'c'])
    expect(result.data?.next_cursor).toBeNull()
  })

  it('rejects repeated pagination cursors instead of looping forever', async () => {
    const result = await collectTaskLocationViewPages(async () => ({
      success: true,
      data: { location_views: [view('a', 10)], next_cursor: 'same-page', feature_enabled: true },
    }), 'same-page')
    expect(result).toMatchObject({ success: false, status: 409 })
  })
})
