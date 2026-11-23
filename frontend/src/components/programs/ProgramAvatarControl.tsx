'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { Check, ImagePlus, Loader2, Trash2, X } from 'lucide-react'
import { api, apiUpload } from '@/lib/api'
import { getAuthScope, isAuthIdentityChanging, subscribeAuthScope } from '@/lib/authScope'
import { avatarCanvasDisplacement, drawAvatarImage, exportCompactAvatar, initialAvatarTransform, validateProgramAvatarFile, type AvatarImageTransform } from '@/lib/avatarImageEditor'
import AvatarImageEditor from '@/components/AvatarImageEditor'
import ZoomableImageSurface from '@/components/image-viewer/ZoomableImageSurface'
import { OPERATIONAL_OVERLAY_LAYERS, useOperationalOverlayPortal, useOperationalOverlayRegistration } from '@/components/operational-window/OperationalOverlayContext'
import { OPERATIONAL_OVERLAY_LAYERS as GLOBAL_OVERLAY_LAYERS } from '@/components/operational-overlay/operationalOverlayLayers'
import type { Program } from '@/types/program'
import { acquireProgramAvatarBlob, invalidateProgramAvatarBlob } from './programAvatarCache'

type AvatarProgram = Pick<Program, 'id' | 'name' | 'color' | 'avatar_url' | 'avatar_revision'>

function useProgramAvatarURL(program: AvatarProgram) {
  const scope = useSyncExternalStore(subscribeAuthScope, getAuthScope, () => 'server')
  const key = `${scope}:${program.id}:${program.avatar_revision ?? 0}:${Boolean(program.avatar_url)}`
  const [result, setResult] = useState({ key: '', url: '' })
  const [retry, setRetry] = useState(0)
  const [failed, setFailed] = useState('')
  useEffect(() => {
    let active = true
    let objectURL = ''
    let release: (() => void) | undefined
    setFailed('')
    if (program.avatar_url && !isAuthIdentityChanging(scope)) {
      const lease = acquireProgramAvatarBlob(scope, program.id, program.avatar_revision ?? 0)
      release = lease.release
      void lease.promise.then(response => {
        if (!active || getAuthScope() !== scope) return
        if (!response.success || !response.blob) { setFailed(key); return }
        objectURL = URL.createObjectURL(response.blob)
        setResult({ key, url: objectURL })
      })
    } else if (!program.avatar_url) invalidateProgramAvatarBlob(scope, program.id, program.avatar_revision ?? 0)
    return () => { active = false; release?.(); if (objectURL) URL.revokeObjectURL(objectURL) }
  }, [key, retry, program.id, program.avatar_url, program.avatar_revision, scope])
  return { url: result.key === key ? result.url : '', failed: failed === key, retry: () => { invalidateProgramAvatarBlob(scope, program.id, program.avatar_revision ?? 0); setRetry(value => value + 1) } }
}

export function ProgramAvatar({ program, className = 'h-12 w-12', interactive = false, suspended = false }: { program: AvatarProgram; className?: string; interactive?: boolean; suspended?: boolean }) {
  const { url, failed, retry } = useProgramAvatarURL(program)
  const [view, setView] = useState(false)
  const suspendedRef = useRef(suspended)
  suspendedRef.current = suspended
  const [imageFailed, setImageFailed] = useState('')
  const scope = useSyncExternalStore(subscribeAuthScope, getAuthScope, () => 'server')
  useEffect(() => setView(false), [program.id, scope])
  const color = /^#[0-9a-f]{6}$/i.test(program.color || '') ? program.color : '#10B981'
  const display = url && imageFailed !== url
    ? <img src={url} alt={`Foto de ${program.name}`} onError={() => setImageFailed(url)} className="h-full w-full rounded-[inherit] object-cover" />
    : <span aria-hidden="true" className="font-semibold uppercase">{program.name.trim()[0] || '?'}</span>
  const classes = `inline-flex shrink-0 items-center justify-center overflow-hidden rounded-2xl text-white ${className}`
  return <>
    {interactive && program.avatar_url ? <button type="button" disabled={suspended} aria-label={`Ver foto de ${program.name}`} onClick={event => { event.stopPropagation(); if (!suspendedRef.current) setView(true) }} className={`${classes} min-h-11 min-w-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2`} style={{ backgroundColor: color }}>{display}</button>
      : <span className={classes} style={{ backgroundColor: color }}>{display}</span>}
    {view && <PhotoDialog title="Foto del programa" subtitle={program.name} paused={suspended} onClose={() => setView(false)}>
      {url && imageFailed !== url ? <ZoomableImageSurface src={url} alt={`Foto de ${program.name}`} sourceKey={`${scope}:${program.id}:${program.avatar_revision ?? 0}:${url}`} active={!suspended && scope === getAuthScope() && !isAuthIdentityChanging(scope)} onError={() => setImageFailed(url)} className="h-[min(65vh,32rem)] w-full rounded-2xl bg-slate-950" imageClassName="rounded-2xl" />
        : failed || (Boolean(url) && imageFailed === url) ? <div role="alert" className="space-y-3 text-sm text-slate-600"><p>No se pudo cargar la foto.</p><button type="button" className="min-h-11 rounded-xl border px-4" onClick={() => { setImageFailed(''); retry() }}>Reintentar</button></div>
          : <p role="status" className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Cargando foto…</p>}
    </PhotoDialog>}
  </>
}

export interface ProgramAvatarControlProps {
  program: Program
  suspended?: boolean
  readOnly?: boolean
  onChange?: (program: Program) => void
  onDraftChange?: (dirty: boolean) => void
  onBusyChange?: (busy: boolean) => void
}

export default function ProgramAvatarControl({ program, suspended = false, readOnly = false, onChange, onDraftChange, onBusyChange }: ProgramAvatarControlProps) {
  const scope = useSyncExternalStore(subscribeAuthScope, getAuthScope, () => 'server')
  const identity = `${scope}:${program.id}`
  const live = useRef({ identity, suspended, readOnly })
  live.current = { identity, suspended, readOnly }
  const mounted = useRef(true)
  const [current, setCurrent] = useState(program)
  const currentRef = useRef(current)
  currentRef.current = current
  const [mode, setMode] = useState<'none' | 'editor' | 'remove'>('none')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState(false)
  const [expectedRevision, setExpectedRevision] = useState(program.avatar_revision ?? 0)
  const [loading, setLoading] = useState(false)
  const [editorImage, setEditorImage] = useState<HTMLImageElement | null>(null)
  const [transform, setTransform] = useState(initialAvatarTransform)
  const [history, setHistory] = useState<AvatarImageTransform[]>([])
  const [dragging, setDragging] = useState(false)
  const [discard, setDiscard] = useState(false)
  const canvas = useRef<HTMLCanvasElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const fileIdentity = useRef('')
  const resource = useRef<{ image: HTMLImageElement; url: string; timer: ReturnType<typeof setTimeout> } | null>(null)
  const generation = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const drag = useRef({ x: 0, y: 0, startX: 0, startY: 0 })
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const canManage = () => mounted.current && live.current.identity === identity && !live.current.suspended && !live.current.readOnly && scope === getAuthScope() && !isAuthIdentityChanging()
  const isCurrent = () => mounted.current && identity === live.current.identity && scope === getAuthScope() && !isAuthIdentityChanging()
  const setPending = (value: boolean) => { busyRef.current = value; setBusy(value) }
  const releaseResource = useCallback(() => {
    generation.current++
    const previous = resource.current
    resource.current = null
    if (previous) {
      clearTimeout(previous.timer); previous.image.onload = null; previous.image.onerror = null; previous.image.src = ''; URL.revokeObjectURL(previous.url)
    }
    if (canvas.current) canvas.current.width = canvas.current.width
  }, [])
  const resetEditor = () => { releaseResource(); setEditorImage(null); setLoading(false); setTransform(initialAvatarTransform); setHistory([]); setDragging(false); setDiscard(false) }
  const close = () => {
    if (busyRef.current) return
    if (editorImage || loading) { setDiscard(true); return }
    resetEditor(); setMode('none'); setError(''); setConflict(false)
  }
  useEffect(() => {
    mounted.current = true
    controller.current?.abort(); releaseResource()
    setCurrent(program); setMode('none'); setPending(false); setError(''); setConflict(false)
    setEditorImage(null); setLoading(false); setTransform(initialAvatarTransform); setHistory([]); setDiscard(false)
    return () => { mounted.current = false; controller.current?.abort(); releaseResource() }
    // Revision changes preserve the editor and its expected revision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, releaseResource])
  useEffect(() => { setCurrent(previous => (program.avatar_revision ?? 0) >= (previous.avatar_revision ?? 0) ? program : previous) }, [program])
  useEffect(() => { onDraftChange?.(Boolean(editorImage || loading)) }, [editorImage, loading, onDraftChange])
  useEffect(() => { onBusyChange?.(busy) }, [busy, onBusyChange])
  useEffect(() => { if (canvas.current && editorImage) drawAvatarImage(canvas.current, editorImage, transform) }, [editorImage, transform, mode, discard])

  const loadFile = async (file: File) => {
    if (!canManage() || busyRef.current || fileIdentity.current !== identity) return
    resetEditor(); setError(''); setConflict(false); setMode('editor'); setLoading(true)
    setExpectedRevision(current.avatar_revision ?? 0)
    const loadID = generation.current
    const loadCurrent = () => loadID === generation.current && isCurrent()
    try {
      await validateProgramAvatarFile(file)
      if (!loadCurrent()) return
      const url = URL.createObjectURL(file)
      const image = new Image()
      const fail = () => {
        if (!loadCurrent()) return
        releaseResource(); setEditorImage(null); setLoading(false); setError('No se pudo leer la imagen. Vuelve a seleccionarla.')
      }
      const timer = setTimeout(fail, 15000)
      resource.current = { image, url, timer }
      image.onload = () => {
        if (!loadCurrent()) return
        clearTimeout(timer)
        setEditorImage(image); setLoading(false)
      }
      image.onerror = fail
      image.src = url
    } catch (failure) {
      if (loadCurrent()) { setLoading(false); setError(failure instanceof Error ? failure.message : 'No se pudo leer la imagen.') }
    }
  }
  const publish = (next: Program) => {
    if ((next.avatar_revision ?? 0) < (currentRef.current.avatar_revision ?? 0)) return
    currentRef.current = next; setCurrent(next); onChangeRef.current?.(next)
  }
  const save = async () => {
    if (!canManage() || busyRef.current || !editorImage || !canvas.current || conflict) return
    setPending(true); setError('')
    const operation = new AbortController(); controller.current = operation
    try {
      const blob = await exportCompactAvatar(canvas.current, operation.signal)
      if (!isCurrent() || !canManage()) return
      const form = new FormData()
      form.append('file', blob, 'program-avatar.jpg'); form.append('expected_revision', String(expectedRevision))
      const result = await apiUpload<Program>(`/api/programs/${program.id}/avatar`, form, { signal: operation.signal })
      if (!isCurrent()) return
      if (!result.success || !result.data) { setConflict(result.status === 409); setError(result.status === 409 ? 'La foto cambió en otra ventana. Actualiza la versión antes de guardar tu recorte.' : result.error || 'No se pudo guardar la foto. Vuelve a intentarlo.'); return }
      publish(result.data); resetEditor(); setMode('none')
    } catch (failure) { if (isCurrent()) setError(failure instanceof Error ? failure.message : 'No se pudo preparar la imagen.') }
    finally { if (isCurrent()) setPending(false) }
  }
  const remove = async () => {
    if (!canManage() || busyRef.current || conflict) return
    setPending(true); setError('')
    const operation = new AbortController(); controller.current = operation
    try {
      const result = await api<Program>(`/api/programs/${program.id}/avatar`, { method: 'DELETE', body: JSON.stringify({ expected_revision: expectedRevision }), signal: operation.signal })
      if (!isCurrent()) return
      if (!result.success || !result.data) { setConflict(result.status === 409); setError(result.status === 409 ? 'La foto cambió en otra ventana. Revisa la versión actual antes de quitarla.' : result.error || 'No se pudo quitar la foto.'); return }
      publish(result.data); setMode('none')
    } catch { if (isCurrent()) setError('No se pudo quitar la foto. Vuelve a intentarlo.')
    } finally { if (isCurrent()) setPending(false) }
  }
  const refreshRevision = async () => {
    if (!canManage() || busyRef.current) return
    setPending(true)
    const operation = new AbortController(); controller.current = operation
    try {
      const result = await api<Program>(`/api/programs/${program.id}`, { signal: operation.signal })
      if (!isCurrent() || !canManage()) return
      if (!result.success || !result.data) { setError(result.error || 'No se pudo actualizar la versión. Vuelve a intentarlo.'); return }
      publish(result.data); setExpectedRevision(result.data.avatar_revision ?? 0); setConflict(false); setError('')
    } catch { if (isCurrent()) setError('No se pudo actualizar la versión. Vuelve a intentarlo.')
    } finally { if (isCurrent()) setPending(false) }
  }
  const remember = () => { if (canManage() && !busyRef.current) setHistory(previous => [...previous.slice(-9), transform]) }
  const commitTransform = (next: AvatarImageTransform) => { if (!canManage() || busyRef.current) return; remember(); setTransform(next) }
  const pickFile = () => { if (!canManage() || busyRef.current) return; fileIdentity.current = identity; fileInput.current?.click() }
  const paused = suspended || readOnly
  return <div className="flex flex-wrap items-center gap-3" data-program-avatar-control>
    <ProgramAvatar program={current} className="h-16 w-16 text-xl" interactive suspended={suspended} />
    <div className="min-w-0 flex-1"><p className="text-sm font-medium text-slate-800">Foto del programa</p>
      {!paused && <><p className="mt-0.5 text-xs text-slate-500">JPEG o PNG · hasta 20 MiB. La foto se guarda por separado.</p><div className="mt-1 flex flex-wrap gap-1">
        <button type="button" disabled={busy} onClick={pickFile} className="inline-flex min-h-11 items-center gap-1.5 rounded-xl px-3 text-sm font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"><ImagePlus className="h-4 w-4" />{current.avatar_url ? 'Cambiar foto' : 'Subir foto'}</button>
        {current.avatar_url && <button type="button" disabled={busy} onClick={() => { if (!canManage() || busyRef.current) return; setExpectedRevision(current.avatar_revision ?? 0); setMode('remove'); setConflict(false); setError('') }} className="inline-flex min-h-11 items-center gap-1.5 rounded-xl px-3 text-sm text-slate-500 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-50"><Trash2 className="h-4 w-4" />Quitar</button>}
      </div></>}
    </div>
    <input ref={fileInput} type="file" accept="image/jpeg,image/png" aria-label="Seleccionar foto del programa" className="hidden" onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void loadFile(file) }} />
    {mode !== 'none' && <PhotoDialog title={discard ? '¿Descartar el recorte?' : mode === 'editor' ? 'Editar foto del programa' : 'Quitar foto del programa'} subtitle={program.name} paused={paused} busy={busy} onClose={discard ? () => setDiscard(false) : close} wide={mode === 'editor' && !discard}
      footer={<><button type="button" disabled={busy} onClick={discard ? () => setDiscard(false) : close} className="min-h-11 rounded-xl px-4 text-sm font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50">{discard ? 'Seguir editando' : 'Cancelar'}</button>
        {discard ? <button type="button" onClick={() => { if (!canManage() || busyRef.current) return; resetEditor(); setMode('none'); setError('') }} className="min-h-11 rounded-xl bg-rose-600 px-4 text-sm font-semibold text-white">Descartar</button>
          : conflict ? <button type="button" disabled={busy} onClick={() => void refreshRevision()} className="min-h-11 rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white disabled:opacity-50">Actualizar versión</button>
            : <button type="button" disabled={busy || (mode === 'editor' && !editorImage)} onClick={() => void (mode === 'editor' ? save() : remove())} className={`inline-flex min-h-11 items-center gap-2 rounded-xl px-4 text-sm font-semibold text-white disabled:opacity-50 ${mode === 'remove' ? 'bg-rose-600' : 'bg-emerald-600'}`}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{mode === 'editor' ? 'Guardar foto' : 'Quitar foto'}</button>}</>}
    >
      {error && !discard && <p role="alert" className="mb-4 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
      {discard ? <p className="text-sm text-slate-600">La foto actual seguirá igual. El recorte sin guardar se perderá.</p> : mode === 'remove' ? <div className="space-y-4"><ProgramAvatar program={current} className="h-20 w-20 text-2xl" /><p className="text-sm text-slate-600">Se quitará la foto del programa. Se mostrará su inicial y color.</p></div> : <>
        <AvatarImageEditor canvasRef={canvas} transform={transform} loading={loading} dragging={dragging} canUndo={history.length > 0} shape="square" disabled={busy || !editorImage}
          onRemember={remember} onChange={patch => { if (canManage() && !busyRef.current) setTransform(previous => ({ ...previous, ...patch })) }} onCommitTransform={commitTransform}
          onUndo={() => { if (!canManage() || busyRef.current || !history.length) return; setTransform(history[history.length - 1]); setHistory(previous => previous.slice(0, -1)) }}
          onPointerDown={event => { if (!canManage() || busyRef.current || !editorImage) return; event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, y: event.clientY, startX: transform.offsetX, startY: transform.offsetY }; remember(); setDragging(true) }}
          onPointerMove={event => { if (!canManage() || busyRef.current || !dragging) return; const delta = avatarCanvasDisplacement({ x: event.clientX - drag.current.x, y: event.clientY - drag.current.y }, event.currentTarget, event.currentTarget.getBoundingClientRect()); if (delta) setTransform(previous => ({ ...previous, offsetX: drag.current.startX + delta.x, offsetY: drag.current.startY + delta.y })) }} onPointerEnd={() => setDragging(false)} />
        {!loading && !editorImage && <button type="button" onClick={pickFile} className="mt-4 min-h-11 rounded-xl border px-4 text-sm">Elegir otra imagen</button>}
        <p className="mt-4 text-xs text-slate-500">Se guardará en 512 × 512 píxeles, optimizada a un máximo de 250 KiB.</p>
      </>}
    </PhotoDialog>}
  </div>
}

function PhotoDialog({ title, subtitle, children, footer, onClose, paused = false, busy = false, wide = false }: { title: string; subtitle: string; children: React.ReactNode; footer?: React.ReactNode; onClose: () => void; paused?: boolean; busy?: boolean; wide?: boolean }) {
  const contextPortal = useOperationalOverlayPortal()
  const target = contextPortal || (typeof document !== 'undefined' ? document.body : null)
  const panel = useRef<HTMLDivElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const suspendedFocus = useRef<HTMLElement | null>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const pausedRef = useRef(paused); pausedRef.current = paused
  useOperationalOverlayRegistration(!paused, 'program-avatar-dialog')
  useLayoutEffect(() => {
    if (paused && document.activeElement instanceof HTMLElement && panel.current?.contains(document.activeElement)) {
      suspendedFocus.current = document.activeElement; document.activeElement.blur()
      // Disabled controls can retain focus in some engines. Move it out of the
      // suspended dialog without making a hidden ancestor the new focus owner.
      if (document.activeElement === suspendedFocus.current) {
        const previous = document.body.getAttribute('tabindex')
        document.body.setAttribute('tabindex', '-1'); document.body.focus({ preventScroll: true })
        if (previous === null) document.body.removeAttribute('tabindex')
        else document.body.setAttribute('tabindex', previous)
      }
    }
  }, [paused])
  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    return () => { if (!pausedRef.current && previousFocus.current?.isConnected) previousFocus.current.focus({ preventScroll: true }) }
  }, [])
  useEffect(() => {
    if (paused) return
    const selector = 'button:not([disabled]), input:not([disabled]), [href], [tabindex="0"]'
    const focus = suspendedFocus.current
    if (focus?.isConnected && panel.current?.contains(focus)) focus.focus({ preventScroll: true })
    else panel.current?.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true })
    suspendedFocus.current = null
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); closeRef.current(); return }
      if (event.key !== 'Tab') return
      const controls = Array.from(panel.current?.querySelectorAll<HTMLElement>(selector) || [])
      const first = controls[0]; const last = controls[controls.length - 1]
      if (!first) { event.preventDefault(); panel.current?.focus(); return }
      if (!panel.current?.contains(document.activeElement)) { event.preventDefault(); first.focus() }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', keyboard, true)
    return () => document.removeEventListener('keydown', keyboard, true)
  }, [paused])
  if (!target) return null
  return createPortal(<div role="dialog" aria-modal="true" aria-label={title} data-program-avatar-dialog hidden={paused} inert={paused} style={{ display: paused ? 'none' : undefined, zIndex: contextPortal ? OPERATIONAL_OVERLAY_LAYERS.dialog : GLOBAL_OVERLAY_LAYERS.dialog }} className="pointer-events-auto fixed inset-0 flex items-center justify-center bg-slate-950/55 p-3 backdrop-blur-[2px]">
    <div ref={panel} tabIndex={-1} className={`flex max-h-[94dvh] w-full flex-col overflow-hidden rounded-3xl border border-white/70 bg-white shadow-2xl outline-none ${wide ? 'max-w-3xl' : 'max-w-lg'}`}>
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-200 px-5 py-3"><div className="min-w-0"><h3 className="font-semibold text-slate-900">{title}</h3><p className="truncate text-xs text-slate-500">{subtitle}</p></div><button type="button" aria-label="Cerrar foto" disabled={busy} onClick={onClose} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 disabled:opacity-40"><X className="h-5 w-5" /></button></header>
      <div className="min-h-0 overflow-y-auto p-5">{children}</div>
      {footer && <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-slate-200 px-5 py-3">{footer}</footer>}
    </div>
  </div>, target)
}
