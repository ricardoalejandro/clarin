import { describe, expect, it, vi } from 'vitest'
import type { SurveyResponse } from '@/types/survey'
import { changeSurveyApplicationStatus, emptySurveyResultsState, surveyResultsReducer } from './surveyApplicationState'

describe('survey application state', () => {
  it.each(['Permiso denegado', 'La aplicación cambió', 'Error de conexión'])('surfaces rejected status changes without reconciliation: %s', async error => {
    const reconcile = vi.fn(async () => {})
    await expect(changeSurveyApplicationStatus(async () => ({ success: false, error }), reconcile)).rejects.toThrow(error)
    expect(reconcile).not.toHaveBeenCalled()
  })

  it('reconciles exactly once after a successful status change', async () => {
    const reconcile = vi.fn(async () => {})
    await changeSurveyApplicationStatus(async () => ({ success: true }), reconcile)
    expect(reconcile).toHaveBeenCalledOnce()
  })

  it('keeps failed initial loads distinct from successful empty results', () => {
    let state = emptySurveyResultsState('survey-1')
    state = surveyResultsReducer(state, { ownerSurveyId: 'survey-1', type: 'analyticsStart' })
    state = surveyResultsReducer(state, { ownerSurveyId: 'survey-1', type: 'analyticsFailure', error: 'Analytics 500' })
    state = surveyResultsReducer(state, { ownerSurveyId: 'survey-1', type: 'analyticsFinish' })
    state = surveyResultsReducer(state, { ownerSurveyId: 'survey-1', type: 'responsesFailure', error: 'Responses 500' })
    expect(state.analyticsError).toBe('Analytics 500')
    expect(state.responsesError).toBe('Responses 500')
    expect(state.loadingAnalytics).toBe(false)
    expect(state.responsesLoaded).toBe(false)
    state = surveyResultsReducer(state, { ownerSurveyId: 'survey-1', type: 'responsesStart' })
    state = surveyResultsReducer(state, { ownerSurveyId: 'survey-1', type: 'responsesSuccess', page: 0, responses: [], total: 0 })
    expect(state.responsesLoaded).toBe(true)
    expect(state.responsesError).toBe('')
  })

  it('keeps rows and displayed page canonical through pagination failure and retry', () => {
    const rows = [{ id: 'response-1' }] as SurveyResponse[]
    let state = surveyResultsReducer(emptySurveyResultsState('survey-1'), { ownerSurveyId: 'survey-1', type: 'responsesSuccess', page: 0, responses: rows, total: 75 })
    state = surveyResultsReducer(state, { ownerSurveyId: 'survey-1', type: 'responsesRequest', page: 1 })
    state = surveyResultsReducer(state, { ownerSurveyId: 'survey-1', type: 'responsesStart' })
    state = surveyResultsReducer(state, { ownerSurveyId: 'survey-1', type: 'responsesFailure', error: 'Retry this page' })
    state = surveyResultsReducer(state, { ownerSurveyId: 'survey-1', type: 'responsesFinish' })
    expect(state.responses).toBe(rows)
    expect(state.responsePage).toBe(0)
    expect(state.requestedResponsePage).toBe(1)
    state = surveyResultsReducer(state, { ownerSurveyId: 'survey-1', type: 'responsesStart' })
    state = surveyResultsReducer(state, { ownerSurveyId: 'survey-1', type: 'responsesSuccess', page: 1, responses: [{ id: 'response-51' }] as SurveyResponse[], total: 75 })
    expect(state.responsePage).toBe(1)
    expect(state.responses[0].id).toBe('response-51')
    expect(state.responsesError).toBe('')
  })

  it('rejects responses owned by another survey or a stale requested page', () => {
    const state = surveyResultsReducer(emptySurveyResultsState('survey-2'), { ownerSurveyId: 'survey-2', type: 'responsesRequest', page: 2 })
    expect(surveyResultsReducer(state, { ownerSurveyId: 'survey-1', type: 'analyticsFailure', error: 'old' })).toBe(state)
    expect(surveyResultsReducer(state, { ownerSurveyId: 'survey-2', type: 'responsesSuccess', page: 0, responses: [], total: 1 })).toBe(state)
  })

  it('keeps response detail errors retryable and rejects completions after close or replacement', () => {
    let state = surveyResultsReducer(emptySurveyResultsState('survey-1'), { ownerSurveyId: 'survey-1', type: 'detailStart', responseId: 'response-1' })
    state = surveyResultsReducer(state, { ownerSurveyId: 'survey-1', type: 'detailFailure', responseId: 'response-1', error: 'Detail 403' })
    state = surveyResultsReducer(state, { ownerSurveyId: 'survey-1', type: 'detailFinish', responseId: 'response-1' })
    expect(state.responseDetailError).toBe('Detail 403')
    expect(state.loadingResponseDetail).toBe(false)
    state = surveyResultsReducer(state, { ownerSurveyId: 'survey-1', type: 'detailStart', responseId: 'response-2' })
    expect(state.responseDetailError).toBe('')
    const response = { id: 'response-1' } as SurveyResponse
    expect(surveyResultsReducer(state, { ownerSurveyId: 'survey-1', type: 'detailSuccess', responseId: 'response-1', response })).toBe(state)
    state = surveyResultsReducer(state, { ownerSurveyId: 'survey-1', type: 'detailClose' })
    expect(surveyResultsReducer(state, { ownerSurveyId: 'survey-1', type: 'detailSuccess', responseId: 'response-2', response })).toBe(state)
  })
})
