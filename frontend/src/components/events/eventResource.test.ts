import { describe, expect, it, vi } from 'vitest'
import { loadEventResource, EventResourceError } from './eventResource'
const { sharedApi } = vi.hoisted(() => ({ sharedApi: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: sharedApi }))

describe('event resource loading', () => {
  it('accepts only the canonical event requested and carries the scoped abort signal', async () => {
    const controller = new AbortController()
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, event: { id: 'event-a', name: 'Jornada' } })))
    expect(await loadEventResource('event-a', 'test-token', controller.signal, fetcher)).toMatchObject({ id: 'event-a' })
    expect(fetcher).toHaveBeenCalledWith('/api/events/event-a', expect.objectContaining({ signal: controller.signal, headers: { Authorization: 'Bearer test-token' } }))
  })
  it.each([401, 403, 404])('ends loading with an unavailable state for %s', async status => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status }))
    await expect(loadEventResource('event-a', '', new AbortController().signal, fetcher)).rejects.toMatchObject({ retryable: false })
  })
  it.each([{}, { success: true }, { success: true, event: { id: 'another-event' } }])('rejects malformed or mismatched success instead of leaving a skeleton', async body => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(body)))
    await expect(loadEventResource('event-a', '', new AbortController().signal, fetcher)).rejects.toMatchObject({ retryable: true })
  })
  it('offers retry for temporary server or network errors without exposing server internals', async () => {
    const server = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'internal private data' }), { status: 500 }))
    await expect(loadEventResource('event-a', '', new AbortController().signal, server)).rejects.toMatchObject({ retryable: true, message: 'No se pudo cargar el evento. Vuelve a intentarlo.' })
    const network = vi.fn().mockRejectedValue(new TypeError('network unavailable'))
    await expect(loadEventResource('event-a', '', new AbortController().signal, network)).rejects.toBeInstanceOf(EventResourceError)
  })
  it('preserves cancellation instead of showing a retry error for the prior event', async () => {
    const controller = new AbortController(), abort = new DOMException('aborted', 'AbortError')
    controller.abort()
    await expect(loadEventResource('event-a', '', controller.signal, vi.fn().mockRejectedValue(abort))).rejects.toBe(abort)
  })
})

it('uses shared authentication and never submits a legacy bearer header by default', async () => {
  sharedApi.mockResolvedValueOnce({ success: true, status: 200, data: { success: true, event: { id: 'event-a' } } })
  const controller = new AbortController()
  expect(await loadEventResource('event-a', 'cookie-session', controller.signal)).toEqual({ id: 'event-a' })
  expect(sharedApi).toHaveBeenCalledWith('/api/events/event-a', expect.objectContaining({ signal: controller.signal }))
  expect(sharedApi.mock.calls.at(-1)?.[1].headers.has('Authorization')).toBe(false)
})
it('respects shared account-scope cancellation without reading stale event data', async () => {
  sharedApi.mockResolvedValueOnce({ success: false, error: 'Solicitud cancelada' })
  await expect(loadEventResource('event-a', 'cookie-session', new AbortController().signal)).rejects.toMatchObject({ name: 'AbortError' })
})
