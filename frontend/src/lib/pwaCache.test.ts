import { describe, expect, it } from 'vitest'
import {
  chunkRecoverySessionKey,
  offlineV3ShellCacheName,
  offlineV5ShellCacheName,
  pwaCacheName,
  OFFLINE_V3_META_CACHE,
  OFFLINE_V3_SHELL_CACHE_PREFIX,
  OFFLINE_V5_META_CACHE,
  OFFLINE_V5_SHELL_CACHE_PREFIX,
  PWA_CACHE_PREFIX,
} from './pwaCache'

describe('PWA cache identity', () => {
  it('names caches with the Clarin prefix and build version', () => {
    expect(pwaCacheName('2026.08.07-141530-c967995')).toBe(`${PWA_CACHE_PREFIX}2026.08.07-141530-c967995`)
  })

  it('scopes the one-time recovery marker to the build', () => {
    expect(chunkRecoverySessionKey('build-a')).not.toBe(chunkRecoverySessionKey('build-b'))
    expect(chunkRecoverySessionKey('build-a')).toBe('clarin:chunk-recovery:build-a')
  })

  it('keeps the public v3 shell and its non-private generation pointer separate', () => {
    expect(offlineV3ShellCacheName('build-a')).toBe(`${OFFLINE_V3_SHELL_CACHE_PREFIX}build-a`)
    expect(OFFLINE_V3_META_CACHE).not.toContain('account')
    expect(OFFLINE_V3_META_CACHE).not.toContain('user')
  })

  it('keeps the browser-only v5 application shell account-neutral', () => {
    expect(offlineV5ShellCacheName('build-a')).toBe(`${OFFLINE_V5_SHELL_CACHE_PREFIX}build-a`)
    expect(OFFLINE_V5_META_CACHE).not.toContain('account')
    expect(OFFLINE_V5_META_CACHE).not.toContain('user')
  })
})
