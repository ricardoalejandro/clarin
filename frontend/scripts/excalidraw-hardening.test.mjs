import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { hardenEditorBundle } from './excalidraw-hardening.mjs'

test('neutralizes external URLs in literals and dynamic template helpers', () => {
  const source = [
    'const docs = "https://docs.example.invalid/help";',
    'const video = (id) => `https://player.vimeo.com/video/${id}`;',
    'const playlist = (id) => `https://www.youtube.com/embed/videoseries?list=${id}`;',
  ].join('\n')
  const result = hardenEditorBundle(source, 'hardening-fixture.js')
  assert.doesNotMatch(result.hardened, /https?:\/\//i)
  assert.doesNotMatch(result.hardened, /(?:youtube|vimeo)\.com/i)
  assert.match(result.hardened, /about:blank#clarin-external-disabled/)
  assert.equal(result.disabledRoutes, 3)
})

test('keeps XML namespaces and rewrites the audited font fallback to an absolute same-origin URL', () => {
  const source = [
    'const svg = "http://www.w3.org/2000/svg";',
    'const pkg = { name: "@excalidraw/excalidraw", version: "0.18.1" };',
    'const fallback = `https://esm.sh/${pkg.name}@${pkg.version}/dist/prod/`;',
    'const fontURL = (asset) => new URL(asset, fallback).href;',
  ].join('\n')
  const result = hardenEditorBundle(source, 'hardening-local-fixture.js')
  assert.match(result.hardened, /http:\/\/www\.w3\.org\/2000\/svg/)
  assert.match(result.hardened, /\/vendor\/whiteboards-editor\/0\.18\.1\//)
  assert.doesNotMatch(result.hardened, /\/dist\/prod\//)
  assert.equal(result.localFallbacks, 1)
  const resolveFont = new Function(
    'globalThis',
    `${result.hardened}\nreturn fontURL("fonts/Excalifont/Excalifont-Regular.woff2")`,
  )
  assert.equal(
    resolveFont({ location: { origin: 'https://clarin.example.invalid' } }),
    'https://clarin.example.invalid/vendor/whiteboards-editor/0.18.1/fonts/Excalifont/Excalifont-Regular.woff2',
  )
})

test('repairs bundles already transformed with the former relative fallback', () => {
  const source = [
    'const pkg = { name: "@excalidraw/excalidraw", version: "0.18.1" };',
    'const fallback = `/vendor/whiteboards-editor/0.18.1/${pkg.name}@${pkg.version}/dist/prod/`;',
    'const fontURL = (asset) => new URL(asset, fallback).href;',
  ].join('\n')
  const result = hardenEditorBundle(source, 'hardening-legacy-local-fixture.js')
  const resolveFont = new Function(
    'globalThis',
    `${result.hardened}\nreturn fontURL("fonts/Virgil/Virgil.woff2")`,
  )
  assert.equal(result.localFallbacks, 1)
  assert.equal(
    resolveFont({ location: { origin: 'https://clarin.example.invalid' } }),
    'https://clarin.example.invalid/vendor/whiteboards-editor/0.18.1/fonts/Virgil/Virgil.woff2',
  )
})

test('keeps the Docker branding policy synchronized with the maintenance skill', async () => {
  const scriptsDirectory = dirname(fileURLToPath(import.meta.url))
  const localPolicy = JSON.parse(await readFile(resolve(scriptsDirectory, 'visible-branding-policy.json'), 'utf8'))
  const canonicalPolicy = JSON.parse(await readFile(
    resolve(scriptsDirectory, '../../.codex/skills/clarin-excalidraw-development/references/visible-branding-policy.json'),
    'utf8',
  ))

  assert.equal(localPolicy.schemaVersion, canonicalPolicy.schemaVersion)
  assert.equal(localPolicy.policyId, canonicalPolicy.policyId)
  assert.deepEqual(localPolicy.legalArtifactBasenames, canonicalPolicy.legalArtifactBasenames)
  assert.deepEqual(localPolicy.forbiddenVisibleText, canonicalPolicy.forbiddenVisibleText)
})
