import type { OfflineAction, OfflineModule } from '@/offline-v3/types'

export interface OnlineGrantV4 {
  grant_id: string
  browser_profile_id: string
  user_id: string
  account_id: string
  account_name: string
  username?: string
  display_user?: string
  state: string
  actions: OfflineAction[]
  max_resources: number
  quota_bytes: number
  selection_revision: number
  selection_digest: string
}
export interface EnrollmentV4 {
  id: string
  browser_profile_id: string
  user_id: string
  username?: string
  browser_name?: string
  display_name?: string
  state: string
  requested_at?: string
  accounts?: Array<{ id: string; name: string }>
}
export interface ResourceV4 {
  module: OfflineModule
  resource_type: string
  resource_id: string
  label?: string
  subtitle?: string
}
export interface SelectionV4 { items: ResourceV4[]; selection_revision: number; selection_digest: string }
export type ControlScopeV4 = 'grant' | 'browser_profile' | 'user' | 'account'

export class OfflineAPIErrorV4 extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = 'OfflineAPIErrorV4' }
}

/** These requests use the current online session only. Local passwords never enter this API. */
export async function offlineRequestV4<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, { method: options.method || 'GET', credentials: 'include', cache: 'no-store', redirect: 'error', signal: options.signal, headers: { Accept: 'application/json', ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) })
  } catch (error) {
    if (options.signal?.aborted || (error as Error).name === 'AbortError') throw error
    throw new OfflineAPIErrorV4(0, 'network_unavailable', 'No se pudo conectar con Clarin. Vuelve a intentarlo cuando se restablezca el acceso.')
  }
  const trusted = response.headers.get('X-Clarin-Response') === '1' && response.headers.get('content-type')?.includes('application/json')
  if (!trusted) throw new OfflineAPIErrorV4(response.status, 'untrusted_response', 'Clarin o la protección de acceso no devolvieron una respuesta verificable.')
  const data = await response.json()
  if (!response.ok) {
    const selectionConflict = response.status === 409 && options.method === 'PUT' && /\/selection$/.test(path)
    const message = selectionConflict ? 'La selección cambió en otra pestaña. Actualiza la selección antes de volver a guardar.' : response.status === 409 ? 'El estado de esta autorización cambió. Actualiza los datos antes de volver a intentarlo.' : data.message || 'Clarin rechazó esta operación. Comprueba tu autorización y vuelve a intentarlo.'
    throw new OfflineAPIErrorV4(response.status, data.code || data.error || `http_${response.status}`, message)
  }
  return data as T
}

const base = '/api/offline/v4'
const admin = '/api/admin/offline-v4'
export const offlineAvailabilityV4 = (signal?: AbortSignal) => offlineRequestV4<{ enabled: boolean; task_writes_enabled: boolean; protocol_version: number }>(`${base}/runtime/availability`, { signal })
export const onlineGrantsV4 = (profileId: string, signal?: AbortSignal) => offlineRequestV4<{ items: OnlineGrantV4[] }>(`${base}/grants?${new URLSearchParams({ browser_profile_id: profileId })}`, { signal })
export const enrollmentStatusV4 = (id: string, signal?: AbortSignal) => offlineRequestV4<{ request: EnrollmentV4; grants: OnlineGrantV4[] }>(`${base}/enrollment/requests/${encodeURIComponent(id)}`, { signal })
export const grantSelectionV4 = (id: string, signal?: AbortSignal) => offlineRequestV4<SelectionV4>(`${base}/grants/${encodeURIComponent(id)}/selection`, { signal })
export const replaceSelectionV4 = (id: string, revision: number, resources: ResourceV4[]) => offlineRequestV4<SelectionV4>(`${base}/grants/${encodeURIComponent(id)}/selection`, { method: 'PUT', body: { selection_revision: revision, items: resources.map(({ module, resource_type, resource_id }) => ({ module, resource_type, resource_id })) } })
export const resourceCandidatesV4 = (id: string, module: OfflineModule, query: string, after = '', signal?: AbortSignal) => offlineRequestV4<{ items: ResourceV4[]; next_cursor?: string | null }>(`${base}/grants/${encodeURIComponent(id)}/resources?${new URLSearchParams({ module, q: query, limit: '50', ...(after ? { after } : {}) })}`, { signal })
export const adminRequestsV4 = (signal?: AbortSignal) => offlineRequestV4<{ items: EnrollmentV4[] }>(`${admin}/enrollment-requests`, { signal })
export const adminGrantsV4 = (signal?: AbortSignal) => offlineRequestV4<{ items: OnlineGrantV4[] }>(`${admin}/grants`, { signal })
export const approveRequestV4 = (id: string, accounts: Array<{ account_id: string; actions: OfflineAction[]; max_resources: number; quota_bytes: number }>) => offlineRequestV4<{ grants: OnlineGrantV4[] }>(`${admin}/enrollment-requests/${encodeURIComponent(id)}/approve`, { method: 'POST', body: { accounts } })
export const rejectRequestV4 = (id: string) => offlineRequestV4<unknown>(`${admin}/enrollment-requests/${encodeURIComponent(id)}/reject`, { method: 'POST', body: { note: 'Solicitud rechazada por superadmin.' } })
export const revokeScopeV4 = (scope: ControlScopeV4, scopeId: string) => offlineRequestV4<{ revoked_count: number }>(`${admin}/controls`, { method: 'POST', body: { scope, scope_id: scopeId, action: 'revoke' } })
