import { describe, expect, it } from 'vitest'
import { surveyApplicationsURL } from './surveyApplications'

describe('surveyApplicationsURL', () => {
  it('builds the bounded first page without an empty query or cursor', () => {
    expect(surveyApplicationsURL('template id', {
      query: '  ', archiveState: 'current', status: 'all', originType: 'all',
    })).toBe('/api/survey-templates/template%20id/applications?archive_state=current&status=all&origin_type=all&limit=50')
  })

  it('encodes filters, search and the opaque cursor', () => {
    const url = surveyApplicationsURL('abc', {
      query: ' seguimiento final ', archiveState: 'archived', status: 'closed', originType: 'program', cursor: 'opaque+/=', limit: 100,
    })
    expect(url).toContain('query=seguimiento+final')
    expect(url).toContain('cursor=opaque%2B%2F%3D')
  })
})

