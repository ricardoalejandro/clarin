import { describe, expect, it } from 'vitest'
import { resolveOperationalWindowMode } from './useOperationalWindow'

describe('resolveOperationalWindowMode', () => {
  it('uses a temporary maximized mode without changing the preferred mode', () => {
    const preferred = 'docked' as const
    expect(resolveOperationalWindowMode(false, preferred, 'maximized')).toBe('maximized')
    expect(preferred).toBe('docked')
  })

  it('always maximizes on mobile and restores the preferred desktop mode afterwards', () => {
    expect(resolveOperationalWindowMode(true, 'floating')).toBe('maximized')
    expect(resolveOperationalWindowMode(false, 'floating')).toBe('floating')
  })
})
