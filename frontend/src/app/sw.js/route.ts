import { PWA_CACHE_PREFIX, pwaCacheName } from '@/lib/pwaCache'

const CACHE_NAME = pwaCacheName()

export const dynamic = 'force-dynamic'

export function GET() {
  const source = `
const CACHE_PREFIX = ${JSON.stringify(PWA_CACHE_PREFIX)};
const CACHE_NAME = ${JSON.stringify(CACHE_NAME)};
const STATIC_FETCH_TIMEOUT_MS = 10000;
const SHELL_ASSETS = [
  '/offline',
  '/icons/clarin-192.png',
  '/icons/clarin-512.png',
  '/icons/clarin-maskable-512.png'
];

function fetchWithTimeout(request, cacheMode) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STATIC_FETCH_TIMEOUT_MS);
  return fetch(request, { cache: cacheMode, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

async function cacheShell() {
  const cache = await caches.open(CACHE_NAME);
  const results = await Promise.all(SHELL_ASSETS.map(async asset => {
    try {
      const response = await fetchWithTimeout(asset, 'reload');
      if (!response.ok) return false;
      await cache.put(asset, response);
      return true;
    } catch (_) {
      return false;
    }
  }));
  if (!results.every(Boolean)) throw new Error('PWA shell precache incomplete');
}

self.addEventListener('install', event => {
  event.waitUntil(cacheShell());
  // Keep the current page on its current worker. It will adopt this worker on
  // a later navigation, avoiding a mid-session build/cache mismatch.
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys
        .filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
        .map(key => caches.delete(key))))
  );
});

async function fetchStaticAsset(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetchWithTimeout(request, 'default');
    if (response.ok) {
      await cache.put(request, response.clone()).catch(() => {});
      return response;
    }
  } catch (_) {
    // Retry once with a network revalidation after a timeout or network error.
  }

  try {
    const retry = await fetchWithTimeout(request, 'reload');
    if (retry.ok) {
      await cache.put(request, retry.clone()).catch(() => {});
      return retry;
    }
  } catch (_) {
    // Return a bounded failure instead of leaving the browser request pending.
  }

  return Response.error();
}

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetchWithTimeout(request, 'no-cache').catch(async () => {
      const cache = await caches.open(CACHE_NAME);
      return (await cache.match('/offline')) || Response.error();
    }));
    return;
  }

  if (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(fetchStaticAsset(request));
  }
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
