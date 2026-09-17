import { describe, expect, it } from 'vitest'
import { operationErrorMessage, operationOutcomeIsUnknown } from './operationAttempt'
import { LocalServiceError } from './types'

describe('offline operation ambiguity', () => {
  it('retains an idempotent attempt only when the local response outcome is unknown', () => {
    expect(operationOutcomeIsUnknown(new LocalServiceError(0, 'local_service_timeout', 'timeout'))).toBe(true)
    expect(operationOutcomeIsUnknown(new LocalServiceError(0, 'local_service_unavailable', 'down'))).toBe(true)
    expect(operationOutcomeIsUnknown(new LocalServiceError(403, 'action_denied', 'denied'))).toBe(false)
  })

  it('tells the user that retry reuses the same operation instead of silently duplicating it', () => {
    expect(operationErrorMessage(new LocalServiceError(0, 'local_service_timeout', 'timeout'))).toContain('mismo identificador')
    expect(operationErrorMessage(new LocalServiceError(409, 'conflict', 'Conflicto'))).toBe('Conflicto')
  })
})
