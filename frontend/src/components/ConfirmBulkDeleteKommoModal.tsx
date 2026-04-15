'use client'

import { useState, useEffect, useRef } from 'react'
import { AlertTriangle, X, Trash2, ExternalLink } from 'lucide-react'

export interface KommoLeadToDelete {
  id: string
  name: string
  phone: string
  kommo_id: number
}

interface ConfirmBulkDeleteKommoModalProps {
  isOpen: boolean
  onConfirm: () => void
  onCancel: () => void
  totalCount: number
  kommoLeads: KommoLeadToDelete[]
  loading?: boolean
}

export default function ConfirmBulkDeleteKommoModal({
  isOpen,
  onConfirm,
  onCancel,
  totalCount,
  kommoLeads,
  loading = false,
}: ConfirmBulkDeleteKommoModalProps) {
  const [confirmText, setConfirmText] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isOpen) {
      setConfirmText('')
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [isOpen, onCancel])

  if (!isOpen) return null

  const canConfirm = confirmText.toUpperCase() === 'ELIMINAR'
  const localOnlyCount = totalCount - kommoLeads.length

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center" onClick={onCancel}>
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      {/* Modal */}
      <div
        className="relative w-full max-w-lg mx-4 animate-in fade-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Red top accent bar */}
        <div className="h-1.5 bg-gradient-to-r from-red-500 via-red-600 to-red-700 rounded-t-xl" />

        <div className="bg-white rounded-b-xl shadow-2xl border border-red-200 max-h-[80vh] overflow-hidden flex flex-col">
          {/* Close button */}
          <button
            onClick={onCancel}
            className="absolute top-4 right-4 p-1 text-slate-400 hover:text-slate-600 transition-colors z-10"
          >
            <X className="w-5 h-5" />
          </button>

          {/* Icon + Title */}
          <div className="pt-6 px-6 flex-shrink-0">
            <div className="flex items-center gap-3 mb-4">
              <div className="flex-shrink-0 w-12 h-12 rounded-full bg-red-100 flex items-center justify-center">
                <AlertTriangle className="w-6 h-6 text-red-600" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-slate-900">Eliminación en lote</h3>
                <p className="text-sm text-red-600 font-medium">
                  {totalCount} lead(s) serán eliminados permanentemente
                </p>
              </div>
            </div>

            {/* Summary */}
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4">
              <div className="flex items-center justify-between text-sm">
                <span className="text-slate-700">Total a eliminar:</span>
                <span className="font-bold text-red-700">{totalCount} leads</span>
              </div>
              {kommoLeads.length > 0 && (
                <div className="flex items-center justify-between text-sm mt-1 pt-1 border-t border-red-200">
                  <span className="text-slate-700">Se moverán a PERDIDO en Kommo:</span>
                  <span className="font-bold text-red-700">{kommoLeads.length} leads</span>
                </div>
              )}
              {localOnlyCount > 0 && (
                <div className="flex items-center justify-between text-sm mt-1">
                  <span className="text-slate-500">Solo se borran de Clarin:</span>
                  <span className="font-medium text-slate-600">{localOnlyCount} leads</span>
                </div>
              )}
            </div>
          </div>

          {/* Kommo leads list (scrollable) */}
          {kommoLeads.length > 0 && (
            <div className="px-6 flex-1 overflow-auto min-h-0">
              <p className="text-xs font-semibold text-red-700 uppercase tracking-wide mb-2">
                Leads afectados en Kommo:
              </p>
              <div className="space-y-1 max-h-32 overflow-y-auto border border-red-100 rounded-lg p-2 bg-red-50/50">
                {kommoLeads.map((lead) => (
                  <div key={lead.id} className="flex items-center justify-between text-xs bg-white p-1.5 rounded border border-red-100">
                    <span className="font-medium text-slate-800 truncate max-w-[150px]">
                      {lead.name || lead.phone || 'Sin nombre'}
                    </span>
                    <span className="text-slate-500 flex items-center gap-1">
                      <ExternalLink className="w-3 h-3" />
                      #{lead.kommo_id}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Warning messages + confirm input */}
          <div className="px-6 pt-4 flex-shrink-0">
            {/* Warning messages */}
            <div className="space-y-2 mb-4">
              <div className="flex items-start gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-red-500 mt-2 flex-shrink-0" />
                <p className="text-sm text-slate-700">
                  {kommoLeads.length > 0 ? (
                    <>
                      {kommoLeads.length} lead(s) serán movidos a <span className="font-bold text-red-700">PERDIDO</span> en Kommo.
                    </>
                  ) : (
                    <>Todos los leads serán eliminados permanentemente de Clarin.</>
                  )}
                </p>
              </div>
              <div className="flex items-start gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-amber-500 mt-2 flex-shrink-0" />
                <p className="text-sm text-slate-700">
                  Los contactos de WhatsApp <span className="font-semibold text-slate-900">NO serán eliminados</span>.
                </p>
              </div>
              <div className="flex items-start gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-red-500 mt-2 flex-shrink-0" />
                <p className="text-sm text-slate-700">
                  Esta acción <span className="font-bold text-red-700">no se puede deshacer</span>.
                </p>
              </div>
            </div>

            {/* Confirmation input */}
            <div className="mb-6">
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                Escribe <span className="font-mono font-bold text-red-600 bg-red-50 px-1.5 py-0.5 rounded">ELIMINAR</span> para confirmar:
              </label>
              <input
                ref={inputRef}
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canConfirm && !loading) onConfirm()
                }}
                placeholder="ELIMINAR"
                className="w-full px-3 py-2 border-2 border-red-200 rounded-lg text-sm font-mono tracking-wider text-center focus:outline-none focus:border-red-400 focus:ring-2 focus:ring-red-100 transition-all placeholder:text-slate-300"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-3 px-6 pb-6 flex-shrink-0">
            <button
              onClick={onCancel}
              disabled={loading}
              className="flex-1 px-4 py-2.5 bg-white border border-slate-300 text-slate-700 rounded-lg text-sm font-medium hover:bg-slate-50 transition-colors disabled:opacity-50"
            >
              Cancelar
            </button>
            <button
              onClick={onConfirm}
              disabled={!canConfirm || loading}
              className={`flex-1 px-4 py-2.5 rounded-lg text-sm font-bold transition-all flex items-center justify-center gap-2 ${
                canConfirm && !loading
                  ? 'bg-red-600 text-white hover:bg-red-700 shadow-lg shadow-red-200'
                  : 'bg-slate-100 text-slate-400 cursor-not-allowed'
              }`}
            >
              {loading ? (
                <>
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  <span>Eliminando...</span>
                </>
              ) : (
                <>
                  <Trash2 className="w-4 h-4" />
                  <span>Eliminar {totalCount} leads</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
