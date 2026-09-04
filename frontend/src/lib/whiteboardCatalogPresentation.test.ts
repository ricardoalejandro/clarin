import { describe, expect, it } from 'vitest'
import {
  formatWhiteboardPurgeEligibility,
  whiteboardCatalogPresentation,
  type WhiteboardSummary,
} from './whiteboards'

const access = {
  level: 'manage' as const,
  can_view: true,
  can_edit: true,
  can_comment: true,
  can_delete: true,
  can_manage_access: true,
}

function board(overrides: Partial<WhiteboardSummary> = {}): WhiteboardSummary {
  return {
    id: 'board-1',
    name: 'Mapa operativo',
    created_at: '2026-09-04T08:00:00.000Z',
    updated_at: '2026-09-04T10:00:00.000Z',
    version: 1,
    scene_sequence: 2,
    effective_access: access,
    ...overrides,
  }
}

describe('whiteboardCatalogPresentation', () => {
  it('normalizes standalone metadata without inventing an owner', () => {
    const presentation = whiteboardCatalogPresentation(board({
      folder_name: 'Investigación',
      shared: true,
      updated_by_name: 'Ana QA',
    }), null, Date.parse('2026-09-04T12:00:00.000Z'))

    expect(presentation).toMatchObject({
      archived: false,
      work: false,
      badge: 'Compartida',
      contextLabel: 'Ana QA',
      actorLabel: 'Ana QA',
      updatedLabel: 'Hace 2 h',
      folderLabel: 'Investigación',
      purgeLabel: null,
      workLocationHref: null,
      workLocationAriaLabel: null,
    })
  })

  it('uses one Work badge and a clean authorized breadcrumb', () => {
    const presentation = whiteboardCatalogPresentation(board({
      origin: 'work',
      owner_name: 'Ricardo Rojas',
      work_location: {
        task_view_id: 'view 1',
        environment_id: 'environment-1',
        scope_type: 'list',
        scope_id: 'list-1',
        scope_name: 'Países',
        breadcrumb: [
          { type: 'environment', id: 'environment-1', name: ' NTtdata ' },
          { type: 'folder', id: 'folder-1', name: 'Países' },
          { type: 'list', id: 'list-1', name: 'Angola' },
        ],
        lifecycle: 'active',
      },
    }), null, Date.parse('2026-09-04T12:00:00.000Z'))

    expect(presentation.badge).toBe('Clarin Work')
    expect(presentation.contextLabel).toBe('NTtdata / Países / Angola')
    expect(presentation.contextLabel).not.toContain('Clarin Work')
    expect(presentation.actorLabel).toBe('Ricardo Rojas')
    expect(presentation.workLocationHref).toBe('/dashboard/tasks?work_view=view%201')
    expect(presentation.workLocationAriaLabel).toBe('Abrir ubicación en Work · Mapa operativo · NTtdata / Países / Angola')
  })

  it('keeps archived context but blocks the Work location action', () => {
    const eligibleAt = '2026-09-30T00:00:00.000Z'
    const presentation = whiteboardCatalogPresentation(board({
      archived_at: '2026-09-01T00:00:00.000Z',
      origin: 'work',
      work_location: {
        task_view_id: 'view-1',
        environment_id: 'environment-1',
        scope_type: 'folder',
        scope_id: 'folder-1',
        scope_name: 'Archivo histórico',
        lifecycle: 'location_archived',
      },
    }), eligibleAt)

    expect(presentation).toMatchObject({
      archived: true,
      work: true,
      badge: 'Clarin Work',
      contextLabel: 'Archivo histórico',
      workLocationHref: null,
      workLocationAriaLabel: null,
    })
    expect(presentation.purgeLabel).toBe(formatWhiteboardPurgeEligibility(eligibleAt))
  })

  it('provides calm fallbacks for missing folder, responsible person and Work breadcrumb', () => {
    expect(whiteboardCatalogPresentation(board(), null)).toMatchObject({
      contextLabel: 'Cuenta',
      folderLabel: 'Sin carpeta',
      actorLabel: 'Cuenta',
      badge: null,
    })
    expect(whiteboardCatalogPresentation(board({
      origin: 'work',
      work_location: {
        task_view_id: '',
        environment_id: 'environment-1',
        scope_type: 'list',
        scope_id: 'list-1',
        scope_name: '',
        lifecycle: 'active',
      },
    }), null)).toMatchObject({
      contextLabel: 'Ubicación autorizada',
      workLocationHref: null,
    })
  })
})
