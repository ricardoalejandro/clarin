'use client'

import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Clock3, ExternalLink, Eye, FileText, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import { apiGet } from '@/lib/api'
import { getAuthScope } from '@/lib/authScope'
import OperationalWindowShell from '@/components/operational-window/OperationalWindowShell'
import { OPERATIONAL_OVERLAY_LAYERS } from '@/components/operational-overlay/operationalOverlayLayers'
import { StorageDialog } from './StorageDialog'
import { StorageReadQueue } from './storageReadQueue'
import { formatStorageBytes, ORIGIN_LABELS, reconcileStorageUses, safeStorageOriginHref, STORAGE_READ_TIMEOUT_MS, STORAGE_SELECTION_LIMIT, storageDate, storageUsesPath, type StorageFile, type StorageTarget, type StorageUse, type StorageUsesResponse } from './storageModel'

type StorageUsesRead = StorageUsesResponse & { code?: string; catalog_status?: string; retry_after_seconds?: number }

const control = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:cursor-not-allowed disabled:opacity-45'

const button = `${control} border border-slate-200 bg-white text-slate-700 hover:bg-slate-50`

export function StorageDetailsWindow({ file, scope, refresh, canManage, reviewBusy, onClose, onPreview, onReview, onUnavailable, onSelectionChange }: {
  file: StorageFile; scope: string; refresh: number; canManage: boolean; reviewBusy: boolean
  onClose: () => void; onPreview: () => void; onReview: (target: StorageTarget) => void; onUnavailable: () => void; onSelectionChange?: (hasSelection: boolean) => void
}) {
  const [response, setResponse] = useState<StorageUsesResponse | null>(null)
  const [responseIdentity, setResponseIdentity] = useState<string | null>(null)
  const [cursor, setCursor] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [selected, setSelected] = useState<Map<string, StorageUse>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [indexing, setIndexing] = useState<{ retryAt: number } | null>(null)
  const [clock, setClock] = useState(Date.now())
  const [retry, setRetry] = useState(0)
  const [discardOpen, setDiscardOpen] = useState(false)
  const requests = useRef<{ invalidate: (revision: number) => void; dispose: () => void } | null>(null)
  const pages = useRef(new Map<string, string[]>())
  const unavailable = useRef(onUnavailable)
  unavailable.current = onUnavailable
  const canSelect = canManage && response?.can_manage !== false && file.status === 'active'
  const viewIdentity = JSON.stringify([scope, file.object_key, cursor, canManage])
  const viewReady = response !== null && responseIdentity === viewIdentity
  const retryReady = !indexing || clock >= indexing.retryAt
  useEffect(() => {
    if (!indexing) return
    const timer = window.setTimeout(() => setClock(Date.now()), Math.max(0, indexing.retryAt - Date.now()))
    return () => window.clearTimeout(timer)
  }, [indexing])

  useEffect(() => { onSelectionChange?.(selected.size > 0) }, [selected.size, onSelectionChange])

  useEffect(() => {
    if (!canManage) setSelected(new Map())
  }, [canManage])

  useEffect(() => {
    const queue = new StorageReadQueue(refresh, {
      timeoutMs: STORAGE_READ_TIMEOUT_MS,
      read: signal => apiGet<StorageUsesRead>(storageUsesPath(file.object_key, cursor), { signal }),
      onStart: () => { setLoading(true); setError(''); setIndexing(null) },
      onResult: result => {
        if (getAuthScope() !== scope) return false
        if (!result.success || !result.data?.success || !Array.isArray(result.data.uses)) {
          setResponseIdentity(null)
          if (result.status === 503 && result.data?.code === 'storage_indexing_budget' && result.data.catalog_status === 'indexing') {
            const seconds = result.data.retry_after_seconds
            const delay = typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? Math.min(60, seconds) : 3
            const now = Date.now(); setClock(now); setIndexing({ retryAt: now + delay * 1000 }); setError('')
            return false
          }
          if (result.status === 401 || result.status === 403 || result.status === 404) {
            setResponse(null); setSelected(new Map()); unavailable.current(); return false
          }
          setError(result.error || result.data?.error || 'No se pudieron comprobar los usos de este archivo.'); return false
        }
        const data = result.data
        const previousIDs = pages.current.get(cursor) || []
        pages.current.set(cursor, data.uses.map(use => use.use_id))
        setResponse(data)
        setResponseIdentity(viewIdentity)
        setSelected(previous => {
          const next = reconcileStorageUses(previous, data.uses, canManage && data.can_manage !== false)
          const currentIDs = new Set(data.uses.map(use => use.use_id))
          for (const id of previousIDs) if (!currentIDs.has(id)) next.delete(id)
          return next
        })
        return true
      },
      onError: () => { if (getAuthScope() === scope) { setResponseIdentity(null); setError('No se pudieron cargar los usos. Revisa tu conexión e inténtalo de nuevo.') } },
      onSettled: () => { if (getAuthScope() === scope) setLoading(false) },
    })
    requests.current = queue
    queue.start()
    return () => { queue.dispose(); if (requests.current === queue) requests.current = null }
  }, [file.object_key, cursor, retry, scope, canManage])

  useEffect(() => { requests.current?.invalidate(refresh) }, [refresh])

  const close = () => { if (selected.size > 0) setDiscardOpen(true); else onClose() }
  const toggle = (use: StorageUse) => {
    if (!canSelect || !use.can_remove || !viewReady || error) return
    setSelected(previous => {
      const next = new Map(previous)
      if (next.has(use.use_id)) next.delete(use.use_id)
      else if (next.size < STORAGE_SELECTION_LIMIT) next.set(use.use_id, use)
      return next
    })
  }
  const review = () => {
    if (selected.size === 0 || !viewReady || error || reviewBusy || getAuthScope() !== scope) return
    onReview({ object_key: file.object_key, mode: 'uses', use_ids: Array.from(selected.keys()).sort() })
  }

  return <>
    <OperationalWindowShell open storageKey="clarin:storage-details" storageScope={scope} title={file.filename || 'Archivo'} eyebrow="Almacenamiento" description={`${formatStorageBytes(file.size_bytes)} · ${storageDate(file.last_modified)}`} icon={FileText} defaultMode="docked" dockedWidth={680} defaultWidth={820} minWidth={480} minHeight={460} overlayZIndex={OPERATIONAL_OVERLAY_LAYERS.window} temporaryOverlaySelector="[data-chat-overlay], [data-storage-dialog], [data-operational-picker-backdrop], [data-operational-confirmation]" onRequestClose={close} dataAttribute="storage-details-window" footer={<div className="flex flex-wrap items-center justify-between gap-2"><p role="status" className="text-xs text-slate-500">{selected.size ? `${selected.size} usos seleccionados de un máximo de ${STORAGE_SELECTION_LIMIT}` : 'Seleccionar un uso no modifica el archivo.'}</p><div className="flex flex-wrap gap-2"><button type="button" onClick={close} className={button}>Cerrar</button>{canManage && file.status === 'active' && <button type="button" onClick={review} disabled={!selected.size || !viewReady || !!error || reviewBusy} className={`${control} bg-emerald-600 text-white hover:bg-emerald-700`}>Revisar usos seleccionados<ArrowRight className="h-4 w-4" /></button>}</div></div>}>
      <div className="space-y-5 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-slate-50 p-3"><div className="min-w-0"><p className="text-sm font-medium text-slate-800">{file.is_own_upload && file.ownership_verified ? 'Carga tuya verificada' : 'Archivo compartido con sus ubicaciones'}</p><p className="mt-1 text-xs leading-5 text-slate-500">Un archivo puede utilizarse en varios lugares. Retirar un uso conserva los demás.</p></div><button type="button" onClick={onPreview} className={button}><Eye className="h-4 w-4" />Vista previa</button></div>
        <section aria-label="Usos del archivo"><div className="flex items-center justify-between gap-3"><div><h3 className="text-sm font-semibold text-slate-900">Dónde se usa</h3><p className="mt-1 text-xs text-slate-500">Sólo aparecen las ubicaciones a las que tienes acceso.</p></div>{loading && response && <Loader2 aria-label="Actualizando usos" className="h-4 w-4 animate-spin text-emerald-600 motion-reduce:animate-none" />}</div>
          {indexing && <div role="status" className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><p className="flex items-center gap-2 font-medium"><Clock3 className="h-4 w-4 shrink-0" />Ubicaciones en actualización</p><p className="mt-2">Estamos preparando el catálogo de este archivo. Sus usos todavía no se han podido verificar.{response ? ' Se conserva la última información disponible y tu selección.' : ' Los usos aparecerán cuando termine la actualización.'}</p><button type="button" aria-label="Reintentar indexación" disabled={!retryReady} onClick={() => { if (retryReady) setRetry(value => value + 1) }} className={button+' mt-2'}><RefreshCw className="h-4 w-4" />Reintentar</button>{!retryReady && <p className="mt-2 text-xs">Podrás volver a intentarlo en unos segundos.</p>}</div>}
          {error && <div role="alert" className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800"><p>{error}</p><button type="button" onClick={() => setRetry(value => value + 1)} className={`${button} mt-2`}><RefreshCw className="h-4 w-4" />Reintentar</button></div>}
          {loading && !response ? <p role="status" className="flex items-center gap-2 py-8 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />Comprobando ubicaciones y permisos…</p> : response && response.uses.length === 0 && !indexing ? <p className="mt-3 rounded-xl border border-slate-200 p-4 text-sm leading-6 text-slate-600">{file.is_own_upload && file.ownership_verified ? 'Esta carga no tiene usos actuales. Puedes seleccionarla desde Archivos para revisar su traslado a la papelera.' : 'No hay usos disponibles para mostrar en esta página.'}</p> : <ul className="mt-3 divide-y divide-slate-100">{response?.uses.map(use => {
            const href = safeStorageOriginHref(use.href)
            return <li key={use.use_id} className="flex items-start gap-3 py-3">
              {canManage && file.status === 'active' && <label className="flex h-11 w-11 shrink-0 items-center justify-center"><input type="checkbox" aria-label={`Seleccionar uso: ${use.label}${use.context_label ? ` · ${use.context_label}` : ''}`} checked={selected.has(use.use_id)} onChange={() => toggle(use)} disabled={!canSelect || !use.can_remove || !viewReady || !!error || (!selected.has(use.use_id) && selected.size >= STORAGE_SELECTION_LIMIT)} className="h-4 w-4 accent-emerald-600 disabled:opacity-40" /></label>}
              <div className="min-w-0 flex-1"><p className="text-xs font-medium text-slate-500">{ORIGIN_LABELS[use.type] || 'Ubicación autorizada'}</p><p className="mt-1 break-words text-sm font-medium text-slate-800">{use.label}</p>{use.context_label && <p className="mt-1 break-words text-xs leading-5 text-slate-500">{use.context_label}</p>}{use.created_at && <p className="mt-1 text-xs text-slate-500">{storageDate(use.created_at)}</p>}{!use.can_remove && <p className="mt-2 flex items-start gap-1.5 text-xs leading-5 text-slate-500"><ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />{use.blocked_reason || 'Este uso debe conservarse.'}</p>}</div>
              {href && <a href={href} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-emerald-700 hover:bg-emerald-50" aria-label={`Abrir ${use.label}`}><ExternalLink className="h-4 w-4" /></a>}
            </li>
          })}</ul>}
          {(response?.retained_elsewhere || file.has_protected_uses || file.retained_elsewhere) && <p className="mt-3 flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-xs leading-5 text-amber-900"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />Hay otras referencias que deben conservarse. El archivo seguirá disponible donde todavía se utilice.</p>}
          {response && (history.length > 0 || response.has_more) && <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3"><span className="text-xs text-slate-500">Página {history.length + 1}{response.total == null ? '' : ` · ${response.total} usos autorizados`}</span><div className="flex gap-2"><button type="button" aria-label="Usos anteriores" disabled={!history.length || !viewReady || !!error} onClick={() => { setCursor(history[history.length - 1]); setHistory(previous => previous.slice(0, -1)) }} className={button}><ArrowLeft className="h-4 w-4" />Anterior</button><button type="button" aria-label="Usos siguientes" disabled={!response.has_more || !response.next_cursor || !viewReady || !!error} onClick={() => { setHistory(previous => [...previous, cursor]); setCursor(response.next_cursor || '') }} className={button}>Siguiente<ArrowRight className="h-4 w-4" /></button></div></div>}
        </section>
      </div>
    </OperationalWindowShell>
    {discardOpen && <StorageDialog title="Descartar selección de usos" description="Los usos seleccionados todavía no se han retirado." onClose={() => setDiscardOpen(false)} footer={<><button type="button" onClick={() => setDiscardOpen(false)} className={button}>Seguir revisando</button><button type="button" onClick={onClose} className={button}>Descartar selección</button></>}><p className="text-sm text-slate-600">Puedes seguir revisando este archivo o cerrar y descartar la selección.</p></StorageDialog>}
  </>
}
