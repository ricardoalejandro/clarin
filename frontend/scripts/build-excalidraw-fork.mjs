import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { sassPlugin } from 'esbuild-sass-plugin'

export const EXCALIDRAW_FORK_VERSION = '0.18.1-clarin.5'
export const EXCALIDRAW_UPSTREAM_COMMIT = 'a2ec2889babf7d2295469c6d90ebe77fae57df84'

const frontendRoot = process.cwd()
const forkRoot = resolve(frontendRoot, 'vendor', 'excalidraw-clarin')
const packageRoot = join(forkRoot, 'packages', 'excalidraw')

const safeEnvironment = mode => ({
  DEV: mode === 'development',
  PROD: mode === 'production',
  MODE: mode,
  PKG_NAME: '@excalidraw/excalidraw',
  PKG_VERSION: EXCALIDRAW_FORK_VERSION,
  VITE_APP_DEBUG_ENABLE_TEXT_CONTAINER_BOUNDING_BOX: 'false',
  VITE_APP_ENABLE_TRACKING: 'false',
  VITE_APP_LIBRARY_BACKEND: 'about:blank#clarin-external-disabled',
  VITE_APP_LIBRARY_URL: 'about:blank#clarin-external-disabled',
  VITE_WORKER_ID: '',
})

const commonConfig = {
  absWorkingDir: packageRoot,
  bundle: true,
  splitting: true,
  format: 'esm',
  packages: 'external',
  plugins: [sassPlugin()],
  target: 'es2020',
  assetNames: '[dir]/[name]',
  chunkNames: '[dir]/[name]-[hash]',
  entryPoints: ['index.tsx', 'clarin-rich-text.ts', '**/*.chunk.ts'],
  entryNames: '[name]',
  alias: {
    '@excalidraw/excalidraw': packageRoot,
    '@excalidraw/utils': join(forkRoot, 'packages', 'utils'),
    '@excalidraw/math': join(forkRoot, 'packages', 'math'),
  },
  loader: {
    '.woff2': 'file',
  },
}

export async function buildExcalidrawFork() {
  await Promise.all([
    rm(join(packageRoot, 'dist', 'dev'), { recursive: true, force: true }),
    rm(join(packageRoot, 'dist', 'prod'), { recursive: true, force: true }),
  ])
  await build({
    ...commonConfig,
    outdir: join(packageRoot, 'dist', 'dev'),
    sourcemap: true,
    define: { 'import.meta.env': JSON.stringify(safeEnvironment('development')) },
  })
  await build({
    ...commonConfig,
    outdir: join(packageRoot, 'dist', 'prod'),
    minify: true,
    define: { 'import.meta.env': JSON.stringify(safeEnvironment('production')) },
  })
  return packageRoot
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await buildExcalidrawFork()
  console.log(`Fork de Excalidraw ${EXCALIDRAW_FORK_VERSION} compilado desde ${EXCALIDRAW_UPSTREAM_COMMIT}.`)
}
