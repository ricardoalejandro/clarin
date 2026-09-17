import type { OfflineV5Module, OfflineV5Resource } from './uiState'

export interface OfflineAvailabilityV5 {
  enabled: boolean
  prepare_enabled: boolean
  writes_enabled: boolean
  blob_sync_enabled: boolean
  protocol_version: 5
  max_offline_seconds: number
  max_resources: number
}

export interface OfflineGrantV5 {
  grant_id: string
  browser_profile_id: string
  user_id: string
  account_id: string
  account_name: string
  username?: string
  display_user?: string
  state: string
  modules: OfflineV5Module[]
  capabilities: string[]
  max_resources: number
  quota_bytes: number
  selection_revision: number
  selection_digest: string
  v5_revision: number
}

export interface OfflineEnrollmentV5 {
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

export interface OfflineSelectionV5 {
  items: OfflineV5Resource[]
  selection_revision: number
  selection_digest: string
}

export class OfflineAPIErrorV5 extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'OfflineAPIErrorV5'
  }
}

export function offlineV5FailureAllowsFallback(error: unknown) {
  if (!(error instanceof OfflineAPIErrorV5)) return false
  if (error.code === 'network_unavailable' || error.code === 'untrusted_response') return true
  return error.status === 408 || error.status === 429 || error.status >= 500
}

export function offlineV5ApprovalConflict(error: unknown) {
  return error instanceof OfflineAPIErrorV5
    && error.status === 409
    && (error.code === 'offline_state_conflict' || error.code === 'offline_retry_required')
}

export function offlineV5RequestIsPending(items: readonly OfflineEnrollmentV5[], requestID: string) {
  return items.some(item => item.id === requestID && (item.state === 'requested' || item.state === 'pending'))
}

/** Online administration calls never receive the password used to unlock the local vault. */
export async function offlineRequestV5<T>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      method: options.method || 'GET',
      credentials: 'include',
      cache: 'no-store',
      redirect: 'error',
      signal: options.signal,
      headers: {
        Accept: 'application/json',
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    })
  } catch (error) {
    if (options.signal?.aborted || (error as Error).name === 'AbortError') throw error
    throw new OfflineAPIErrorV5(0, 'network_unavailable', 'No se pudo conectar con Clarin. Vuelve a intentarlo cuando se restablezca el acceso.')
  }
  const contentType = response.headers.get('content-type') || ''
  if (response.headers.get('X-Clarin-Response') !== '1' || !contentType.includes('application/json')) {
    throw new OfflineAPIErrorV5(response.status, 'untrusted_response', 'Clarin o la protección de acceso no devolvieron una respuesta verificable.')
  }
  const data = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) {
    const code = typeof data.code === 'string' ? data.code : typeof data.error === 'string' ? data.error : `http_${response.status}`
    const selectionConflict = response.status === 409 && options.method === 'PUT' && /\/selection$/.test(path)
    let message = typeof data.message === 'string'
      ? data.message
      : 'Clarin rechazó esta operación. Comprueba la autorización y vuelve a intentarlo.'
    if (selectionConflict) {
      message = 'La selección cambió en otra pestaña. Actualízala antes de volver a guardar.'
    } else if (code === 'offline_retry_required') {
      message = 'Otra aprobación terminó al mismo tiempo. Clarin actualizará el estado antes de permitir otro intento.'
    } else if (code === 'offline_state_conflict') {
      message = 'La solicitud o la autorización cambió mientras se procesaba. Clarin actualizará el estado antes de permitir otro intento.'
    } else if (response.status === 409) {
      message = 'La autorización cambió en otra sesión. Actualiza los datos antes de volver a intentarlo.'
    }
    throw new OfflineAPIErrorV5(
      response.status,
      code,
      message,
    )
  }
  return data as T
}

const base = '/api/offline/v5'
const admin = '/api/admin/offline-v5'

export const offlineAvailabilityV5 = (signal?: AbortSignal) => offlineRequestV5<OfflineAvailabilityV5>(`${base}/runtime/availability`, { signal })
export const onlineGrantsV5 = (profileID: string, signal?: AbortSignal) => offlineRequestV5<{ items: OfflineGrantV5[] }>(`${base}/grants?${new URLSearchParams({ browser_profile_id: profileID })}`, { signal })
export const enrollmentStatusV5 = (id: string, signal?: AbortSignal) => offlineRequestV5<{ request: OfflineEnrollmentV5; grants: OfflineGrantV5[] }>(`${base}/enrollment/requests/${encodeURIComponent(id)}`, { signal })
export const grantSelectionV5 = (id: string, signal?: AbortSignal) => offlineRequestV5<OfflineSelectionV5>(`${base}/grants/${encodeURIComponent(id)}/selection`, { signal })
export const replaceSelectionV5 = (id: string, revision: number, resources: readonly OfflineV5Resource[]) => offlineRequestV5<OfflineSelectionV5>(`${base}/grants/${encodeURIComponent(id)}/selection`, {
  method: 'PUT',
  body: {
    selection_revision: revision,
    items: resources.map(({ module, resource_type, resource_id }) => ({ module, resource_type, resource_id })),
  },
})
export const resourceCandidatesV5 = (id: string, module: OfflineV5Module, query: string, after = '', signal?: AbortSignal) => offlineRequestV5<{ items: OfflineV5Resource[]; next_cursor?: string | null }>(`${base}/grants/${encodeURIComponent(id)}/resources?${new URLSearchParams({ module, q: query, limit: '50', ...(after ? { after } : {}) })}`, { signal })

export const adminRequestsV5 = (signal?: AbortSignal) => offlineRequestV5<{ items: OfflineEnrollmentV5[] }>(`${admin}/enrollment-requests`, { signal })
export const adminGrantsV5 = (signal?: AbortSignal) => offlineRequestV5<{ items: OfflineGrantV5[] }>(`${admin}/grants`, { signal })
export const approveRequestV5 = (
  id: string,
  accounts: Array<{ account_id: string; modules: OfflineV5Module[]; max_resources: number; quota_bytes: number }>,
) => offlineRequestV5<{ grants: OfflineGrantV5[] }>(`${admin}/enrollment-requests/${encodeURIComponent(id)}/approve`, { method: 'POST', body: { accounts } })
export const rejectRequestV5 = (id: string) => offlineRequestV5<unknown>(`${admin}/enrollment-requests/${encodeURIComponent(id)}/reject`, { method: 'POST', body: { note: 'Solicitud rechazada por superadmin.' } })
export const upgradeGrantV5 = (id: string, modules: OfflineV5Module[]) => offlineRequestV5<{ grant: OfflineGrantV5 }>(`${admin}/grants/${encodeURIComponent(id)}/upgrade`, { method: 'POST', body: { modules } })
export const revokeGrantV5 = (id: string) => offlineRequestV5<{ revoked_count: number }>(`${admin}/grants/${encodeURIComponent(id)}/revoke`, { method: 'POST', body: {} })
