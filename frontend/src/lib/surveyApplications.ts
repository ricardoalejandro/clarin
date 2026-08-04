export type SurveyApplicationArchiveState = 'current' | 'archived'
export type SurveyApplicationStatus = 'all' | 'draft' | 'active' | 'closed'
export type SurveyApplicationOrigin = 'all' | 'standalone' | 'program'

export interface SurveyApplicationQuery {
  query: string
  archiveState: SurveyApplicationArchiveState
  status: SurveyApplicationStatus
  originType: SurveyApplicationOrigin
  cursor?: string
  limit?: number
}

export function surveyApplicationsURL(templateId: string, options: SurveyApplicationQuery): string {
  const params = new URLSearchParams({
    archive_state: options.archiveState,
    status: options.status,
    origin_type: options.originType,
    limit: String(options.limit || 50),
  })
  const query = options.query.trim()
  if (query) params.set('query', query)
  if (options.cursor) params.set('cursor', options.cursor)
  return `/api/survey-templates/${encodeURIComponent(templateId)}/applications?${params.toString()}`
}

