import { describe, expect, it } from 'vitest'
import { chunkRecoverySessionKey, pwaCacheName, PWA_CACHE_PREFIX } from './pwaCache'

describe('PWA cache identity', () => {
  it('names caches with the Clarin prefix and build version', () => {
    expect(pwaCacheName('2026.08.07-141530-c967995')).toBe(`${PWA_CACHE_PREFIX}2026.08.07-141530-c967995`)
  })

  it('scopes the one-time recovery marker to the build', () => {
    expect(chunkRecoverySessionKey('build-a')).not.toBe(chunkRecoverySessionKey('build-b'))
    expect(chunkRecoverySessionKey('build-a')).toBe('clarin:chunk-recovery:build-a')
  })
})
