declare const __CLARIN_OFFLINE_BUILD__: string
export {}

const recoveryKey = `clarin:offline-v4-recovery:${__CLARIN_OFFLINE_BUILD__}`
let handling = false

function isRuntimeAssetFailure(event: ErrorEvent | PromiseRejectionEvent) {
  if (event instanceof ErrorEvent && event.target instanceof HTMLScriptElement) return event.target.src.includes('/offline-v4/assets/')
  const candidate = event instanceof PromiseRejectionEvent ? event.reason : event.error || event.message
  const message = typeof candidate === 'string' ? candidate : candidate?.message || ''
  return /ChunkLoadError|dynamically imported module|Importing a module script failed|Failed to fetch/i.test(message)
}

function showSafeRecovery() {
  const root = document.getElementById('clarin-offline-root') || document.body
  root.innerHTML = '<main style="min-height:100vh;display:grid;place-items:center;padding:24px;background:#f8fafc;font-family:Inter,system-ui,sans-serif;color:#0f172a"><section style="width:min(100%,420px);padding:28px;border:1px solid #dbe3ee;border-radius:20px;background:white;box-shadow:0 24px 70px rgba(15,23,42,.12);text-align:center"><img src="/favicon.svg" alt="Clarin" style="width:48px;height:48px;border-radius:14px"><h1 style="margin:16px 0 0;font-size:20px">No se pudo abrir la copia local</h1><p style="margin:9px 0 18px;color:#64748b;font-size:14px;line-height:1.55">Conservamos la versión anterior y todos los datos cifrados. Reintenta o espera a recuperar conexión.</p><button id="clarin-offline-retry" style="width:100%;min-height:44px;border:0;border-radius:12px;background:#059669;color:white;font-weight:700">Reintentar</button></section></main>'
  document.getElementById('clarin-offline-retry')?.addEventListener('click', () => {
    sessionStorage.removeItem(recoveryKey)
    window.location.reload()
  })
}

function recover(event: ErrorEvent | PromiseRejectionEvent) {
  if (handling || !isRuntimeAssetFailure(event)) return
  handling = true
  event.preventDefault()
  if (sessionStorage.getItem(recoveryKey) === '1') {
    sessionStorage.removeItem(recoveryKey)
    showSafeRecovery()
    return
  }
  sessionStorage.setItem(recoveryKey, '1')
  navigator.serviceWorker.controller?.postMessage({ type: 'CLARIN_OFFLINE_V4_USE_PREVIOUS' })
  window.setTimeout(() => window.location.reload(), 150)
}

window.addEventListener('error', recover, true)
window.addEventListener('unhandledrejection', recover)
window.setTimeout(() => sessionStorage.removeItem(recoveryKey), 15_000)
