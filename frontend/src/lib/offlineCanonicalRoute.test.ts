import { describe, expect, it } from 'vitest'
import { canonicalResourceID } from './offlineCanonicalRoute'

describe('canonicalResourceID', () => {
  const id = 'd9428888-122b-4d6f-9f57-f50758b42f11'

  it('preserves the normal Next dynamic route parameter', () => {
    expect(canonicalResourceID(id, 'programs', '/dashboard/programs/ignored')).toBe(id)
  })

  it('recovers the resource from a canonical URL served with a static shell', () => {
    expect(canonicalResourceID(undefined, 'programs', `/dashboard/programs/${id}`)).toBe(id)
    expect(canonicalResourceID(undefined, 'whiteboards', `/dashboard/whiteboards/${id}/`)).toBe(id)
  })

  it('rejects non-canonical and malformed paths', () => {
    expect(canonicalResourceID(undefined, 'programs', `/dashboard/contacts/${id}`)).toBe('')
    expect(canonicalResourceID(undefined, 'programs', '/dashboard/programs/not-an-id')).toBe('')
  })
})
