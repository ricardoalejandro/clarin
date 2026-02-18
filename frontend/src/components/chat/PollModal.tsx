'use client'

import { useState } from 'react'
import { X, BarChart3 } from 'lucide-react'

interface PollModalProps {
  onClose: () => void
  onSend: (question: string, options: string[], maxSelections: number) => void
}

export default function PollModal({ onClose, onSend }: PollModalProps) {
  const [question, setQuestion] = useState('')
  const [options, setOptions] = useState<string[]>(['', ''])
  const [maxSelections, setMaxSelections] = useState(1)

  const addOption = () => {
    if (options.length < 12) setOptions([...options, ''])
  }

  const removeOption = (idx: number) => {
    if (options.length > 2) setOptions(options.filter((_, i) => i !== idx))
  }

  const valid = question.trim() && options.filter(o => o.trim()).length >= 2

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl border border-slate-100">
        <div className="p-4 border-b border-slate-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-emerald-600" />
            <h3 className="text-sm font-semibold text-slate-900">Crear encuesta</h3>
          </div>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-600">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4 space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Pregunta</label>
            <input
              type="text"
              value={question}
              onChange={e => setQuestion(e.target.value)}
              placeholder="Escribe tu pregunta..."
              className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm text-slate-900 placeholder:text-slate-400 focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Opciones</label>
            <div className="space-y-2">
              {options.map((opt, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={opt}
                    onChange={e => {
                      const newOpts = [...options]
                      newOpts[i] = e.target.value
                      setOptions(newOpts)
                    }}
                    placeholder={`Opción ${i + 1}`}
                    className="flex-1 px-3 py-2 border border-slate-200 rounded-xl text-sm text-slate-900 placeholder:text-slate-400 focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
                  />
                  {options.length > 2 && (
                    <button onClick={() => removeOption(i)} className="p-1 text-slate-400 hover:text-red-500">
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
              ))}
            </div>
            {options.length < 12 && (
              <button
                onClick={addOption}
                className="mt-2 text-xs text-emerald-600 hover:text-emerald-700 font-medium"
              >
                + Agregar opción
              </button>
            )}
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Máx. selecciones permitidas
            </label>
            <select
              value={maxSelections}
              onChange={e => setMaxSelections(Number(e.target.value))}
              className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm text-slate-900 focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
            >
              {Array.from({ length: options.filter(o => o.trim()).length || 1 }, (_, i) => i + 1).map(n => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="p-4 border-t border-slate-100 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-xl text-sm"
          >
            Cancelar
          </button>
          <button
            onClick={() => {
              const validOpts = options.filter(o => o.trim()).map(o => o.trim())
              if (question.trim() && validOpts.length >= 2) {
                onSend(question.trim(), validOpts, Math.min(maxSelections, validOpts.length))
              }
            }}
            disabled={!valid}
            className="px-4 py-2 bg-emerald-600 text-white rounded-xl text-sm hover:bg-emerald-700 disabled:opacity-50 font-medium shadow-sm"
          >
            Enviar encuesta
          </button>
        </div>
      </div>
    </div>
  )
}
