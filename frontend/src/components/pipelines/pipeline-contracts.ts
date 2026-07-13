import type { PipelineStage, PipelineStageType } from '@/types/contact'

export interface PipelineTemplateStage {
  name: string
  color: string
  stage_type: PipelineStageType
  position?: number
}

export interface PipelineTemplate {
  id: string
  name: string
  description: string
  recommended_for?: string
  stages: PipelineTemplateStage[]
}

export interface StageDraft {
  key: string
  id?: string
  name: string
  color: string
  stage_type: PipelineStageType
  position: number
  lead_count: number
}

export interface DeletedStageDraft {
  id: string
  name: string
  lead_count: number
  reassign_to_stage_id?: string
  reassign_to_client_id?: string
}

export const STAGE_COLORS = [
  '#0f766e',
  '#059669',
  '#16a34a',
  '#65a30d',
  '#ca8a04',
  '#ea580c',
  '#dc2626',
  '#db2777',
  '#9333ea',
  '#7c3aed',
  '#4f46e5',
  '#2563eb',
  '#0284c7',
  '#475569',
] as const

const DEFAULT_WON_COLOR = '#16a34a'
const DEFAULT_LOST_COLOR = '#dc2626'

export function createStageKey() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `stage-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function normalizeName(value: string) {
  return value.trim().replace(/\s+/g, ' ').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es')
}

export function inferStageType(stage: Pick<PipelineStage, 'name' | 'stage_type'>): PipelineStageType {
  if (stage.stage_type === 'won' || stage.stage_type === 'lost') return stage.stage_type
  const name = normalizeName(stage.name)
  if (['ganado', 'ganada', 'ganados', 'ganadas', 'cerrado ganado', 'closed won', 'inscrito', 'inscrita'].includes(name)) return 'won'
  if (['perdido', 'perdida', 'perdidos', 'perdidas', 'cerrado perdido', 'closed lost', 'no continua'].includes(name)) return 'lost'
  return 'active'
}

export function normalizeDraftPositions(stages: StageDraft[]) {
  const active = stages.filter(stage => stage.stage_type === 'active')
  const won = stages.filter(stage => stage.stage_type === 'won')
  const lost = stages.filter(stage => stage.stage_type === 'lost')
  return [...active, ...won, ...lost].map((stage, position) => ({ ...stage, position }))
}

export function draftFromPipelineStages(stages: PipelineStage[] | null | undefined, ensureTerminals = true): StageDraft[] {
  const sorted = [...(stages || [])].sort((a, b) => a.position - b.position)
  const draft: StageDraft[] = sorted.map(stage => ({
    key: stage.id || createStageKey(),
    id: stage.id,
    name: stage.name,
    color: stage.color || '#64748b',
    stage_type: inferStageType(stage),
    position: stage.position,
    lead_count: stage.lead_count || 0,
  }))

  if (ensureTerminals && !draft.some(stage => stage.stage_type === 'won')) {
    draft.push({ key: createStageKey(), name: 'Ganado', color: DEFAULT_WON_COLOR, stage_type: 'won', position: draft.length, lead_count: 0 })
  }
  if (ensureTerminals && !draft.some(stage => stage.stage_type === 'lost')) {
    draft.push({ key: createStageKey(), name: 'Perdido', color: DEFAULT_LOST_COLOR, stage_type: 'lost', position: draft.length, lead_count: 0 })
  }
  return normalizeDraftPositions(draft)
}

export function draftFromTemplate(template: PipelineTemplate): StageDraft[] {
  return normalizeDraftPositions(template.stages.map((stage, position) => ({
    key: createStageKey(),
    name: stage.name,
    color: stage.color || STAGE_COLORS[position % STAGE_COLORS.length],
    stage_type: stage.stage_type,
    position,
    lead_count: 0,
  })))
}

export function createManualDraft(): StageDraft[] {
  return normalizeDraftPositions([
    { key: createStageKey(), name: 'Nueva oportunidad', color: '#2563eb', stage_type: 'active', position: 0, lead_count: 0 },
    { key: createStageKey(), name: 'Ganado', color: DEFAULT_WON_COLOR, stage_type: 'won', position: 1, lead_count: 0 },
    { key: createStageKey(), name: 'Perdido', color: DEFAULT_LOST_COLOR, stage_type: 'lost', position: 2, lead_count: 0 },
  ])
}

export function validateStageDraft(stages: StageDraft[]) {
  const errors: string[] = []
  const emptyNames = stages.filter(stage => !stage.name.trim())
  const normalizedNames = stages.map(stage => normalizeName(stage.name)).filter(Boolean)
  const duplicateNames = normalizedNames.filter((name, index) => normalizedNames.indexOf(name) !== index)
  const activeCount = stages.filter(stage => stage.stage_type === 'active').length
  const wonCount = stages.filter(stage => stage.stage_type === 'won').length
  const lostCount = stages.filter(stage => stage.stage_type === 'lost').length

  if (activeCount === 0) errors.push('Agrega al menos una etapa activa.')
  if (wonCount !== 1) errors.push('El pipeline debe tener exactamente una etapa Ganado.')
  if (lostCount !== 1) errors.push('El pipeline debe tener exactamente una etapa Perdido.')
  if (emptyNames.length > 0) errors.push('Todas las etapas necesitan un nombre.')
  if (duplicateNames.length > 0) errors.push('Los nombres de las etapas no pueden repetirse.')
  if (stages.some(stage => stage.name.trim().length > 80)) errors.push('Los nombres de etapa pueden tener hasta 80 caracteres.')
  return errors
}

export function stageDraftSignature(stages: StageDraft[], deleted: DeletedStageDraft[] = []) {
  return JSON.stringify({
    stages: normalizeDraftPositions(stages).map(({ id, name, color, stage_type, position }) => ({ id, name: name.trim(), color, stage_type, position })),
    deleted: deleted.map(({ id, reassign_to_stage_id, reassign_to_client_id }) => ({ id, reassign_to_stage_id, reassign_to_client_id })).sort((a, b) => a.id.localeCompare(b.id)),
  })
}

export function serializeStages(stages: StageDraft[]) {
  return normalizeDraftPositions(stages).map(stage => ({
    ...(stage.id ? { id: stage.id } : { client_id: stage.key }),
    name: stage.name.trim(),
    color: stage.color,
    stage_type: stage.stage_type,
    position: stage.position,
  }))
}
