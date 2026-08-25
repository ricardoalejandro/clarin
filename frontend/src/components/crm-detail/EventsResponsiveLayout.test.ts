import { describe, expect, it } from 'vitest'
import { resolveEventsResponsiveLayout, type EventsViewMode } from '@/lib/eventsResponsive'

describe('Eventos responsive layout', () => {
  const widths = [320, 375, 639, 640, 768, 1023, 1024, 1440]
  const views: EventsViewMode[] = ['grid', 'compact', 'list']

  it.each(views)('preserves the selected %s view at every measured width', viewMode => {
    for (const width of widths) {
      expect(resolveEventsResponsiveLayout(viewMode, width).viewMode).toBe(viewMode)
    }
  })

  it('uses stacked list rows only below 640px without changing list view', () => {
    expect(resolveEventsResponsiveLayout('list', 320)).toMatchObject({ viewMode: 'list', listPresentation: 'stacked' })
    expect(resolveEventsResponsiveLayout('list', 639)).toMatchObject({ viewMode: 'list', listPresentation: 'stacked' })
    expect(resolveEventsResponsiveLayout('list', 640)).toMatchObject({ viewMode: 'list', listPresentation: 'table' })
    expect(resolveEventsResponsiveLayout('list', 1440)).toMatchObject({ viewMode: 'list', listPresentation: 'table' })
  })

  it('keeps the unmeasured initial state stable and uses measured width only for density', () => {
    expect(resolveEventsResponsiveLayout('compact', 0)).toMatchObject({
      viewMode: 'compact',
      listPresentation: 'table',
      compactWorkspace: false,
      compactGridColumns: 1,
      eventGridColumns: 1,
    })
    expect(resolveEventsResponsiveLayout('grid', 1023).compactWorkspace).toBe(true)
    expect(resolveEventsResponsiveLayout('grid', 1024).compactWorkspace).toBe(false)
  })
})
