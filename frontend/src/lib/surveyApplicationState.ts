import type { SurveyAnalytics, SurveyResponse } from '@/types/survey'

export type SurveyResultsState = {
  ownerSurveyId: string
  analytics: SurveyAnalytics | null
  responses: SurveyResponse[]
  responsesTotal: number
  loadingAnalytics: boolean
  loadingResponses: boolean
  analyticsError: string
  responsesError: string
  responsesLoaded: boolean
  selectedResponse: SurveyResponse | null
  responsePage: number
  requestedResponsePage: number
  responseDetailId: string | null
  loadingResponseDetail: boolean
  responseDetailError: string
}

export function emptySurveyResultsState(ownerSurveyId: string): SurveyResultsState {
  return { ownerSurveyId, analytics: null, responses: [], responsesTotal: 0,
    loadingAnalytics: false, loadingResponses: false, analyticsError: '', responsesError: '',
    responsesLoaded: false, selectedResponse: null, responsePage: 0, requestedResponsePage: 0,
    responseDetailId: null, loadingResponseDetail: false, responseDetailError: '' }
}

type ResultsAction = { ownerSurveyId: string } & (
  | { type: 'analyticsStart' }
  | { type: 'analyticsSuccess'; analytics: SurveyAnalytics | null }
  | { type: 'analyticsFailure'; error: string }
  | { type: 'analyticsFinish' }
  | { type: 'responsesRequest'; page: number }
  | { type: 'responsesStart' }
  | { type: 'responsesSuccess'; page: number; responses: SurveyResponse[]; total: number }
  | { type: 'responsesFailure'; error: string }
  | { type: 'responsesFinish' }
  | { type: 'detailStart'; responseId: string }
  | { type: 'detailSuccess'; responseId: string; response: SurveyResponse }
  | { type: 'detailFailure'; responseId: string; error: string }
  | { type: 'detailFinish'; responseId: string }
  | { type: 'detailClose' }
)

// Keep the last successful page mounted until another canonical page arrives.
// Failures never become successful empty results or change the displayed range.
export function surveyResultsReducer(state: SurveyResultsState, action: ResultsAction): SurveyResultsState {
  if (state.ownerSurveyId !== action.ownerSurveyId) return state
  switch (action.type) {
    case 'analyticsStart': return { ...state, loadingAnalytics: true, analyticsError: '' }
    case 'analyticsSuccess': return { ...state, analytics: action.analytics }
    case 'analyticsFailure': return { ...state, analyticsError: action.error }
    case 'analyticsFinish': return { ...state, loadingAnalytics: false }
    case 'responsesRequest': return { ...state, requestedResponsePage: Math.max(0, action.page) }
    case 'responsesStart': return { ...state, loadingResponses: true, responsesError: '' }
    case 'responsesSuccess':
      if (state.requestedResponsePage !== action.page) return state
      return { ...state, responses: action.responses, responsesTotal: action.total,
        responsesLoaded: true, responsePage: action.page,
        selectedResponse: state.responsePage === action.page ? state.selectedResponse : null }
    case 'responsesFailure': return { ...state, responsesError: action.error }
    case 'responsesFinish': return { ...state, loadingResponses: false }
    case 'detailStart': return { ...state, responseDetailId: action.responseId,
      loadingResponseDetail: true, responseDetailError: '',
      selectedResponse: state.selectedResponse?.id === action.responseId ? state.selectedResponse : null }
    case 'detailSuccess':
      if (state.responseDetailId !== action.responseId) return state
      return { ...state, selectedResponse: action.response }
    case 'detailFailure':
      if (state.responseDetailId !== action.responseId) return state
      return { ...state, responseDetailError: action.error }
    case 'detailFinish':
      if (state.responseDetailId !== action.responseId) return state
      return { ...state, loadingResponseDetail: false }
    case 'detailClose': return { ...state, selectedResponse: null, responseDetailId: null,
      loadingResponseDetail: false, responseDetailError: '' }
  }
}

export async function changeSurveyApplicationStatus(
  request: () => Promise<{ success: boolean; error?: string }>,
  reconcile: () => Promise<void>,
): Promise<void> {
  const response = await request()
  if (!response.success) throw new Error(response.error || 'No se pudo cambiar el estado de la encuesta.')
  await reconcile()
}
