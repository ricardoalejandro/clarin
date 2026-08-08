import { describe, expect, it } from 'vitest'
import { crmMessageIsPending, crmMessageTemporaryMode, type CrmMessagePhase } from './crmMessageWorkflow'

describe('CRM message workflow', () => {
  it.each<CrmMessagePhase>(['resolving', 'choosing_device', 'opening_chat', 'chat'])(
    'temporarily maximizes the CRM window during %s',
    phase => {
      expect(crmMessageTemporaryMode(phase)).toBe('maximized')
    },
  )

  it('restores the persisted window mode only after the workflow returns to idle', () => {
    expect(crmMessageTemporaryMode('idle')).toBeUndefined()
  })

  it('marks only network resolution and chat creation as pending', () => {
    expect(crmMessageIsPending('resolving')).toBe(true)
    expect(crmMessageIsPending('opening_chat')).toBe(true)
    expect(crmMessageIsPending('choosing_device')).toBe(false)
    expect(crmMessageIsPending('chat')).toBe(false)
    expect(crmMessageIsPending('idle')).toBe(false)
  })
})
