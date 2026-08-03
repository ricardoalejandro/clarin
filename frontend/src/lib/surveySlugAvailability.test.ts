import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSurveySlugAvailabilityController } from './surveySlugAvailability'

afterEach(() => vi.useRealTimers())

describe('createSurveySlugAvailabilityController', () => {
  it('waits exactly 500ms and aborts an obsolete request', async () => {
    vi.useFakeTimers()
    const signals: AbortSignal[] = []
    const request = vi.fn(async (_slug: string, signal: AbortSignal) => { signals.push(signal); return true })
    const onResult = vi.fn()
    const controller = createSurveySlugAvailabilityController({ request, onPending: vi.fn(), onResult, onError: vi.fn() })

    controller.check('primero')
    await vi.advanceTimersByTimeAsync(499)
    expect(request).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(request).toHaveBeenCalledTimes(1)

    controller.check('segundo')
    expect(signals[0].aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(500)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('discards a late completion after a newer value was scheduled', async () => {
    vi.useFakeTimers()
    let resolveFirst!: (value: boolean) => void
    const request = vi.fn((slug: string) => slug === 'primero'
      ? new Promise<boolean>(resolve => { resolveFirst = resolve })
      : Promise.resolve(false))
    const onResult = vi.fn()
    const controller = createSurveySlugAvailabilityController({ request, onPending: vi.fn(), onResult, onError: vi.fn() })
    controller.check('primero')
    await vi.advanceTimersByTimeAsync(500)
    controller.check('segundo')
    resolveFirst(true)
    await Promise.resolve()
    expect(onResult).not.toHaveBeenCalledWith(true)
    await vi.advanceTimersByTimeAsync(500)
    expect(onResult).toHaveBeenLastCalledWith(false)
  })
})
