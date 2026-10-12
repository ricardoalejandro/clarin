import { eventDetailPayload, eventLocalDateTime } from '@/app/dashboard/events/eventForm'

export type EventConfigurationSection = 'data' | 'stages' | 'rules'
export type EventConfigurationRecord = {
  id: string; updated_at?: string; name: string; description?: string | null; event_date?: string | null; event_end?: string | null
  location?: string | null; color: string; status: string; pipeline_id?: string | null
}
export type EventDataDraft = { name: string; description: string; event_date: string; event_end: string; location: string; color: string; status: string }
export type EventConfigurationStage = { id: string; name: string; color: string; position: number; participant_count: number }
export type EventStageLayout = { success?: boolean; pipeline_id: string | null; revision: number; stages: EventConfigurationStage[]; stage_id_map?: Record<string, string> }
export type EventStageDraft = { key: string; id?: string; name: string; color: string; count: number; deleted?: boolean; moveTo?: string }
export type EventRuleTag = { id: string; name: string; color: string; negate?: boolean }
export type EventRuleDraft = { formula_mode: 'OR' | 'AND'; tag_formula_type: 'simple' | 'advanced'; tag_formula: string; tags: EventRuleTag[] }
export type EventRuleImpact = { created: number; activated: number; deactivated: number; unchanged: number; matched: number; broad_rule: boolean; rule_revision: number; fingerprint: string }

export const emptyEventData = (): EventDataDraft => ({ name: '', description: '', event_date: '', event_end: '', location: '', color: '#3B82F6', status: 'draft' })
export const emptyEventRule = (): EventRuleDraft => ({ formula_mode: 'OR', tag_formula_type: 'simple', tag_formula: '', tags: [] })
export const eventDataDraft = (event: EventConfigurationRecord): EventDataDraft => ({
  name: event.name, description: event.description || '', location: event.location || '',
  event_date: eventLocalDateTime(event.event_date), event_end: eventLocalDateTime(event.event_end),
  color: event.color.toUpperCase(), status: event.status,
})
export function eventConfigurationDataPayload(draft: EventDataDraft, original?: EventConfigurationRecord | null) {
  if (!draft.name.trim() || draft.name.trim().length > 255) throw new Error('Escribe un nombre de hasta 255 caracteres.')
  if (!/^#[0-9A-F]{6}$/i.test(draft.color)) throw new Error('El color debe tener el formato #RRGGBB.')
  return { ...eventDetailPayload(draft, original || undefined), name: draft.name.trim(), color: draft.color.toUpperCase(), status: draft.status }
}
export const eventStageDrafts = (layout: EventStageLayout): EventStageDraft[] => layout.stages.map(stage => ({ key: stage.id, id: stage.id, name: stage.name, color: stage.color.toUpperCase(), count: stage.participant_count }))
export function moveEventStage(stages: EventStageDraft[], key: string, target: string) {
  const active = stages.filter(stage => !stage.deleted)
  const from = active.findIndex(stage => stage.key === key), to = active.findIndex(stage => stage.key === target)
  if (from < 0 || to < 0 || from === to) return stages
  const next = [...active], [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return [...next, ...stages.filter(stage => stage.deleted)]
}
export function eventStageSignature(stages: EventStageDraft[]) {
  return JSON.stringify(stages.map(({ key, name, color, deleted, moveTo }) => ({ key, name, color, deleted: Boolean(deleted), moveTo: deleted ? moveTo : undefined })))
}
export function eventStagePayload(stages: EventStageDraft[], revision: number) {
  const active = stages.filter(stage => !stage.deleted)
  if (!active.length) throw new Error('Debe quedar al menos una etapa.')
  if (active.length > 200) throw new Error('El evento admite hasta 200 etapas.')
  const names = new Set<string>()
  for (const stage of active) {
    const name = stage.name.trim().toLocaleLowerCase('es')
    if (!name || stage.name.trim().length > 80) throw new Error('Cada etapa necesita un nombre de hasta 80 caracteres.')
    if (names.has(name)) throw new Error('Los nombres de las etapas no pueden repetirse.')
    if (!/^#[0-9A-F]{6}$/i.test(stage.color)) throw new Error('El color debe tener el formato #RRGGBB.')
    names.add(name)
  }
  const deletions = stages.filter(stage => stage.deleted && stage.id).map(stage => {
    const destination = active.find(item => item.key === stage.moveTo)
    if (!destination) throw new Error('Elige un destino para «' + stage.name + '».')
    return { id: stage.id, moveTo: { kind: destination.id ? 'stage' : 'client', id: destination.id || destination.key } }
  })
  return {
    expected_revision: revision,
    stages: active.map((stage, position) => ({ ...(stage.id ? { id: stage.id } : { clientId: stage.key }), name: stage.name.trim(), color: stage.color.toUpperCase(), position })),
    deletions,
  }
}
export function eventRulePayload(rule: EventRuleDraft) {
  return {
    formula_mode: rule.formula_mode, tag_formula_type: rule.tag_formula_type, tag_formula: rule.tag_formula,
    include_tag_ids: rule.tags.filter(tag => !tag.negate).map(tag => tag.id).sort(),
    exclude_tag_ids: rule.tags.filter(tag => tag.negate).map(tag => tag.id).sort(),
  }
}
export const eventRuleSignature = (rule: EventRuleDraft) => JSON.stringify(eventRulePayload(rule))
