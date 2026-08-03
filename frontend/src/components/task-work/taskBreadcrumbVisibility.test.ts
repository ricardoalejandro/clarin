import { describe, expect, it } from 'vitest'
import { taskLocationLabel } from './taskBreadcrumbVisibility'

describe('shared task breadcrumb visibility', () => {
  it('never invents or leaks a list when the hierarchy is hidden', () => {
    expect(taskLocationLabel({ breadcrumbs_visible: false, list_name: 'Lista privada' })).toBe('Compartida contigo')
    expect(taskLocationLabel({ breadcrumbs_visible: false })).toBe('Compartida contigo')
  })

  it('keeps the canonical fallback only when hierarchy is visible', () => {
    expect(taskLocationLabel({ breadcrumbs_visible: true, list_name: 'Operaciones' })).toBe('Operaciones')
    expect(taskLocationLabel({})).toBe('Bandeja general')
  })
})

