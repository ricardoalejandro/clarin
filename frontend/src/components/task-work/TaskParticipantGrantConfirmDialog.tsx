'use client'

import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, ShieldAlert, X } from 'lucide-react'
import { TASK_OVERLAY_LAYERS } from './taskOverlayLayers'

type AccountUser = { id: string; display_name?: string; username?: string }

export default function TaskParticipantGrantConfirmDialog({
  open,
  affectedUserIDs,
  users,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean
  affectedUserIDs: string[]
  users: AccountUser[]
  busy: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = requestAnimationFrame(() => dialogRef.current?.focus({ preventScroll: true }))
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab' || !dialogRef.current) return
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])'))
      if (!focusable.length) { event.preventDefault(); dialogRef.current.focus(); return }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', keydown)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('keydown', keydown)
      previous?.focus({ preventScroll: true })
    }
  }, [busy, onClose, open])

  if (!open || typeof document === 'undefined') return null
  const uniqueIDs = Array.from(new Set(affectedUserIDs.filter(Boolean)))
  const names = uniqueIDs.map(id => {
    const user = users.find(candidate => candidate.id === id)
    return user?.display_name || user?.username || 'Usuario de la cuenta'
  })
  return createPortal(<div className="fixed inset-0 flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-sm" style={{ zIndex: TASK_OVERLAY_LAYERS.confirmation }} onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <div ref={dialogRef} tabIndex={-1} role="alertdialog" aria-modal="true" aria-labelledby="participant-grant-title" className="w-full max-w-md rounded-3xl border border-white/70 bg-white p-5 shadow-2xl outline-none sm:p-6">
      <div className="flex items-start gap-3"><span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-amber-50 text-amber-700"><ShieldAlert className="h-5 w-5" /></span><div className="min-w-0 flex-1"><p className="text-[10px] font-black uppercase tracking-[.16em] text-amber-700">Acceso explícito</p><h2 id="participant-grant-title" className="mt-1 text-lg font-black text-slate-900">Confirmar acceso para participantes</h2></div><button type="button" disabled={busy} aria-label="Cerrar" onClick={onClose} className="rounded-xl p-2 text-slate-400 hover:bg-slate-100 disabled:opacity-40"><X className="h-4 w-4" /></button></div>
      <p className="mt-4 text-sm leading-6 text-slate-600">{uniqueIDs.length === 1 ? 'Esta persona' : `${uniqueIDs.length} personas`} no {uniqueIDs.length === 1 ? 'tiene' : 'tienen'} nivel Editar en este recurso. Al confirmar, la misma operación guardará la tarea y concederá acceso Editar explícito.</p>
      {names.length > 0 && <ul className="mt-3 max-h-36 space-y-1 overflow-y-auto rounded-2xl bg-slate-50 p-3">{names.map((name, index) => <li key={`${uniqueIDs[index]}:${index}`} className="truncate text-xs font-semibold text-slate-600">{name}</li>)}</ul>}
      <p className="mt-3 text-xs leading-5 text-slate-400">Quitar después a la persona como responsable o colaboradora no revocará este permiso silenciosamente; podrás administrarlo desde Acceso.</p>
      <div className="mt-5 flex justify-end gap-2"><button type="button" disabled={busy} onClick={onClose} className="min-h-11 rounded-xl px-4 text-sm font-bold text-slate-600 hover:bg-slate-100 disabled:opacity-40">Cancelar</button><button type="button" disabled={busy} onClick={onConfirm} className="inline-flex min-h-11 min-w-44 items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 text-sm font-black text-white hover:bg-slate-800 disabled:opacity-40">{busy && <Loader2 className="h-4 w-4 animate-spin" />}Conceder Editar y guardar</button></div>
    </div>
  </div>, document.body)
}
