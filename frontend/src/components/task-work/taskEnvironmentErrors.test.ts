import { describe, expect, it } from 'vitest'
import { taskEnvironmentSaveError } from './taskEnvironmentErrors'

describe('taskEnvironmentSaveError', () => {
  it('explains an active name collision without asking the user to reopen the window', () => {
    expect(taskEnvironmentSaveError(409, 'environment_name_conflict')).toContain('Ya existe')
  })

  it('keeps the optimistic concurrency guidance for other conflicts', () => {
    expect(taskEnvironmentSaveError(409, 'version_conflict')).toContain('otra sesión')
  })

  it('preserves a useful server error for non-conflicts', () => {
    expect(taskEnvironmentSaveError(500, undefined, 'Detalle interno')).toBe('Detalle interno')
  })
})
