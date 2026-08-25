'use client'

import { useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Eye, Loader2, Phone, X } from 'lucide-react'
import type { Chat } from '@/types/chat'
import {
  deviceDisplayPhone,
  relationClassName,
  relationLabel,
  type WhatsAppDeviceOption,
} from '@/lib/whatsappChatLauncher'
import { useAccessibleDialog } from '@/components/pipelines/useAccessibleDialog'
import {
  OPERATIONAL_OVERLAY_LAYERS,
  useOperationalOverlayRegistration,
  useOperationalOverlayTarget,
} from '@/components/operational-window/OperationalOverlayContext'

interface Props {
  open: boolean
  idPrefix: string
  phone: string
  devices: WhatsAppDeviceOption[]
  existingChat?: Chat | null
  historicalPhone?: string
  busy?: boolean
  onSelect: (device: WhatsAppDeviceOption) => void
  onOpenHistorical?: () => void
  onCancel: () => void
}

export default function WhatsAppDevicePicker({
  open,
  idPrefix,
  phone,
  devices,
  existingChat,
  historicalPhone,
  busy = false,
  onSelect,
  onOpenHistorical,
  onCancel,
}: Props) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const portalTarget = useOperationalOverlayTarget()
  useOperationalOverlayRegistration(open, `${idPrefix}-whatsapp-device-picker`)
  useAccessibleDialog(open, dialogRef, onCancel, cancelRef)

  const sortedDevices = useMemo(() => [...devices].sort((a, b) => {
    if (existingChat?.device_id === a.id || a.matches_historical) return -1
    if (existingChat?.device_id === b.id || b.matches_historical) return 1
    return (a.name || '').localeCompare(b.name || '', 'es')
  }), [devices, existingChat?.device_id])

  if (!open || typeof document === 'undefined') return null
  const target = portalTarget || document.body
  const titleId = `${idPrefix}-whatsapp-device-title`

  return createPortal(
    <div
      data-operational-picker-backdrop
      className="app-viewport pointer-events-auto fixed inset-0 flex items-end justify-center bg-slate-950/45 backdrop-blur-[2px] sm:items-center sm:p-4"
      style={{ zIndex: portalTarget ? OPERATIONAL_OVERLAY_LAYERS.dialog : 180 }}
      onMouseDown={event => {
        if (event.target === event.currentTarget && !busy) onCancel()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy}
        tabIndex={-1}
        className="flex max-h-[min(86dvh,var(--app-height,100dvh))] w-full max-w-md flex-col overflow-hidden rounded-t-3xl border border-white/80 bg-white p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-[0_28px_80px_rgba(15,23,42,0.32)] outline-none sm:rounded-3xl sm:p-6"
      >
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-700">
            <Phone className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-base font-bold text-slate-900">Elegir canal de WhatsApp</h2>
            <p className="mt-1 break-words text-xs leading-5 text-slate-500">Selecciona el dispositivo que enviará mensajes a {phone}.</p>
          </div>
          <button type="button" aria-label="Cerrar selección de dispositivo" disabled={busy} onClick={onCancel} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-40">
            <X className="h-5 w-5" />
          </button>
        </div>

        {existingChat && (
          <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-3.5 py-3 text-xs leading-5 text-amber-800">
            Existe historial{historicalPhone ? ` asociado al número ${historicalPhone}` : ' cuyo número anterior no pudo confirmarse'}.
          </div>
        )}

        <div className="mt-4 min-h-0 space-y-2 overflow-y-auto pr-1">
          {sortedDevices.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-200 px-4 py-8 text-center">
              <p className="text-sm font-semibold text-slate-700">No hay dispositivos conectados</p>
              <p className="mt-1 text-xs leading-5 text-slate-500">Conecta un dispositivo WhatsApp Web para continuar.</p>
            </div>
          ) : sortedDevices.map(device => {
            const ownsHistory = Boolean(device.matches_historical || existingChat?.device_id === device.id)
            return (
              <button
                key={device.id}
                type="button"
                disabled={busy}
                onClick={() => onSelect(device)}
                aria-label={`Usar ${device.name || 'dispositivo'}${deviceDisplayPhone(device) ? `, ${deviceDisplayPhone(device)}` : ''}`}
                className={`group flex min-h-16 w-full items-center gap-3 rounded-2xl border p-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:cursor-wait disabled:opacity-55 ${ownsHistory ? 'border-emerald-200 bg-emerald-50/70 hover:bg-emerald-50' : 'border-slate-200 bg-white hover:border-emerald-200 hover:bg-emerald-50/50'}`}
              >
                <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl ${ownsHistory ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600 group-hover:bg-emerald-100 group-hover:text-emerald-700'}`}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Phone className="h-4 w-4" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-sm font-semibold text-slate-900">{device.name || 'Dispositivo'}</span>
                    {ownsHistory && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">Historial actual</span>}
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${relationClassName(device)}`}>{relationLabel(device)}</span>
                  </span>
                  <span className="mt-1 block truncate text-xs text-slate-500">{deviceDisplayPhone(device) || 'Número no disponible'}</span>
                </span>
              </button>
            )
          })}
        </div>

        {existingChat && onOpenHistorical && (
          <button type="button" disabled={busy} onClick={onOpenHistorical} className="mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-4 text-sm font-semibold text-amber-800 transition hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:opacity-50">
            <Eye className="h-4 w-4" /> Ver historial en solo lectura
          </button>
        )}
        <button ref={cancelRef} type="button" disabled={busy} onClick={onCancel} className="mt-3 min-h-11 w-full rounded-2xl border border-slate-200 px-4 text-sm font-semibold text-slate-600 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-50">
          Cancelar
        </button>
      </div>
    </div>,
    target,
  )
}
