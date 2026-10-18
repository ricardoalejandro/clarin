'use client'

import { Contrast, FlipHorizontal2, FlipVertical2, Loader2, RefreshCw, RotateCw, SlidersHorizontal, Undo2 } from 'lucide-react'
import { initialAvatarTransform, type AvatarImageTransform } from '@/lib/avatarImageEditor'

interface Props {
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  transform: AvatarImageTransform
  loading: boolean
  dragging: boolean
  canUndo: boolean
  shape?: 'circle' | 'square'
  disabled?: boolean
  onPointerDown: React.PointerEventHandler<HTMLCanvasElement>
  onPointerMove: React.PointerEventHandler<HTMLCanvasElement>
  onPointerEnd: () => void
  onRemember: () => void
  onChange: (patch: Partial<AvatarImageTransform>) => void
  onCommitTransform: (value: AvatarImageTransform) => void
  onUndo: () => void
}

/** Shared crop controls; ownership, loading, persistence and permission remain with the caller. */
export default function AvatarImageEditor({ canvasRef, transform, loading, dragging, canUndo, shape = 'circle', disabled = false, onPointerDown, onPointerMove, onPointerEnd, onRemember, onChange, onCommitTransform, onUndo }: Props) {
  return <div className="grid gap-6 md:grid-cols-[minmax(280px,1fr)_250px]">
    <div className="mx-auto w-full max-w-[480px]">
      <div className="relative aspect-square overflow-hidden rounded-2xl bg-slate-200 shadow-inner">
        <canvas ref={canvasRef} width={512} height={512} aria-label="Vista previa del recorte de foto"
          onPointerDown={disabled ? undefined : onPointerDown} onPointerMove={disabled ? undefined : onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}
          className={`h-full w-full touch-none ${disabled ? '' : dragging ? 'cursor-grabbing' : 'cursor-grab'}`} />
        {loading && <div role="status" className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 bg-slate-200 text-sm text-slate-600"><Loader2 className="h-5 w-5 animate-spin" /> Preparando imagen…</div>}
        {shape === 'circle' && <div className="pointer-events-none absolute inset-[7%] rounded-full border-2 border-white/90 shadow-[0_0_0_999px_rgba(15,23,42,0.32)]" />}
      </div>
      <p className="mt-2 text-center text-xs text-slate-500">Arrastra para encuadrar. {shape === 'circle' ? 'La guía circular muestra cómo se verá en las listas.' : 'La vista cuadrada es la foto que se guardará.'}</p>
    </div>
    <fieldset disabled={disabled} className="min-w-0 space-y-4">
      <EditorSlider label="Zoom" value={transform.zoom} min={1} max={3} step={.05} onChangeStart={onRemember} onChange={zoom => onChange({ zoom })} />
      {shape === 'square' && <div className="grid grid-cols-2 gap-3"><EditorSlider label="Posición horizontal" value={transform.offsetX} min={-256} max={256} step={1} onChangeStart={onRemember} onChange={offsetX => onChange({ offsetX })} /><EditorSlider label="Posición vertical" value={transform.offsetY} min={-256} max={256} step={1} onChangeStart={onRemember} onChange={offsetY => onChange({ offsetY })} /></div>}
      <EditorSlider label="Brillo" value={transform.brightness} min={60} max={140} step={1} suffix="%" icon={<SlidersHorizontal className="h-4 w-4" />} onChangeStart={onRemember} onChange={brightness => onChange({ brightness })} />
      <EditorSlider label="Contraste" value={transform.contrast} min={60} max={140} step={1} suffix="%" icon={<Contrast className="h-4 w-4" />} onChangeStart={onRemember} onChange={contrast => onChange({ contrast })} />
      <div><p className="mb-2 text-xs font-medium text-slate-600">Orientación</p><div className="grid grid-cols-3 gap-2">
        <EditorButton label="Girar" onClick={() => onCommitTransform({ ...transform, rotation: (transform.rotation + 90) % 360 })}><RotateCw className="h-4 w-4" /></EditorButton>
        <EditorButton label="Horizontal" onClick={() => onCommitTransform({ ...transform, flipX: !transform.flipX })}><FlipHorizontal2 className="h-4 w-4" /></EditorButton>
        <EditorButton label="Vertical" onClick={() => onCommitTransform({ ...transform, flipY: !transform.flipY })}><FlipVertical2 className="h-4 w-4" /></EditorButton>
      </div></div>
      <div className="grid grid-cols-2 gap-2 border-t border-slate-100 pt-4">
        <EditorButton label="Deshacer" disabled={!canUndo} onClick={onUndo}><Undo2 className="h-4 w-4" /></EditorButton>
        <EditorButton label="Restablecer" onClick={() => onCommitTransform(initialAvatarTransform)}><RefreshCw className="h-4 w-4" /></EditorButton>
      </div>
    </fieldset>
  </div>
}

function EditorSlider({ label, value, min, max, step, suffix = '', icon, onChangeStart, onChange }: { label: string; value: number; min: number; max: number; step: number; suffix?: string; icon?: React.ReactNode; onChangeStart: () => void; onChange: (value: number) => void }) {
  return <label className="block"><span className="mb-1.5 flex items-center justify-between text-xs font-medium text-slate-600"><span className="flex items-center gap-1.5">{icon}{label}</span><span className="tabular-nums text-slate-400">{Math.round(value * 100) / 100}{suffix}</span></span>
    <input type="range" aria-label={label} value={value} min={min} max={max} step={step} onPointerDown={onChangeStart}
      onKeyDown={event => { if (!event.repeat && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) onChangeStart() }}
      onChange={event => onChange(Number(event.target.value))} className="h-2 w-full cursor-pointer accent-emerald-600" />
  </label>
}

function EditorButton({ label, disabled = false, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" disabled={disabled} onClick={onClick} className="flex min-h-11 flex-col items-center justify-center gap-1 rounded-xl border border-slate-200 bg-white px-2 text-[10px] font-medium text-slate-600 hover:border-emerald-300 hover:bg-emerald-50 disabled:opacity-35">{children}{label}</button>
}
