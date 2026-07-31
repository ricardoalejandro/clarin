import { describe, expect, it } from 'vitest'
import { dashboardSidebarHeaderState } from './dashboardSidebarState'

describe('dashboard sidebar header', () => {
  it('replaces the brand with a single expand control when collapsed', () => {
    expect(dashboardSidebarHeaderState(true, false)).toEqual({ compact: true, showBrand: false, showExpandControl: true, showCollapseControl: false })
  })

  it('keeps the complete brand on expanded and mobile surfaces', () => {
    expect(dashboardSidebarHeaderState(false, false).showBrand).toBe(true)
    expect(dashboardSidebarHeaderState(true, true).showBrand).toBe(true)
  })
})
