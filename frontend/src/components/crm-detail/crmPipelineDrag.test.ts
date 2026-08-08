import { describe, expect, it } from 'vitest'
import { CRM_PIPELINE_UNASSIGNED_STAGE_ID, moveCrmPipelineItems, reconcileCrmPipelineCanonicalItem, type CrmPipelineSnapshot } from './crmPipelineDrag'
import { nextCrmPipelineKeyboardStage } from './CrmPipelineDndContext'

type Item = { id: string; stage: string }

const source = (): CrmPipelineSnapshot<Item> => ({
  columns: [
    { id: 'new', totalCount: 3, items: [{ id: 'a', stage: 'new' }, { id: 'b', stage: 'new' }] },
    { id: 'contacted', totalCount: 1, items: [{ id: 'c', stage: 'contacted' }] },
  ],
  unassigned: { id: '__unassigned__', totalCount: 1, items: [{ id: 'd', stage: '' }] },
})

describe('moveCrmPipelineItems', () => {
  it('moves loaded cards and reconciles source and destination counters once', () => {
    const original = source()
    const result = moveCrmPipelineItems(original, ['a', 'd'], 'contacted', item => item.id, item => ({ ...item, stage: 'contacted' }))
    expect(result.movedIds).toEqual(['a', 'd'])
    expect(result.snapshot.columns[0]).toMatchObject({ totalCount: 2, items: [{ id: 'b' }] })
    expect(result.snapshot.columns[1].totalCount).toBe(3)
    expect(result.snapshot.columns[1].items.map(item => item.id)).toEqual(['a', 'd', 'c'])
    expect(result.snapshot.unassigned).toMatchObject({ totalCount: 0, items: [] })
    expect(original.columns[0].items.map(item => item.id)).toEqual(['a', 'b'])
  })

  it('does not change a card already in the destination', () => {
    const original = source()
    const result = moveCrmPipelineItems(original, ['c'], 'contacted', item => item.id, item => item)
    expect(result.movedIds).toEqual([])
    expect(result.snapshot).toBe(original)
  })

  it('moves a staged card into the visible unassigned bucket', () => {
    const original = source()
    const result = moveCrmPipelineItems(
      original,
      ['a'],
      CRM_PIPELINE_UNASSIGNED_STAGE_ID,
      item => item.id,
      item => ({ ...item, stage: '' }),
    )

    expect(result.movedIds).toEqual(['a'])
    expect(result.snapshot.columns[0]).toMatchObject({ totalCount: 2, items: [{ id: 'b' }] })
    expect(result.snapshot.unassigned.totalCount).toBe(2)
    expect(result.snapshot.unassigned.items.map(item => item.id)).toEqual(['a', 'd'])
    expect(result.snapshot.unassigned.items[0].stage).toBe('')
  })

  it('refuses an unknown destination without removing the source card', () => {
    const original = source()
    const result = moveCrmPipelineItems(original, ['a'], 'missing-stage', item => item.id, item => item)
    expect(result.snapshot).toBe(original)
    expect(result.movedIds).toEqual([])
  })
})

describe('pipeline keyboard navigation', () => {
  const stages = ['new', 'contacted', 'confirmed']

  it('moves one stage per arrow and clamps at the board edges', () => {
    expect(nextCrmPipelineKeyboardStage(stages, 'new', 1)).toBe('contacted')
    expect(nextCrmPipelineKeyboardStage(stages, 'contacted', -1)).toBe('new')
    expect(nextCrmPipelineKeyboardStage(stages, 'confirmed', 1)).toBe('confirmed')
  })

  it('enters a measured board predictably when no stage is active', () => {
    expect(nextCrmPipelineKeyboardStage(stages, null, 1)).toBe('new')
    expect(nextCrmPipelineKeyboardStage(stages, null, -1)).toBe('confirmed')
  })
})

describe('reconcileCrmPipelineCanonicalItem', () => {
  it('moves a loaded card from a stage to the canonical unassigned bucket', () => {
    const original = source()
    const canonical = { id: 'a', stage: '', canonical: true } as Item & { canonical: boolean }
    const result = reconcileCrmPipelineCanonicalItem(
      original as CrmPipelineSnapshot<Item & { canonical?: boolean }>,
      canonical,
      CRM_PIPELINE_UNASSIGNED_STAGE_ID,
      item => item.id,
      (current, server) => ({ ...current, ...server }),
    )
    expect(result.columns[0]).toMatchObject({ totalCount: 2, items: [{ id: 'b' }] })
    expect(result.unassigned.totalCount).toBe(2)
    expect(result.unassigned.items[0]).toMatchObject({ id: 'a', canonical: true })
  })

  it('patches an item already in the canonical destination without changing counts', () => {
    const original = source()
    const result = reconcileCrmPipelineCanonicalItem(
      original,
      { id: 'c', stage: 'contacted-canonical' },
      'contacted',
      item => item.id,
      (current, server) => ({ ...current, ...server }),
    )
    expect(result.columns[1].totalCount).toBe(1)
    expect(result.columns[1].items[0].stage).toBe('contacted-canonical')
  })
})
