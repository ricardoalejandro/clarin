export const OFFLINE_V4_ENABLE_MESSAGE = 'CLARIN_OFFLINE_V4_SET_ENABLED'
export const OFFLINE_V4_MODE_MESSAGE = 'CLARIN_OFFLINE_V4_SET_MODE'
export const OFFLINE_V4_ONLINE_REAUTH_MESSAGE = 'CLARIN_OFFLINE_V4_BEGIN_ONLINE_REAUTH'

async function postOfflineV4Message(payload: Record<string, unknown>, timeoutMs: number) {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return false
  const registration = await navigator.serviceWorker.getRegistration('/')
  // A waiting worker does not yet control navigation. Its ACK cannot prove
  // that the currently open web pages can reopen the newly prepared shell.
  if (payload.type === OFFLINE_V4_ENABLE_MESSAGE && payload.enabled === true && registration?.waiting && registration.active) {
    throw new Error('Hay una actualización de Clarin pendiente. Guarda tu trabajo, cierra las pestañas de Clarin y vuelve a abrir la web para preparar el acceso offline. No necesitas instalar nada.')
  }
  const worker = registration?.active || navigator.serviceWorker.controller
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
    try { worker.postMessage(payload, [channel.port2]) } catch { finish(false) }
  })
}

export async function setOfflineV4NavigationEnabled(enabled: boolean) {
  // First enable verifies and stores the complete public shell (including the
  // lazy whiteboard viewer). Disabling remains a small metadata operation.
  return postOfflineV4Message({ type: OFFLINE_V4_ENABLE_MESSAGE, enabled }, enabled ? 60_000 : 2_000)
}

export function setOfflineV4Mode(mode: 'offline' | 'online') {
  return postOfflineV4Message({ type: OFFLINE_V4_MODE_MESSAGE, mode }, 2_000)
}

export function beginOfflineV4OnlineReauth() {
  return postOfflineV4Message({ type: OFFLINE_V4_ONLINE_REAUTH_MESSAGE }, 2_000)
}
