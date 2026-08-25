import { describe, expect, it } from 'vitest'
import { overdueAttentionQuery, scopeQuery } from './TaskWorkspace'

describe('scopeQuery', () => {
  it('normalizes the legacy all scope to the active Entorno', () => {
    expect(scopeQuery({ type: 'all' }, 'environment-1').get('environment_id')).toBe('environment-1')
  })

  it('keeps Compartidas conmigo inside the active Entorno', () => {
    const query = scopeQuery({ type: 'shared' }, 'environment-2')
    expect(query.get('shared_with_me')).toBe('true')
    expect(query.get('environment_id')).toBe('environment-2')
  })

  it('never replaces an explicit Entorno with the active fallback', () => {
    expect(scopeQuery({ type: 'environment', id: 'environment-explicit' }, 'environment-active').get('environment_id')).toBe('environment-explicit')
  })
})

describe('overdueAttentionQuery', () => {
  it('uses the same global root-task predicate as the dashboard counter', () => {
    const query = overdueAttentionQuery('actor-1')
    expect(query.get('environment_id')).toBeNull()
    expect(query.get('assigned_to')).toBe('actor-1')
    expect(query.get('due')).toBe('overdue')
    expect(query.get('include_closed')).toBe('false')
    expect(query.get('include_subtasks')).toBe('false')
  })
})
