'use client'

import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Archive, Loader2, Trash2, X } from 'lucide-react'
import { createPortal } from 'react-dom'

interface Props {
  open: boolean
  title: string
  description: string
  actionLabel: string
  confirmationName?: string
  permanent?: boolean
  busy?: boolean
  error?: string
  onClose: () => void
  onConfirm: () => void
}

export default function TaskDestructiveConfirmDialog({ open, title, description, actionLabel, confirmationName, permanent = false, busy = false, error, onClose, onConfirm }: Props) {
  const [value, setValue] = useState('')
  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    setValue('')
    const previous = document.activeElement as HTMLElement | null
    const frame = requestAnimationFrame(() => dialogRef.current?.focus())
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) { event.preventDefault(); onClose() }
    }
    window.addEventListener('keydown', keydown)
    return () => { cancelAnimationFrame(frame); window.removeEventListener('keydown', keydown); previous?.focus?.() }
  }, [busy, onClose, open])
  if (!open || typeof document === 'undefined') return null
  const exact = confirmationName === undefined || value === confirmationName
  const Icon = permanent ? Trash2 : Archive
  return createPortal(<div data-task-destructive-dialog className="fixed inset-0 z-[190] flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-sm" onMouseDown={event => event.target === event.currentTarget && !busy && onClose()}>
    <div ref={dialogRef} tabIndex={-1} role="alertdialog" aria-modal="true" aria-labelledby="task-destructive-title" aria-describedby="task-destructive-description" className="w-full max-w-md overflow-hidden rounded-3xl border border-white/60 bg-white shadow-2xl outline-none">
      <div className="p-6">
        <div className={`flex h-12 w-12 items-center justify-center rounded-2xl ${permanent ? 'bg-rose-50 text-rose-600' : 'bg-amber-50 text-amber-600'}`}><Icon className="h-5 w-5" /></div>
        <div className="mt-4 flex items-start gap-3"><div className="min-w-0 flex-1"><h2 id="task-destructive-title" className="text-lg font-black text-slate-900">{title}</h2><p id="task-destructive-description" className="mt-2 text-sm leading-6 text-slate-500">{description}</p></div><button type="button" aria-label="Cerrar" disabled={busy} onClick={onClose} className="-mt-1 rounded-xl p-2 text-slate-400 hover:bg-slate-100 disabled:opacity-40"><X className="h-4 w-4" /></button></div>
        {confirmationName !== undefined && <label className="mt-5 block text-xs font-bold text-slate-600">Escribe <strong className="text-slate-900">{confirmationName}</strong> para confirmar<input autoFocus value={value} onChange={event => setValue(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && exact && !busy) onConfirm() }} spellCheck={false} autoComplete="off" className="mt-2 w-full rounded-xl border border-slate-200 px-3.5 py-3 text-sm font-semibold text-slate-800 outline-none transition focus:border-rose-300 focus:ring-4 focus:ring-rose-100" /></label>}
        {error && <div role="alert" className="mt-4 flex gap-2 rounded-xl bg-rose-50 px-3 py-2.5 text-xs font-semibold text-rose-700"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{error}</div>}
      </div>
      <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50/80 px-6 py-4"><button type="button" disabled={busy} onClick={onClose} className="rounded-xl px-4 py-2.5 text-sm font-semibold text-slate-600 hover:bg-white disabled:opacity-40">Cancelar</button><button type="button" disabled={busy || !exact} onClick={onConfirm} className={`inline-flex min-w-36 items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold text-white shadow-lg transition disabled:cursor-not-allowed disabled:opacity-35 ${permanent ? 'bg-rose-600 shadow-rose-100 hover:bg-rose-700' : 'bg-slate-900 shadow-slate-200 hover:bg-amber-700'}`}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}{actionLabel}</button></div>
    </div>
  </div>, document.body)
}
