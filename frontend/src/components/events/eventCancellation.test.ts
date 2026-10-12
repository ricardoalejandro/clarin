import { describe, expect, it, vi } from 'vitest'
import { cancelEventResource, eventCancellationPayload } from './eventCancellation'

const event = { id: 'event-a', status: 'active', updated_at: '2026-10-12T12:00:00Z' }
describe('event cancellation preserves history', () => {
  it('sends only a versioned lifecycle PUT and never a destructive DELETE', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, event: { ...event, status: 'cancelled' } })))
    await cancelEventResource(event, 'test-token', fetcher)
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, options] = fetcher.mock.calls[0]
    expect(url).toBe('/api/events/event-a')
    expect(options.method).toBe('PUT')
    expect(JSON.parse(options.body)).toEqual({ status: 'cancelled', expected_updated_at: event.updated_at })
  })
  it('loads the canonical version if an older list response lacks it', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ success: true, event }))).mockResolvedValueOnce(new Response(JSON.stringify({ success: true, event: { ...event, status: 'cancelled' } })))
    await cancelEventResource({ id: event.id, status: 'active' }, '', fetcher)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetcher.mock.calls[1][1].body).expected_updated_at).toBe(event.updated_at)
  })
  it.each(['completed', 'cancelled'])('rejects a terminal %s event without a write', async status => {
    const fetcher = vi.fn()
    await expect(cancelEventResource({ ...event, status }, '', fetcher)).rejects.toThrow('cerrado')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('keeps conflict explicit instead of retrying or deleting', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 409 }))
    await expect(cancelEventResource(event, '', fetcher)).rejects.toThrow('otra sesión')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(() => eventCancellationPayload({ id: event.id, status: 'active' })).toThrow('versión')
  })
})
