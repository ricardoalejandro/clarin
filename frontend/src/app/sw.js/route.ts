import {
  OFFLINE_V4_META_CACHE,
  OFFLINE_V4_SHELL_CACHE_PREFIX,
  OFFLINE_V5_META_CACHE,
  OFFLINE_V5_SHELL_CACHE_PREFIX,
  PWA_CACHE_PREFIX,
  offlineV4ShellCacheName,
  offlineV5ShellCacheName,
  pwaCacheName,
} from '@/lib/pwaCache'

const BUILD_ID = process.env.NEXT_PUBLIC_BUILD_VERSION || 'dev'
const CACHE_NAME = pwaCacheName(BUILD_ID)
const V4_CACHE_NAME = offlineV4ShellCacheName(BUILD_ID)
const V5_CACHE_NAME = offlineV5ShellCacheName(BUILD_ID)

const BASE_OFFLINE_FALLBACK_HTML = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <title>Clarin · Sin conexión</title>
  <style>
    :root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    *{box-sizing:border-box}body{min-height:100vh;min-height:100dvh;margin:0;display:grid;place-items:center;padding:1rem;background:#020617;color:#f1f5f9}
    main{width:min(100%,28rem);overflow:hidden;border:1px solid #334155;border-radius:1.5rem;background:#0f172a;box-shadow:0 28px 80px #0006}
    section{padding:2rem;background:radial-gradient(circle at top right,#10b9812e,transparent 48%)}
    strong{display:block;color:#6ee7b7;font-size:.75rem;letter-spacing:.14em;text-transform:uppercase}h1{margin:1.75rem 0 .5rem;font-size:1.5rem;color:#fff}p{margin:0;color:#94a3b8;line-height:1.6}
    footer{padding:1.5rem}a{min-height:2.75rem;display:flex;align-items:center;justify-content:center;border-radius:.75rem;background:#10b981;color:#022c22;font-weight:700;text-decoration:none}a:focus-visible{outline:2px solid #6ee7b7;outline-offset:3px}
  </style>
</head>
<body><main><section><strong>Clarin · Acceso web</strong><h1>Estás sin conexión</h1><p>No hay una copia offline preparada para este navegador. Cuando vuelva la conexión, entra en Configuración → Offline para prepararla.</p></section><footer><a href="/login?offline_fresh_login=1">Intentar de nuevo</a></footer></main></body>
</html>`

export const dynamic = 'force-dynamic'

export function GET() {
  const source = `
const BUILD_ID = ${JSON.stringify(BUILD_ID)};
const CACHE_PREFIX = ${JSON.stringify(PWA_CACHE_PREFIX)};
const CACHE_NAME = ${JSON.stringify(CACHE_NAME)};
const V4_CACHE_PREFIX = ${JSON.stringify(OFFLINE_V4_SHELL_CACHE_PREFIX)};
const V4_CACHE_NAME = ${JSON.stringify(V4_CACHE_NAME)};
const V4_META_CACHE = ${JSON.stringify(OFFLINE_V4_META_CACHE)};
const V5_CACHE_PREFIX = ${JSON.stringify(OFFLINE_V5_SHELL_CACHE_PREFIX)};
const V5_CACHE_NAME = ${JSON.stringify(V5_CACHE_NAME)};
const V5_META_CACHE = ${JSON.stringify(OFFLINE_V5_META_CACHE)};
const STATIC_FETCH_TIMEOUT_MS = 10000;
const NAVIGATION_TIMEOUT_MS = 5000;
const PRECACHE_CONCURRENCY = 6;
const FALLBACK_SHELL = '/offline';
const BASE_OFFLINE_FALLBACK_HTML = ${JSON.stringify(BASE_OFFLINE_FALLBACK_HTML)};
const BASE_READY_REQUEST = '/offline/.ready.json';
const BASE_ASSETS = ['/favicon.svg', '/icons/apple-touch-icon.png', '/icons/clarin-192.png', '/icons/clarin-512.png', '/icons/clarin-maskable-512.png'];
const WHITEBOARD_ENGINE = '0.18.1-clarin.7';
const ROUTE_SHELLS = Object.freeze({
  login: { document: '/offline-v5/routes/login.html', flight: '/offline-v5/routes/login.rsc' },
  dashboard: { document: '/offline-v5/routes/dashboard.html', flight: '/offline-v5/routes/dashboard.rsc' },
  tasks: { document: '/offline-v5/routes/tasks.html', flight: '/offline-v5/routes/tasks.rsc' },
  contacts: { document: '/offline-v5/routes/contacts.html', flight: '/offline-v5/routes/contacts.rsc' },
  programs: { document: '/offline-v5/routes/programs.html', flight: '/offline-v5/routes/programs.rsc' },
  whiteboards: { document: '/offline-v5/routes/whiteboards.html', flight: '/offline-v5/routes/whiteboards.rsc' },
  program_detail: { document: '/offline-v5/routes/program_detail.html', flight: '/offline-v5/routes/program_detail.rsc' },
  whiteboard_detail: { document: '/offline-v5/routes/whiteboard_detail.html', flight: '/offline-v5/routes/whiteboard_detail.rsc' },
});
const SPECS = Object.freeze({
  v4: { protocol: 4, manifest: '/offline-v4/manifest.json', ready: '/offline-v4/.ready.json', cacheBase: V4_CACHE_NAME, cachePrefix: V4_CACHE_PREFIX, metaCache: V4_META_CACHE, metaRequest: '/offline-v4/.runtime-meta.json', maximumBytes: 32 * 1024 * 1024, worker: '/offline-v4/worker.js' },
  v5: { protocol: 5, manifest: '/offline-v5/manifest.json', ready: '/offline-v5/.ready.json', cacheBase: V5_CACHE_NAME, cachePrefix: V5_CACHE_PREFIX, metaCache: V5_META_CACHE, metaRequest: '/offline-v5/.runtime-meta.json', maximumBytes: 64 * 1024 * 1024, worker: '/offline-v5/worker.js' },
});
const stagePromises = { v4: undefined, v5: undefined };
const metaUpdatePromises = { v4: Promise.resolve(), v5: Promise.resolve() };

function fetchWithTimeout(request, cacheMode, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || STATIC_FETCH_TIMEOUT_MS);
  return fetch(request, { cache: cacheMode, credentials: 'omit', signal: controller.signal }).finally(() => clearTimeout(timer));
}

function fetchNavigationWithTimeout(request) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NAVIGATION_TIMEOUT_MS);
  // Preserve the authenticated online cookie. Public shell downloads are the
  // only requests made with credentials omitted.
  return fetch(request, { cache: 'no-cache', signal: controller.signal }).finally(() => clearTimeout(timer));
}

function hex(bytes) {
  return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
}

async function readBoundedBody(response, maximum, exact, label) {
  const reader = response.body && response.body.getReader();
  if (!reader) {
    if (exact && maximum !== 0) throw new Error(label + ' empty asset');
    return new Uint8Array(0);
  }
  const chunks = [];
  let length = 0;
  let expired = false;
  const timer = setTimeout(() => { expired = true; void reader.cancel().catch(() => {}); }, STATIC_FETCH_TIMEOUT_MS);
  try {
    while (true) {
      const next = await reader.read();
      if (expired) throw new Error(label + ' asset body timeout');
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximum) throw new Error(label + ' asset body budget rejected');
      chunks.push(next.value);
    }
    if (exact && length !== maximum) throw new Error(label + ' asset length rejected');
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function sha256(bytes) {
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}

function verifiedResponse(response, bytes) {
  const headers = new Headers(response.headers);
  headers.delete('content-encoding');
  headers.set('content-length', String(bytes.byteLength));
  headers.set('x-content-type-options', 'nosniff');
  return new Response(bytes, { status: response.status, statusText: response.statusText, headers });
}

async function forEachConcurrent(items, concurrency, worker) {
  let next = 0;
  let cancelled = false;
  let failure;
  async function run() {
    while (!cancelled && next < items.length) {
      const index = next++;
      try { await worker(items[index]); }
      catch (error) { cancelled = true; if (!failure) failure = error; }
    }
  }
  await Promise.allSettled(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
  if (failure) throw failure;
}

function defaultMeta() {
  return { enabled: false, mode: 'online', online_transition: false, online_transition_expires_at: 0, fallback_offer: false, shell_generations: [], pwa_generations: [] };
}

const ONLINE_TRANSITION_TTL_MS = 120000;

function transitionOpen(meta, kind, now = Date.now()) {
  if (!meta || meta.online_transition !== true) return false;
  if (kind !== 'v5') return true;
  const expires = Number(meta.online_transition_expires_at);
  return Number.isSafeInteger(expires) && expires > now && expires <= now + ONLINE_TRANSITION_TTL_MS;
}

async function readMeta(kind) {
  const spec = SPECS[kind];
  const response = await (await caches.open(spec.metaCache)).match(spec.metaRequest);
  if (!response) return defaultMeta();
  try {
    const parsed = await response.json();
    return {
      enabled: parsed.enabled === true,
      mode: parsed.mode === 'offline' ? 'offline' : 'online',
      online_transition: transitionOpen(parsed, kind),
      online_transition_expires_at: transitionOpen(parsed, kind) ? Number(parsed.online_transition_expires_at || 0) : 0,
      fallback_offer: parsed.fallback_offer === true,
      shell_generations: Array.isArray(parsed.shell_generations) ? parsed.shell_generations.filter(value => typeof value === 'string').slice(0, 2) : [],
      pwa_generations: Array.isArray(parsed.pwa_generations) ? parsed.pwa_generations.filter(value => typeof value === 'string').slice(0, 2) : [],
    };
  } catch (_) {
    // Corrupt public metadata is never authority to unlock private data.
    return { ...defaultMeta(), mode: 'offline' };
  }
}

async function writeMeta(kind, next) {
  const spec = SPECS[kind];
  const cache = await caches.open(spec.metaCache);
  await cache.put(spec.metaRequest, new Response(JSON.stringify(next), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }));
}

function updateMeta(kind, change) {
  const updated = metaUpdatePromises[kind].then(async () => {
    const next = change(await readMeta(kind));
    await writeMeta(kind, next);
    return next;
  });
  metaUpdatePromises[kind] = updated.catch(() => {});
  return updated;
}

async function cacheBaseShell() {
  const cache = await caches.open(CACHE_NAME);
  const results = await Promise.all(BASE_ASSETS.map(async asset => {
    try {
      const response = await fetchWithTimeout(asset, 'reload');
      if (!response.ok || asset.startsWith('/api/')) return false;
      await cache.put(asset, response);
      return true;
    } catch (_) { return false; }
  }));
  if (!results.every(Boolean)) throw new Error('PWA shell precache incomplete');
  // Never cache a network navigation response as the public fallback. Even a
  // credentialless response may be personalized by an intermediary or by
  // server-side context. This literal contains no account or identity data.
  await cache.put(FALLBACK_SHELL, new Response(BASE_OFFLINE_FALLBACK_HTML, { headers: {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  } }));
  await cache.put(BASE_READY_REQUEST, new Response(JSON.stringify({ build_id: BUILD_ID }), { headers: { 'Content-Type': 'application/json' } }));
}

function validV5Path(pathname) {
  if (pathname.startsWith('/offline-v5/') || pathname.startsWith('/_next/static/')) return true;
  if (pathname.startsWith('/vendor/whiteboards-editor/' + WHITEBOARD_ENGINE + '/')) return true;
  return ['/favicon.ico', '/favicon.svg', '/icons/apple-touch-icon.png', '/icons/clarin-192.png', '/icons/clarin-512.png', '/icons/clarin-maskable-512.png', '/icons/clarin-maskable.svg', '/pdf.worker.min.mjs'].includes(pathname);
}

function validManifestAsset(asset, kind) {
  const spec = SPECS[kind];
  if (!asset || typeof asset.url !== 'string' || typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256)) return false;
  if (!Number.isSafeInteger(asset.bytes) || asset.bytes < 0 || asset.bytes > spec.maximumBytes) return false;
  if (typeof asset.content_type !== 'string' || asset.content_type.length > 128) return false;
  const url = new URL(asset.url, self.location.origin);
  if (url.origin !== self.location.origin || url.search || url.hash || url.username || url.password || url.pathname.startsWith('/api/')) return false;
  return kind === 'v4' ? url.pathname.startsWith('/offline-v4/') : validV5Path(url.pathname);
}

function validV5Manifest(manifest) {
  if (manifest.whiteboard_engine !== WHITEBOARD_ENGINE || manifest.worker !== SPECS.v5.worker || manifest.app_manifest !== '/offline-v5/app.webmanifest') return false;
  if (!manifest.shell || typeof manifest.shell !== 'object') return false;
  const expected = Object.keys(ROUTE_SHELLS);
  if (Object.keys(manifest.shell).length !== expected.length) return false;
  return expected.every(key => manifest.shell[key] && manifest.shell[key].document === ROUTE_SHELLS[key].document && manifest.shell[key].flight === ROUTE_SHELLS[key].flight);
}

async function stageShell(kind) {
  const spec = SPECS[kind];
  const manifestResponse = await fetchWithTimeout(spec.manifest, 'reload');
  if (!manifestResponse.ok || !(manifestResponse.headers.get('content-type') || '').includes('application/json')) throw new Error(kind + ' manifest unavailable');
  const manifestBytes = await readBoundedBody(manifestResponse, 512 * 1024, false, kind);
  const manifestHash = await sha256(manifestBytes);
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  if (manifest.protocol_version !== spec.protocol || manifest.build_id !== BUILD_ID || manifest.app_origin !== self.location.origin || !Array.isArray(manifest.assets)) throw new Error(kind + ' manifest rejected');
  if (kind === 'v4' && manifest.shell !== '/offline-v4/index.html') throw new Error('v4 shell rejected');
  if (kind === 'v5' && !validV5Manifest(manifest)) throw new Error('v5 canonical shell rejected');
  if (manifest.assets.length > 2500 || manifest.assets.length < 3 || !manifest.assets.every(asset => validManifestAsset(asset, kind))) throw new Error(kind + ' asset allowlist rejected');
  const paths = new Set(manifest.assets.map(asset => new URL(asset.url, self.location.origin).pathname));
  const required = kind === 'v4' ? [manifest.shell, spec.worker] : [spec.worker, manifest.app_manifest, ...Object.values(ROUTE_SHELLS).flatMap(route => [route.document, route.flight])];
  if (paths.size !== manifest.assets.length || !required.every(path => paths.has(path))) throw new Error(kind + ' required assets missing or duplicated');
  const totalBytes = manifest.assets.reduce((sum, asset) => sum + asset.bytes, 0);
  if (totalBytes <= 0 || totalBytes > spec.maximumBytes) throw new Error(kind + ' shell budget rejected');
  const finalName = spec.cacheBase + '-' + manifestHash.slice(0, 16);
  const existing = await caches.open(finalName);
  const existingReady = await existing.match(spec.ready);
  if (existingReady) {
    try {
      const marker = await existingReady.json();
      if (marker.manifest_hash === manifestHash && marker.build_id === BUILD_ID) return finalName;
    } catch (_) {}
  }
  const stagingName = finalName + '-staging';
  await caches.delete(stagingName);
  const staging = await caches.open(stagingName);
  try {
    await forEachConcurrent(manifest.assets, PRECACHE_CONCURRENCY, async asset => {
      const response = await fetchWithTimeout(asset.url, 'reload');
      if (!response.ok || Number(response.headers.get('content-length') || asset.bytes) > asset.bytes + 1024) throw new Error(kind + ' asset fetch rejected');
      const bytes = await readBoundedBody(response, asset.bytes, true, kind);
      if (await sha256(bytes) !== asset.sha256) throw new Error(kind + ' asset integrity rejected');
      await staging.put(asset.url, verifiedResponse(response, bytes));
    });
    await staging.put(spec.manifest, verifiedResponse(manifestResponse, manifestBytes));
    const ready = { protocol_version: spec.protocol, build_id: BUILD_ID, built_at: manifest.built_at, total_bytes: totalBytes, manifest_hash: manifestHash };
    await staging.put(spec.ready, new Response(JSON.stringify(ready), { headers: { 'Content-Type': 'application/json' } }));
    await caches.delete(finalName);
    const finalCache = await caches.open(finalName);
    const requests = await staging.keys();
    for (const request of requests.filter(item => new URL(item.url).pathname !== spec.ready)) {
      const response = await staging.match(request);
      if (!response) throw new Error(kind + ' staging copy incomplete');
      await finalCache.put(request, response);
    }
    // CacheStorage cannot rename; publishing READY last makes activation atomic.
    await finalCache.put(spec.ready, new Response(JSON.stringify(ready), { headers: { 'Content-Type': 'application/json' } }));
    await caches.delete(stagingName);
    return finalName;
  } catch (error) {
    await Promise.allSettled([caches.delete(stagingName), caches.delete(finalName)]);
    throw error;
  }
}

function ensureShell(kind) {
  if (!stagePromises[kind]) stagePromises[kind] = stageShell(kind).finally(() => { stagePromises[kind] = undefined; });
  return stagePromises[kind];
}

async function commitGeneration(kind, installed) {
  return updateMeta(kind, previous => ({ ...previous,
    shell_generations: installed ? [installed, ...previous.shell_generations.filter(name => name !== installed)].slice(0, 2) : previous.shell_generations.slice(0, 2),
    pwa_generations: [CACHE_NAME, ...previous.pwa_generations.filter(name => name !== CACHE_NAME)].slice(0, 2),
  }));
}

async function cleanupGenerations() {
  const [v4, v5] = await Promise.all([readMeta('v4'), readMeta('v5')]);
  const keep = new Set([...v4.shell_generations, ...v5.shell_generations, ...v4.pwa_generations, ...v5.pwa_generations, V4_META_CACHE, V5_META_CACHE]);
  const keys = await caches.keys();
  await Promise.all(keys.filter(key => (key.startsWith(V4_CACHE_PREFIX) || key.startsWith(V5_CACHE_PREFIX) || key.startsWith(CACHE_PREFIX)) && !keep.has(key)).map(key => caches.delete(key)));
}

async function onlyLoginWindowsAreOpen() {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return windows.length === 0 || windows.every(client => routeKey(new URL(client.url).pathname) === 'login');
}

self.addEventListener('install', event => {
  // Ordinary users receive only the tiny public PWA fallback. The verified
  // application corpus is downloaded after an authorized user prepares it.
  // A previous worker may otherwise remain waiting forever behind a cached
  // login document, leaving that document's offline CSP in force. Promote an
  // update only when every visible Clarin window is a login/root page; an open
  // dashboard keeps the normal safe waiting behavior so pending offline work
  // and a running authenticated UI are never interrupted by a deployment.
  event.waitUntil((async () => {
    await cacheBaseShell();
    if (await onlyLoginWindowsAreOpen()) await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const kind of ['v4', 'v5']) {
      const meta = await readMeta(kind);
      let generation;
      if (meta.enabled) {
        try { generation = await ensureShell(kind); } catch (_) {}
      }
      await commitGeneration(kind, generation);
    }
    await cleanupGenerations();
  })());
});

async function setEnabled(kind, enabled) {
  if (enabled) {
    const generation = await ensureShell(kind);
    await commitGeneration(kind, generation);
  }
  await updateMeta(kind, meta => ({ ...meta, enabled, fallback_offer: enabled ? meta.fallback_offer : false }));
  await cleanupGenerations();
}

async function matchReady(cacheName, request, kind) {
  const cache = await caches.open(cacheName);
  if (!(await cache.match(SPECS[kind].ready))) return undefined;
  return cache.match(request);
}

async function matchAcrossGenerations(request, kind) {
  const meta = await readMeta(kind);
  for (const cacheName of meta.shell_generations) {
    const response = await matchReady(cacheName, request, kind);
    if (response) return response;
  }
  return undefined;
}

async function matchBase(request) {
  for (const cacheName of (await readMeta('v5')).pwa_generations) {
    const cache = await caches.open(cacheName);
    if (!(await cache.match(BASE_READY_REQUEST))) continue;
    const response = await cache.match(request);
    if (response) return response;
  }
  return undefined;
}

async function setMode(kind, mode) {
  if (mode !== 'offline' && mode !== 'online') throw new Error('invalid mode');
  const proof = kind === 'v5' ? ROUTE_SHELLS.login.document : '/offline-v4/index.html';
  if (mode === 'offline' && !(await matchAcrossGenerations(proof, kind))) throw new Error('verified shell unavailable');
  await updateMeta(kind, meta => {
    if (mode === 'offline' && !meta.enabled) throw new Error('offline not prepared');
    if (mode === 'online' && meta.mode === 'offline' && !transitionOpen(meta, kind)) throw new Error('explicit reauthentication required');
    return { ...meta, mode, online_transition: false, online_transition_expires_at: 0, fallback_offer: false };
  });
}

async function beginOnlineTransition(kind) {
  await updateMeta(kind, meta => {
    if (kind === 'v5' && (!meta.enabled || meta.mode !== 'offline')) throw new Error('offline session required');
    return { ...meta, online_transition: true, online_transition_expires_at: kind === 'v5' ? Date.now() + ONLINE_TRANSITION_TTL_MS : 0 };
  });
}

async function clearLocalAuthority(kind) {
  await updateMeta(kind, meta => ({
    ...meta,
    enabled: false,
    mode: 'online',
    online_transition: false,
    online_transition_expires_at: 0,
    fallback_offer: false,
    shell_generations: [],
  }));
  await cleanupGenerations();
}

self.addEventListener('message', event => {
  const data = event.data;
  if (!data || typeof data.type !== 'string') return;
  const v5 = data.type.includes('_V5_');
  const v4 = data.type.includes('_V4_');
  if (!v4 && !v5) return;
  const kind = v5 ? 'v5' : 'v4';
  const port = event.ports && event.ports[0];
  const reply = (ok, extra) => { if (port) port.postMessage({ ok, ...(extra || {}) }); };
  if (data.type.endsWith('_SET_ENABLED') && typeof data.enabled === 'boolean') {
    event.waitUntil(setEnabled(kind, data.enabled).then(() => reply(true)).catch(() => reply(false, { error: 'offline_shell_unavailable' })));
    return;
  }
  if (data.type.endsWith('_SET_MODE')) {
    event.waitUntil(setMode(kind, data.mode).then(() => reply(true)).catch(() => reply(false, { error: 'offline_mode_transition_rejected' })));
    return;
  }
  if (data.type.endsWith('_BEGIN_ONLINE_REAUTH')) {
    event.waitUntil(beginOnlineTransition(kind).then(() => reply(true)).catch(() => reply(false)));
    return;
  }
  if (data.type === 'CLARIN_OFFLINE_V5_CLEAR_LOCAL_AUTHORITY') {
    event.waitUntil(clearLocalAuthority(kind).then(() => reply(true)).catch(() => reply(false, { error: 'offline_authority_cleanup_failed' })));
    return;
  }
  if (data.type.endsWith('_CLEAR_FALLBACK_OFFER')) {
    event.waitUntil(updateMeta(kind, meta => ({ ...meta, fallback_offer: false })).then(() => reply(true)).catch(() => reply(false)));
    return;
  }
  if (data.type.endsWith('_GET_STATUS')) {
    event.waitUntil(readMeta(kind).then(meta => reply(true, { meta })).catch(() => reply(false)));
    return;
  }
  if (data.type.endsWith('_USE_PREVIOUS')) {
    event.waitUntil(updateMeta(kind, meta => meta.shell_generations.length < 2 ? meta : ({ ...meta, shell_generations: [meta.shell_generations[1], meta.shell_generations[0]] })).then(() => reply(true)).catch(() => reply(false)));
  }
});

function isAccountNavigation(pathname) {
  return pathname === '/' || pathname === '/login' || pathname === '/login/' || pathname === '/dashboard' || pathname.startsWith('/dashboard/');
}

function routeKey(pathname) {
  if (pathname === '/' || /^\\/login\\/?$/.test(pathname)) return 'login';
  if (/^\\/dashboard\\/?$/.test(pathname)) return 'dashboard';
  for (const key of ['tasks', 'contacts', 'programs', 'whiteboards']) {
    if (pathname === '/dashboard/' + key || pathname === '/dashboard/' + key + '/') return key;
  }
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
  if (new RegExp('^/dashboard/programs/' + uuid + '/?$', 'i').test(pathname)) return 'program_detail';
  if (new RegExp('^/dashboard/whiteboards/' + uuid + '/?$', 'i').test(pathname)) return 'whiteboard_detail';
  return undefined;
}

function isInfrastructureFailure(response) {
  if (response.status >= 500) return true;
  if ((response.headers.get('CF-Mitigated') || '').toLowerCase() === 'challenge') return true;
  return [403, 408, 429].includes(response.status) && response.headers.get('X-Clarin-Response') !== '1';
}

function securedShellResponse(response, route, flight) {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Clarin-Offline', '1');
  headers.set('X-Clarin-Offline-Route', route);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  if (flight) {
    headers.set('Content-Type', 'text/x-component; charset=utf-8');
  } else {
    headers.set('Content-Type', 'text/html; charset=utf-8');
    headers.set('X-Frame-Options', 'DENY');
    headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:; worker-src 'self' blob:; child-src 'self' blob:; frame-src 'self'; media-src 'self' blob:; manifest-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function offlineV5Route(request, flight) {
  const key = routeKey(new URL(request.url).pathname);
  if (!key) return undefined;
  const artifact = flight ? ROUTE_SHELLS[key].flight : ROUTE_SHELLS[key].document;
  const response = await matchAcrossGenerations(artifact, 'v5');
  return response ? securedShellResponse(response, key, flight) : undefined;
}

async function offlineNavigation(request, reason) {
  const v5 = await readMeta('v5');
  if (v5.enabled) {
    if (reason === 'infrastructure') await updateMeta('v5', meta => ({ ...meta, fallback_offer: true }));
    const response = await offlineV5Route(request, false);
    if (response) return response;
  }
  const v4 = await readMeta('v4');
  if (v4.enabled && (isAccountNavigation(new URL(request.url).pathname) || v4.mode === 'offline')) {
    const shell = await matchAcrossGenerations('/offline-v4/index.html', 'v4');
    if (shell) return securedShellResponse(shell, 'v4-recovery', false);
  }
  return (await matchBase(FALLBACK_SHELL)) || Response.error();
}

async function networkFirstNavigation(request) {
  const url = new URL(request.url);
  const [v5, v4] = await Promise.all([readMeta('v5'), readMeta('v4')]);
  const loginNavigation = routeKey(url.pathname) === 'login';
  const explicitLogin = url.pathname === '/login' && ((transitionOpen(v5, 'v5') || transitionOpen(v4, 'v4')) && (url.searchParams.get('offline_reauth') === '1' || url.searchParams.get('offline_fresh_login') === '1'));
  // The login document is always network-first, even while a prepared copy
  // keeps the dashboard in offline mode. Otherwise a stale browser-wide v4/v5
  // latch can serve the strict offline CSP on every ordinary F5 and block
  // Turnstile until Ctrl+F5 bypasses this worker. A real network, origin or
  // Cloudflare failure still falls through to the verified cached login.
  if (!loginNavigation && !explicitLogin && v5.mode === 'offline' && isAccountNavigation(url.pathname)) return offlineNavigation(request, 'mode');
  if (!loginNavigation && !explicitLogin && v4.mode === 'offline' && isAccountNavigation(url.pathname)) return offlineNavigation(request, 'mode');
  if (url.searchParams.get('offline') === '1') return offlineNavigation(request, 'explicit');
  try {
    const response = await fetchNavigationWithTimeout(request);
    if (!isInfrastructureFailure(response)) {
      if (v5.fallback_offer) void updateMeta('v5', meta => ({ ...meta, fallback_offer: false }));
      return response;
    }
  } catch (_) {}
  return offlineNavigation(request, 'infrastructure');
}

function isFlightRequest(request, url) {
  return request.headers.get('RSC') === '1' || url.searchParams.has('_rsc');
}

async function networkFirstFlight(request) {
  const meta = await readMeta('v5');
  const url = new URL(request.url);
  if (meta.mode === 'offline' && routeKey(url.pathname) !== 'login') return (await offlineV5Route(request, true)) || Response.error();
  try {
    const response = await fetchNavigationWithTimeout(request);
    if (!isInfrastructureFailure(response)) return response;
  } catch (_) {}
  if (meta.enabled) {
    await updateMeta('v5', current => ({ ...current, fallback_offer: true }));
    return (await offlineV5Route(request, true)) || Response.error();
  }
  return Response.error();
}

async function fetchPublicAsset(request, kind) {
  const cached = kind === 'pwa' ? await matchBase(request) : await matchAcrossGenerations(request, kind);
  if (cached) return cached;
  try {
    const response = await fetchWithTimeout(request, 'default');
    if (response.ok) return response;
  } catch (_) {}
  return Response.error();
}

function offlineV5NetworkAPIAllowed(request, url, meta) {
  const method = request.method.toUpperCase();
  if (method === 'GET' && url.pathname === '/api/offline/v5/lease-keys') return true;
  if (method === 'POST' && url.pathname === '/api/offline/v5/grants/status') return true;
  if (method === 'POST' && (url.pathname === '/api/offline/v5/sync/challenge' || url.pathname === '/api/offline/v5/sync')) return true;
  if (!transitionOpen(meta, 'v5')) return false;
  return method === 'GET' && url.pathname === '/api/public/security-config'
    || method === 'POST' && (url.pathname === '/api/auth/login' || url.pathname === '/api/auth/logout');
}

async function protectOfflineV5API(request) {
  const meta = await readMeta('v5');
  if (meta.mode !== 'offline') return fetch(request);
  const url = new URL(request.url);
  if (offlineV5NetworkAPIAllowed(request, url, meta)) return fetch(request);
  return new Response(JSON.stringify({
    success: false,
    error: 'offline_network_blocked',
    message: 'Esta solicitud de red está bloqueada mientras Clarin usa la copia offline.',
    offline: true,
  }), {
    status: 503,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Clarin-Offline': '5',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // The page adapter serves the selected local records without touching the
  // network. This service-worker boundary additionally blocks XHR, sendBeacon
  // and any future transport that might bypass the patched fetch function.
  if (url.pathname.startsWith('/api/')) { event.respondWith(protectOfflineV5API(request)); return; }
  if (request.method !== 'GET') return;
  if (url.pathname.startsWith('/vendor/whiteboards-editor/' + WHITEBOARD_ENGINE + '/')) { event.respondWith(fetchPublicAsset(request, 'v5')); return; }
  if (url.pathname === '/manifest.webmanifest') { event.respondWith(fetchPublicAsset('/offline-v5/app.webmanifest', 'v5')); return; }
  if (request.mode === 'navigate') { event.respondWith(networkFirstNavigation(request)); return; }
  if (isFlightRequest(request, url) && routeKey(url.pathname)) { event.respondWith(networkFirstFlight(request)); return; }
  if (url.pathname.startsWith('/offline-v5/') || url.pathname.startsWith('/_next/static/') || url.pathname === '/pdf.worker.min.mjs') { event.respondWith(fetchPublicAsset(request, 'v5')); return; }
  if (url.pathname.startsWith('/offline-v4/')) { event.respondWith(fetchPublicAsset(request, 'v4')); return; }
  if (url.pathname.startsWith('/icons/') || url.pathname === '/favicon.svg') event.respondWith(fetchPublicAsset(request, 'pwa'));
});
`.trim()

  return new Response(source, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Service-Worker-Allowed': '/',
    },
  })
}
