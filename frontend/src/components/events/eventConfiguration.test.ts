import { describe, expect, it } from 'vitest'
import { emptyEventData, eventConfigurationDataPayload, eventStagePayload, moveEventStage, eventStageSignature, eventRulePayload, type EventStageDraft } from './eventConfiguration'

const stages: EventStageDraft[] = [
  { key: 'a', id: 'a', name: 'Invitados', color: '#123456', count: 200 },
  { key: 'b', id: 'b', name: 'Confirmados', color: '#abcdef', count: 30 },
  { key: 'draft-new', name: 'Seguimiento', color: '#ABCDEF', count: 0 },
]
describe('event configuration contracts', () => {
  it('keeps raw draft text editable and trims only the save payload', () => {
    const raw = [{ ...stages[0], name: ' Primer contacto ' }]
    expect(eventStagePayload(raw, 3).stages[0].name).toBe('Primer contacto')
    expect(raw[0].name).toBe(' Primer contacto ')
    expect(() => eventStagePayload([{ ...stages[0], name: '' }], 3)).toThrow('nombre')
  })
  it('reorders in the draft without dropping a pending reassignment', () => {
    const input = [stages[0], { ...stages[1], deleted: true, moveTo: 'draft-new' }, stages[2]]
    const moved = moveEventStage(input, 'draft-new', 'a')
    expect(moved.map(stage => stage.key)).toEqual(['draft-new', 'a', 'b'])
    expect(moved[2].moveTo).toBe('draft-new')
    expect(input[0].key).toBe('a')
    expect(moveEventStage(input, 'unknown', 'a')).toBe(input)
  })
  it('keeps revision and resolves a new stage as a deletion destination', () => {
    const payload = eventStagePayload([{ ...stages[0], deleted: true, moveTo: 'draft-new' }, stages[1], stages[2]], 17)
    expect(payload.expected_revision).toBe(17)
    expect(payload.deletions).toEqual([{ id: 'a', moveTo: { kind: 'client', id: 'draft-new' } }])
    expect(payload.stages).toEqual([
      { id: 'b', name: 'Confirmados', color: '#ABCDEF', position: 0 },
      { clientId: 'draft-new', name: 'Seguimiento', color: '#ABCDEF', position: 1 },
    ])
  })
  it('refuses incomplete deletion and duplicate names without touching the draft', () => {
    expect(() => eventStagePayload([{ ...stages[0], deleted: true }, stages[1]], 1)).toThrow('destino')
    expect(() => eventStagePayload([stages[0], { ...stages[1], name: ' invitados ' }], 1)).toThrow('repetirse')
    expect(() => eventStagePayload([{ ...stages[0], color: 'red' }], 1)).toThrow('#RRGGBB')
  })
  it('does not mark server participant count reconciliation as a dirty edit', () => {
    expect(eventStageSignature(stages)).toBe(eventStageSignature(stages.map(stage => ({ ...stage, count: stage.count + 1 }))))
  })
  it('separates metadata from admission rule payloads and preserves dates', () => {
    const draft = { ...emptyEventData(), name: ' Jornada ', event_date: '2026-10-12T10:00', event_end: '2026-10-12T11:00' }
    const payload = eventConfigurationDataPayload(draft)
    expect(payload.name).toBe('Jornada')
    expect(payload).not.toHaveProperty('include_tag_ids')
    expect(() => eventConfigurationDataPayload({ ...draft, event_end: '2026-10-12T09:00' })).toThrow('posterior')
    expect(eventRulePayload({ formula_mode: 'AND', tag_formula_type: 'simple', tag_formula: '', tags: [
      { id: 'z', name: 'One', color: '#123456' }, { id: 'a', name: 'Excluded', color: '#123456', negate: true },
    ] })).toEqual({ formula_mode: 'AND', tag_formula_type: 'simple', tag_formula: '', include_tag_ids: ['z'], exclude_tag_ids: ['a'] })
  })
})
