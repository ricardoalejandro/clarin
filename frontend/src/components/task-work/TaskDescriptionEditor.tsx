'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react'
import { Expand, GripHorizontal, Loader2 } from 'lucide-react'
import {
  TASK_DESCRIPTION_DEFAULT_HEIGHT,
  TASK_DESCRIPTION_MAX_HEIGHT,
  TASK_DESCRIPTION_MIN_HEIGHT,
  clampTaskDescriptionHeight,
  taskDescriptionHeightFromKey,
} from './taskInteractionVisuals'

const DESCRIPTION_HEIGHT_STORAGE_VERSION = 2

export function taskDescriptionHeightStorageKey(storageScope = 'shared') {
  return `clarin:tasks:description-height:v${DESCRIPTION_HEIGHT_STORAGE_VERSION}:${encodeURIComponent(storageScope || 'shared')}`
}

interface Props {
  value: string
  onChange: (value: string) => void
  storageScope?: string
  panelRef?: { current: HTMLElement | null }
  pending?: boolean
  disabled?: boolean
  error?: ReactNode
  className?: string
  placeholder?: string
  onCommit?: () => boolean | void | Promise<boolean | void>
  onSubmit?: () => boolean | void | Promise<boolean | void>
  onExpandedChange?: (expanded: boolean) => void
}

export default function TaskDescriptionEditor({
  value,
  onChange,
  storageScope,
  panelRef,
  pending = false,
  disabled = false,
  error,
  className = '',
  placeholder = 'Añade contexto, criterios de éxito o instrucciones…',
  onCommit,
  onSubmit,
  onExpandedChange,
}: Props) {
  const [height, setHeight] = useState(TASK_DESCRIPTION_DEFAULT_HEIGHT)
  const [expanded, setExpanded] = useState(false)
  const [closing, setClosing] = useState(false)
  const heightRef = useRef(height)
  const inlineTextareaRef = useRef<HTMLTextAreaElement>(null)
  const expandedTextareaRef = useRef<HTMLTextAreaElement>(null)
  const pointerCleanupRef = useRef<(() => void) | null>(null)
  const storageKey = taskDescriptionHeightStorageKey(storageScope)
  heightRef.current = height

  useEffect(() => {
    const stored = Number(localStorage.getItem(storageKey))
    const next = Number.isFinite(stored) && stored > 0
      ? clampTaskDescriptionHeight(stored)
      : TASK_DESCRIPTION_DEFAULT_HEIGHT
    heightRef.current = next
    setHeight(next)
  }, [storageKey])

  useEffect(() => () => pointerCleanupRef.current?.(), [])

  const setExpandedState = useCallback((next: boolean) => {
    setExpanded(next)
    onExpandedChange?.(next)
  }, [onExpandedChange])

  const panelMaximum = useCallback(() => panelRef?.current
    ? Math.max(TASK_DESCRIPTION_MIN_HEIGHT, panelRef.current.clientHeight - 220)
    : TASK_DESCRIPTION_MAX_HEIGHT, [panelRef])

  const persistHeight = useCallback((requested: number) => {
    const next = clampTaskDescriptionHeight(requested, panelMaximum())
    heightRef.current = next
    setHeight(next)
    localStorage.setItem(storageKey, String(next))
    return next
  }, [panelMaximum, storageKey])

  const beginResize = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || disabled) return
    event.preventDefault()
    event.stopPropagation()
    pointerCleanupRef.current?.()
    const startY = event.clientY
    const startHeight = heightRef.current
    const move = (pointer: PointerEvent) => {
      pointer.preventDefault()
      const next = clampTaskDescriptionHeight(startHeight + pointer.clientY - startY, panelMaximum())
      heightRef.current = next
      setHeight(next)
    }
    const cleanup = () => {
      localStorage.setItem(storageKey, String(heightRef.current))
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', cleanup)
      window.removeEventListener('pointercancel', cleanup)
      pointerCleanupRef.current = null
    }
    pointerCleanupRef.current = cleanup
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', cleanup, { once: true })
    window.addEventListener('pointercancel', cleanup, { once: true })
  }, [disabled, panelMaximum, storageKey])

  const commitAndClose = useCallback(async () => {
    if (pending || closing) return
    setClosing(true)
    try {
      const saved = await onCommit?.()
      if (saved !== false) setExpandedState(false)
    } finally {
      setClosing(false)
    }
  }, [closing, onCommit, pending, setExpandedState])

  const submitFromEditor = useCallback(async (expandedMode: boolean) => {
    if (!onSubmit || pending || closing) return
    setClosing(true)
    try {
      const saved = await onSubmit()
      if (saved !== false && expandedMode) {
        setExpandedState(false)
      } else if (saved === false) {
        requestAnimationFrame(() => (expandedMode ? expandedTextareaRef.current : inlineTextareaRef.current)?.focus({ preventScroll: true }))
      }
    } finally {
      setClosing(false)
    }
  }, [closing, onSubmit, pending, setExpandedState])

  const busy = pending || closing
  return <section className={className}>
    <div className="mb-2 flex items-center justify-between gap-3">
      <h3 className="text-xs font-bold uppercase tracking-[0.14em] text-slate-400">Descripción</h3>
      <div className="flex items-center gap-2">
        {pending && <span className="flex items-center gap-1 text-[10px] font-medium text-emerald-600"><Loader2 className="h-3 w-3 animate-spin" /> Guardando</span>}
        <button type="button" disabled={disabled} onClick={() => setExpandedState(true)} className="inline-flex min-h-8 items-center gap-1.5 rounded-lg px-2 text-[11px] font-semibold text-slate-500 transition hover:bg-slate-100 hover:text-emerald-700 disabled:opacity-40" aria-label="Expandir descripción"><Expand className="h-3.5 w-3.5" />Expandir</button>
      </div>
    </div>
    <div className="relative">
      <textarea
        ref={inlineTextareaRef}
        data-task-description
        value={value}
        readOnly={disabled}
        aria-disabled={disabled}
        onChange={event => onChange(event.target.value)}
        onBlur={() => { void onCommit?.() }}
        onKeyDown={event => {
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault()
            event.stopPropagation()
            if (onSubmit) void submitFromEditor(false)
            else event.currentTarget.blur()
          }
        }}
        placeholder={placeholder}
        style={{ height }}
        className="w-full resize-none rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 pb-7 text-sm leading-6 text-slate-700 outline-none transition focus:border-emerald-300 focus:bg-white focus:ring-4 focus:ring-emerald-50 read-only:cursor-not-allowed read-only:opacity-60"
      />
      <div
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        aria-label="Ajustar altura de la descripción"
        aria-orientation="vertical"
        aria-valuemin={TASK_DESCRIPTION_MIN_HEIGHT}
        aria-valuemax={TASK_DESCRIPTION_MAX_HEIGHT}
        aria-valuenow={height}
        title="Arrastra para cambiar la altura. Usa ↑ y ↓ con el teclado."
        onPointerDown={beginResize}
        onDoubleClick={() => { if (!disabled) persistHeight(TASK_DESCRIPTION_DEFAULT_HEIGHT) }}
        onKeyDown={event => {
          if (disabled) return
          const next = taskDescriptionHeightFromKey(heightRef.current, event.key, panelMaximum())
          if (next === null) return
          event.preventDefault()
          persistHeight(next)
        }}
        className="absolute bottom-1.5 right-2 flex h-6 w-9 cursor-ns-resize items-center justify-center rounded-lg border border-slate-200 bg-white/95 text-slate-400 shadow-sm outline-none transition hover:border-emerald-300 hover:text-emerald-600 focus-visible:ring-2 focus-visible:ring-emerald-400 aria-disabled:cursor-not-allowed aria-disabled:opacity-40"
      ><GripHorizontal className="h-4 w-4" /></div>
    </div>

    {expanded && <section
      data-task-description-expanded
      data-no-window-drag
      role="dialog"
      aria-modal="true"
      aria-label="Editor ampliado de descripción"
      onKeyDown={event => {
        if (event.key !== 'Tab') return
        const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'))
        if (!focusable.length) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }}
      className="absolute inset-0 z-40 flex flex-col bg-white"
    >
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-slate-200 px-5 py-4 sm:px-6">
        <div><p className="text-[10px] font-black uppercase tracking-[.16em] text-emerald-600">Clarin Work</p><h2 className="mt-1 text-lg font-black text-slate-900">Descripción</h2></div>
        <button type="button" disabled={busy} onClick={() => { void commitAndClose() }} className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-slate-900 px-4 text-sm font-bold text-white shadow-sm transition hover:bg-slate-800 disabled:opacity-50">{busy && <Loader2 className="h-4 w-4 animate-spin" />}Listo</button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col p-4 sm:p-6">
        {error}
        <textarea
          ref={expandedTextareaRef}
          autoFocus
          value={value}
          readOnly={disabled}
          aria-disabled={disabled}
          onChange={event => onChange(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              void commitAndClose()
            } else if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              event.stopPropagation()
              if (onSubmit) {
                void submitFromEditor(true)
              }
              else void commitAndClose()
            }
          }}
          placeholder={placeholder}
          className="min-h-0 flex-1 resize-none rounded-2xl border border-slate-200 bg-slate-50 p-5 text-sm leading-7 text-slate-700 outline-none transition focus:border-emerald-300 focus:bg-white focus:ring-4 focus:ring-emerald-50 read-only:cursor-not-allowed read-only:opacity-60"
        />
        <p className="mt-3 text-center text-[10px] text-slate-400">Ctrl/⌘ + Enter para guardar · Escape para volver</p>
      </div>
    </section>}
  </section>
}
