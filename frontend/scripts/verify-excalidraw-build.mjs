import { access } from 'node:fs/promises'
import { join } from 'node:path'
import {
  EXPECTED_EDITOR_VERSION,
  LOCAL_EDITOR_ASSET_PATH,
  verifyArtifactTree,
} from './excalidraw-hardening.mjs'

const packageRoot = join(process.cwd(), 'node_modules', '@excalidraw', 'excalidraw', 'dist')
const roots = [
  { path: packageRoot, strictExternalHosts: true },
  // Other Clarin modules deliberately use controlled third-party services.
  // Built output still rejects every Excalidraw/Firebase/editor route, while
  // the exact editor artifact receives the broader zero-egress host policy.
  { path: join(process.cwd(), '.next', 'static'), strictExternalHosts: false },
  { path: join(process.cwd(), '.next', 'server'), strictExternalHosts: false },
  { path: join(process.cwd(), 'public', LOCAL_EDITOR_ASSET_PATH), strictExternalHosts: true },
]

let verifiedFiles = 0
for (const root of roots) {
  await access(root.path)
  verifiedFiles += await verifyArtifactTree(root.path, { strictExternalHosts: root.strictExternalHosts })
}

console.log(`Build de Pizarras ${EXPECTED_EDITOR_VERSION} verificado: ${verifiedFiles} artefactos sin rutas operativas upstream.`)
