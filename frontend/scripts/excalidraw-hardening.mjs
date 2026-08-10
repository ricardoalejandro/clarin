import { execFile } from 'node:child_process'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { promisify } from 'node:util'
import { parse } from 'acorn'

export const EXPECTED_EDITOR_VERSION = '0.18.1'
export const LOCAL_EDITOR_ASSET_PATH = `/vendor/whiteboards-editor/${EXPECTED_EDITOR_VERSION}/`
const LOCAL_EDITOR_ASSET_BASE_EXPRESSION = `new URL(${JSON.stringify(LOCAL_EDITOR_ASSET_PATH)}, globalThis.location.origin).href`

const execFileAsync = promisify(execFile)
const DISABLED_EXTERNAL_URL = 'about:blank#clarin-external-disabled'
const XML_NAMESPACES = new Set([
  'http://www.w3.org/1999/xhtml',
  'http://www.w3.org/2000/svg',
])
const TEXT_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.map',
  '.mjs',
  '.txt',
])
const PROHIBITED_ROUTE_PATTERNS = [
  /(?:^|[^a-z0-9-])(?:[a-z0-9-]+\.)*excalidraw\.com(?:[^a-z0-9-]|$)/iu,
  /excalidraw-room-persistence\.cloudfunctions\.net/iu,
  /excalidraw-room-persistence\.(?:firebaseapp|appspot)\.com/iu,
  /excalidraw-room-persistence\.firebaseio\.com/iu,
  /excalidraw-oss-dev\.(?:appspot|firebaseapp)\.com/iu,
  /(?:^|[^a-z0-9-])esm\.(?:sh|run)(?:[^a-z0-9-]|$)/iu,
  /github\.com\/excalidraw(?:\/|$)/iu,
  /raw\.githubusercontent\.com\/excalidraw(?:\/|$)/iu,
  /(?:x|youtube)\.com\/(?:@)?excalidraw(?:\/|$)/iu,
  /discord\.gg\/UexuTaE/iu,
  /mermaid\.js\.org\/syntax\//iu,
]
const PROHIBITED_EXTERNAL_HOST_PATTERNS = [
  /(?:^|[^a-z0-9-])(?:[a-z0-9-]+\.)*(?:youtube\.com|youtu\.be|vimeo\.com)(?:[^a-z0-9-]|$)/iu,
  /(?:^|[^a-z0-9-])(?:[a-z0-9-]+\.)*(?:googleapis\.com|gstatic\.com|sentry\.io|githubusercontent\.com)(?:[^a-z0-9-]|$)/iu,
]

export async function walkFiles(root, predicate = () => true) {
  const files = []
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (predicate(path)) files.push(path)
    }
  }
  await walk(root)
  return files
}

function parseJavaScript(source, fileLabel) {
  try {
    return parse(source, {
      allowHashBang: true,
      ecmaVersion: 'latest',
      sourceType: 'module',
    })
  } catch (moduleError) {
    try {
      return parse(source, {
        allowHashBang: true,
        ecmaVersion: 'latest',
        sourceType: 'script',
      })
    } catch {
      throw new Error(`JavaScript inválido en ${fileLabel}: ${moduleError.message}`)
    }
  }
}

function visitAst(node, visitor) {
  if (!node || typeof node !== 'object') return
  visitor(node)
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) visitAst(child, visitor)
    } else if (value && typeof value === 'object') {
      visitAst(value, visitor)
    }
  }
}

function decodeEscapes(value) {
  let decoded = value
  for (let pass = 0; pass < 3; pass += 1) {
    const next = decoded
      .replace(/\\u\{([0-9a-f]{1,6})\}/giu, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
      .replace(/\\u([0-9a-f]{4})/giu, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
      .replace(/\\x([0-9a-f]{2})/giu, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
      .replace(/\\\//gu, '/')
    if (next === decoded) break
    decoded = next
  }
  return decoded
}

function findProhibitedRoute(value, { detectMalformed = true, strictExternalHosts = false } = {}) {
  const decoded = decodeEscapes(value)
  if (detectMalformed && (decoded.includes('https:///') || decoded.includes('http:///'))) return 'URL externa malformada'
  const patterns = strictExternalHosts
    ? [...PROHIBITED_ROUTE_PATTERNS, ...PROHIBITED_EXTERNAL_HOST_PATTERNS]
    : PROHIBITED_ROUTE_PATTERNS
  return patterns.find(pattern => pattern.test(decoded))?.toString() ?? null
}

function isExternalUrl(value) {
  return /^(?:https?|wss?):\/\//iu.test(value) && !XML_NAMESPACES.has(value)
}

function neutralizeEmbeddedHosts(value) {
  if (!findProhibitedRoute(value, { strictExternalHosts: true })) return value
  if (value.trimStart().startsWith('{')) return '{}'
  return 'clarin.invalid'
}

function staticString(node) {
  if (!node || typeof node !== 'object') return null
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node.type === 'TemplateLiteral') {
    let result = ''
    for (let index = 0; index < node.quasis.length; index += 1) {
      result += node.quasis[index].value.cooked ?? node.quasis[index].value.raw
      if (index < node.expressions.length) {
        const expression = staticString(node.expressions[index])
        if (expression === null) result += '<dynamic>'
        else result += expression
      }
    }
    return result
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = staticString(node.left)
    const right = staticString(node.right)
    return left === null || right === null ? null : left + right
  }
  return null
}

function assertNoProhibitedRoutes(source, fileLabel, { parseJs = false, strictExternalHosts = false } = {}) {
  // In minified JavaScript a valid string ending in "https://" immediately
  // followed by a regex literal can look like "https:///" in raw bytes. The
  // AST pass below checks actual static string values without that false match.
  const directMatch = findProhibitedRoute(source, { detectMalformed: !parseJs, strictExternalHosts })
  if (directMatch) throw new Error(`Ruta upstream prohibida en ${fileLabel}: ${directMatch}`)

  if (!parseJs) return
  const ast = parseJavaScript(source, fileLabel)
  visitAst(ast, node => {
    if (!['Literal', 'TemplateLiteral', 'BinaryExpression'].includes(node.type)) return
    const value = staticString(node)
    if (value === null) return
    const match = findProhibitedRoute(value, { strictExternalHosts })
    if (match) throw new Error(`Ruta upstream construida dinámicamente en ${fileLabel}: ${match}`)
  })
}

function applyReplacements(source, replacements) {
  const ordered = [...replacements].sort((left, right) => right.start - left.start)
  let next = source
  let previousStart = source.length + 1
  for (const replacement of ordered) {
    if (replacement.end > previousStart) throw new Error('Se detectaron reemplazos AST superpuestos.')
    next = `${next.slice(0, replacement.start)}${replacement.value}${next.slice(replacement.end)}`
    previousStart = replacement.start
  }
  return next
}

export function hardenEditorBundle(source, fileLabel = 'bundle') {
  const ast = parseJavaScript(source, fileLabel)
  const replacements = []
  const replacedFirebaseValues = new Set()
  const replacedLocalFallbackRanges = []
  let localFallbacks = 0
  let disabledRoutes = 0

  visitAst(ast, node => {
    if (node.type === 'TemplateLiteral') {
      const rawTemplate = node.quasis.map(quasi => quasi.value.raw).join('<dynamic>')
      const isUpstreamFallback = /https:\/\/esm\.(?:sh|run)\//iu.test(rawTemplate)
      const isLegacyLocalFallback = rawTemplate.includes(LOCAL_EDITOR_ASSET_PATH)
        && /\/dist\/prod\//iu.test(rawTemplate)
      if (isUpstreamFallback || isLegacyLocalFallback) {
        replacements.push({ start: node.start, end: node.end, value: LOCAL_EDITOR_ASSET_BASE_EXPRESSION })
        replacedLocalFallbackRanges.push({ start: node.start, end: node.end })
        localFallbacks += 1
        return
      }
    }
    if (node.type === 'Property') {
      const key = node.key?.name ?? node.key?.value
      if (key === 'VITE_APP_FIREBASE_CONFIG' && node.value?.type === 'Literal' && node.value.value !== '{}') {
        replacements.push({ start: node.value.start, end: node.value.end, value: JSON.stringify('{}') })
        replacedFirebaseValues.add(`${node.value.start}:${node.value.end}`)
        disabledRoutes += 1
        return
      }
    }
    if (node.type === 'Literal' && typeof node.value === 'string') {
      if (replacedFirebaseValues.has(`${node.start}:${node.end}`)) return
      let value = node.value
      if (isExternalUrl(value)) {
        value = DISABLED_EXTERNAL_URL
        disabledRoutes += 1
      } else {
        const neutralized = neutralizeEmbeddedHosts(value)
        if (neutralized !== value) {
          value = neutralized
          disabledRoutes += 1
        }
      }
      if (value !== node.value) replacements.push({ start: node.start, end: node.end, value: JSON.stringify(value) })
      return
    }

    if (node.type === 'TemplateElement') {
      if (replacedLocalFallbackRanges.some(range => node.start >= range.start && node.end <= range.end)) return
      // URL helpers for embeds are commonly expressed as template literals,
      // so replacing only Literal nodes leaves an operational network route in
      // the production bundle even when the corresponding control is hidden.
      if (/https?:\/\//iu.test(node.value.raw)) {
        const value = node.value.raw.replace(/https?:\/\/[^\\`$}\s]*/giu, DISABLED_EXTERNAL_URL)
        replacements.push({ start: node.start, end: node.end, value })
        disabledRoutes += 1
      }
    }
  })

  const hardened = applyReplacements(source, replacements)
  assertNoProhibitedRoutes(hardened, fileLabel, { parseJs: true, strictExternalHosts: true })
  return { disabledRoutes, hardened, localFallbacks }
}

async function assertNodeSyntax(file) {
  await execFileAsync(process.execPath, ['--check', file], { maxBuffer: 2 * 1024 * 1024 })
}

export async function hardenJavaScriptTree(root) {
  const files = await walkFiles(root, path => extname(path) === '.js')
  let disabledRoutes = 0
  let localFallbacks = 0
  for (const file of files) {
    const original = await readFile(file, 'utf8')
    const result = hardenEditorBundle(original, file)
    disabledRoutes += result.disabledRoutes
    localFallbacks += result.localFallbacks
    if (result.hardened !== original) await writeFile(file, result.hardened)
    await assertNodeSyntax(file)
  }

  const maps = await walkFiles(root, path => extname(path) === '.map')
  for (const file of maps) {
    const sourceMap = JSON.parse(await readFile(file, 'utf8'))
    delete sourceMap.sourcesContent
    await writeFile(file, JSON.stringify(sourceMap))
  }

  return { disabledRoutes, files: files.length, localFallbacks, maps: maps.length }
}

export async function verifyJavaScriptTree(root, { strictExternalHosts = false } = {}) {
  const files = await walkFiles(root, path => extname(path) === '.js' || extname(path) === '.mjs' || extname(path) === '.cjs')
  for (const file of files) {
    const source = await readFile(file, 'utf8')
    assertNoProhibitedRoutes(source, file, { parseJs: true, strictExternalHosts })
  }
  return files.length
}

export async function verifyArtifactTree(root, { strictExternalHosts = false } = {}) {
  const files = await walkFiles(root, path => {
    if (/(?:^|\/)(?:LICENSE|NOTICE(?:\.md)?)$/iu.test(path)) return false
    return TEXT_EXTENSIONS.has(extname(path)) || /(?:worker|worklet)$/iu.test(path)
  })
  for (const file of files) {
    const source = await readFile(file, 'utf8')
    const extension = extname(file)
    assertNoProhibitedRoutes(source, file, {
      parseJs: extension === '.js' || extension === '.mjs' || extension === '.cjs',
      strictExternalHosts,
    })
  }
  return files.length
}
