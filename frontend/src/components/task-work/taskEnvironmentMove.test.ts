import { describe, expect, it } from 'vitest'
import { taskMoveConfirmationLabel, taskMoveNeedsAccessConfirmation } from './taskEnvironmentMove'

describe('cross-environment task move', () => {
  it('requires an explicit retry only for the canonical ACL conflict', () => {
    expect(taskMoveNeedsAccessConfirmation(409, { code: 'access_change_confirmation_required' })).toBe(true)
    expect(taskMoveNeedsAccessConfirmation(409, { code: 'version_conflict' })).toBe(false)
    expect(taskMoveNeedsAccessConfirmation(403, { code: 'access_change_confirmation_required' })).toBe(false)
  })

  it('deduplicates affected participants in confirmation copy', () => {
    expect(taskMoveConfirmationLabel(['a', 'a', 'b'])).toMatch(/^2 participantes/)
    expect(taskMoveConfirmationLabel(['a'])).toMatch(/^1 participante necesita/)
  })
})

