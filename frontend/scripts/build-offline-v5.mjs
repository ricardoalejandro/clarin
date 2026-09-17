import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const nextRoot = path.join(root, '.next')
const outputRoot = path.join(root, 'public', 'offline-v5')
const buildID = (process.env.NEXT_PUBLIC_BUILD_VERSION || 'dev').trim() || 'dev'
const appOrigin = new URL(process.env.NEXT_PUBLIC_APP_URL || 'https://clarin.naperu.cloud').origin
const whiteboardVersion = '0.18.1-clarin.7'
const maximumBytes = 64 * 1024 * 1024

const routeSources = {
  login: 'login',
  dashboard: 'dashboard',
  tasks: 'dashboard/tasks',
  contacts: 'dashboard/contacts',
  programs: 'dashboard/programs',
  whiteboards: 'dashboard/whiteboards',
  program_detail: 'dashboard/offline-v5-program',
  whiteboard_detail: 'dashboard/offline-v5-whiteboard',
}

async function exists(filename) {
  try { await fs.access(filename); return true } catch { return false }
}

async function filesBelow(directory) {
  const result = []
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) result.push(...await filesBelow(absolute))
    else if (entry.isFile()) result.push(absolute)
    else throw new Error(`unexpected offline-v5 artifact: ${absolute}`)
  }
  return result
}

async function copyRouteShell(name, source) {
  const base = path.join(nextRoot, 'server', 'app', source)
  const htmlSource = `${base}.html`
  const rscSource = `${base}.rsc`
  if (!await exists(htmlSource) || !await exists(rscSource)) {
    throw new Error(`offline-v5 canonical route is not statically available: ${source}`)
  }
  const directory = path.join(outputRoot, 'routes')
  await fs.mkdir(directory, { recursive: true })
  const document = path.join(directory, `${name}.html`)
  const flight = path.join(directory, `${name}.rsc`)
  await Promise.all([fs.copyFile(htmlSource, document), fs.copyFile(rscSource, flight)])
  return { document, flight }
}

if (!await exists(path.join(nextRoot, 'BUILD_ID'))) {
  throw new Error('offline-v5 must be built after a successful Next.js production build')
}
if (outputRoot !== path.join(root, 'public', 'offline-v5')) {
  throw new Error('refusing to clean an unexpected offline-v5 output path')
}
await fs.rm(outputRoot, { recursive: true, force: true })
await fs.mkdir(outputRoot, { recursive: true })

const workerEntry = path.join(root, 'src', 'offline-v5', 'worker.ts')
if (!await exists(workerEntry)) throw new Error('offline-v5 SharedWorker source is missing')
await build({
  entryPoints: [workerEntry],
  outfile: path.join(outputRoot, 'worker.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome110', 'edge110'],
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  tsconfig: path.join(root, 'tsconfig.json'),
  define: {
    __CLARIN_OFFLINE_BUILD__: JSON.stringify(buildID),
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
})

const routeFiles = {}
for (const [name, source] of Object.entries(routeSources)) {
  routeFiles[name] = await copyRouteShell(name, source)
}

const publicURL = filename => {
  const absolute = path.resolve(filename)
  const nextStatic = path.join(nextRoot, 'static') + path.sep
  if (absolute.startsWith(nextStatic)) {
    return `/_next/static/${path.relative(path.join(nextRoot, 'static'), absolute).split(path.sep).join('/')}`
  }
  const publicRoot = path.join(root, 'public') + path.sep
  if (!absolute.startsWith(publicRoot)) throw new Error(`offline-v5 file is outside public roots: ${absolute}`)
  return `/${path.relative(path.join(root, 'public'), absolute).split(path.sep).join('/')}`
}

const requiredPublicFiles = [
  path.join(root, 'public', 'favicon.ico'),
  path.join(root, 'public', 'favicon.svg'),
  path.join(root, 'public', 'icons', 'apple-touch-icon.png'),
  path.join(root, 'public', 'icons', 'clarin-192.png'),
  path.join(root, 'public', 'icons', 'clarin-512.png'),
  path.join(root, 'public', 'icons', 'clarin-maskable-512.png'),
  path.join(root, 'public', 'icons', 'clarin-maskable.svg'),
  path.join(root, 'public', 'pdf.worker.min.mjs'),
]
const appManifest = path.join(outputRoot, 'app.webmanifest')
await fs.copyFile(path.join(nextRoot, 'server', 'app', 'manifest.webmanifest.body'), appManifest)
const whiteboardRoot = path.join(root, 'public', 'vendor', 'whiteboards-editor', whiteboardVersion)
const staticFiles = await filesBelow(path.join(nextRoot, 'static'))
const whiteboardFiles = await filesBelow(whiteboardRoot)
const generated = [
  path.join(outputRoot, 'worker.js'),
  appManifest,
  ...Object.values(routeFiles).flatMap(item => [item.document, item.flight]),
]

const contentType = filename => {
  if (filename.endsWith('.html')) return 'text/html; charset=utf-8'
  if (filename.endsWith('.rsc')) return 'text/x-component; charset=utf-8'
  if (filename.endsWith('.js') || filename.endsWith('.mjs')) return 'application/javascript; charset=utf-8'
  if (filename.endsWith('.css')) return 'text/css; charset=utf-8'
  if (filename.endsWith('.json')) return 'application/json; charset=utf-8'
  if (filename.endsWith('.webmanifest')) return 'application/manifest+json; charset=utf-8'
  if (filename.endsWith('.svg')) return 'image/svg+xml'
  if (filename.endsWith('.png')) return 'image/png'
  if (filename.endsWith('.woff2')) return 'font/woff2'
  return 'application/octet-stream'
}

const assets = []
for (const filename of [...new Set([...generated, ...staticFiles, ...requiredPublicFiles, ...whiteboardFiles])]) {
  const bytes = await fs.readFile(filename)
  assets.push({
    url: publicURL(filename),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.byteLength,
    content_type: contentType(filename),
  })
}
assets.sort((left, right) => left.url.localeCompare(right.url))

const shell = Object.fromEntries(Object.entries(routeFiles).map(([name, files]) => [name, {
  document: publicURL(files.document),
  flight: publicURL(files.flight),
}]))
const manifest = {
  protocol_version: 5,
  build_id: buildID,
  built_at: new Date().toISOString(),
  app_origin: appOrigin,
  worker: '/offline-v5/worker.js',
  app_manifest: '/offline-v5/app.webmanifest',
  whiteboard_engine: whiteboardVersion,
  shell,
  assets,
}
const totalBytes = assets.reduce((sum, asset) => sum + asset.bytes, 0)
if (totalBytes <= 0 || totalBytes > maximumBytes) {
  throw new Error(`offline-v5 public shell exceeds 64 MiB (${totalBytes} bytes)`)
}
await fs.writeFile(path.join(outputRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
process.stdout.write(`offline-v5 canonical shell ${buildID}: ${assets.length} assets, ${totalBytes} bytes\n`)
