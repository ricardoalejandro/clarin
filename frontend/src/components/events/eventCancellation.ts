import { eventAPIRequest, loadEventResource } from './eventResource'

export interface CancellableEvent { id: string; status: string; updated_at?: string }
export function eventCancellationPayload(event: CancellableEvent) {
  if (event.status !== 'active' && event.status !== 'draft') throw new Error('Este evento ya está cerrado y conserva su historial.')
  if (!event.updated_at) throw new Error('No se pudo verificar la versión del evento. Actualiza el listado e inténtalo nuevamente.')
  return { status: 'cancelled', expected_updated_at: event.updated_at }
}
export async function cancelEventResource(event: CancellableEvent, token: string, fetcher: typeof fetch = eventAPIRequest) {
  const canonical = event.updated_at ? event : await loadEventResource<CancellableEvent>(event.id, token, new AbortController().signal, fetcher)
  const response = await fetcher('/api/events/' + encodeURIComponent(event.id), {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(eventCancellationPayload(canonical)),
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok || !result.success || !result.event) throw new Error(response.status === 409 ? 'El evento cambió en otra sesión. Actualiza el listado antes de cancelarlo.' : result.error || 'No se pudo cancelar el evento. Inténtalo nuevamente.')
  return result.event as CancellableEvent
}
