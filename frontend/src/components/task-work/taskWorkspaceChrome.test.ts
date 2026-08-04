import { describe, expect, it } from 'vitest'
import { showIndependentListsHeading, taskGroupingTriggerText, taskWorkspaceChromeDensity } from './taskWorkspaceChrome'

describe('taskWorkspaceChrome', () => {
  it('derives chrome density from the measured workspace width', () => {
    expect(taskWorkspaceChromeDensity(0)).toBe('comfortable')
    expect(taskWorkspaceChromeDensity(759)).toBe('narrow')
    expect(taskWorkspaceChromeDensity(760)).toBe('compact')
    expect(taskWorkspaceChromeDensity(1099)).toBe('compact')
    expect(taskWorkspaceChromeDensity(1100)).toBe('comfortable')
  })

  it('keeps the grouping trigger informative without crowding narrow workspaces', () => {
    expect(taskGroupingTriggerText('none', 'comfortable')).toBe('Agrupar: Sin agrupación')
    expect(taskGroupingTriggerText('assignee', 'compact')).toBe('Responsable')
    expect(taskGroupingTriggerText('status', 'narrow')).toBe('')
  })

  it('hides an empty independent-list heading until it communicates state or a drop target', () => {
    expect(showIndependentListsHeading(0, 'ready', false)).toBe(false)
    expect(showIndependentListsHeading(1, 'ready', false)).toBe(true)
    expect(showIndependentListsHeading(0, 'loading', false)).toBe(true)
    expect(showIndependentListsHeading(0, 'error', false)).toBe(true)
    expect(showIndependentListsHeading(0, 'ready', true)).toBe(true)
  })
})
