export type StorageAction = 'trash' | 'restore' | 'purge'
export type StorageTab = 'files' | 'trash' | 'activity'
export type MediaType = 'image' | 'video' | 'audio' | 'document'
export interface StorageOrigin { type: string; label: string; href?: string }
export interface StorageFile {
  object_key: string; filename: string; media_type: MediaType; size_bytes: number
  last_modified?: string; origins: StorageOrigin[]; references_count: number
  can_remove: boolean; can_restore?: boolean; can_purge?: boolean; blocked_reason?: string
  preview_url?: string; status: 'active' | 'trash'; trash_at?: string; purge_after?: string
}
export interface StorageUsage {
  scope: 'authorized' | 'account'; managed_elsewhere_bytes?: number
  used_bytes: number; visible_bytes: number; limit_bytes: number; available_bytes: number
  percent_used: number; object_count: number; by_type: Record<string, number>
  by_origin: Record<string, number>; removable_bytes: number; removable_count: number
  trash_bytes: number; can_manage: boolean; retention_days: number
}
export interface StorageFilesResponse {
  success: boolean; error?: string; files: StorageFile[]; total: number; offset: number
  limit: number; next_offset: number; has_more: boolean; can_manage: boolean
}
export interface StorageReview {
  success: boolean; error?: string; preview_id: string; expires_at: string; action: StorageAction
  items: { object_key: string; filename: string; size_bytes: number; eligible: boolean; reason?: string }[]
  eligible_count: number; estimated_bytes: number
}
export interface StorageResult {
  success: boolean; error?: string; operation_id: string; status: 'completed' | 'partial' | 'failed' | 'processing'
  action: StorageAction; items: { object_key: string; filename: string; status: 'completed' | 'blocked' | 'failed' | 'pending'; reason?: string }[]
  freed_bytes: number; retained_bytes: number
}
export interface StorageOperation {
  id: string; action: StorageAction; status: 'completed' | 'partial' | 'failed' | 'processing'; can_retry?: boolean
  created_at: string; completed_at?: string; files_count: number; freed_bytes: number; retained_bytes: number
}
export interface StorageActivity { success: boolean; error?: string; operations: StorageOperation[]; total: number; has_more: boolean }
export interface StorageFilters { query: string; type: string; origin: string; status: string; minSize: string; age: string; sort: string }
export const EMPTY_FILTERS: StorageFilters = { query: '', type: '', origin: '', status: 'all', minSize: '', age: '', sort: 'size' }
export const STORAGE_PAGE_SIZE = 40
export const STORAGE_SELECTION_LIMIT = 100
export const PREVIEW_MAX_BYTES = 100 * 1024 * 1024
export const PREVIEW_TIMEOUT_MS = 45_000
export const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024
export const ORIGIN_LABELS: Record<string, string> = { chats: 'Chats', campaigns: 'Campañas', quick_replies: 'Respuestas rápidas', dynamics: 'Dinámicas', surveys: 'Encuestas', documents: 'Documentos', contacts: 'Contactos' }
export function formatStorageBytes(value = 0): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']; let size = value; let unit = 0
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1 }
  return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`
}
export function storageDate(value?: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Sin fecha'
  return new Date(value).toLocaleDateString('es-PE', { day: '2-digit', month: 'short', year: 'numeric' })
}
export function storageFilesQuery(filters: StorageFilters, tab: StorageTab, offset: number): string {
  const params = new URLSearchParams({ limit: String(STORAGE_PAGE_SIZE), offset: String(Math.max(0, offset)), sort: filters.sort, order: filters.sort === 'name' ? 'asc' : 'desc', status: tab === 'trash' ? 'trash' : filters.status })
  if (filters.query.trim()) params.set('q', filters.query.trim())
  if (filters.type) params.set('type', filters.type)
  if (filters.origin) params.set('origin', filters.origin)
  if (filters.minSize) params.set('min_size', filters.minSize)
  if (filters.age) params.set('older_than_days', filters.age)
  return params.toString()
}
export function storageContentPath(file: Pick<StorageFile, 'object_key'>): string {
  return `/api/storage/content?${new URLSearchParams({ object_key: file.object_key })}`
}
export function safeStorageOriginHref(href?: string): string | undefined {
  if (!href || !/^\/dashboard\/(chats|broadcasts|quick-replies|dynamics|surveys|documents|contacts|settings|tasks|whiteboards)(?:[/?#]|$)/.test(href) || /[\\\u0000-\u0020]/.test(href)) return undefined
  return href
}
export function canSelectStorageFile(file: StorageFile, tab: StorageTab, canManage: boolean): boolean {
  if (!canManage) return false
  return tab === 'trash' ? !!file.can_restore || !!file.can_purge : !!file.can_remove
}
export function toggleStorageSelection(selected: Map<string, StorageFile>, file: StorageFile): Map<string, StorageFile> {
  const next = new Map(selected)
  if (next.has(file.object_key)) next.delete(file.object_key)
  else if (next.size < STORAGE_SELECTION_LIMIT) next.set(file.object_key, file)
  return next
}
export function reconcileStorageSelection(selected: Map<string, StorageFile>, result: StorageResult): Map<string, StorageFile> {
  const next = new Map(selected)
  for (const item of result.items || []) if (item.status === 'completed') next.delete(item.object_key)
  return next
}
export function resultStorageMessage(result: StorageResult): string {
  if (result.status === 'processing') return 'La operación sigue pendiente. Consulta Actividad para comprobar su resultado o reintentarla.'
  const completed = result.items.filter(item => item.status === 'completed').length
  const failed = result.items.length - completed
  const successText = result.action === 'trash'
    ? `${completed} archivo${completed === 1 ? '' : 's'} en la papelera. Todavía no se ha liberado espacio.`
    : result.action === 'restore' ? `${completed} archivo${completed === 1 ? '' : 's'} restaurado${completed === 1 ? '' : 's'}.`
      : `${completed} archivo${completed === 1 ? '' : 's'} eliminado${completed === 1 ? '' : 's'}. Espacio liberado: ${formatStorageBytes(result.freed_bytes)}.`
  return `${successText}${failed ? ` ${failed} no se pudieron procesar. Revisa los detalles.` : ''}`
}
export function storagePreviewExpired(review: Pick<StorageReview, 'expires_at'>, now = Date.now()): boolean {
  const expiry = Date.parse(review.expires_at)
  return !Number.isFinite(expiry) || now >= expiry
}

export function nextStorageTab(current: StorageTab, key: string, canViewActivity: boolean): StorageTab | null {
  const tabs: StorageTab[] = canViewActivity ? ['files', 'trash', 'activity'] : ['files', 'trash']
  const index = Math.max(0, tabs.indexOf(current))
  if (key === 'Home') return tabs[0]
  if (key === 'End') return tabs[tabs.length - 1]
  if (key === 'ArrowRight') return tabs[(index + 1) % tabs.length]
  if (key === 'ArrowLeft') return tabs[(index + tabs.length - 1) % tabs.length]
  return null
}
