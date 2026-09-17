import { useEffect, useRef, useState } from 'react'
import { AlertCircle, ChevronRight, Eye, Loader2, Maximize, Minus, PenTool, Plus, RefreshCw } from 'lucide-react'
import type { OfflineDataGateway } from '@/offline-v3/gateway'
import type { OfflineWhiteboard } from '@/offline-v3/types'

function OfflineWhiteboardScene({ board }: { board: OfflineWhiteboard }) {
  const [url, setURL] = useState('')
  const [error, setError] = useState('')
  const [zoom, setZoom] = useState(1)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    let objectURL = ''
    setURL(''); setError(''); setZoom(1)
    void import('@/offline-v3/whiteboardRender').then(module => module.renderOfflineWhiteboard(board, controller.signal)).then(blob => {
      if (controller.signal.aborted) return
      objectURL = URL.createObjectURL(blob); setURL(objectURL)
    }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'No se pudo representar la pizarra.') })
    return () => { controller.abort(); if (objectURL) URL.revokeObjectURL(objectURL) }
  }, [board, attempt])
  if (error) return <div className="offline-alert offline-alert--error" role="alert"><AlertCircle /><span>{error}</span><button className="offline-button offline-button--secondary" onClick={() => setAttempt(current => current + 1)}>Reintentar</button></div>
  if (!url) return <div className="offline-loading" role="status"><Loader2 className="spin" />Preparando vista protegida…</div>
  return <div className="offline-whiteboard-reader">
    <div className="offline-whiteboard-reader__toolbar" aria-label="Vista de pizarra">
      <span><Eye size={16} />Solo lectura · revisión {board.scene_sequence || board.sequence || board.version}</span>
      <div><button className="offline-button offline-button--secondary" aria-label="Alejar pizarra" disabled={zoom <= 1} onClick={() => setZoom(current => Math.max(1, current - 1))}><Minus size={16} /></button><output aria-label="Ampliación">{zoom * 100}%</output><button className="offline-button offline-button--secondary" aria-label="Acercar pizarra" disabled={zoom >= 4} onClick={() => setZoom(current => Math.min(4, current + 1))}><Plus size={16} /></button><button className="offline-button offline-button--secondary" onClick={() => setZoom(1)}><Maximize size={16} />Ajustar</button></div>
    </div>
    <div className="offline-whiteboard-reader__viewport" tabIndex={0} role="region" aria-label={`Pizarra ${board.name}; desplázate para recorrer la imagen ampliada`}>
      <div className={`offline-whiteboard-reader__image offline-whiteboard-reader__image--${zoom}`}><img src={url} alt={`Vista de solo lectura de ${board.name}`} draggable={false} /></div>
    </div>
  </div>
}

export default function OfflineWhiteboardsView({ gateway, whiteboardId, navigate, refreshToken }: { gateway: OfflineDataGateway; whiteboardId?: string; navigate: (path: string) => void; refreshToken?: string }) {
  const [boards, setBoards] = useState<OfflineWhiteboard[]>([])
  const [board, setBoard] = useState<OfflineWhiteboard | null>(null)
  const [nextCursor, setNextCursor] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const generation = useRef(0)
  const scope = useRef({ gateway, whiteboardId })
  useEffect(() => {
    const changed = generation.current === 0 || scope.current.gateway !== gateway || scope.current.whiteboardId !== whiteboardId
    scope.current = { gateway, whiteboardId }
    const expected = ++generation.current
    if (changed) { setLoading(true); setBoard(null); setBoards([]); setNextCursor(undefined) }
    setError(''); setLoadingMore(false)
    const request = whiteboardId ? gateway.whiteboardScene(whiteboardId).then(result => result.item) : gateway.whiteboards()
    void request.then(result => {
      if (expected !== generation.current) return
      if (whiteboardId) { const next = result as OfflineWhiteboard; setBoard(current => current?.id === next.id && current.version === next.version && current.scene_sequence === next.scene_sequence && current.sequence === next.sequence ? current : next) }
      else { const page = result as Awaited<ReturnType<typeof gateway.whiteboards>>; setBoards(page.items); setNextCursor(page.next_cursor) }
    }).catch(cause => { if (expected === generation.current) { setBoard(null); setBoards([]); setError(cause instanceof Error ? cause.message : 'No se pudo cargar la pizarra.') } })
      .finally(() => { if (expected === generation.current) setLoading(false) })
    return () => { generation.current++ }
  }, [gateway, whiteboardId, attempt, refreshToken])
  async function loadMore() {
    if (!nextCursor || loadingMore) return
    const expected = generation.current; setLoadingMore(true)
    try {
      const page = await gateway.whiteboards(nextCursor)
      if (expected !== generation.current) return
      setBoards(current => [...current, ...page.items.filter(item => !current.some(existing => existing.id === item.id))]); setNextCursor(page.next_cursor)
    } catch (cause) { if (expected === generation.current) setError(cause instanceof Error ? cause.message : 'No se pudieron cargar más pizarras.') }
    finally { if (expected === generation.current) setLoadingMore(false) }
  }
  return <section className="offline-module" aria-labelledby="offline-whiteboards-title">
    {whiteboardId && <button className="offline-back" onClick={() => navigate('/dashboard/whiteboards')}>← Pizarras</button>}
    <header className="offline-module__header"><div><p className="offline-eyebrow">Pizarras · solo lectura</p><h1 id="offline-whiteboards-title">{board?.name || (whiteboardId ? 'Pizarra' : 'Pizarras disponibles')}</h1><p>{board?.description || 'Únicamente las escenas seleccionadas y sus imágenes descargadas.'}</p></div></header>
    {error && <div className="offline-alert offline-alert--error" role="alert"><AlertCircle /><span>{error}</span><button className="offline-button offline-button--secondary" onClick={() => setAttempt(current => current + 1)}>Reintentar</button></div>}
    {loading ? <div className="offline-loading"><Loader2 className="spin" />Descifrando copia protegida…</div> : whiteboardId ? (board && <OfflineWhiteboardScene key={`${board.id}:${board.version}`} board={board} />) : boards.length === 0 && !error ? <div className="offline-empty"><PenTool /><h2>No hay pizarras preparadas</h2><p>Las pizarras no descargadas no se muestran como vacías.</p></div> : <div className="offline-card-grid">{boards.map(item => <button className="offline-program-card" key={item.id} onClick={() => navigate(`/dashboard/whiteboards/${item.id}`)}><span className="offline-program-card__icon offline-program-card__icon--violet"><PenTool /></span><span><strong>{item.name}</strong><small>Actualizada {new Date(item.updated_at).toLocaleString('es-PE')}</small></span><ChevronRight /></button>)}</div>}
    {nextCursor && <button className="offline-button offline-button--secondary offline-load-more" disabled={loadingMore} onClick={() => void loadMore()}><RefreshCw className={loadingMore ? 'spin' : ''} />Cargar más</button>}
  </section>
}
