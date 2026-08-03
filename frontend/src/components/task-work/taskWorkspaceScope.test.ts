import { describe, expect, it } from 'vitest'
import { scopeQuery } from './TaskWorkspace'

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
