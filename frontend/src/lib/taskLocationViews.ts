import type { TaskLocationView, TaskLocationViewBreadcrumbItem, TaskViewMode } from '@/types/task'

export const TASK_LOCATION_VIEW_PAGE_SIZE = 50
export const TASK_LOCATION_VIEW_MAX_NAME_LENGTH = 200

export function normalizeTaskBuiltinView(value: unknown): TaskViewMode {
  return value === 'board' || value === 'calendar' || value === 'gantt' || value === 'summary' ? value : 'list'
}

export function taskLocationViewBreadcrumb(view: TaskLocationView) {
  const items = view.scope.breadcrumb?.length
    ? view.scope.breadcrumb
    : [{ type: view.scope.scope_type, id: view.scope.scope_id, name: view.scope.scope_name } satisfies TaskLocationViewBreadcrumbItem]
  return items.map(item => item.name).filter(Boolean).join(' / ')
}

export function taskLocationViewTabCapacity(availableWidth: number) {
  if (!Number.isFinite(availableWidth) || availableWidth < 560) return 0
  if (availableWidth < 760) return 1
  if (availableWidth < 980) return 2
  if (availableWidth < 1_220) return 3
  return 5
}

export function splitTaskLocationViewTabs(
  views: readonly TaskLocationView[],
  activeID: string | null,
  capacity: number,
) {
  const ordered = [...views].sort((left, right) => left.sort_order - right.sort_order
    || left.resource.whiteboard.name.localeCompare(right.resource.whiteboard.name, 'es'))
  const requestedCapacity = Number.isFinite(capacity) ? Math.max(0, Math.trunc(capacity)) : 0
  // A contextual view that is open must remain directly reachable. When a
  // built-in view is active, a very narrow bar can safely move every
  // contextual tab into the portaled overflow menu.
  const safeCapacity = activeID ? Math.max(1, requestedCapacity) : requestedCapacity
  if (safeCapacity === 0) return { visible: [] as TaskLocationView[], overflow: ordered }
  if (ordered.length <= safeCapacity) return { visible: ordered, overflow: [] as TaskLocationView[] }
  const visible = ordered.slice(0, safeCapacity)
  const active = activeID ? ordered.find(view => view.id === activeID) : undefined
  if (active && !visible.some(view => view.id === active.id)) visible[visible.length - 1] = active
  const visibleIDs = new Set(visible.map(view => view.id))
  return { visible, overflow: ordered.filter(view => !visibleIDs.has(view.id)) }
}

export function taskLocationViewOperationID() {
  return crypto.randomUUID()
}

export function taskLocationViewMutationContextKey(
  environmentID: string,
  scope: { type: string; id?: string } | null,
) {
  return `${environmentID.trim()}:${scope?.type || 'none'}:${scope?.id?.trim() || ''}`
}

export function taskLocationViewMutationResponseIsCurrent(
  started: { contextKey: string; generation: number },
  current: { contextKey: string; generation: number },
) {
  return Boolean(started.contextKey)
    && started.contextKey === current.contextKey
    && started.generation === current.generation
}

export function taskLocationViewSelectionError(
  requested: TaskLocationView,
  canonical: TaskLocationView | undefined,
  operationIsCurrent: boolean,
) {
  if (!operationIsCurrent) return null
  if (canonical
    && canonical.capabilities.can_view
    && canonical.access_revision === requested.access_revision
    && canonical.lifecycle === 'active') return null
  return 'La pizarra cambió o dejó de estar disponible. Actualizamos las vistas de esta ubicación; vuelve a intentarlo.'
}

export interface TaskLocationViewOperationAttempt {
  operationID: string
  kind: 'create' | 'rename' | 'duplicate' | 'trash'
  targetID?: string
}

export function createTaskLocationViewOperationAttempt(
  kind: TaskLocationViewOperationAttempt['kind'],
  targetID?: string,
): TaskLocationViewOperationAttempt {
  return { kind, targetID, operationID: taskLocationViewOperationID() }
}

export function taskLocationViewRequiresProtectedRemount(
  current: TaskLocationView,
  next: TaskLocationView,
) {
  return current.id !== next.id
    || current.resource.whiteboard.id !== next.resource.whiteboard.id
    || current.lifecycle !== next.lifecycle
    || current.access_revision !== next.access_revision
}

export function taskLocationViewNameDraft(value: string) {
  return Array.from(value).slice(0, TASK_LOCATION_VIEW_MAX_NAME_LENGTH).join('')
}

export function taskLocationViewName(value: string) {
  return taskLocationViewNameDraft(value.trim())
}

export function taskLocationViewCopyName(value: string) {
  const suffix = ' (copia)'
  const base = Array.from(value.trim()).slice(0, TASK_LOCATION_VIEW_MAX_NAME_LENGTH - Array.from(suffix).length).join('')
  return `${base}${suffix}`
}

export function taskLocationViewError(status?: number, fallback?: string) {
  if (status === 403) return 'No tienes permiso para administrar vistas en esta ubicación.'
  if (status === 404) return 'La vista o su ubicación ya no están disponibles.'
  if (status === 409) return fallback || 'La vista cambió en otra sesión. Actualizamos su estado para que puedas reintentar.'
  if (status === 503) return fallback || 'Las vistas de Pizarra están temporalmente desactivadas.'
  return fallback || 'No se pudo completar la operación con la vista.'
}

export function taskContainerWhiteboardCount(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0
}

export function taskPurgedWhiteboardCount(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 0
  const payload = value as { purged?: { whiteboards?: unknown }; whiteboards?: unknown }
  return taskContainerWhiteboardCount(payload.purged?.whiteboards ?? payload.whiteboards)
}

export function taskContainerPurgeDescription(value: unknown) {
  const count = taskContainerWhiteboardCount(value)
  return `Esta acción es irreversible. Se eliminará el elemento de Papelera y, cuando corresponda, todo su árbol.${count > 0 ? ` También se eliminarán ${count} pizarra${count === 1 ? '' : 's'} contextual${count === 1 ? '' : 'es'} vinculada${count === 1 ? '' : 's'}.` : ''} La operación se bloqueará si algún descendiente aún no cumple la retención.`
}
