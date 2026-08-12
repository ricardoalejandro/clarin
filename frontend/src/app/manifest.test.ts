import { describe, expect, it } from 'vitest'
import manifest from './manifest'

describe('PWA manifest', () => {
  it('opens the authenticated dashboard in standalone mode with installable icons', () => {
    const value = manifest()
    expect(value.start_url).toBe('/dashboard')
    expect(value.scope).toBe('/')
    expect(value.display).toBe('standalone')
    expect(value.icons).toEqual(expect.arrayContaining([
      expect.objectContaining({ src: '/icons/clarin-192.png', sizes: '192x192', purpose: 'any' }),
      expect.objectContaining({ src: '/icons/clarin-512.png', sizes: '512x512', purpose: 'any' }),
      expect.objectContaining({ src: '/icons/clarin-maskable-512.png', sizes: '512x512', purpose: 'maskable' }),
    ]))
  })
})
