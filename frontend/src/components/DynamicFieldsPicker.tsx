'use client'

import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import {
  Search, X, ChevronDown, ChevronRight,
  Type, Hash, AtSign, Calendar, Tag, MapPin, Phone, CreditCard,
  Briefcase, FileText, QrCode, Workflow, GraduationCap, CalendarClock,
} from 'lucide-react'

export interface DynamicField {
  key: string
  label: string
  template: string
}

export interface DynamicFieldCategory {
  label: string
  fields: DynamicField[]
}

interface Props {
  open: boolean
  anchorRef: React.RefObject<HTMLElement | null>
  categories: DynamicFieldCategory[]
  onSelect: (field: DynamicField) => void
  onClose: () => void
}

// Map field key (or label) to a representative icon
function iconForField(field: DynamicField) {
  const k = field.key.toLowerCase()
  const l = field.label.toLowerCase()
  if (k.includes('email') || l.includes('email') || l.includes('correo')) return AtSign
  if (k.includes('fecha') || l.includes('fecha')) return Calendar
  if (k.includes('telefono') || k.includes('phone') || l.includes('teléfono')) return Phone
  if (k.includes('dni') || l.includes('dni')) return CreditCard
  if (k.includes('direccion') || k.includes('distrito') || l.includes('dirección')) return MapPin
  if (k.includes('empresa') || k.includes('ocupacion') || l.includes('empresa')) return Briefcase
  if (k.includes('edad') || k.includes('numero') || k.includes('cantidad')) return Hash
  if (k.includes('tag') || l.includes('etiqueta')) return Tag
  if (k.includes('pipeline') || k.includes('etapa')) return Workflow
  if (k.includes('programa')) return GraduationCap
  if (k.includes('evento') || k.includes('sesion')) return CalendarClock
  if (k.includes('qr')) return QrCode
  if (k.includes('nota') || k.includes('descripcion')) return FileText
  return Type
}

const CATEGORY_DEFAULT_OPEN: Record<string, boolean> = {
  'Datos personales': true,
  'CRM': true,
  'Programa / Evento': false,
  'Sistema': false,
  'Personalizados': true,
}

export default function DynamicFieldsPicker({
  open, anchorRef, categories, onSelect, onClose,
}: Props) {
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [activeIdx, setActiveIdx] = useState(0)
  const [pos, setPos] = useState<{ left: number; top: number; placement: 'right' | 'left' } | null>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])

  // Position with auto-flip
  useEffect(() => {
    if (!open) return
    const update = () => {
      const el = anchorRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const W = 320
      const margin = 8
      const spaceRight = window.innerWidth - r.right - margin
      const placement: 'right' | 'left' = spaceRight >= W + margin ? 'right' : 'left'
      const left = placement === 'right' ? r.right + margin : Math.max(margin, r.left - W - margin)
      // Vertical: prefer top-aligned with anchor; clamp into viewport
      const maxH = Math.min(520, window.innerHeight * 0.75)
      let top = r.top
      if (top + maxH > window.innerHeight - margin) {
        top = Math.max(margin, window.innerHeight - maxH - margin)
      }
      setPos({ left, top, placement })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open, anchorRef])

  // Reset query when reopened, focus input
  useEffect(() => {
    if (open) {
      setQuery('')
      setActiveIdx(0)
      setCollapsed({})
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  // Click outside / Esc
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (popoverRef.current?.contains(t)) return
      if (anchorRef.current?.contains(t)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onClose, anchorRef])

  // Filtered categories
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return categories
    return categories
      .map(cat => ({
        ...cat,
        fields: cat.fields.filter(f =>
          f.label.toLowerCase().includes(q) || f.key.toLowerCase().includes(q),
        ),
      }))
      .filter(cat => cat.fields.length > 0)
  }, [categories, query])

  // Flat list of visible fields (for keyboard nav)
  const flat = useMemo(() => {
    const out: { cat: string; field: DynamicField }[] = []
    filtered.forEach(cat => {
      const isCollapsed = query.trim() ? false : (collapsed[cat.label] ?? !(CATEGORY_DEFAULT_OPEN[cat.label] ?? true))
      if (!isCollapsed) {
        cat.fields.forEach(field => out.push({ cat: cat.label, field }))
      }
    })
    return out
  }, [filtered, collapsed, query])

  // Reset active when list shrinks
  useEffect(() => {
    if (activeIdx >= flat.length) setActiveIdx(Math.max(0, flat.length - 1))
  }, [flat.length, activeIdx])

  // Scroll active into view
  useEffect(() => {
    const el = itemRefs.current[activeIdx]
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx])

  const handleKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx(i => Math.min(flat.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx(i => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = flat[activeIdx]
      if (item) onSelect(item.field)
    }
  }, [flat, activeIdx, onSelect])

  if (!open || !pos || typeof document === 'undefined') return null

  const total = categories.reduce((s, c) => s + c.fields.length, 0)
  const filteredCount = filtered.reduce((s, c) => s + c.fields.length, 0)

  let runningIdx = 0

  return createPortal(
    <div
      ref={popoverRef}
      className="fixed bg-[#1e1e2e] border border-[#3a3a4d] rounded-xl shadow-2xl flex flex-col overflow-hidden"
      style={{
        left: `${pos.left}px`,
        top: `${pos.top}px`,
        width: '320px',
        maxHeight: 'min(520px, 75vh)',
        zIndex: 100,
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="px-3 py-2 border-b border-[#2a2a3d] flex items-center justify-between">
        <div>
          <p className="text-xs font-semibold text-slate-100">Campos dinámicos</p>
          <p className="text-[10px] text-slate-500">
            {query ? `${filteredCount} de ${total}` : `${total} campos disponibles`}
          </p>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-white/10 transition"
          title="Cerrar (Esc)"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Search */}
      <div className="px-3 py-2 border-b border-[#2a2a3d] bg-[#1a1a26]">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500 pointer-events-none" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => { setQuery(e.target.value); setActiveIdx(0) }}
            onKeyDown={handleKey}
            placeholder="Buscar campo…"
            className="w-full pl-7 pr-2 py-1.5 text-xs text-slate-100 bg-[#2a2a3d] border border-[#3a3a4d] rounded focus:bg-[#333348] focus:border-emerald-500 outline-none placeholder:text-slate-600 dark-input"
          />
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto py-1">
        {filtered.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-slate-500">
            No se encontraron campos para <span className="text-slate-300 font-medium">"{query}"</span>
          </div>
        ) : (
          filtered.map(cat => {
            const isCollapsed = query.trim() ? false : (collapsed[cat.label] ?? !(CATEGORY_DEFAULT_OPEN[cat.label] ?? true))
            return (
              <div key={cat.label} className="mb-0.5">
                <button
                  onClick={() => setCollapsed(c => ({ ...c, [cat.label]: !isCollapsed }))}
                  className="w-full px-3 py-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400 hover:text-slate-200 hover:bg-white/5 transition"
                >
                  {isCollapsed
                    ? <ChevronRight className="w-3 h-3" />
                    : <ChevronDown className="w-3 h-3" />}
                  <span>{cat.label}</span>
                  <span className="ml-auto text-slate-600 font-normal normal-case tracking-normal">{cat.fields.length}</span>
                </button>
                {!isCollapsed && cat.fields.map(field => {
                  const idx = runningIdx++
                  const Icon = iconForField(field)
                  const isActive = idx === activeIdx
                  return (
                    <button
                      key={field.key}
                      ref={(el) => { itemRefs.current[idx] = el }}
                      onMouseDown={(e) => { e.preventDefault(); e.stopPropagation() }}
                      onMouseEnter={() => setActiveIdx(idx)}
                      onClick={() => onSelect(field)}
                      className={`w-full flex items-center gap-2.5 px-3 py-2 text-xs text-left transition ${
                        isActive
                          ? 'bg-emerald-600/20 text-emerald-100'
                          : 'text-slate-200 hover:bg-white/5'
                      }`}
                    >
                      <span className={`w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0 ${
                        isActive ? 'bg-emerald-600/40 text-emerald-300' : 'bg-[#2a2a3d] text-slate-400'
                      }`}>
                        <Icon className="w-3.5 h-3.5" />
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="truncate font-medium">{field.label}</p>
                        <p className={`text-[10px] truncate font-mono ${isActive ? 'text-emerald-300/70' : 'text-slate-500'}`}>
                          {field.template}
                        </p>
                      </div>
                    </button>
                  )
                })}
              </div>
            )
          })
        )}
      </div>

      {/* Footer hints */}
      <div className="px-3 py-1.5 border-t border-[#2a2a3d] bg-[#1a1a26] flex items-center justify-between text-[10px] text-slate-500">
        <div className="flex items-center gap-2">
          <kbd className="px-1.5 py-0.5 bg-[#2a2a3d] border border-[#3a3a4d] rounded font-mono">↑↓</kbd>
          <span>navegar</span>
          <kbd className="px-1.5 py-0.5 bg-[#2a2a3d] border border-[#3a3a4d] rounded font-mono">↵</kbd>
          <span>insertar</span>
        </div>
        <div className="flex items-center gap-1">
          <kbd className="px-1.5 py-0.5 bg-[#2a2a3d] border border-[#3a3a4d] rounded font-mono">Esc</kbd>
          <span>cerrar</span>
        </div>
      </div>
    </div>,
    document.body,
  )
}
