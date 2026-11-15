import { api, apiBlob } from '@/lib/api'
import type { Utility } from '../catalog'

export type UtilityKind = Utility['id']
export interface UtilityContent { slot: string; version: number; bytes: number; content_type?: string; indexing?: boolean }
export interface UtilityDocument {
  id: string; type: UtilityKind; title: string; folder_id: string | null; favorite: boolean; version: number
  config: Record<string, unknown>; slots: UtilityContent[]; created_at: string; updated_at: string
  snippet?: string
}
export interface UtilityFolder { id: string; name: string; version: number }
export interface UtilityWorkspaceState { open_ids: string[]; active_id: string | null; version: number }
export interface LibraryPage { documents: UtilityDocument[]; next_cursor?: string; has_more: boolean }
export class UtilityRequestError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = 'UtilityRequestError' }
}
export async function libraryRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const result = await api<{ success: boolean; data: T }>(`/api/utilities${path}`, { ...options, cache: 'no-store', authMode: 'background' })
  if (!result.success || !result.data || result.data.success === false || result.data.data === undefined) throw new UtilityRequestError(result.error || 'No se pudo completar la operación.', result.status)
  return result.data.data
}
export const jsonRequest = (method: string, value: unknown): RequestInit => ({ method, body: JSON.stringify(value) })
export const operationId = () => crypto.randomUUID()
export async function readDocumentSlot(id: string, slot: string, signal?: AbortSignal): Promise<Blob> {
  const result = await apiBlob(`/api/utilities/documents/${id}/content/${encodeURIComponent(slot)}`, { signal, authMode: 'background' })
  if (!result.success || !result.blob) throw new UtilityRequestError(result.error || 'No se pudo abrir el archivo guardado.', result.status)
  return result.blob
}

export interface TextEdit { offset: number; delete_count: number; text: string }
/** A single contiguous replacement, in the UTF-16 offsets used by Monaco. */
export function minimalTextEdit(before: string, after: string): TextEdit | null {
  if (before === after) return null
  let start = 0
  const common = Math.min(before.length, after.length)
  while (start < common && before.charCodeAt(start) === after.charCodeAt(start)) start++
  // Never split a surrogate pair at a patch boundary.
  if (start > 0 && /[\uD800-\uDBFF]/.test(before[start - 1]) && /[\uDC00-\uDFFF]/.test(before[start] || after[start] || '')) start--
  let left = before.length, right = after.length
  while (left > start && right > start && before.charCodeAt(left - 1) === after.charCodeAt(right - 1)) { left--; right-- }
  if (left < before.length && left > start && /[\uD800-\uDBFF]/.test(before[left - 1]) && /[\uDC00-\uDFFF]/.test(before[left])) { left++; right++ }
  return { offset: start, delete_count: left - start, text: after.slice(start, right) }
}

export function moveOpenDocument(ids: readonly string[], id: string, offset: number) {
  const from = ids.indexOf(id), to = from + offset
  if (from < 0 || to < 0 || to >= ids.length) return [...ids]
  const result = [...ids]
  result.splice(from, 1); result.splice(to, 0, id)
  return result
}

export function closeOpenDocument(workspace: UtilityWorkspaceState, id: string): UtilityWorkspaceState {
  const index = workspace.open_ids.indexOf(id)
  const ids = workspace.open_ids.filter(open => open !== id)
  return { ...workspace, open_ids: ids, active_id: workspace.active_id === id ? ids[Math.min(index, ids.length - 1)] ?? null : workspace.active_id }
}

export function deletedWorkspaceMatches(current: UtilityWorkspaceState, id: string, canonical: UtilityWorkspaceState | null | undefined) {
  return Boolean(canonical && canonical.active_id === (current.active_id === id ? null : current.active_id)
    && JSON.stringify(canonical.open_ids) === JSON.stringify(current.open_ids.filter(open => open !== id)))
}
