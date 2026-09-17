import { classifyRemoteResponse, type RemoteAvailability } from '@/offline-v3/availability'

export async function probeAvailabilityV4(signal?: AbortSignal): Promise<RemoteAvailability> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (signal?.aborted) controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  const timer = window.setTimeout(abort, 5_000)
  try {
    const response = await fetch('/api/offline/v4/runtime/availability', { cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal })
    const contentType = response.headers.get('content-type') || ''
    const body = contentType.includes('application/json') ? await response.json().catch(() => null) : null
    return classifyRemoteResponse(response.status, contentType, response.headers.get('X-Clarin-Response'), body)
  } catch { return { state: 'infrastructure_unavailable', code: 'network_unavailable' } }
  finally { window.clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}
