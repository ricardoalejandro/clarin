export const OFFLINE_V3_IDENTITY_CHANNEL = 'clarin-offline-v3-identity'

export function broadcastOfflineProfileEpoch(profileEpoch: number) {
  if (!Number.isSafeInteger(profileEpoch) || profileEpoch < 0 || typeof BroadcastChannel === 'undefined') return
  const channel = new BroadcastChannel(OFFLINE_V3_IDENTITY_CHANNEL)
  try {
    channel.postMessage({ profile_epoch: profileEpoch })
  } finally {
    channel.close()
  }
}
