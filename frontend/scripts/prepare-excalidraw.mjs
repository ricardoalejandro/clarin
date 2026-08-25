import { build } from 'esbuild'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parse } from 'acorn'
import {
  EXPECTED_EDITOR_VERSION,
  hardenJavaScriptTree,
  LOCAL_EDITOR_ASSET_PATH,
  verifyArtifactTree,
  walkFiles,
} from './excalidraw-hardening.mjs'
import {
  loadWhiteboardFontCatalog,
  runtimeWhiteboardFontCatalog,
  verifyWhiteboardFontCatalog,
} from './whiteboard-font-catalog.mjs'
import { buildExcalidrawFork } from './build-excalidraw-fork.mjs'

await buildExcalidrawFork()
const packageRoot = join(process.cwd(), 'node_modules', '@excalidraw', 'excalidraw')
const packageJSON = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
if (packageJSON.version !== EXPECTED_EDITOR_VERSION) {
  throw new Error(`Versión inesperada del motor de Pizarras: ${packageJSON.version}; se requiere ${EXPECTED_EDITOR_VERSION}`)
}

const destinationRoot = join(process.cwd(), 'public', LOCAL_EDITOR_ASSET_PATH)
const sourceFonts = join(packageRoot, 'dist', 'prod', 'fonts')
const { catalog: whiteboardFontCatalog, root: whiteboardFontRoot } = await loadWhiteboardFontCatalog()
const verifiedFontCatalog = await verifyWhiteboardFontCatalog(whiteboardFontCatalog, whiteboardFontRoot)
const runtimeFontCatalog = runtimeWhiteboardFontCatalog(whiteboardFontCatalog)
await rm(destinationRoot, { recursive: true, force: true })
await mkdir(dirname(destinationRoot), { recursive: true })
await cp(sourceFonts, join(destinationRoot, 'fonts'), { recursive: true })
await cp(join(whiteboardFontRoot, 'fonts', 'Clarin'), join(destinationRoot, 'fonts', 'Clarin'), { recursive: true })
await cp(join(whiteboardFontRoot, 'licenses'), join(destinationRoot, 'CLARIN-FONT-LICENSES'), { recursive: true })
const notice = await readFile(join(process.cwd(), 'THIRD_PARTY_EXCALIDRAW.md'), 'utf8')
const license = notice.match(/## Licencia del editor\s+([\s\S]*?)\s+Fuente:/u)?.[1]
if (!license) throw new Error('No se pudo extraer la licencia MIT del aviso de terceros.')
await writeFile(join(destinationRoot, 'LICENSE'), `${license.trim()}\n`)
await writeFile(join(destinationRoot, 'NOTICE.md'), notice)
for (const legalFile of ['FONT-NOTICES.md', 'OFL-1.1.txt', 'COMIC-SHANNS-MIT.txt']) {
  await cp(join(process.cwd(), 'third_party', 'excalidraw', legalFile), join(destinationRoot, legalFile))
}
const publicFontCatalog = {
  ...whiteboardFontCatalog,
  entries: whiteboardFontCatalog.entries.map(entry => ({
    ...entry,
    fontFaces: entry.fontFaces.map(({ sourceURL: _sourceURL, ...face }) => face),
    origin: {
      provider: entry.origin.provider,
      repository: entry.origin.repository,
      repositoryPath: entry.origin.repositoryPath,
      commit: entry.origin.commit,
    },
  })),
}
await writeFile(join(destinationRoot, 'CLARIN-FONT-CATALOG.json'), `${JSON.stringify(publicFontCatalog, null, 2)}\n`)
await writeFile(join(destinationRoot, 'CLARIN-FONT-NOTICES.md'), `# Fuentes locales de Pizarras\n\nLas ${verifiedFontCatalog.customFonts} familias adicionales se sirven exclusivamente desde Clarin. Sus archivos, hashes, métricas, origen inmutable y licencias están inventariados en \`CLARIN-FONT-CATALOG.json\`.\n\n${whiteboardFontCatalog.entries.map(entry => `- ${entry.family} (ID ${entry.id}): ${entry.license.spdx}; \`${entry.license.file}\`; Google Fonts \`${entry.origin.repositoryPath}\` @ \`${entry.origin.commit}\`.`).join('\n')}\n`)

const assetFiles = await walkFiles(destinationRoot)
if (!assetFiles.length) throw new Error('No se copiaron los assets locales del motor de Pizarras.')
await writeFile(join(destinationRoot, 'manifest.json'), `${JSON.stringify({
  engineVersion: EXPECTED_EDITOR_VERSION,
  assetBase: LOCAL_EDITOR_ASSET_PATH,
  files: assetFiles.length,
}, null, 2)}\n`)

let disabledRoutes = 0
let hardenedFiles = 0
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
let strippedMaps = 0
for (const target of ['dev', 'prod']) {
  const result = await hardenJavaScriptTree(join(packageRoot, 'dist', target), { fontCatalog: runtimeFontCatalog })
  customFontFamilyCatalogs += result.customFontFamilyCatalogs
  customFontLazyRegistrations += result.customFontLazyRegistrations
  customFontMetadataCatalogs += result.customFontMetadataCatalogs
  customFontRegistrations += result.customFontRegistrations
  disabledRoutes += result.disabledRoutes
  hardenedFiles += result.files
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
  buttonIconAccessibilityLabels += result.buttonIconAccessibilityLabels
  strippedMaps += result.maps
}

// A clean install patches exactly one development and one production editor
// entrypoint. Re-running prepare is intentionally idempotent, so an already
// patched tree reports zero new injections but is verified below by content.
const editorEntrypoints = await Promise.all(['dev', 'prod'].map(target => readFile(join(packageRoot, 'dist', target, 'index.js'), 'utf8')))
for (const [index, source] of editorEntrypoints.entries()) {
  if (!source.includes('toolbar-highlighter') || !source.includes('__clarinHighlighterRequested')) {
    throw new Error(`El bundle ${index === 0 ? 'dev' : 'prod'} no contiene el Resaltador nativo completo.`)
  }
  const ultraBoldOptions = source.match(/strokeWidth-ultraBold/gu) || []
  if (ultraBoldOptions.length !== 1 || !source.includes('clarin-ultra-bold-stroke')) {
    throw new Error(`El bundle ${index === 0 ? 'dev' : 'prod'} no contiene exactamente un cuarto nivel de grosor.`)
  }
}
for (const target of ['dev', 'prod']) {
  const javascript = await Promise.all((await walkFiles(join(packageRoot, 'dist', target), file => file.endsWith('.js'))).map(file => readFile(file, 'utf8')))
  const combined = javascript.join('\n')
  for (const [marker, count] of Object.entries({ 'clarin-font-catalog': 1, 'clarin-font-metadata': 1, 'clarin-font-registration': 1, 'clarin-font-category-filters': 2, 'clarin-font-display-label': 1, 'clarin-font-full-svg-embed': 1, 'clarin-button-icon-label': 1 })) {
    if ((combined.match(new RegExp(marker, 'gu')) || []).length !== count) throw new Error(`El bundle ${target} no contiene exactamente un parche ${marker}.`)
  }
  for (const forbiddenLoaderMarker of ['clarin-font-visible-loader-', 'clarin-font-visible-observer-', 'clarin-font-preview-loader', 'clarin-font-lazy-preview', '__clarinLoadFontOption', '__clarinLoadFontFully', 'clarin-font-preview-retry']) {
    if (combined.includes(forbiddenLoaderMarker)) throw new Error(`El bundle ${target} conserva una descarga tipográfica disparada por el selector (${forbiddenLoaderMarker}).`)
  }
  if (!combined.includes('Más fuentes · 32')) throw new Error(`El bundle ${target} no expone el catálogo completo de 32 fuentes.`)
  for (const entry of runtimeFontCatalog) {
    if (!combined.includes(`${JSON.stringify(entry.cssFamily)}: ${entry.id}`) && !combined.includes(`${JSON.stringify(entry.cssFamily)}:${entry.id}`)) throw new Error(`El bundle ${target} no conserva el ID ${entry.id} de ${entry.family}.`)
  }
}
if (highlighterMenus < 0 || highlighterMenus > 2
  || highlighterMenus !== highlighterToolLifecycles
  || highlighterMenus !== hiddenGenerateSections) {
  throw new Error('El parche del Resaltador no fue idempotente o no alcanzó ambos bundles del editor.')
}
if (ultraBoldStrokeWidths < 0 || ultraBoldStrokeWidths > 2) {
  throw new Error('El parche de grosor máximo no fue idempotente o alcanzó bundles inesperados.')
}
for (const [label, value] of Object.entries({ customFontFamilyCatalogs, customFontMetadataCatalogs, customFontRegistrations, fontPickerCategoryFilters })) {
  if (value < 0 || value > 2) throw new Error(`El parche ${label} no fue idempotente o alcanzó bundles inesperados.`)
}
if (fontPickerTriggers !== 2) throw new Error('No se verificó el disparador Más fuentes en desarrollo y producción.')
if (buttonIconAccessibilityLabels < 0 || buttonIconAccessibilityLabels > 2) throw new Error('El parche accesible de ButtonIcon no fue idempotente.')

// A production build must never reuse or retain a chunk compiled before the
// local hardening pass. `.next` is generated output and is rebuilt immediately.
if (process.argv.includes('--clean-next')) {
  await rm(join(process.cwd(), '.next'), { recursive: true, force: true })
}

const smoke = await build({
  bundle: true,
  entryPoints: [join(packageRoot, 'dist', 'prod', 'index.js')],
  format: 'esm',
  logLevel: 'silent',
  platform: 'browser',
  write: false,
})
if (!smoke.outputFiles.length) throw new Error('El smoke bundle del motor de Pizarras no produjo salida.')
parse(smoke.outputFiles[0].text, { ecmaVersion: 'latest', sourceType: 'module' })

await verifyArtifactTree(join(packageRoot, 'dist'), { strictExternalHosts: true })
await verifyArtifactTree(destinationRoot, { strictExternalHosts: true })

console.log(
  `Motor de Pizarras ${EXPECTED_EDITOR_VERSION}: ${assetFiles.length} assets locales, ${hardenedFiles} bundles y ${strippedMaps} mapas verificados; catálogo de ${verifiedFontCatalog.totalSelectableFonts} fuentes (${verifiedFontCatalog.fontFaces} WOFF2 Clarin) verificado; ${disabledRoutes} rutas y ${localFallbacks} fallbacks neutralizados; ${libraryBrowseRoutes} rutas de exploración delegadas a Clarin, ${rewrittenLibraryBrowseMessages} mensajes de seguridad adaptados y ${securedLibraryBrowseTargets} destinos asegurados; Resaltador nativo verificado (${highlighterMenus} menús, ${highlighterToolLifecycles} ciclos y ${hiddenGenerateSections} secciones vacías corregidas); grosor máximo nativo verificado (${ultraBoldStrokeWidths} inserciones en esta ejecución).`,
)
