import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)

test('runtime pins the same official Node LTS image for build and execution', () => {
  const dockerfile = readFileSync(new URL('../../deploy/Dockerfile.frontend', import.meta.url), 'utf8')
  const images = [...dockerfile.matchAll(/^FROM (\S+) AS (?:builder|runner)$/gm)].map(match => match[1])
  assert.equal(images.length, 2)
  assert.equal(images[0], images[1])
  assert.match(images[0], /^node:24\.21\.0-alpine@sha256:[a-f0-9]{64}$/)
})

test('non-root runtime keeps private-mode public assets readable without granting ownership', () => {
  const dockerfile = readFileSync(new URL('../../deploy/Dockerfile.frontend', import.meta.url), 'utf8')
  assert.match(dockerfile, /^COPY --from=builder \/app\/public \.\/public$/m)
  assert.match(dockerfile, /^RUN chmod -R a\+rX \/app\/public/m)
  assert.match(dockerfile, /^USER node\nCMD \["node", "server\.js"\]/m)
  assert.ok(dockerfile.indexOf('chmod -R a+rX /app/public') < dockerfile.indexOf('USER node'))
})

test('direct browser-offline v5 artifacts are no-store, unframeable, and same-origin only', async () => {
  const nextConfig = require('../next.config.js')
  const rules = await nextConfig.headers()
  const v5 = rules.find(rule => rule.source === '/offline-v5/:path*')
  assert.ok(v5, 'missing /offline-v5/:path* security headers')
  const headers = Object.fromEntries(v5.headers.map(header => [header.key.toLowerCase(), header.value]))
  assert.equal(headers['cache-control'], 'no-store, no-cache, must-revalidate, proxy-revalidate')
  assert.equal(headers['x-frame-options'], 'DENY')
  assert.equal(headers['x-content-type-options'], 'nosniff')
  assert.equal(headers['referrer-policy'], 'no-referrer')
  assert.match(headers['content-security-policy'], /default-src 'none'/)
  assert.match(headers['content-security-policy'], /connect-src 'self'/)
  assert.doesNotMatch(headers['content-security-policy'], /127\.0\.0\.1/)
})

test('login is no-store and permits only the official Turnstile script and frame origin', async () => {
  const nextConfig = require('../next.config.js')
  const rules = await nextConfig.headers()
  for (const source of ['/', '/login']) {
    const rule = rules.find(candidate => candidate.source === source)
    assert.ok(rule, `missing ${source} security headers`)
    const headers = Object.fromEntries(rule.headers.map(header => [header.key.toLowerCase(), header.value]))
    assert.equal(headers['cache-control'], 'no-store, no-cache, must-revalidate, proxy-revalidate')
    assert.match(headers['content-security-policy'], /script-src-elem 'self' 'unsafe-inline' https:\/\/challenges\.cloudflare\.com/)
    assert.match(headers['content-security-policy'], /frame-src https:\/\/challenges\.cloudflare\.com/)
    assert.match(headers['content-security-policy'], /connect-src 'self' https:\/\/challenges\.cloudflare\.com/)
    assert.doesNotMatch(headers['content-security-policy'], /https:\/\/\*/)
  }
})

test('Mermaid conversion stays on the patched Excalidraw release and compatible local renderer', () => {
  assert.equal(require('@excalidraw/mermaid-to-excalidraw/package.json').version, '2.2.2')
  assert.equal(require('mermaid/package.json').version, '11.16.1')
})

for (const name of ['lodash', 'lodash-es']) {
  test(`${name}: blocks prototype traversal and template import injection`, async () => {
    const module = await import(name)
    const api = module.default || module
    const marker = '__clarin_dependency_qa__'
    Object.defineProperty(Object.prototype, marker, { value: 'preserved', configurable: true })
    try {
      for (const path of [
        ['__proto__', marker], ['constructor', 'prototype', marker],
        `__proto__.${marker}`, `constructor.prototype.${marker}`,
      ]) {
        assert.equal(api.unset({}, path), false)
        assert.equal(Object.prototype[marker], 'preserved')
      }
      const record = { nested: { title: 'normal' } }
      assert.equal(api.unset(record, ['nested', 'title']), true)
      assert.deepEqual(record, { nested: {} })
      assert.throws(() => api.template('hello', {
        imports: { 'qa = (globalThis.__clarinInjected = true)': {} },
      }), /Invalid.*imports/)
      assert.equal(globalThis.__clarinInjected, undefined)
      assert.equal(api.template('<%= label %>', { imports: { label: 'Clarin' } })({}), 'Clarin')
    } finally {
      delete Object.prototype[marker]
      delete globalThis.__clarinInjected
    }
  })
}

for (const [name, resolver] of [
  ['editor/postcss CJS 3.x', require],
  ['Mermaid ESM 5.x', createRequire(require.resolve('@excalidraw/mermaid-to-excalidraw'))],
  ['DOCX ESM 5.x', createRequire(require.resolve('docx'))],
]) {
  test(`nanoid ${name}: negative/zero sizes terminate; normal IDs remain valid`, () => {
    // Keep a future regression from hanging the complete test worker.
    const script = `
      import assert from 'node:assert/strict';
      import { nanoid, customAlphabet } from ${JSON.stringify(pathToFileURL(resolver.resolve('nanoid/non-secure')).href)};
      import { nanoid as secure, customAlphabet as secureAlphabet } from ${JSON.stringify(pathToFileURL(resolver.resolve('nanoid')).href)};
      assert.equal(nanoid(-1), '');
      assert.equal(customAlphabet('abc', -1)(), '');
      assert.equal(secureAlphabet('abc', 0)(), '');
      assert.equal(secure(40).length, 40);
      assert.equal(new Set(Array.from({length: 100}, () => secure())).size, 100);
    `
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      timeout: 5000, encoding: 'utf8',
    })
    assert.equal(result.error, undefined, result.error?.message)
    assert.equal(result.status, 0, result.stderr)
  })
}
