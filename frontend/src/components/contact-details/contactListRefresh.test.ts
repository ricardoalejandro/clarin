import { describe, expect, it, vi } from 'vitest'
import { refreshContactWindow, refreshedContactAnchor } from './contactListRefresh'

describe('Contact list background refresh', () => {
  it('reconciles all loaded pages with bounded requests and removes a stale tail', async () => {
    const fetchPage = vi.fn(async (offset: number, limit: number) => ({ contacts: Array.from({ length: Math.min(limit, 123 - offset) }, (_, index) => ({ id: `contact-${offset + index}` })), total: 123 }))
    const result = await refreshContactWindow(150, 50, fetchPage)
    expect(fetchPage.mock.calls).toEqual([[0, 50], [50, 50], [100, 50]])
    expect(result.contacts).toHaveLength(123)
    expect(result.offset).toBe(123)
    expect(result.total).toBe(123)
  })
  it('does not commit a partial refresh when a later page fails', async () => {
    const fetchPage = vi.fn().mockResolvedValueOnce({ contacts: [{ id: 'one' }], total: 3 }).mockRejectedValueOnce(new Error('offline'))
    await expect(refreshContactWindow(3, 1, fetchPage)).rejects.toThrow('offline')
  })
  it('preserves the visible contact and pixel offset when order changes', () => {
    expect(refreshedContactAnchor([{ id: 'new' }, { id: 'one' }, { id: 'two' }], { id: 'two', index: 1, offset: -12 })).toEqual({ id: 'two', index: 2, offset: -12 })
    expect(refreshedContactAnchor([{ id: 'one' }], { id: 'deleted', index: 9, offset: 0 })).toEqual({ id: 'one', index: 0, offset: 0 })
    expect(refreshedContactAnchor([], { id: 'one', index: 0, offset: 0 })).toBeNull()
  })
})
