import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { beginAuthIdentityChange, completeAuthIdentityChange } from '@/lib/authScope'
import type { Device, DeviceDeletionResult } from '@/types/chat'
import { useDeviceAdministration } from './useDeviceAdministration'

const ws = vi.hoisted(() => ({ listeners: new Set<(event: unknown) => void>() }))
vi.mock('@/lib/api', () => ({ subscribeWebSocket: (listener: (event: unknown) => void) => { ws.listeners.add(listener); return () => ws.listeners.delete(listener) } }))
const device: Device = { id: 'device-1', name: 'Synthetic channel', status: 'connected' }
const pending: DeviceDeletionResult = { device_id: device.id, operation_id: 'operation-1', deletion_status: 'pending', devices_total: 1, devices_available: 0, contacts_detached: 2, chats_detached: 3 }
const json = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response
beforeEach(() => { localStorage.clear(); localStorage.setItem('token', 'synthetic-device-token') })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); ws.listeners.clear() })

describe('device administration canonical state', () => {
  it('preserves a failed delete, single-flights a request, polls retries, and removes only on completion', async () => {
    let rows: Device[] = [device]
    let fail = true
    let resolveDelete!: (response: Response) => void
    const fetchMock = vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
      if (options?.method === 'DELETE') {
        if (fail) { fail = false; return Promise.resolve(json({ success: false, error: 'Fallo controlado' }, 500)) }
        return new Promise<Response>(resolve => { resolveDelete = resolve })
      }
      return Promise.resolve(json({ success: true, devices: rows }))
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    const view = renderHook(() => useDeviceAdministration<Device>(true))
    await act(async () => {})
    expect(view.result.current.total).toBe(1)
    await act(async () => { expect(await view.result.current.deleteDevice(device.id)).toBe(false) })
    expect(view.result.current.devices).toEqual([device])
    expect(view.result.current.error).toBe('Fallo controlado')
    let operation!: Promise<boolean>
    act(() => { operation = view.result.current.deleteDevice(device.id) })
    expect(view.result.current.pendingIds.has(device.id)).toBe(true)
    await act(async () => { expect(await view.result.current.deleteDevice(device.id)).toBe(false) })
    rows = [{ ...device, status: 'deleting', deletion: { operation_id: pending.operation_id, phase: 'pending', attempts: 0 } }]
    await act(async () => { resolveDelete(json({ success: true, ...pending }, 202)); expect(await operation).toBe(true) })
    expect(view.result.current.total).toBe(1)
    expect(view.result.current.available).toBe(0)
    expect(view.result.current.pendingIds.size).toBe(0)
    rows = [{ ...rows[0], deletion: { ...rows[0].deletion!, attempts: 1, next_retry_at: '2026-10-07T03:00:00Z', error_code: 'whatsapp_cleanup_retry' } }]
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(view.result.current.devices[0].deletion?.attempts).toBe(1)
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'DELETE')).toHaveLength(2)
    rows = []
    await act(async () => { ws.listeners.forEach(listener => listener({ event: 'device_deletion', data: { ...pending, deletion_status: 'completed', devices_total: 0, devices_available: 0 } })) })
    expect(view.result.current.total).toBe(0)
    expect(view.result.current.devices).toEqual([])
  })

  it('rejects an old account completion even if fetch ignores cancellation', async () => {
    let resolve!: (response: Response) => void
    const fetchMock = vi.fn().mockImplementationOnce(() => new Promise<Response>(done => { resolve = done })).mockImplementation(() => Promise.resolve(json({ success: true, devices: [{ ...device, id: 'fresh-device' }] })))
    vi.stubGlobal('fetch', fetchMock)
    const view = renderHook(() => useDeviceAdministration<Device>(true))
    act(() => { beginAuthIdentityChange() })
    expect(view.result.current.devices).toEqual([])
    await act(async () => { resolve(json({ success: true, devices: [device] })) })
    expect(view.result.current.devices).toEqual([])
    act(() => { completeAuthIdentityChange() })
    await waitFor(() => expect(view.result.current.devices[0]?.id).toBe('fresh-device'))
  })

  it('keeps canonical completion when a delayed HTTP 202 arrives after its WebSocket and empty GET', async () => {
    let rows: Device[] = [device]
    let resolveDelete!: (response: Response) => void
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => init?.method === 'DELETE'
      ? new Promise<Response>(resolve => { resolveDelete = resolve })
      : Promise.resolve(json({ success: true, devices: rows })))
    vi.stubGlobal('fetch', fetchMock)
    const view = renderHook(() => useDeviceAdministration<Device>(true))
    await waitFor(() => expect(view.result.current.devices).toEqual([device]))
    let deletion!: Promise<boolean>
    act(() => { deletion = view.result.current.deleteDevice(device.id) })
    expect(view.result.current.pendingIds.has(device.id)).toBe(true)

    rows = []
    await act(async () => {
      ws.listeners.forEach(listener => listener({ event: 'device_deletion', data: { ...pending, deletion_status: 'completed', devices_total: 0, devices_available: 0 } }))
    })
    await waitFor(() => expect(view.result.current.devices).toEqual([]))
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method !== 'DELETE')).toHaveLength(2)
    expect(view.result.current.total).toBe(0)
    expect(view.result.current.available).toBe(0)

    await act(async () => {
      resolveDelete(json({ success: true, ...pending }, 202))
      expect(await deletion).toBe(true)
    })
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method !== 'DELETE')).toHaveLength(3))
    expect(view.result.current.devices).toEqual([])
    expect(view.result.current.total).toBe(0)
    expect(view.result.current.available).toBe(0)
    expect(view.result.current.pendingIds.size).toBe(0)
    expect(view.result.current.error).toBe('')
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1)
  })
})
