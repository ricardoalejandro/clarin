import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultSBOM = 'third_party/excalidraw/excalidraw-0.18.1-clarin.7.cdx.json'
const defaultEvidence = 'third_party/excalidraw/dependency-license-evidence.json'
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0
const property = (component, name) => component.properties?.find(item => item.name === name)?.value
const repositoryURL = value => String(typeof value === 'object' ? value?.url || '' : value || '').replace(/^git\+/, '').replace(/\.git$/, '')

function inside(root, path) {
  if (isAbsolute(path) || path.split(/[\\/]/).includes('..')) throw new Error(`Unsafe license path: ${path}`)
  const absolute = resolve(root, path)
  if (existsSync(absolute)) {
    const actual = relative(realpathSync(root), realpathSync(absolute))
    if (actual === '..' || actual.startsWith('../') || isAbsolute(actual)) throw new Error(`License path escapes installed material: ${path}`)
  }
  return absolute
}

function legalFiles(root) {
  const files = []
  const visit = (directory, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => compare(a.name, b.name))) {
      if (['node_modules', '.git'].includes(entry.name)) continue
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) visit(resolve(directory, entry.name), path)
      else if (/^(?:licen[cs]e|copying|notice|copyright)(?:$|[._-])/i.test(entry.name)) {
        if (!entry.isFile()) throw new Error(`Legal evidence is not a regular file: ${path}`)
        files.push(path)
      }
    }
  }
  visit(root)
  return files
}

function legalText(path) {
  const bytes = readFileSync(path)
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  // A filename or SPDX label is not a distributable license grant. This is a
  // minimum completeness guard, not a replacement for reviewing license terms.
  const substantive = text.trim().length >= 200 && /permission|redistribution|licensed|dedication|public domain|terms and conditions|license/i.test(text)
  return { text, sha256: sha256(bytes), substantive }
}

export function buildDependencyNotices({
  frontendRoot = defaultRoot,
  sbomPath = defaultSBOM,
  lockfilePath = 'package-lock.json',
  evidencePath = defaultEvidence,
} = {}) {
  const root = resolve(frontendRoot)
  const sbomBytes = readFileSync(inside(root, sbomPath))
  const sbom = JSON.parse(sbomBytes)
  const lock = JSON.parse(readFileSync(inside(root, lockfilePath), 'utf8'))
  const evidence = JSON.parse(readFileSync(inside(root, evidencePath), 'utf8'))
  if (evidence.schemaVersion !== 1 || evidence.sbomSha256 !== sha256(sbomBytes)) throw new Error('License evidence does not bind the exact archived SBOM')
  const components = [sbom.metadata.component, ...sbom.components].sort((a, b) => compare(`${a.name}@${a.version}`, `${b.name}@${b.version}`))
  const groups = new Map()
  const covered = []
  const excluded = []
  const usedOverrides = new Set()
  for (const component of components) {
    const id = `${component.name}@${component.version}`
    const paths = (property(component, 'clarin:npm:lock-paths') || property(component, 'clarin:npm:lock-path') || '').split(',').filter(Boolean).sort(compare)
    if (!paths.length) throw new Error(`${id}: SBOM has no installed-material path`)
    const integrity = property(component, 'clarin:npm:integrity')
    for (const path of paths) {
      inside(root, path)
      const entry = lock.packages[path]
      if (!entry || entry.version !== component.version || (integrity && entry.integrity !== integrity)) throw new Error(`${id}: lock/SBOM identity drift at ${path}`)
    }
    const exclusion = evidence.exclusions?.find(item => item.name === component.name && item.version === component.version)
    if (exclusion) {
      // Explicit artifact exclusion, not a general exemption for absent optional
      // packages. The only current case is the Darwin native build watcher.
      if (component.name !== 'fsevents' || !paths.every(path => lock.packages[path].optional === true && JSON.stringify(lock.packages[path].os) === '["darwin"]')) {
        throw new Error(`${id}: unsupported platform exclusion`)
      }
      excluded.push({ component: id, reason: exclusion.reason })
      continue
    }
    const path = paths.find(path => existsSync(inside(root, `${path}/package.json`)))
    if (!path) throw new Error(`${id}: required installed license material is absent`)
    const packageRoot = inside(root, path)
    const installed = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'))
    if (installed.name !== component.name || installed.version !== component.version) throw new Error(`${id}: installed package identity drift`)
    let sources = legalFiles(packageRoot).map(file => ({ path: `${path}/${file}`, source: `${path}/${file}` }))
    const override = evidence.overrides?.find(item => item.name === component.name && item.version === component.version)
    if (override) {
      if (override.integrity !== integrity || !/^[a-f0-9]{40}$/.test(override.commit) || !override.sourceURL?.includes(`/${override.commit}/`)) {
        throw new Error(`${id}: upstream license provenance does not match the exact package`)
      }
      if (override.provenanceType === 'npm-gitHead-license') {
        if (override.publishedGitHead !== override.commit) throw new Error(`${id}: npm gitHead license evidence differs from its published commit`)
      } else if (override.provenanceType === 'official-repository-license-with-packaged-MIT-declaration') {
        if (installed.license !== 'MIT' || override.declaredLicense !== installed.license
          || override.declaredAuthor !== installed.author
          || repositoryURL(override.repository) !== repositoryURL(installed.repository)
          || !override.provenanceLimitation) {
          throw new Error(`${id}: repository-level attribution requires matching packaged MIT/author/repository and an explicit provenance limitation`)
        }
      } else throw new Error(`${id}: unsupported license provenance mode`)
      sources.push({ path: override.file, source: override.sourceURL, expectedSha256: override.sha256 })
      usedOverrides.add(id)
    }
    if (!sources.length) throw new Error(`${id}: no complete LICENSE/NOTICE text; SPDX alone is insufficient`)
    const entries = sources.map(source => ({ source, legal: legalText(inside(root, source.path)) }))
    if (!entries.some(entry => entry.legal.substantive)) throw new Error(`${id}: no substantive legal text; SPDX alone is insufficient`)
    // Preserve short copyright/notice headers too, but only alongside at least
    // one substantive grant. DOMPurify's license_header is such a companion.
    for (const { source, legal } of entries) {
      if (source.expectedSha256 && source.expectedSha256 !== legal.sha256) throw new Error(`${id}: upstream license hash mismatch`)
      const group = groups.get(legal.sha256) || { ...legal, components: new Set(), sources: new Set() }
      group.components.add(id)
      group.sources.add(source.source)
      groups.set(legal.sha256, group)
    }
    covered.push(id)
  }
  for (const override of evidence.overrides || []) {
    if (!usedOverrides.has(`${override.name}@${override.version}`)) throw new Error(`Unused license evidence: ${override.name}@${override.version}`)
  }
  const sections = [...groups.values()].sort((a, b) => compare(a.sha256, b.sha256)).map(group => (
    `======================================================================\nSHA-256: ${group.sha256}\nComponents:\n${[...group.components].sort(compare).map(id => `  ${id}`).join('\n')}\nSources:\n${[...group.sources].sort(compare).map(source => `  ${source}`).join('\n')}\n\n${group.text}${group.text.endsWith('\n') ? '' : '\n'}`
  ))
  const limitations = (evidence.overrides || []).filter(item => item.provenanceLimitation).map(item => item.provenanceLimitation).sort(compare)
  const text = `CLARIN WHITEBOARD DEPENDENCY LICENSES\nGenerated deterministically from installed license files and pinned official repository evidence.\nSBOM SHA-256: ${sha256(sbomBytes)}\nSBOM components: ${components.length}; covered: ${covered.length}; explicitly excluded: ${excluded.length}.\nIdentical legal texts are included once, with every applicable component listed.\nThis install closure over-approximates browser code; inclusion does not imply runtime execution.\nFont/asset notices and the Clarin patch notices remain distributed separately.\n\nExcluded from the browser/Linux web artifact:\n${excluded.map(item => `  ${item.component}: ${item.reason}`).join('\n') || '  None.'}\n\nAttribution evidence limitations:\n${limitations.map(item => `  ${item}`).join('\n') || '  None.'}\n\n${sections.join('\n')}`
  return { text, sha256: sha256(text), componentCount: components.length, coveredComponents: covered, excludedComponents: excluded, uniqueTexts: groups.size }
}

export function run(argv = process.argv.slice(2)) {
  const options = {}
  let output
  let verify
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    const value = argv[++index]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`)
    if (key === '--output') output = value
    else if (key === '--verify') verify = value
    else if (key === '--root') options.frontendRoot = value
    else if (key === '--sbom') options.sbomPath = value
    else if (key === '--evidence') options.evidencePath = value
    else throw new Error(`Unknown option: ${key}`)
  }
  const result = buildDependencyNotices(options)
  if (verify && readFileSync(resolve(verify), 'utf8') !== result.text) throw new Error('Archived dependency notices differ from the verified installed material')
  if (output) {
    const target = resolve(output)
    mkdirSync(dirname(target), { recursive: true })
    if (existsSync(target) && !lstatSync(target).isFile()) throw new Error('Notice output is not a regular file')
    writeFileSync(target, result.text)
  } else if (!verify) process.stdout.write(result.text)
  console.error(`Dependency notices: ${result.coveredComponents.length}/${result.componentCount} components, ${result.uniqueTexts} legal texts, ${result.excludedComponents.length} explicit platform exclusion(s), sha256 ${result.sha256}`)
  return result
}

/** Keep the editor's existing notice byte-for-byte and append the full closure. */
export function composeEditorNotice(baseNotice, dependencyText) {
  if (!baseNotice.trim() || !dependencyText.startsWith('CLARIN WHITEBOARD DEPENDENCY LICENSES\n')) throw new Error('Both complete editor and dependency notices are required')
  return `${baseNotice}${baseNotice.endsWith('\n') ? '\n' : '\n\n'}## Dependency license texts\n\n${dependencyText}`
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { run() } catch (error) { console.error(error.message); process.exitCode = 1 }
}
