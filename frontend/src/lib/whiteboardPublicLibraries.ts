const WHITEBOARD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PUBLIC_LIBRARY_TOKEN_PATTERN = /^[a-z0-9_-]{32,128}$/i

export const WHITEBOARD_PUBLIC_LIBRARY_CALLBACK_PATH = '/whiteboards/library-import'
export const WHITEBOARD_PUBLIC_LIBRARY_IMPORT_QUERY = 'library_import'
export const WHITEBOARD_PUBLIC_LIBRARY_FRAGMENT_MAX_LENGTH = 8 * 1024
export const WHITEBOARD_PUBLIC_LIBRARY_START_GLOBAL = '__CLARIN_WHITEBOARD_LIBRARY_START_URL__'
export const WHITEBOARD_PUBLIC_LIBRARY_CALLBACK_STORAGE_KEY = 'clarin:whiteboard-public-library-callback:v1'
export const WHITEBOARD_PUBLIC_LIBRARY_CALLBACK_TTL_MS = 10 * 60 * 1000

declare global {
  // Read only by Clarin's audited Excalidraw hardening patch. The value is
  // always a relative same-origin URL and is never copied to the public site.
  // eslint-disable-next-line no-var
  var __CLARIN_WHITEBOARD_LIBRARY_START_URL__: string | undefined
}

export type WhiteboardPublicLibraryImportStatus = 'pending' | 'fetching' | 'ready' | 'completed' | 'expired' | 'failed'

export interface WhiteboardPublicLibraryImportRecord {
  id: string
  board_id: string
  library_id: string
  status: WhiteboardPublicLibraryImportStatus
  library_json?: unknown
  source_url?: string
  expires_at?: string
}

export interface WhiteboardPublicLibraryNavigation {
  path: string
  importID: string
}

export type WhiteboardPublicLibraryCallbackTokens = {
  token: string
  libraryURL: string
}

export type WhiteboardPublicLibraryCallbackParseResult =
  | { ok: true; tokens: WhiteboardPublicLibraryCallbackTokens }
  | { ok: false; error: string }

function normalizedIdentifier(value: string) {
  return value.trim()
}

export function isWhiteboardPublicLibraryIdentifier(value: unknown): value is string {
  return typeof value === 'string' && WHITEBOARD_ID_PATTERN.test(value.trim())
}

/**
 * Builds the only URL the embedded editor may use for public-library browsing.
 * The browser navigates to Clarin first; no third-party URL is present in the
 * application bundle or fetched by the editor.
 */
export function buildWhiteboardPublicLibraryStartPath(boardID: string, libraryID: string) {
  const board = normalizedIdentifier(boardID)
  const library = normalizedIdentifier(libraryID)
  if (!isWhiteboardPublicLibraryIdentifier(board) || !isWhiteboardPublicLibraryIdentifier(library)) return null
  return `/api/whiteboards/${encodeURIComponent(board)}/public-library-import/start?library_id=${encodeURIComponent(library)}`
}

/**
 * Recognises the exact document-navigation route for the active board and
 * personal library. This deliberately does not read the editor global: that
 * global only supplies the native Excalidraw link and can be ownership-cleaned
 * while an already-rendered anchor is still visible.
 */
export function isWhiteboardPublicLibraryStartPath(
  path: string,
  boardID: string,
  libraryID: string | null | undefined,
) {
  if (!libraryID) return false
  const expected = buildWhiteboardPublicLibraryStartPath(boardID, libraryID)
  return expected !== null && path === expected
}

/**
 * Accepts only the exact same-origin navigation path returned by Clarin. The
 * one-use proof lives in an HttpOnly cookie, so neither that proof nor the
 * third-party catalog URL is exposed to the editor bundle or browser history.
 */
export function validateWhiteboardPublicLibraryNavigationPath(
  value: unknown,
  expectedBoardID: string,
): WhiteboardPublicLibraryNavigation | null {
  const boardID = normalizedIdentifier(expectedBoardID)
  if (!isWhiteboardPublicLibraryIdentifier(boardID)
    || typeof value !== 'string'
    || value.length > 1024
    || !value.startsWith('/api/whiteboards/')) return null

  try {
    const parsed = new URL(value, 'https://clarin.invalid')
    if (parsed.origin !== 'https://clarin.invalid' || parsed.hash) return null
    const segments = parsed.pathname.split('/').filter(Boolean)
    if (segments.length !== 6
      || segments[0] !== 'api'
      || segments[1] !== 'whiteboards'
      || segments[2] !== boardID
      || segments[3] !== 'public-library-imports'
      || segments[5] !== 'navigate'
      || !isWhiteboardPublicLibraryIdentifier(segments[4])) return null

    if (parsed.search) return null
    const canonicalPath = parsed.pathname
    if (value !== canonicalPath) return null
    return { path: canonicalPath, importID: segments[4] }
  } catch {
    return null
  }
}

/**
 * Publishes the active board's same-origin start route for the hardened native
 * library button. Cleanup is ownership-aware so a stale editor cannot clear a
 * newer board's route during a fast navigation.
 */
export function installWhiteboardPublicLibraryStartPath(boardID: string, libraryID: string) {
  const path = buildWhiteboardPublicLibraryStartPath(boardID, libraryID)
  if (typeof globalThis === 'undefined') return () => undefined
  globalThis.__CLARIN_WHITEBOARD_LIBRARY_START_URL__ = path || undefined
  return () => {
    if (globalThis.__CLARIN_WHITEBOARD_LIBRARY_START_URL__ === path) {
      delete globalThis.__CLARIN_WHITEBOARD_LIBRARY_START_URL__
    }
  }
}

export function buildWhiteboardPublicLibraryImportPath(boardID: string, importID: string) {
  const board = normalizedIdentifier(boardID)
  const imported = normalizedIdentifier(importID)
  if (!isWhiteboardPublicLibraryIdentifier(board) || !isWhiteboardPublicLibraryIdentifier(imported)) return null
  return `/api/whiteboards/${encodeURIComponent(board)}/public-library-imports/${encodeURIComponent(imported)}`
}

export function buildWhiteboardPublicLibraryImportCompletePath(boardID: string, importID: string) {
  const path = buildWhiteboardPublicLibraryImportPath(boardID, importID)
  return path ? `${path}/complete` : null
}

export function buildWhiteboardPublicLibraryReturnPath(boardID: string, importID: string) {
  const board = normalizedIdentifier(boardID)
  const imported = normalizedIdentifier(importID)
  if (!isWhiteboardPublicLibraryIdentifier(board) || !isWhiteboardPublicLibraryIdentifier(imported)) return null
  const query = new URLSearchParams({ [WHITEBOARD_PUBLIC_LIBRARY_IMPORT_QUERY]: imported })
  return `/dashboard/whiteboards/${encodeURIComponent(board)}?${query.toString()}`
}

export function buildWhiteboardPublicLibraryLoginPath() {
  const query = new URLSearchParams({
    reason: 'expired',
    next: WHITEBOARD_PUBLIC_LIBRARY_CALLBACK_PATH,
  })
  return `/login?${query.toString()}`
}

export function readWhiteboardPublicLibraryImportID(search: string) {
  const value = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
    .get(WHITEBOARD_PUBLIC_LIBRARY_IMPORT_QUERY)
    ?.trim()
  return isWhiteboardPublicLibraryIdentifier(value) ? value : null
}

export function stripWhiteboardPublicLibraryImportFromPath(pathname: string, search: string, hash = '') {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  params.delete(WHITEBOARD_PUBLIC_LIBRARY_IMPORT_QUERY)
  const nextSearch = params.toString()
  return `${pathname}${nextSearch ? `?${nextSearch}` : ''}${hash}`
}

/**
 * Parses the fragment produced by the official directory. Fragments never
 * reach the HTTP request or server logs. The caller must remove it from the
 * address bar before starting the callback request.
 */
export function parseWhiteboardPublicLibraryCallbackFragment(hash: string): WhiteboardPublicLibraryCallbackParseResult {
  if (!hash || hash.length > WHITEBOARD_PUBLIC_LIBRARY_FRAGMENT_MAX_LENGTH) {
    return { ok: false, error: 'El enlace de la biblioteca está vacío o es demasiado largo.' }
  }
  const source = hash.startsWith('#') ? hash.slice(1) : hash
  const params = new URLSearchParams(source)
  const libraryValues = params.getAll('addLibrary')
  const tokenValues = params.getAll('token')
  if (libraryValues.length !== 1 || tokenValues.length !== 1) {
    return { ok: false, error: 'El enlace de la biblioteca no tiene el formato esperado.' }
  }

  const token = tokenValues[0].trim()
  if (!PUBLIC_LIBRARY_TOKEN_PATTERN.test(token)) {
    return { ok: false, error: 'La autorización de importación no es válida.' }
  }

  const libraryURL = libraryValues[0].trim()
  if (!libraryURL || libraryURL.length > 4096 || /[\u0000-\u001f\u007f]/.test(libraryURL)) {
    return { ok: false, error: 'La dirección de la biblioteca no es válida.' }
  }
  try {
    const parsed = new URL(libraryURL)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname) {
      return { ok: false, error: 'La dirección de la biblioteca no es segura.' }
    }
    if (!parsed.pathname.toLocaleLowerCase('en').endsWith('.excalidrawlib')) {
      return { ok: false, error: 'La dirección no apunta a una biblioteca compatible.' }
    }
    return { ok: true, tokens: { token, libraryURL: parsed.href } }
  } catch {
    return { ok: false, error: 'La dirección de la biblioteca no es válida.' }
  }
}

export function whiteboardPublicLibraryCallbackError(status?: number) {
  if (status === 401) return 'Tu sesión expiró. Inicia sesión y vuelve a explorar la biblioteca.'
  if (status === 403) return 'No tienes permiso para importar esta biblioteca en la pizarra.'
  if (status === 404 || status === 410) return 'La solicitud de importación venció. Vuelve a abrir el catálogo desde la pizarra.'
  if (status === 413) return 'La biblioteca supera el tamaño permitido por Clarin.'
  if (status === 422) return 'Clarin rechazó la biblioteca porque contiene datos o recursos no permitidos.'
  if (status === 429) return 'Hay demasiadas importaciones en curso. Espera un momento y vuelve a intentarlo.'
  return 'No se pudo validar la biblioteca. Revisa tu conexión y vuelve a intentarlo.'
}

export function validateWhiteboardPublicLibraryImportRecord(
  value: unknown,
  expectedBoardID: string,
  expectedImportID: string,
  expectedLibraryID?: string,
): WhiteboardPublicLibraryImportRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.id !== expectedImportID || record.board_id !== expectedBoardID) return null
  if (!isWhiteboardPublicLibraryIdentifier(record.id)
    || !isWhiteboardPublicLibraryIdentifier(record.board_id)
    || !isWhiteboardPublicLibraryIdentifier(record.library_id)) return null
  if (expectedLibraryID && record.library_id !== expectedLibraryID) return null
  if (!['pending', 'fetching', 'ready', 'completed', 'expired', 'failed'].includes(String(record.status))) return null
  if (record.status === 'ready' && (!record.library_json || typeof record.library_json !== 'object' || Array.isArray(record.library_json))) return null
  return record as unknown as WhiteboardPublicLibraryImportRecord
}

export async function consumeWhiteboardPublicLibraryImport(input: {
  boardID: string
  importID: string
  libraryID: string
  load: () => Promise<WhiteboardPublicLibraryImportRecord>
  mergeAndPersist: (libraryJSON: unknown, record: WhiteboardPublicLibraryImportRecord) => Promise<{ libraryVersion: number }>
  complete: (input: { operationID: string; libraryVersion: number }) => Promise<void>
}) {
  const record = validateWhiteboardPublicLibraryImportRecord(
    await input.load(),
    input.boardID,
    input.importID,
    input.libraryID,
  )
  if (!record) throw new Error('Clarin devolvió una importación de biblioteca no válida.')
  if (record.status === 'completed') return { status: 'completed' as const, record, alreadyCompleted: true }
  if (record.status !== 'ready') {
    throw new Error(record.status === 'expired'
      ? 'La importación de biblioteca venció.'
      : 'La biblioteca todavía no está lista para importarse.')
  }

  const persisted = await input.mergeAndPersist(record.library_json, record)
  if (!Number.isSafeInteger(persisted.libraryVersion) || persisted.libraryVersion <= 0) {
    throw new Error('Clarin no confirmó la versión persistida de Mi biblioteca.')
  }
  await input.complete({
    // The import UUID is stable across retries and makes the acknowledgement
    // idempotent when the prior response was lost.
    operationID: record.id,
    libraryVersion: persisted.libraryVersion,
  })
  return { status: 'completed' as const, record, alreadyCompleted: false }
}

export async function acknowledgeWhiteboardPublicLibraryImportAfterConflict<T extends {
  success: boolean
  status?: number
}>(input: {
  operationID: string
  libraryVersion: number
  complete: (value: { operationID: string; libraryVersion: number }) => Promise<T>
  reconcileLibraryVersion: () => Promise<number | null>
}) {
  let libraryVersion = input.libraryVersion
  let response = await input.complete({ operationID: input.operationID, libraryVersion })
  let reconciled = false
  if (!response.success && response.status === 409) {
    const canonicalVersion = await input.reconcileLibraryVersion()
    if (!Number.isSafeInteger(canonicalVersion) || Number(canonicalVersion) <= 0) {
      return { response, libraryVersion, reconciled }
    }
    libraryVersion = Number(canonicalVersion)
    reconciled = true
    response = await input.complete({ operationID: input.operationID, libraryVersion })
  }
  return { response, libraryVersion, reconciled }
}
