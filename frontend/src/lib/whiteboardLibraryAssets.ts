import { api, apiBlob, apiGet } from '@/lib/api'
import {
  collectWhiteboardAssetPages,
  WHITEBOARD_LIBRARIES_API_ROOT,
} from '@/lib/whiteboardsApi'

export const WHITEBOARD_LIBRARY_ASSET_PAGE_LIMIT = 200
export const WHITEBOARD_LIBRARY_ASSET_MAX_BYTES = 10 * 1024 * 1024

const WHITEBOARD_LIBRARY_FILE_ID = /^[A-Za-z0-9_-]{1,255}$/

export interface WhiteboardLibraryAsset {
  id: string
  library_id: string
  file_id: string
  kind: 'asset'
  filename: string
  content_type: string
  media_type: string
  size_bytes: number
  committed_at?: string | null
  draft_expires_at?: string | null
  created_at: string
}

export interface WhiteboardLibraryAssetPage {
  success?: boolean
  assets: WhiteboardLibraryAsset[]
  next_cursor?: string | null
}

export type WhiteboardLibraryAssetPageResult = {
  success: boolean
  data?: WhiteboardLibraryAssetPage
  error?: string
  status?: number
}

export interface WhiteboardLibraryAssetUploadPayload {
  fileID: string
  blob: Blob
  filename: string
}

function libraryAssetCollectionPath(libraryID: string) {
  return `${WHITEBOARD_LIBRARIES_API_ROOT}/${encodeURIComponent(libraryID)}/assets`
}

export function buildWhiteboardLibraryAssetListPath(
  libraryID: string,
  cursor: string | null = null,
  referencedOnly = false,
) {
  const params = new URLSearchParams({ limit: String(WHITEBOARD_LIBRARY_ASSET_PAGE_LIMIT) })
  if (referencedOnly) params.set('referenced_only', '1')
  if (cursor) params.set('cursor', cursor)
  return `${libraryAssetCollectionPath(libraryID)}?${params.toString()}`
}

export function buildWhiteboardLibraryAssetPath(libraryID: string, assetID: string) {
  return `${libraryAssetCollectionPath(libraryID)}/${encodeURIComponent(assetID)}`
}

/**
 * Builds the exact multipart contract accepted by Clarin. Validation mirrors
 * the backend's cheap pre-storage guards; content and image dimensions remain
 * authoritative server checks.
 */
export function buildWhiteboardLibraryAssetUploadForm(
  payload: WhiteboardLibraryAssetUploadPayload,
) {
  const fileID = payload.fileID.trim()
  if (!WHITEBOARD_LIBRARY_FILE_ID.test(fileID)) {
    throw new Error('El identificador del recurso de biblioteca no es válido.')
  }
  if (payload.blob.size <= 0) {
    throw new Error('El recurso de biblioteca está vacío.')
  }
  if (payload.blob.size > WHITEBOARD_LIBRARY_ASSET_MAX_BYTES) {
    throw new Error('El recurso de biblioteca supera el máximo de 10 MB.')
  }

  const form = new FormData()
  form.set('file_id', fileID)
  form.set('file', payload.blob, payload.filename.trim() || fileID)
  return form
}

export function collectWhiteboardLibraryAssetPages(
  loadPage: (cursor: string | null) => Promise<WhiteboardLibraryAssetPageResult>,
  referencedFileIDs?: readonly string[],
) {
  return collectWhiteboardAssetPages<WhiteboardLibraryAsset>(
    loadPage,
    referencedFileIDs,
    asset => asset.file_id,
  )
}

/**
 * Omitting referencedFileIDs lists the complete authorized manifest. Passing
 * a list asks the server for referenced-only rows and also filters client-side,
 * stopping as soon as every requested file ID has been resolved.
 */
export function listWhiteboardLibraryAssets(
  libraryID: string,
  options: { referencedFileIDs?: readonly string[]; signal?: AbortSignal } = {},
) {
  const referencedOnly = options.referencedFileIDs !== undefined
  return collectWhiteboardLibraryAssetPages(cursor => (
    apiGet<WhiteboardLibraryAssetPage>(
      buildWhiteboardLibraryAssetListPath(libraryID, cursor, referencedOnly),
      { signal: options.signal },
    )
  ), options.referencedFileIDs)
}

export function downloadWhiteboardLibraryAsset(
  libraryID: string,
  assetID: string,
  signal?: AbortSignal,
) {
  return apiBlob(buildWhiteboardLibraryAssetPath(libraryID, assetID), { signal })
}

export async function uploadWhiteboardLibraryAsset(
  libraryID: string,
  payload: WhiteboardLibraryAssetUploadPayload,
  signal?: AbortSignal,
) {
  if (signal?.aborted) return { success: false as const, error: 'Solicitud cancelada' }

  let form: FormData
  try {
    form = buildWhiteboardLibraryAssetUploadForm(payload)
  } catch (error) {
    return {
      success: false as const,
      error: error instanceof Error ? error.message : 'El recurso de biblioteca no es válido.',
    }
  }

  return api<{ success?: boolean; asset: WhiteboardLibraryAsset; deduped: boolean }>(
    libraryAssetCollectionPath(libraryID),
    { method: 'POST', body: form, signal },
  )
}

export function deleteWhiteboardLibraryAsset(
  libraryID: string,
  assetID: string,
  signal?: AbortSignal,
) {
  return api<{ success?: boolean }>(
    buildWhiteboardLibraryAssetPath(libraryID, assetID),
    { method: 'DELETE', signal },
  )
}
