'use client'

import { createPortal } from 'react-dom'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { AlertCircle, BriefcaseBusiness, Check, ChevronDown, CircleDollarSign, GitBranch, Loader2, Trophy } from 'lucide-react'
import type { Lead, PipelineStage } from '@/types/contact'
import {
  OPERATIONAL_OVERLAY_LAYERS,
  useOperationalOverlayPortal,
  useOperationalOverlayRegistration,
} from '@/components/operational-window/OperationalOverlayContext'

export type LeadStageChangeResult = boolean | void | { success: boolean; error?: string }

type Props = {
  lead: Lead
  stages?: PipelineStage[]
  disabled?: boolean
  saving?: boolean
  embedded?: boolean
  onStageChange?: (stage: PipelineStage | null) => LeadStageChangeResult | Promise<LeadStageChangeResult>
}

type ViewportRect = { left: number; top: number; width: number; height: number }
type AnchorRect = Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom' | 'width'>

export type CrmStagePickerPlacement = {
  left: number
  top: number
  width: number
  maxHeight: number
  placement: 'top' | 'bottom'
}

export function crmStagePickerPlacement(anchor: AnchorRect, viewport: ViewportRect, menuHeight = 320): CrmStagePickerPlacement {
  const margin = 8
  const gap = 6
  const viewportRight = viewport.left + viewport.width
  const viewportBottom = viewport.top + viewport.height
  const usableWidth = Math.max(160, viewport.width - (margin * 2))
  const width = Math.min(Math.max(anchor.width, 260), usableWidth)
  const left = Math.min(Math.max(anchor.left, viewport.left + margin), Math.max(viewport.left + margin, viewportRight - width - margin))
  const below = Math.max(0, viewportBottom - anchor.bottom - margin - gap)
  const above = Math.max(0, anchor.top - viewport.top - margin - gap)
  const placement = below >= Math.min(menuHeight, 240) || below >= above ? 'bottom' : 'top'
  const availableHeight = placement === 'bottom' ? below : above
  const maxHeight = Math.max(64, Math.min(menuHeight, availableHeight))
  const rawTop = placement === 'bottom' ? anchor.bottom + gap : anchor.top - gap - maxHeight
  const top = Math.min(Math.max(rawTop, viewport.top + margin), Math.max(viewport.top + margin, viewportBottom - maxHeight - margin))
  return { left, top, width, maxHeight, placement }
}

function lifecycleLabel(status: string) {
  if (status === 'won') return 'Ganada'
  if (status === 'lost') return 'Perdida'
  return 'Abierta'
}

function viewportRect(): ViewportRect {
  const viewport = window.visualViewport
  return {
    left: viewport?.offsetLeft || 0,
    top: viewport?.offsetTop || 0,
    width: viewport?.width || window.innerWidth,
    height: viewport?.height || window.innerHeight,
  }
}

export default function LeadContextPanel({ lead, stages = [], disabled = false, saving = false, embedded = false, onStageChange }: Props) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const listboxId = useId()
  const overlayId = useId()
  const overlayPortal = useOperationalOverlayPortal()
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [placement, setPlacement] = useState<CrmStagePickerPlacement | null>(null)
  const options = useMemo(() => [
    { id: '', name: 'Sin etapa', color: '#64748b', stage: null as PipelineStage | null },
    ...[...stages]
      .sort((left, right) => left.position - right.position)
      .map(stage => ({ id: stage.id, name: stage.name, color: stage.color || '#64748b', stage })),
  ], [stages])
  const currentStageId = lead.stage_id || ''
  const stageColor = lead.stage_color || lead.lead_stage_color || '#64748b'
  const currentStageName = lead.stage_name || lead.lead_stage_name || 'Sin etapa'
  const isDisabled = disabled || saving || pending || !onStageChange

  useOperationalOverlayRegistration(open, `crm-stage-picker-${overlayId}`)

  const close = (restoreFocus = false) => {
    setOpen(false)
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus())
  }

  useLayoutEffect(() => {
    if (!open) return
    const measure = () => {
      const anchor = triggerRef.current?.getBoundingClientRect()
      if (!anchor) return
      const estimatedHeight = Math.min(320, Math.max(112, (options.length * 48) + 16))
      setPlacement(crmStagePickerPlacement(anchor, viewportRect(), menuRef.current?.offsetHeight || estimatedHeight))
    }
    measure()
    const frame = requestAnimationFrame(measure)
    const visualViewport = window.visualViewport
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    visualViewport?.addEventListener('resize', measure)
    visualViewport?.addEventListener('scroll', measure)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
      visualViewport?.removeEventListener('resize', measure)
      visualViewport?.removeEventListener('scroll', measure)
    }
  }, [open, options.length])

  useEffect(() => {
    if (!open) return
    const selectedIndex = Math.max(0, options.findIndex(option => option.id === currentStageId))
    setActiveIndex(selectedIndex)
    requestAnimationFrame(() => menuRef.current?.focus())
    const dismiss = (event: MouseEvent) => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return
      close(false)
    }
    document.addEventListener('mousedown', dismiss)
    return () => document.removeEventListener('mousedown', dismiss)
  }, [currentStageId, open, options])

  useEffect(() => {
    if (!open) return
    const option = document.getElementById(`${listboxId}-option-${activeIndex}`)
    option?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex, listboxId, open])

  const selectStage = async (stage: PipelineStage | null) => {
    if ((stage?.id || '') === currentStageId || isDisabled) {
      close(true)
      return
    }
    close(true)
    setPending(true)
    setError('')
    try {
      const result = await onStageChange?.(stage)
      const success = typeof result === 'object' && result !== null ? result.success : result !== false
      if (!success) {
        const message = typeof result === 'object' && result !== null ? result.error : undefined
        setError(message || 'No se pudo cambiar la etapa. Se restauró el valor anterior.')
      }
    } catch (stageError) {
      setError(stageError instanceof Error ? stageError.message : 'No se pudo cambiar la etapa. Se restauró el valor anterior.')
    } finally {
      setPending(false)
    }
  }

  const onListboxKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close(true)
      return
    }
    if (event.key === 'Tab') {
      close(false)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      if (event.key === 'Home') setActiveIndex(0)
      else if (event.key === 'End') setActiveIndex(options.length - 1)
      else setActiveIndex(current => (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length)
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      void selectStage(options[activeIndex]?.stage || null)
    }
  }

  const menu = open && placement && typeof document !== 'undefined' ? createPortal(
    <div
      ref={menuRef}
      data-operational-picker-backdrop
      id={listboxId}
      role="listbox"
      tabIndex={-1}
      aria-label="Etapas del pipeline actual"
      aria-activedescendant={`${listboxId}-option-${activeIndex}`}
      onKeyDown={onListboxKeyDown}
      className="pointer-events-auto fixed overflow-y-auto rounded-2xl border border-slate-200 bg-white p-1.5 shadow-[0_20px_55px_rgba(15,23,42,0.24)] outline-none ring-1 ring-slate-900/5"
      style={{ left: placement.left, top: placement.top, width: placement.width, maxHeight: placement.maxHeight, zIndex: OPERATIONAL_OVERLAY_LAYERS.picker }}
    >
      {options.map((option, index) => {
        const selected = option.id === currentStageId
        const active = index === activeIndex
        return (
          <button
            key={option.id || 'unassigned'}
            id={`${listboxId}-option-${index}`}
            type="button"
            role="option"
            aria-selected={selected}
            onMouseMove={() => setActiveIndex(index)}
            onClick={() => void selectStage(option.stage)}
            className={`flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm font-semibold outline-none ${active ? 'bg-emerald-50 text-emerald-900' : 'text-slate-700 hover:bg-slate-50'}`}
          >
            <span className="h-3.5 w-3.5 shrink-0 rounded-full ring-4 ring-white" style={{ backgroundColor: option.color }} />
            <span className="min-w-0 flex-1 truncate">{option.name}</span>
            {selected && <Check className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />}
          </button>
        )
      })}
    </div>,
    overlayPortal || document.body,
  ) : null

  return (
    <section className={embedded ? '' : 'rounded-2xl border border-emerald-100 bg-white p-4 shadow-sm'} aria-labelledby="lead-context-title">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[.16em] text-emerald-700"><BriefcaseBusiness className="h-3.5 w-3.5" />Oportunidad</p>
          <h3 id="lead-context-title" className="mt-1 truncate text-base font-bold text-slate-900">{lead.title || lead.name || 'Oportunidad sin título'}</h3>
          <p className="mt-1 flex items-center gap-1.5 text-xs text-slate-500"><GitBranch className="h-3.5 w-3.5" />{lead.pipeline_name || lead.lead_pipeline_name || 'Pipeline principal'}</p>
        </div>
        <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold ${lead.status === 'won' ? 'bg-emerald-50 text-emerald-700' : lead.status === 'lost' ? 'bg-rose-50 text-rose-700' : 'bg-blue-50 text-blue-700'}`}>{lead.status === 'won' ? <Trophy className="h-3.5 w-3.5" /> : <CircleDollarSign className="h-3.5 w-3.5" />}{lifecycleLabel(lead.status)}</span>
      </div>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-label={`Etapa actual: ${currentStageName}`}
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-haspopup="listbox"
        disabled={isDisabled}
        onClick={() => { setError(''); setOpen(current => !current) }}
        onKeyDown={event => {
          if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault()
            setOpen(true)
          }
        }}
        className="mt-4 flex min-h-14 w-full items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-left transition hover:border-emerald-200 hover:bg-emerald-50/40 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
      >
        <div className="min-w-0"><p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Etapa actual</p><p className="truncate text-sm font-bold text-slate-800">{pending || saving ? 'Guardando etapa…' : currentStageName}</p></div>
        <span className="flex shrink-0 items-center gap-2">
          {pending || saving ? <Loader2 className="h-4 w-4 animate-spin text-emerald-600 motion-reduce:animate-none" aria-hidden="true" /> : <span className="h-3.5 w-3.5 rounded-full ring-4 ring-white" style={{ backgroundColor: stageColor }} />}
          <ChevronDown className={`h-4 w-4 text-slate-400 transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
        </span>
      </button>
      {(pending || saving) && <p className="sr-only" role="status">Guardando la nueva etapa</p>}
      {error && <p className="mt-2 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700" role="alert"><AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{error}</p>}
      {menu}
    </section>
  )
}
