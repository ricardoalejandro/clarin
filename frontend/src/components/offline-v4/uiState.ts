import type { OfflineAction } from '@/offline-v3/types'
import type { ControlScopeV4, OnlineGrantV4, ResourceV4 } from './online'

export const offlineModulesV4 = [
  { id: 'tasks', label: 'Tareas', action: 'tasks.read', detail: 'Listas; creación y completado según permiso' },
  { id: 'contacts', label: 'Contactos', action: 'contacts.read', detail: 'Solo lectura' },
  { id: 'programs', label: 'Programas', action: 'programs.read', detail: 'Solo lectura' },
  { id: 'whiteboards', label: 'Pizarras', action: 'whiteboards.read', detail: 'Solo lectura' },
] as const
export const permissionLabelsV4: Record<OfflineAction, string> = {
  'tasks.read': 'Leer tareas', 'tasks.create': 'Crear tareas', 'tasks.complete': 'Completar tareas',
  'contacts.read': 'Leer contactos', 'programs.read': 'Leer programas', 'whiteboards.read': 'Leer pizarras',
}
export const resourceKeyV4 = (resource: ResourceV4) => `${resource.module}:${resource.resource_type}:${resource.resource_id}`
export function resourceLabelV4(resource: ResourceV4) {
  return resource.label?.trim() || `${offlineModulesV4.find(item => item.id === resource.module)?.label || 'Recurso'} · ${resource.resource_id}`
}
/** Known labels may be reused only within the already account-scoped selection. */
export function reconcileSelectionLabelsV4(items: ResourceV4[], known: ResourceV4[]) {
  const labels = new Map(known.filter(item => item.label?.trim()).map(item => [resourceKeyV4(item), item.label]))
  return items.map(item => item.label?.trim() || !labels.has(resourceKeyV4(item)) ? item : { ...item, label: labels.get(resourceKeyV4(item)) })
}
export function toggleResourceV4(current: ResourceV4[], resource: ResourceV4, maximum: number) {
  const key = resourceKeyV4(resource)
  if (current.some(item => resourceKeyV4(item) === key)) return current.filter(item => resourceKeyV4(item) !== key)
  if (current.length >= Math.min(20, Math.max(0, maximum))) return current
  return [...current, resource]
}
export function validateOfflinePasswordV4(password: string, confirmation: string) {
  if ([...password].length < 12) return 'Tu contraseña de Clarin debe tener al menos 12 caracteres para preparar el acceso offline.'
  if (new TextEncoder().encode(password).byteLength > 1024) return 'La contraseña supera el límite de 1024 bytes de texto.'
  if (password !== confirmation) return 'Las contraseñas no coinciden.'
  return ''
}
export function togglePermissionV4(actions: OfflineAction[], action: OfflineAction) {
  const next = new Set(actions)
  if (next.has(action)) {
    next.delete(action)
    if (action === 'tasks.read') { next.delete('tasks.create'); next.delete('tasks.complete') }
  } else {
    next.add(action)
    if (action === 'tasks.create' || action === 'tasks.complete') next.add('tasks.read')
  }
  return Object.keys(permissionLabelsV4).filter(item => next.has(item as OfflineAction)) as OfflineAction[]
}
export function validateApprovalV4(drafts: Array<{ account_id: string; actions: OfflineAction[] }>, authorizedIds: string[]) {
  if (!drafts.length) return 'Selecciona al menos una cuenta y un permiso.'
  if (drafts.length > 5) return 'Puedes autorizar como máximo 5 cuentas por solicitud.'
  if (new Set(drafts.map(item => item.account_id)).size !== drafts.length) return 'No repitas una cuenta.'
  if (drafts.some(item => !authorizedIds.includes(item.account_id) || !item.actions.length)) return 'Cada cuenta debe pertenecer al usuario y tener un permiso.'
  if (drafts.some(item => item.actions.some(action => !permissionLabelsV4[action]))) return 'Hay un permiso desconocido.'
  if (drafts.some(item => item.actions.some(action => action === 'tasks.create' || action === 'tasks.complete') && !item.actions.includes('tasks.read'))) return 'Crear o completar requiere leer tareas.'
  return ''
}
export function controlTargetV4(grant: OnlineGrantV4, scope: ControlScopeV4) {
  const targets = { grant: grant.grant_id, browser_profile: grant.browser_profile_id, user: grant.user_id, account: grant.account_id }
  if (!targets[scope]) throw new Error('No existe una identidad válida para ese alcance.')
  return targets[scope]
}
export function stateLabelV4(state: string) {
  return ({ requested: 'Pendiente de aprobación', pending: 'Pendiente de aprobación', approved: 'Autorizado', active: 'Autorizado', available: 'Copia preparada', preparing: 'Preparando copia', expired: 'Autorización vencida', revoked: 'Revocado', rejected: 'Rechazado' } as Record<string, string>)[state] || 'No disponible'
}
