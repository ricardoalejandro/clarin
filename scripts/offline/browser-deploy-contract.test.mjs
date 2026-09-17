import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = file => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');

test('browser deployment does not require a native installer', () => {
  const make = read('Makefile');
  assert.match(make, /\ndeploy:\n/);
  assert.doesNotMatch(make, /\ndeploy:.*offline-artifact-check/);
  assert.ok(make.indexOf('if [ "$$OFFLINE_V3_ENABLED" = "true" ]') < make.indexOf('release-artifact.mjs freeze'));
  const pkg = JSON.parse(read('frontend/package.json'));
  assert.match(pkg.scripts.build, /build:offline-v4/);
  assert.doesNotMatch(pkg.scripts.build, /build:offline-v3/);
});

test('offline proof bodies have a dedicated bounded edge route', () => {
  const compose = read('docker-compose.yml');
  assert.ok(compose.includes('Path(`/{offline:(?i:api/(?:offline/v4|admin/offline-v4)(?:/.*)?)}`)'));
  assert.match(compose, /clarin-offline-v4-limit\.buffering\.maxRequestBodyBytes=2097152/);
  assert.match(compose, /clarin-offline-v4-limit\.buffering\.memRequestBodyBytes=65536/);
  assert.match(compose, /clarin-offline-v4\.middlewares=clarin-offline-v4-limit/);
  assert.ok(compose.includes('PathRegexp(`(?i)^/api/(offline/v5|admin/offline-v5)(/.*)?$`)'));
  assert.match(compose, /clarin-offline-v5-limit\.buffering\.maxRequestBodyBytes=2097152/);
  assert.match(compose, /clarin-offline-v5-limit\.buffering\.memRequestBodyBytes=65536/);
  assert.match(compose, /clarin-offline-v5\.middlewares=clarin-offline-v5-limit/);
  const fileProvider = read('infra/offline/traefik-browser-v4.yml');
  assert.ok(fileProvider.includes('PathRegexp(`(?i)^/api/(offline/v5|admin/offline-v5)(/.*)?$`)'));
  assert.match(fileProvider, /clarin-offline-v5-file-limit/);
  const make = read('Makefile');
  assert.match(make, /node scripts\/offline\/install-browser-proxy\.mjs/);
  assert.ok(make.indexOf('node scripts/offline/install-browser-proxy.mjs') < make.indexOf('docker compose up -d offline-signer'));
});

test('v4 bundles have same-origin-only connections and exact worker build identity', () => {
  const builder = read('frontend/scripts/build-offline-v4.mjs');
  assert.doesNotMatch(builder, /127\.0\.0\.1:17373/);
  assert.ok(builder.includes("connect-src 'self'"));
  assert.equal((builder.match(/__CLARIN_OFFLINE_BUILD__:/g) || []).length, 2);
});
