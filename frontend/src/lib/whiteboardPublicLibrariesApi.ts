import { api, apiGet } from '@/lib/api'
import {
  buildWhiteboardPublicLibraryStartPath,
  buildWhiteboardPublicLibraryImportCompletePath,
  buildWhiteboardPublicLibraryImportPath,
  type WhiteboardPublicLibraryCallbackTokens,
  type WhiteboardPublicLibraryImportRecord,
} from '@/lib/whiteboardPublicLibraries'

export const WHITEBOARD_PUBLIC_LIBRARY_CALLBACK_API_PATH = '/api/whiteboards/public-library-import/callback'
export const WHITEBOARD_PUBLIC_LIBRARY_START_HEADER = 'X-Clarin-Whiteboard-Library-Start'

export function startWhiteboardPublicLibraryImport(
  boardID: string,
  libraryID: string,
  signal?: AbortSignal,
) {
  const path = buildWhiteboardPublicLibraryStartPath(boardID, libraryID)
  if (!path) return Promise.resolve({ success: false as const, error: 'La exploración de bibliotecas solicitada no es válida.', status: 400 })
  return api<{ success?: boolean; navigation_path?: string }>(path, {
    method: 'POST',
    body: '{}',
    headers: { [WHITEBOARD_PUBLIC_LIBRARY_START_HEADER]: '1' },
    redirect: 'error',
    signal,
  })
}

export function submitWhiteboardPublicLibraryCallback(
  tokens: WhiteboardPublicLibraryCallbackTokens,
  signal?: AbortSignal,
) {
  return api<{ success?: boolean; import_id?: string; board_id?: string; code?: string }>(
    WHITEBOARD_PUBLIC_LIBRARY_CALLBACK_API_PATH,
    {
      method: 'POST',
      body: JSON.stringify({ token: tokens.token, library_url: tokens.libraryURL }),
      signal,
      // The callback route must be able to capture and clear its fragment before
      // auth recovery. It handles a 401 explicitly instead of allowing the
      // generic API helper to navigate away and discard the callback.
      skipAuth: true,
    },
  )
}

export function getWhiteboardPublicLibraryImport(boardID: string, importID: string, signal?: AbortSignal) {
  const path = buildWhiteboardPublicLibraryImportPath(boardID, importID)
  if (!path) return Promise.resolve({ success: false as const, error: 'La importación solicitada no es válida.', status: 400 })
  return apiGet<{ success?: boolean; import?: WhiteboardPublicLibraryImportRecord }>(path, { signal })
}

export function completeWhiteboardPublicLibraryImport(
  boardID: string,
  importID: string,
  input: { operationID: string; libraryVersion: number },
  signal?: AbortSignal,
) {
  const path = buildWhiteboardPublicLibraryImportCompletePath(boardID, importID)
  if (!path) return Promise.resolve({ success: false as const, error: 'La importación solicitada no es válida.', status: 400 })
  return api<{ success?: boolean; import?: WhiteboardPublicLibraryImportRecord }>(path, {
    method: 'POST',
    body: JSON.stringify({
      operation_id: input.operationID,
      library_version: input.libraryVersion,
    }),
    signal,
  })
}
