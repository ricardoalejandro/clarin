import { describe, expect, it, vi } from 'vitest'
import { markTaskCreateUncertain, retainTaskCreateOperation } from './taskCreateOperation'

describe('online task create operation', () => {
  it('freezes an uncertain attempt even if the visible draft changes', () => {
    const draft = { title: 'Submitted', collaborator_ids: ['one'] }
    const uncertain = markTaskCreateUncertain(retainTaskCreateOperation(null, draft, () => 'stable'))
    draft.title = 'Edited while recovering'; draft.collaborator_ids.push('two')
    const next = retainTaskCreateOperation(uncertain, draft, () => 'must-not-run')
    expect(next).toBe(uncertain)
    expect(next.payload).toEqual({ title: 'Submitted', collaborator_ids: ['one'] })
  })
  it('retains identity through transport failure and grant confirmation', () => {
    const create = vi.fn().mockReturnValueOnce('first').mockReturnValueOnce('second')
    const initial = retainTaskCreateOperation(null, { title: 'A', priority: 'high', confirm_grants: false }, create)
    expect(retainTaskCreateOperation(initial, { priority: 'high', title: 'A', operation_id: 'first', confirm_grants: true }, create)).toBe(initial)
    expect(create).toHaveBeenCalledTimes(1)
    expect(retainTaskCreateOperation(initial, { title: 'B', priority: 'high' }, create).operationID).toBe('second')
  })
})
