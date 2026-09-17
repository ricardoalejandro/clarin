import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = path.join(root, 'src')
const entry = path.join(sourceRoot, 'offline-v4', 'entry.tsx')
const recoveryEntry = path.join(sourceRoot, 'offline-v4', 'recovery.ts')
const outputRoot = path.join(root, 'public', 'offline-v4')
const buildID = (process.env.NEXT_PUBLIC_BUILD_VERSION || 'dev').trim() || 'dev'
const appOrigin = new URL(process.env.NEXT_PUBLIC_APP_URL || 'https://clarin.naperu.cloud').origin
const whiteboardVersion = '0.18.1-clarin.7'

async function assertNoNextRuntimeImports(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  for (const item of entries) {
    const absolute = path.join(directory, item.name)
    if (item.isDirectory()) await assertNoNextRuntimeImports(absolute)
    else if (/\.(?:ts|tsx)$/.test(item.name)) {
      const source = await fs.readFile(absolute, 'utf8')
      if (/\b(?:from|import\s*)\s*\(?\s*['"]next(?:\/|['"])/.test(source)) {
        throw new Error(`offline-v4 cannot import Next runtime: ${path.relative(root, absolute)}`)
      }
    }
  }
}

await Promise.all([
  assertNoNextRuntimeImports(path.join(sourceRoot, 'offline-v4')),
  assertNoNextRuntimeImports(path.join(sourceRoot, 'components', 'offline-v4')),
])

if (outputRoot !== path.join(root, 'public', 'offline-v4')) throw new Error('refusing to clean an unexpected offline-v4 output path')
await fs.rm(outputRoot, { recursive: true, force: true })

// The SharedWorker URL is stable; its exact bytes are included in the same verified manifest.
const worker = await build({
  entryPoints: [path.join(sourceRoot, 'offline-v4', 'worker.ts')],
  outfile: path.join(outputRoot, 'worker.js'), bundle: true, format: 'esm',
  platform: 'browser', target: ['chrome110', 'edge110'], minify: true,
  sourcemap: false, metafile: true, tsconfig: path.join(root, 'tsconfig.json'),
  define: { __CLARIN_OFFLINE_BUILD__: JSON.stringify(buildID), 'process.env.NODE_ENV': JSON.stringify('production') },
})

const result = await build({
  entryPoints: { runtime: entry, recovery: recoveryEntry },
  outdir: outputRoot,
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome110', 'edge110'],
  jsx: 'automatic',
  jsxImportSource: 'react',
  entryNames: 'assets/[name]-[hash]',
  chunkNames: 'assets/chunk-[name]-[hash]',
  assetNames: 'assets/[name]-[hash]',
  minify: true,
  sourcemap: false,
  metafile: true,
  legalComments: 'none',
  define: {
    __CLARIN_OFFLINE_BUILD__: JSON.stringify(buildID),
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  tsconfig: path.join(root, 'tsconfig.json'),
})

for (const input of Object.keys({ ...worker.metafile.inputs, ...result.metafile.inputs })) {
  const normalized = input.split(path.sep).join('/')
  if (normalized.includes('/node_modules/next/') || /(?:^|\/)next(?:\/|$)/.test(normalized)) {
    throw new Error(`offline-v4 transitively imported the Next runtime: ${input}`)
  }
}

const outputEntries = Object.entries(result.metafile.outputs)
const javascript = outputEntries.find(([, meta]) => path.resolve(root, meta.entryPoint || '') === entry && meta.exports.length >= 0 && meta.entryPoint)?.[0]
const recoveryJavascript = outputEntries.find(([, meta]) => path.resolve(root, meta.entryPoint || '') === recoveryEntry && meta.entryPoint)?.[0]
const css = outputEntries.find(([filename]) => filename.endsWith('.css'))?.[0]
if (!javascript || !recoveryJavascript || !css) throw new Error('offline-v4 build did not produce its JavaScript, recovery and CSS assets')

const publicURL = filename => `/${path.relative(path.join(root, 'public'), path.resolve(root, filename)).split(path.sep).join('/')}`
const scriptURL = publicURL(javascript)
const recoveryScriptURL = publicURL(recoveryJavascript)
const styleURL = publicURL(css)
const html = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#0f172a">
  <meta name="robots" content="noindex,nofollow">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:; worker-src 'self'; base-uri 'none'; form-action 'self'">
  <title>Clarin · Modo offline</title>
  <link rel="icon" href="/favicon.svg">
  <link rel="stylesheet" href="${styleURL}">
</head>
<body>
  <div id="clarin-offline-root"></div>
  <script type="module" src="${recoveryScriptURL}"></script>
  <script type="module" src="${scriptURL}"></script>
</body>
</html>`
await fs.writeFile(path.join(outputRoot, 'index.html'), html)

// The lazy read-only renderer uses the exact existing audited Clarin engine.
// Its fonts and license notices must survive browser restart without requests
// to an external CDN or to a non-cached online-only vendor route.
const whiteboardSource = path.join(root, 'public/vendor/whiteboards-editor', whiteboardVersion)
const whiteboardManifest = JSON.parse(await fs.readFile(path.join(whiteboardSource, 'manifest.json'), 'utf8'))
if (whiteboardManifest.engineVersion !== whiteboardVersion) throw new Error('Offline whiteboard asset version mismatch')
const whiteboardOutput = path.join(outputRoot, 'whiteboard-assets')
await fs.cp(whiteboardSource, whiteboardOutput, { recursive: true, errorOnExist: true, force: false })
async function generatedFiles(directory) {
  const paths = []
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, item.name)
    if (item.isDirectory()) paths.push(...await generatedFiles(absolute))
    else if (item.isFile()) paths.push(absolute)
    else throw new Error('Unexpected whiteboard asset entry')
  }
  return paths
}

const contentType = filename => filename.endsWith('.js') ? 'application/javascript' : filename.endsWith('.css') ? 'text/css' : filename.endsWith('.html') ? 'text/html' : 'application/octet-stream'
const artifactPaths = [path.join(outputRoot, 'worker.js'), path.join(outputRoot, 'index.html'), ...outputEntries.map(([filename]) => path.resolve(root, filename)), ...await generatedFiles(whiteboardOutput)]
const assets = []
for (const filename of [...new Set(artifactPaths)]) {
  const bytes = await fs.readFile(filename)
  assets.push({
    url: publicURL(filename),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.byteLength,
    content_type: contentType(filename),
  })
}
assets.sort((left, right) => left.url.localeCompare(right.url))

await fs.writeFile(path.join(outputRoot, 'manifest.json'), `${JSON.stringify({
  protocol_version: 4,
  build_id: buildID,
  built_at: new Date().toISOString(),
  app_origin: appOrigin,
  shell: '/offline-v4/index.html',
  assets,
}, null, 2)}\n`)

const totalBytes = assets.reduce((sum, asset) => sum + asset.bytes, 0)
if (totalBytes > 32 * 1024 * 1024) throw new Error(`offline-v4 public shell exceeds 32 MiB (${totalBytes} bytes)`)
process.stdout.write(`offline-v4 shell ${buildID}: ${assets.length} assets, ${totalBytes} bytes\n`)
