import { describe, expect, it } from 'vitest'
import { buildSurveyResultsExportPayload, createSurveyResultsExportSingleFlight } from './surveyResultsExport'

describe('buildSurveyResultsExportPayload', () => {
  it('sends every selected chart and defaults missing questions to bars', () => {
    expect(buildSurveyResultsExportPayload(['q1', 'q2', 'q3'], { q1: 'pie', q3: 'radar' }, 'base', 'follow')).toEqual({
      chart_types: { q1: 'pie', q2: 'bar', q3: 'radar' },
      baseline_id: 'base',
      followup_id: 'follow',
    })
  })

  it('omits empty comparison identifiers', () => {
    expect(buildSurveyResultsExportPayload(['q1'], {})).toEqual({ chart_types: { q1: 'bar' } })
  })

  it('blocks duplicate exports and allows a retry after failure', async () => {
    let resolveFirst!: () => void
    const gate = createSurveyResultsExportSingleFlight()
    const first = gate.run(() => new Promise<void>(resolve => { resolveFirst = resolve }))
    expect(gate.isActive()).toBe(true)
    expect(await gate.run(async () => undefined)).toBe(false)
    resolveFirst()
    expect(await first).toBe(true)

    await expect(gate.run(async () => { throw new Error('falló') })).rejects.toThrow('falló')
    expect(gate.isActive()).toBe(false)
    expect(await gate.run(async () => undefined)).toBe(true)
  })
})
