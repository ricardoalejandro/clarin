import { describe, expect, it } from 'vitest'
import { taskContainerCanManageStructure, taskContainerLifecycleCapability } from './taskContainerCapabilities'

describe('task container management capabilities', () => {
  it('keeps Administrar available when Trash is blocked by retained tasks', () => {
    expect(taskContainerCanManageStructure({
      permissions: { level: 'full' },
    })).toBe(true)
  })

  it('accepts the canonical capabilities and effective access aliases', () => {
    expect(taskContainerCanManageStructure({ capabilities: { level: 'full' } })).toBe(true)
    expect(taskContainerCanManageStructure({ effective_access_level: 'full' })).toBe(true)
  })

  it('does not grant structure management to Editar or missing access', () => {
    expect(taskContainerCanManageStructure({ permissions: { level: 'edit' } })).toBe(false)
    expect(taskContainerCanManageStructure()).toBe(false)
  })

  it('prefers the canonical capabilities object when aliases disagree', () => {
    expect(taskContainerCanManageStructure({
      capabilities: { level: 'edit' },
      permissions: { level: 'full' },
      effective_access_level: 'full',
    })).toBe(false)
  })

  it('uses canonical lifecycle capabilities before compatibility aliases', () => {
    expect(taskContainerLifecycleCapability({
      capabilities: { level: 'full', can_archive: true, can_trash: false },
      permissions: { level: 'full', can_archive: false, can_trash: true },
    }, 'can_archive')).toBe(true)
    expect(taskContainerLifecycleCapability({
      capabilities: { level: 'full', can_archive: true, can_trash: false },
      permissions: { level: 'full', can_archive: false, can_trash: true },
    }, 'can_trash')).toBe(false)
  })

  it('falls back to compatibility aliases and preserves an unknown capability', () => {
    expect(taskContainerLifecycleCapability({
      permissions: { level: 'full', can_archive: true },
    }, 'can_archive')).toBe(true)
    expect(taskContainerLifecycleCapability({ permissions: { level: 'full' } }, 'can_trash')).toBeUndefined()
  })
})
