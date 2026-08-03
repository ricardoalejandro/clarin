import type { TaskAccessGrant, TaskAccessLevel } from '@/types/task'

export const TASK_ACCESS_LEVELS: Array<{
  value: TaskAccessLevel
  label: string
  description: string
}> = [
  { value: 'none', label: 'Sin acceso', description: 'No puede ver este recurso.' },
  { value: 'view', label: 'Ver', description: 'Puede leer tareas, comentarios y archivos.' },
  { value: 'comment', label: 'Comentar', description: 'Puede comentar, mencionar y adjuntar en comentarios.' },
  { value: 'edit', label: 'Editar', description: 'Puede crear y modificar tareas y adjuntos.' },
  { value: 'full', label: 'Administrar', description: 'Puede administrar estructura, privacidad y archivo.' },
]

const accessRank: Record<TaskAccessLevel, number> = {
  none: 0,
  view: 1,
  comment: 2,
  edit: 3,
  full: 4,
}

export function taskAccessLabel(level?: TaskAccessLevel) {
  return TASK_ACCESS_LEVELS.find(item => item.value === level)?.label || 'Sin acceso'
}

export function taskAccessAtLeast(level: TaskAccessLevel | undefined, required: TaskAccessLevel) {
  return accessRank[level || 'none'] >= accessRank[required]
}

export function normalizeTaskAccessGrants(grants: TaskAccessGrant[]) {
  const canonical = new Map<string, TaskAccessGrant>()
  for (const grant of grants) {
    if (!grant.user_id) continue
    canonical.set(grant.user_id, {
      ...grant,
      can_manage_access: grant.access_level === 'full' && Boolean(grant.can_manage_access),
    })
  }
  return Array.from(canonical.values()).sort((left, right) =>
    `${left.display_name || left.username || ''}:${left.user_id}`.localeCompare(
      `${right.display_name || right.username || ''}:${right.user_id}`,
      'es',
    ),
  )
}

export function validatePrivateAccessManagers(
  isPrivate: boolean,
  grants: TaskAccessGrant[],
) {
  if (!isPrivate) return ''
  if (grants.some(grant => grant.access_level === 'full' && grant.can_manage_access)) return ''
  return 'Un recurso privado debe conservar al menos una persona con nivel Administrar y gestión de acceso.'
}

export function environmentListQuery(search: string, cursor = '', includeArchived = false) {
  const params = new URLSearchParams({ limit: '50' })
  if (search.trim()) params.set('search', search.trim())
  if (cursor) params.set('cursor', cursor)
  if (includeArchived) params.set('include_archived', 'true')
  return params.toString()
}

export function environmentTaskListQuery(search: string, cursor = '') {
  const params = new URLSearchParams({ scope: 'all', limit: '50' })
  if (search.trim()) params.set('search', search.trim())
  if (cursor) params.set('cursor', cursor)
  return params.toString()
}

export function environmentFolderListQuery(folderID: string, search = '', cursor = '') {
  const params = new URLSearchParams({ folder_id: folderID, limit: '50' })
  if (search.trim()) params.set('search', search.trim())
  if (cursor) params.set('cursor', cursor)
  return params.toString()
}

export function environmentFolderQuery(search: string, cursor = '', limit = 50) {
  const params = new URLSearchParams({ limit: String(limit) })
  if (search.trim()) params.set('search', search.trim())
  if (cursor) params.set('cursor', cursor)
  return params.toString()
}
