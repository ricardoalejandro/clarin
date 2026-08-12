import { api, apiBlob, apiDelete, apiGet, apiPost, apiPut } from '@/lib/api'
import {
  buildWhiteboardListQuery,
  buildWhiteboardManualRevisionRequest,
  buildWhiteboardAccountUserSearchPath,
  buildWhiteboardCursorUpdate,
  buildWhiteboardPresenceUpdate,
  buildWhiteboardPurgeRequest,
  createWhiteboardOperationID,
  type WhiteboardAccountUser,
  type WhiteboardAccessPolicy,
  type WhiteboardAccessUpdateInput,
  type WhiteboardCursorPayload,
  type WhiteboardFolder,
  type WhiteboardLibraryRecord,
  type WhiteboardRealtimeEvent,
  type WhiteboardSavePayload,
  type WhiteboardSceneDocument,
  type WhiteboardScenePatch,
  type WhiteboardSceneRecord,
  type WhiteboardScope,
  type WhiteboardShareLink,
  type WhiteboardSummary,
  type WhiteboardVersion,
  whiteboardRoomSocketPath,
  whiteboardSceneSaveMethod,
} from '@/lib/whiteboards'

export const WHITEBOARDS_API_ROOT = '/api/whiteboards'
export const WHITEBOARD_FOLDERS_API_ROOT = '/api/whiteboard-folders'
export const WHITEBOARD_LIBRARIES_API_ROOT = '/api/whiteboard-libraries'

export interface WhiteboardListResponse {
  success?: boolean
  whiteboards: WhiteboardSummary[]
  next_cursor?: string | null
  permissions?: {
    can_create: boolean
    can_create_folder: boolean
  }
  counts?: Partial<Record<WhiteboardScope, number>>
}

export interface WhiteboardFolderListResponse {
  success?: boolean
  folders: WhiteboardFolder[]
  next_cursor?: string | null
}

type WhiteboardFolderPageResult = {
  success: boolean
  data?: WhiteboardFolderListResponse
  error?: string
  status?: number
}

export async function collectWhiteboardFolderPages(
  loadPage: (cursor: string | null) => Promise<WhiteboardFolderPageResult>,
): Promise<WhiteboardFolderPageResult> {
  const folders: WhiteboardFolder[] = []
  const folderIDs = new Set<string>()
  const seen = new Set<string>()
  let cursor: string | null = null
  while (true) {
    const response = await loadPage(cursor)
    if (!response.success || !response.data) return response
    for (const folder of response.data.folders || []) {
      if (folderIDs.has(folder.id)) continue
      folderIDs.add(folder.id)
      folders.push(folder)
    }
    const nextCursor = response.data.next_cursor?.trim() || null
    if (!nextCursor) return { ...response, data: { ...response.data, folders, next_cursor: null } }
    if (seen.has(nextCursor)) return { success: false, error: 'La paginación de carpetas devolvió un cursor repetido.', status: response.status }
    seen.add(nextCursor)
    cursor = nextCursor
  }
}

function withDerivedWhiteboardState(board: WhiteboardSummary): WhiteboardSummary {
  return {
    ...board,
    shared: board.shared ?? board.effective_access?.inherited_from === 'direct_grant',
  }
}

export async function listWhiteboards(input: {
  scope: WhiteboardScope
  folderID?: string | null
  search?: string
  cursor?: string | null
  signal?: AbortSignal
}) {
  const query = buildWhiteboardListQuery({
    scope: input.scope,
    folderID: input.folderID,
    search: input.search,
    cursor: input.cursor,
  })
  const response = await apiGet<WhiteboardListResponse>(`${WHITEBOARDS_API_ROOT}?${query}`, { signal: input.signal })
  if (!response.success || !response.data) return response
  let boards = (response.data.whiteboards || []).map(withDerivedWhiteboardState)
  if (input.scope === 'trash') boards = boards.filter(board => Boolean(board.archived_at))
  if (input.scope === 'shared') boards = boards.filter(board => board.shared)
  return {
    ...response,
    data: {
      ...response.data,
      whiteboards: boards,
      permissions: response.data.permissions || { can_create: true, can_create_folder: true },
    },
  }
}

export async function listWhiteboardFolders(input: { signal?: AbortSignal; includeArchived?: boolean } = {}) {
  return collectWhiteboardFolderPages(cursor => {
    const params = new URLSearchParams({ limit: '200' })
    if (input.includeArchived) params.set('include_archived', 'true')
    if (cursor) params.set('cursor', cursor)
    return apiGet<WhiteboardFolderListResponse>(`${WHITEBOARD_FOLDERS_API_ROOT}?${params.toString()}`, { signal: input.signal })
  })
}

export function createWhiteboard(input: {
  name: string
  folder_id?: string | null
  scene?: WhiteboardSceneDocument
}) {
  return apiPost<{ success?: boolean; whiteboard: WhiteboardSummary }>(WHITEBOARDS_API_ROOT, {
    name: input.name,
    folder_id: input.folder_id,
    scene: input.scene,
    scene_schema_version: 'excalidraw',
    editor_version: '0.18.1',
    operation_id: createWhiteboardOperationID(),
  })
}

export function duplicateWhiteboard(id: string, input: { name?: string; folder_id?: string | null }) {
  return apiPost<{ success?: boolean; whiteboard: WhiteboardSummary }>(
    `${WHITEBOARDS_API_ROOT}/${encodeURIComponent(id)}/duplicate`,
    { ...input, operation_id: createWhiteboardOperationID() },
  )
}

export function createWhiteboardFolder(input: { name: string; parent_id?: string | null }) {
  return apiPost<{ success?: boolean; folder: WhiteboardFolder }>(WHITEBOARD_FOLDERS_API_ROOT, input)
}

export function updateWhiteboardFolder(id: string, input: {
  parent_id?: string | null
  name: string
  description?: string
  sort_order?: number
  expected_version: number
}) {
  return apiPut<{ success?: boolean; folder: WhiteboardFolder }>(`${WHITEBOARD_FOLDERS_API_ROOT}/${encodeURIComponent(id)}`, input)
}

export function archiveWhiteboardFolder(id: string, expectedVersion: number) {
  return apiDelete<{ success?: boolean }>(`${WHITEBOARD_FOLDERS_API_ROOT}/${encodeURIComponent(id)}?expected_version=${expectedVersion}`)
}

export function restoreWhiteboardFolder(id: string, expectedVersion: number) {
  return apiPost<{ success?: boolean; folder: WhiteboardFolder }>(`${WHITEBOARD_FOLDERS_API_ROOT}/${encodeURIComponent(id)}/restore`, {
    expected_version: expectedVersion,
  })
}

export function loadWhiteboardMetadata(id: string, signal?: AbortSignal) {
  return apiGet<{ success?: boolean; whiteboard: WhiteboardSummary }>(`${WHITEBOARDS_API_ROOT}/${encodeURIComponent(id)}`, { signal })
}

export function loadWhiteboardScene(id: string, signal?: AbortSignal) {
  return apiGet<{ success?: boolean; scene: WhiteboardSceneRecord }>(`${WHITEBOARDS_API_ROOT}/${encodeURIComponent(id)}/scene`, { signal })
}

export function saveWhiteboard(id: string, payload: WhiteboardSavePayload) {
  const method = whiteboardSceneSaveMethod(payload)
  return api<{ success?: boolean; rebased?: boolean; result: { scene: WhiteboardSceneRecord; idempotent: boolean } }>(
    `${WHITEBOARDS_API_ROOT}/${encodeURIComponent(id)}/scene`,
    { method, body: JSON.stringify(payload) },
  )
}

export function updateWhiteboard(id: string, input: {
  name: string
  description?: string
  folder_id?: string | null
  expected_version: number
}) {
  return apiPut<{ success?: boolean; whiteboard: WhiteboardSummary }>(`${WHITEBOARDS_API_ROOT}/${encodeURIComponent(id)}`, input)
}

export function archiveWhiteboard(id: string, expectedVersion: number) {
  return apiDelete<{ success?: boolean }>(`${WHITEBOARDS_API_ROOT}/${encodeURIComponent(id)}?expected_version=${expectedVersion}`)
}

export function restoreWhiteboard(id: string, expectedVersion: number) {
  return apiPost<{ success?: boolean; whiteboard: WhiteboardSummary }>(`${WHITEBOARDS_API_ROOT}/${encodeURIComponent(id)}/restore`, {
    expected_version: expectedVersion,
  })
}

export interface WhiteboardTrashPolicy {
  retention_days: number
  can_manage: boolean
}

export function getWhiteboardTrashPolicy(signal?: AbortSignal) {
  return apiGet<WhiteboardTrashPolicy>(`${WHITEBOARDS_API_ROOT}/trash-policy`, { signal })
}

export function updateWhiteboardTrashPolicy(retentionDays: number) {
  return apiPut<WhiteboardTrashPolicy>(`${WHITEBOARDS_API_ROOT}/trash-policy`, { retention_days: retentionDays })
}

export function purgeWhiteboard(id: string, confirmationName: string, operationID: string) {
  return apiDelete<{
    success?: boolean
    operation_id?: string
    purged?: { revisions: number; assets: number }
    code?: string
    next_eligible_at?: string
  }>(`${WHITEBOARDS_API_ROOT}/${encodeURIComponent(id)}/purge`, {
    ...buildWhiteboardPurgeRequest(confirmationName, operationID),
  })
}

export function getWhiteboardAccess(id: string, signal?: AbortSignal) {
  return apiGet<{ success?: boolean; access: WhiteboardAccessPolicy }>(`${WHITEBOARDS_API_ROOT}/${encodeURIComponent(id)}/grants`, { signal })
}

export function updateWhiteboardAccess(id: string, input: WhiteboardAccessUpdateInput) {
  return apiPut<{ success?: boolean; access: WhiteboardAccessPolicy }>(`${WHITEBOARDS_API_ROOT}/${encodeURIComponent(id)}/grants`, {
    ...input,
    operation_id: createWhiteboardOperationID(),
  })
}

export function searchWhiteboardAccountUsers(query: string, signal?: AbortSignal) {
  return apiGet<{ success?: boolean; users: WhiteboardAccountUser[] }>(buildWhiteboardAccountUserSearchPath(query), { signal })
}

export function buildWhiteboardShareLinksPath(id: string, cursor?: string | null) {
  const params = new URLSearchParams({ limit: '50' })
  if (cursor) params.set('cursor', cursor)
  return `${WHITEBOARDS_API_ROOT}/${encodeURIComponent(id)}/share-links?${params.toString()}`
}

export function listWhiteboardShareLinks(id: string, input: { cursor?: string | null; signal?: AbortSignal } = {}) {
  return apiGet<{ success?: boolean; share_links: WhiteboardShareLink[]; next_cursor?: string | null }>(buildWhiteboardShareLinksPath(id, input.cursor), { signal: input.signal })
}

export function createWhiteboardShareLink(id: string, input: {
  label: string
  access_level: 'view' | 'edit'
  password?: string
  allow_export: boolean
  expires_at?: string | null
  max_sessions?: number | null
}) {
  return apiPost<{ success?: boolean; share_link: WhiteboardShareLink; token: string }>(`${WHITEBOARDS_API_ROOT}/${encodeURIComponent(id)}/share-links`, input)
}

export function revokeWhiteboardShareLink(id: string, linkID: string) {
  return apiDelete<{ success?: boolean }>(`${WHITEBOARDS_API_ROOT}/${encodeURIComponent(id)}/share-links/${encodeURIComponent(linkID)}`)
}

export function buildWhiteboardVersionsPath(id: string, beforeSequence?: number | null) {
  const params = new URLSearchParams({ limit: '100' })
  if (typeof beforeSequence === 'number') params.set('before_sequence', String(beforeSequence))
  return `${WHITEBOARDS_API_ROOT}/${encodeURIComponent(id)}/revisions?${params.toString()}`
}

export function listWhiteboardVersions(id: string, input: { beforeSequence?: number | null; signal?: AbortSignal } = {}) {
  return apiGet<{ success?: boolean; revisions: WhiteboardVersion[]; has_more?: boolean }>(buildWhiteboardVersionsPath(id, input.beforeSequence), { signal: input.signal })
}

export function loadWhiteboardRevision(id: string, versionID: string, signal?: AbortSignal) {
  return apiGet<{ success?: boolean; revision: WhiteboardVersion; scene: WhiteboardSceneDocument | string }>(
    `${WHITEBOARDS_API_ROOT}/${encodeURIComponent(id)}/revisions/${encodeURIComponent(versionID)}`,
    { signal },
  )
}

export function createWhiteboardVersion(id: string, expectedSequence: number) {
  return apiPost<{ success?: boolean; result: { scene: WhiteboardSceneRecord } }>(
    `${WHITEBOARDS_API_ROOT}/${encodeURIComponent(id)}/revisions`,
    buildWhiteboardManualRevisionRequest(expectedSequence, createWhiteboardOperationID()),
  )
}

export function restoreWhiteboardVersion(id: string, versionID: string, expectedSequence: number) {
  return apiPost<{ success?: boolean; result: { scene: WhiteboardSceneRecord } }>(`${WHITEBOARDS_API_ROOT}/${encodeURIComponent(id)}/revisions/${encodeURIComponent(versionID)}/restore`, {
    expected_sequence: expectedSequence,
    operation_id: createWhiteboardOperationID(),
  })
}

export function getWhiteboardCurrentActor(signal?: AbortSignal) {
  return apiGet<{ success?: boolean; user: { id: string; is_admin?: boolean } }>('/api/me', { signal })
}

export function buildWhiteboardLibrariesPath(query = '', cursor: string | null = null) {
  const params = new URLSearchParams({ limit: '50' })
  if (query.trim()) params.set('q', query.trim())
  if (cursor) params.set('cursor', cursor)
  return `${WHITEBOARD_LIBRARIES_API_ROOT}?${params.toString()}`
}

export function listWhiteboardLibraries(signal?: AbortSignal, query = '', cursor: string | null = null) {
  return apiGet<{
    success?: boolean
    libraries: WhiteboardLibraryRecord[]
    next_cursor?: string | null
  }>(buildWhiteboardLibrariesPath(query, cursor), { signal })
}

type WhiteboardLibraryPageResult = {
  success: boolean
  data?: {
    success?: boolean
    libraries: WhiteboardLibraryRecord[]
    next_cursor?: string | null
  }
  error?: string
  status?: number
}

/** Resolves the stable library cursor without silently dropping page 2+. */
export async function collectWhiteboardLibraryPages(
  loadPage: (cursor: string | null) => Promise<WhiteboardLibraryPageResult>,
): Promise<WhiteboardLibraryPageResult> {
  const libraries: WhiteboardLibraryRecord[] = []
  const libraryIDs = new Set<string>()
  const seenCursors = new Set<string>()
  let cursor: string | null = null
  let status: number | undefined
  while (true) {
    const response = await loadPage(cursor)
    status = response.status
    if (!response.success || !response.data) return response
    for (const library of response.data.libraries || []) {
      if (libraryIDs.has(library.id)) continue
      libraryIDs.add(library.id)
      libraries.push(library)
    }
    const nextCursor = response.data.next_cursor || null
    if (!nextCursor) {
      return { success: true, status, data: { success: true, libraries, next_cursor: null } }
    }
    if (seenCursors.has(nextCursor)) {
      return { success: false, status: 409, error: 'La paginación de bibliotecas devolvió un cursor repetido.' }
    }
    seenCursors.add(nextCursor)
    cursor = nextCursor
  }
}

export function getWhiteboardLibrary(id: string, signal?: AbortSignal) {
  return apiGet<{ success?: boolean; library: WhiteboardLibraryRecord }>(`${WHITEBOARD_LIBRARIES_API_ROOT}/${encodeURIComponent(id)}`, { signal })
}

export function createWhiteboardLibrary(input: {
  name: string
  description: string
  library_json: Record<string, unknown> & { libraryItems: readonly unknown[] }
  visibility: 'private' | 'account'
}) {
  return apiPost<{ success?: boolean; library: WhiteboardLibraryRecord }>(WHITEBOARD_LIBRARIES_API_ROOT, input)
}

export function updateWhiteboardLibrary(id: string, input: {
  name: string
  description: string
  library_json: Record<string, unknown> & { libraryItems: readonly unknown[] }
  visibility: 'private' | 'account'
  expected_version: number
}) {
  return apiPut<{ success?: boolean; library: WhiteboardLibraryRecord }>(`${WHITEBOARD_LIBRARIES_API_ROOT}/${encodeURIComponent(id)}`, input)
}

export function archiveWhiteboardLibrary(id: string, expectedVersion: number) {
  return apiDelete<{ success?: boolean }>(`${WHITEBOARD_LIBRARIES_API_ROOT}/${encodeURIComponent(id)}`, {
    expected_version: expectedVersion,
  })
}

export interface WhiteboardAsset {
  id: string
  board_id: string
  file_id: string
  kind: string
  filename: string
  content_type: string
  size_bytes: number
  created_at: string
}

export type WhiteboardGuestAsset = Omit<WhiteboardAsset, 'board_id'>

interface WhiteboardAssetPage<T> {
  success?: boolean
  assets: T[]
  next_cursor?: string | null
}

type WhiteboardPageResult<T> = {
  success: boolean
  data?: WhiteboardAssetPage<T>
  error?: string
  status?: number
}

/** Collects a complete manifest, or stops as soon as every live scene reference is resolved. */
export async function collectWhiteboardAssetPages<T>(
  loadPage: (cursor: string | null) => Promise<WhiteboardPageResult<T>>,
  referencedFileIDs?: readonly string[],
  fileIDForItem: (item: T) => string | undefined = item => (
    typeof (item as { file_id?: unknown })?.file_id === 'string'
      ? (item as { file_id: string }).file_id
      : undefined
  ),
): Promise<WhiteboardPageResult<T>> {
  const assets: T[] = []
  const seenCursors = new Set<string>()
  const unresolved = referencedFileIDs
    ? new Set(referencedFileIDs.filter(fileID => typeof fileID === 'string' && fileID.trim()))
    : null
  let cursor: string | null = null
  let status: number | undefined

  if (unresolved?.size === 0) {
    return { success: true, data: { success: true, assets, next_cursor: null } }
  }

  while (true) {
    const response = await loadPage(cursor)
    status = response.status
    if (!response.success || !response.data) return response
    for (const asset of response.data.assets || []) {
      if (!unresolved) {
        assets.push(asset)
        continue
      }
      const fileID = fileIDForItem(asset)
      if (!fileID || !unresolved.delete(fileID)) continue
      assets.push(asset)
    }
    if (unresolved?.size === 0) {
      return { success: true, data: { success: true, assets, next_cursor: null }, status }
    }
    const nextCursor = response.data.next_cursor?.trim() || null
    if (!nextCursor) {
      return { success: true, data: { success: true, assets, next_cursor: null }, status }
    }
    if (seenCursors.has(nextCursor)) {
      return { success: false, error: 'La paginación de recursos devolvió un cursor repetido.', status }
    }
    seenCursors.add(nextCursor)
    cursor = nextCursor
  }
}

export function buildWhiteboardAssetListPath(id: string, cursor: string | null, referencedOnly = false) {
  const params = new URLSearchParams({ limit: '200' })
  if (referencedOnly) params.set('referenced_only', '1')
  if (cursor) params.set('cursor', cursor)
  return `${WHITEBOARDS_API_ROOT}/${encodeURIComponent(id)}/assets?${params.toString()}`
}

export function listWhiteboardAssets(id: string, referencedFileIDs: readonly string[], signal?: AbortSignal) {
  return collectWhiteboardAssetPages<WhiteboardAsset>(cursor => (
    apiGet<WhiteboardAssetPage<WhiteboardAsset>>(buildWhiteboardAssetListPath(id, cursor, true), { signal })
  ), referencedFileIDs)
}

export function downloadWhiteboardAsset(id: string, assetID: string, signal?: AbortSignal) {
  return apiBlob(`${WHITEBOARDS_API_ROOT}/${encodeURIComponent(id)}/assets/${encodeURIComponent(assetID)}`, { signal })
}

function whiteboardRevisionAssetListPath(id: string, versionID: string, cursor: string | null) {
  const params = new URLSearchParams({ limit: '200' })
  if (cursor) params.set('cursor', cursor)
  return `${WHITEBOARDS_API_ROOT}/${encodeURIComponent(id)}/revisions/${encodeURIComponent(versionID)}/assets?${params.toString()}`
}

export function listWhiteboardRevisionAssets(id: string, versionID: string, referencedFileIDs: readonly string[], signal?: AbortSignal) {
  return collectWhiteboardAssetPages<WhiteboardAsset>(cursor => (
    apiGet<WhiteboardAssetPage<WhiteboardAsset>>(whiteboardRevisionAssetListPath(id, versionID, cursor), { signal })
  ), referencedFileIDs)
}

export function downloadWhiteboardRevisionAsset(id: string, versionID: string, assetID: string, signal?: AbortSignal) {
  return apiBlob(
    `${WHITEBOARDS_API_ROOT}/${encodeURIComponent(id)}/revisions/${encodeURIComponent(versionID)}/assets/${encodeURIComponent(assetID)}`,
    { signal },
  )
}

export function uploadWhiteboardAsset(id: string, fileID: string, blob: Blob, filename: string, signal?: AbortSignal) {
  const form = new FormData()
  form.set('file_id', fileID)
  form.set('kind', 'asset')
  form.set('file', blob, filename)
  return api<{ success?: boolean; asset: WhiteboardAsset; deduped: boolean }>(`${WHITEBOARDS_API_ROOT}/${encodeURIComponent(id)}/assets`, {
    method: 'POST',
    body: form,
    signal,
  })
}

export function uploadWhiteboardThumbnail(id: string, blob: Blob) {
  const form = new FormData()
  form.set('file_id', 'thumbnail')
  form.set('kind', 'thumbnail')
  form.set('file', blob, 'thumbnail.png')
  return api<{
    success?: boolean
    asset: WhiteboardAsset
    deduped: boolean
    whiteboard?: WhiteboardSummary
    board_version?: number
    thumbnail_url?: string
  }>(`${WHITEBOARDS_API_ROOT}/${encodeURIComponent(id)}/assets`, {
    method: 'POST',
    body: form,
  })
}

function whiteboardGuestAssetsPath(shareLinkID: string, cursor: string | null = null, referencedOnly = false) {
  const params = new URLSearchParams({ link_id: shareLinkID, limit: '200' })
  if (referencedOnly) params.set('referenced_only', '1')
  if (cursor) params.set('cursor', cursor)
  return `/api/whiteboard-guest/assets?${params.toString()}`
}

export async function listWhiteboardGuestAssets(shareLinkID: string, referencedFileIDs: readonly string[], signal?: AbortSignal) {
  return collectWhiteboardAssetPages<WhiteboardGuestAsset>(async cursor => {
    try {
      const response = await fetch(whiteboardGuestAssetsPath(shareLinkID, cursor, true), { credentials: 'include', signal })
      const payload = await response.json().catch(() => ({ error: `Error ${response.status}` })) as {
        assets?: WhiteboardGuestAsset[]
        next_cursor?: string | null
        error?: string
      }
      return response.ok
        ? { success: true as const, data: { assets: payload.assets || [], next_cursor: payload.next_cursor }, status: response.status }
        : { success: false as const, error: payload.error || 'No se pudieron cargar los recursos compartidos.', status: response.status }
    } catch (error) {
      return { success: false as const, error: error instanceof Error ? error.message : 'No se pudieron cargar los recursos compartidos.' }
    }
  }, referencedFileIDs)
}

export async function downloadWhiteboardGuestAsset(shareLinkID: string, assetID: string, signal?: AbortSignal) {
  try {
    const response = await fetch(`/api/whiteboard-guest/assets/${encodeURIComponent(assetID)}?link_id=${encodeURIComponent(shareLinkID)}`, {
      credentials: 'include',
      signal,
    })
    if (response.ok) return { success: true as const, blob: await response.blob(), status: response.status }
    const payload = await response.json().catch(() => ({ error: `Error ${response.status}` })) as { error?: string }
    return { success: false as const, error: payload.error || 'No se pudo cargar un recurso compartido.', status: response.status }
  } catch (error) {
    return { success: false as const, error: error instanceof Error ? error.message : 'No se pudo cargar un recurso compartido.' }
  }
}

export async function uploadWhiteboardGuestAsset(
  shareLinkID: string,
  fileID: string,
  blob: Blob,
  filename: string,
  signal?: AbortSignal,
) {
  const form = new FormData()
  form.set('file_id', fileID)
  form.set('kind', 'asset')
  form.set('file', blob, filename)
  try {
    const response = await fetch(whiteboardGuestAssetsPath(shareLinkID), {
      method: 'POST',
      body: form,
      credentials: 'include',
      signal,
    })
    const payload = await response.json().catch(() => ({ error: `Error ${response.status}` })) as { asset?: WhiteboardGuestAsset; deduped?: boolean; error?: string }
    return response.ok && payload.asset
      ? { success: true as const, data: { asset: payload.asset, deduped: Boolean(payload.deduped) }, status: response.status }
      : { success: false as const, error: payload.error || 'No se pudo guardar un recurso compartido.', status: response.status }
  } catch (error) {
    return { success: false as const, error: error instanceof Error ? error.message : 'No se pudo guardar un recurso compartido.' }
  }
}

export async function requestWhiteboardCollabTicket(id: string) {
  const response = await apiPost<{ success?: boolean; ticket: string }>(`${WHITEBOARDS_API_ROOT}/${encodeURIComponent(id)}/collab-ticket`, {})
  if (!response.success || !response.data?.ticket) throw new Error(response.error || 'La colaboración en tiempo real no está disponible.')
  return response.data.ticket
}

export async function requestWhiteboardGuestCollabTicket(shareLinkID: string) {
  const response = await fetch(`/api/whiteboard-guest/collab-ticket?link_id=${encodeURIComponent(shareLinkID)}`, {
    method: 'POST',
    credentials: 'include',
  })
  const payload = await response.json().catch(() => ({ error: `Error ${response.status}` })) as { ticket?: string; error?: string }
  if (!response.ok || !payload.ticket) throw new Error(payload.error || 'La colaboración en tiempo real no está disponible.')
  return payload.ticket
}

const WHITEBOARD_REALTIME_MAX_PATCH_BYTES = 900_000
const WHITEBOARD_REALTIME_ACK_TIMEOUT_MS = 4_000

export class WhiteboardRealtimeOperationError extends Error {
  readonly code?: string

  constructor(message: string, code?: string) {
    super(message)
    this.name = 'WhiteboardRealtimeOperationError'
    this.code = code
  }
}

export type WhiteboardRoomConnectionState = 'connecting' | 'open' | 'closed'

export interface WhiteboardRealtimeRoom {
  isOpen: () => boolean
  requestSync: () => boolean
  sendPatch: (patch: WhiteboardScenePatch) => Promise<WhiteboardRealtimeEvent> | null
  sendCursor: (cursor: WhiteboardCursorPayload) => boolean
  sendPresence: () => boolean
  close: () => void
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function parseWhiteboardRealtimeEvent(raw: unknown): WhiteboardRealtimeEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const event = String(record.event || '') as WhiteboardRealtimeEvent['event']
  const accepted: WhiteboardRealtimeEvent['event'][] = [
    'scene.patch',
    'scene.snapshot',
    'sync.required',
    'ack',
    'presence.snapshot',
    'presence.update',
    'cursor.update',
    'access.revoked',
    'error',
  ]
  if (!accepted.includes(event)) return null
  const data = objectRecord(record.data)
  let scene: WhiteboardSceneDocument | undefined
  if (data.scene && typeof data.scene === 'object') scene = data.scene as WhiteboardSceneDocument
  if (typeof data.scene === 'string') {
    try {
      const parsed = JSON.parse(data.scene) as unknown
      if (parsed && typeof parsed === 'object') scene = parsed as WhiteboardSceneDocument
    } catch {
      return null
    }
  }
  return {
    event,
    sequence: typeof record.sequence === 'number' ? record.sequence : typeof data.sequence === 'number' ? data.sequence : undefined,
    operation_id: typeof record.operation_id === 'string' ? record.operation_id : typeof data.operation_id === 'string' ? data.operation_id : undefined,
    elements: Array.isArray(data.elements) ? data.elements : undefined,
    app_state: data.app_state && typeof data.app_state === 'object' ? data.app_state as Record<string, unknown> : undefined,
    scene,
    rebased: record.rebased === true || data.rebased === true,
    reason: typeof data.reason === 'string' ? data.reason : undefined,
    actor: Object.keys(objectRecord(record.actor)).length ? objectRecord(record.actor) as unknown as WhiteboardRealtimeEvent['actor'] : undefined,
    data: record.data,
    code: typeof record.code === 'string' ? record.code : undefined,
    error: typeof record.error === 'string' ? record.error : undefined,
  }
}

export function connectWhiteboardRoom(input: {
  whiteboardID: string
  getSequence: () => number
  getTicket: () => Promise<string>
  onEvent: (event: WhiteboardRealtimeEvent) => void
  onConnectionChange?: (state: WhiteboardRoomConnectionState) => void
}): WhiteboardRealtimeRoom {
  let socket: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectAttempt = 0
  let permanentlyClosed = false
  let connectionGeneration = 0
  let cursorTimer: ReturnType<typeof setTimeout> | null = null
  let pendingCursor: WhiteboardCursorPayload | null = null
  let lastCursorSentAt = 0
  const pending = new Map<string, {
    resolve: (event: WhiteboardRealtimeEvent) => void
    reject: (error: Error) => void
    timeout: ReturnType<typeof setTimeout>
  }>()

  const rejectPending = (message: string) => {
    pending.forEach(operation => {
      clearTimeout(operation.timeout)
      operation.reject(new Error(message))
    })
    pending.clear()
  }

  const send = (message: object) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false
    try {
      socket.send(JSON.stringify(message))
      return true
    } catch {
      return false
    }
  }

  const requestSync = () => send({ event: 'sync.request', base_sequence: Math.max(0, input.getSequence()) })

  const sendPresence = () => send(buildWhiteboardPresenceUpdate())

  const flushCursor = () => {
    cursorTimer = null
    const cursor = pendingCursor
    pendingCursor = null
    if (!cursor) return false
    const message = buildWhiteboardCursorUpdate(cursor)
    const encodedData = JSON.stringify(message.data)
    if (new TextEncoder().encode(encodedData).byteLength > 4_000) return false
    const sent = send(message)
    if (sent) lastCursorSentAt = Date.now()
    return sent
  }

  const sendCursor = (cursor: WhiteboardCursorPayload) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false
    pendingCursor = cursor
    const remaining = Math.max(0, 50 - (Date.now() - lastCursorSentAt))
    if (remaining === 0) return flushCursor()
    if (!cursorTimer) cursorTimer = setTimeout(flushCursor, remaining)
    return true
  }

  const scheduleReconnect = () => {
    if (permanentlyClosed) return
    const delay = Math.min(1_000 * 2 ** reconnectAttempt, 10_000)
    reconnectAttempt += 1
    reconnectTimer = setTimeout(() => { void connect() }, delay)
  }

  const connect = async () => {
    if (permanentlyClosed || typeof window === 'undefined') return
    const generation = ++connectionGeneration
    input.onConnectionChange?.('connecting')
    let ticket: string
    try {
      ticket = await input.getTicket()
    } catch {
      if (permanentlyClosed || generation !== connectionGeneration) return
      input.onConnectionChange?.('closed')
      scheduleReconnect()
      return
    }
    if (permanentlyClosed || generation !== connectionGeneration) return
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    socket = new WebSocket(`${protocol}//${window.location.host}${whiteboardRoomSocketPath(input.whiteboardID, ticket)}`)
    socket.onopen = () => {
      reconnectAttempt = 0
      input.onConnectionChange?.('open')
      requestSync()
      sendPresence()
    }
    socket.onmessage = message => {
      let decoded: unknown
      try {
        decoded = JSON.parse(String(message.data)) as unknown
      } catch {
        return
      }
      const event = parseWhiteboardRealtimeEvent(decoded)
      if (!event) return
      if (event.event === 'ack' && event.operation_id) {
        const operation = pending.get(event.operation_id)
        if (operation) {
          pending.delete(event.operation_id)
          clearTimeout(operation.timeout)
          operation.resolve(event)
        }
      }
      if (event.event === 'error' && event.operation_id) {
        const operation = pending.get(event.operation_id)
        if (operation) {
          pending.delete(event.operation_id)
          clearTimeout(operation.timeout)
          operation.reject(new WhiteboardRealtimeOperationError(
            event.error || 'Clarin rechazó el guardado en tiempo real.',
            event.code,
          ))
        }
      }
      input.onEvent(event)
    }
    socket.onerror = () => {
      // onclose owns retry and pending-operation cleanup.
    }
    socket.onclose = () => {
      socket = null
      pendingCursor = null
      if (cursorTimer) clearTimeout(cursorTimer)
      cursorTimer = null
      rejectPending('Se interrumpió la conexión en tiempo real antes de confirmar el guardado.')
      input.onConnectionChange?.('closed')
      if (permanentlyClosed) return
      scheduleReconnect()
    }
  }

  void connect()

  return {
    isOpen: () => Boolean(socket && socket.readyState === WebSocket.OPEN),
    requestSync,
    sendCursor,
    sendPresence,
    sendPatch: patch => {
      if (!socket || socket.readyState !== WebSocket.OPEN || patch.elements.length === 0 || patch.elements.length > 2_000) return null
      const serialized = JSON.stringify(patch)
      if (new TextEncoder().encode(serialized).byteLength > WHITEBOARD_REALTIME_MAX_PATCH_BYTES) return null
      return new Promise<WhiteboardRealtimeEvent>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(patch.operation_id)
          reject(new Error('Clarin no confirmó el guardado en tiempo real.'))
        }, WHITEBOARD_REALTIME_ACK_TIMEOUT_MS)
        pending.set(patch.operation_id, { resolve, reject, timeout })
        try {
          socket!.send(serialized)
        } catch {
          pending.delete(patch.operation_id)
          clearTimeout(timeout)
          reject(new Error('No se pudo enviar el guardado en tiempo real.'))
        }
      })
    },
    close: () => {
      permanentlyClosed = true
      connectionGeneration += 1
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = null
      pendingCursor = null
      if (cursorTimer) clearTimeout(cursorTimer)
      cursorTimer = null
      rejectPending('La sala de la pizarra se cerró.')
      const current = socket
      socket = null
      if (current && current.readyState < WebSocket.CLOSING) current.close(1000, 'whiteboard_closed')
      input.onConnectionChange?.('closed')
    },
  }
}
