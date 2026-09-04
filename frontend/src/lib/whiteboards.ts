export const WHITEBOARD_AUTOSAVE_DELAY_MS = 1200
export const WHITEBOARD_IMPORT_MAX_BYTES = 25 * 1024 * 1024
export const WHITEBOARD_REALTIME_MAX_ELEMENTS = 2000
export const WHITEBOARD_SHARE_EXPORT_DEFAULT = false
export const WHITEBOARD_THUMBNAIL_DEBOUNCE_MS = 1_500
export const WHITEBOARD_THUMBNAIL_MIN_INTERVAL_MS = 60_000
export const WHITEBOARD_SAVE_MAX_AUTOMATIC_FAILURES = 3
export const WHITEBOARD_MANAGER_VIEW_STORAGE_KEY = 'clarin.whiteboards.view.v1'
export const WHITEBOARD_SHOW_DEPRECATED_OFFICIAL_FONTS = true
// Comments remain persisted and API-compatible, but the editor intentionally
// does not expose their UI until a new product interaction is approved.
export const WHITEBOARD_COMMENTS_UI_ENABLED = false

export type WhiteboardScope = 'all' | 'mine' | 'recent' | 'shared' | 'work' | 'trash'
export type WhiteboardViewMode = 'grid' | 'compact' | 'list'
export type WhiteboardManagerLayout = 'narrow' | 'compact' | 'wide'
export type WhiteboardAccessLevel = 'view' | 'comment' | 'edit' | 'manage'

export function retainWhiteboardPendingSave<T>(pending: T | null, create: () => T) {
  return pending ?? create()
}

export function shouldRetryWhiteboardDirtySave(input: {
  dirty: boolean
  saving: boolean
  online: boolean
  canEdit: boolean
}) {
  return input.dirty && !input.saving && input.online && input.canEdit
}

export type WhiteboardSaveFailureAction = 'conflict' | 'retry' | 'terminal' | 'transient_exhausted'
export type WhiteboardSaveRetryBlockReason = Exclude<WhiteboardSaveFailureAction, 'retry'> | null
export type WhiteboardEditorLayout = 'mobile' | 'compact' | 'wide'

export function whiteboardSaveFailureAction(status: number | undefined, automaticFailures: number): WhiteboardSaveFailureAction {
  if (status === 409) return 'conflict'
  if (status !== undefined && [400, 401, 403, 404, 410, 422].includes(status)) return 'terminal'
  return automaticFailures < WHITEBOARD_SAVE_MAX_AUTOMATIC_FAILURES ? 'retry' : 'transient_exhausted'
}

export function whiteboardSaveRetryStateAfterReconnect(input: {
  previouslyOpened: boolean
  automaticFailures: number
  automaticRetryBlockReason: WhiteboardSaveRetryBlockReason
}) {
  const shouldRetry = input.previouslyOpened && input.automaticRetryBlockReason === 'transient_exhausted'
  return {
    shouldRetry,
    automaticFailures: shouldRetry ? 0 : input.automaticFailures,
    automaticRetryBlockReason: shouldRetry ? null : input.automaticRetryBlockReason,
  }
}

export function whiteboardSaveRetryDelay(automaticFailures: number) {
  if (automaticFailures <= 1) return 1_000
  return 2_500
}

export function whiteboardEditorLayout(availableWidth: number): WhiteboardEditorLayout {
  if (!Number.isFinite(availableWidth) || availableWidth < 760) return 'mobile'
  if (availableWidth < 1_280) return 'compact'
  return 'wide'
}

export function whiteboardToolbarShowsShare(availableWidth: number, canManageAccess: boolean) {
  return canManageAccess && Number.isFinite(availableWidth) && availableWidth >= 1_280
}

export function whiteboardToolbarStacksBelowTools(availableWidth: number) {
  return !Number.isFinite(availableWidth) || availableWidth < 960
}

export function whiteboardEditorCanvasActions(allowImageExport: boolean) {
  return {
    loadScene: false,
    saveToActiveFile: false,
    saveAsImage: allowImageExport,
    export: false,
    toggleTheme: false,
  } as const
}

export function whiteboardImageExportDialogAppState() {
  return { openDialog: { name: 'imageExport' as const } }
}

export function whiteboardMoreMenuPosition(
  trigger: { right: number; bottom: number },
  viewport: { width: number; height: number },
) {
  const margin = 12
  const menuWidth = Math.min(336, Math.max(0, viewport.width - margin * 2))
  const maximumRight = Math.max(margin, viewport.width - menuWidth - margin)
  return {
    top: Math.min(trigger.bottom + 8, Math.max(margin, viewport.height - 520)),
    right: Math.min(Math.max(margin, viewport.width - trigger.right), maximumRight),
  }
}

export function whiteboardThumbnailDelay(lastAttemptAt: number, now = Date.now()) {
  return Math.max(WHITEBOARD_THUMBNAIL_DEBOUNCE_MS, lastAttemptAt + WHITEBOARD_THUMBNAIL_MIN_INTERVAL_MS - now)
}

export function buildWhiteboardManualRevisionRequest(expectedSequence: number, operationID: string) {
  return { expected_sequence: Math.max(0, Math.trunc(expectedSequence)), operation_id: operationID }
}

export function whiteboardDuplicateName(name: string) {
  const suffix = ' (copia)'
  const normalized = name.trim() || 'Pizarra'
  return `${normalized.slice(0, 200 - suffix.length).trimEnd()}${suffix}`
}

export function sanitizeWhiteboardExternalLink(value: unknown) {
  if (typeof value !== 'string') return null
  const candidate = value.trim()
  if (!candidate || /[\u0000-\u001f\u007f]/.test(candidate)) return null
  if (!/^(?:https?:|mailto:)/i.test(candidate)) return null
  try {
    const parsed = new URL(candidate)
    if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return null
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && !parsed.hostname) return null
    return parsed.href
  } catch {
    return null
  }
}

export interface WhiteboardEffectiveAccess {
  level: WhiteboardAccessLevel
  inherited_from?: 'account_admin' | 'creator' | 'direct_grant' | 'account_visibility' | string
  can_view: boolean
  can_comment?: boolean
  can_edit: boolean
  can_delete?: boolean
  can_manage_access: boolean
}

export function whiteboardEditorAccess(
  access: WhiteboardEffectiveAccess | null | undefined,
  archivedAt?: string | null,
) {
  const active = !archivedAt
  const canEdit = Boolean(access?.can_edit) && active
  const canComment = Boolean(access?.can_comment ?? access?.can_edit) && active
  return {
    canEdit,
    canComment,
    viewModeEnabled: !canEdit,
  }
}

export interface WhiteboardFolder {
  id: string
  name: string
  description?: string
  parent_id?: string | null
  sort_order?: number
  color?: string | null
  whiteboard_count?: number
  version: number
  archived_at?: string | null
  created_at?: string
  updated_at?: string
  effective_access?: WhiteboardEffectiveAccess
}

export interface WhiteboardFolderRow {
  folder: WhiteboardFolder
  depth: number
}

export interface WhiteboardSummary {
  id: string
  account_id?: string
  name: string
  folder_id?: string | null
  folder_name?: string | null
  thumbnail_url?: string | null
  thumbnail_asset_id?: string | null
  thumbnail_media_asset_id?: string | null
  shared?: boolean
  access_level?: WhiteboardAccessLevel
  owner_name?: string | null
  updated_by_name?: string | null
  created_at: string
  updated_at: string
  archived_at?: string | null
  description?: string
  scene_schema_version?: string
  editor_version?: string
  access_mode?: 'private' | 'account'
  access_revision?: number
  version: number
  scene_sequence: number
  effective_access: WhiteboardEffectiveAccess
  origin?: 'standalone' | 'work'
  work_location?: {
    task_view_id: string
    environment_id: string
    scope_type: 'folder' | 'list'
    scope_id: string
    scope_name: string
    breadcrumb?: Array<{ type: 'environment' | 'folder' | 'list'; id: string; name: string }>
    lifecycle: 'active' | 'location_archived' | 'trash'
  } | null
}

export interface WhiteboardCatalogPresentation {
  archived: boolean
  work: boolean
  badge: 'Clarin Work' | 'Compartida' | null
  contextLabel: string
  actorLabel: string
  updatedLabel: string
  folderLabel: string
  purgeLabel: string | null
  workLocationHref: string | null
  workLocationAriaLabel: string | null
}

export interface WhiteboardSceneDocument {
  [key: string]: unknown
  type: 'excalidraw'
  version: 2
  source: 'clarin'
  elements: readonly unknown[]
  appState: Record<string, unknown>
  files: Record<string, unknown>
}

export interface WhiteboardSceneRecord {
  board_id: string
  scene: WhiteboardSceneDocument
  scene_schema_version: string
  editor_version: string
  sequence: number
  updated_at: string
}

export interface WhiteboardDocument extends WhiteboardSummary {
  scene: WhiteboardSceneDocument
}

export interface WhiteboardVersion {
  id: string
  revision_number: number
  sequence: number
  created_at: string
  actor_id?: string | null
  guest_session_id?: string | null
  write_kind: 'snapshot' | 'patch' | 'restore' | string
  revision_kind: 'automatic' | 'manual' | 'system' | string
  expires_at?: string | null
  snapshot_size_bytes?: number
}

export interface WhiteboardGrant {
  id: string
  user_id: string
  display_name?: string
  username?: string
  email?: string
  access_level: WhiteboardAccessLevel
  can_manage_access: boolean
}

export interface WhiteboardAccessPolicy {
  board_id: string
  access_mode: 'private' | 'account'
  access_revision: number
  effective_access: WhiteboardEffectiveAccess
  grants: WhiteboardGrant[]
}

export interface WhiteboardAccessUpdateInput {
  access_mode: WhiteboardAccessPolicy['access_mode']
  grants: Array<Pick<WhiteboardGrant, 'user_id' | 'access_level'>>
  expected_access_revision: number
}

export interface WhiteboardLibraryRecord {
  id: string
  name: string
  description: string
  /** Present on detail/create/update responses; summary listings omit it. */
  library_json?: unknown
  item_count?: number
  content_size_bytes?: number
  visibility: 'private' | 'account'
  version: number
  created_by?: string | null
  updated_by?: string | null
  archived_at?: string | null
  created_at: string
  updated_at: string
}

export interface WhiteboardAccountUser {
  id: string
  display_name: string
  username: string
  role?: string
}

export interface WhiteboardLibraryItemIdentity {
  id: string
}

export interface WhiteboardShareLink {
  id: string
  board_id: string
  label: string
  // Guest links intentionally stay read/edit only. Comment access belongs to
  // authenticated members of the cuenta and is never inferred for guests.
  access_level: 'view' | 'edit'
  password_protected: boolean
  allow_export: boolean
  expires_at?: string | null
  max_sessions?: number | null
  session_count: number
  revoked_at?: string | null
  last_used_at?: string | null
  created_at: string
}

export interface WhiteboardRealtimeEvent {
	event: 'scene.patch' | 'scene.snapshot' | 'sync.required' | 'ack' | 'presence.snapshot' | 'presence.update' | 'cursor.update' | 'room.ready' | 'presentation.snapshot' | 'presentation.changed' | 'follow.change' | 'viewport.update' | 'comment.changed' | 'access.revoked' | 'error'
  sequence?: number
  operation_id?: string
  elements?: readonly unknown[]
  app_state?: Record<string, unknown>
  scene?: WhiteboardSceneDocument
  rebased?: boolean
  reason?: string
  actor?: WhiteboardRealtimeActor
  data?: unknown
  code?: string
  error?: string
}

export interface WhiteboardRealtimeActor {
  kind: 'user' | 'guest' | string
  id: string
  display_name: string
  access: WhiteboardAccessLevel | string
}

export interface WhiteboardPresentation {
	presentation_id: string
	actor: WhiteboardRealtimeActor
	started_at: string
}

export type WhiteboardViewportBounds = readonly [number, number, number, number]

export function isWhiteboardSceneSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export interface WhiteboardCursorPayload {
  pointer: {
    x: number
    y: number
    tool: 'pointer' | 'laser'
  }
  button: 'down' | 'up'
}

export interface WhiteboardCollaboratorState {
  id: string
  username: string
  pointer?: WhiteboardCursorPayload['pointer']
  button?: WhiteboardCursorPayload['button']
}

export interface WhiteboardSavePayload {
  expected_sequence: number
  operation_id: string
  scene: WhiteboardSceneDocument
  patch?: {
    elements: readonly unknown[]
    app_state: Record<string, unknown>
  }
  scene_schema_version: 'excalidraw'
  editor_version: '0.18.1-clarin.6'
}

export interface WhiteboardScenePatch {
  event: 'scene.patch'
  operation_id: string
  base_sequence: number
  elements: readonly unknown[]
  app_state: Record<string, unknown>
}

export interface WhiteboardCursorUpdate {
  event: 'cursor.update'
  data: WhiteboardCursorPayload
}

export interface WhiteboardPresenceUpdate {
  event: 'presence.update'
  data: { status: 'active' }
}

export interface WhiteboardFollowChange {
	event: 'follow.change'
	data: {
		target_actor_id: string
		action: 'FOLLOW' | 'UNFOLLOW'
	}
}

export interface WhiteboardViewportUpdate {
	event: 'viewport.update'
	data: { bounds: WhiteboardViewportBounds }
}

export interface WhiteboardSceneWritePlan {
  kind: 'patch' | 'snapshot'
  elements: readonly unknown[]
}

export type WhiteboardGuestBootstrap =
  | { kind: 'exchange' }
  | { kind: 'resume'; path: string }

const PERSISTED_APP_STATE_KEYS = [
  'viewBackgroundColor',
  'gridSize',
  'gridStep',
  'gridModeEnabled',
] as const

export function whiteboardSceneRootExtensions(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const { type: _type, version: _version, source: _source, elements: _elements, appState: _appState, files: _files, ...extensions } = value as Record<string, unknown>
  return extensions
}

export function sanitizeWhiteboardAppState(appState: Record<string, unknown>): Record<string, unknown> {
  return PERSISTED_APP_STATE_KEYS.reduce<Record<string, unknown>>((result, key) => {
    const value = appState[key]
    if (value !== undefined) result[key] = value
    return result
  }, {})
}

/**
 * Applies canonical document preferences without replacing the editor session
 * state (viewport, active tool, selection, or an in-progress interaction).
 */
export function mergeWhiteboardSessionAppState(
  currentAppState: Record<string, unknown>,
  canonicalAppState: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...currentAppState,
    ...sanitizeWhiteboardAppState(canonicalAppState),
  }
}

const WHITEBOARD_FILE_LOCATION_OR_BINARY_KEYS = new Set([
  'arraybuffer',
  'base64',
  'binary',
  'blob',
  'bucket',
  'buffer',
  'bytes',
  'content',
  'data',
  'datauri',
  'dataurl',
  'filepath',
  'fileurl',
  'href',
  'location',
  'objectkey',
  'path',
  'payload',
  'raw',
  'src',
  'storagekey',
  'uri',
  'url',
])

const WHITEBOARD_FILE_LOCATION_OR_BINARY_KEY_PARTS = [
  'arraybuffer',
  'base64',
  'binary',
  'blob',
  'bucket',
  'buffer',
  'bytes',
  'dataurl',
  'filepath',
  'fileurl',
  'location',
  'objectkey',
  'payload',
  'storagekey',
] as const

const INVALID_WHITEBOARD_FILE_METADATA = Symbol('invalid-whiteboard-file-metadata')

function normalizedWhiteboardFileMetadataKey(key: string) {
  return key.replace(/[^a-z0-9]/gi, '').toLocaleLowerCase('en')
}

function sanitizeWhiteboardFileMetadataValue(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
): unknown | typeof INVALID_WHITEBOARD_FILE_METADATA {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    return /^(?:blob|data|file|https?):/i.test(value.trim()) ? INVALID_WHITEBOARD_FILE_METADATA : value
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : INVALID_WHITEBOARD_FILE_METADATA
  if (typeof value !== 'object' || depth > 12) return INVALID_WHITEBOARD_FILE_METADATA
  if (seen.has(value)) return INVALID_WHITEBOARD_FILE_METADATA
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const items: unknown[] = []
      for (const item of value) {
        const sanitized = sanitizeWhiteboardFileMetadataValue(item, seen, depth + 1)
        if (sanitized === INVALID_WHITEBOARD_FILE_METADATA) continue
        items.push(sanitized)
      }
      return items
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return INVALID_WHITEBOARD_FILE_METADATA
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const normalizedKey = normalizedWhiteboardFileMetadataKey(key)
      if (
        !normalizedKey
        || WHITEBOARD_FILE_LOCATION_OR_BINARY_KEYS.has(normalizedKey)
        || WHITEBOARD_FILE_LOCATION_OR_BINARY_KEY_PARTS.some(part => normalizedKey.includes(part))
      ) continue
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') continue
      const sanitized = sanitizeWhiteboardFileMetadataValue(item, seen, depth + 1)
      if (sanitized !== INVALID_WHITEBOARD_FILE_METADATA) result[key] = sanitized
    }
    return result
  } finally {
    seen.delete(value)
  }
}

/**
 * Keeps Excalidraw-compatible file metadata in JSONB while all bytes and
 * storage/network locations remain exclusively in Clarin's private assets.
 */
export function sanitizeWhiteboardFilesForPersistence(files: Record<string, unknown> | undefined) {
  if (!files || typeof files !== 'object' || Array.isArray(files)) return {}
  const result: Record<string, unknown> = {}
  for (const [fileID, metadata] of Object.entries(files)) {
    if (!fileID || fileID === '__proto__' || fileID === 'prototype' || fileID === 'constructor') continue
    const sanitized = sanitizeWhiteboardFileMetadataValue(metadata, new WeakSet(), 0)
    if (sanitized && sanitized !== INVALID_WHITEBOARD_FILE_METADATA && typeof sanitized === 'object' && !Array.isArray(sanitized)) {
      result[fileID] = sanitized
    }
  }
  return result
}

export function mergeWhiteboardFileRecords(
  base: Record<string, unknown> | undefined,
  overlay: Record<string, unknown> | undefined,
) {
  const result: Record<string, unknown> = { ...(base || {}) }
  for (const [fileID, value] of Object.entries(overlay || {})) {
    const current = result[fileID]
    result[fileID] = current && value
      && typeof current === 'object' && !Array.isArray(current)
      && typeof value === 'object' && !Array.isArray(value)
      ? { ...(current as Record<string, unknown>), ...(value as Record<string, unknown>) }
      : value
  }
  return result
}

export function buildWhiteboardSavePayload(input: {
  sceneSequence: number
  operationID: string
  reason: 'autosave' | 'manual' | 'import'
  elements: readonly unknown[]
  appState: Record<string, unknown>
  files?: Record<string, unknown>
  includePatch?: boolean
  patchElements?: readonly unknown[]
  rootExtensions?: Record<string, unknown>
}): WhiteboardSavePayload {
  const appState = sanitizeWhiteboardAppState(input.appState)
  return {
    expected_sequence: input.sceneSequence,
    operation_id: input.operationID,
    scene: {
      ...(input.rootExtensions || {}),
      type: 'excalidraw',
      version: 2,
      source: 'clarin',
      elements: input.elements,
      appState,
      files: sanitizeWhiteboardFilesForPersistence(input.files),
    },
    ...(input.includePatch ? { patch: { elements: input.patchElements || input.elements, app_state: appState } } : {}),
    scene_schema_version: 'excalidraw',
    editor_version: '0.18.1-clarin.6',
  }
}

export function buildWhiteboardImportPlan(input: {
  name: string
  folderID?: string | null
  operationID: string
  elements: readonly unknown[]
  appState: Record<string, unknown>
  files?: Record<string, unknown>
  rootExtensions?: Record<string, unknown>
}) {
  return {
    create: { name: input.name, folder_id: input.folderID || null },
    snapshot: buildWhiteboardSavePayload({
      sceneSequence: 0,
      operationID: input.operationID,
      reason: 'import',
      elements: input.elements,
      appState: input.appState,
      files: input.files,
      rootExtensions: input.rootExtensions,
      includePatch: false,
    }),
  }
}

function whiteboardElementRevision(value: unknown) {
  if (!value || typeof value !== 'object') return null
  const element = value as Record<string, unknown>
  if (typeof element.id !== 'string' || !element.id) return null
  return {
    id: element.id,
    version: typeof element.version === 'number' ? element.version : null,
    versionNonce: typeof element.versionNonce === 'number' ? element.versionNonce : null,
    isDeleted: element.isDeleted === true,
  }
}

const WHITEBOARD_RELATIONAL_ELEMENT_KEYS = [
  'index',
  'containerId',
  'frameId',
  'groupIds',
  'boundElements',
  'startBinding',
  'endBinding',
] as const

function whiteboardElementPersistenceState(value: unknown) {
  const revision = whiteboardElementRevision(value)
  if (!revision || !value || typeof value !== 'object' || Array.isArray(value)) return null
  const element = value as Record<string, unknown>
  return {
    ...revision,
    type: typeof element.type === 'string' ? element.type : null,
    image: element.type === 'image' ? {
      fileId: typeof element.fileId === 'string' ? element.fileId : null,
      status: typeof element.status === 'string' ? element.status : null,
      scale: Array.isArray(element.scale) ? element.scale : null,
    } : null,
    relations: Object.fromEntries(WHITEBOARD_RELATIONAL_ELEMENT_KEYS.map(key => [key, element[key] ?? null])),
  }
}

function whiteboardElementRelationshipIDs(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const element = value as Record<string, unknown>
  const related = new Set<string>()
  const add = (candidate: unknown) => {
    if (typeof candidate === 'string' && candidate) related.add(candidate)
  }
  add(element.containerId)
  add(element.frameId)
  for (const bindingKey of ['startBinding', 'endBinding'] as const) {
    const binding = element[bindingKey]
    if (binding && typeof binding === 'object' && !Array.isArray(binding)) {
      add((binding as Record<string, unknown>).elementId)
    }
  }
  if (Array.isArray(element.boundElements)) {
    for (const binding of element.boundElements) {
      if (binding && typeof binding === 'object' && !Array.isArray(binding)) {
        add((binding as Record<string, unknown>).id)
      }
    }
  }
  return Array.from(related)
}

export function diffWhiteboardElements(
  currentElements: readonly unknown[],
  acknowledgedElements: readonly unknown[],
) {
  const acknowledged = new Map<string, ReturnType<typeof whiteboardElementPersistenceState>>()
  for (const value of acknowledgedElements) {
    const state = whiteboardElementPersistenceState(value)
    if (!state) continue
    acknowledged.set(state.id, state)
  }
  return currentElements.filter(value => {
    const state = whiteboardElementPersistenceState(value)
    if (!state) return true
    const previous = acknowledged.get(state.id)
    return !previous || !sameWhiteboardSerializableValue(previous, state)
  })
}

/**
 * Expands a patch to the complete Excalidraw relationship closure. Bindings
 * may change on either side without bumping the container version, so sending
 * only the visibly edited element can otherwise detach text, arrows or frames
 * after a reload.
 */
export function closeWhiteboardElementPatch(
  currentElements: readonly unknown[],
  changedElements: readonly unknown[],
) {
  const currentByID = new Map<string, unknown>()
  const referencesByID = new Map<string, Set<string>>()
  for (const element of currentElements) {
    const revision = whiteboardElementRevision(element)
    if (!revision) continue
    currentByID.set(revision.id, element)
    for (const relatedID of whiteboardElementRelationshipIDs(element)) {
      const references = referencesByID.get(relatedID) || new Set<string>()
      references.add(revision.id)
      referencesByID.set(relatedID, references)
    }
  }
  const included = new Set<string>()
  const unkeyed: unknown[] = []
  for (const element of changedElements) {
    const revision = whiteboardElementRevision(element)
    if (revision) {
      included.add(revision.id)
      if (!currentByID.has(revision.id)) currentByID.set(revision.id, element)
    } else {
      unkeyed.push(element)
    }
  }
  const queue = Array.from(included)
  while (queue.length > 0) {
    const elementID = queue.shift() as string
    const element = currentByID.get(elementID)
    const relatedIDs = [
      ...whiteboardElementRelationshipIDs(element),
      ...Array.from(referencesByID.get(elementID) || []),
    ]
    for (const relatedID of relatedIDs) {
      if (!currentByID.has(relatedID) || included.has(relatedID)) continue
      included.add(relatedID)
      queue.push(relatedID)
    }
  }
  return [
    ...currentElements.filter(element => {
      const revision = whiteboardElementRevision(element)
      return Boolean(revision && included.has(revision.id))
    }),
    ...Array.from(currentByID.entries())
      .filter(([id]) => included.has(id) && !currentElements.some(element => whiteboardElementRevision(element)?.id === id))
      .map(([, element]) => element),
    ...unkeyed,
  ]
}

function sameWhiteboardSerializableValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => sameWhiteboardSerializableValue(value, right[index]))
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord).sort()
  const rightKeys = Object.keys(rightRecord).sort()
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]
      && sameWhiteboardSerializableValue(leftRecord[key], rightRecord[key]))
}

export function hasWhiteboardDocumentMutation(input: {
  currentElements: readonly unknown[]
  previousElements: readonly unknown[]
  currentAppState: Record<string, unknown>
  previousAppState: Record<string, unknown>
  currentFiles?: Record<string, unknown>
  previousFiles?: Record<string, unknown>
}) {
  if (diffWhiteboardElements(input.currentElements, input.previousElements).length > 0) return true
  if (diffWhiteboardElements(input.previousElements, input.currentElements).length > 0) return true
  const currentAppState = sanitizeWhiteboardAppState(input.currentAppState)
  const previousAppState = sanitizeWhiteboardAppState(input.previousAppState)
  if (PERSISTED_APP_STATE_KEYS.some(key => !Object.is(currentAppState[key], previousAppState[key]))) return true
  const currentFiles = sanitizeWhiteboardFilesForPersistence(input.currentFiles || {})
  const previousFiles = sanitizeWhiteboardFilesForPersistence(input.previousFiles || {})
  if (!sameWhiteboardSerializableValue(currentFiles, previousFiles)) return true
  const localFileReadiness = (files: Record<string, unknown> | undefined) => Object.fromEntries(
    Object.entries(files || {}).map(([fileID, rawFile]) => [
      fileID,
      Boolean(rawFile && typeof rawFile === 'object' && !Array.isArray(rawFile)
        && typeof (rawFile as Record<string, unknown>).dataURL === 'string'
        && (rawFile as Record<string, unknown>).dataURL),
    ]),
  )
  return !sameWhiteboardSerializableValue(
    localFileReadiness(input.currentFiles),
    localFileReadiness(input.previousFiles),
  )
}

/**
 * Excalidraw may mutate its binary-file map while an image is being decoded.
 * Keep a record snapshot so that the later fileId/dataURL transition remains
 * observable by autosave instead of aliasing the previous editor state.
 */
export function snapshotWhiteboardFiles(files: Record<string, unknown> | undefined) {
  return Object.fromEntries(Object.entries(files || {}).map(([fileID, rawFile]) => [
    fileID,
    rawFile && typeof rawFile === 'object' && !Array.isArray(rawFile)
      ? { ...(rawFile as Record<string, unknown>) }
      : rawFile,
  ]))
}

export function planWhiteboardAssetPersistence(
  elements: readonly unknown[],
  files: Record<string, unknown> | undefined,
  persistedFileIDs: ReadonlySet<string>,
) {
  const referencedFileIDs = Array.from(new Set(elements.flatMap(rawElement => {
    if (!rawElement || typeof rawElement !== 'object' || Array.isArray(rawElement)) return []
    const element = rawElement as Record<string, unknown>
    return element.type === 'image' && element.isDeleted !== true && typeof element.fileId === 'string' && element.fileId
      ? [element.fileId]
      : []
  })))
  const uploadFileIDs: string[] = []
  const missingFileIDs: string[] = []
  for (const fileID of referencedFileIDs) {
    if (persistedFileIDs.has(fileID)) continue
    const rawFile = files?.[fileID]
    const hasDataURL = Boolean(rawFile && typeof rawFile === 'object' && !Array.isArray(rawFile)
      && typeof (rawFile as Record<string, unknown>).dataURL === 'string'
      && (rawFile as Record<string, unknown>).dataURL)
    if (hasDataURL) uploadFileIDs.push(fileID)
    else missingFileIDs.push(fileID)
  }
  return { referencedFileIDs, uploadFileIDs, missingFileIDs }
}

export type WhiteboardNavigationAction = 'leave' | 'wait' | 'flush' | 'confirm'

export function whiteboardNavigationAction(input: {
  dirty: boolean
  pending: boolean
  saving: boolean
  assetSaving?: boolean
  libraryDirty?: boolean
  librarySaving?: boolean
  commentSaving?: boolean
  commentDirty?: boolean
  flushAttempted: boolean
}): WhiteboardNavigationAction {
  if (!input.dirty && !input.pending && !input.saving && !input.assetSaving && !input.libraryDirty && !input.librarySaving && !input.commentSaving && !input.commentDirty) return 'leave'
  if (input.saving || input.assetSaving || input.librarySaving || input.commentSaving) return 'wait'
  if (!input.flushAttempted && (input.dirty || input.pending || input.libraryDirty)) return 'flush'
  return 'confirm'
}

export function whiteboardNavigationWritesCovered(input: {
  requiredSceneVersion: number | null
  savedSceneVersion: number
  requiredLibraryVersion: number | null
  savedLibraryVersion: number
  commentsPending?: boolean
  commentsDirty?: boolean
}) {
  return (input.requiredSceneVersion === null || input.savedSceneVersion >= input.requiredSceneVersion)
    && (input.requiredLibraryVersion === null || input.savedLibraryVersion >= input.requiredLibraryVersion)
    && !input.commentsPending
    && !input.commentsDirty
}

export function buildWhiteboardSceneWritePlan(
  currentElements: readonly unknown[],
  acknowledgedElements: readonly unknown[],
): WhiteboardSceneWritePlan {
  const elements = closeWhiteboardElementPatch(
    currentElements,
    diffWhiteboardElements(currentElements, acknowledgedElements),
  )
  return elements.length > 0 && elements.length <= WHITEBOARD_REALTIME_MAX_ELEMENTS
    ? { kind: 'patch', elements }
    : { kind: 'snapshot', elements: [] }
}

export function mergeWhiteboardAcknowledgedElements(
  acknowledgedElements: readonly unknown[],
  patchElements: readonly unknown[],
) {
  const replacements = Object.create(null) as Record<string, unknown>
  const appended: unknown[] = []
  for (const value of patchElements) {
    const revision = whiteboardElementRevision(value)
    if (!revision) {
      appended.push(value)
      continue
    }
    replacements[revision.id] = value
  }
  const merged = acknowledgedElements.map(value => {
    const revision = whiteboardElementRevision(value)
    if (!revision || !(revision.id in replacements)) return value
    const replacement = replacements[revision.id]
    delete replacements[revision.id]
    return replacement
  })
  return [...merged, ...Object.values(replacements), ...appended]
}

export function reconcileWhiteboardCanonicalAck(input: {
  canonicalElements: readonly unknown[]
  capturedElements: readonly unknown[]
  currentElements: readonly unknown[]
  canonicalAppState?: Record<string, unknown>
  capturedAppState?: Record<string, unknown>
  currentAppState?: Record<string, unknown>
}) {
  const laterLocalChanges = diffWhiteboardElements(input.currentElements, input.capturedElements)
  const canonicalAppState = sanitizeWhiteboardAppState(input.canonicalAppState || {})
  const capturedAppState = sanitizeWhiteboardAppState(input.capturedAppState || {})
  const currentAppState = sanitizeWhiteboardAppState(input.currentAppState || {})
  const laterLocalAppState = Object.fromEntries(Object.entries(currentAppState).filter(([key, value]) => (
    !Object.is(value, capturedAppState[key])
  )))
  return {
    elements: mergeWhiteboardAcknowledgedElements(input.canonicalElements, laterLocalChanges),
    appState: { ...canonicalAppState, ...laterLocalAppState },
    laterLocalChanges,
  }
}

export function buildWhiteboardGuestBootstrap(shareLinkID: string, hasFragmentSecret: boolean): WhiteboardGuestBootstrap {
  if (hasFragmentSecret) return { kind: 'exchange' }
  return {
    kind: 'resume',
    path: whiteboardGuestScenePath(shareLinkID),
  }
}

export function buildWhiteboardAccessUpdate(
  policy: WhiteboardAccessPolicy,
  accessMode: WhiteboardAccessPolicy['access_mode'],
  grants: readonly WhiteboardGrant[] = policy.grants,
): WhiteboardAccessUpdateInput {
  return {
    access_mode: accessMode,
    grants: grants.map(grant => ({ user_id: grant.user_id, access_level: grant.access_level })),
    expected_access_revision: policy.access_revision,
  }
}

export function sameWhiteboardAccessGrants(left: readonly WhiteboardGrant[], right: readonly WhiteboardGrant[]) {
  const normalize = (grants: readonly WhiteboardGrant[]) => grants
    .map(grant => `${grant.user_id}:${grant.access_level}`)
    .sort()
  const leftKeys = normalize(left)
  const rightKeys = normalize(right)
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index])
}

export function whiteboardPersonalLibraryStorageName(userID: string) {
  return `Mi biblioteca · ${userID}`
}

export function selectWhiteboardPersonalLibrary(libraries: readonly WhiteboardLibraryRecord[], userID: string) {
  const owned = libraries.filter(library => library.visibility === 'private' && library.created_by === userID && !library.archived_at)
  const storageName = whiteboardPersonalLibraryStorageName(userID)
  return owned.find(library => library.name === storageName)
    || owned.find(library => library.name === 'Mi biblioteca')
    || null
}

export function parseWhiteboardLibraryItems(value: unknown): readonly unknown[] {
  let parsed = value
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed) as unknown
    } catch {
      return []
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
  const items = (parsed as Record<string, unknown>).libraryItems
  return Array.isArray(items) ? items : []
}

export function combineWhiteboardLibraryItems<T extends WhiteboardLibraryItemIdentity>(
  personalItems: readonly T[],
  accountCatalogs: readonly (readonly T[])[],
) {
  const combined: T[] = []
  const seen = new Set<string>()
  const readOnlyItemIDs = new Set<string>()
  for (const item of personalItems) {
    if (!item.id || seen.has(item.id)) continue
    seen.add(item.id)
    combined.push(item)
  }
  for (const catalog of accountCatalogs) {
    for (const item of catalog) {
      if (!item.id || seen.has(item.id)) continue
      seen.add(item.id)
      readOnlyItemIDs.add(item.id)
      combined.push(item)
    }
  }
  return { combined, readOnlyItemIDs }
}

export function personalWhiteboardLibraryItems<T extends WhiteboardLibraryItemIdentity>(
  combinedItems: readonly T[],
  readOnlyItemIDs: ReadonlySet<string>,
) {
  return combinedItems.filter(item => !readOnlyItemIDs.has(item.id))
}

export function reconcileWhiteboardLibraryConflict<T extends WhiteboardLibraryItemIdentity>(
  canonicalItems: readonly T[],
  localItems: readonly T[],
) {
  const reconciled = [...canonicalItems]
  const canonicalIDs = new Set(canonicalItems.map(item => item.id))
  for (const item of localItems) {
    if (!canonicalIDs.has(item.id)) reconciled.push(item)
  }
  return reconciled
}

export function buildWhiteboardAccountUserSearchPath(query: string) {
  const params = new URLSearchParams()
  params.set('q', query.trim())
  params.set('limit', '50')
  return `/api/account/users?${params.toString()}`
}

export function filterWhiteboardAccountUsers(
  users: readonly WhiteboardAccountUser[],
  query: string,
  excludedUserIDs: ReadonlySet<string>,
) {
  const normalized = query.trim().toLocaleLowerCase('es')
  if (!normalized) return []
  return users.filter(user => !excludedUserIDs.has(user.id) && [user.display_name, user.username]
    .some(value => value.toLocaleLowerCase('es').includes(normalized))).slice(0, 50)
}

export function whiteboardGuestScenePath(shareLinkID: string) {
  return `/api/whiteboard-guest/scene?link_id=${encodeURIComponent(shareLinkID)}`
}

export function whiteboardRoomSocketPath(whiteboardID: string, ticket: string) {
  return `/ws/whiteboards/${encodeURIComponent(whiteboardID)}?ticket=${encodeURIComponent(ticket)}`
}

export function whiteboardSceneSaveMethod(payload: Pick<WhiteboardSavePayload, 'patch'>): 'PATCH' | 'PUT' {
  return payload.patch ? 'PATCH' : 'PUT'
}

export function buildWhiteboardRealtimePatch(input: {
  sceneSequence: number
  operationID: string
  elements: readonly unknown[]
  appState: Record<string, unknown>
}): WhiteboardScenePatch {
  return {
    event: 'scene.patch',
    operation_id: input.operationID,
    base_sequence: input.sceneSequence,
    elements: input.elements,
    app_state: sanitizeWhiteboardAppState(input.appState),
  }
}

function boundedWhiteboardCoordinate(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.max(-1_000_000, Math.min(1_000_000, value))
}

export function buildWhiteboardCursorUpdate(input: WhiteboardCursorPayload): WhiteboardCursorUpdate {
  return {
    event: 'cursor.update',
    data: {
      pointer: {
        x: boundedWhiteboardCoordinate(input.pointer.x),
        y: boundedWhiteboardCoordinate(input.pointer.y),
        tool: input.pointer.tool === 'laser' ? 'laser' : 'pointer',
      },
      button: input.button === 'down' ? 'down' : 'up',
    },
  }
}

export function buildWhiteboardPresenceUpdate(): WhiteboardPresenceUpdate {
	return { event: 'presence.update', data: { status: 'active' } }
}

export function buildWhiteboardFollowChange(targetActorID: string, action: 'FOLLOW' | 'UNFOLLOW'): WhiteboardFollowChange | null {
	if (!targetActorID.trim()) return null
	return { event: 'follow.change', data: { target_actor_id: targetActorID, action } }
}

export function buildWhiteboardViewportUpdate(bounds: WhiteboardViewportBounds): WhiteboardViewportUpdate | null {
	const normalized = bounds.map(value => Number(value)) as unknown as WhiteboardViewportBounds
	if (normalized.some(value => !Number.isFinite(value) || Math.abs(value) > 1_000_000)) return null
	if (normalized[2] <= normalized[0] || normalized[3] <= normalized[1]) return null
	return { event: 'viewport.update', data: { bounds: normalized } }
}

function realtimeActor(value: unknown): WhiteboardRealtimeActor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const actor = value as Record<string, unknown>
  if (typeof actor.id !== 'string' || !actor.id || typeof actor.display_name !== 'string') return null
  return {
    kind: typeof actor.kind === 'string' ? actor.kind : 'user',
    id: actor.id,
    display_name: actor.display_name,
    access: typeof actor.access === 'string' ? actor.access : 'view',
  }
}

function cursorPayload(value: unknown): WhiteboardCursorPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const data = value as Record<string, unknown>
  if (!data.pointer || typeof data.pointer !== 'object' || Array.isArray(data.pointer)) return null
  const pointer = data.pointer as Record<string, unknown>
  if (typeof pointer.x !== 'number' || typeof pointer.y !== 'number') return null
  return buildWhiteboardCursorUpdate({
    pointer: { x: pointer.x, y: pointer.y, tool: pointer.tool === 'laser' ? 'laser' : 'pointer' },
    button: data.button === 'down' ? 'down' : 'up',
  }).data
}

export function reconcileWhiteboardCollaborators(
  current: ReadonlyMap<string, WhiteboardCollaboratorState>,
  event: Pick<WhiteboardRealtimeEvent, 'event' | 'actor' | 'data'>,
) {
  const next = new Map(current)
  if (event.event === 'presence.snapshot') {
    next.clear()
    if (Array.isArray(event.data)) {
      for (const value of event.data) {
        const actor = realtimeActor(value)
        if (actor) next.set(actor.id, { id: actor.id, username: actor.display_name })
      }
    }
    return next
  }
  const actor = realtimeActor(event.actor)
  if (!actor) return next
  if (event.event === 'presence.update') {
    const status = event.data && typeof event.data === 'object' && !Array.isArray(event.data)
      ? String((event.data as Record<string, unknown>).status || '')
      : ''
    if (status === 'left') next.delete(actor.id)
    else next.set(actor.id, { ...next.get(actor.id), id: actor.id, username: actor.display_name })
    return next
  }
  if (event.event === 'cursor.update') {
    const cursor = cursorPayload(event.data)
    if (cursor) next.set(actor.id, { ...next.get(actor.id), id: actor.id, username: actor.display_name, ...cursor })
  }
  return next
}

export function buildWhiteboardListQuery(input: {
  scope: WhiteboardScope
  folderID?: string | null
  search?: string
  cursor?: string | null
  limit?: number
}) {
  const params = new URLSearchParams()
  params.set('scope', input.scope === 'work' ? 'all' : input.scope)
  if (input.scope === 'work') params.set('origin', 'work')
  params.set('limit', String(Math.min(Math.max(input.limit || 50, 1), 200)))
  if (input.scope === 'trash') params.set('include_archived', 'true')
  if (input.folderID) params.set('folder_id', input.folderID)
  if (input.search?.trim()) params.set('q', input.search.trim())
  if (input.cursor) params.set('cursor', input.cursor)
  return params.toString()
}

export function reconcileWhiteboardScopeCapability(scope: WhiteboardScope, workWhiteboardsEnabled: boolean): WhiteboardScope {
  return scope === 'work' && !workWhiteboardsEnabled ? 'mine' : scope
}

export function filterWhiteboards(whiteboards: readonly WhiteboardSummary[], settledSearch: string) {
  const query = settledSearch.trim().toLocaleLowerCase('es')
  if (!query) return [...whiteboards]
  return whiteboards.filter(whiteboard => [
    whiteboard.name,
    whiteboard.description,
    whiteboard.folder_name,
    whiteboard.owner_name,
    whiteboard.work_location?.scope_name,
    ...(whiteboard.work_location?.breadcrumb?.map(item => item.name) || []),
  ]
    .some(value => value?.toLocaleLowerCase('es').includes(query)))
}

export function reconcileWhiteboardSummary(
  current: readonly WhiteboardSummary[],
  incoming: WhiteboardSummary,
  scope: WhiteboardScope,
) {
  const withoutIncoming = current.filter(item => item.id !== incoming.id)
  if ((scope === 'trash') !== Boolean(incoming.archived_at)) return withoutIncoming
  if (scope === 'mine' && incoming.shared) return withoutIncoming
  if (scope === 'shared' && !incoming.shared) return withoutIncoming
  if (scope === 'work' && incoming.origin !== 'work') return withoutIncoming
  if (scope === 'recent' && Date.now() - Date.parse(incoming.updated_at) > 30 * 24 * 60 * 60 * 1000) return withoutIncoming
  return [...withoutIncoming, incoming].sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at))
}

export function shouldApplyWhiteboardRealtimeEvent(input: {
  currentSceneSequence: number
  localOperationID?: string | null
  event: Pick<WhiteboardRealtimeEvent, 'sequence' | 'operation_id'>
}) {
  if (input.event.operation_id && input.event.operation_id === input.localOperationID) return false
  return isWhiteboardSceneSequence(input.event.sequence) && input.event.sequence > input.currentSceneSequence
}

export function reconcileWhiteboardConnectionOpen(previouslyOpened: boolean) {
  return {
    hasOpened: true,
    reloadComments: previouslyOpened,
  }
}

// A sync.required can replace a saturated realtime queue. Scene recovery alone
// is insufficient for authenticated members because the displaced payload may
// have been comment.changed; reload both canonical resources. Guests never
// receive Clarin-owned comments.
export function whiteboardRealtimeSyncRecoveryPlan(audience: 'member' | 'guest') {
  return {
    reloadScene: true,
    reloadComments: audience === 'member',
  }
}

export function createWhiteboardOperationID() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `whiteboard-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function whiteboardFileName(name: string, extension: string) {
  const safeName = name.trim().replace(/[^a-zA-Z0-9À-ÿ._-]+/g, '-').replace(/^-+|-+$/g, '') || 'pizarra'
  return `${safeName}.${extension.replace(/^\./, '')}`
}

export function validateWhiteboardImport(file: Pick<File, 'name' | 'size' | 'type'>): string | null {
  if (file.size > WHITEBOARD_IMPORT_MAX_BYTES) return 'El archivo supera el límite de 25 MB.'
  const name = file.name.toLocaleLowerCase('es')
  const acceptedExtension = name.endsWith('.excalidraw') || name.endsWith('.json')
  const acceptedMime = !file.type || file.type === 'application/json' || file.type === 'application/octet-stream'
  if (!acceptedExtension || !acceptedMime) return 'Selecciona un archivo .excalidraw o JSON compatible.'
  return null
}

export function formatWhiteboardUpdatedAt(value: string, now = Date.now()) {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return 'Fecha desconocida'
  const deltaMinutes = Math.max(0, Math.floor((now - timestamp) / 60_000))
  if (deltaMinutes < 1) return 'Ahora'
  if (deltaMinutes < 60) return `Hace ${deltaMinutes} min`
  const deltaHours = Math.floor(deltaMinutes / 60)
  if (deltaHours < 24) return `Hace ${deltaHours} h`
  return new Intl.DateTimeFormat('es', { dateStyle: 'medium' }).format(new Date(timestamp))
}

export function whiteboardPurgeEligibleAt(archivedAt: string | null | undefined, retentionDays: number) {
  if (!archivedAt || !Number.isFinite(retentionDays) || retentionDays < 1) return null
  const archivedTime = Date.parse(archivedAt)
  if (!Number.isFinite(archivedTime)) return null
  return new Date(archivedTime + Math.floor(retentionDays) * 86_400_000).toISOString()
}

export function formatWhiteboardPurgeEligibility(value: string | null) {
  if (!value) return 'Fecha de eliminación no disponible'
  return `Eliminación definitiva desde ${new Intl.DateTimeFormat('es', { dateStyle: 'medium' }).format(new Date(value))}`
}

export function whiteboardCatalogPresentation(
  whiteboard: WhiteboardSummary,
  purgeEligibleAt: string | null,
  now = Date.now(),
): WhiteboardCatalogPresentation {
  const archived = Boolean(whiteboard.archived_at)
  const work = whiteboard.origin === 'work' && Boolean(whiteboard.work_location)
  const workBreadcrumb = whiteboard.work_location?.breadcrumb
    ?.map(item => item.name.trim())
    .filter(Boolean)
    .join(' / ')
    || whiteboard.work_location?.scope_name?.trim()
    || 'Ubicación autorizada'
  const taskViewID = whiteboard.work_location?.task_view_id?.trim()
  const canOpenWorkLocation = work
    && !archived
    && whiteboard.work_location?.lifecycle !== 'trash'
    && Boolean(taskViewID)
  const workLocationHref = canOpenWorkLocation
    ? `/dashboard/tasks?work_view=${encodeURIComponent(taskViewID as string)}`
    : null
  const folderLabel = whiteboard.folder_name?.trim() || 'Sin carpeta'
  const actorLabel = whiteboard.updated_by_name?.trim() || whiteboard.owner_name?.trim() || 'Cuenta'
  const standaloneContext = whiteboard.description?.trim() || actorLabel

  return {
    archived,
    work,
    badge: work ? 'Clarin Work' : whiteboard.shared ? 'Compartida' : null,
    contextLabel: work ? workBreadcrumb : standaloneContext,
    actorLabel,
    updatedLabel: formatWhiteboardUpdatedAt(whiteboard.updated_at, now),
    folderLabel,
    purgeLabel: archived ? formatWhiteboardPurgeEligibility(purgeEligibleAt) : null,
    workLocationHref,
    workLocationAriaLabel: workLocationHref
      ? `Abrir ubicación en Work · ${whiteboard.name} · ${workBreadcrumb}`
      : null,
  }
}

export function buildWhiteboardPurgeRequest(confirmationName: string, operationID: string) {
  return { confirmation_name: confirmationName, operation_id: operationID }
}

export function whiteboardManagerLayout(width: number): WhiteboardManagerLayout {
  if (width < 760) return 'narrow'
  if (width < 1080) return 'compact'
  return 'wide'
}

export function parseWhiteboardViewMode(value: string | null | undefined): WhiteboardViewMode {
  return value === 'grid' || value === 'list' || value === 'compact' ? value : 'compact'
}

export function flattenWhiteboardFolders(folders: readonly WhiteboardFolder[]): WhiteboardFolderRow[] {
  const children = new Map<string | null, WhiteboardFolder[]>()
  for (const folder of folders.filter(item => !item.archived_at)) {
    const parentID = folder.parent_id && folders.some(parent => parent.id === folder.parent_id && !parent.archived_at)
      ? folder.parent_id
      : null
    children.set(parentID, [...(children.get(parentID) || []), folder])
  }
  children.forEach(items => items.sort((left, right) => {
    const leftHasOrder = typeof left.sort_order === 'number' && Number.isFinite(left.sort_order)
    const rightHasOrder = typeof right.sort_order === 'number' && Number.isFinite(right.sort_order)
    if (leftHasOrder && rightHasOrder && left.sort_order !== right.sort_order) {
      return (left.sort_order as number) - (right.sort_order as number)
    }
    if (leftHasOrder !== rightHasOrder) return leftHasOrder ? -1 : 1
    const byName = left.name.localeCompare(right.name, 'es')
    return byName || left.id.localeCompare(right.id)
  }))
  const rows: WhiteboardFolderRow[] = []
  const visited = new Set<string>()
  const visit = (parentID: string | null, depth: number) => {
    for (const folder of children.get(parentID) || []) {
      if (visited.has(folder.id)) continue
      visited.add(folder.id)
      rows.push({ folder, depth })
      visit(folder.id, Math.min(depth + 1, 4))
    }
  }
  visit(null, 0)
  for (const folder of folders) {
    if (!folder.archived_at && !visited.has(folder.id)) rows.push({ folder, depth: 0 })
  }
  return rows
}
