import { describe, expect, it } from 'vitest'
import { classifyRemoteResponse } from './availability'

describe('offline infrastructure classification', () => {
  it('never converts a trusted Clarin auth denial into an infrastructure outage', () => {
    expect(classifyRemoteResponse(401, 'application/json', '1', { error: 'invalid_credentials' })).toEqual({ state: 'auth_denied', code: 'invalid_credentials' })
    expect(classifyRemoteResponse(403, 'application/json; charset=utf-8', '1', { error: 'account_denied' })).toEqual({ state: 'auth_denied', code: 'account_denied' })
    expect(classifyRemoteResponse(429, 'application/json', '1', { error: 'login_throttled' })).toEqual({ state: 'auth_denied', code: 'login_throttled' })
    expect(classifyRemoteResponse(400, 'application/json', '1', { error: 'invalid_request' })).toEqual({ state: 'auth_denied', code: 'invalid_request' })
  })

  it('recognizes Cloudflare HTML and upstream outages as infrastructure failures', () => {
    expect(classifyRemoteResponse(403, 'text/html', null, '<html>Cloudflare</html>')).toEqual({ state: 'infrastructure_unavailable', code: 'http_403' })
    expect(classifyRemoteResponse(200, 'application/json', null, { success: true })).toEqual({ state: 'infrastructure_unavailable', code: 'http_200' })
    expect(classifyRemoteResponse(522, 'text/html', null, '')).toEqual({ state: 'infrastructure_unavailable', code: 'http_522' })
    expect(classifyRemoteResponse(503, 'application/json', '1', { error: 'upstream_unavailable' })).toEqual({ state: 'infrastructure_unavailable', code: 'upstream_unavailable' })
  })

  it('reads only the public availability contract', () => {
    expect(classifyRemoteResponse(200, 'application/json', '1', {
      protocol_version: 3,
      enabled: true,
      minimum_client_version: '3.0.0',
      signer_ready: true,
    })).toEqual({ state: 'available', enabled: true, minimumClientVersion: '3.0.0', signerReady: true })
  })
})
