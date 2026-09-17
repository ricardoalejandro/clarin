const BUILD_ID = "2026.09.14-1-235507698122867-d420a6bea1a5";
const CACHE_PREFIX = "clarin-pwa-";
const CACHE_NAME = "clarin-pwa-2026.09.14-1-235507698122867-d420a6bea1a5";
const V3_CACHE_PREFIX = "clarin-offline-v3-shell-";
const V3_CACHE_NAME = "clarin-offline-v3-shell-2026.09.14-1-235507698122867-d420a6bea1a5";
const META_CACHE_NAME = "clarin-offline-v3-meta-v1";
const STATIC_FETCH_TIMEOUT_MS = 10000;
const NAVIGATION_TIMEOUT_MS = 5000;
const MAX_V3_SHELL_BYTES = 32 * 1024 * 1024;
const V3_PRECACHE_CONCURRENCY = 6;
const META_REQUEST = '/offline-v3/.runtime-meta.json';
const READY_REQUEST = '/offline-v3/.ready.json';
const MANIFEST_URL = '/offline-v3/manifest.json';
const FALLBACK_SHELL = '/offline';
const BASE_ASSETS = [FALLBACK_SHELL, '/favicon.svg', '/icons/clarin-192.png', '/icons/clarin-512.png', '/icons/clarin-maskable-512.png'];
let v3StagePromise;
let metaUpdatePromise = Promise.resolve();

function fetchWithTimeout(request, cacheMode, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || STATIC_FETCH_TIMEOUT_MS);
  return fetch(request, { cache: cacheMode, credentials: 'omit', signal: controller.signal }).finally(() => clearTimeout(timer));
}

function fetchNavigationWithTimeout(request) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NAVIGATION_TIMEOUT_MS);
  // Preserve the navigation Request credentials. Dropping the online cookie here
  // could turn a healthy authenticated route into a false offline fallback.
  return fetch(request, { cache: 'no-cache', signal: controller.signal }).finally(() => clearTimeout(timer));
}

function hex(bytes) {
  return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
}

async function sha256(response) {
  return hex(await crypto.subtle.digest('SHA-256', await response.arrayBuffer()));
}

async function forEachConcurrent(items, concurrency, worker) {
  let next = 0;
  let cancelled = false;
  let failure;
  async function run() {
    while (!cancelled && next < items.length) {
      const index = next++;
      try {
        await worker(items[index]);
      } catch (error) {
        cancelled = true;
        if (!failure) failure = error;
      }
    }
  }
  // Do not expose or delete a shared staging cache until every in-flight fetch
  // has settled. Promise.all would reject early while sibling workers write.
  await Promise.allSettled(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
  if (failure) throw failure;
}

async function readMeta() {
  const cache = await caches.open(META_CACHE_NAME);
  const response = await cache.match(META_REQUEST);
  if (!response) return { enabled: false, mode: 'online', online_transition: false, shell_generations: [], pwa_generations: [] };
  try {
    const parsed = await response.json();
    return {
      enabled: parsed.enabled === true,
      mode: parsed.mode === 'offline' ? 'offline' : 'online',
      online_transition: parsed.online_transition === true,
      shell_generations: Array.isArray(parsed.shell_generations) ? parsed.shell_generations.filter(value => typeof value === 'string').slice(0, 2) : [],
      pwa_generations: Array.isArray(parsed.pwa_generations) ? parsed.pwa_generations.filter(value => typeof value === 'string').slice(0, 2) : [],
    };
  } catch (_) {
    // Corrupt metadata is not authority to resume a stale online identity.
    return { enabled: false, mode: 'offline', online_transition: false, shell_generations: [], pwa_generations: [] };
  }
}

async function writeMeta(next) {
  const cache = await caches.open(META_CACHE_NAME);
  await cache.put(META_REQUEST, new Response(JSON.stringify(next), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }));
}

function updateMeta(change) {
  const updated = metaUpdatePromise.then(async () => {
    const next = change(await readMeta());
    await writeMeta(next);
    return next;
  });
  metaUpdatePromise = updated.catch(() => {});
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
  await cache.put(READY_REQUEST, new Response(JSON.stringify({ build_id: BUILD_ID }), { headers: { 'Content-Type': 'application/json' } }));
}

function validManifestAsset(asset, origin) {
  if (!asset || typeof asset.url !== 'string' || typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256)) return false;
  if (!Number.isSafeInteger(asset.bytes) || asset.bytes < 0 || asset.bytes > MAX_V3_SHELL_BYTES) return false;
  const url = new URL(asset.url, origin);
  return url.origin === origin && url.pathname.startsWith('/offline-v3/') && !url.pathname.startsWith('/api/');
}

async function stageV3Shell() {
  const manifestResponse = await fetchWithTimeout(MANIFEST_URL, 'reload');
  if (!manifestResponse.ok || !(manifestResponse.headers.get('content-type') || '').includes('application/json')) throw new Error('offline-v3 manifest unavailable');
  const manifestHash = await sha256(manifestResponse.clone());
  const manifest = await manifestResponse.clone().json();
  if (manifest.protocol_version !== 3 || manifest.build_id !== BUILD_ID || manifest.app_origin !== self.location.origin || manifest.shell !== '/offline-v3/index.html' || !Array.isArray(manifest.assets)) throw new Error('offline-v3 manifest rejected');
  if (!manifest.assets.every(asset => validManifestAsset(asset, self.location.origin))) throw new Error('offline-v3 asset allowlist rejected');
  const totalBytes = manifest.assets.reduce((sum, asset) => sum + asset.bytes, 0);
  if (totalBytes <= 0 || totalBytes > MAX_V3_SHELL_BYTES) throw new Error('offline-v3 shell budget rejected');
  const finalCacheName = V3_CACHE_NAME + '-' + manifestHash.slice(0, 16);
  const existing = await caches.open(finalCacheName);
  const existingReady = await existing.match(READY_REQUEST);
  if (existingReady) {
    try {
      const marker = await existingReady.json();
      if (marker.manifest_hash === manifestHash && marker.build_id === BUILD_ID) return finalCacheName;
    } catch (_) {}
  }
  const stagingCacheName = finalCacheName + '-staging';
  await caches.delete(stagingCacheName);
  const cache = await caches.open(stagingCacheName);
  try {
    await forEachConcurrent(manifest.assets, V3_PRECACHE_CONCURRENCY, async asset => {
      const response = await fetchWithTimeout(asset.url, 'reload');
      if (!response.ok || Number(response.headers.get('content-length') || asset.bytes) > asset.bytes + 1024) throw new Error('offline-v3 asset fetch rejected');
      if (await sha256(response.clone()) !== asset.sha256) throw new Error('offline-v3 asset integrity rejected');
      await cache.put(asset.url, response);
    });
    await cache.put(MANIFEST_URL, manifestResponse);
    const ready = { build_id: BUILD_ID, built_at: manifest.built_at, total_bytes: totalBytes, manifest_hash: manifestHash };
    await cache.put(READY_REQUEST, new Response(JSON.stringify(ready), { headers: { 'Content-Type': 'application/json' } }));

    // CacheStorage has no rename primitive. Copy a fully verified staging cache and
    // publish READY last; activation never points at an incomplete generation.
    await caches.delete(finalCacheName);
    const finalCache = await caches.open(finalCacheName);
    const requests = await cache.keys();
    for (const request of requests.filter(request => new URL(request.url).pathname !== READY_REQUEST)) {
      const response = await cache.match(request);
      if (!response) throw new Error('offline-v3 staging copy incomplete');
      await finalCache.put(request, response);
    }
    await finalCache.put(READY_REQUEST, new Response(JSON.stringify(ready), { headers: { 'Content-Type': 'application/json' } }));
    await caches.delete(stagingCacheName);
    return finalCacheName;
  } catch (error) {
    await Promise.allSettled([caches.delete(stagingCacheName), caches.delete(finalCacheName)]);
    throw error;
  }
}

function ensureV3Shell() {
  if (!v3StagePromise) {
    v3StagePromise = stageV3Shell().finally(() => { v3StagePromise = undefined; });
  }
  return v3StagePromise;
}

self.addEventListener('install', event => {
  // The large v3 shell is prepared only for an authorized browser. Ordinary
  // Clarin users should not download the offline corpus during every SW update.
  event.waitUntil(cacheBaseShell());
  // Never skip waiting: a populated page keeps the build that rendered it.
});

async function commitGenerations(installedV3Generation) {
  const committed = await updateMeta(previous => ({ ...previous,
    shell_generations: installedV3Generation
      ? [installedV3Generation, ...previous.shell_generations.filter(name => name !== installedV3Generation)].slice(0, 2)
      : previous.shell_generations.slice(0, 2),
    pwa_generations: [CACHE_NAME, ...previous.pwa_generations.filter(name => name !== CACHE_NAME)].slice(0, 2),
  }));
  const shellGenerations = committed.shell_generations;
  const pwaGenerations = committed.pwa_generations;
  const keep = new Set([...shellGenerations, ...pwaGenerations, META_CACHE_NAME]);
  const keys = await caches.keys();
  await Promise.all(keys.filter(key => (key.startsWith(V3_CACHE_PREFIX) || key.startsWith(CACHE_PREFIX)) && !keep.has(key)).map(key => caches.delete(key)));
}

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const meta = await readMeta();
    let generation;
    if (meta.enabled) {
      try { generation = await ensureV3Shell(); } catch (_) {
        // Keep the last verified generation. A failed update must not destroy
        // an already prepared offline entry point.
      }
    }
    await commitGenerations(generation);
  })());
});

self.addEventListener('message', event => {
  if (!event.data) return;
  if (event.data.type === 'CLARIN_OFFLINE_V3_SET_ENABLED' && typeof event.data.enabled === 'boolean') {
    event.waitUntil((async () => {
      const port = event.ports && event.ports[0];
      try {
        if (event.data.enabled) {
          const generation = await ensureV3Shell();
          // Publish a verified generation before making normal routes eligible
          // for offline fallback. On failure the previous disabled state wins.
          await commitGenerations(generation);
        }
        await updateMeta(meta => ({ ...meta, enabled: event.data.enabled }));
        if (port) port.postMessage({ ok: true });
      } catch (_) {
        if (port) port.postMessage({ ok: false, error: 'offline_shell_unavailable' });
      }
    })());
    return;
  }
  if (event.data.type === 'CLARIN_OFFLINE_V3_SET_MODE' || event.data.type === 'CLARIN_OFFLINE_V3_BEGIN_ONLINE_REAUTH') {
    event.waitUntil((async () => {
      const port = event.ports && event.ports[0];
      try {
        if (event.data.type === 'CLARIN_OFFLINE_V3_BEGIN_ONLINE_REAUTH') {
          await updateMeta(meta => ({ ...meta, online_transition: true }));
        } else {
          const mode = event.data.mode;
          if (mode !== 'offline' && mode !== 'online') throw new Error('invalid mode');
          if (mode === 'offline' && !(await matchAcrossGenerations('/offline-v3/index.html', 'v3'))) throw new Error('verified shell unavailable');
          await updateMeta(meta => {
            if (mode === 'offline' && !meta.enabled) throw new Error('offline not prepared');
            if (mode === 'online' && meta.mode === 'offline' && !meta.online_transition) throw new Error('explicit reauthentication required');
            return { ...meta, mode, online_transition: false };
          });
        }
        if (port) port.postMessage({ ok: true });
      } catch (_) {
        if (port) port.postMessage({ ok: false, error: 'offline_mode_transition_rejected' });
      }
    })());
    return;
  }
  if (event.data.type === 'CLARIN_OFFLINE_V3_USE_PREVIOUS') {
    event.waitUntil(updateMeta(meta => {
      if (meta.shell_generations.length < 2) return meta;
      return { ...meta, shell_generations: [meta.shell_generations[1], meta.shell_generations[0]] };
    }));
  }
});

async function matchReady(cacheName, request) {
  const cache = await caches.open(cacheName);
  if (!(await cache.match(READY_REQUEST))) return undefined;
  return cache.match(request);
}

async function matchAcrossGenerations(request, kind) {
  const meta = await readMeta();
  const generations = kind === 'v3' ? meta.shell_generations : meta.pwa_generations;
  for (const cacheName of generations) {
    const response = await matchReady(cacheName, request);
    if (response) return response;
  }
  return undefined;
}

function isSupportedV3Navigation(pathname) {
  if (/^\/$/.test(pathname) || /^\/(?:login|dashboard)\/?$/.test(pathname)) return true;
  if (/^\/dashboard\/(?:tasks|contacts|programs|whiteboards|conflicts)\/?$/.test(pathname)) return true;
  return /^\/dashboard\/(?:programs|whiteboards)\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/?$/i.test(pathname);
}

function isInfrastructureFailure(response) {
  if (response.status >= 500) return true;
  if ((response.headers.get('CF-Mitigated') || '').toLowerCase() === 'challenge') return true;
  return [403, 408, 429].includes(response.status) && response.headers.get('X-Clarin-Response') !== '1';
}

function isAccountNavigation(pathname) {
  return pathname === '/' || pathname === '/login' || pathname === '/login/' || pathname === '/dashboard' || pathname.startsWith('/dashboard/');
}

async function offlineNavigation(request) {
  const meta = await readMeta();
  const url = new URL(request.url);
  if (meta.enabled && (isSupportedV3Navigation(url.pathname) || meta.mode === 'offline' && isAccountNavigation(url.pathname))) {
    const shell = await matchAcrossGenerations('/offline-v3/index.html', 'v3');
    if (shell) {
      const headers = new Headers(shell.headers);
      headers.set('Cache-Control', 'no-store');
      headers.set('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self' http://127.0.0.1:17373; font-src 'self' data:; worker-src 'self'; frame-src 'none'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      headers.set('Referrer-Policy', 'no-referrer');
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('X-Frame-Options', 'DENY');
      return new Response(shell.body, { status: shell.status, statusText: shell.statusText, headers });
    }
  }
  return (await matchAcrossGenerations(FALLBACK_SHELL, 'pwa')) || Response.error();
}

async function networkFirstNavigation(request) {
  const url = new URL(request.url);
  const meta = await readMeta();
  const explicitLogin = url.pathname === '/login' && meta.online_transition &&
    (url.searchParams.get('offline_reauth') === '1' || url.searchParams.get('offline_fresh_login') === '1');
  // A restored connection or a browser reload cannot pick an old cookie's
  // actor. The public latch grants no access: the local vault still locks on
  // close and requires the exact authorized user's credentials again.
  if (meta.mode === 'offline' && isAccountNavigation(url.pathname) && !explicitLogin) return offlineNavigation(request);
  if (url.searchParams.get('offline') === '1') return offlineNavigation(request);
  try {
    const response = await fetchNavigationWithTimeout(request);
    if (!isInfrastructureFailure(response)) return response;
  } catch (_) {}
  return offlineNavigation(request);
}

async function fetchPublicAsset(request, kind) {
  const cached = await matchAcrossGenerations(request, kind);
  if (cached) return cached;
  try {
    const response = await fetchWithTimeout(request, 'default');
    if (response.ok) return response;
  } catch (_) {}
  return Response.error();
}

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate') { event.respondWith(networkFirstNavigation(request)); return; }
  if (url.pathname.startsWith('/offline-v3/')) { event.respondWith(fetchPublicAsset(request, 'v3')); return; }
  if (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/icons/') || url.pathname === '/favicon.svg') event.respondWith(fetchPublicAsset(request, 'pwa'));
});
