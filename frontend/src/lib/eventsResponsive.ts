export type EventsViewMode = 'grid' | 'compact' | 'list'

export type EventsListPresentation = 'table' | 'stacked'

export interface EventsResponsiveLayout {
  viewMode: EventsViewMode
  listPresentation: EventsListPresentation
  compactWorkspace: boolean
  folderGridColumns: number
  compactGridColumns: number
  eventGridColumns: number
}

/**
 * Responsive density may change with the measured Eventos workspace, but the
 * user's chosen view is authoritative and must never be replaced by zoom.
 */
export function resolveEventsResponsiveLayout(
  viewMode: EventsViewMode,
  measuredWidth: number,
): EventsResponsiveLayout {
  const width = Number.isFinite(measuredWidth) && measuredWidth > 0 ? measuredWidth : 0

  return {
    viewMode,
    listPresentation: width > 0 && width < 640 ? 'stacked' : 'table',
    compactWorkspace: width > 0 && width < 1024,
    folderGridColumns: width >= 1200 ? 5 : width >= 900 ? 4 : width >= 640 ? 3 : 2,
    compactGridColumns: width >= 1000 ? 4 : width >= 680 ? 3 : width >= 480 ? 2 : 1,
    eventGridColumns: width >= 1000 ? 3 : width >= 640 ? 2 : 1,
  }
}
