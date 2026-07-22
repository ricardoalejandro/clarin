'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Plus, Search, Tag, X } from 'lucide-react'
import { api } from '@/lib/api'
import type {
  ContactProfileAvailableTag,
  ContactProfileContext,
  ContactProfileTagSearchResponse,
} from '@/types/contact-profile'

interface ContactTagEditorProps {
  contactId: string
  context: ContactProfileContext
  selected: ContactProfileAvailableTag[]
  canCreate: boolean
  disabled?: boolean
  onChange: (tags: ContactProfileAvailableTag[]) => void
}

const normalizeTagName = (value: string) => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('es')

export default function ContactTagEditor({
  contactId,
  context,
  selected,
  canCreate,
  disabled = false,
  onChange,
}: ContactTagEditorProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ContactProfileAvailableTag[]>([])
  const [searching, setSearching] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const requestSequence = useRef(0)

  const cleanQuery = query.trim().replace(/\s+/g, ' ')
  const selectedIDs = useMemo(() => new Set(selected.map(tag => tag.id)), [selected])
  const availableResults = results.filter(tag => !selectedIDs.has(tag.id))
  const exactMatch = [...selected, ...results].some(tag => normalizeTagName(tag.name) === normalizeTagName(cleanQuery))

  useEffect(() => {
    const sequence = ++requestSequence.current
    setError('')
    if (!cleanQuery) {
      setResults([])
      setSearching(false)
      return
    }
    setResults([])
    setSearching(true)
    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      const params = new URLSearchParams({
        context_type: context.type,
        context_id: context.id,
        q: cleanQuery,
        limit: '20',
      })
      const result = await api<ContactProfileTagSearchResponse>(
        `/api/contact-profiles/${contactId}/tags?${params.toString()}`,
        { method: 'GET', signal: controller.signal },
      )
      if (controller.signal.aborted || sequence !== requestSequence.current) return
      if (!result.success || !result.data?.success) {
        setResults([])
        setError(result.error || 'No se pudieron buscar las etiquetas.')
      } else {
        setResults(Array.isArray(result.data.tags) ? result.data.tags : [])
      }
      setSearching(false)
    }, 500)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [cleanQuery, contactId, context.id, context.type])

  const selectTag = (tag: ContactProfileAvailableTag) => {
    if (selectedIDs.has(tag.id)) return
    onChange([...selected, tag])
    setQuery('')
    setResults([])
    setError('')
  }

  const createTag = async () => {
    if (!canCreate || !cleanQuery || exactMatch || creating) return
    setCreating(true)
    setError('')
    const result = await api<{ success: boolean; tag: ContactProfileAvailableTag }>('/api/tags', {
      method: 'POST',
      body: JSON.stringify({ name: cleanQuery, color: '#6366f1' }),
    })
    setCreating(false)
    if (!result.success || !result.data?.success || !result.data.tag) {
      setError(result.error || 'No se pudo crear la etiqueta.')
      return
    }
    selectTag(result.data.tag)
  }

  return (
    <div className="mt-3">
      {selected.length > 0 ? (
        <div className="flex flex-wrap gap-2" aria-label="Etiquetas seleccionadas">
          {selected.map(tag => (
            <span key={tag.id} className="inline-flex min-h-11 max-w-full items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 pl-3 pr-1 text-sm font-semibold text-slate-700">
              <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: tag.color || '#64748b' }} />
              <span className="min-w-0 truncate">{tag.name}</span>
              <button type="button" disabled={disabled} onClick={() => onChange(selected.filter(item => item.id !== tag.id))} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-50" aria-label={`Quitar etiqueta ${tag.name}`}><X className="h-4 w-4" /></button>
            </span>
          ))}
        </div>
      ) : <p className="text-xs italic text-slate-400">Sin etiquetas seleccionadas.</p>}

      <div className="relative mt-3">
        <Search className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-slate-400" />
        <input
          type="search"
          value={query}
          onChange={event => setQuery(event.target.value)}
          disabled={disabled}
          placeholder="Buscar o crear etiqueta"
          aria-label="Buscar o crear etiqueta"
          role="combobox"
          aria-expanded={Boolean(cleanQuery)}
          aria-controls="contact-tag-results"
          className="h-11 w-full rounded-xl border border-slate-300 bg-white pl-10 pr-10 text-base text-slate-900 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 disabled:opacity-50 sm:text-sm"
        />
        {searching && <Loader2 className="absolute right-3 top-3.5 h-4 w-4 animate-spin text-emerald-600" aria-label="Buscando etiquetas" />}
      </div>

      {cleanQuery && (
        <div id="contact-tag-results" className="mt-2 max-h-60 overflow-y-auto overscroll-contain rounded-xl border border-slate-200 bg-white p-1 shadow-sm" role="listbox">
          {availableResults.map(tag => (
            <button key={tag.id} type="button" role="option" aria-selected="false" onClick={() => selectTag(tag)} className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-medium text-slate-700 hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
              <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: tag.color || '#64748b' }} />
              <span className="min-w-0 flex-1 truncate">{tag.name}</span>
            </button>
          ))}
          {!searching && availableResults.length === 0 && !canCreate && <p className="px-3 py-3 text-xs text-slate-400">No hay coincidencias.</p>}
          {!searching && canCreate && !exactMatch && (
            <button type="button" onClick={() => void createTag()} disabled={creating} className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-bold text-emerald-700 hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-50">
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              <span className="min-w-0 truncate">Crear “{cleanQuery}”</span>
            </button>
          )}
          {!searching && exactMatch && availableResults.length === 0 && <p className="px-3 py-3 text-xs text-slate-400">La etiqueta ya está seleccionada.</p>}
        </div>
      )}
      {error && <p className="mt-2 flex items-start gap-1.5 text-xs text-red-600" role="alert"><Tag className="mt-0.5 h-3.5 w-3.5 shrink-0" />{error}</p>}
      <p className="mt-2 text-[11px] leading-relaxed text-slate-400">La búsqueda se ejecuta 500 ms después de dejar de escribir. Solo se muestran coincidencias.</p>
    </div>
  )
}
