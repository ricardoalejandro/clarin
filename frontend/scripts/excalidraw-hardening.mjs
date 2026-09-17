import { execFile } from 'node:child_process'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { promisify } from 'node:util'
import { parse } from 'acorn'

export const EXPECTED_EDITOR_VERSION = '0.18.1-clarin.7'
export const LOCAL_EDITOR_ASSET_PATH = `/vendor/whiteboards-editor/${EXPECTED_EDITOR_VERSION}/`
const LOCAL_EDITOR_ASSET_BASE_EXPRESSION = `new URL(${JSON.stringify(LOCAL_EDITOR_ASSET_PATH)}, globalThis.location.origin).href`

const execFileAsync = promisify(execFile)
const DISABLED_EXTERNAL_URL = 'about:blank#clarin-external-disabled'
const CLARIN_LIBRARY_BROWSE_TEMPLATE = '?target=<dynamic>&referrer=<dynamic>&useHash=true&token=<dynamic>&theme=<dynamic>&version=<dynamic>'
const CLARIN_LIBRARY_DISCLOSURE_LABEL = 'Explorar bibliotecas. Abre el sitio oficial, que puede usar analítica externa. Clarin validará el archivo antes de guardarlo.'
const CLARIN_LIBRARY_DISCLOSURE_TITLE = 'Abre el sitio oficial, que puede usar analítica externa. Clarin validará el archivo antes de guardarlo.'
const CLARIN_LIBRARY_START_EXPRESSION = `(() => {
  const value = globalThis.__CLARIN_WHITEBOARD_LIBRARY_START_URL__;
  return typeof value === "string"
    && /^\\/api\\/whiteboards\\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\/public-library-import\\/start\\?library_id=[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
    ? value
    : ${JSON.stringify(DISABLED_EXTERNAL_URL)};
})()`
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
      const line = moduleError.loc?.line ?? 1
      const lines = source.split('\n')
      const context = lines.slice(Math.max(0, line - 2), Math.min(lines.length, line + 1)).join('\n')
      throw new Error(`JavaScript inválido en ${fileLabel}: ${moduleError.message}\n${context}`)
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

function propertyName(node) {
  if (!node || node.type !== 'Property' || node.computed) return null
  return node.key?.name ?? node.key?.value ?? null
}

function memberPropertyName(node) {
  if (!node || node.type !== 'MemberExpression') return null
  return node.computed ? staticString(node.property) : node.property?.name ?? null
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

function directCallExpressions(expression) {
  if (!expression) return []
  if (expression.type === 'CallExpression') return [expression]
  if (expression.type === 'SequenceExpression') return expression.expressions.flatMap(directCallExpressions)
  return []
}

function objectInsertionSeparator(source, node, properties) {
  if (!properties.length) return ''
  const trailingSyntax = source.slice(properties.at(-1).end, node.end - 1)
  return trailingSyntax.includes(',') ? '' : ','
}

function arrayInsertionSeparator(source, node) {
  const elements = node.elements.filter(Boolean)
  if (!elements.length) return ''
  const trailingSyntax = source.slice(elements.at(-1).end, node.end - 1)
  return trailingSyntax.includes(',') ? ' ' : ', '
}

export function hardenEditorBundle(source, fileLabel = 'bundle', fontCatalog = []) {
  const ast = parseJavaScript(source, fileLabel)
  const replacements = []
  const replacedFirebaseValues = new Set()
  const replacedLocalFallbackRanges = []
  let localFallbacks = 0
  let disabledRoutes = 0
  let libraryBrowseRoutes = 0
  let rewrittenLibraryBrowseMessages = 0
  let securedLibraryBrowseTargets = 0
  let highlighterMenus = 0
  let highlighterToolLifecycles = 0
  let hiddenGenerateSections = 0
  let ultraBoldStrokeWidths = 0
  let customFontFamilyCatalogs = 0
  let customFontLazyRegistrations = 0
  let customFontMetadataCatalogs = 0
  let customFontRegistrations = 0
  let fontPickerCategoryFilters = 0
  let fontPickerVisiblePreviews = 0
  let fontPickerTriggers = 0
  let buttonIconAccessibilityLabels = 0
  const highlighterMenuCandidates = []
  const existingHighlighterIconValues = []
  const highlighterLifecycleCandidates = []
  const highlighterTriggerCandidates = []
  const generateSectionCandidates = []
  const strokeWidthOptionCandidates = []
  const fontFamilyCandidates = []
  const fontMetadataCandidates = []
  const fontRegistrationCandidates = []
  const customFontContentCandidates = []
  const customFontLazyRegistrationCandidates = []
  const fontPickerListCandidates = []
  const fontPickerTriggerCandidates = []
  const buttonIconAccessibilityCandidates = []
  const hasHighlighterMenu = source.includes('toolbar-highlighter')
  const hasHighlighterLifecycle = source.includes('__clarinHighlighterRequested')
  if (hasHighlighterMenu !== hasHighlighterLifecycle) {
    throw new Error(`Parche de Resaltador incompleto en ${fileLabel}.`)
  }

  visitAst(ast, node => {
    if (fontCatalog.length
      && node.type === 'MethodDefinition'
      && !node.computed
      && (node.key?.name ?? node.key?.value) === 'loadFontFaces'
      && node.value?.async
      && node.value.body?.type === 'BlockStatement') {
      const methodSource = source.slice(node.value.start, node.value.end)
      if (methodSource.includes('.fontFacesLoader(') && methodSource.includes('.fonts.add(')) {
        customFontLazyRegistrationCandidates.push(node.value)
      }
    }
    if (fontCatalog.length
      && node.type === 'MethodDefinition'
      && !node.computed
      && (node.key?.name ?? node.key?.value) === 'getContent'
      && node.value?.async
      && node.value.body?.type === 'BlockStatement') {
      const methodSource = source.slice(node.value.body.start, node.value.body.end)
      if (methodSource.includes('.fetchFont(')) {
        customFontContentCandidates.push(node.value.body)
      }
    }
    if (fontCatalog.length && node.type === 'ObjectExpression') {
      const properties = node.properties.filter(property => property?.type === 'Property')
      const directNames = new Set(properties.map(propertyName).filter(Boolean))
      if (['Virgil', 'Helvetica', 'Cascadia', 'Excalifont', 'Nunito', 'Lilita One', 'Comic Shanns', 'Liberation Sans'].every(name => directNames.has(name))) {
        fontFamilyCandidates.push({ node, properties })
      }
      const computedNames = new Set(properties.map(property => memberPropertyName(property.key)).filter(Boolean))
      if (['Excalifont', 'Nunito', 'Lilita One', 'Comic Shanns', 'Virgil', 'Helvetica', 'Cascadia'].every(name => computedNames.has(name))) {
        const officialKey = properties.find(property => memberPropertyName(property.key) === 'Excalifont')
        if (officialKey?.key?.type === 'MemberExpression') {
          fontMetadataCandidates.push({ node, properties, familyExpression: source.slice(officialKey.key.object.start, officialKey.key.object.end) })
        }
      }
    }
    if (fontCatalog.length && node.type === 'BlockStatement') {
      const sequenceExpressions = []
      const calls = node.body.flatMap(statement => {
        const expression = statement?.type === 'ExpressionStatement'
          ? statement.expression
          : statement?.type === 'ReturnStatement'
            ? statement.argument
            : null
        if (expression?.type === 'SequenceExpression') sequenceExpressions.push(expression)
        return directCallExpressions(expression)
      })
      const names = new Set(calls.map(call => staticString(call.arguments[0])).filter(Boolean))
      if (['Cascadia', 'Comic Shanns', 'Excalifont', 'Helvetica', 'Liberation Sans', 'Lilita One', 'Nunito', 'Virgil'].every(name => names.has(name))) {
        const officialCalls = calls.filter(call => names.has(staticString(call.arguments[0])))
        const exemplar = calls.find(call => staticString(call.arguments[0]) === 'Virgil')
        if (exemplar) fontRegistrationCandidates.push({ node, calls, exemplar, officialCalls, sequenceExpressions })
      }
    }
    if (fontCatalog.length && (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression')) {
      const bodySource = source.slice(node.start, node.end)
      if (bodySource.includes('fontList.availableFonts') && bodySource.includes('fontList.sceneFonts') && bodySource.includes('quickSearch.placeholder')) {
        fontPickerListCandidates.push(node)
      }
      if (bodySource.includes('font-family-show-fonts')
        && (bodySource.includes('labels.showFonts') || bodySource.includes('Más fuentes · 32'))) {
        fontPickerTriggerCandidates.push(node)
      }
    }
    if (node.type === 'ArrayExpression') {
      const options = node.elements.flatMap(element => {
        if (element?.type !== 'ObjectExpression') return []
        const properties = element.properties.filter(property => property?.type === 'Property')
        const testID = properties.find(property => propertyName(property) === 'testId')
        const value = staticString(testID?.value)
        return value ? [{ element, properties, testID: value }] : []
      })
      const testIDs = new Set(options.map(option => option.testID))
      if (testIDs.has('strokeWidth-thin')
        && testIDs.has('strokeWidth-bold')
        && testIDs.has('strokeWidth-extraBold')) {
        strokeWidthOptionCandidates.push({ node, options })
      }
    }
    if (node.type === 'ObjectExpression') {
      const properties = node.properties.filter(property => property?.type === 'Property')
      if (fontCatalog.length) {
        const byName = new Map(properties.map(property => [propertyName(property), property]))
        const type = byName.get('type')
        const title = byName.get('title')
        const testID = byName.get('data-testid')
        const children = byName.get('children')
        if (staticString(type?.value) === 'button'
          && title?.value?.type === 'Identifier'
          && testID?.value?.type === 'Identifier'
          && children?.value?.type === 'Identifier'
          && byName.has('className')
          && byName.has('onClick')) {
          buttonIconAccessibilityCandidates.push({ node, properties, title })
        }
      }
      const className = properties.find(property => propertyName(property) === 'className')
      if (staticString(className?.value) === 'library-menu-browse-button') {
        const requiredProperties = new Map([
          ['target', '_self'],
          ['rel', 'noreferrer'],
          ['referrerPolicy', 'no-referrer'],
          ['aria-label', CLARIN_LIBRARY_DISCLOSURE_LABEL],
          ['title', CLARIN_LIBRARY_DISCLOSURE_TITLE],
        ])
        const missing = []
        for (const [key, value] of requiredProperties) {
          const property = properties.find(candidate => propertyName(candidate) === key)
          if (!property) {
            missing.push(`${JSON.stringify(key)}: ${JSON.stringify(value)}`)
            continue
          }
          if (staticString(property.value) !== value) {
            replacements.push({ start: property.value.start, end: property.value.end, value: JSON.stringify(value) })
          }
        }
        if (missing.length > 0) {
          replacements.push({ start: node.start + 1, end: node.start + 1, value: `${missing.join(', ')}, ` })
        }
        securedLibraryBrowseTargets += 1
      }
    }
    if (node.type === 'CallExpression') {
      const objectArgument = node.arguments.find(argument => argument?.type === 'ObjectExpression')
      if (objectArgument) {
        const properties = objectArgument.properties.filter(property => property?.type === 'Property')
        const testID = properties.find(property => propertyName(property) === 'data-testid')
        if (staticString(testID?.value) === 'toolbar-laser') {
          const onSelect = properties.find(property => propertyName(property) === 'onSelect')?.value
          const icon = properties.find(property => propertyName(property) === 'icon')?.value
          const selectionCall = onSelect?.type === 'ArrowFunctionExpression' && onSelect.body?.type === 'CallExpression'
            ? onSelect.body
            : null
          const receiver = selectionCall?.callee?.type === 'MemberExpression'
            ? source.slice(selectionCall.callee.object.start, selectionCall.callee.object.end)
            : null
          if (receiver && icon && node.arguments[0]) {
            highlighterMenuCandidates.push({
              call: node,
              component: source.slice(node.arguments[0].start, node.arguments[0].end),
              helper: source.slice(node.callee.start, node.callee.end),
              icon: source.slice(icon.start, icon.end),
              receiver,
            })
          }
        }
        if (staticString(testID?.value) === 'toolbar-highlighter') {
          const icon = properties.find(property => propertyName(property) === 'icon')?.value
          if (icon) existingHighlighterIconValues.push(icon)
        }
        const children = properties.find(property => propertyName(property) === 'children')
        const style = properties.find(property => propertyName(property) === 'style')
        if (!hasHighlighterMenu && style && staticString(children?.value) === 'Generate') generateSectionCandidates.push(node)
      }
      if (!hasHighlighterMenu && staticString(node.arguments[1]) === 'setActiveTool') {
        const lifecycle = node.arguments[2]
        if (lifecycle?.type === 'ArrowFunctionExpression' && lifecycle.body?.type === 'BlockStatement') {
          highlighterLifecycleCandidates.push(lifecycle.body)
        }
      }
    }
    if (!hasHighlighterMenu && node.type === 'Property' && propertyName(node) === 'App-toolbar__extra-tools-trigger--selected') {
      highlighterTriggerCandidates.push(node)
    }
    if (node.type === 'TemplateLiteral') {
      const rawTemplate = node.quasis.map(quasi => quasi.value.raw).join('<dynamic>')
      if (rawTemplate.includes(CLARIN_LIBRARY_BROWSE_TEMPLATE)) {
        replacements.push({ start: node.start, end: node.end, value: CLARIN_LIBRARY_START_EXPRESSION })
        libraryBrowseRoutes += 1
        return
      }
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
      if (key === 'hint_emptyLibrary' && node.value?.type === 'Literal' && typeof node.value.value === 'string') {
        replacements.push({
          start: node.value.start,
          end: node.value.end,
          value: JSON.stringify('Selecciona una figura del lienzo para añadirla aquí, o abre el catálogo público validado por Clarin.'),
        })
        rewrittenLibraryBrowseMessages += 1
        return
      }
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

  if (fontCatalog.length) {
    const expectedIDs = fontCatalog.map(entry => entry.id)
    if (fontCatalog.length !== 25 || new Set(expectedIDs).size !== 25 || expectedIDs[0] !== 10001 || expectedIDs.at(-1) !== 10025) {
      throw new Error(`Catálogo privado de fuentes inválido en ${fileLabel}.`)
    }

    if (fontFamilyCandidates.length > 1) throw new Error(`Se encontraron varios catálogos FONT_FAMILY en ${fileLabel}.`)
    if (fontFamilyCandidates.length === 1) {
      const candidate = fontFamilyCandidates[0]
      const existing = new Map(candidate.properties.map(property => [propertyName(property), property]))
      const present = fontCatalog.filter(entry => existing.has(entry.cssFamily))
      const legacyPresent = fontCatalog.filter(entry => existing.has(entry.family))
      if ((present.length && present.length !== fontCatalog.length)
        || (legacyPresent.length && legacyPresent.length !== fontCatalog.length)
        || (present.length && legacyPresent.length)) throw new Error(`El catálogo FONT_FAMILY quedó parcialmente parcheado en ${fileLabel}.`)
      if (present.length === fontCatalog.length) {
        for (const entry of fontCatalog) {
          const property = existing.get(entry.cssFamily)
          if (property?.value?.type !== 'Literal' || property.value.value !== entry.id) throw new Error(`El ID privado de ${entry.family} cambió en ${fileLabel}.`)
        }
      } else if (legacyPresent.length === fontCatalog.length) {
        for (const entry of fontCatalog) {
          const property = existing.get(entry.family)
          if (property?.value?.type !== 'Literal' || property.value.value !== entry.id) throw new Error(`El ID privado de ${entry.family} cambió en ${fileLabel}.`)
          replacements.push({ start: property.key.start, end: property.key.end, value: JSON.stringify(entry.cssFamily) })
        }
        customFontFamilyCatalogs = 1
      } else {
        replacements.push({
          start: candidate.node.end - 1,
          end: candidate.node.end - 1,
          value: `${objectInsertionSeparator(source, candidate.node, candidate.properties)}\n/* clarin-font-catalog */\n${fontCatalog.map(entry => `${JSON.stringify(entry.cssFamily)}: ${entry.id}`).join(',\n')}\n`,
        })
        customFontFamilyCatalogs = 1
      }
    }

    if (fontMetadataCandidates.length > 1) throw new Error(`Se encontraron varios catálogos de métricas de fuentes en ${fileLabel}.`)
    if (fontMetadataCandidates.length === 1) {
      const candidate = fontMetadataCandidates[0]
      const existingNames = new Set(candidate.properties.map(property => memberPropertyName(property.key)).filter(Boolean))
      const present = fontCatalog.filter(entry => existingNames.has(entry.cssFamily))
      const legacyPresent = fontCatalog.filter(entry => existingNames.has(entry.family))
      if ((present.length && present.length !== fontCatalog.length)
        || (legacyPresent.length && legacyPresent.length !== fontCatalog.length)
        || (present.length && legacyPresent.length)) throw new Error(`Las métricas privadas quedaron parcialmente parcheadas en ${fileLabel}.`)
      if (!present.length && !legacyPresent.length) {
        replacements.push({
          start: candidate.node.end - 1,
          end: candidate.node.end - 1,
          value: `${objectInsertionSeparator(source, candidate.node, candidate.properties)}\n/* clarin-font-metadata */\n${fontCatalog.map(entry => `[${candidate.familyExpression}[${JSON.stringify(entry.cssFamily)}]]: { metrics: ${JSON.stringify(entry.metrics)}, category: ${JSON.stringify(entry.category)}, label: ${JSON.stringify(entry.family)} }`).join(',\n')}\n`,
        })
        customFontMetadataCatalogs = 1
      } else {
        for (const entry of fontCatalog) {
          const legacy = legacyPresent.length === fontCatalog.length
          const property = candidate.properties.find(item => memberPropertyName(item.key) === (legacy ? entry.family : entry.cssFamily))
          const canonical = `[${candidate.familyExpression}[${JSON.stringify(entry.cssFamily)}]]: { metrics: ${JSON.stringify(entry.metrics)}, category: ${JSON.stringify(entry.category)}, label: ${JSON.stringify(entry.family)} }`
          if (!property) throw new Error(`No se encontraron las métricas de ${entry.family} en ${fileLabel}.`)
          if (source.slice(property.start, property.end) !== canonical) {
            replacements.push({ start: property.start, end: property.end, value: canonical })
            customFontMetadataCatalogs = 1
          }
        }
      }
    }

    if (fontRegistrationCandidates.length > 1) throw new Error(`Se encontraron varios inicializadores de fuentes en ${fileLabel}.`)
    if (fontRegistrationCandidates.length === 1) {
      const candidate = fontRegistrationCandidates[0]
      const callsByName = new Map(candidate.calls.map(call => [staticString(call.arguments[0]), call]))
      const present = fontCatalog.filter(entry => callsByName.has(entry.cssFamily))
      const legacyPresent = fontCatalog.filter(entry => callsByName.has(entry.family))
      if ((present.length && present.length !== fontCatalog.length)
        || (legacyPresent.length && legacyPresent.length !== fontCatalog.length)
        || (present.length && legacyPresent.length)) throw new Error(`El registro privado de fuentes quedó parcialmente parcheado en ${fileLabel}.`)
      if (!present.length && !legacyPresent.length) {
        const officialNames = new Set(['Cascadia', 'Comic Shanns', 'Excalifont', 'Helvetica', 'Liberation Sans', 'Lilita One', 'Nunito', 'Virgil'])
        const anchor = candidate.calls.filter(call => officialNames.has(staticString(call.arguments[0]))).at(-1)
        if (!anchor) throw new Error(`No se encontró el ancla del registro oficial de fuentes en ${fileLabel}.`)
        const callee = source.slice(candidate.exemplar.callee.start, candidate.exemplar.callee.end)
        const isSequence = candidate.sequenceExpressions.some(sequence => sequence.expressions.includes(anchor))
        const calls = fontCatalog.map(entry => `${callee}(${JSON.stringify(entry.cssFamily)}, ${entry.fontFaces.map(face => JSON.stringify(face)).join(', ')})`)
        const insertion = isSequence
          ? `,/* clarin-font-registration */${calls.join(',')}`
          : `\n/* clarin-font-registration */\n${calls.map(call => `${call};`).join('\n')}`
        const directStatement = isSequence
          ? null
          : candidate.node.body.find(statement => statement.type === 'ExpressionStatement' && directCallExpressions(statement.expression).includes(anchor))
        if (!isSequence && !directStatement) throw new Error(`No se encontró la sentencia ancla del registro oficial de fuentes en ${fileLabel}.`)
        const insertionPoint = directStatement?.end ?? anchor.end
        replacements.push({ start: insertionPoint, end: insertionPoint, value: insertion })
        customFontRegistrations = 1
      } else if (legacyPresent.length === fontCatalog.length) {
        for (const entry of fontCatalog) {
          const call = callsByName.get(entry.family)
          replacements.push({ start: call.arguments[0].start, end: call.arguments[0].end, value: JSON.stringify(entry.cssFamily) })
        }
        customFontRegistrations = 1
      }
    }

    if (customFontContentCandidates.length > 1) throw new Error(`Se encontraron varios generadores de contenido de fuentes en ${fileLabel}.`)
    if (customFontContentCandidates.length === 1 && !source.slice(customFontContentCandidates[0].start, customFontContentCandidates[0].end).includes('clarin-font-full-svg-embed')) {
      const methodBody = customFontContentCandidates[0]
      replacements.push({
        start: methodBody.start + 1,
        end: methodBody.start + 1,
        value: `
/* clarin-font-full-svg-embed */
if (${JSON.stringify(fontCatalog.map(entry => entry.cssFamily))}.includes(this.fontFace.family.replace(/^["']|["']$/g, ""))) {
  for (const __clarinFontUrl of this.urls) {
    try {
      const __clarinFontBuffer = await this.fetchFont(__clarinFontUrl);
      const __clarinFontBytes = new Uint8Array(__clarinFontBuffer);
      let __clarinFontBinary = "";
      for (let __clarinFontOffset = 0; __clarinFontOffset < __clarinFontBytes.length; __clarinFontOffset += 32768) {
        __clarinFontBinary += String.fromCharCode(...__clarinFontBytes.subarray(__clarinFontOffset, __clarinFontOffset + 32768));
      }
      return \`data:font/woff2;base64,\${btoa(__clarinFontBinary)}\`;
    } catch {}
  }
}
`,
      })
    } else if (customFontContentCandidates.length === 1) {
      const methodBody = customFontContentCandidates[0]
      const bodySource = source.slice(methodBody.start, methodBody.end)
      const legacyFamilies = JSON.stringify(fontCatalog.map(entry => entry.family))
      const namespacedFamilies = JSON.stringify(fontCatalog.map(entry => entry.cssFamily))
      const legacyOffset = bodySource.indexOf(legacyFamilies)
      if (legacyOffset >= 0) {
        replacements.push({
          start: methodBody.start + legacyOffset,
          end: methodBody.start + legacyOffset + legacyFamilies.length,
          value: namespacedFamilies,
        })
      }
      const unnormalizedFamilyCheck = `${namespacedFamilies}.includes(this.fontFace.family)`
      const familyCheckOffset = bodySource.indexOf(unnormalizedFamilyCheck)
      if (familyCheckOffset >= 0) {
        replacements.push({
          start: methodBody.start + familyCheckOffset,
          end: methodBody.start + familyCheckOffset + unnormalizedFamilyCheck.length,
          value: `${namespacedFamilies}.includes(this.fontFace.family.replace(/^["']|["']$/g, ""))`,
        })
      }
    }

    if (customFontLazyRegistrationCandidates.length > 1) throw new Error(`Se encontraron varios cargadores de fuentes en ${fileLabel}.`)
    if (customFontLazyRegistrationCandidates.length === 1) {
      const candidate = customFontLazyRegistrationCandidates[0]
      const candidateSource = source.slice(candidate.start, candidate.end)
      if (candidateSource.includes('clarin-font-lazy-registration')) {
        const marker = '/* clarin-font-lazy-registration */'
        const markerStart = candidate.start + candidateSource.indexOf(marker)
        replacements.push({ start: markerStart, end: markerStart + marker.length, value: '' })
        const patchedLoops = []
        visitAst(candidate.body, inner => {
          if (inner.type === 'ForOfStatement' && source.slice(inner.start, inner.end).includes('clarin-font-lazy-registration')) patchedLoops.push(inner)
        })
        if (patchedLoops.length !== 1) throw new Error(`No se pudo retirar el registro condicionado anterior en ${fileLabel}.`)
        const entryCalls = []
        visitAst(patchedLoops[0].right, inner => {
          if (inner.type === 'CallExpression'
            && inner.callee?.type === 'MemberExpression'
            && memberPropertyName(inner.callee) === 'entries') entryCalls.push(inner)
        })
        const alreadyRestored = patchedLoops[0].right?.type === 'CallExpression'
          && patchedLoops[0].right.callee?.type === 'MemberExpression'
          && memberPropertyName(patchedLoops[0].right.callee) === 'values'
        if (!alreadyRestored) {
          if (entryCalls.length !== 1) throw new Error(`No se pudo resolver el registro de fuentes anterior en ${fileLabel}.`)
          const registry = source.slice(entryCalls[0].callee.object.start, entryCalls[0].callee.object.end)
          replacements.push({
            start: patchedLoops[0].right.start,
            end: patchedLoops[0].right.end,
            value: `${registry}.values()`,
          })
        }
        customFontLazyRegistrations = 1
      }
    }

    if (fontPickerListCandidates.length > 1) throw new Error(`Se encontraron varios selectores ampliados de fuentes en ${fileLabel}.`)
    if (fontPickerListCandidates.length === 1) {
      const candidate = fontPickerListCandidates[0]
      const candidateSource = source.slice(candidate.start, candidate.end)
      for (const forbiddenLoaderMarker of [
        'clarin-font-preview-loader',
        'clarin-font-visible-loader-',
        'clarin-font-visible-observer-',
        '__clarinLoadFontOption',
        '__clarinLoadFontFully',
        'clarin-font-preview-retry',
      ]) {
        if (candidateSource.includes(forbiddenLoaderMarker)) {
          throw new Error(`El selector conserva una descarga tipográfica activada por interacción (${forbiddenLoaderMarker}) en ${fileLabel}.`)
        }
      }
      const resolveDescriptorMetadataSource = descriptor => {
        const iconProperty = descriptor.properties.find(property => property?.type === 'Property' && propertyName(property) === 'icon')
        const metadataMembers = []
        if (iconProperty?.value) {
          visitAst(iconProperty.value, inner => {
            if (inner.type !== 'MemberExpression') return
            const memberName = inner.computed ? staticString(inner.property) : inner.property?.name
            if (memberName === 'icon') metadataMembers.push(inner)
          })
        }
        if (metadataMembers.length !== 1) throw new Error(`No se pudo resolver el identificador minificado de metadata de fuentes en ${fileLabel}.`)
        return source.slice(metadataMembers[0].object.start, metadataMembers[0].object.end)
      }
      const ensureDescriptorDisplayLabel = (descriptor, metadataSource) => {
        const textProperty = descriptor.properties.find(property => property?.type === 'Property' && propertyName(property) === 'text')
        if (!textProperty?.value) throw new Error(`No se pudo resolver el nombre visible de fuentes en ${fileLabel}.`)
        const currentText = source.slice(textProperty.value.start, textProperty.value.end)
        const currentProperty = source.slice(textProperty.key.end, textProperty.end)
        if (!currentProperty.includes('clarin-font-display-label')) {
          replacements.push({
            start: textProperty.value.start,
            end: textProperty.value.end,
            value: `/* clarin-font-display-label */ ${metadataSource}.label ?? (${currentText})`,
          })
          fontPickerCategoryFilters = 1
        }
      }
      const findSearchMemoDependencies = callback => {
        const memoCandidates = []
        visitAst(candidate.body, inner => {
          if (inner.type !== 'CallExpression' || inner.arguments[1]?.type !== 'ArrayExpression' || !inner.arguments[0]) return
          if (inner.arguments[0].start <= callback.start && inner.arguments[0].end >= callback.end) memoCandidates.push(inner)
        })
        if (!memoCandidates.length) return null
        const shortest = Math.min(...memoCandidates.map(call => call.arguments[0].end - call.arguments[0].start))
        const matches = memoCandidates.filter(call => call.arguments[0].end - call.arguments[0].start === shortest)
        if (matches.length !== 1) throw new Error(`No se pudo resolver la dependencia del filtro de fuentes en ${fileLabel}.`)
        return matches[0].arguments[1]
      }
      if (!candidateSource.includes('clarin-font-category-filters')) {
        const stateCalls = []
        const descriptors = []
        const searchCallbacks = []
        const quickSearchCalls = []
        visitAst(candidate.body, inner => {
          if (inner.type === 'VariableDeclarator' && inner.init?.type === 'CallExpression' && staticString(inner.init.arguments[0]) === '') stateCalls.push({ declarator: inner, call: inner.init })
          if (inner.type === 'ObjectExpression') {
            const properties = inner.properties.filter(property => property?.type === 'Property')
            const names = new Set(properties.map(propertyName).filter(Boolean))
            if (names.has('value') && names.has('icon') && names.has('text') && properties.length <= 5) descriptors.push(inner)
            const placeholder = properties.find(property => propertyName(property) === 'placeholder')?.value
            if (placeholder?.type === 'CallExpression' && staticString(placeholder.arguments[0]) === 'quickSearch.placeholder') quickSearchCalls.push(inner)
          }
          if (inner.type === 'ArrowFunctionExpression' && inner.body?.type !== 'BlockStatement') {
            const body = source.slice(inner.body.start, inner.body.end)
            if (body.includes('.includes(') && body.includes('.text') && !searchCallbacks.some(candidateCallback => candidateCallback.start === inner.start)) searchCallbacks.push(inner)
          }
        })
        const searchStateIdentifier = stateCalls[0]?.declarator.id?.type === 'ArrayPattern' ? stateCalls[0].declarator.id.elements[0] : null
        const searchStateName = searchStateIdentifier ? source.slice(searchStateIdentifier.start, searchStateIdentifier.end) : ''
        const matchingSearchCallbacks = searchCallbacks.filter(callback => new RegExp(`\\b${searchStateName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\b`, 'u').test(source.slice(callback.body.start, callback.body.end)))
        const shortestSearchLength = Math.min(...matchingSearchCallbacks.map(callback => callback.body.end - callback.body.start))
        const directSearchCallbacks = matchingSearchCallbacks.filter(callback => callback.body.end - callback.body.start === shortestSearchLength)
        if (stateCalls.length !== 1 || descriptors.length !== 1 || directSearchCallbacks.length !== 1 || quickSearchCalls.length !== 1 || candidate.body.type !== 'BlockStatement') {
          throw new Error(`No se pudo resolver el filtro de fuentes en ${fileLabel}: state=${stateCalls.length}, descriptor=${descriptors.length}, search=${matchingSearchCallbacks.length}/${searchCallbacks.length}, quick=${quickSearchCalls.length}.`)
        }
        const stateCallee = source.slice(stateCalls[0].call.callee.start, stateCalls[0].call.callee.end)
        replacements.push({ start: candidate.body.start + 1, end: candidate.body.start + 1, value: `\nconst [__clarinFontCategory, __setClarinFontCategory] = ${stateCallee}("all");\n` })
        const metadataSource = resolveDescriptorMetadataSource(descriptors[0])
        ensureDescriptorDisplayLabel(descriptors[0], metadataSource)
        replacements.push({ start: descriptors[0].end - 1, end: descriptors[0].end - 1, value: `, category: ${metadataSource}.category || "official"` })
        const callback = directSearchCallbacks[0]
        const parameter = source.slice(callback.params[0].start, callback.params[0].end)
        const originalSearch = source.slice(callback.body.start, callback.body.end)
        replacements.push({ start: callback.body.start, end: callback.body.end, value: `(__clarinFontCategory === "all" || ${parameter}.category === __clarinFontCategory) && (${originalSearch})` })
        const dependencyArray = findSearchMemoDependencies(callback)
        if (!dependencyArray) throw new Error(`No se encontró el useMemo del filtro de fuentes en ${fileLabel}.`)
        replacements.push({ start: dependencyArray.end - 1, end: dependencyArray.end - 1, value: `${arrayInsertionSeparator(source, dependencyArray)}__clarinFontCategory` })
        const quickObject = quickSearchCalls[0]
        const quickCall = (() => {
          let found = null
          visitAst(candidate.body, inner => {
            if (found || inner.type !== 'CallExpression' || !inner.arguments.includes(quickObject)) return
            found = inner
          })
          return found
        })()
        if (!quickCall) throw new Error(`No se encontró el componente de búsqueda de fuentes en ${fileLabel}.`)
        const jsxFactory = source.slice(quickCall.callee.start, quickCall.callee.end)
        const categories = JSON.stringify([
          { id: 'all', label: 'Todas' }, { id: 'handwriting', label: 'Manuales' }, { id: 'display', label: 'Display' },
          { id: 'sans', label: 'Sans' }, { id: 'serif', label: 'Serif' }, { id: 'mono', label: 'Mono' },
        ])
        replacements.push({
          start: quickCall.start,
          end: quickCall.start,
          value: `/* clarin-font-category-filters */ ${jsxFactory}("div", { className: "clarin-font-category-filters", role: "group", "aria-label": "Filtrar fuentes", children: ${categories}.map((category) => ${jsxFactory}("button", { type: "button", className: "clarin-font-category-filter", "aria-pressed": __clarinFontCategory === category.id, onClick: () => __setClarinFontCategory(category.id), children: category.label }, category.id)) }), `,
        })
        const debounceCalls = []
        visitAst(quickObject, inner => {
          if (inner.type === 'CallExpression' && inner.arguments[1]?.type === 'Literal' && inner.arguments[1].value === 20) debounceCalls.push(inner)
        })
        if (debounceCalls.length !== 1) throw new Error(`No se encontró el debounce de búsqueda de fuentes en ${fileLabel}.`)
        replacements.push({ start: debounceCalls[0].arguments[1].start, end: debounceCalls[0].arguments[1].end, value: '500' })
        fontPickerCategoryFilters = 1
      } else {
        const patchedDescriptors = []
        visitAst(candidate.body, inner => {
          if (inner.type !== 'ObjectExpression') return
          const properties = inner.properties.filter(property => property?.type === 'Property')
          const names = new Set(properties.map(propertyName).filter(Boolean))
          if (names.has('value') && names.has('icon') && names.has('text') && names.has('category') && properties.length <= 6) patchedDescriptors.push(inner)
        })
        if (patchedDescriptors.length !== 1) throw new Error(`No se pudo resolver el descriptor ya parcheado de fuentes en ${fileLabel}.`)
        const metadataSource = resolveDescriptorMetadataSource(patchedDescriptors[0])
        ensureDescriptorDisplayLabel(patchedDescriptors[0], metadataSource)
        const categoryProperty = patchedDescriptors[0].properties.find(property => property?.type === 'Property' && propertyName(property) === 'category')
        const categoryObject = categoryProperty?.value?.type === 'LogicalExpression' && categoryProperty.value.left?.type === 'MemberExpression'
          ? categoryProperty.value.left.object
          : null
        if (!categoryObject) throw new Error(`No se pudo validar la categoría ya parcheada de fuentes en ${fileLabel}.`)
        if (source.slice(categoryObject.start, categoryObject.end) !== metadataSource) {
          replacements.push({ start: categoryObject.start, end: categoryObject.end, value: metadataSource })
          fontPickerCategoryFilters = 1
        }
        const patchedCallbacks = []
        visitAst(candidate.body, inner => {
          if (inner.type !== 'ArrowFunctionExpression' || inner.body?.type === 'BlockStatement') return
          const body = source.slice(inner.body.start, inner.body.end)
          if (body.includes('__clarinFontCategory') && body.includes('.includes(') && body.includes('.text')) patchedCallbacks.push(inner)
        })
        const shortestPatchedLength = Math.min(...patchedCallbacks.map(callback => callback.body.end - callback.body.start))
        const directPatchedCallbacks = patchedCallbacks.filter(callback => callback.body.end - callback.body.start === shortestPatchedLength)
        if (directPatchedCallbacks.length !== 1) throw new Error(`No se pudo actualizar la dependencia del filtro de fuentes en ${fileLabel}.`)
        const dependencyArray = findSearchMemoDependencies(directPatchedCallbacks[0])
        if (!dependencyArray) throw new Error(`No se encontró el useMemo ya parcheado en ${fileLabel}.`)
        const hasCategoryDependency = dependencyArray.elements.some(element => element?.type === 'Identifier' && element.name === '__clarinFontCategory')
        if (!hasCategoryDependency) {
          replacements.push({ start: dependencyArray.end - 1, end: dependencyArray.end - 1, value: `${arrayInsertionSeparator(source, dependencyArray)}__clarinFontCategory` })
          fontPickerCategoryFilters = 1
        }
      }
    }

    if (fontPickerTriggerCandidates.length > 1) throw new Error(`Se encontraron varios disparadores del catálogo de fuentes en ${fileLabel}.`)
    if (fontPickerTriggerCandidates.length === 1) {
      const triggerObjects = []
      visitAst(fontPickerTriggerCandidates[0].body, inner => {
        if (inner.type !== 'ObjectExpression') return
        const properties = inner.properties.filter(property => property?.type === 'Property')
        if (staticString(properties.find(property => propertyName(property) === 'testId')?.value) === 'font-family-show-fonts') triggerObjects.push({ node: inner, properties })
      })
      if (triggerObjects.length !== 1) throw new Error(`No se pudo resolver el botón Más fuentes en ${fileLabel}.`)
      const trigger = triggerObjects[0]
      const title = trigger.properties.find(property => propertyName(property) === 'title')
      const ariaLabel = trigger.properties.find(property => propertyName(property) === 'aria-label')
      if (!title) throw new Error(`El botón Más fuentes perdió su título en ${fileLabel}.`)
      if (staticString(title.value) !== 'Más fuentes · 32') replacements.push({ start: title.value.start, end: title.value.end, value: JSON.stringify('Más fuentes · 32') })
      if (!ariaLabel) replacements.push({ start: trigger.node.start + 1, end: trigger.node.start + 1, value: `${JSON.stringify('aria-label')}: ${JSON.stringify('Más fuentes · 32')}, ` })
      fontPickerTriggers = 1
    }

    if (buttonIconAccessibilityCandidates.length > 1) throw new Error(`Se encontraron varios componentes ButtonIcon en ${fileLabel}.`)
    if (buttonIconAccessibilityCandidates.length === 1) {
      const candidate = buttonIconAccessibilityCandidates[0]
      const ariaLabel = candidate.properties.find(property => propertyName(property) === 'aria-label')
      const titleExpression = source.slice(candidate.title.value.start, candidate.title.value.end)
      if (!ariaLabel) {
        replacements.push({
          start: candidate.node.start + 1,
          end: candidate.node.start + 1,
          value: `/* clarin-button-icon-label */ "aria-label": ${titleExpression}, `,
        })
        buttonIconAccessibilityLabels = 1
      } else if (source.slice(ariaLabel.value.start, ariaLabel.value.end) !== titleExpression) {
        throw new Error(`ButtonIcon perdió su nombre accesible en ${fileLabel}.`)
      }
    }
  }

  if (strokeWidthOptionCandidates.length > 0) {
    if (strokeWidthOptionCandidates.length !== 1) {
      throw new Error(`No se pudo resolver de forma unívoca el selector de grosor en ${fileLabel}: ${strokeWidthOptionCandidates.length} candidatos.`)
    }
    const candidate = strokeWidthOptionCandidates[0]
    const existing = candidate.options.find(option => option.testID === 'strokeWidth-ultraBold')
    if (existing) {
      const value = existing.properties.find(property => propertyName(property) === 'value')?.value
      const text = existing.properties.find(property => propertyName(property) === 'text')?.value
      if (value?.type !== 'Literal' || value.value !== 8 || staticString(text) !== 'Muy grueso') {
        throw new Error(`El nivel máximo de grosor existente no coincide con el contrato de Clarin en ${fileLabel}.`)
      }
    } else {
      const extraBold = candidate.options.find(option => option.testID === 'strokeWidth-extraBold')
      const icon = extraBold?.properties.find(property => propertyName(property) === 'icon')?.value
      if (!icon) throw new Error(`No se encontró el icono nativo de grosor máximo en ${fileLabel}.`)
      const lastElement = candidate.node.elements.at(-1)
      const trailingSource = lastElement
        ? source.slice(lastElement.end, candidate.node.end - 1)
        : ''
      const separator = trailingSource.includes(',') ? '' : ','
      replacements.push({
        start: candidate.node.end - 1,
        end: candidate.node.end - 1,
        value: `${separator} /* clarin-ultra-bold-stroke */ {
          value: 8,
          text: "Muy grueso",
          icon: ${source.slice(icon.start, icon.end)},
          testId: "strokeWidth-ultraBold"
        }`,
      })
      ultraBoldStrokeWidths = 1
    }
  }

  if (hasHighlighterMenu) {
    if (highlighterMenuCandidates.length !== 1 || existingHighlighterIconValues.length !== 1) {
      throw new Error(`No se pudo verificar el icono nativo de Resaltador en ${fileLabel}: laser=${highlighterMenuCandidates.length}, highlighter=${existingHighlighterIconValues.length}.`)
    }
    const desiredIcon = highlighterMenuCandidates[0].icon
    const currentIcon = existingHighlighterIconValues[0]
    if (source.slice(currentIcon.start, currentIcon.end) !== desiredIcon) {
      replacements.push({ start: currentIcon.start, end: currentIcon.end, value: desiredIcon })
    }
  }

  if (!hasHighlighterMenu && highlighterMenuCandidates.length > 0) {
    if (highlighterMenuCandidates.length !== 1
      || highlighterLifecycleCandidates.length !== 1
      || highlighterTriggerCandidates.length !== 1
      || generateSectionCandidates.length !== 1) {
      throw new Error(`No se pudo resolver de forma unívoca el parche nativo de Resaltador en ${fileLabel}: menus=${highlighterMenuCandidates.length}, lifecycle=${highlighterLifecycleCandidates.length}, triggers=${highlighterTriggerCandidates.length}, generate=${generateSectionCandidates.length}.`)
    }
    const menu = highlighterMenuCandidates[0]
    replacements.push({
      start: menu.call.end,
      end: menu.call.end,
      value: `, /* clarin-highlighter */ ${menu.helper}(${menu.component}, {
        onSelect: () => {
          ${menu.receiver}.__clarinHighlighterRequested = true;
          ${menu.receiver}.setActiveTool({ type: "freedraw" });
        },
        icon: ${menu.icon},
        className: "clarin-highlighter-tool",
        "data-testid": "toolbar-highlighter",
        selected: ${menu.receiver}.__clarinHighlighterActive === true && ${menu.receiver}.state.activeTool.type === "freedraw",
        "aria-pressed": ${menu.receiver}.__clarinHighlighterActive === true && ${menu.receiver}.state.activeTool.type === "freedraw",
        children: "Resaltador"
      })`,
    })
    highlighterMenus = 1

    const lifecycle = highlighterLifecycleCandidates[0]
    replacements.push({
      start: lifecycle.start + 1,
      end: lifecycle.start + 1,
      value: `
      const __clarinHighlighterRequested = this.__clarinHighlighterRequested === true;
      this.__clarinHighlighterRequested = false;
      if (this.__clarinHighlighterActive === true && !__clarinHighlighterRequested) {
        this.__clarinHighlighterStyles = {
          currentItemStrokeColor: this.state.currentItemStrokeColor,
          currentItemStrokeWidth: this.state.currentItemStrokeWidth,
          currentItemStrokeVariability: this.state.currentItemStrokeVariability,
          currentItemOpacity: this.state.currentItemOpacity,
          currentItemRoughness: this.state.currentItemRoughness,
          currentItemStrokeStyle: this.state.currentItemStrokeStyle
        };
        this.__clarinHighlighterActive = false;
        if (this.__clarinDrawStyles) this.setState(this.__clarinDrawStyles);
      }
      if (__clarinHighlighterRequested) {
        if (this.__clarinHighlighterActive !== true) {
          this.__clarinDrawStyles = {
            currentItemStrokeColor: this.state.currentItemStrokeColor,
            currentItemStrokeWidth: this.state.currentItemStrokeWidth,
            currentItemStrokeVariability: this.state.currentItemStrokeVariability,
            currentItemOpacity: this.state.currentItemOpacity,
            currentItemRoughness: this.state.currentItemRoughness,
            currentItemStrokeStyle: this.state.currentItemStrokeStyle
          };
          this.__clarinHighlighterActive = true;
          this.setState(this.__clarinHighlighterStyles || {
            currentItemStrokeColor: "#FFD43B",
            currentItemStrokeWidth: 4,
            currentItemStrokeVariability: "constant",
            currentItemOpacity: 40,
            currentItemRoughness: 0,
            currentItemStrokeStyle: "solid"
          });
        }
      }
      `,
    })
    highlighterToolLifecycles = 1

    const trigger = highlighterTriggerCandidates[0]
    const originalTrigger = source.slice(trigger.value.start, trigger.value.end)
    replacements.push({
      start: trigger.value.start,
      end: trigger.value.end,
      value: `(${menu.receiver}.__clarinHighlighterActive === true && ${menu.receiver}.state.activeTool.type === "freedraw") || (${originalTrigger})`,
    })

    const generateSection = generateSectionCandidates[0]
    replacements.push({ start: generateSection.start, end: generateSection.end, value: 'null' })
    hiddenGenerateSections = 1
  }

  const hardened = applyReplacements(source, replacements)
  assertNoProhibitedRoutes(hardened, fileLabel, { parseJs: true, strictExternalHosts: true })
  return {
    customFontFamilyCatalogs,
    customFontLazyRegistrations,
    customFontMetadataCatalogs,
    customFontRegistrations,
    buttonIconAccessibilityLabels,
    disabledRoutes,
    fontPickerCategoryFilters,
    fontPickerVisiblePreviews,
    fontPickerTriggers,
    hardened,
    hiddenGenerateSections,
    highlighterMenus,
    highlighterToolLifecycles,
    libraryBrowseRoutes,
    localFallbacks,
    rewrittenLibraryBrowseMessages,
    securedLibraryBrowseTargets,
    ultraBoldStrokeWidths,
  }
}

async function assertNodeSyntax(file) {
  await execFileAsync(process.execPath, ['--check', file], { maxBuffer: 2 * 1024 * 1024 })
}

export async function hardenJavaScriptTree(root, { fontCatalog = [] } = {}) {
  const files = await walkFiles(root, path => extname(path) === '.js')
  let disabledRoutes = 0
  let libraryBrowseRoutes = 0
  let localFallbacks = 0
  let rewrittenLibraryBrowseMessages = 0
  let securedLibraryBrowseTargets = 0
  let hiddenGenerateSections = 0
  let highlighterMenus = 0
  let highlighterToolLifecycles = 0
  let ultraBoldStrokeWidths = 0
  let customFontFamilyCatalogs = 0
  let customFontLazyRegistrations = 0
  let customFontMetadataCatalogs = 0
  let customFontRegistrations = 0
  let fontPickerCategoryFilters = 0
  let fontPickerVisiblePreviews = 0
  let fontPickerTriggers = 0
  let buttonIconAccessibilityLabels = 0
  for (const file of files) {
    const original = await readFile(file, 'utf8')
    const result = hardenEditorBundle(original, file, fontCatalog)
    customFontFamilyCatalogs += result.customFontFamilyCatalogs
    customFontLazyRegistrations += result.customFontLazyRegistrations
    customFontMetadataCatalogs += result.customFontMetadataCatalogs
    customFontRegistrations += result.customFontRegistrations
    buttonIconAccessibilityLabels += result.buttonIconAccessibilityLabels
    disabledRoutes += result.disabledRoutes
    libraryBrowseRoutes += result.libraryBrowseRoutes
    localFallbacks += result.localFallbacks
    rewrittenLibraryBrowseMessages += result.rewrittenLibraryBrowseMessages
    securedLibraryBrowseTargets += result.securedLibraryBrowseTargets
    hiddenGenerateSections += result.hiddenGenerateSections
    highlighterMenus += result.highlighterMenus
    highlighterToolLifecycles += result.highlighterToolLifecycles
    ultraBoldStrokeWidths += result.ultraBoldStrokeWidths
    fontPickerCategoryFilters += result.fontPickerCategoryFilters
    fontPickerVisiblePreviews += result.fontPickerVisiblePreviews
    fontPickerTriggers += result.fontPickerTriggers
    if (result.hardened !== original) await writeFile(file, result.hardened)
    await assertNodeSyntax(file)
  }

  const maps = await walkFiles(root, path => extname(path) === '.map')
  for (const file of maps) {
    const sourceMap = JSON.parse(await readFile(file, 'utf8'))
    delete sourceMap.sourcesContent
    await writeFile(file, JSON.stringify(sourceMap))
  }

  return {
    customFontFamilyCatalogs,
    customFontLazyRegistrations,
    customFontMetadataCatalogs,
    customFontRegistrations,
    buttonIconAccessibilityLabels,
    disabledRoutes,
    files: files.length,
    hiddenGenerateSections,
    highlighterMenus,
    highlighterToolLifecycles,
    fontPickerCategoryFilters,
    fontPickerVisiblePreviews,
    fontPickerTriggers,
    libraryBrowseRoutes,
    localFallbacks,
    maps: maps.length,
    rewrittenLibraryBrowseMessages,
    securedLibraryBrowseTargets,
    ultraBoldStrokeWidths,
  }
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
