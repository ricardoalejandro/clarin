export const PWA_CACHE_PREFIX = 'clarin-pwa-'

export function pwaCacheName(buildVersion = process.env.NEXT_PUBLIC_BUILD_VERSION || 'dev') {
  return `${PWA_CACHE_PREFIX}${buildVersion}`
}

export function chunkRecoverySessionKey(buildVersion = process.env.NEXT_PUBLIC_BUILD_VERSION || 'dev') {
  return `clarin:chunk-recovery:${buildVersion}`
}
