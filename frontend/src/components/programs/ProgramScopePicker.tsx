'use client'

import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import { OPERATIONAL_OVERLAY_LAYERS } from '@/components/operational-overlay/operationalOverlayLayers'

export interface ProgramScopeOption<T extends string> { value: T; label: string; count?: number }

export function programScopePickerPosition(rect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>, viewport: { width: number; height: number; left?: number; top?: number }): CSSProperties {
  const left = viewport.left || 0
  const top = viewport.top || 0
  const width = Math.max(0, Math.min(248, viewport.width - 16))
  const viewportHeight = Math.max(0, viewport.height - 16)
  const below = Math.max(0, top + viewport.height - rect.bottom - 14)
  const above = Math.max(0, rect.top - top - 14)
  const flip = below < 168 && above > below
  const height = Math.min(viewportHeight, Math.max(44, Math.min(240, flip ? above : below)))
  const preferredTop = flip ? rect.top - height - 6 : rect.bottom + 6
  return { width, left: Math.max(left + 8, Math.min(rect.right - width, left + viewport.width - width - 8)), top: Math.max(top + 8, Math.min(preferredTop, top + viewport.height - height - 8)), maxHeight: height }
}

export function ProgramScopePicker<T extends string>({ value, options, onChange, label, resultCount }: {
  value: T; options: readonly ProgramScopeOption<T>[]; onChange: (value: T) => void; label: string; resultCount?: number
}) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [highlighted, setHighlighted] = useState(0)
  const [style, setStyle] = useState<CSSProperties>({})
  const selected = options.find(option => option.value === value) || options[0]
  const selectedIndex = Math.max(0, options.findIndex(option => option.value === value))
  const optionValues = JSON.stringify(options.map(option => option.value))
  const close = (restore = true) => { setOpen(false); if (restore) trigger.current?.focus({ preventScroll: true }) }
  useEffect(() => {
    if (open) setHighlighted(selectedIndex)
  }, [open, selectedIndex, optionValues])
  useEffect(() => {
    if (!open) return
    const update = () => {
      const rect = trigger.current?.getBoundingClientRect()
      const viewport = window.visualViewport
      const available = { width: viewport?.width || window.innerWidth, height: viewport?.height || window.innerHeight, left: viewport?.offsetLeft || 0, top: viewport?.offsetTop || 0 }
      if (rect && (rect.bottom < available.top || rect.top > available.top + available.height || rect.right < available.left || rect.left > available.left + available.width)) {
        setOpen(false)
        return
      }
      if (rect) setStyle(programScopePickerPosition(rect, available))
    }
    const outside = (event: PointerEvent) => { if (!trigger.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false) }
    update()
    menu.current?.focus({ preventScroll: true })
    document.addEventListener('pointerdown', outside)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    window.visualViewport?.addEventListener('resize', update)
    window.visualViewport?.addEventListener('scroll', update)
    return () => {
      document.removeEventListener('pointerdown', outside)
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      window.visualViewport?.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('scroll', update)
    }
  }, [open])
  const choose = (next: T) => { onChange(next); close() }
  if (!selected) return null
  return <>
    <button ref={trigger} type="button" aria-label={`${label}: ${selected.label}${selected.count === undefined ? '' : ` ${selected.count}`}`} aria-describedby={resultCount === undefined || selected.count === undefined ? undefined : `${id}-results`} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => setOpen(current => !current)} onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true) } }}
      className="inline-flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-r-xl border-l border-slate-200 px-2.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500 sm:text-sm">
      <span>{selected.label}</span>{selected.count !== undefined && <span className="tabular-nums text-emerald-700">{resultCount === undefined ? selected.count : `${resultCount}/${selected.count}`}</span>}<ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />
    </button>
    {resultCount !== undefined && selected.count !== undefined && <span id={`${id}-results`} className="sr-only" role="status">{resultCount} coincidencias de {selected.count}</span>}
    {open && typeof document !== 'undefined' && createPortal(<div id={id} ref={menu} role="listbox" aria-label={label} aria-activedescendant={`${id}-${highlighted}`} tabIndex={-1}
      style={{ ...style, zIndex: OPERATIONAL_OVERLAY_LAYERS.workspacePopover }} className="fixed overflow-y-auto rounded-xl border border-slate-200 bg-white p-1.5 shadow-xl outline-none"
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
        else if (event.key === 'Tab') { close(); }
        else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setHighlighted(index => (index + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length) }
        else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); setHighlighted(event.key === 'Home' ? 0 : options.length - 1) }
        else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); const option = options[highlighted]; if (option) choose(option.value) }
      }}>
      {options.map((option, index) => <button id={`${id}-${index}`} key={option.value} type="button" role="option" aria-selected={option.value === value} tabIndex={-1} onClick={() => choose(option.value)} onPointerMove={() => setHighlighted(index)}
        className={`flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm ${highlighted === index ? 'bg-emerald-50 text-emerald-800' : 'text-slate-700'}`}>
        <span className="flex-1 font-medium">{option.label}</span>{option.count !== undefined && <span className="tabular-nums text-slate-500">{option.count}</span>}<span className="w-4">{option.value === value && <Check className="h-4 w-4 text-emerald-600" />}</span>
      </button>)}
    </div>, document.body)}
  </>
}
