'use client'

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, Plus, Search, X } from 'lucide-react'
import { api } from '@/lib/api'
import { getAuthScope, isAuthIdentityChanging, subscribeAuthScope } from '@/lib/authScope'
import { SEARCH_DEBOUNCE_MS } from '@/lib/useDebouncedValue'
import { OPERATIONAL_OVERLAY_LAYERS } from '@/components/operational-overlay/operationalOverlayLayers'
import { OPERATIONAL_OVERLAY_LAYERS as CONTEXTUAL_OVERLAY_LAYERS, useOperationalOverlayPortal, useOperationalOverlayRegistration } from '@/components/operational-window/OperationalOverlayContext'
import { contactTagMenuPosition } from '@/components/contact-details/contactExperience'
import { tagPickerSearchPath, type TagCatalogContext } from './tagPickerSearch'
import type { ContactProfileContext } from '@/types/contact-profile'

export interface TagPickerItem { id: string; name: string; color: string; account_id?: string }
export interface TagPickerProps {
  contactId?: string
  context?: ContactProfileContext
  catalogContext?: TagCatalogContext
  sessionKey?: string
  selected: TagPickerItem[]
  canCreate?: boolean
  allowCreate?: boolean
  disabled?: boolean
  showSelected?: boolean
  mode?: 'single' | 'multiple'
  onChange: (tags: TagPickerItem[]) => void
  onCreatingChange?: (creating: boolean) => void
}
const normalizeTagName = (value: string) => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('es')

export default function TagPicker({ contactId, context, catalogContext, sessionKey = '', selected, canCreate = false, allowCreate = true, disabled = false, showSelected = true, mode = 'multiple', onChange, onCreatingChange }: TagPickerProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<TagPickerItem[]>([])
  const [searching, setSearching] = useState(false)
  const [creating, setCreating] = useState(false)
  const onCreatingChangeRef = useRef(onCreatingChange)
  onCreatingChangeRef.current = onCreatingChange
  useEffect(() => { onCreatingChangeRef.current?.(creating) }, [creating])
  useEffect(() => () => { onCreatingChangeRef.current?.(false) }, [])
  const [error, setError] = useState('')
  const [catalogCanCreate, setCatalogCanCreate] = useState(false)
  const [retry, setRetry] = useState(0)
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [position, setPosition] = useState<ReturnType<typeof contactTagMenuPosition> | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const requestSequence = useRef(0)
  const searchAbortRef = useRef<AbortController | null>(null)
  const searchTimerRef = useRef<number | undefined>(undefined)
  const creationAbortRef = useRef<AbortController | null>(null)
  const creationBusyRef = useRef(false)
  const menuId = useId()
  const portalTarget = useOperationalOverlayPortal()
  const key = `${sessionKey}:${contactId || ''}:${context?.type || catalogContext || ''}:${context?.id || ''}`
  const contextType = context?.type
  const contextId = context?.id
  const creationAllowed = allowCreate && (catalogContext ? catalogCanCreate : canCreate)
  const activeKeyRef = useRef(key)
  activeKeyRef.current = key
  const cleanQuery = query.trim().replace(/\s+/g, ' ')
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const disabledRef = useRef(disabled)
  disabledRef.current = disabled
  const modeRef = useRef(mode)
  modeRef.current = mode
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const selectedIDs = useMemo(() => new Set(selected.map(tag => tag.id)), [selected])
  const availableResults = results.filter(tag => !selectedIDs.has(tag.id))
  const exactMatch = [...selected, ...results].some(tag => normalizeTagName(tag.name) === normalizeTagName(cleanQuery))
  const allowCreation = creationAllowed && Boolean(cleanQuery) && !exactMatch && !searching && !error
  const visible = open && Boolean(cleanQuery) && !disabled
  const optionCount = availableResults.length + Number(allowCreation)
  useOperationalOverlayRegistration(visible, menuId)

  useEffect(() => {
    setQuery(''); setResults([]); setOpen(false); setError(''); setCreating(false); setCatalogCanCreate(false)
    creationBusyRef.current = false
    return () => { requestSequence.current += 1; creationAbortRef.current?.abort() }
  }, [key])
  useEffect(() => subscribeAuthScope(() => {
    requestSequence.current += 1; searchAbortRef.current?.abort(); window.clearTimeout(searchTimerRef.current); creationAbortRef.current?.abort()
    setQuery(''); setResults([]); setOpen(false); setError(''); setCreating(false); setSearching(false); setCatalogCanCreate(false)
    creationBusyRef.current = false
  }), [])
  useEffect(() => {
    const sequence = ++requestSequence.current
    const scope = getAuthScope()
    setError(''); setResults([])
    if (!cleanQuery || disabled || isAuthIdentityChanging(scope)) { setSearching(false); return }
    setSearching(true)
    const controller = new AbortController()
    searchAbortRef.current = controller
    const timer = window.setTimeout(async () => {
      try {
        const path = tagPickerSearchPath({ contactId, context: contextType && contextId ? { type: contextType, id: contextId } : undefined, catalogContext }, cleanQuery)
        const result = await api<{ success: boolean; tags: TagPickerItem[]; can_create?: boolean }>(path, { method: 'GET', signal: controller.signal })
        if (controller.signal.aborted || sequence !== requestSequence.current || scope !== getAuthScope()) return
        if (!result.success || !result.data?.success || !Array.isArray(result.data.tags)) setError(result.error || 'No se pudieron buscar las etiquetas.')
        else { setResults(result.data.tags.slice(0, 20)); setCatalogCanCreate(result.data.can_create === true) }
      } catch {
        if (controller.signal.aborted || sequence !== requestSequence.current || scope !== getAuthScope()) return
        setError('No se pudieron buscar las etiquetas.')
      }
      setActiveIndex(0); setSearching(false)
    }, SEARCH_DEBOUNCE_MS)
    searchTimerRef.current = timer
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [query, cleanQuery, contactId, contextId, contextType, catalogContext, disabled, retry, key])

  useLayoutEffect(() => {
    if (!visible) { setPosition(null); return }
    const update = () => {
      if (!inputRef.current) return
      const viewport = window.visualViewport
      setPosition(contactTagMenuPosition(inputRef.current.getBoundingClientRect(), { left: viewport?.offsetLeft || 0, top: viewport?.offsetTop || 0, width: viewport?.width || window.innerWidth, height: viewport?.height || window.innerHeight }))
    }
    const outside = (event: PointerEvent) => {
      if (!inputRef.current?.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) setOpen(false)
    }
    update()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    if (inputRef.current) observer?.observe(inputRef.current)
    window.addEventListener('resize', update); window.addEventListener('scroll', update, true)
    window.visualViewport?.addEventListener('resize', update); window.visualViewport?.addEventListener('scroll', update)
    document.addEventListener('pointerdown', outside)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true)
      window.visualViewport?.removeEventListener('resize', update); window.visualViewport?.removeEventListener('scroll', update)
      document.removeEventListener('pointerdown', outside)
    }
  }, [visible])
  useEffect(() => { setActiveIndex(current => Math.min(current, Math.max(0, optionCount - 1))) }, [optionCount])
  useEffect(() => { if (visible) document.getElementById(`${menuId}-${activeIndex}`)?.scrollIntoView?.({ block: 'nearest' }) }, [activeIndex, menuId, visible])

  const selectTag = (tag: TagPickerItem) => {
    if (disabledRef.current || selectedRef.current.some(item => item.id === tag.id)) return
    onChangeRef.current(modeRef.current === 'single' ? [tag] : [...selectedRef.current.filter(item => item.id !== tag.id), tag]); setQuery(''); setResults([]); setError(''); setOpen(false)
    inputRef.current?.focus({ preventScroll: true })
  }
  const createTag = async () => {
    if (disabled || !allowCreation || creationBusyRef.current) return
    const requestKey = key
    const scope = getAuthScope()
    const controller = new AbortController()
    creationAbortRef.current?.abort(); creationAbortRef.current = controller
    creationBusyRef.current = true; setCreating(true); setError('')
    try {
      const result = await api<{ success: boolean; tag: TagPickerItem }>('/api/tags', { method: 'POST', body: JSON.stringify({ name: cleanQuery, color: '#6366F1' }), signal: controller.signal })
      if (controller.signal.aborted || activeKeyRef.current !== requestKey || scope !== getAuthScope()) return
      if (!result.success || !result.data?.success || !result.data.tag) { setError(result.error || 'No se pudo crear la etiqueta.'); return }
      selectTag(result.data.tag)
    } catch {
      if (!controller.signal.aborted && activeKeyRef.current === requestKey && scope === getAuthScope()) setError('No se pudo crear la etiqueta.')
    } finally {
      if (!controller.signal.aborted && activeKeyRef.current === requestKey && scope === getAuthScope()) { creationBusyRef.current = false; setCreating(false) }
    }
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && visible) { event.preventDefault(); event.stopPropagation(); inputRef.current?.focus({ preventScroll: true }); setOpen(false); return }
    if (event.key === 'Tab') { setOpen(false); return }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && cleanQuery) {
      event.preventDefault(); setOpen(true)
      setActiveIndex(current => event.key === 'Home' ? 0 : event.key === 'End' ? Math.max(0, optionCount - 1) : Math.max(0, Math.min(optionCount - 1, current + (event.key === 'ArrowDown' ? 1 : -1))))
    } else if (event.key === 'Enter' && visible) {
      event.preventDefault()
      if (availableResults[activeIndex]) selectTag(availableResults[activeIndex])
      else if (allowCreation && activeIndex === availableResults.length) void createTag()
    }
  }
  return <div className="mt-3">
    {showSelected && (selected.length ? <div className="flex flex-wrap gap-2" aria-label="Etiquetas seleccionadas">{selected.map(tag => <span key={tag.id} className="inline-flex min-h-11 max-w-full items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 pl-3 pr-1 text-sm font-semibold text-slate-700"><span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: tag.color || '#64748b' }} /><span className="min-w-0 break-words">{tag.name}</span><button type="button" disabled={disabled || creating} onClick={() => onChange(selected.filter(item => item.id !== tag.id))} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-50" aria-label={`Quitar etiqueta ${tag.name}`}><X className="h-4 w-4" /></button></span>)}</div> : <p className="text-xs italic text-slate-400">Sin etiquetas seleccionadas.</p>)}
    <div className="relative mt-3">
      <Search className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-slate-400" />
      <input ref={inputRef} type="search" value={query} onFocus={() => setOpen(true)} onChange={event => { setQuery(event.target.value); setOpen(true); setActiveIndex(0) }} onKeyDown={onKeyDown} disabled={disabled || creating} placeholder={creationAllowed ? 'Buscar o crear etiqueta' : 'Buscar etiqueta'} aria-label="Buscar o crear etiqueta" role="combobox" aria-autocomplete="list" aria-expanded={visible} aria-controls={visible ? menuId : undefined} aria-activedescendant={visible && optionCount > 0 ? `${menuId}-${activeIndex}` : undefined} aria-busy={searching || creating} className="h-11 w-full rounded-xl border border-slate-300 bg-white pl-10 pr-10 text-base text-slate-900 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 disabled:opacity-50 sm:text-sm" />
      {(searching || creating) && <Loader2 className="absolute right-3 top-3.5 h-4 w-4 animate-spin text-emerald-600" aria-label={creating ? 'Creando etiqueta' : 'Buscando etiquetas'} />}
    </div>
    {visible && position && typeof document !== 'undefined' && createPortal(<div ref={menuRef} id={menuId} data-contact-tag-menu role="listbox" aria-label="Etiquetas disponibles" onKeyDown={onKeyDown} className="pointer-events-auto fixed overflow-y-auto overscroll-contain rounded-xl border border-slate-200 bg-white p-1 shadow-xl" style={{ ...position, zIndex: portalTarget ? CONTEXTUAL_OVERLAY_LAYERS.picker : OPERATIONAL_OVERLAY_LAYERS.picker }}>
      {availableResults.map((tag, index) => <button id={`${menuId}-${index}`} key={tag.id} type="button" role="option" tabIndex={-1} aria-selected={index === activeIndex} disabled={disabled || creating} onPointerMove={() => setActiveIndex(index)} onMouseDown={event => event.preventDefault()} onClick={() => selectTag(tag)} className={`flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-medium text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${index === activeIndex ? 'bg-emerald-50' : 'hover:bg-slate-50'}`}><span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: tag.color || '#64748b' }} /><span className="min-w-0 flex-1 break-words">{tag.name}</span></button>)}
      {searching && <p role="status" className="px-3 py-3 text-xs text-slate-500">Buscando etiquetas…</p>}
      {!searching && !availableResults.length && !allowCreation && !error && <p className="px-3 py-3 text-xs text-slate-500">{exactMatch ? 'La etiqueta ya está seleccionada.' : 'No hay coincidencias.'}</p>}
      {allowCreation && <button id={`${menuId}-${availableResults.length}`} type="button" role="option" tabIndex={-1} aria-selected={activeIndex === availableResults.length} onMouseDown={event => event.preventDefault()} onClick={() => void createTag()} disabled={creating} className={`flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-bold text-emerald-700 disabled:opacity-50 ${activeIndex === availableResults.length ? 'bg-emerald-50' : ''}`}>{creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}<span className="min-w-0 break-words">Crear “{cleanQuery}”</span></button>}
      {error && <p role="alert" className="px-3 py-3 text-xs text-red-600">{error}<button type="button" onClick={() => setRetry(value => value + 1)} className="ml-2 min-h-11 px-2 font-semibold underline">Reintentar</button></p>}
    </div>, portalTarget || document.body)}
    {!visible && error && <p role="alert" className="mt-2 text-xs text-red-600">{error}</p>}
    <p className="mt-2 text-[11px] text-slate-500">Busca una etiqueta para añadirla.{creationAllowed ? ' Puedes crear una si no existe.' : ''}</p>
  </div>
}
