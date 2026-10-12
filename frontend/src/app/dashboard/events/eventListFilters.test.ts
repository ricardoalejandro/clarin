import { describe, expect, it } from 'vitest'
import { eventListQuery } from './eventListFilters'

const defaults = { search: '', status: '', includeCancelled: false, folderID: null, limit: 50, offset: 0 }

describe('event list visibility queries', () => {
  it('excludes cancelled on the server before pagination only in the all-status view', () => {
    const query = eventListQuery(defaults)
    expect(query.get('exclude_cancelled')).toBe('true')
    expect(query.get('status')).toBeNull()
    expect(query.get('folder')).toBe('root')
    expect(query.get('limit')).toBe('50')
    expect(eventListQuery({ ...defaults, includeCancelled: true }).get('exclude_cancelled')).toBeNull()
  })

  it.each(['active', 'draft', 'completed', 'cancelled'])('lets explicit %s status determine visibility', status => {
    for (const includeCancelled of [true, false]) {
      const query = eventListQuery({ ...defaults, status, includeCancelled })
      expect(query.get('status')).toBe(status)
      expect(query.get('exclude_cancelled')).toBeNull()
    }
  })

  it('keeps visibility on later pages, with encoded search and folder scope', () => {
    const query = eventListQuery({ ...defaults, search: 'A & B', folderID: 'folder-a', offset: 50 })
    expect(Object.fromEntries(query)).toEqual({ search: 'A & B', exclude_cancelled: 'true', folder: 'folder-a', limit: '50', offset: '50' })
  })
})
