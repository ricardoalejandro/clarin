'use client'

import { useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useAccessibleDialog } from '@/components/pipelines/useAccessibleDialog'
import { OPERATIONAL_OVERLAY_LAYERS } from '@/components/operational-overlay/operationalOverlayLayers'

export default function EventConfigurationConfirm({ title, children, confirmLabel, busy = false, onCancel, onConfirm, destructive = false }: {
  title: string; children: ReactNode; confirmLabel: string; busy?: boolean; onCancel: () => void; onConfirm: () => void; destructive?: boolean
}) {
  const panel = useRef<HTMLDivElement>(null), cancel = useRef<HTMLButtonElement>(null)
  useAccessibleDialog(true, panel, () => { if (!busy) onCancel() }, cancel)
  return createPortal(<div data-operational-confirmation className="fixed inset-0 flex items-center justify-center bg-slate-950/45 p-3 backdrop-blur-sm" style={{ zIndex: OPERATIONAL_OVERLAY_LAYERS.confirmation }}>
    <div ref={panel} role="alertdialog" aria-modal="true" aria-label={title} className="flex max-h-[calc(100dvh-24px)] w-full max-w-lg flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-2xl">
      <h3 className="px-5 pb-3 pt-5 text-lg font-semibold text-slate-900">{title}</h3>
      <div className="min-h-0 overflow-y-auto px-5 pb-5 text-sm leading-6 text-slate-600">{children}</div>
      <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-4"><button ref={cancel} type="button" disabled={busy} onClick={onCancel} className="min-h-11 rounded-xl px-4 text-sm font-semibold text-slate-600 hover:bg-white disabled:opacity-40">Cancelar</button><button type="button" disabled={busy} onClick={onConfirm} className={'min-h-11 rounded-xl px-4 text-sm font-semibold text-white disabled:opacity-50 ' + (destructive ? 'bg-rose-600 hover:bg-rose-700' : 'bg-emerald-600 hover:bg-emerald-700')}>{busy ? 'Guardando…' : confirmLabel}</button></div>
    </div>
  </div>, document.body)
}
