import { describe, expect, it } from 'vitest'
import { erosAvailableForRoute } from './programRoutePolicy'

describe('Eros route availability', () => {
  it.each(['/dashboard/programs', '/dashboard/programs/group-1', '/dashboard/programs/courses'])('does not expose Eros in %s', path => {
    expect(erosAvailableForRoute(path)).toBe(false)
  })
  it.each(['/dashboard', '/dashboard/events', '/dashboard/chats', '/dashboard/programs-other'])('preserves Eros outside Programas: %s', path => {
    expect(erosAvailableForRoute(path)).toBe(true)
  })
})
