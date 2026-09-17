export const OFFLINE_V5_MODULE_IDS = ['tasks', 'contacts', 'programs', 'whiteboards'] as const

export type OfflineV5Module = (typeof OFFLINE_V5_MODULE_IDS)[number]

export interface OfflineV5Resource {
  module: OfflineV5Module
  resource_type: string
  resource_id: string
  label?: string
  subtitle?: string
}

export const offlineModulesV5: ReadonlyArray<{
  id: OfflineV5Module
  label: string
  detail: string
}> = [
  { id: 'tasks', label: 'Tareas', detail: 'Consultar y modificar datos de las listas elegidas; los archivos requieren conexión' },
  { id: 'contacts', label: 'Contactos', detail: 'Consultar y editar los datos de los contactos elegidos; las fotos requieren conexión' },
  { id: 'programs', label: 'Programas', detail: 'Trabajar con los datos propios de los programas elegidos; los archivos requieren conexión' },
  { id: 'whiteboards', label: 'Pizarras', detail: 'Editar los elementos preparados con el editor habitual; los archivos requieren conexión' },
]

const moduleSet = new Set<string>(OFFLINE_V5_MODULE_IDS)

export function isOfflineV5Module(value: string): value is OfflineV5Module {
  return moduleSet.has(value)
}

export function normalizeOfflineV5Modules(values: readonly string[]): OfflineV5Module[] {
  const requested = new Set(values.filter(isOfflineV5Module))
  return OFFLINE_V5_MODULE_IDS.filter(module => requested.has(module))
}

export function toggleOfflineV5Module(
  modules: readonly OfflineV5Module[],
  module: OfflineV5Module,
): OfflineV5Module[] {
  const next = new Set(modules)
  if (next.has(module)) next.delete(module)
  else next.add(module)
  return OFFLINE_V5_MODULE_IDS.filter(candidate => next.has(candidate))
}

export function offlineV5ResourceKey(resource: Pick<OfflineV5Resource, 'module' | 'resource_type' | 'resource_id'>) {
  return `${resource.module}:${resource.resource_type}:${resource.resource_id}`
}

export function offlineV5ResourceLabel(resource: OfflineV5Resource) {
  return resource.label?.trim()
    || `${offlineModulesV5.find(module => module.id === resource.module)?.label || 'Recurso'} · ${resource.resource_id}`
}

export function toggleOfflineV5Resource(
  current: readonly OfflineV5Resource[],
  resource: OfflineV5Resource,
  grantMaximum: number,
): OfflineV5Resource[] {
  const key = offlineV5ResourceKey(resource)
  if (current.some(candidate => offlineV5ResourceKey(candidate) === key)) {
    return current.filter(candidate => offlineV5ResourceKey(candidate) !== key)
  }
  const maximum = Math.min(20, Math.max(0, Math.floor(grantMaximum)))
  if (current.length >= maximum) return current.slice()
  return [...current, resource]
}

export function reconcileOfflineV5ResourceLabels(
  resources: readonly OfflineV5Resource[],
  known: readonly OfflineV5Resource[],
): OfflineV5Resource[] {
  const labels = new Map(
    known
      .filter(resource => resource.label?.trim())
      .map(resource => [offlineV5ResourceKey(resource), resource.label]),
  )
  return resources.map(resource => resource.label?.trim() || !labels.has(offlineV5ResourceKey(resource))
    ? resource
    : { ...resource, label: labels.get(offlineV5ResourceKey(resource)) })
}

export interface OfflineV5ApprovalDraft {
  account_id: string
  modules: OfflineV5Module[]
}

export function validateOfflineV5Approval(
  drafts: readonly OfflineV5ApprovalDraft[],
  authorizedAccountIDs: readonly string[],
) {
  if (!drafts.length) return 'Selecciona al menos una cuenta y un módulo.'
  if (drafts.length > 5) return 'Puedes autorizar como máximo 5 cuentas por solicitud.'
  if (new Set(drafts.map(draft => draft.account_id)).size !== drafts.length) return 'No repitas una cuenta.'
  const authorized = new Set(authorizedAccountIDs)
  if (drafts.some(draft => !authorized.has(draft.account_id))) return 'Una cuenta no pertenece al usuario solicitado.'
  if (drafts.some(draft => normalizeOfflineV5Modules(draft.modules).length !== draft.modules.length)) return 'Hay un módulo desconocido.'
  if (drafts.some(draft => draft.modules.length === 0)) return 'Selecciona al menos un módulo por cuenta.'
  return ''
}

export function offlineV5PreparationNotice(shellActivation?: 'current' | 'next-reopen') {
  if (shellActivation === 'next-reopen') {
    return 'La copia quedó preparada. Cierra todas las pestañas de Clarin y vuelve a abrirla una vez para activar esta versión offline.'
  }
  return 'Copia cifrada y verificada. Puedes cerrar el navegador y volver a la misma dirección sin conexión durante su vigencia.'
}
