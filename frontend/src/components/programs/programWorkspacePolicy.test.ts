import { describe, expect, it } from 'vitest'
import { mobileProgramTab, programSections, programWorkspacePolicy } from './programWorkspacePolicy'

describe('Program workspace policy', () => {
  it.each([0, 320, 375, 522, 699])('limits a %ipx workspace to mobile operations', width => {
    expect(programWorkspacePolicy(width, false, 900)).toMatchObject({ mobile: true, desktopActions: false })
    expect(programSections(true, true)).toEqual(['health', 'sessions'])
  })

  it('preserves desktop capabilities at the measured boundary and in compact tablets', () => {
    expect(programWorkspacePolicy(700, false, 900)).toEqual({ compact: true, mobile: false, touch: true, desktopActions: true })
    expect(programWorkspacePolicy(819, false, 900).compact).toBe(true)
    expect(programWorkspacePolicy(820, false, 900).compact).toBe(false)
    expect(programSections(false, true)).toEqual(['health', 'academic', 'sessions', 'stats', 'surveys'])
    expect(programSections(false, false)).not.toContain('surveys')
  })

  it('uses layout height for short touch screens, independent of keyboard visual height', () => {
    expect(programWorkspacePolicy(900, true, 599).mobile).toBe(true)
    expect(programWorkspacePolicy(900, true, 600).mobile).toBe(false)
    expect(programWorkspacePolicy(900, true, 800).desktopActions).toBe(true)
    expect(programWorkspacePolicy(900, false, 480).mobile).toBe(false)
  })

  it.each(['academic', 'stats', 'surveys', 'health', 'participants', 'kanban'] as const)(
    'shows Participants when entering mobile from %s without discarding desktop selection', tab => {
      expect(mobileProgramTab(tab)).toBe('health')
    },
  )
  it('keeps Sessions selected when entering mobile from Sessions', () => {
    expect(mobileProgramTab('sessions')).toBe('sessions')
  })
})
