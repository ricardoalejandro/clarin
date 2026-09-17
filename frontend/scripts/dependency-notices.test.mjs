import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { buildDependencyNotices, composeEditorNotice, run } from './dependency-notices.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const fullLicense = readFileSync(new URL('../node_modules/react/LICENSE', import.meta.url), 'utf8')
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'clarin-dependency-notices-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const write = (path, value) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), typeof value === 'string' ? value : JSON.stringify(value))
  }
  const component = (name, version = '1.0.0') => ({
    name, version, properties: [{ name: 'clarin:npm:lock-paths', value: `node_modules/${name}` }, { name: 'clarin:npm:integrity', value: 'sha512-fixture' }],
  })
  const sbom = { metadata: { component: component('editor') }, components: [component('dep')] }
  const lock = { packages: { 'node_modules/editor': { version: '1.0.0', integrity: 'sha512-fixture' }, 'node_modules/dep': { version: '1.0.0', integrity: 'sha512-fixture' } } }
  const evidence = { schemaVersion: 1, sbomSha256: '', overrides: [], exclusions: [] }
  const save = () => {
    const bytes = JSON.stringify(sbom)
    evidence.sbomSha256 = hash(bytes)
    write('sbom.json', bytes)
    write('evidence.json', evidence)
    write('package-lock.json', lock)
  }
  for (const name of ['editor', 'dep']) {
    write(`node_modules/${name}/package.json`, { name, version: '1.0.0', license: 'MIT' })
    write(`node_modules/${name}/LICENSE`, fullLicense)
  }
  save()
  const options = { frontendRoot: root, sbomPath: 'sbom.json', evidencePath: 'evidence.json' }
  return { root, write, options, sbom, lock, evidence, save, component }
}

test('deduplicates identical complete license texts but preserves every component and source', t => {
  const f = fixture(t)
  const first = buildDependencyNotices(f.options)
  const second = buildDependencyNotices(f.options)
  assert.equal(first.text, second.text)
  assert.equal(first.uniqueTexts, 1)
  assert.deepEqual(first.coveredComponents, ['dep@1.0.0', 'editor@1.0.0'])
  assert.equal(first.text.split(fullLicense).length - 1, 1)
  assert.match(first.text, /node_modules\/dep\/LICENSE/)
  assert.match(first.text, /node_modules\/editor\/LICENSE/)
})

test('rejects a SPDX label without a substantive license and does not write partial output', t => {
  const f = fixture(t)
  f.write('node_modules/dep/LICENSE', 'MIT')
  assert.throws(() => buildDependencyNotices(f.options), /substantive legal text/)
  assert.throws(() => run(['--root', f.root, '--sbom', 'sbom.json', '--evidence', 'evidence.json', '--output', join(f.root, 'output.txt')]), /substantive legal text/)
})

test('preserves a short copyright header alongside the complete license grant', t => {
  const f = fixture(t)
  f.write('node_modules/dep/src/license_header', 'Copyright (c) Synthetic author; see LICENSE for the complete grant.')
  const result = buildDependencyNotices(f.options)
  assert.match(result.text, /Copyright \(c\) Synthetic author/)
  assert.equal(result.uniqueTexts, 2)
})

test('rejects missing material, version drift, integrity drift and SBOM drift', t => {
  const f = fixture(t)
  f.write('node_modules/dep/package.json', { name: 'dep', version: '2.0.0' })
  assert.throws(() => buildDependencyNotices(f.options), /installed package identity drift/)
  f.write('node_modules/dep/package.json', { name: 'dep', version: '1.0.0' })
  f.lock.packages['node_modules/dep'].integrity = 'sha512-changed'
  f.save()
  assert.throws(() => buildDependencyNotices(f.options), /lock\/SBOM identity drift/)
  f.write('sbom.json', '{}')
  assert.throws(() => buildDependencyNotices(f.options), /exact archived SBOM/)
})

test('uses only hash-bound exact-version upstream evidence for omitted licenses', t => {
  const f = fixture(t)
  rmSync(join(f.root, 'node_modules/dep/LICENSE'))
  assert.throws(() => buildDependencyNotices(f.options), /SPDX alone is insufficient/)
  const commit = 'a'.repeat(40)
  f.write('legal/dep.txt', fullLicense)
  f.evidence.overrides.push({ name: 'dep', version: '1.0.0', integrity: 'sha512-fixture', provenanceType: 'npm-gitHead-license', publishedGitHead: commit, commit, sourceURL: `https://raw.githubusercontent.com/example/dep/${commit}/LICENSE`, file: 'legal/dep.txt', sha256: hash(fullLicense) })
  f.save()
  assert.equal(buildDependencyNotices(f.options).coveredComponents.length, 2)
  f.write('legal/dep.txt', fullLicense + '\nchanged')
  assert.throws(() => buildDependencyNotices(f.options), /license hash mismatch/)
})

test('distinguishes later repository-level MIT attribution from exact npm gitHead provenance', t => {
  const f = fixture(t)
  rmSync(join(f.root, 'node_modules/dep/LICENSE'))
  f.write('node_modules/dep/package.json', { name: 'dep', version: '1.0.0', license: 'MIT', author: 'Synthetic author', repository: 'https://github.com/example/dep' })
  const commit = 'b'.repeat(40)
  f.write('legal/dep.txt', fullLicense)
  const override = { name: 'dep', version: '1.0.0', integrity: 'sha512-fixture', provenanceType: 'official-repository-license-with-packaged-MIT-declaration', declaredLicense: 'MIT', declaredAuthor: 'Synthetic author', repository: 'git+https://github.com/example/dep.git', commit, sourceURL: `https://raw.githubusercontent.com/example/dep/${commit}/LICENSE`, file: 'legal/dep.txt', sha256: hash(fullLicense), provenanceLimitation: 'Later official license notice; unavailable package gitHead is not source-equivalence evidence.' }
  f.evidence.overrides.push(override)
  f.save()
  assert.match(buildDependencyNotices(f.options).text, /not source-equivalence evidence/)
  delete override.provenanceLimitation
  f.save()
  assert.throws(() => buildDependencyNotices(f.options), /explicit provenance limitation/)
})

test('composition retains the complete original editor notice and appends dependency texts without mutation', t => {
  const f = fixture(t)
  const original = `# Editor notice\n\n${fullLicense}`
  const dependencies = buildDependencyNotices(f.options).text
  const combined = composeEditorNotice(original, dependencies)
  assert.equal(combined.slice(0, original.length), original)
  assert.ok(combined.endsWith(dependencies))
  assert.ok(combined.includes('## Dependency license texts'))
  assert.equal(original, `# Editor notice\n\n${fullLicense}`)
  assert.throws(() => composeEditorNotice(original, 'MIT'), /complete editor and dependency/)
})

test('reports the precise Darwin fsevents exclusion without exempting missing runtime packages', t => {
  const f = fixture(t)
  f.sbom.components.push(f.component('fsevents', '2.3.3'))
  f.lock.packages['node_modules/fsevents'] = { version: '2.3.3', integrity: 'sha512-fixture', optional: true, os: ['darwin'] }
  f.evidence.exclusions.push({ name: 'fsevents', version: '2.3.3', reason: 'Darwin native build watcher; not distributed in the browser/Linux artifact.' })
  f.save()
  assert.equal(buildDependencyNotices(f.options).excludedComponents.length, 1)
  f.lock.packages['node_modules/fsevents'].optional = false
  f.save()
  assert.throws(() => buildDependencyNotices(f.options), /unsupported platform exclusion/)
})

test('rejects path traversal and verifies the archived bytes', t => {
  const f = fixture(t)
  const result = buildDependencyNotices(f.options)
  f.write('output.txt', result.text)
  run(['--root', f.root, '--sbom', 'sbom.json', '--evidence', 'evidence.json', '--verify', join(f.root, 'output.txt')])
  f.write('output.txt', result.text + '\nchanged')
  assert.throws(() => run(['--root', f.root, '--sbom', 'sbom.json', '--evidence', 'evidence.json', '--verify', join(f.root, 'output.txt')]), /Archived dependency notices differ/)
  assert.throws(() => buildDependencyNotices({ ...f.options, evidencePath: '../outside.json' }), /Unsafe license path/)
})
