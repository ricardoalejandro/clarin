'use client'

import { useRef } from 'react'
import { Loader2 } from 'lucide-react'

interface Props {
  id: string
  mode: 'manual' | 'automatic'
  inputValue: string
  canonicalManualValue: number
  effectiveProgress: number
  completed: boolean
  disabled?: boolean
  pending?: boolean
  error?: string
  subtaskDone?: number
  subtaskCount?: number
  onModeChange: (mode: 'manual' | 'automatic') => void
  onInputChange: (value: string) => void
  onCommit: () => void
  onReset: () => void
  onFocus?: () => void
}

export default function TaskProgressControl({ id, mode, inputValue, canonicalManualValue, effectiveProgress, completed, disabled = false, pending = false, error = '', subtaskDone = 0, subtaskCount = 0, onModeChange, onInputChange, onCommit, onReset, onFocus }: Props) {
  const skipBlurRef = useRef(false)
  const previewValue = /^\d+$/.test(inputValue.trim()) ? Math.min(100, Number(inputValue.trim())) : canonicalManualValue

  return <div className="text-xs font-semibold text-slate-500">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span>Progreso</span>
      <div className="flex rounded-xl bg-slate-100 p-1" role="group" aria-label="Fuente del progreso">
        {(['manual', 'automatic'] as const).map(nextMode => <button key={nextMode} type="button" disabled={disabled || pending || completed} aria-pressed={mode === nextMode} onClick={() => onModeChange(nextMode)} className={`rounded-lg px-3 py-1.5 text-[10px] font-black transition disabled:cursor-not-allowed disabled:opacity-50 ${mode === nextMode ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>{nextMode === 'manual' ? 'Manual' : 'Automático'}</button>)}
      </div>
    </div>

    {completed ? <div className="mt-3 rounded-2xl border border-emerald-200 bg-emerald-50/70 p-3">
      <div className="flex items-center justify-between gap-3"><span className="text-xs font-bold text-emerald-900">100% completado</span><span className="rounded-full bg-white px-2 py-1 text-[10px] font-bold text-emerald-700">Sólo lectura</span></div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white"><div className="h-full w-full rounded-full bg-emerald-500" /></div>
      <p className="mt-2 text-[10px] font-normal leading-4 text-slate-500">El estado completado fija el progreso efectivo. Al reabrir se conserva el último porcentaje manual.</p>
    </div> : mode === 'automatic' ? <div className="mt-3 rounded-2xl border border-emerald-200 bg-emerald-50/60 p-3">
      <div className="flex items-center justify-between"><span className="text-xs font-bold text-emerald-900">{effectiveProgress}% calculado</span><span className="text-[10px] text-emerald-700">{subtaskDone}/{subtaskCount} subtareas</span></div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white"><div className="h-full rounded-full bg-emerald-500 transition-[width] motion-reduce:transition-none" style={{ width: `${effectiveProgress}%` }} /></div>
      <p className="mt-2 text-[10px] font-normal leading-4 text-slate-500">Se calcula con subtareas reales. Sin subtareas: 0% abierta y 100% completada.</p>
    </div> : <div className={`mt-3 rounded-2xl border bg-slate-50/60 p-3 transition ${error ? 'border-rose-300 ring-2 ring-rose-100' : 'border-slate-200 focus-within:border-emerald-300 focus-within:ring-4 focus-within:ring-emerald-50'}`}>
      <div className="flex items-center gap-3">
        <label htmlFor={id} className="min-w-0 flex-1"><span className="block text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">Porcentaje manual</span><span className="mt-1 block text-xs font-normal text-slate-500">Escribe un valor entero entre 0 y 100.</span></label>
        <div className="flex min-h-11 w-28 shrink-0 items-center rounded-xl border border-slate-200 bg-white px-3 shadow-sm">
          <input id={id} aria-label="Porcentaje manual" aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined} type="number" min="0" max="100" step="1" inputMode="numeric" value={inputValue} disabled={disabled || pending} onFocus={onFocus} onChange={event => onInputChange(event.target.value)} onBlur={() => { if (skipBlurRef.current) { skipBlurRef.current = false; return }; onCommit() }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); skipBlurRef.current = true; onReset(); event.currentTarget.blur() } }} className="min-w-0 flex-1 appearance-none bg-transparent text-right text-base font-black text-emerald-700 outline-none disabled:opacity-50 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" />
          <span className="ml-1 text-sm font-bold text-slate-400">%</span>{pending && <Loader2 aria-label="Guardando progreso" className="ml-2 h-3.5 w-3.5 animate-spin text-emerald-600" />}
        </div>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-200" aria-hidden="true"><div className="h-full rounded-full bg-emerald-500 transition-[width] motion-reduce:transition-none" style={{ width: `${previewValue}%` }} /></div>
      {error && <p id={`${id}-error`} role="alert" className="mt-2 text-[10px] font-semibold text-rose-600">{error}</p>}
    </div>}
  </div>
}
