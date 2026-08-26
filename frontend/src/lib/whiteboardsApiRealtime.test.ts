import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectWhiteboardRoom, requestWhiteboardCollabTicket } from './whiteboardsApi'
import { whiteboardCollabTicketError, type WhiteboardRealtimeIssue } from './whiteboardRealtimeConnection'

class FakeWhiteboardWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeWhiteboardWebSocket[] = []

  readonly url: string
  readyState = FakeWhiteboardWebSocket.CONNECTING
  sent: string[] = []
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null

  constructor(url: string | URL) {
    this.url = String(url)
    FakeWhiteboardWebSocket.instances.push(this)
  }

  send(data: string) {
    if (this.readyState !== FakeWhiteboardWebSocket.OPEN) throw new Error('socket_not_open')
    this.sent.push(String(data))
  }

  open() {
    this.readyState = FakeWhiteboardWebSocket.OPEN
    this.onopen?.(new Event('open'))
  }

  emit(payload: unknown) {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(payload) }))
  }

  serverClose(code = 1013, reason = 'server_close') {
    this.readyState = FakeWhiteboardWebSocket.CLOSED
    this.onclose?.(new CloseEvent('close', { code, reason }))
  }

  close(code = 1000, reason = '') {
    this.readyState = FakeWhiteboardWebSocket.CLOSED
    this.onclose?.(new CloseEvent('close', { code, reason }))
  }
}

async function settlePromises() {
  await Promise.resolve()
  await Promise.resolve()
}

describe('connectWhiteboardRoom', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    FakeWhiteboardWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWhiteboardWebSocket)
  })

  afterEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('requests reconnect tickets passively without refreshing or extending activity', async () => {
    localStorage.setItem('token', 'cookie-session')
    localStorage.setItem('clarin:auth_refreshed_at', '1700000000000')
    localStorage.setItem('clarin:last_activity_at', '1700000001000')
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ success: true, ticket: 'passive-ticket' }),
      { status: 201, headers: { 'Content-Type': 'application/json' } },
    ))
    vi.stubGlobal('fetch', fetchMock)

    await expect(requestWhiteboardCollabTicket('board passive')).resolves.toBe('passive-ticket')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/whiteboards/board%20passive/collab-ticket')
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: '{}',
      credentials: 'include',
    })
    expect(localStorage.getItem('clarin:auth_refreshed_at')).toBe('1700000000000')
    expect(localStorage.getItem('clarin:last_activity_at')).toBe('1700000001000')
  })

  it('bootstraps a legacy whiteboard session after one ticket 401 without touching global auth activity', async () => {
    localStorage.setItem('token', 'cookie-session')
    localStorage.setItem('clarin:auth_refreshed_at', '1700000000000')
    localStorage.setItem('clarin:last_activity_at', '1700000001000')
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ success: false, error: 'Invalid token' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ success: true }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ success: true, ticket: 'bootstrapped-ticket' }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ))
    vi.stubGlobal('fetch', fetchMock)

    await expect(requestWhiteboardCollabTicket('legacy-board', 'account-original')).resolves.toBe('bootstrapped-ticket')

    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      '/api/whiteboards/legacy-board/collab-ticket',
      '/api/auth/whiteboard-session',
      '/api/whiteboards/legacy-board/collab-ticket',
    ])
    expect(fetchMock.mock.calls.every(call => call[1]?.credentials === 'include')).toBe(true)
    expect(fetchMock.mock.calls.every(call => call[1]?.method === 'POST')).toBe(true)
    expect(fetchMock.mock.calls.map(call => call[1]?.body)).toEqual([
      JSON.stringify({ account_id: 'account-original' }),
      '{}',
      JSON.stringify({ account_id: 'account-original' }),
    ])
    expect(fetchMock.mock.calls.some(call => (
      call[0] === '/api/auth/refresh'
      || call[0] === '/api/auth/activity'
      || call[0] === '/api/auth/logout'
    ))).toBe(false)
    expect(localStorage.getItem('clarin:auth_refreshed_at')).toBe('1700000000000')
    expect(localStorage.getItem('clarin:last_activity_at')).toBe('1700000001000')
  })

  it.each([
    ['503', () => Promise.resolve(new Response(
      JSON.stringify({ success: false, code: 'authorization_unavailable' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    ))],
    ['403 from a mixed deployment', () => Promise.resolve(new Response(
      JSON.stringify({ success: false, error: 'Forbidden' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    ))],
    ['404 from a deployment without the bootstrap route', () => Promise.resolve(new Response(
      JSON.stringify({ success: false, error: 'Not found' }),
      { status: 404, headers: { 'Content-Type': 'application/json' } },
    ))],
    ['network failure', () => Promise.reject(new TypeError('bootstrap offline'))],
  ] as const)('keeps a bootstrap %s recoverable without retrying the ticket', async (_label, bootstrapResult) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ success: false, error: 'Invalid token' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      ))
      .mockImplementationOnce(bootstrapResult)
    vi.stubGlobal('fetch', fetchMock)

    await expect(requestWhiteboardCollabTicket('legacy-board')).rejects.toMatchObject({
      issue: { kind: 'authorization_unavailable', retryable: true },
    })

    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      '/api/whiteboards/legacy-board/collab-ticket',
      '/api/auth/whiteboard-session',
    ])
  })

  it('keeps only bootstrap 401 terminal as an expired member session', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ success: false, error: 'Invalid token' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ success: false, error: 'Session unavailable' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      ))
    vi.stubGlobal('fetch', fetchMock)

    await expect(requestWhiteboardCollabTicket('legacy-board')).rejects.toMatchObject({
      status: 401,
      issue: { kind: 'session_expired', retryable: false },
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('keeps a second ticket 401 recoverable after a successful compatibility bootstrap', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ success: false, error: 'Invalid token' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      ))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ success: false, error: 'Credential not visible yet' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      ))
    vi.stubGlobal('fetch', fetchMock)

    await expect(requestWhiteboardCollabTicket('legacy-board', 'account-original')).rejects.toMatchObject({
      status: 503,
      issue: { kind: 'authorization_unavailable', retryable: true },
    })
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      '/api/whiteboards/legacy-board/collab-ticket',
      '/api/auth/whiteboard-session',
      '/api/whiteboards/legacy-board/collab-ticket',
    ])
  })

  it('retries a recoverable ticket failure and synchronizes immediately on open', async () => {
    const issue = whiteboardCollabTicketError({
      audience: 'member',
      status: 503,
      code: 'authorization_unavailable',
    })
    const getTicket = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(issue)
      .mockResolvedValue('ticket-2')
    const issues: Array<WhiteboardRealtimeIssue | null> = []
    const connections: string[] = []
    const room = connectWhiteboardRoom({
      whiteboardID: 'board-1',
      audience: 'member',
      getSequence: () => 7,
      getTicket,
      onEvent: vi.fn(),
      onIssue: value => issues.push(value),
      onConnectionChange: value => connections.push(value),
    })

    await settlePromises()
    expect(getTicket).toHaveBeenCalledTimes(1)
    expect(issues.at(-1)).toMatchObject({ kind: 'authorization_unavailable', retryable: true })
    expect(connections).toEqual(['connecting', 'closed'])

    await vi.advanceTimersByTimeAsync(1_000)
    await settlePromises()
    expect(getTicket).toHaveBeenCalledTimes(2)
    expect(FakeWhiteboardWebSocket.instances).toHaveLength(1)

    const socket = FakeWhiteboardWebSocket.instances[0]
    socket.open()
    expect(room.isOpen()).toBe(true)
    expect(issues.at(-1)).toBeNull()
    expect(socket.sent.map(message => JSON.parse(message))).toEqual([
      { event: 'sync.request', base_sequence: 7 },
      { event: 'presence.update', data: { status: 'active' } },
    ])
    room.close()
  })

  it('revalidates Work access changes instead of permanently blocking reconnect', async () => {
    const getTicket = vi.fn(async () => 'ticket')
    const issues: Array<WhiteboardRealtimeIssue | null> = []
    const onEvent = vi.fn()
    const room = connectWhiteboardRoom({
      whiteboardID: 'board-work',
      audience: 'member',
      getSequence: () => 0,
      getTicket,
      onEvent,
      onIssue: value => issues.push(value),
    })
    await settlePromises()
    const first = FakeWhiteboardWebSocket.instances[0]
    first.open()
    first.emit({ event: 'access.revoked', code: 'work_access_changed' })
    first.serverClose(1008, 'work_access_changed')
    await vi.advanceTimersByTimeAsync(1_100)
    await settlePromises()

    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ event: 'access.revoked', code: 'work_access_changed' }))
    expect(issues.filter(Boolean)).toEqual([])
    expect(getTicket).toHaveBeenCalledTimes(2)
    expect(FakeWhiteboardWebSocket.instances).toHaveLength(2)
    room.close()
  })

  it('does not duplicate sockets on online, visibility and pageshow wake-ups', async () => {
    const getTicket = vi.fn(async () => `ticket-${getTicket.mock.calls.length}`)
    const connections: string[] = []
    const room = connectWhiteboardRoom({
      whiteboardID: 'board-1',
      audience: 'member',
      getSequence: () => 1,
      getTicket,
      onEvent: vi.fn(),
      onConnectionChange: value => connections.push(value),
    })
    await settlePromises()
    const first = FakeWhiteboardWebSocket.instances[0]
    first.open()
    first.emit({ event: 'error', code: 'authorization_unavailable', error: 'Temporal' })
    first.serverClose()

    window.dispatchEvent(new Event('online'))
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new PageTransitionEvent('pageshow'))
    await settlePromises()

    expect(getTicket).toHaveBeenCalledTimes(2)
    expect(FakeWhiteboardWebSocket.instances).toHaveLength(2)
    const second = FakeWhiteboardWebSocket.instances[1]
    second.open()
    const callsBeforeStaleClose = connections.length
    first.onclose?.(new CloseEvent('close', { code: 1013, reason: 'late_close' }))
    expect(connections).toHaveLength(callsBeforeStaleClose)
    expect(room.isOpen()).toBe(true)

    await vi.advanceTimersByTimeAsync(20_000)
    expect(FakeWhiteboardWebSocket.instances).toHaveLength(2)
    room.close()
  })

  it.each([
    ['canonical revocation', { event: 'access.revoked', code: 'access_revoked' }, 'access_revoked'],
    ['expired member session', { event: 'error', code: 'session_expired' }, 'session_expired'],
  ] as const)('blocks reconnect after %s', async (_label, event, expectedKind) => {
    const getTicket = vi.fn(async () => 'ticket')
    const issues: Array<WhiteboardRealtimeIssue | null> = []
    const onEvent = vi.fn()
    const room = connectWhiteboardRoom({
      whiteboardID: 'board-1',
      audience: 'member',
      getSequence: () => 0,
      getTicket,
      onEvent,
      onIssue: value => issues.push(value),
    })
    await settlePromises()
    const socket = FakeWhiteboardWebSocket.instances[0]
    socket.open()
    socket.emit(event)
    socket.emit({ event: 'scene.snapshot', data: { scene: { elements: [{ id: 'late' }] } } })
    socket.serverClose(1008, expectedKind)
    window.dispatchEvent(new Event('online'))
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new PageTransitionEvent('pageshow'))
    await vi.advanceTimersByTimeAsync(30_000)

    expect(issues.at(-1)).toMatchObject({ kind: expectedKind, retryable: false })
    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(getTicket).toHaveBeenCalledTimes(1)
    expect(FakeWhiteboardWebSocket.instances).toHaveLength(1)
    room.close()
  })

  it('removes wake listeners and ignores a late browser close after room cleanup', async () => {
    const getTicket = vi.fn(async () => 'ticket')
    const connections: string[] = []
    const onEvent = vi.fn()
    const onIssue = vi.fn()
    const room = connectWhiteboardRoom({
      whiteboardID: 'board-1',
      audience: 'member',
      getSequence: () => 0,
      getTicket,
      onEvent,
      onIssue,
      onConnectionChange: value => connections.push(value),
    })
    await settlePromises()
    const socket = FakeWhiteboardWebSocket.instances[0]
    socket.open()
    room.close()
    const callsAfterClose = [...connections]
    const issuesAfterClose = onIssue.mock.calls.length

    socket.emit({ event: 'access.revoked', code: 'access_revoked' })
    socket.emit({ event: 'scene.snapshot', data: { scene: { elements: [] } } })
    socket.onclose?.(new CloseEvent('close', { code: 1000, reason: 'late_close' }))
    window.dispatchEvent(new Event('online'))
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new PageTransitionEvent('pageshow'))
    await vi.advanceTimersByTimeAsync(30_000)

    expect(connections).toEqual(callsAfterClose)
    expect(onIssue).toHaveBeenCalledTimes(issuesAfterClose)
    expect(onEvent).not.toHaveBeenCalled()
    expect(getTicket).toHaveBeenCalledTimes(1)
    expect(FakeWhiteboardWebSocket.instances).toHaveLength(1)
  })
})
