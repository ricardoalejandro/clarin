'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlignCenter, ArrowDown, ArrowUp, Brush, Check, Circle as CircleIcon,
  FlipHorizontal2, FlipVertical2, Link2, Loader2, Pause, Play, Redo2, RotateCw,
  Scissors, Square, Trash2, Type, Undo2, Volume2, VolumeX, X,
} from 'lucide-react'
import type { Canvas, FabricObject } from 'fabric'
import { useAccessibleDialog } from '@/components/pipelines/useAccessibleDialog'

export interface StatusVideoEdits {
  trim_start: number
  trim_end: number
  mute: boolean
}

export interface StatusMediaEditResult {
  media: File
  overlay?: File
  videoEdits?: StatusVideoEdits
  linkUrl?: string
}

interface StatusMediaEditorProps {
  open: boolean
  file: File | null
  kind: 'image' | 'video'
  onCancel: () => void
  onApply: (result: StatusMediaEditResult) => void
}

const CANVAS_WIDTH = 270
const CANVAS_HEIGHT = 480
const emojis = ['😀', '😍', '🥳', '🎓', '✨', '❤️', '🔥', '✅', '📚', '👏', '📍', '🔗']

const dataURLToBlob = (dataURL: string) => {
  const separator = dataURL.indexOf(',')
  if (separator < 0) throw new Error('El diseño generado no es válido.')
  const header = dataURL.slice(0, separator)
  const mime = /^data:([^;,]+);base64$/.exec(header)?.[1]
  if (!mime) throw new Error('El formato del diseño no es válido.')
  const binary = window.atob(dataURL.slice(separator + 1))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new Blob([bytes], { type: mime })
}

export default function StatusMediaEditor({ open, file, kind, onCancel, onApply }: StatusMediaEditorProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const canvasElementRef = useRef<HTMLCanvasElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<Canvas | null>(null)
  const fabricRef = useRef<typeof import('fabric') | null>(null)
  const objectURLRef = useRef('')
  const historyRef = useRef<string[]>([])
  const historyIndexRef = useRef(-1)
  const restoringRef = useRef(false)
  const [ready, setReady] = useState(false)
  const [selected, setSelected] = useState(false)
  const [drawing, setDrawing] = useState(false)
  const [color, setColor] = useState('#ffffff')
  const [historyVersion, setHistoryVersion] = useState(0)
  const [linkValue, setLinkValue] = useState('')
  const [linkUrl, setLinkUrl] = useState('')
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [videoPlaying, setVideoPlaying] = useState(false)
  const [trimStart, setTrimStart] = useState(0)
  const [trimEnd, setTrimEnd] = useState(0)
  const [mute, setMute] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState('')
  useAccessibleDialog(open, dialogRef, onCancel, closeButtonRef)

  const saveHistory = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || restoringRef.current) return
    const state = JSON.stringify(canvas.toObject(['statusRole'] as never))
    const next = historyRef.current.slice(0, historyIndexRef.current + 1)
    next.push(state)
    if (next.length > 40) next.shift()
    historyRef.current = next
    historyIndexRef.current = next.length - 1
    setHistoryVersion(value => value + 1)
  }, [])

  useEffect(() => {
    if (!open || !file || !canvasElementRef.current) return
    let disposed = false
    setReady(false)
    setError('')
    setLinkValue('')
    setLinkUrl('')
    setDuration(0)
    setCurrentTime(0)
    setVideoPlaying(false)
    setTrimStart(0)
    setTrimEnd(0)
    setMute(false)
    historyRef.current = []
    historyIndexRef.current = -1
    const objectURL = URL.createObjectURL(file)
    objectURLRef.current = objectURL

    const initialize = async () => {
      const fabric = await import('fabric')
      if (disposed || !canvasElementRef.current) return
      fabricRef.current = fabric
      const canvas = new fabric.Canvas(canvasElementRef.current, {
        width: CANVAS_WIDTH,
        height: CANVAS_HEIGHT,
        backgroundColor: kind === 'image' ? '#020617' : 'transparent',
        preserveObjectStacking: true,
        selection: true,
      })
      canvasRef.current = canvas
      const selectionChanged = () => setSelected(Boolean(canvas.getActiveObject()))
      canvas.on('selection:created', selectionChanged)
      canvas.on('selection:updated', selectionChanged)
      canvas.on('selection:cleared', selectionChanged)
      canvas.on('object:modified', saveHistory)
      canvas.on('object:added', saveHistory)
      canvas.on('object:removed', saveHistory)
      canvas.on('path:created', saveHistory)

      if (kind === 'image') {
        try {
          const image = await fabric.FabricImage.fromURL(objectURL)
          if (disposed) return
          const width = image.width || 1
          const height = image.height || 1
          const scale = Math.max(CANVAS_WIDTH / width, CANVAS_HEIGHT / height)
          image.set({
            left: CANVAS_WIDTH / 2,
            top: CANVAS_HEIGHT / 2,
            originX: 'center',
            originY: 'center',
            scaleX: scale,
            scaleY: scale,
            statusRole: 'background',
          } as never)
          canvas.add(image)
          canvas.setActiveObject(image)
        } catch {
          setError('No se pudo abrir esta imagen para editarla.')
        }
      }
      canvas.renderAll()
      saveHistory()
      setReady(true)
    }
    void initialize()

    return () => {
      disposed = true
      canvasRef.current?.dispose()
      canvasRef.current = null
      fabricRef.current = null
      URL.revokeObjectURL(objectURL)
      objectURLRef.current = ''
    }
  }, [file, kind, open, saveHistory])

  const addText = () => {
    const canvas = canvasRef.current
    const fabric = fabricRef.current
    if (!canvas || !fabric) return
    const text = new fabric.Textbox('Escribe aquí', {
      left: 35, top: 190, width: 200, fontSize: 25, fontWeight: 700,
      fill: color, textAlign: 'center', fontFamily: 'Arial',
      backgroundColor: 'rgba(15,23,42,0.58)', padding: 8,
    })
    canvas.add(text)
    canvas.setActiveObject(text)
    text.enterEditing()
    text.selectAll()
    canvas.renderAll()
  }

  const addEmoji = (emoji: string) => {
    const canvas = canvasRef.current
    const fabric = fabricRef.current
    if (!canvas || !fabric) return
    const object = new fabric.IText(emoji, { left: 108, top: 200, fontSize: 52, fontFamily: 'Arial' })
    canvas.add(object)
    canvas.setActiveObject(object)
    canvas.renderAll()
  }

  const addShape = (shape: 'rect' | 'circle') => {
    const canvas = canvasRef.current
    const fabric = fabricRef.current
    if (!canvas || !fabric) return
    const common = { left: 85, top: 195, fill: `${color}33`, stroke: color, strokeWidth: 3 }
    const object = shape === 'rect'
      ? new fabric.Rect({ ...common, width: 100, height: 70, rx: 10, ry: 10 })
      : new fabric.Circle({ ...common, radius: 48 })
    canvas.add(object)
    canvas.setActiveObject(object)
    canvas.renderAll()
  }

  const addLink = () => {
    let normalized = linkValue.trim()
    if (!normalized) return
    if (!/^https:\/\//i.test(normalized)) normalized = `https://${normalized.replace(/^\w+:\/\//, '')}`
    try {
      const parsed = new URL(normalized)
      if (parsed.protocol !== 'https:') throw new Error('invalid')
      normalized = parsed.toString()
    } catch {
      setError('El enlace debe ser una dirección HTTPS válida.')
      return
    }
    setLinkUrl(normalized)
    setError('')
    const canvas = canvasRef.current
    const fabric = fabricRef.current
    if (!canvas || !fabric) return
    const label = new fabric.Textbox(`🔗 ${normalized.replace(/^https:\/\//, '').replace(/\/$/, '')}`, {
      left: 30, top: 350, width: 210, fontSize: 15, fontWeight: 700,
      fill: '#ffffff', textAlign: 'center', backgroundColor: 'rgba(5,150,105,0.88)', padding: 9,
      rx: 8, ry: 8,
    } as never)
    canvas.add(label)
    canvas.setActiveObject(label)
    canvas.renderAll()
  }

  const updateActive = (action: 'rotate' | 'flipX' | 'flipY' | 'front' | 'back' | 'delete' | 'center') => {
    const canvas = canvasRef.current
    const object = canvas?.getActiveObject()
    if (!canvas || !object) return
    if (action === 'rotate') object.rotate(((object.angle || 0) + 90) % 360)
    if (action === 'flipX') object.set('flipX', !object.flipX)
    if (action === 'flipY') object.set('flipY', !object.flipY)
    if (action === 'front') canvas.bringObjectToFront(object)
    if (action === 'back') {
      const background = canvas.getObjects().find(item => (item as FabricObject & { statusRole?: string }).statusRole === 'background')
      canvas.sendObjectToBack(object)
      if (background && background !== object) canvas.sendObjectToBack(background)
    }
    if (action === 'center') {
      object.set({ left: CANVAS_WIDTH / 2, top: CANVAS_HEIGHT / 2, originX: 'center', originY: 'center' })
    }
    if (action === 'delete') canvas.remove(object)
    object.setCoords()
    canvas.renderAll()
    saveHistory()
  }

  const toggleDrawing = () => {
    const canvas = canvasRef.current
    const fabric = fabricRef.current
    if (!canvas || !fabric) return
    const next = !drawing
    setDrawing(next)
    canvas.isDrawingMode = next
    if (next) {
      const brush = new fabric.PencilBrush(canvas)
      brush.color = color
      brush.width = 5
      canvas.freeDrawingBrush = brush
      canvas.discardActiveObject()
      canvas.renderAll()
    }
  }

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas?.freeDrawingBrush) canvas.freeDrawingBrush.color = color
  }, [color])

  const restoreHistory = async (direction: -1 | 1) => {
    const canvas = canvasRef.current
    const nextIndex = historyIndexRef.current + direction
    const state = historyRef.current[nextIndex]
    if (!canvas || !state || nextIndex < 0 || nextIndex >= historyRef.current.length) return
    restoringRef.current = true
    historyIndexRef.current = nextIndex
    try {
      await canvas.loadFromJSON(state)
      canvas.renderAll()
      setSelected(false)
      setHistoryVersion(value => value + 1)
    } finally {
      restoringRef.current = false
    }
  }

  const seekVideo = (value: number) => {
    const next = Math.max(0, Math.min(Number.isFinite(value) ? value : 0, duration || 0))
    if (videoRef.current) videoRef.current.currentTime = next
    setCurrentTime(next)
  }

  const toggleVideoPlayback = async () => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) {
      if (video.currentTime < trimStart || video.currentTime >= trimEnd) seekVideo(trimStart)
      try {
        await video.play()
      } catch {
        setError('El navegador no pudo iniciar la vista previa del video.')
      }
    } else {
      video.pause()
    }
  }

  const updateTrimStart = (raw: number) => {
    const next = Math.max(0, Math.min(Number.isFinite(raw) ? raw : 0, Math.max(0, duration - 0.1)))
    setTrimStart(next)
    setTrimEnd(previous => Math.min(duration, Math.max(next + 0.1, Math.min(previous, next + 60))))
    seekVideo(next)
  }

  const updateTrimEnd = (raw: number) => {
    const next = Math.max(trimStart + 0.1, Math.min(Number.isFinite(raw) ? raw : trimStart + 60, duration || trimStart + 60, trimStart + 60))
    setTrimEnd(next)
    if (videoRef.current && videoRef.current.currentTime > next) seekVideo(trimStart)
  }

  const apply = async () => {
    const canvas = canvasRef.current
    if (!canvas || !file || applying) return
    setApplying(true)
    setError('')
    try {
      canvas.discardActiveObject()
      canvas.isDrawingMode = false
      canvas.renderAll()
      if (kind === 'image') {
        const dataURL = canvas.toDataURL({ format: 'jpeg', quality: 0.9, multiplier: 4 })
        const blob = await dataURLToBlob(dataURL)
        onApply({
          media: new File([blob], `${file.name.replace(/\.[^.]+$/, '') || 'estado'}-editado.jpg`, { type: 'image/jpeg', lastModified: Date.now() }),
          linkUrl: linkUrl || undefined,
        })
        return
      }
      const hasOverlay = canvas.getObjects().length > 0
      let overlay: File | undefined
      if (hasOverlay) {
        const dataURL = canvas.toDataURL({ format: 'png', multiplier: 4 })
        const blob = await dataURLToBlob(dataURL)
        overlay = new File([blob], 'estado-overlay.png', { type: 'image/png', lastModified: Date.now() })
      }
      onApply({
        media: file,
        overlay,
        videoEdits: { trim_start: trimStart, trim_end: trimEnd || duration, mute },
        linkUrl: linkUrl || undefined,
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se pudo preparar el diseño.')
    } finally {
      setApplying(false)
    }
  }

  if (!open || !file || typeof document === 'undefined') return null

  return createPortal(
    <div className="fixed inset-0 z-[170] flex items-center justify-center bg-slate-950/80 p-0 backdrop-blur-sm sm:p-4">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Editar publicación" className="flex h-[100dvh] w-full flex-col overflow-hidden bg-slate-100 shadow-2xl sm:h-[min(900px,96dvh)] sm:max-w-6xl sm:rounded-3xl">
        <header className="flex min-h-16 items-center gap-3 border-b border-slate-200 bg-white px-4 sm:px-6">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-700"><Scissors className="h-5 w-5" /></div>
          <div className="min-w-0 flex-1"><h3 className="font-bold text-slate-900">Editar {kind === 'image' ? 'imagen' : 'video'}</h3><p className="truncate text-xs text-slate-500">Mueve, gira y escala cualquier elemento directamente sobre la publicación.</p></div>
          <button ref={closeButtonRef} type="button" onClick={onCancel} disabled={applying} className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 disabled:opacity-40" aria-label="Cerrar editor"><X className="h-5 w-5" /></button>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_330px] lg:overflow-hidden">
          <main className="flex min-h-[560px] items-center justify-center overflow-auto bg-[radial-gradient(circle_at_center,#334155_0,#0f172a_70%)] p-5">
            <div className="relative h-[min(70dvh,640px)] max-h-[640px] aspect-[9/16] overflow-hidden rounded-3xl bg-slate-950 shadow-2xl ring-1 ring-white/20">
              {kind === 'video' && <video ref={videoRef} src={objectURLRef.current} muted={mute} playsInline onLoadedMetadata={event => { const value = Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0; setDuration(value); setTrimEnd(Math.min(60, value)); setCurrentTime(0) }} onTimeUpdate={event => { const value = event.currentTarget.currentTime; setCurrentTime(value); if (trimEnd > trimStart && value >= trimEnd) { event.currentTarget.pause(); event.currentTarget.currentTime = trimStart; setCurrentTime(trimStart) } }} onPlay={() => setVideoPlaying(true)} onPause={() => setVideoPlaying(false)} className="pointer-events-none absolute inset-0 h-full w-full object-contain" />}
              <div className="absolute inset-0 flex items-center justify-center [&_.canvas-container]:!h-full [&_.canvas-container]:!w-full [&_canvas]:!h-full [&_canvas]:!w-full"><canvas ref={canvasElementRef} /></div>
              {!ready && <div className="absolute inset-0 flex items-center justify-center bg-slate-950/80 text-sm font-semibold text-white"><Loader2 className="mr-2 h-5 w-5 animate-spin" />Preparando editor</div>}
            </div>
          </main>

          <aside className="space-y-4 overflow-y-auto border-t border-slate-200 bg-white p-4 lg:border-l lg:border-t-0 lg:p-5">
            <section>
              <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Añadir</p>
              <div className="mt-2 grid grid-cols-4 gap-2">
                <ToolButton label="Texto" onClick={addText}><Type className="h-4 w-4" /></ToolButton>
                <ToolButton label={drawing ? 'Terminar' : 'Dibujar'} active={drawing} onClick={toggleDrawing}><Brush className="h-4 w-4" /></ToolButton>
                <ToolButton label="Cuadro" onClick={() => addShape('rect')}><Square className="h-4 w-4" /></ToolButton>
                <ToolButton label="Círculo" onClick={() => addShape('circle')}><CircleIcon className="h-4 w-4" /></ToolButton>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5 rounded-2xl bg-slate-50 p-2" aria-label="Emojis">
                {emojis.map(emoji => <button key={emoji} type="button" onClick={() => addEmoji(emoji)} className="flex h-9 w-9 items-center justify-center rounded-xl text-xl hover:bg-white hover:shadow-sm" aria-label={`Añadir ${emoji}`}>{emoji}</button>)}
              </div>
            </section>

            <section>
              <div className="flex items-center justify-between"><p className="text-xs font-bold uppercase tracking-wide text-slate-500">Color</p><input type="color" value={color} onChange={event => setColor(event.target.value)} className="h-9 w-12 cursor-pointer rounded-lg border border-slate-200 bg-white p-1" /></div>
            </section>

            <section className={`${selected ? '' : 'opacity-45'}`}>
              <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Elemento seleccionado</p>
              <div className="mt-2 grid grid-cols-4 gap-2">
                <ToolButton label="Girar" disabled={!selected} onClick={() => updateActive('rotate')}><RotateCw className="h-4 w-4" /></ToolButton>
                <ToolButton label="Voltear H" disabled={!selected} onClick={() => updateActive('flipX')}><FlipHorizontal2 className="h-4 w-4" /></ToolButton>
                <ToolButton label="Voltear V" disabled={!selected} onClick={() => updateActive('flipY')}><FlipVertical2 className="h-4 w-4" /></ToolButton>
                <ToolButton label="Centrar" disabled={!selected} onClick={() => updateActive('center')}><AlignCenter className="h-4 w-4" /></ToolButton>
                <ToolButton label="Adelante" disabled={!selected} onClick={() => updateActive('front')}><ArrowUp className="h-4 w-4" /></ToolButton>
                <ToolButton label="Atrás" disabled={!selected} onClick={() => updateActive('back')}><ArrowDown className="h-4 w-4" /></ToolButton>
                <ToolButton label="Eliminar" danger disabled={!selected} onClick={() => updateActive('delete')}><Trash2 className="h-4 w-4" /></ToolButton>
              </div>
            </section>

            <section>
              <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Enlace HTTPS</p>
              <div className="mt-2 flex gap-2"><input value={linkValue} onChange={event => setLinkValue(event.target.value)} placeholder="https://…" className="min-w-0 flex-1 rounded-xl border border-slate-200 px-3 text-sm outline-none focus:border-emerald-500" /><button type="button" onClick={addLink} className="flex h-11 w-11 items-center justify-center rounded-xl bg-slate-900 text-white" aria-label="Añadir enlace"><Link2 className="h-4 w-4" /></button></div>
              {linkUrl && <p className="mt-1 truncate text-[11px] font-semibold text-emerald-700">Se incluirá también en el texto de la publicación.</p>}
            </section>

            {kind === 'video' && <section className="rounded-2xl bg-slate-50 p-3">
              <div className="flex items-center justify-between"><p className="text-xs font-bold uppercase tracking-wide text-slate-500">Video</p><button type="button" onClick={() => setMute(value => !value)} className="flex h-9 items-center gap-2 rounded-xl bg-white px-3 text-xs font-bold text-slate-700 shadow-sm">{mute ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}{mute ? 'Sin audio' : 'Con audio'}</button></div>
              <div className="mt-3 flex items-center gap-2"><button type="button" onClick={() => void toggleVideoPlayback()} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-white" aria-label={videoPlaying ? 'Pausar vista previa' : 'Reproducir vista previa'}>{videoPlaying ? <Pause className="h-4 w-4" /> : <Play className="ml-0.5 h-4 w-4" />}</button><input type="range" min={0} max={duration || 0.1} step="0.05" value={Math.min(currentTime, duration || 0)} onChange={event => seekVideo(Number(event.target.value))} className="h-2 min-w-0 flex-1 cursor-pointer accent-emerald-600" aria-label="Posición de la vista previa" /><span className="w-20 text-right text-[10px] tabular-nums text-slate-500">{currentTime.toFixed(1)} / {duration.toFixed(1)} s</span></div>
              <div className="mt-3 grid grid-cols-2 gap-2"><label className="text-[11px] font-semibold text-slate-600">Inicio (s)<input type="number" min={0} max={Math.max(0, duration - 0.1)} step="0.1" value={trimStart} onChange={event => updateTrimStart(Number(event.target.value))} className="mt-1 h-10 w-full rounded-xl border border-slate-200 px-2 text-sm" /></label><label className="text-[11px] font-semibold text-slate-600">Fin (s)<input type="number" min={trimStart + 0.1} max={Math.min(duration || trimStart + 60, trimStart + 60)} step="0.1" value={trimEnd} onChange={event => updateTrimEnd(Number(event.target.value))} className="mt-1 h-10 w-full rounded-xl border border-slate-200 px-2 text-sm" /></label></div>
              <p className="mt-2 text-[11px] text-slate-500">Máximo 60 segundos. El resultado se optimiza para WhatsApp.</p>
            </section>}

            {error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-xs text-rose-700">{error}</p>}
            <div className="flex items-center gap-2 border-t border-slate-100 pt-4">
              <button type="button" onClick={() => void restoreHistory(-1)} disabled={historyIndexRef.current <= 0 || applying} className="flex h-11 w-11 items-center justify-center rounded-xl border border-slate-200 text-slate-600 disabled:opacity-30" aria-label="Deshacer"><Undo2 className="h-4 w-4" /></button>
              <button type="button" onClick={() => void restoreHistory(1)} disabled={historyIndexRef.current >= historyRef.current.length - 1 || applying} className="flex h-11 w-11 items-center justify-center rounded-xl border border-slate-200 text-slate-600 disabled:opacity-30" aria-label="Rehacer"><Redo2 className="h-4 w-4" /></button>
              <span className="sr-only">{historyVersion}</span>
              <button type="button" onClick={() => void apply()} disabled={!ready || applying} className="ml-auto flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-bold text-white shadow-lg shadow-emerald-600/20 hover:bg-emerald-700 disabled:bg-slate-300">{applying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{applying ? 'Preparando…' : 'Aplicar diseño'}</button>
            </div>
          </aside>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function ToolButton({ children, label, onClick, disabled = false, active = false, danger = false }: { children: React.ReactNode; label: string; onClick: () => void; disabled?: boolean; active?: boolean; danger?: boolean }) {
  return <button type="button" onClick={onClick} disabled={disabled} className={`flex min-h-12 flex-col items-center justify-center gap-1 rounded-xl border px-1 text-[9px] font-bold transition disabled:cursor-not-allowed disabled:opacity-35 ${danger ? 'border-rose-200 text-rose-600 hover:bg-rose-50' : active ? 'border-emerald-500 bg-emerald-50 text-emerald-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>{children}<span>{label}</span></button>
}
