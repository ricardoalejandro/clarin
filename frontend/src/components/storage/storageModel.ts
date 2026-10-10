export type StorageAction = 'trash' | 'restore' | 'purge'
export type StorageTab = 'files' | 'trash' | 'activity'
export type MediaType = 'image' | 'video' | 'audio' | 'document'
export interface StorageOrigin { type: string; label: string; href?: string }
export interface StorageFile {
  object_key: string; filename: string; media_type: MediaType; size_bytes: number
  last_modified?: string; origins: StorageOrigin[]; references_count: number
  can_remove: boolean; can_restore?: boolean; can_purge?: boolean; blocked_reason?: string
  preview_url?: string; status: 'active' | 'trash'; trash_at?: string; purge_after?: string
  can_remove_uses?: boolean; ownership_verified?: boolean; is_own_upload?: boolean
  has_protected_uses?: boolean; recovery_id?: string; removed_uses_count?: number; object_retained?: boolean; retained_elsewhere?: boolean
}
export interface StorageUse {
  use_id: string; type: string; label: string; context_label?: string; href?: string
  created_at?: string; can_remove: boolean; blocked_reason?: string
}
export interface StorageUsesResponse {
  success: boolean; error?: string; uses: StorageUse[]; total?: number; limit: number
  next_cursor?: string; has_more: boolean; can_manage?: boolean; retained_elsewhere?: boolean
}
export type StorageTarget = { object_key: string; mode: 'file'; use_ids?: never } | { object_key: string; mode: 'uses'; use_ids: string[] }
export interface StorageImpact {
  selected_uses_count?: number; removed_uses?: number; retained_uses_visible_count?: number
  retained_elsewhere?: boolean; will_trash?: boolean; trash_bytes?: number; estimated_freed_bytes?: number
}
export interface StorageRecommendation {
  id: 'large_files' | 'older_files' | 'unused_uploads' | 'trash_ready'
  count: number; bytes: number
  filters: { type?: string; origin?: string; status?: string; min_size?: number | string; older_than_days?: number | string }
}
export interface StorageUsage {
  account_id?: string; generated_at?: string; last_verified_at?: string | null
  catalog_status?: 'indexing' | 'ready' | 'degraded'; inventory_complete?: boolean
  recommendations?: StorageRecommendation[]
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
export interface StorageReview extends StorageImpact {
  success: boolean; error?: string; preview_id: string; expires_at: string; action: StorageAction
  items: ({ object_key: string; recovery_id?: string; filename: string; size_bytes: number; eligible: boolean; reason?: string; impact?: StorageImpact } & StorageImpact)[]
  eligible_count: number; estimated_bytes: number
}
export interface StorageResult {
  success: boolean; error?: string; operation_id: string; status: 'completed' | 'partial' | 'failed' | 'processing'
  action: StorageAction; items: { object_key: string; recovery_id?: string; filename: string; status: 'completed' | 'blocked' | 'failed' | 'pending'; reason?: string; removed_uses?: number }[]
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
export const ORIGIN_LABELS: Record<string, string> = { chats: 'Chats', campaigns: 'Campañas', quick_replies: 'Respuestas rápidas', dynamics: 'Dinámicas', surveys: 'Encuestas', documents: 'Documentos', contacts: 'Contactos', tasks: 'Tareas', whiteboards: 'Pizarras', own_uploads: 'Mis cargas', stickers: 'Stickers' }
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
export function storageTrashStatus(file: Pick<StorageFile, 'blocked_reason' | 'can_purge' | 'purge_after'>): string {
  const reason = file.blocked_reason || (file.can_purge ? 'Disponible para borrado definitivo' : 'El borrado definitivo todavía no está disponible.')
  if (file.can_purge || !file.purge_after || !Number.isFinite(Date.parse(file.purge_after))) return reason
  return `${reason} Retención mínima hasta ${storageDate(file.purge_after)}.`
}
export function storageAdvancedFilterCount(filters: StorageFilters): number {
  return Number(!!filters.origin) + Number(!!filters.minSize) + Number(!!filters.age)
    + Number(filters.status !== EMPTY_FILTERS.status) + Number(filters.sort !== EMPTY_FILTERS.sort)
}
export function storageFilesQuery(filters: StorageFilters, tab: StorageTab, offset: number): string {
  const params = new URLSearchParams({ limit: String(STORAGE_PAGE_SIZE), offset: String(Math.max(0, offset)), sort: filters.sort, order: filters.sort === 'name' ? 'asc' : 'desc', status: tab === 'trash' ? filters.status === 'trash_ready' ? 'trash_ready' : 'trash' : filters.status })
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
  return tab === 'trash' ? !!file.recovery_id && (!!file.can_restore || !!file.can_purge) : !!file.can_remove
}
export function storageFileIdentity(file: Pick<StorageFile, 'object_key' | 'recovery_id'>): string {
  return file.recovery_id ? `recovery:${file.recovery_id}` : file.object_key
}
export function toggleStorageSelection(selected: Map<string, StorageFile>, file: StorageFile): Map<string, StorageFile> {
  const next = new Map(selected)
  const key = storageFileIdentity(file)
  if (next.has(key)) next.delete(key)
  else if (next.size < STORAGE_SELECTION_LIMIT) next.set(key, file)
  return next
}
export function reconcileStorageSelection(selected: Map<string, StorageFile>, result: StorageResult): Map<string, StorageFile> {
  const next = new Map(selected)
  for (const item of result.items || []) if (item.status === 'completed') next.delete(storageFileIdentity(item))
  return next
}
export function resultStorageMessage(result: StorageResult): string {
  if (result.status === 'processing') return 'La operación sigue pendiente. Consulta Actividad para comprobar su resultado o reintentarla.'
  const completed = result.items.filter(item => item.status === 'completed').length
  const failed = result.items.length - completed
  const successText = result.action === 'trash'
    ? `${completed} archivo${completed === 1 ? '' : 's'} procesado${completed === 1 ? '' : 's'}. Puedes recuperar los usos retirados desde la papelera. Todavía no se ha liberado espacio.`
    : result.action === 'restore' ? `${completed} archivo${completed === 1 ? '' : 's'} restaurado${completed === 1 ? '' : 's'}.`
      : `${completed} archivo${completed === 1 ? '' : 's'} eliminado${completed === 1 ? '' : 's'}. Espacio liberado: ${formatStorageBytes(result.freed_bytes)}.`
  return `${successText}${failed ? ` ${failed} no se pudieron procesar. Revisa los detalles.` : ''}`
}

export function storagePreviewRequest(action: StorageAction, files: Iterable<StorageFile>, targets?: StorageTarget[]) {
  const selected = Array.from(files)
  if (action === 'trash') return { action, targets: targets || selected.map(file => ({ object_key: file.object_key, mode: 'file' as const })) }
  return { action, recovery_ids: selected.flatMap(file => file.recovery_id ? [file.recovery_id] : []) }
}

export function storageRecommendationFilters(recommendation: StorageRecommendation): { tab: StorageTab; filters: StorageFilters } {
  const { filters } = recommendation
  return {
    tab: recommendation.id === 'trash_ready' ? 'trash' : 'files',
    filters: { ...EMPTY_FILTERS, type: filters.type || '', origin: filters.origin || '', status: filters.status || 'all', minSize: filters.min_size == null ? '' : String(filters.min_size), age: filters.older_than_days == null ? '' : String(filters.older_than_days) },
  }
}

export function storageUsesPath(objectKey: string, cursor = ''): string {
  const query = new URLSearchParams({ object_key: objectKey, limit: String(STORAGE_PAGE_SIZE) })
  if (cursor) query.set('cursor', cursor)
  return `/api/storage/uses?${query}`
}

export function reconcileStorageUses(selected: Map<string, StorageUse>, uses: StorageUse[], canManage: boolean): Map<string, StorageUse> {
  if (!canManage) return new Map()
  const next = new Map(selected)
  for (const use of uses) if (next.has(use.use_id)) {
    if (use.can_remove) next.set(use.use_id, use)
    else next.delete(use.use_id)
  }
  return next
}

/** A broadcast is an invalidation hint. It never grants access or supplies file data. */
export function storageRealtimeChange(message: unknown, accountID: string | undefined, lastRevision = 0): { action: 'refresh' | 'reset'; revision: number } | null {
  if (!accountID || !message || typeof message !== 'object') return null
  const event = message as { event?: unknown; account_id?: unknown; data?: { account_id?: unknown; revision?: unknown; reason?: unknown; action?: unknown } }
  const eventAccount = event.account_id || event.data?.account_id
  if (eventAccount && eventAccount !== accountID) return null
  // Legacy Work events have no account payload but arrive on the authenticated
  // account socket. They can only redact and revalidate, never provide data.
  if ((event.event === 'task_update' || event.event === 'whiteboard_update') &&
      ['access_changed', 'access_revoked', 'whiteboard_work_hub_revoked', 'whiteboard_hub_changed'].includes(String(event.data?.action))) {
    return { action: 'reset', revision: lastRevision }
  }
  if (event.event !== 'storage_changed' || eventAccount !== accountID) return null
  const revision = typeof event.data?.revision === 'number' && Number.isSafeInteger(event.data.revision) ? event.data.revision : 0
  if (event.data?.reason === 'access_changed') return { action: 'reset', revision: Math.max(revision, lastRevision) }
  // Revisions are server milliseconds: two committed changes can share one.
  // Equal timestamps still invalidate; only strictly older hints are redundant.
  if (revision > 0 && revision < lastRevision) return null
  return { action: 'refresh', revision: Math.max(revision, lastRevision) }
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
