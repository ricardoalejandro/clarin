import { PWA_CACHE_PREFIX } from './pwaCache'

export function isChunkLoadError(error: unknown): boolean {
  if (!error) return false
  const candidate = typeof error === 'object' ? error as { name?: unknown; message?: unknown } : {}
  const name = typeof candidate.name === 'string' ? candidate.name : ''
  const message = typeof error === 'string'
    ? error
    : typeof candidate.message === 'string' ? candidate.message : ''
  return name === 'ChunkLoadError' || /ChunkLoadError|Loading (?:chunk|CSS chunk) .* failed/i.test(`${name} ${message}`)
}

export function buildChunkRecoveryScript(buildVersion: string): string {
  const buildToken = JSON.stringify(buildVersion || 'dev')
  const cachePrefixToken = JSON.stringify(PWA_CACHE_PREFIX)

  return `
(function() {
  var cachePrefix = ${cachePrefixToken};
  var recoveryKey = 'clarin:chunk-recovery:' + ${buildToken};
  var handlingFailure = false;

  function isChunkFailure(value) {
    var name = value && typeof value.name === 'string' ? value.name : '';
    var message = typeof value === 'string'
      ? value
      : value && typeof value.message === 'string' ? value.message : '';
    return name === 'ChunkLoadError' || /ChunkLoadError|Loading (?:chunk|CSS chunk) .* failed/i.test(name + ' ' + message);
  }

  function readRecoveryMarker() {
    try { return window.sessionStorage.getItem(recoveryKey) === '1'; } catch (_) { return false; }
  }

  function writeRecoveryMarker() {
    try { window.sessionStorage.setItem(recoveryKey, '1'); } catch (_) {}
  }

  function removeRecoveryMarker() {
    try { window.sessionStorage.removeItem(recoveryKey); } catch (_) {}
  }

  function clearPwaState() {
    var tasks = [];
    if ('caches' in window) {
      tasks.push(window.caches.keys().then(function(keys) {
        return Promise.all(keys.filter(function(key) { return key.indexOf(cachePrefix) === 0; }).map(function(key) {
          return window.caches.delete(key);
        }));
      }).catch(function() {}));
    }
    if ('serviceWorker' in navigator) {
      tasks.push(navigator.serviceWorker.getRegistrations().then(function(registrations) {
        return Promise.all(registrations.filter(function(registration) {
          var workers = [registration.active, registration.waiting, registration.installing].filter(Boolean);
          var urls = workers.map(function(worker) { return worker.scriptURL; });
          return registration.scope === window.location.origin + '/' && urls.some(function(url) { return /\\/sw\\.js(?:$|\\?)/.test(url); });
        }).map(function(registration) { return registration.unregister(); }));
      }).catch(function() {}));
    }
    return Promise.race([
      Promise.all(tasks),
      new Promise(function(resolve) { window.setTimeout(resolve, 1500); }),
    ]);
  }

  function showRecoveryScreen() {
    if (!document.body) {
      window.addEventListener('DOMContentLoaded', showRecoveryScreen, { once: true });
      return;
    }
    document.body.innerHTML = '<main style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:#f8fafc;font-family:Inter,system-ui,sans-serif;color:#0f172a"><section style="width:min(100%,420px);padding:28px;border:1px solid #e2e8f0;border-radius:18px;background:white;box-shadow:0 18px 45px rgba(15,23,42,.12);text-align:center"><div style="width:48px;height:48px;margin:0 auto 16px;border-radius:14px;background:#059669;color:white;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:20px">C</div><h1 style="margin:0;font-size:20px">Clarin necesita actualizarse</h1><p style="margin:10px 0 20px;color:#64748b;font-size:14px;line-height:1.6">No se pudo cargar una parte de la aplicación. Pulsa reintentar para limpiar la copia local y volver a abrir Clarin.</p><button id="clarin-chunk-retry" type="button" style="width:100%;min-height:44px;border:0;border-radius:12px;background:#059669;color:white;font-weight:700;cursor:pointer">Reintentar</button></section></main>';
    var button = document.getElementById('clarin-chunk-retry');
    if (button) button.addEventListener('click', function() {
      removeRecoveryMarker();
      window.location.reload();
    });
  }

  function recoverFromChunkFailure() {
    if (handlingFailure) return;
    handlingFailure = true;
    if (readRecoveryMarker()) {
      removeRecoveryMarker();
      showRecoveryScreen();
      return;
    }
    writeRecoveryMarker();
    clearPwaState().then(function() { window.location.reload(); }, function() { window.location.reload(); });
  }

  function handleFailure(event) {
    var value = event && 'reason' in event ? event.reason : event && (event.error || event.message);
    if (!isChunkFailure(value)) return;
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    recoverFromChunkFailure();
  }

  window.addEventListener('error', handleFailure, true);
  window.addEventListener('unhandledrejection', handleFailure);
  try {
    if (window.sessionStorage.getItem(recoveryKey) === '1') {
      window.setTimeout(removeRecoveryMarker, 15000);
    }
  } catch (_) {}
})();
`.trim()
}
