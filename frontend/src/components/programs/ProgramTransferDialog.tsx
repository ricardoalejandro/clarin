'use client'

import { useEffect, useId, useRef, useState, type ChangeEvent, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { ArrowRight, CheckCircle2, FileJson, Loader2, Search, Upload, X } from 'lucide-react'
import { api } from '@/lib/api'
import { getAuthScope, isAuthIdentityChanging } from '@/lib/authScope'
import { useDebouncedValue } from '@/lib/useDebouncedValue'
import { useAccessibleDialog } from '@/components/pipelines/useAccessibleDialog'
import { OPERATIONAL_OVERLAY_LAYERS } from '@/components/operational-overlay/operationalOverlayLayers'
import type { Program } from '@/types/program'
import {
  PROGRAM_TRANSFER_MAX_BYTES, canConfirmTransfer, normalizeTransferPreview, parseProgramTransferFile,
  programTransferChoices, programTransferField, programTransferKind, programTransferValue, transferError, transferInput,
  transferMapsEqual, validTransferSummary, type TransferConflict, type TransferPreview, type TransferResult, type TransferSummary,
} from './programTransfer'

const ghost = 'min-h-11 rounded-xl px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100 disabled:opacity-50'
const primary = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50'
const outline = 'min-h-11 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50'
type RequestFailure = { code?: string }
type Destination = Pick<Program, 'id' | 'name' | 'description'>

export function ProgramTransferDialog({ scope, inactive = false, onClose, onImported, returnFocusRef }: {
  scope: string
  inactive?: boolean
  onClose: () => void
  onImported: (result: TransferResult) => void
  returnFocusRef?: RefObject<HTMLElement | null>
}) {
  const id = useId()
  const opener = useRef<HTMLElement | null>(typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null)
  const panel = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const previewTitle = useRef<HTMLHeadingElement>(null)
  const successNotice = useRef<HTMLParagraphElement>(null)
  const discardStay = useRef<HTMLButtonElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const reader = useRef<FileReader | null>(null)
  const request = useRef<AbortController | null>(null)
  const pending = useRef<'preview' | 'confirm' | null>(null)
  const state = useRef({ inactive, scope })
  state.current = { inactive, scope }
  const [file, setFile] = useState<{ name: string; data: Record<string, unknown> } | null>(null)
  const [filePending, setFilePending] = useState(false)
  const [mode, setMode] = useState<'new' | 'existing'>('new')
  const [target, setTarget] = useState('')
  const [preview, setPreview] = useState<TransferPreview | null>(null)
  const [decisions, setDecisions] = useState<Record<string, string>>({})
  const [mappings, setMappings] = useState<Record<string, string>>({})
  const [previewMappings, setPreviewMappings] = useState<Record<string, string>>({})
  const [phase, setPhase] = useState<'preview' | 'confirm' | null>(null)
  const [error, setError] = useState('')
  const [result, setResult] = useState<TransferResult | null>(null)
  const [discardPrompt, setDiscardPrompt] = useState(false)
  const [destinations, setDestinations] = useState<Destination[]>([])
  const [catalogState, setCatalogState] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle')
  const [catalogRefresh, setCatalogRefresh] = useState(0)
  const [query, setQuery] = useState('')
  const [settledQuery, setSettledQuery] = useDebouncedValue(query)
  const [visibleDestinations, setVisibleDestinations] = useState(8)
  const [visibleConflicts, setVisibleConflicts] = useState(12)
  const queryPending = query !== settledQuery
  const destinationFilter = settledQuery.trim().toLocaleLowerCase('es')
  const filteredDestinations = destinations.filter(item => !destinationFilter || `${item.name} ${item.description || ''}`.toLocaleLowerCase('es').includes(destinationFilter))
  const targetLabel = destinations.find(item => item.id === target)?.name
  const ready = Boolean(file && !filePending && (mode === 'new' || (catalogState === 'loaded' && targetLabel)))
  const mappingChanged = !transferMapsEqual(mappings, previewMappings)
  const canPreview = ready && !phase && !inactive
  const canConfirm = canPreview && preview && !mappingChanged && canConfirmTransfer(preview, decisions)

  const validIdentity = () => state.current.scope === scope && scope === getAuthScope() && !isAuthIdentityChanging(scope)
  const validScope = () => !state.current.inactive && validIdentity()
  const clearRequest = () => {
    request.current?.abort()
    request.current = null
    pending.current = null
  }

  useEffect(() => () => {
    clearRequest()
    if (reader.current?.readyState === FileReader.LOADING) reader.current.abort()
    reader.current = null
  }, [scope])

  useEffect(() => {
    if (mode !== 'existing' || inactive || result || scope !== getAuthScope()) return
    const controller = new AbortController()
    setCatalogState('loading')
    void api<Program[]>('/api/programs?status=active', { signal: controller.signal, cache: 'no-store' }).then(response => {
      if (controller.signal.aborted || scope !== getAuthScope()) return
      if (!response.success || !Array.isArray(response.data)) {
        setDestinations([])
        setCatalogState('error')
        return
      }
      setDestinations(response.data.filter(item => item.type === 'course' && item.status === 'active')
        .sort((a, b) => a.name.localeCompare(b.name, 'es')))
      setCatalogState('loaded')
    })
    return () => controller.abort()
  }, [mode, scope, inactive, result, catalogRefresh])

  useEffect(() => {
    if (pending.current === 'preview' && inactive) {
      clearRequest()
      setPhase(null)
      setPreview(null)
    }
  }, [inactive])

  useEffect(() => {
    if (inactive || !preview) return
    previewTitle.current?.focus()
  }, [preview, inactive])

  useEffect(() => {
    if (inactive || !result) return
    successNotice.current?.focus()
  }, [result, inactive])

  useEffect(() => {
    if (discardPrompt && !inactive) discardStay.current?.focus()
  }, [discardPrompt, inactive])

  const close = () => {
    if (pending.current === 'confirm') return
    if (discardPrompt) { setDiscardPrompt(false); closeButton.current?.focus(); return }
    if (!result && file) { setDiscardPrompt(true); return }
    onClose()
  }
  useAccessibleDialog(!inactive, panel, close, fileInput)

  useEffect(() => () => {
    // Resuming after a responsive suspension starts another focus-trap
    // session. Closing the import must still return to its original trigger.
    queueMicrotask(() => {
      const element = returnFocusRef?.current || opener.current
      if (scope === getAuthScope() && element?.isConnected) element.focus({ preventScroll: true })
    })
  }, [scope, returnFocusRef])

  const resetPreview = () => {
    clearRequest()
    setPhase(null)
    setPreview(null)
    setDecisions({})
    setMappings({})
    setPreviewMappings({})
    setError('')
  }

  const chooseFile = (event: ChangeEvent<HTMLInputElement>) => {
    if (pending.current === 'confirm' || !validScope()) return
    const selected = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!selected) return
    resetPreview()
    if (reader.current?.readyState === FileReader.LOADING) reader.current.abort()
    reader.current = null
    setFile(null)
    setFilePending(false)
    if (selected.size > PROGRAM_TRANSFER_MAX_BYTES) { setError('El archivo supera el límite de 2 MB.'); return }
    if (!selected.size) { setError('El archivo está vacío. Selecciona el archivo exportado desde Programas.'); return }
    const next = new FileReader()
    reader.current = next
    setFilePending(true)
    next.onload = () => {
      if (reader.current !== next || !validIdentity()) return
      reader.current = null
      setFilePending(false)
      try { setFile({ name: selected.name, data: parseProgramTransferFile(String(next.result)) }) }
      catch (parseError) { setError(parseError instanceof Error ? parseError.message : 'No se pudo leer el archivo.') }
    }
    next.onerror = () => {
      if (reader.current !== next || !validIdentity()) return
      reader.current = null
      setFilePending(false)
      setError('No se pudo leer el archivo. Intenta seleccionarlo de nuevo.')
    }
    next.readAsText(selected)
  }

  const chooseMode = (next: 'new' | 'existing') => {
    if (mode === next || pending.current === 'confirm') return
    resetPreview()
    setMode(next)
    setTarget('')
    setQuery('')
    setSettledQuery('')
    setVisibleDestinations(8)
  }

  const review = async () => {
    if (!file || !canPreview || pending.current || !validScope()) return
    const controller = new AbortController()
    request.current = controller
    pending.current = 'preview'
    setPhase('preview')
    setError('')
    const plans = mappings
    const response = await api<TransferPreview & RequestFailure>('/api/programs/transfer/preview', {
      method: 'POST', body: JSON.stringify(transferInput(file.data, target, plans)), signal: controller.signal, cache: 'no-store',
    }).catch(() => ({ success: false, status: undefined, data: undefined, error: 'No se pudo conectar. Vuelve a intentarlo.' }))
    if (controller.signal.aborted || request.current !== controller || !validScope()) return
    clearRequest()
    setPhase(null)
    const canonical = normalizeTransferPreview(response.data)
    if (!response.success || !canonical) {
      setPreview(null)
      setError(transferError(response.status, response.data?.code, response.error || 'No pudimos obtener una vista previa válida. Vuelve a intentarlo.'))
      return
    }
    setPreviewMappings(plans)
    setDecisions({})
    setVisibleConflicts(12)
    setPreview(canonical)
  }

  const confirm = async () => {
    if (!file || !preview || !canConfirm || pending.current || !validScope()) return
    const controller = new AbortController()
    request.current = controller
    pending.current = 'confirm'
    setPhase('confirm')
    setError('')
    const response = await api<TransferResult & RequestFailure>('/api/programs/transfer/confirm', {
      method: 'POST',
      body: JSON.stringify({ ...transferInput(file.data, target, previewMappings), token: preview.token, decisions }),
      signal: controller.signal, cache: 'no-store',
    }).catch(() => ({ success: false, status: undefined, data: undefined, error: 'No se pudo confirmar la respuesta. Vuelve a revisar el archivo antes de reintentar.' }))
    if (controller.signal.aborted || request.current !== controller || scope !== getAuthScope() || state.current.scope !== scope) return
    clearRequest()
    setPhase(null)
    if (!response.success || typeof response.data?.program_id !== 'string' || !response.data.program_id || !validTransferSummary(response.data.summary)) {
      if (response.status === 409 || !response.status) { setPreview(null); setDecisions({}) }
      setError(transferError(response.status, response.data?.code, response.error || 'No se pudo confirmar el resultado. Revisa el archivo antes de reintentar.'))
      return
    }
    setFile(null)
    setPreview(null)
    setMappings({})
    setPreviewMappings({})
    setDecisions({})
    setResult(response.data)
    onImported(response.data)
  }

  const chooseConflict = (conflict: TransferConflict, value: string) => {
    if (pending.current || inactive) return
    if (conflict.mapping_key) setMappings(current => ({ ...current, [conflict.mapping_key!]: value }))
    else setDecisions(current => ({ ...current, [conflict.key]: value }))
    setError('')
  }

  if (typeof document === 'undefined') return null
  return createPortal(<div
    hidden={inactive} inert={inactive || undefined}
    style={{ zIndex: OPERATIONAL_OVERLAY_LAYERS.dialog, ...(inactive ? { display: 'none' } : {}) }}
    className="fixed inset-0 flex items-center justify-center bg-slate-950/45 p-0 backdrop-blur-[2px] sm:p-4">
    <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} tabIndex={-1}
      className="flex h-dvh w-full flex-col overflow-hidden bg-white shadow-2xl outline-none sm:h-auto sm:max-h-[calc(100dvh-2rem)] sm:max-w-2xl sm:rounded-3xl sm:border sm:border-white/80">
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-100 px-4 py-3 sm:px-5">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-1 rounded-xl bg-emerald-50 p-2 text-emerald-700"><Upload aria-hidden="true" className="h-5 w-5" /></span>
          <div>
            <h2 id={`${id}-title`} className="text-lg font-semibold text-slate-900">Importar programa</h2>
            <p id={`${id}-description`} className="text-sm text-slate-500">Revisa los cambios antes de traerlos a esta cuenta.</p>
          </div>
        </div>
        <button ref={closeButton} type="button" onClick={close} disabled={phase === 'confirm'} aria-label="Cerrar importación"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 disabled:opacity-50"><X className="h-5 w-5" /></button>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-5" aria-busy={phase !== null || filePending}>
        {result ? <>
          <p ref={successNotice} tabIndex={-1} role="status" className="flex items-start gap-2 rounded-xl bg-emerald-50 p-3 text-sm font-semibold text-emerald-800">
            <CheckCircle2 className="h-5 w-5 shrink-0" aria-hidden="true" /> Importación finalizada.
          </p>
          <Summary summary={result.summary} reviewed={false} />
        </> : <>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <label htmlFor={`${id}-file`} className="flex items-center gap-2 text-sm font-semibold text-slate-800">
              <FileJson className="h-4 w-4 text-emerald-700" aria-hidden="true" /> Archivo de programa
            </label>
            <input id={`${id}-file`} ref={fileInput} type="file" accept=".json,application/json" onChange={chooseFile} disabled={phase === 'confirm' || discardPrompt}
              aria-describedby={`${id}-file-help`} className="mt-2 block min-h-11 w-full min-w-0 text-sm text-slate-600 file:mr-3 file:min-h-11 file:rounded-lg file:border-0 file:bg-white file:px-3 file:text-sm file:font-semibold file:text-slate-700 hover:file:bg-slate-100" />
            <p id={`${id}-file-help`} className="mt-1 text-xs text-slate-500">Usa un archivo sin editar, exportado por esta instalación de Clarin (JSON, hasta 2 MB). Puede contener datos personales. No incluye encuestas, fotos ni adjuntos.</p>
            {filePending && <p role="status" className="mt-2 text-sm text-slate-600">Leyendo el archivo…</p>}
            {file && <p className="mt-2 break-all text-sm font-medium text-emerald-700">Seleccionado: {file.name}</p>}
          </div>

          <fieldset disabled={phase === 'confirm' || discardPrompt}>
            <legend className="mb-2 text-sm font-semibold text-slate-800">Destino en esta cuenta</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              <Option checked={mode === 'new'} name={`${id}-destination`} onChange={() => chooseMode('new')}>Crear programa</Option>
              <Option checked={mode === 'existing'} name={`${id}-destination`} onChange={() => chooseMode('existing')}>Fusionar con un programa</Option>
            </div>
            {mode === 'existing' && <div className="mt-2 rounded-xl border border-slate-200 p-3">
              {catalogState === 'loading' && <p role="status" className="text-sm text-slate-600">Cargando programas activos…</p>}
              {catalogState === 'error' && <div className="flex flex-wrap items-center gap-2"><p role="alert" className="text-sm text-rose-700">No pudimos cargar los programas de la cuenta.</p><button type="button" className={outline} onClick={() => setCatalogRefresh(value => value + 1)}>Reintentar</button></div>}
              {catalogState === 'loaded' && <>{destinations.length === 0 ? <p className="text-sm text-slate-600">No hay programas activos disponibles. Puedes crear uno nuevo.</p> : <>
                <div className="flex min-h-11 items-center gap-2 rounded-xl bg-slate-100 px-3">
                  <Search className="h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
                  <input type="search" aria-label="Buscar programa de destino" className="min-w-0 flex-1 bg-transparent py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                    placeholder="Buscar programa…" value={query} onChange={event => { const next = event.target.value; setQuery(next); if (!next) setSettledQuery(''); setVisibleDestinations(8) }} />
                  {queryPending && <Loader2 className="h-4 w-4 shrink-0 motion-safe:animate-spin text-emerald-700" aria-label="Esperando para buscar" />}
                </div>
                {targetLabel && <p className="mt-2 break-words text-xs font-semibold text-emerald-800">Destino: {targetLabel}</p>}
                <div className="mt-2 grid gap-1.5">
                  {filteredDestinations.slice(0, visibleDestinations).map(item => <Option key={item.id} checked={target === item.id} name={`${id}-program`} onChange={() => { if (target !== item.id) { resetPreview(); setTarget(item.id) } }}>{item.name}</Option>)}
                  {!filteredDestinations.length && <p role="status" className="px-1 py-2 text-sm text-slate-500">No hay coincidencias.</p>}
                  {filteredDestinations.length > visibleDestinations && <button type="button" onClick={() => setVisibleDestinations(value => value + 8)} className={ghost}>Ver más programas</button>}
                </div>
              </>}</>}
            </div>}
          </fieldset>

          {preview && <section className="space-y-3" aria-labelledby={`${id}-preview`}>
            <div>
              <h3 id={`${id}-preview`} ref={previewTitle} tabIndex={-1} className="break-words text-base font-semibold text-slate-900">Vista previa · {preview.program_name}</h3>
              <p className="mt-1 text-sm text-slate-500">{!target && preview.target_program_id ? 'Esta cuenta ya tiene un programa vinculado al archivo. La importación se aplicará a ese programa; no se creará otro.' : 'No se ha guardado ningún cambio en el programa.'}</p>
            </div>
            <Summary summary={preview.summary} reviewed />
            {preview.items.length > 0 && <details className="rounded-xl border border-slate-200">
              <summary className="min-h-11 cursor-pointer px-3 py-3 text-sm font-semibold text-slate-700">
                Ver registros nuevos y actualizados
              </summary>
              <ul className="space-y-1 border-t border-slate-100 px-3 py-2">
                {preview.items.map((item, index) => <li key={index} className="flex min-w-0 items-start justify-between gap-2 rounded-lg px-1 py-1.5">
                  <span className="min-w-0 break-words text-sm text-slate-800"><span className="font-medium">{programTransferKind(item.kind)}</span>{item.label ? ` · ${item.label}` : ''}</span>
                  <span className={`shrink-0 rounded-full px-2 py-1 text-xs font-medium ${item.action === 'create' ? 'bg-emerald-50 text-emerald-800' : 'bg-blue-50 text-blue-800'}`}>{item.action === 'create' ? 'Por crear' : 'Por actualizar'}</span>
                </li>)}
              </ul>
              {preview.summary.create + preview.summary.update > preview.items.length && <p className="px-3 pb-3 text-xs text-slate-500">Se muestran los primeros {preview.items.length} de {preview.summary.create + preview.summary.update} registros.</p>}
            </details>}
            {preview.conflicts.length > 0 && <p className="text-sm text-slate-600">Elige cómo resolver cada diferencia. Si cambias una coincidencia, actualiza la vista previa.</p>}
            {preview.conflicts.slice(0, visibleConflicts).map((conflict, index) => <fieldset key={conflict.key} disabled={phase !== null || discardPrompt}
              className="min-w-0 space-y-2 rounded-2xl border border-amber-200 bg-amber-50/45 p-3">
              <legend className="max-w-full break-words px-1 text-sm font-semibold text-amber-900">{conflict.label}{conflict.field ? ` · ${programTransferField(conflict.field)}` : ''}</legend>
              {(Object.hasOwn(conflict, 'local') || Object.hasOwn(conflict, 'incoming')) && <dl className="grid gap-2 sm:grid-cols-2">
                <div className="min-w-0 rounded-lg bg-white/85 p-2"><dt className="text-xs font-semibold text-slate-500">En esta cuenta</dt><dd className="whitespace-pre-wrap break-words text-sm text-slate-800">{programTransferValue(conflict.local, conflict.field)}</dd></div>
                <div className="min-w-0 rounded-lg bg-white/85 p-2"><dt className="text-xs font-semibold text-slate-500">En el archivo</dt><dd className="whitespace-pre-wrap break-words text-sm text-slate-800">{programTransferValue(conflict.incoming, conflict.field)}</dd></div>
              </dl>}
              <div className="grid gap-1.5 sm:grid-cols-2">{programTransferChoices(conflict).map(option => <Option key={option.value} name={`${id}-conflict-${index}`}
                checked={(conflict.mapping_key ? mappings[conflict.mapping_key] : decisions[conflict.key]) === option.value} onChange={() => chooseConflict(conflict, option.value)}>{option.label}</Option>)}</div>
              {!programTransferChoices(conflict).length && <p className="text-sm text-amber-800">No hay una coincidencia que se pueda confirmar. Revisa el programa de destino.</p>}
            </fieldset>)}
            {preview.conflicts.length > visibleConflicts && <button type="button" onClick={() => setVisibleConflicts(value => value + 12)} className={outline}>Ver más diferencias</button>}
          </section>}
        </>}
        {error && <p role="alert" className="break-words rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}
        {discardPrompt && <p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">¿Descartar el archivo y todas las decisiones sin aplicar?</p>}
      </div>

      <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-slate-100 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:px-5">
        {discardPrompt ? <>
          <button ref={discardStay} type="button" className={ghost} onClick={close}>Seguir revisando</button>
          <button type="button" className={outline} onClick={onClose}>Descartar importación</button>
        </> : result ? <>
          <button type="button" className={ghost} onClick={onClose}>Cerrar</button>
          <Link href={`/dashboard/programs/${encodeURIComponent(result.program_id)}`} className={primary}>Ver programa <ArrowRight className="h-4 w-4" aria-hidden="true" /></Link>
        </> : <>
          <button type="button" className={ghost} onClick={close} disabled={phase === 'confirm'}>Cancelar</button>
          {(!preview || mappingChanged || phase === 'preview') && <button type="button" className={primary} onClick={() => void review()} disabled={!canPreview}>
            {phase === 'preview' && <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />}
            {phase === 'preview' ? 'Preparando vista previa…' : preview ? 'Actualizar vista previa' : 'Generar vista previa'}
          </button>}
          {preview && !mappingChanged && phase !== 'preview' && <button type="button" className={primary} onClick={() => void confirm()} disabled={!canConfirm}>
            {phase === 'confirm' && <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />}
            {phase === 'confirm' ? 'Importando…' : 'Confirmar importación'}
          </button>}
        </>}
      </footer>
    </div>
  </div>, document.body)
}

function Option({ name, checked, onChange, children }: { name: string; checked: boolean; onChange: () => void; children: string }) {
  return <label className={`flex min-h-11 min-w-0 cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm focus-within:ring-2 focus-within:ring-emerald-500 ${checked ? 'border-emerald-300 bg-emerald-50 font-medium text-emerald-900' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'}`}>
    <input type="radio" name={name} checked={checked} onChange={onChange} className="shrink-0 accent-emerald-700" />
    <span className="min-w-0 break-words">{children}</span>
  </label>
}

function Summary({ summary, reviewed }: { summary: TransferSummary; reviewed: boolean }) {
  return <dl aria-label={reviewed ? 'Resumen de la vista previa' : 'Resultado de la importación'} className="grid grid-cols-2 gap-2 sm:grid-cols-4">
    {[
      [reviewed ? 'Por crear' : 'Creados', summary.create],
      [reviewed ? 'Por actualizar' : 'Actualizados', summary.update],
      ['Sin cambios', summary.unchanged],
      [reviewed ? 'Por revisar' : 'Conflictos', summary.conflicts],
    ].map(([label, count]) => <div key={label} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
      <dt className="text-xs font-medium text-slate-600">{label}</dt><dd className="text-lg font-semibold tabular-nums text-slate-900">{count}</dd>
    </div>)}
  </dl>
}
