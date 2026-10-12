import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWhiteboardRealtimeScheduler } from './whiteboardRealtimeScheduler'

describe('whiteboard realtime scheduler', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0) })
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

  it('rejects an overdue callback after an immediate flush and keeps the latest trailing value', async () => {
    const timeout = vi.spyOn(globalThis, 'setTimeout')
    const sent: Array<{ at: number; value: number }> = []
    const scheduler = createWhiteboardRealtimeScheduler({ intervalMS: 50, now: () => Date.now(), send: (value: number) => { sent.push({ at: Date.now(), value }); return true } })
    scheduler.enqueue(0)
    vi.setSystemTime(1); scheduler.enqueue(1)
    const overdue = timeout.mock.calls[0][0] as () => void
    vi.setSystemTime(50); scheduler.enqueue(50)
    vi.setSystemTime(51); scheduler.enqueue(51)
    overdue()
    expect(sent).toEqual([{ at: 0, value: 0 }, { at: 50, value: 50 }])
    await vi.advanceTimersByTimeAsync(49)
    expect(sent.at(-1)).toEqual({ at: 100, value: 51 })
    scheduler.close()
  })

  it('bounds high-frequency input and sends the final position', async () => {
    const sent: Array<{ at: number; value: number }> = []
    const scheduler = createWhiteboardRealtimeScheduler({ intervalMS: 50, now: () => Date.now(), send: (value: number) => { sent.push({ at: Date.now(), value }); return true } })
    for (let i = 0; i < 1_000; i += 1) { scheduler.enqueue(i); await vi.advanceTimersByTimeAsync(1) }
    await vi.advanceTimersByTimeAsync(50)
    expect(sent.length).toBeLessThanOrEqual(21)
    expect(sent.at(-1)?.value).toBe(999)
    expect(sent.slice(1).every((value, index) => value.at - sent[index].at >= 50)).toBe(true)
    scheduler.close()
  })

  it('merges controls, respects cooldown and cancels every pending value on reset/close', async () => {
    const send = vi.fn<(value: number) => boolean>(() => true)
    const scheduler = createWhiteboardRealtimeScheduler({ intervalMS: 1_000, now: () => Date.now(), send, merge: (a: number, b: number) => a | b })
    scheduler.enqueue(1)
    scheduler.enqueue(1); scheduler.enqueue(2)
    vi.setSystemTime(500); scheduler.defer(1_000)
    await vi.advanceTimersByTimeAsync(999)
    expect(send).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(send.mock.calls.at(-1)).toEqual([3])
    scheduler.enqueue(4); scheduler.reset()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(send).toHaveBeenCalledTimes(2)
    scheduler.enqueue(8); scheduler.enqueue(16); scheduler.close()
    expect(scheduler.enqueue(32)).toBe(false)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(send).toHaveBeenCalledTimes(3)
  })
  it('replays a rejected final position after cooldown even when input has stopped', async () => {
    const send = vi.fn<(value: number) => boolean>(() => true)
    const scheduler = createWhiteboardRealtimeScheduler({ intervalMS: 50, now: () => Date.now(), send })
    scheduler.enqueue(7)
    scheduler.defer(1_000)
    await vi.advanceTimersByTimeAsync(999)
    expect(send).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(send.mock.calls).toEqual([[7], [7]])
    scheduler.close()
  })

})
