export const OFFLINE_V3_ENABLE_MESSAGE = 'CLARIN_OFFLINE_V3_SET_ENABLED'
export const OFFLINE_V3_MODE_MESSAGE = 'CLARIN_OFFLINE_V3_SET_MODE'
export const OFFLINE_V3_ONLINE_REAUTH_MESSAGE = 'CLARIN_OFFLINE_V3_BEGIN_ONLINE_REAUTH'

async function postOfflineV3Message(payload: Record<string, unknown>, timeoutMs: number) {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return false
  const registration = await navigator.serviceWorker.getRegistration('/')
  const worker = registration?.active || registration?.waiting || registration?.installing || navigator.serviceWorker.controller
  if (!worker) return false
  const channel = new MessageChannel()
  return new Promise<boolean>((resolve) => {
    let settled = false
    let timer = 0
    const finish = (result: boolean) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      channel.port1.close()
      resolve(result)
    }
    timer = window.setTimeout(() => finish(false), timeoutMs)
    channel.port1.onmessage = (event) => finish(event.data?.ok === true)
    worker.postMessage(payload, [channel.port2])
  })
}

export async function setOfflineV3NavigationEnabled(enabled: boolean) {
  // First enable verifies and stores the complete public shell (including the
  // lazy whiteboard viewer). Disabling remains a small metadata operation.
  return postOfflineV3Message({ type: OFFLINE_V3_ENABLE_MESSAGE, enabled }, enabled ? 60_000 : 2_000)
}

export function setOfflineV3Mode(mode: 'offline' | 'online') {
  return postOfflineV3Message({ type: OFFLINE_V3_MODE_MESSAGE, mode }, 2_000)
}

export function beginOfflineV3OnlineReauth() {
  return postOfflineV3Message({ type: OFFLINE_V3_ONLINE_REAUTH_MESSAGE }, 2_000)
}
