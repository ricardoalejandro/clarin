export interface LogbookFilter { text_search?: string; stage_ids?: string; has_phone?: boolean; tag_names?: string[]; exclude_tag_names?: string[]; tag_mode?: string; tag_formula?: string; date_field?: string; date_from?: string; date_to?: string }
export interface LogbookStage { name: string; color: string; count: number; position?: number | null }
export interface EventLogbook { id: string; event_id: string; date: string; title: string; status: 'pending' | 'active' | 'completed'; general_notes: string; version: number; captured_at?: string; completed_at?: string; total_participants: number; stage_snapshot: Record<string, LogbookStage>; saved_filter?: LogbookFilter | null; captured_filter?: LogbookFilter | null; created_by_name?: string }
export interface LogbookEntry { id: string; participant_id: string; participant_name: string; participant_phone?: string; stage_name: string; stage_color: string; stage_id?: string; capture_stage_key: string; stage_position: number | null; notes: string }
export interface LogbookPage<T> { items: T[]; total: number; next_cursor?: string }
export const logbookStatusLabel = {pending: 'Pendiente', active: 'En curso', completed: 'Completada'}
export function logbookDate(value: string) { return new Date(`${value.slice(0, 10)}T12:00:00`).toLocaleDateString('es-PE', {day: '2-digit', month: 'short', year: 'numeric'}) }
export function logbookScopeLabels(filter?: LogbookFilter | null): string[] {
 if (!filter || !Object.values(filter).some(value => Array.isArray(value) ? value.length : !!value)) return ['Todos los participantes activos']
 const labels: string[] = []
 if (filter.text_search) labels.push(`Búsqueda: ${filter.text_search}`)
 if (filter.stage_ids) labels.push(`${filter.stage_ids.split(',').length} etapas seleccionadas`)
 if (filter.has_phone) labels.push('Con teléfono')
 if (filter.tag_names?.length) labels.push(`Etiquetas: ${filter.tag_names.join(', ')} (${filter.tag_mode || 'OR'})`)
 if (filter.exclude_tag_names?.length) labels.push(`Sin etiquetas: ${filter.exclude_tag_names.join(', ')}`)
 if (filter.tag_formula) labels.push(`Fórmula: ${filter.tag_formula}`)
 if (filter.date_field) labels.push(`Fecha: ${filter.date_from?.slice(0, 10) || 'Inicio'} — ${filter.date_to?.slice(0, 10) || 'Actualidad'}`)
 return labels
}
export function orderedLogbookStages(stages: Record<string, LogbookStage>) {return Object.entries(stages).sort(([ka,a],[kb,b]) => ka === 'unassigned' ? 1 : kb === 'unassigned' ? -1 : (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) || ka.localeCompare(kb))}
export function canonicalLogbook(current: EventLogbook | null, incoming: EventLogbook) {return current?.id === incoming.id && current.version > incoming.version ? current : incoming}
export function mergeLogbookPage<T extends {id:string}>(current:T[],incoming:T[],append:boolean):T[]{if(!append)return incoming;const values=new Map(current.map(row=>[row.id,row]));incoming.forEach(row=>values.set(row.id,row));return Array.from(values.values())}
export function logbookCanEdit(book: EventLogbook | null,readOnly:boolean){return !!book && !readOnly && book.status!=='completed'}
export function logbookMatches(book: EventLogbook,query:string,status:string){return (!status||book.status===status)&&(!query||`${book.title} ${book.date}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))}
export function logbookDraftConflict(draftVersion:number,book:EventLogbook|null){return !!book&&draftVersion!==book.version}
