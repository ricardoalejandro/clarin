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
  it('coalesces browser wake-ups and manual retries into one trailing recovery batch', async () => {
    let sequence = 1
    const room = connectWhiteboardRoom({ whiteboardID: 'board-1', audience: 'member', getSequence: () => sequence, getTicket: async () => 'ticket', onEvent: vi.fn() })
    await settlePromises()
    const socket = FakeWhiteboardWebSocket.instances[0]; socket.open()
    for (let i = 0; i < 10; i += 1) {
      window.dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new PageTransitionEvent('pageshow')); room.retryNow()
    }
    expect(socket.sent.map(value => JSON.parse(value).event)).toEqual(['sync.request', 'presence.update'])
    sequence = 9
    await vi.advanceTimersByTimeAsync(999)
    expect(socket.sent).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(socket.sent.map(value => JSON.parse(value))).toEqual([
      { event: 'sync.request', base_sequence: 1 }, { event: 'presence.update', data: { status: 'active' } },
      { event: 'sync.request', base_sequence: 9 }, { event: 'presence.update', data: { status: 'active' } },
    ])
    room.close()
  })

  it('honors rate cooldown without freezing the cursor and clears only its own notice', async () => {
    const issues: Array<WhiteboardRealtimeIssue | null> = []
    const room = connectWhiteboardRoom({ whiteboardID: 'board-1', audience: 'member', getSequence: () => 1, getTicket: async () => 'ticket', onEvent: vi.fn(), onIssue: issue => issues.push(issue) })
    await settlePromises()
    const socket = FakeWhiteboardWebSocket.instances[0]; socket.open()
    socket.emit({ event: 'error', code: 'rate_limited', data: { event: 'sync.request', scope: 'connection', retry_after_ms: 1_000 } })
    room.retryNow()
    room.sendCursor({ pointer: { x: 1, y: 2, tool: 'pointer' }, button: 'up' })
    expect(issues.at(-1)?.kind).toBe('rate_limited')
    expect(socket.sent.filter(value => JSON.parse(value).event === 'cursor.update')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(999)
    expect(socket.sent.filter(value => JSON.parse(value).event === 'sync.request')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(socket.sent.filter(value => JSON.parse(value).event === 'sync.request')).toHaveLength(2)
    expect(issues.at(-1)?.kind).toBe('rate_limited')
    socket.emit({ event: 'ack', sequence: 1 })
    expect(issues.at(-1)).toBeNull()
    socket.emit({ event: 'error', code: 'rate_limited' })
    socket.emit({ event: 'error', code: 'authorization_unavailable', error: 'Temporal' })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(issues.at(-1)?.kind).toBe('authorization_unavailable')
    socket.emit({ event: 'error', code: 'rate_limited' })
    expect(issues.at(-1)?.kind).toBe('authorization_unavailable')
    room.close()
  })

  it('keeps rejected durable operations correlated and permits an identical idempotent retry', async () => {
    const room = connectWhiteboardRoom({ whiteboardID: 'board-1', audience: 'member', getSequence: () => 1, getTicket: async () => 'ticket', onEvent: vi.fn() })
    await settlePromises()
    const socket = FakeWhiteboardWebSocket.instances[0]; socket.open()
    const patch = { event: 'scene.patch' as const, operation_id: 'same-operation', base_sequence: 1, elements: [{ id: 'shape', version: 2 }], app_state: {} }
    const first = room.sendPatch(patch)
    const rejected = expect(first).rejects.toMatchObject({ code: 'rate_limited' })
    socket.emit({ event: 'error', operation_id: patch.operation_id, code: 'rate_limited', data: { event: 'scene.patch', scope: 'room', retry_after_ms: 1_000 } })
    await rejected
    const second = room.sendPatch(patch)
    socket.emit({ event: 'ack', operation_id: patch.operation_id, sequence: 2 })
    await expect(second).resolves.toMatchObject({ operation_id: patch.operation_id, sequence: 2 })
    expect(socket.sent.map(value => JSON.parse(value)).filter(value => value.event === 'scene.patch')).toEqual([patch, patch])
    room.close()
  })

  it('drops all deferred channels when a room closes', async () => {
    const onIssue = vi.fn()
    const room = connectWhiteboardRoom({ whiteboardID: 'board-1', audience: 'guest', getSequence: () => 1, getTicket: async () => 'ticket', onEvent: vi.fn(), onIssue })
    await settlePromises()
    const socket = FakeWhiteboardWebSocket.instances[0]; socket.open()
    room.retryNow(); room.sendCursor({ pointer: { x: 1, y: 2, tool: 'pointer' }, button: 'up' }); room.sendCursor({ pointer: { x: 2, y: 3, tool: 'pointer' }, button: 'up' })
    room.sendViewport([0, 0, 10, 10]); room.sendViewport([1, 1, 11, 11])
    socket.emit({ event: 'error', code: 'rate_limited' })
    room.close()
    const count = socket.sent.length
    const issueCount = onIssue.mock.calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(socket.sent).toHaveLength(count)
    expect(onIssue).toHaveBeenCalledTimes(issueCount)
  })

  it('keeps rate feedback through reconnect and a large-scene sync until REST confirms it', async () => {
    const issues: Array<WhiteboardRealtimeIssue | null> = []
    const room = connectWhiteboardRoom({ whiteboardID: 'board-1', audience: 'member', getSequence: () => 5, getTicket: async () => 'ticket', onEvent: vi.fn(), onIssue: issue => issues.push(issue) })
    await settlePromises()
    const first = FakeWhiteboardWebSocket.instances[0]; first.open()
    first.emit({ event: 'error', code: 'rate_limited', data: { event: 'cursor.update', retry_after_ms: 1_000 } })
    first.serverClose()
    await vi.advanceTimersByTimeAsync(1_000)
    const second = FakeWhiteboardWebSocket.instances[1]; second.open()
    expect(issues.at(-1)?.kind).toBe('rate_limited')
    second.emit({ event: 'sync.required', sequence: 5, data: { reason: 'scene_too_large' } })
    expect(issues.at(-1)?.kind).toBe('rate_limited')
    room.confirmSync()
    expect(issues.at(-1)).toBeNull()
    room.close()
  })

  it('keeps rate feedback until the complete replay delta is canonically acknowledged', async () => {
    const issues: Array<WhiteboardRealtimeIssue | null> = []
    let sequence = 5
    const room = connectWhiteboardRoom({ whiteboardID: 'board-1', audience: 'member', getSequence: () => sequence, getTicket: async () => 'ticket', onEvent: event => { if (event.event === 'scene.patch' && event.sequence === sequence + 1) sequence = event.sequence }, onIssue: issue => issues.push(issue) })
    await settlePromises()
    const socket = FakeWhiteboardWebSocket.instances[0]; socket.open()
    socket.emit({ event: 'error', code: 'rate_limited', data: { event: 'sync.request', retry_after_ms: 1_000 } })
    await vi.advanceTimersByTimeAsync(1_000)
    socket.emit({ event: 'scene.patch', operation_id: 'patch-six', sequence: 6, data: { elements: [] } })
    expect(issues.at(-1)?.kind).toBe('rate_limited')
    socket.emit({ event: 'scene.patch', operation_id: 'patch-seven', sequence: 7, data: { elements: [] } })
    socket.emit({ event: 'ack', sequence: 6 })
    expect(issues.at(-1)?.kind).toBe('rate_limited')
    socket.emit({ event: 'ack', sequence: 7 })
    expect(issues.at(-1)).toBeNull()
    room.close()
  })

  it('waits for canonical REST when a durable ACK explicitly requires snapshot recovery', async () => {
    const issues: Array<WhiteboardRealtimeIssue | null> = []
    const room = connectWhiteboardRoom({ whiteboardID: 'board-1', audience: 'member', getSequence: () => 5, getTicket: async () => 'ticket', onEvent: vi.fn(), onIssue: issue => issues.push(issue) })
    await settlePromises()
    const socket = FakeWhiteboardWebSocket.instances[0]; socket.open()
    socket.emit({ event: 'error', code: 'rate_limited', data: { event: 'scene.patch', retry_after_ms: 1_000 } })
    await vi.advanceTimersByTimeAsync(1_000)
    const patch = { event: 'scene.patch' as const, operation_id: 'large-canonical-operation', base_sequence: 5, elements: [{ id: 'shape', version: 2 }], app_state: {} }
    const saved = room.sendPatch(patch)
    socket.emit({ event: 'ack', operation_id: patch.operation_id, sequence: 6, data: { sync_required: true } })
    await expect(saved).resolves.toMatchObject({ sequence: 6 })
    expect(issues.at(-1)?.kind).toBe('rate_limited')
    socket.emit({ event: 'sync.required', sequence: 6 })
    expect(issues.at(-1)?.kind).toBe('rate_limited')
    room.confirmSync()
    expect(issues.at(-1)).toBeNull()
    room.close()
  })

})
