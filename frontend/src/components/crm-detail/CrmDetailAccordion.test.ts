import { describe, expect, it } from 'vitest'
import { defaultCrmDetailAccordionState } from './CrmDetailAccordion'

describe('defaultCrmDetailAccordionState', () => {
  it('keeps the three primary groups visible and secondary context collapsed', () => {
    expect(defaultCrmDetailAccordionState()).toEqual({
      contact: true,
      tags: true,
      activity: true,
      context: false,
      tasks: false,
      history: false,
      integrations: false,
    })
  })

  it('returns a fresh state for every CRM entity', () => {
    const first = defaultCrmDetailAccordionState()
    first.contact = false
    expect(defaultCrmDetailAccordionState().contact).toBe(true)
  })
})
