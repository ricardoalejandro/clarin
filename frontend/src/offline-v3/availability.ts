export type RemoteAvailability =
  | { state: 'available'; enabled: boolean; minimumClientVersion: string; signerReady: boolean }
  | { state: 'auth_denied'; code: string }
  | { state: 'infrastructure_unavailable'; code: string }

export function classifyRemoteResponse(
  status: number,
  contentType: string,
  clarinMarker: string | null,
  body: unknown,
): RemoteAvailability {
  const json = Boolean(contentType.toLowerCase().includes('application/json'))
  const trusted = clarinMarker === '1' && json
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : {}
  const code = typeof record.error === 'string' ? record.error : `http_${status}`

  // Any authentic Clarin 4xx is an application/security decision, including
  // throttling and malformed login attempts. Only an unmarked response (for
  // example Cloudflare HTML) may turn a 4xx into an offline availability offer.
  if (trusted && status >= 400 && status < 500) return { state: 'auth_denied', code }
  if (!trusted || status >= 500) return { state: 'infrastructure_unavailable', code }
  if (status >= 400) return { state: 'infrastructure_unavailable', code }
  return {
    state: 'available',
    enabled: record.enabled === true,
    minimumClientVersion: typeof record.minimum_client_version === 'string' ? record.minimum_client_version : '',
    signerReady: record.signer_ready === true,
  }
}

export async function probeRemoteAvailability(timeoutMs = 5_000): Promise<RemoteAvailability> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch('/api/offline/v3/runtime/availability', {
      cache: 'no-store',
      credentials: 'include',
      signal: controller.signal,
    })
    const contentType = response.headers.get('content-type') || ''
    const body = contentType.includes('application/json') ? await response.json().catch(() => null) : await response.text().catch(() => '')
    return classifyRemoteResponse(response.status, contentType, response.headers.get('X-Clarin-Response'), body)
  } catch {
    return { state: 'infrastructure_unavailable', code: 'network_unavailable' }
  } finally {
    window.clearTimeout(timer)
  }
}
