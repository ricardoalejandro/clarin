import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from '@/lib/api'
import { TASK_LOCATION_VIEW_PAGE_SIZE, taskLocationViewOperationID } from '@/lib/taskLocationViews'
import type {
  TaskLocationView, TaskLocationViewScopeType, TaskLocationViewVisibilityCandidate,
  TaskLocationViewVisibilityMode, TaskLocationViewVisibilityPolicy,
} from '@/types/task'

export const TASK_LOCATION_VIEWS_API_ROOT = '/api/tasks/location-views'

export interface TaskLocationViewListResponse {
  success?: boolean
  location_views: TaskLocationView[]
  next_cursor?: string | null
  feature_enabled: boolean
}

export interface TaskLocationViewListAPIResult {
  success: boolean
  data?: TaskLocationViewListResponse
  error?: string
  status?: number
}

export function listTaskLocationViews(input: {
  scopeType: TaskLocationViewScopeType
  scopeID: string
  lifecycle?: 'archive'
  cursor?: string | null
  signal?: AbortSignal
}) {
  const params = new URLSearchParams({
    scope_type: input.scopeType,
    scope_id: input.scopeID,
    limit: String(TASK_LOCATION_VIEW_PAGE_SIZE),
  })
  if (input.lifecycle) params.set('lifecycle', input.lifecycle)
  if (input.cursor) params.set('cursor', input.cursor)
  return apiGet<TaskLocationViewListResponse>(`${TASK_LOCATION_VIEWS_API_ROOT}?${params.toString()}`, { signal: input.signal })
}

export async function collectTaskLocationViewPages(
  loadPage: (cursor: string | null) => Promise<TaskLocationViewListAPIResult>,
  initialCursor: string | null = null,
): Promise<TaskLocationViewListAPIResult> {
  const collected: TaskLocationView[] = []
  const viewIDs = new Set<string>()
  const cursors = new Set<string>()
  let cursor = initialCursor?.trim() || null
  if (cursor) cursors.add(cursor)

  while (true) {
    const response = await loadPage(cursor)
    if (!response.success || !response.data) return response
    if (!response.data.feature_enabled) {
      return {
        ...response,
        data: { ...response.data, location_views: [], next_cursor: null },
      }
    }
    for (const view of response.data.location_views || []) {
      if (viewIDs.has(view.id)) continue
      viewIDs.add(view.id)
      collected.push(view)
    }
    const nextCursor = response.data.next_cursor?.trim() || null
    if (!nextCursor) {
      return {
        ...response,
        data: { ...response.data, location_views: collected, next_cursor: null },
      }
    }
    if (cursors.has(nextCursor)) {
      return {
        success: false,
        status: 409,
        error: 'La paginación de vistas devolvió un cursor repetido. Vuelve a intentarlo.',
      }
    }
    cursors.add(nextCursor)
    cursor = nextCursor
  }
}

export function collectTaskLocationViews(input: {
  scopeType: TaskLocationViewScopeType
  scopeID: string
  lifecycle?: 'archive'
  cursor?: string | null
  signal?: AbortSignal
}) {
  return collectTaskLocationViewPages(
    cursor => listTaskLocationViews({ ...input, cursor }),
    input.cursor || null,
  )
}

export function loadTaskLocationView(id: string, signal?: AbortSignal) {
  return apiGet<{ success?: boolean; location_view: TaskLocationView; feature_enabled?: boolean }>(
    `${TASK_LOCATION_VIEWS_API_ROOT}/${encodeURIComponent(id)}`,
    { signal },
  )
}

export function createTaskLocationView(input: {
  scopeType: TaskLocationViewScopeType
  scopeID: string
  name: string
  visibilityMode?: TaskLocationViewVisibilityMode
  visibleUserIDs?: string[]
  expectedParentAccessRevision?: number
  operationID?: string
}) {
  return apiPost<{ success?: boolean; location_view: TaskLocationView; idempotent?: boolean }>(TASK_LOCATION_VIEWS_API_ROOT, {
    type: 'whiteboard',
    scope_type: input.scopeType,
    scope_id: input.scopeID,
    name: input.name,
    visibility_mode: input.visibilityMode || 'inherit',
    visible_user_ids: input.visibleUserIDs || [],
    expected_parent_access_revision: input.expectedParentAccessRevision || 0,
    operation_id: input.operationID || taskLocationViewOperationID(),
  })
}

export function renameTaskLocationView(view: TaskLocationView, name: string, operationID = taskLocationViewOperationID()) {
  return apiPatch<{ success?: boolean; location_view: TaskLocationView; idempotent?: boolean }>(
    `${TASK_LOCATION_VIEWS_API_ROOT}/${encodeURIComponent(view.id)}`,
    { name, expected_version: view.version, operation_id: operationID },
  )
}

export function duplicateTaskLocationView(view: TaskLocationView, name?: string, operationID = taskLocationViewOperationID()) {
  return apiPost<{ success?: boolean; location_view: TaskLocationView; idempotent?: boolean }>(
    `${TASK_LOCATION_VIEWS_API_ROOT}/${encodeURIComponent(view.id)}/duplicate`,
    { name, expected_version: view.version, expected_access_revision: view.access_revision, operation_id: operationID },
  )
}

export function loadTaskLocationViewAccess(viewID: string, signal?: AbortSignal) {
  return apiGet<{ success?: boolean; access: TaskLocationViewVisibilityPolicy }>(
    `${TASK_LOCATION_VIEWS_API_ROOT}/${encodeURIComponent(viewID)}/access`,
    { signal },
  )
}

export function replaceTaskLocationViewAccess(input: {
  viewID: string
  visibilityMode: TaskLocationViewVisibilityMode
  visibleUserIDs: string[]
  expectedAccessRevision: number
  operationID?: string
}) {
  return apiPut<{ success?: boolean; access: TaskLocationViewVisibilityPolicy; operation_id: string; idempotent?: boolean }>(
    `${TASK_LOCATION_VIEWS_API_ROOT}/${encodeURIComponent(input.viewID)}/access`,
    {
      visibility_mode: input.visibilityMode,
      visible_user_ids: input.visibleUserIDs,
      expected_access_revision: input.expectedAccessRevision,
      operation_id: input.operationID || taskLocationViewOperationID(),
    },
  )
}

export function searchTaskLocationViewAccessCandidates(input: {
  scopeType: TaskLocationViewScopeType
  scopeID: string
  query: string
  signal?: AbortSignal
}) {
  const params = new URLSearchParams({
    scope_type: input.scopeType,
    scope_id: input.scopeID,
    q: input.query.trim(),
    limit: '50',
  })
  return apiGet<{ success?: boolean; users: TaskLocationViewVisibilityCandidate[] }>(
    `/api/tasks/location-view-access-candidates?${params.toString()}`,
    { signal: input.signal },
  )
}

export function trashTaskLocationView(view: TaskLocationView, operationID = taskLocationViewOperationID()) {
  return apiDelete<{ success?: boolean; location_view: TaskLocationView; idempotent?: boolean }>(
    `${TASK_LOCATION_VIEWS_API_ROOT}/${encodeURIComponent(view.id)}`,
    { expected_version: view.version, operation_id: operationID },
  )
}

export function restoreTaskLocationView(view: TaskLocationView, operationID = taskLocationViewOperationID()) {
  return apiPost<{ success?: boolean; location_view: TaskLocationView; idempotent?: boolean }>(
    `${TASK_LOCATION_VIEWS_API_ROOT}/${encodeURIComponent(view.id)}/restore`,
    { expected_version: view.version, operation_id: operationID },
  )
}
