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

const packageRoot = join(process.cwd(), 'node_modules', '@excalidraw', 'excalidraw')
const packageJSON = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
if (packageJSON.version !== EXPECTED_EDITOR_VERSION) {
  throw new Error(`Versión inesperada del motor de Pizarras: ${packageJSON.version}; se requiere ${EXPECTED_EDITOR_VERSION}`)
}

const destinationRoot = join(process.cwd(), 'public', LOCAL_EDITOR_ASSET_PATH)
const sourceFonts = join(packageRoot, 'dist', 'prod', 'fonts')
await rm(destinationRoot, { recursive: true, force: true })
await mkdir(dirname(destinationRoot), { recursive: true })
await cp(sourceFonts, join(destinationRoot, 'fonts'), { recursive: true })
const notice = await readFile(join(process.cwd(), 'THIRD_PARTY_EXCALIDRAW.md'), 'utf8')
const license = notice.match(/## Licencia del editor\s+([\s\S]*?)\s+Fuente:/u)?.[1]
if (!license) throw new Error('No se pudo extraer la licencia MIT del aviso de terceros.')
await writeFile(join(destinationRoot, 'LICENSE'), `${license.trim()}\n`)
await writeFile(join(destinationRoot, 'NOTICE.md'), notice)
for (const legalFile of ['FONT-NOTICES.md', 'OFL-1.1.txt', 'COMIC-SHANNS-MIT.txt']) {
  await cp(join(process.cwd(), 'third_party', 'excalidraw', legalFile), join(destinationRoot, legalFile))
}

const assetFiles = await walkFiles(destinationRoot)
if (!assetFiles.length) throw new Error('No se copiaron los assets locales del motor de Pizarras.')
await writeFile(join(destinationRoot, 'manifest.json'), `${JSON.stringify({
  engineVersion: EXPECTED_EDITOR_VERSION,
  assetBase: LOCAL_EDITOR_ASSET_PATH,
  files: assetFiles.length,
}, null, 2)}\n`)

let disabledRoutes = 0
let hardenedFiles = 0
let localFallbacks = 0
let strippedMaps = 0
for (const target of ['dev', 'prod']) {
  const result = await hardenJavaScriptTree(join(packageRoot, 'dist', target))
  disabledRoutes += result.disabledRoutes
  hardenedFiles += result.files
  localFallbacks += result.localFallbacks
  strippedMaps += result.maps
}

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
  `Motor de Pizarras ${EXPECTED_EDITOR_VERSION}: ${assetFiles.length} assets locales, ${hardenedFiles} bundles y ${strippedMaps} mapas verificados; ${disabledRoutes} rutas y ${localFallbacks} fallbacks neutralizados en esta ejecución.`,
)
