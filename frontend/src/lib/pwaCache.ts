export const PWA_CACHE_PREFIX = 'clarin-pwa-'
export const OFFLINE_V3_SHELL_CACHE_PREFIX = 'clarin-offline-v3-shell-'
export const OFFLINE_V3_META_CACHE = 'clarin-offline-v3-meta-v1'
export const OFFLINE_V4_SHELL_CACHE_PREFIX = 'clarin-offline-v4-shell-'
export const OFFLINE_V4_META_CACHE = 'clarin-offline-v4-meta-v1'
export const OFFLINE_V5_SHELL_CACHE_PREFIX = 'clarin-offline-v5-shell-'
export const OFFLINE_V5_META_CACHE = 'clarin-offline-v5-meta-v1'

export function offlineV4ShellCacheName(buildVersion = process.env.NEXT_PUBLIC_BUILD_VERSION || 'dev') {
  return `${OFFLINE_V4_SHELL_CACHE_PREFIX}${buildVersion}`
}

export function offlineV5ShellCacheName(buildVersion = process.env.NEXT_PUBLIC_BUILD_VERSION || 'dev') {
  return `${OFFLINE_V5_SHELL_CACHE_PREFIX}${buildVersion}`
}

export function pwaCacheName(buildVersion = process.env.NEXT_PUBLIC_BUILD_VERSION || 'dev') {
  return `${PWA_CACHE_PREFIX}${buildVersion}`
}

export function offlineV3ShellCacheName(buildVersion = process.env.NEXT_PUBLIC_BUILD_VERSION || 'dev') {
  return `${OFFLINE_V3_SHELL_CACHE_PREFIX}${buildVersion}`
}

export function chunkRecoverySessionKey(buildVersion = process.env.NEXT_PUBLIC_BUILD_VERSION || 'dev') {
  return `clarin:chunk-recovery:${buildVersion}`
}
