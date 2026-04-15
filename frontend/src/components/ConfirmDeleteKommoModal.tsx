'use client'

import { useState, useEffect, useRef } from 'react'
import { AlertTriangle, X, Trash2, ExternalLink } from 'lucide-react'

interface ConfirmDeleteKommoModalProps {
  isOpen: boolean
  onConfirm: () => void
  onCancel: () => void
  leadName: string
  kommoId: number
  loading?: boolean
}

export default function ConfirmDeleteKommoModal({
  isOpen,
  onConfirm,
  onCancel,
  leadName,
  kommoId,
  loading = false,
}: ConfirmDeleteKommoModalProps) {
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

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center" onClick={onCancel}>
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      {/* Modal */}
      <div
        className="relative w-full max-w-md mx-4 animate-in fade-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Red top accent bar */}
        <div className="h-1.5 bg-gradient-to-r from-red-500 via-red-600 to-red-700 rounded-t-xl" />

        <div className="bg-white rounded-b-xl shadow-2xl border border-red-200">
          {/* Close button */}
          <button
            onClick={onCancel}
            className="absolute top-4 right-4 p-1 text-slate-400 hover:text-slate-600 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>

          {/* Icon + Title */}
          <div className="pt-6 px-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="flex-shrink-0 w-12 h-12 rounded-full bg-red-100 flex items-center justify-center">
                <AlertTriangle className="w-6 h-6 text-red-600" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-slate-900">Eliminación permanente</h3>
                <p className="text-sm text-red-600 font-medium">Esta acción no tiene vuelta atrás</p>
              </div>
            </div>

            {/* Lead info */}
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4">
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium text-slate-700">Lead:</span>
                <span className="text-slate-900 font-semibold">{leadName}</span>
              </div>
              <div className="flex items-center gap-2 text-sm mt-1">
                <span className="font-medium text-slate-700">Kommo ID:</span>
                <span className="text-slate-900">#{kommoId}</span>
                <ExternalLink className="w-3 h-3 text-slate-400" />
              </div>
            </div>

            {/* Warning messages */}
            <div className="space-y-2 mb-4">
              <div className="flex items-start gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-red-500 mt-2 flex-shrink-0" />
                <p className="text-sm text-slate-700">
                  El lead será movido a <span className="font-bold text-red-700">PERDIDO</span> en Kommo y <span className="font-bold text-red-700">eliminado permanentemente</span> de Clarin.
                </p>
              </div>
              <div className="flex items-start gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-amber-500 mt-2 flex-shrink-0" />
                <p className="text-sm text-slate-700">
                  El contacto de WhatsApp <span className="font-semibold text-slate-900">NO será eliminado</span>.
                </p>
              </div>
              <div className="flex items-start gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-red-500 mt-2 flex-shrink-0" />
                <p className="text-sm text-slate-700">
                  Una vez eliminado, <span className="font-bold text-red-700">no se puede recuperar</span>. La próxima sincronización no lo restaurará.
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
          <div className="flex gap-3 px-6 pb-6">
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
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <Trash2 className="w-4 h-4" />
              )}
              {loading ? 'Eliminando...' : 'Eliminar permanentemente'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
