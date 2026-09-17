import { useEffect, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, Loader2, RefreshCw } from 'lucide-react'
import type { OfflineDataGateway } from '@/offline-v3/gateway'
import type { OfflineConflict, OfflineTask } from '@/offline-v3/types'
import { offlineTaskPriorityLabels } from '@/offline-v3/taskReadModel'

const reasons: Record<string, string> = {
  version_conflict: 'La tarea cambió en el servidor antes de recibir tu cambio.',
  stale_version: 'La tarea cambió en el servidor antes de recibir tu cambio.',
  action_denied: 'Ya no tienes permiso para realizar esta acción.',
  access_denied: 'Ya no tienes permiso para realizar esta acción.',
  outside_selection: 'La tarea ya no pertenece a la selección autorizada.',
  resource_not_found: 'La tarea ya no está disponible.',
  task_not_found: 'La tarea ya no está disponible.',
}

function TaskVersion({ label, value }: { label: string; value?: Partial<OfflineTask> }) {
  const category = value?.status_category || (value?.status === 'completed' ? 'done' : value?.status === 'cancelled' ? 'cancelled' : 'not_started')
  return <section className="offline-conflict-version"><h3>{label}</h3>{value ? <>
    <strong>{value.title || 'Tarea sin título'}</strong>
    {value.description && <p>{value.description}</p>}
    <dl><dt>Estado</dt><dd>{category === 'done' ? 'Completada' : category === 'cancelled' ? 'Cancelada' : category === 'active' ? 'En curso' : 'Pendiente'}</dd>
      {value.priority && <><dt>Prioridad</dt><dd>{offlineTaskPriorityLabels[value.priority] || 'Sin especificar'}</dd></>}
      {value.due_at && <><dt>Fecha límite</dt><dd>{Number.isFinite(Date.parse(value.due_at)) ? new Date(value.due_at).toLocaleDateString('es-PE') : 'Fecha no disponible'}</dd></>}
    </dl>
  </> : <p>El servidor no devolvió una versión consultable. Esto no significa que se haya eliminado la tarea.</p>}</section>
}

export default function OfflineConflictsView({ gateway, refreshToken = '' }: { gateway: OfflineDataGateway; refreshToken?: string }) {
  const [items, setItems] = useState<OfflineConflict[]>([])
  const [cursor, setCursor] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const generation = useRef(0)
  const previousGateway = useRef(gateway)
  const fetchPage = (after?: string) => gateway.conflicts ? gateway.conflicts(after) : Promise.reject(new Error('El motor necesita actualizarse para consultar estos cambios.'))

  useEffect(() => {
    const current = ++generation.current
    if (previousGateway.current !== gateway) { previousGateway.current = gateway; setItems([]); setCursor(undefined) }
    setLoading(true); setLoadingMore(false); setError('')
    void fetchPage().then(page => {
      if (generation.current !== current) return
      setItems(page.items); setCursor(page.next_cursor)
    }).catch(requestError => { if (generation.current === current) setError((requestError as Error).message) })
      .finally(() => { if (generation.current === current) setLoading(false) })
    return () => { generation.current++ }
  }, [gateway, refreshToken, retry])

  async function loadMore() {
    if (!cursor || loadingMore) return
    const current = generation.current
    setLoadingMore(true)
    try {
      const page = await fetchPage(cursor)
      if (generation.current !== current) return
      setItems(existing => [...existing, ...page.items.filter(item => !existing.some(previous => previous.operation_id === item.operation_id))]); setCursor(page.next_cursor)
    } catch (requestError) { if (generation.current === current) setError((requestError as Error).message) }
    finally { if (generation.current === current) setLoadingMore(false) }
  }

  return <section className="offline-module" aria-labelledby="offline-conflicts-title">
    <header className="offline-module__header"><div><p className="offline-eyebrow">Cambios conservados</p><h1 id="offline-conflicts-title">Cambios por revisar</h1><p>Se conserva la versión del servidor. Tu cambio no se ha borrado ni se volverá a enviar automáticamente.</p></div><button className="offline-button offline-button--secondary" onClick={() => setRetry(value => value + 1)} disabled={loading}><RefreshCw />Actualizar</button></header>
    {error && <div className="offline-alert offline-alert--error" role="alert"><AlertCircle />{error}</div>}
    {loading && items.length === 0 ? <div className="offline-loading"><Loader2 className="spin" />Abriendo cambios protegidos…</div> : !error && items.length === 0 ? <div className="offline-empty"><CheckCircle2 /><h2>No hay cambios por revisar</h2></div> : <div className="offline-conflicts">{items.map(item => <details className="offline-conflict" key={item.operation_id}>
      <summary><strong>{item.client_change.title || 'Cambio de tarea'}</strong><span>{item.status === 'conflict' ? 'Conflicto de versiones' : 'Cambio no aplicado'}</span></summary>
      <p>{reasons[item.error_code || ''] || 'El servidor no pudo aplicar este cambio con la autorización y versión recibidas.'}</p>
      <div className="offline-conflict-versions"><TaskVersion label="Tu cambio guardado" value={item.client_change} /><TaskVersion label="Versión del servidor" value={item.server_result?.task} /></div>
      <p className="offline-muted">Revisa este cambio con la misma cuenta al volver online. Esta pantalla es de solo lectura y no sobrescribe el servidor.</p>
    </details>)}</div>}
    {cursor && <button className="offline-button offline-button--secondary offline-load-more" disabled={loadingMore || loading} onClick={() => void loadMore()}>{loadingMore ? <Loader2 className="spin" /> : <RefreshCw />}Cargar más</button>}
  </section>
}
