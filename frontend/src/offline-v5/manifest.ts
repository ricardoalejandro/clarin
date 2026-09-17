import { sha256HexText, validateOfflineV5Actions, verifyOfflineV5Lease, verifyOfflineV5Manifest } from './crypto'
import { manifestIdentity, sameOfflineV5Identity } from './identity'
import {
  OFFLINE_V5_LEASE_MS,
  OFFLINE_V5_MAX_BYTES,
  OFFLINE_V5_MAX_DEPENDENCIES,
  OFFLINE_V5_MAX_ROOTS,
  OfflineV5Error,
  type OfflineV5Identity,
  type OfflineV5Manifest,
  type OfflineV5PrepareBundle,
  type OfflineV5Snapshot,
  type OfflineV5WhiteboardAssetDescriptor,
} from './types'

const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024
const MAX_CAPABILITIES = 5000
const HASH_HEX = /^[a-f0-9]{64}$/
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

export function offlineV5WhiteboardAssetDescriptors(snapshot: OfflineV5Snapshot): OfflineV5WhiteboardAssetDescriptor[] {
  if (snapshot.module !== 'whiteboards' || snapshot.tombstone) return []
  const transport = snapshot.payload.asset_transport as Record<string, unknown> | undefined
  if (!transport || transport.embedded !== false || transport.local_encrypted !== true || transport.blob_sync_enabled !== false) {
    throw new OfflineV5Error('invalid_asset_transport', 'La copia de la pizarra no declara un transporte local seguro para sus imágenes.')
  }
  const raw = snapshot.payload.referenced_assets
  if (!Array.isArray(raw)) throw new OfflineV5Error('invalid_asset_manifest', 'La pizarra no contiene un manifiesto válido de imágenes.')
  const ids = new Set<string>(), files = new Set<string>()
  return raw.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OfflineV5Error('invalid_asset_manifest', 'La pizarra contiene un descriptor de imagen inválido.')
    const item = value as Record<string, unknown>
    const descriptor = {
      id: String(item.id || ''),
      root_resource_id: String(item.root_resource_id || ''),
      file_id: String(item.file_id || ''),
      content_hash: String(item.content_hash || '').toLowerCase(),
      content_type: String(item.content_type || '').toLowerCase(),
      size_bytes: Number(item.size_bytes),
    } as OfflineV5WhiteboardAssetDescriptor
    if (!descriptor.id || !descriptor.file_id || descriptor.root_resource_id !== snapshot.root_resource_id
        || !HASH_HEX.test(descriptor.content_hash) || !IMAGE_TYPES.has(descriptor.content_type)
        || !Number.isSafeInteger(descriptor.size_bytes) || descriptor.size_bytes < 1 || descriptor.size_bytes > OFFLINE_V5_MAX_BYTES
        || ids.has(descriptor.id) || files.has(descriptor.file_id)
        || Object.prototype.hasOwnProperty.call(item, 'data_base64') || Object.prototype.hasOwnProperty.call(item, 'object_key')) {
      throw new OfflineV5Error('invalid_asset_manifest', 'La pizarra contiene una imagen fuera del recurso firmado o con metadatos inválidos.')
    }
    ids.add(descriptor.id); files.add(descriptor.file_id)
    return descriptor
  })
}

export function offlineV5ManifestScopeWithinBounds(manifest: Pick<OfflineV5Manifest, 'roots' | 'dependencies' | 'capabilities'>): boolean {
  return Array.isArray(manifest.roots) && manifest.roots.length >= 1 && manifest.roots.length <= OFFLINE_V5_MAX_ROOTS
    && Array.isArray(manifest.dependencies) && manifest.dependencies.length <= OFFLINE_V5_MAX_DEPENDENCIES
    && Array.isArray(manifest.capabilities) && manifest.capabilities.length <= MAX_CAPABILITIES
}

function safeTime(value: string, name: string): number {
  const time = Date.parse(value)
  if (!Number.isFinite(time)) throw new OfflineV5Error('invalid_manifest_time', `La fecha ${name} del manifiesto no es válida.`)
  return time
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]))
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) || Array.isArray(right)) return false
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>, keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(key => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]))
}

/** Rejects account-labelled data anywhere in an authenticated snapshot tree. */
export function offlineV5PayloadAccountIsolated(value: unknown, accountID: string): boolean {
  if (!accountID) return false
  const pending: unknown[] = [value]
  const seen = new Set<object>()
  while (pending.length) {
    const item = pending.pop()
    if (!item || typeof item !== 'object') continue
    if (seen.has(item)) continue
    seen.add(item)
    if (Array.isArray(item)) {
      pending.push(...item)
      continue
    }
    const record = item as Record<string, unknown>
    if (Object.prototype.hasOwnProperty.call(record, 'account_id') && record.account_id !== accountID) return false
    pending.push(...Object.values(record))
  }
  return true
}

function expectedChunk(manifest: OfflineV5Manifest, snapshot: OfflineV5Snapshot): boolean {
  return Array.isArray(manifest.chunk_hashes) && manifest.chunk_hashes.some(item => item.selection_id === snapshot.selection_id && item.head_version === snapshot.head_version && item.content_hash === snapshot.content_hash)
}

function validateRootPayload(snapshot: OfflineV5Snapshot) {
  if (snapshot.dependency || snapshot.tombstone) return
  const property = { tasks: 'list', contacts: 'contact', programs: 'program', whiteboards: 'whiteboard' }[snapshot.module]
  const root = snapshot.payload[property] as { id?: unknown } | undefined
  if (!root || root.id !== snapshot.root_resource_id || snapshot.resource_id !== snapshot.root_resource_id) {
    throw new OfflineV5Error('wrong_snapshot_root', 'El contenido descargado no corresponde al recurso seleccionado.')
  }
  if (snapshot.module === 'tasks') {
    const tasks = snapshot.payload.tasks
    if (!Array.isArray(tasks) || tasks.length > 5000 || tasks.some(item => !item || typeof item !== 'object' || (item as { list_id?: unknown }).list_id !== snapshot.root_resource_id)) {
      throw new OfflineV5Error('wrong_snapshot_tasks', 'La lista descargada contiene tareas de otro recurso.')
    }
  }
}

export async function validateOfflineV5Bundle(origin: string, bundle: OfflineV5PrepareBundle, expected?: Partial<OfflineV5Identity>): Promise<OfflineV5Identity> {
  const manifest = bundle?.manifest
  if (!manifest || manifest.protocol_version !== 5 || !Number.isSafeInteger(manifest.revision) || manifest.revision < 1 || !Number.isSafeInteger(manifest.selection_revision) || manifest.selection_revision < 1) {
    throw new OfflineV5Error('invalid_manifest', 'Clarín devolvió un manifiesto offline inválido.')
  }
  const identity = manifestIdentity(origin, manifest)
  if (expected && !sameOfflineV5Identity(identity, { ...identity, ...expected })) throw new OfflineV5Error('wrong_manifest_identity', 'La descarga pertenece a otro navegador, usuario o cuenta.')
  if (!offlineV5ManifestScopeWithinBounds(manifest)) {
    throw new OfflineV5Error('invalid_manifest_scope', 'La selección offline supera los límites permitidos.')
  }
  if (!Number.isSafeInteger(manifest.max_storage_bytes) || manifest.max_storage_bytes < 1 || manifest.max_storage_bytes > OFFLINE_V5_MAX_BYTES) throw new OfflineV5Error('invalid_manifest_quota', 'El límite de almacenamiento offline no es válido.')
  await verifyOfflineV5Manifest(manifest)
  const issued = safeTime(manifest.issued_at, 'de emisión'), expires = safeTime(manifest.expires_at, 'de vencimiento')
  if (expires <= issued || expires - issued > OFFLINE_V5_LEASE_MS || Date.now() >= expires) throw new OfflineV5Error('manifest_expired', 'La autorización offline venció.')
  if (!bundle.signer_public_keys?.keys?.length || !bundle.lease) throw new OfflineV5Error('missing_lease', 'Clarín no devolvió la autorización firmada.')
  await verifyOfflineV5Lease(bundle.lease, bundle.signer_public_keys.keys, identity, manifest)

  const roots = new Map<string, typeof manifest.roots[number]>()
  const resources = new Set<string>()
  for (const root of manifest.roots) {
    if (!root.selection_id || !root.resource_id || !root.resource_type || !['tasks', 'contacts', 'programs', 'whiteboards'].includes(root.module)
        || roots.has(root.selection_id) || resources.has(`${root.module}\0${root.resource_type}\0${root.resource_id}`)) throw new OfflineV5Error('invalid_manifest_roots', 'El manifiesto repite o altera un recurso seleccionado.')
    roots.set(root.selection_id, root)
    resources.add(`${root.module}\0${root.resource_type}\0${root.resource_id}`)
  }
  const dependencies = new Set<string>()
  for (const dependency of manifest.dependencies) {
    if (!roots.has(dependency.root_selection_id) || !dependency.resource_id || !dependency.resource_type || !['tasks', 'contacts', 'programs', 'whiteboards'].includes(dependency.module)) throw new OfflineV5Error('invalid_manifest_dependency', 'Una dependencia no pertenece a un recurso seleccionado.')
    dependencies.add(`${dependency.root_selection_id}\0${dependency.module}\0${dependency.resource_type}\0${dependency.resource_id}`)
  }
  validateOfflineV5Actions(manifest.capabilities.map(item => item.action))
  for (const capability of manifest.capabilities) {
    const root = roots.get(capability.selection_id)
    if (!root || capability.root_resource_id !== root.resource_id || capability.resource_id !== root.resource_id || capability.resource_type !== root.resource_type || !capability.action.startsWith(`${root.module}.`)) {
      throw new OfflineV5Error('invalid_manifest_capability', 'Una capacidad no pertenece a la selección autorizada.')
    }
  }

  if (!Array.isArray(bundle.snapshots) || bundle.snapshots.length < manifest.roots.length || bundle.snapshots.length > manifest.roots.length + manifest.dependencies.length) throw new OfflineV5Error('incomplete_snapshot_set', 'La copia offline no contiene exactamente los recursos autorizados.')
  const seen = new Set<string>()
  let totalPayloadBytes = 0
  for (const snapshot of bundle.snapshots) {
    if (snapshot.protocol_version !== 5 || snapshot.manifest_id !== manifest.id || snapshot.manifest_revision !== manifest.revision || !snapshot.selection_id || !snapshot.root_selection_id
        || !Number.isSafeInteger(snapshot.head_version) || snapshot.head_version < 0 || seen.has(snapshot.selection_id)) throw new OfflineV5Error('invalid_snapshot', 'La copia contiene un recurso inválido o repetido.')
    const root = roots.get(snapshot.root_selection_id)
    if (!root) throw new OfflineV5Error('wrong_snapshot_selection', 'La copia contiene datos fuera de la selección autorizada.')
    if (snapshot.dependency) {
      if (!dependencies.has(`${snapshot.root_selection_id}\0${snapshot.module}\0${snapshot.resource_type}\0${snapshot.resource_id}`)) throw new OfflineV5Error('unexpected_dependency', 'La copia contiene una dependencia no autorizada.')
    } else if (snapshot.selection_id !== root.selection_id || snapshot.resource_id !== root.resource_id || snapshot.root_resource_id !== root.resource_id || snapshot.module !== root.module || snapshot.resource_type !== root.resource_type) {
      throw new OfflineV5Error('wrong_snapshot_root', 'La copia contiene otro recurso raíz.')
    }
    if (!expectedChunk(manifest, snapshot)) throw new OfflineV5Error('snapshot_not_in_manifest', 'El recurso no aparece en el manifiesto firmado.')
    const bytes = new TextEncoder().encode(snapshot.payload_json || '').byteLength
    if (!snapshot.tombstone && (!snapshot.payload_json || bytes > MAX_SNAPSHOT_BYTES || await sha256HexText(snapshot.payload_json) !== snapshot.content_hash.toLowerCase())) throw new OfflineV5Error('snapshot_integrity', 'Un recurso no superó la verificación SHA-256.')
    if (!snapshot.tombstone) {
      let parsed: unknown
      try { parsed = JSON.parse(snapshot.payload_json) } catch { throw new OfflineV5Error('invalid_snapshot_json', 'Un recurso contiene JSON inválido.') }
      if (!deepEqual(parsed, snapshot.payload)) throw new OfflineV5Error('snapshot_payload_mismatch', 'El recurso visible no coincide con sus bytes verificados.')
      if (!offlineV5PayloadAccountIsolated(parsed, identity.account_id)) throw new OfflineV5Error('cross_account_snapshot', 'La copia contiene datos de otra cuenta y fue descartada.')
      validateRootPayload(snapshot)
    }
    totalPayloadBytes += bytes
    for (const descriptor of offlineV5WhiteboardAssetDescriptors(snapshot)) totalPayloadBytes += descriptor.size_bytes
    if (totalPayloadBytes > manifest.max_storage_bytes) throw new OfflineV5Error('snapshot_quota', 'La descarga supera el límite autorizado para esta copia.')
    seen.add(snapshot.selection_id)
  }
  for (const root of manifest.roots) if (!seen.has(root.selection_id)) throw new OfflineV5Error('missing_root_snapshot', 'Falta un recurso seleccionado; no se guardó una copia parcial.')
  return identity
}
