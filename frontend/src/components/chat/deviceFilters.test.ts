import { describe, expect, it } from 'vitest'
import { reconcileChatDeviceFilters } from './deviceFilters'

describe('canonical chat device filters', () => {
  it('releases a deleting or removed channel so detached history stays visible', () => {
    expect(reconcileChatDeviceFilters(['device-a'], [{ id: 'device-a', status: 'deleting' }])).toEqual([])
    expect(reconcileChatDeviceFilters(['device-a'], [])).toEqual([])
  })

  it('keeps other canonical selections and excludes deletion metadata before status reconciliation', () => {
    expect(reconcileChatDeviceFilters(['device-a', 'device-b'], [
      { id: 'device-a', status: 'connected', deletion: { operation_id: 'delete-a', phase: 'pending', attempts: 0 } },
      { id: 'device-b', status: 'disconnected' },
    ])).toEqual(['device-b'])
    const selected = ['device-b']
    expect(reconcileChatDeviceFilters(selected, [{ id: 'device-b', status: 'connected' }])).toBe(selected)
    expect(reconcileChatDeviceFilters([], [{ id: 'device-b', status: 'connected' }])).toEqual([])
  })
})
