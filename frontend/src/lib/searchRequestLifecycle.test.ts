import { describe, expect, it } from 'vitest'

import { SearchRequestLifecycle } from './searchRequestLifecycle'

describe('SearchRequestLifecycle', () => {
  it('aborts and invalidates the preceding request as soon as input changes', () => {
    const lifecycle = new SearchRequestLifecycle()
    const first = lifecycle.begin()

    lifecycle.invalidate()

    expect(first.signal.aborted).toBe(true)
    expect(lifecycle.isCurrent(first)).toBe(false)
  })

  it('rejects a stale completion even when a transport ignores abort', () => {
    const lifecycle = new SearchRequestLifecycle()
    const first = lifecycle.begin()
    const second = lifecycle.begin()

    expect(lifecycle.isCurrent(first)).toBe(false)
    expect(lifecycle.isCurrent(second)).toBe(true)
    expect(lifecycle.finish(first)).toBe(false)
    expect(lifecycle.finish(second)).toBe(true)
  })
})
