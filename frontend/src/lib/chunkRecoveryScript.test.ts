import { describe, expect, it } from 'vitest'
import { buildChunkRecoveryScript, isChunkLoadError } from './chunkRecoveryScript'

describe('chunk recovery', () => {
  it('recognizes webpack chunk failures without treating auth errors as chunk failures', () => {
    expect(isChunkLoadError({ name: 'ChunkLoadError', message: 'Loading chunk 2723 failed' })).toBe(true)
    expect(isChunkLoadError('Loading CSS chunk 12 failed')).toBe(true)
    expect(isChunkLoadError({ name: 'Error', message: '401 Unauthorized' })).toBe(false)
  })

  it('generates a bounded, one-reload recovery script for Clarin PWA state', () => {
    const source = buildChunkRecoveryScript('2026.08.07-141530-c967995')

    expect(() => new Function(source)).not.toThrow()
    expect(source).toContain('clarin-pwa-')
    expect(source).toContain('sessionStorage')
    expect(source).toContain('getRegistrations')
    expect(source).toContain("registration.scope === window.location.origin + '/'")
    expect(source).toContain('key.indexOf(cachePrefix) === 0')
    expect(source).toContain('window.setTimeout(resolve, 1500)')
    expect(source).toContain('window.location.reload()')
    expect(source).toContain('Clarin necesita actualizarse')
  })
})
