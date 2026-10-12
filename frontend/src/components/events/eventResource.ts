import { api } from '@/lib/api'

export class EventResourceError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); this.name = 'EventResourceError' }
}
export function isEventResourceAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
}
export function eventResourceFailure(error: unknown): EventResourceError {
  return error instanceof EventResourceError ? error : new EventResourceError('No pudimos conectar con el servidor. Revisa tu conexión e inténtalo nuevamente.', true)
}
// Keep the same small Response contract for tests while production requests use
// the shared cookie session, serialized refresh and account-scope cancellation.
export const eventAPIRequest: typeof fetch = async (input, options) => {
  const headers = new Headers(options?.headers)
  headers.delete('Authorization')
  const response = await api<unknown>(String(input), { ...options, headers })
  if (options?.signal?.aborted || (!response.status && response.error === 'Solicitud cancelada')) throw new DOMException('Request aborted', 'AbortError')
  return new Response(JSON.stringify(response.data ?? { success: false, error: response.error }), {
    status: response.status ?? (response.success ? 200 : 503),
    headers: { 'Content-Type': 'application/json' },
  })
}
export async function loadEventResource<T extends { id: string }>(eventId: string, token: string, signal: AbortSignal, fetcher: typeof fetch = eventAPIRequest): Promise<T> {
  let response: Response
  try {
    response = await fetcher('/api/events/' + encodeURIComponent(eventId), { headers: { Authorization: 'Bearer ' + token }, signal })
  } catch (error) {
    if (signal.aborted || isEventResourceAbort(error)) throw error
    throw eventResourceFailure(error)
  }
  const body = await response.json().catch(() => null)
  if (signal.aborted) throw new DOMException('Request aborted', 'AbortError')
  if ([401, 403, 404].includes(response.status)) {
    throw new EventResourceError(response.status === 401 ? 'Tu sesión ya no permite consultar este evento. Vuelve a iniciar sesión.' : 'Este evento no está disponible o ya no tienes acceso a él.', false)
  }
  if (!response.ok || !body?.success || !body?.event || body.event.id !== eventId) {
    throw new EventResourceError('No se pudo cargar el evento. Vuelve a intentarlo.', true)
  }
  return body.event as T
}
