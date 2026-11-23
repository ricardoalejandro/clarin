export const PROGRAM_TRANSFER_MAX_BYTES = 2 * 1024 * 1024
export const PROGRAM_TRANSFER_EXPORT_SUFFIX = '.clarin-program.json'

export type TransferChoice = { value: string; label: string }
export type TransferConflict = {
  key: string
  kind: string
  label: string
  field?: string
  local?: unknown
  incoming?: unknown
  mapping_key?: string
  choices?: TransferChoice[]
}
export type TransferSummary = { create: number; update: number; unchanged: number; conflicts: number }
export type TransferPreviewItem = { action: 'create' | 'update'; kind: string; label: string }
export type TransferPreview = {
  token: string
  program_name: string
  target_program_id?: string
  summary: TransferSummary
  conflicts: TransferConflict[]
  items: TransferPreviewItem[]
}
export type TransferResult = { program_id: string; summary: TransferSummary }
export type TransferInput = {
  file: Record<string, unknown>
  target_program_id?: string
  mappings?: Record<string, string>
}

export function parseProgramTransferFile(text: string): Record<string, unknown> {
  let document: unknown
  try { document = JSON.parse(text.replace(/^\uFEFF/, '')) }
  catch { throw new Error('El archivo no contiene JSON válido. Selecciona un archivo exportado desde Programas.') }
  if (!object(document) || !Number.isInteger(document.version) || !Array.isArray(document.records)) {
    throw new Error('Este archivo no tiene el formato de un programa de Clarin. El Excel de participantes no sirve para importar.')
  }
  if (typeof document.signature !== 'string' || !document.signature) {
    throw new Error('El archivo no tiene la firma de Clarin. Vuelve a exportar el programa y usa el archivo sin editarlo.')
  }
  return document
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function validTransferSummary(summary: unknown): summary is TransferSummary {
  return object(summary) && (['create', 'update', 'unchanged', 'conflicts'] as const)
    .every(key => Number.isSafeInteger(summary[key]) && Number(summary[key]) >= 0)
}

export function normalizeTransferPreview(data: unknown): TransferPreview | null {
  if (!object(data) || typeof data.token !== 'string' || !data.token || typeof data.program_name !== 'string' || !validTransferSummary(data.summary)) return null
  if (data.target_program_id !== undefined && typeof data.target_program_id !== 'string') return null
  const conflicts = data.conflicts ?? []
  const items = data.items ?? []
  if (!Array.isArray(conflicts) || !conflicts.every(validConflict)) return null
  if (!Array.isArray(items) || !items.every(validItem)) return null
  if (data.summary.conflicts !== conflicts.length || new Set(conflicts.map(conflict => conflict.key)).size !== conflicts.length) return null
  return { token: data.token, program_name: data.program_name, target_program_id: data.target_program_id, summary: data.summary, conflicts, items }
}

function validItem(value: unknown): value is TransferPreviewItem {
  return object(value) && (value.action === 'create' || value.action === 'update')
    && typeof value.kind === 'string' && typeof value.label === 'string'
}

function validConflict(value: unknown): value is TransferConflict {
  return object(value) && typeof value.key === 'string' && Boolean(value.key)
    && typeof value.kind === 'string' && typeof value.label === 'string'
    && (value.mapping_key === undefined || typeof value.mapping_key === 'string')
    && (value.field === undefined || typeof value.field === 'string')
    && (value.choices == null || (Array.isArray(value.choices) && value.choices.every(choice =>
      object(choice) && typeof choice.value === 'string' && typeof choice.label === 'string')))
}

export function transferInput(file: Record<string, unknown>, target: string, mappings: Record<string, string>): TransferInput {
  return { file, ...(target && { target_program_id: target }), ...(Object.keys(mappings).length > 0 && { mappings }) }
}

export function transferMapsEqual(a: Record<string, string>, b: Record<string, string>) {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && a[key] === b[key])
}

const scalarChoices: TransferChoice[] = [
  { value: 'local', label: 'Conservar el dato local' },
  { value: 'incoming', label: 'Usar el dato del archivo' },
]

export function programTransferChoices(conflict: TransferConflict): TransferChoice[] {
  return conflict.choices?.length ? conflict.choices : conflict.mapping_key ? [] : scalarChoices
}

export function canConfirmTransfer(preview: TransferPreview, decisions: Record<string, string>) {
  return preview.conflicts.every(conflict => !conflict.mapping_key
    && Object.hasOwn(decisions, conflict.key)
    && programTransferChoices(conflict).some(option => option.value === decisions[conflict.key]))
}

const FIELD_LABELS: Record<string, string> = {
  name: 'Nombre', title: 'Título', topic: 'Tema', topics: 'Temas de la clase', description: 'Descripción',
  date: 'Fecha', location: 'Lugar', status: 'Estado', enrolled_at: 'Fecha de inscripción',
  dropped_at: 'Fecha de retiro', completed_at: 'Fecha de finalización', start_time: 'Hora de inicio', end_time: 'Hora de fin',
  notes: 'Observaciones', note: 'Nota', phone: 'Teléfono', email: 'Correo', schedule_days: 'Días programados',
  archived_from_status: 'Estado antes de archivar', drop_reason: 'Motivo de retiro', drop_notes: 'Detalle de retiro',
}
const STATUS_LABELS: Record<string, string> = {
  present: 'Presente', absent: 'Ausente', late: 'Tarde', pending: 'Pendiente',
  confirmed: 'Confirmado', active: 'Activo', archived: 'Archivado', completed: 'Completado', dropped: 'Retirado',
  regular: 'Regular', recovery: 'Recuperación',
}
const KIND_LABELS: Record<string, string> = {
  program: 'Programa', contact: 'Contacto', course: 'Curso', course_topic: 'Tema de curso', goal: 'Meta',
  program_course: 'Curso del programa', instructor: 'Instructor', participant: 'Participante', session: 'Sesión',
  session_topic: 'Tema de sesión', attendance: 'Asistencia', session_observation: 'Observación de clase',
  participant_note: 'Nota de seguimiento', interaction: 'Observación de participante',
}

export function programTransferKind(kind: string) {
  return Object.hasOwn(KIND_LABELS, kind) ? KIND_LABELS[kind] : 'Registro'
}

export function programTransferField(field: string) {
  return Object.hasOwn(FIELD_LABELS, field) ? FIELD_LABELS[field] : field.replaceAll('_', ' ')
}

export function programTransferValue(value: unknown, field = ''): string {
  if (value === null || value === undefined || value === '') return 'Sin dato'
  if (typeof value === 'string') {
    return ['status', 'session_type', 'archived_from_status'].includes(field) && Object.hasOwn(STATUS_LABELS, value) ? STATUS_LABELS[value] : value
  }
  if (typeof value === 'boolean') return value ? 'Sí' : 'No'
  if (Array.isArray(value)) return value.map(item => programTransferValue(item, field)).join(', ') || 'Sin dato'
  if (object(value)) return Object.entries(value).map(([key, item]) => `${programTransferField(key)}: ${programTransferValue(item, key)}`).join(' · ') || 'Sin dato'
  return String(value)
}

export function programTransferFilename(name: string): string {
  const safeName = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100)
  return `${safeName || 'programa'}${PROGRAM_TRANSFER_EXPORT_SUFFIX}`
}

export function programTransferAllowed(user: unknown): boolean {
  if (!object(user)) return false
  if (user.is_admin === true || user.is_super_admin === true) return true
  if (!Array.isArray(user.permissions)) return false
  return user.permissions.includes('*') || (user.permissions.includes('programs') && user.permissions.includes('contacts'))
}

export function transferError(status: number | undefined, code: string | undefined, fallback: string): string {
  if (status === 401) return 'Tu sesión ya no está disponible. Vuelve a iniciar sesión para continuar.'
  if (status === 403) return 'Necesitas acceso a Programas y Contactos de esta cuenta para realizar la transferencia.'
  if (code === 'program_transfer_preview_stale') return 'El destino cambió o la vista previa caducó. Genera otra vista previa antes de confirmar.'
  if (code === 'program_transfer_signature_invalid') return 'Clarin no pudo verificar este archivo. Usa un archivo sin editar, exportado por esta misma instalación.'
  if (code === 'program_transfer_destination_closed') return 'El programa de destino no está activo. Selecciona otro programa o crea uno nuevo.'
  if (status === 413 || code === 'program_transfer_too_large') return 'El archivo supera el límite de 2 MB.'
  return fallback
}
