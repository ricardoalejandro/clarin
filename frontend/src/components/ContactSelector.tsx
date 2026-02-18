'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { Search, X, Filter, Users, CheckCircle2, User, Tag, ChevronDown } from 'lucide-react'

interface PersonResult {
  id: string
  name: string
  phone: string
  email: string
  source_type: 'contact' | 'lead'
  tags?: { id: string; name: string; color: string }[]
}

interface TagItem {
  id: string
  name: string
  color: string
}

export interface SelectedPerson {
  id: string
  name: string
  phone: string
  email: string
  source_type: 'contact' | 'lead'
}

interface ContactSelectorProps {
  open: boolean
  onClose: () => void
  onConfirm: (selected: SelectedPerson[]) => void
  title?: string
  subtitle?: string
  confirmLabel?: string
  /** Exclude these IDs from results (e.g. already-added participants) */
  excludeIds?: Set<string>
}

export default function ContactSelector({
  open,
  onClose,
  onConfirm,
  title = 'Seleccionar Personas',
  subtitle = 'Busca entre tus contactos y leads',
  confirmLabel = 'Agregar',
  excludeIds,
}: ContactSelectorProps) {
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [results, setResults] = useState<PersonResult[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<Map<string, SelectedPerson>>(new Map())

  // Filters
  const [sourceType, setSourceType] = useState<'all' | 'contact' | 'lead'>('all')
  const [showFilterDropdown, setShowFilterDropdown] = useState(false)
  const [allTags, setAllTags] = useState<TagItem[]>([])
  const [filterTagIds, setFilterTagIds] = useState<Set<string>>(new Set())
  const [tagSearch, setTagSearch] = useState('')
  const [hasPhone, setHasPhone] = useState(false)

  const filterRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : ''

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 500)
    return () => clearTimeout(t)
  }, [search])

  // Focus search on open
  useEffect(() => {
    if (open) {
      setTimeout(() => searchRef.current?.focus(), 100)
      fetchTags()
    } else {
      // Reset state on close
      setSearch('')
      setDebouncedSearch('')
      setResults([])
      setSelected(new Map())
      setSourceType('all')
      setFilterTagIds(new Set())
      setHasPhone(false)
      setShowFilterDropdown(false)
      setTagSearch('')
    }
  }, [open])

  // Fetch people when search/filters change
  useEffect(() => {
    if (!open) return
    fetchPeople()
  }, [debouncedSearch, sourceType, filterTagIds, hasPhone, open])

  // Click outside to close filter dropdown
  useEffect(() => {
    if (!showFilterDropdown) { setTagSearch(''); return }
    const handler = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setShowFilterDropdown(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showFilterDropdown])

  const fetchTags = useCallback(async () => {
    try {
      const res = await fetch('/api/tags', { headers: { Authorization: `Bearer ${token}` } })
      const data = await res.json()
      if (data.success) setAllTags(data.tags || [])
    } catch (e) { console.error(e) }
  }, [token])

  const fetchPeople = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (debouncedSearch) params.set('search', debouncedSearch)
      if (sourceType !== 'all') params.set('type', sourceType)
      if (filterTagIds.size > 0) params.set('tag_ids', Array.from(filterTagIds).join(','))
      if (hasPhone) params.set('has_phone', 'true')
      params.set('limit', '100')

      const res = await fetch(`/api/people/search?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) {
        const filtered = excludeIds
          ? (data.people || []).filter((p: PersonResult) => !excludeIds.has(p.id))
          : data.people || []
        setResults(filtered)
        setTotal(data.total || 0)
      }
    } catch (e) { console.error(e) } finally { setLoading(false) }
  }, [debouncedSearch, sourceType, filterTagIds, hasPhone, token, excludeIds])

  const toggleSelect = (person: PersonResult) => {
    const next = new Map(selected)
    if (next.has(person.id)) {
      next.delete(person.id)
    } else {
      next.set(person.id, {
        id: person.id,
        name: person.name,
        phone: person.phone,
        email: person.email,
        source_type: person.source_type,
      })
    }
    setSelected(next)
  }

  const selectAll = () => {
    const next = new Map(selected)
    results.forEach(p => {
      if (!next.has(p.id)) {
        next.set(p.id, { id: p.id, name: p.name, phone: p.phone, email: p.email, source_type: p.source_type })
      }
    })
    setSelected(next)
  }

  const handleConfirm = () => {
    onConfirm(Array.from(selected.values()))
  }

  const activeFilterCount = (sourceType !== 'all' ? 1 : 0) + (filterTagIds.size > 0 ? 1 : 0) + (hasPhone ? 1 : 0)

  // Tag search with wildcard support (% as wildcard, like leads page)
  const filteredTags = allTags.filter(tag => {
    if (!tagSearch.trim()) return true
    const term = tagSearch.trim()
    if (term.includes('%')) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')
      try { return new RegExp(`^${escaped}$`, 'i').test(tag.name) } catch { return true }
    }
    return tag.name.toLowerCase().includes(term.toLowerCase())
  })

  if (!open) return null

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-5xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
            <p className="text-sm text-gray-500 mt-0.5">{subtitle}</p>
          </div>
          <button onClick={onClose} className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Search + Filters */}
        <div className="px-6 py-4 border-b border-gray-100 space-y-3">
          <div className="flex gap-3">
            <div ref={filterRef} className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                ref={searchRef}
                value={search}
                onChange={e => setSearch(e.target.value)}
                onFocus={() => setShowFilterDropdown(true)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); setShowFilterDropdown(false) } }}
                placeholder="Buscar por nombre, teléfono, email..."
                className="w-full pl-10 pr-10 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent text-gray-900 text-sm"
              />
              <button
                onClick={() => setShowFilterDropdown(!showFilterDropdown)}
                className={`absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-md transition ${activeFilterCount > 0 ? 'bg-green-100 text-green-700' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'}`}
              >
                <Filter className="w-4 h-4" />
                {activeFilterCount > 0 && (
                  <span className="absolute -top-1 -right-1 w-4 h-4 bg-green-600 text-white text-[10px] rounded-full flex items-center justify-center">{activeFilterCount}</span>
                )}
              </button>

              {/* Filter Dropdown */}
              {showFilterDropdown && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-xl shadow-xl z-30 max-h-[400px] overflow-y-auto">
                  <div className="p-3 border-b border-gray-100 flex items-center justify-between">
                    <span className="text-sm font-semibold text-gray-700">Filtros</span>
                    <div className="flex items-center gap-2">
                      {activeFilterCount > 0 && (
                        <button
                          onClick={() => { setSourceType('all'); setFilterTagIds(new Set()); setHasPhone(false) }}
                          className="text-xs text-red-500 hover:text-red-700"
                        >
                          Limpiar filtros
                        </button>
                      )}
                      <button onClick={() => setShowFilterDropdown(false)} className="p-0.5 hover:bg-gray-100 rounded">
                        <X className="w-4 h-4 text-gray-400" />
                      </button>
                    </div>
                  </div>

                  {/* Source type filter */}
                  <div className="p-3 border-b border-gray-100">
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Tipo</p>
                    <div className="flex flex-wrap gap-1.5">
                      {[
                        { value: 'all' as const, label: 'Todos' },
                        { value: 'contact' as const, label: 'Contactos' },
                        { value: 'lead' as const, label: 'Leads' },
                      ].map(opt => (
                        <button
                          key={opt.value}
                          onClick={() => setSourceType(opt.value)}
                          className={`px-3 py-1.5 rounded-full text-xs font-medium transition border ${
                            sourceType === opt.value
                              ? 'border-green-300 bg-green-50 text-green-700'
                              : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Has phone filter */}
                  <div className="p-3 border-b border-gray-100">
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Teléfono</p>
                    <button
                      onClick={() => setHasPhone(!hasPhone)}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                        hasPhone ? 'bg-green-50 border-green-300 text-green-700' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
                      }`}
                    >
                      Solo con teléfono
                    </button>
                  </div>

                  {/* Tag filters */}
                  {allTags.length > 0 && (
                    <div className="p-3">
                      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Etiquetas</p>
                      <div className="relative mb-2">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                        <input
                          value={tagSearch}
                          onChange={e => setTagSearch(e.target.value)}
                          placeholder="Buscar... (usa % como comodín)"
                          className="w-full pl-8 pr-3 py-1.5 bg-gray-50 border border-gray-200 rounded-lg text-xs text-gray-800 placeholder:text-gray-400 focus:ring-2 focus:ring-green-500 focus:border-green-500"
                        />
                      </div>
                      {filterTagIds.size > 0 && (
                        <div className="flex flex-wrap gap-1 mb-2">
                          {Array.from(filterTagIds).map(tid => {
                            const tag = allTags.find(t => t.id === tid)
                            if (!tag) return null
                            return (
                              <span
                                key={tid}
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium text-white"
                                style={{ backgroundColor: tag.color || '#6b7280' }}
                              >
                                {tag.name}
                                <button onClick={() => { const n = new Set(filterTagIds); n.delete(tid); setFilterTagIds(n) }} className="hover:opacity-75">
                                  <X className="w-2.5 h-2.5" />
                                </button>
                              </span>
                            )
                          })}
                        </div>
                      )}
                      <div className="max-h-[200px] overflow-y-auto space-y-0.5">
                        {filteredTags.map(tag => {
                          const isActive = filterTagIds.has(tag.id)
                          return (
                            <label
                              key={tag.id}
                              className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-gray-50 cursor-pointer transition"
                            >
                              <input
                                type="checkbox"
                                checked={isActive}
                                onChange={() => {
                                  const next = new Set(filterTagIds)
                                  if (isActive) next.delete(tag.id); else next.add(tag.id)
                                  setFilterTagIds(next)
                                }}
                                className="w-3.5 h-3.5 rounded border-gray-300 text-green-600 focus:ring-green-500"
                              />
                              <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: tag.color || '#6b7280' }} />
                              <span className="flex-1 text-xs text-gray-700">{tag.name}</span>
                            </label>
                          )
                        })}
                        {filteredTags.length === 0 && tagSearch.trim() && (
                          <p className="text-xs text-gray-400 text-center py-2">Sin resultados</p>
                        )}
                      </div>
                    </div>
                  )}

                  <div className="p-3 border-t border-gray-100 sticky bottom-0 bg-white rounded-b-xl">
                    <button
                      onClick={() => setShowFilterDropdown(false)}
                      className="w-full px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition text-sm font-medium"
                    >
                      Aplicar
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Active filter badges */}
          {activeFilterCount > 0 && (
            <div className="flex flex-wrap gap-2">
              {sourceType !== 'all' && (
                <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-green-50 text-green-700 rounded-full text-xs font-medium border border-green-200">
                  {sourceType === 'contact' ? 'Contactos' : 'Leads'}
                  <button onClick={() => setSourceType('all')} className="hover:text-green-900"><X className="w-3 h-3" /></button>
                </span>
              )}
              {hasPhone && (
                <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-green-50 text-green-700 rounded-full text-xs font-medium border border-green-200">
                  Con teléfono
                  <button onClick={() => setHasPhone(false)} className="hover:text-green-900"><X className="w-3 h-3" /></button>
                </span>
              )}
              {Array.from(filterTagIds).map(tid => {
                const tag = allTags.find(t => t.id === tid)
                if (!tag) return null
                return (
                  <span
                    key={tid}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium text-white"
                    style={{ backgroundColor: tag.color || '#6b7280' }}
                  >
                    {tag.name}
                    <button onClick={() => { const n = new Set(filterTagIds); n.delete(tid); setFilterTagIds(n) }} className="hover:opacity-75"><X className="w-3 h-3" /></button>
                  </span>
                )
              })}
            </div>
          )}
        </div>

        {/* Results */}
        <div className="flex-1 overflow-hidden flex flex-col min-h-0">
          {/* Selection info bar */}
          <div className="flex items-center justify-between px-6 py-2.5 bg-gray-50 border-b border-gray-100">
            <div className="flex items-center gap-3">
              <span className="text-xs text-gray-500">
                {loading ? 'Buscando...' : `${results.length} resultado${results.length !== 1 ? 's' : ''}`}
                {total > results.length && ` de ${total}`}
              </span>
              {results.length > 0 && (
                <button onClick={selectAll} className="text-xs text-green-600 hover:text-green-700 font-medium">
                  Seleccionar todos
                </button>
              )}
            </div>
            {selected.size > 0 && (
              <span className="text-xs font-medium text-green-700 bg-green-100 px-2.5 py-1 rounded-full">
                {selected.size} seleccionado{selected.size !== 1 ? 's' : ''}
              </span>
            )}
          </div>

          {/* Selected pills */}
          {selected.size > 0 && (
            <div className="px-6 py-3 border-b border-gray-100 bg-green-50/50">
              <div className="flex flex-wrap gap-1.5">
                {Array.from(selected.values()).map(p => (
                  <span key={p.id} className="inline-flex items-center gap-1 px-2.5 py-1 bg-green-100 text-green-700 rounded-full text-xs font-medium">
                    {p.name || p.phone || 'Sin nombre'}
                    <span className={`px-1 py-0 rounded text-[9px] font-bold ${p.source_type === 'contact' ? 'bg-blue-100 text-blue-600' : 'bg-purple-100 text-purple-600'}`}>
                      {p.source_type === 'contact' ? 'C' : 'L'}
                    </span>
                    <button onClick={() => { const n = new Map(selected); n.delete(p.id); setSelected(n) }} className="hover:text-green-900">
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Results list */}
          <div className="flex-1 overflow-y-auto px-6 py-2">
            {loading ? (
              <div className="space-y-2 py-2">
                {[...Array(6)].map((_, i) => (
                  <div key={i} className="h-14 bg-gray-100 rounded-lg animate-pulse" />
                ))}
              </div>
            ) : results.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <Users className="w-12 h-12 text-gray-300 mb-3" />
                <p className="text-gray-500 font-medium">
                  {debouncedSearch || activeFilterCount > 0 ? 'No se encontraron resultados' : 'Escribe para buscar contactos y leads'}
                </p>
                <p className="text-gray-400 text-sm mt-1">
                  {debouncedSearch ? 'Intenta con otro término o ajusta los filtros' : 'La búsqueda es por nombre, teléfono o email'}
                </p>
              </div>
            ) : (
              <div className="space-y-1 py-1">
                {results.map(person => {
                  const isSelected = selected.has(person.id)
                  return (
                    <button
                      key={person.id}
                      onClick={() => toggleSelect(person)}
                      className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg border text-left transition-all ${
                        isSelected ? 'border-green-300 bg-green-50 shadow-sm' : 'border-gray-200 hover:bg-gray-50 hover:border-gray-300'
                      }`}
                    >
                      <div className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-semibold flex-shrink-0 ${
                        isSelected ? 'bg-green-200 text-green-700' : 'bg-gray-200 text-gray-600'
                      }`}>
                        {person.name ? person.name.charAt(0).toUpperCase() : '?'}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-gray-900 truncate">{person.name || 'Sin nombre'}</p>
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                            person.source_type === 'contact'
                              ? 'bg-blue-100 text-blue-600'
                              : 'bg-purple-100 text-purple-600'
                          }`}>
                            {person.source_type === 'contact' ? 'Contacto' : 'Lead'}
                          </span>
                        </div>
                        <div className="flex items-center gap-3 mt-0.5">
                          {person.phone && <span className="text-xs text-gray-500">{person.phone}</span>}
                          {person.email && <span className="text-xs text-gray-400">{person.email}</span>}
                        </div>
                        {person.tags && person.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {person.tags.slice(0, 4).map(tag => (
                              <span
                                key={tag.id}
                                className="px-1.5 py-0.5 text-[10px] rounded-full text-white font-medium"
                                style={{ backgroundColor: tag.color || '#6b7280' }}
                              >
                                {tag.name}
                              </span>
                            ))}
                            {person.tags.length > 4 && (
                              <span className="text-[10px] text-gray-400">+{person.tags.length - 4}</span>
                            )}
                          </div>
                        )}
                      </div>
                      {isSelected && <CheckCircle2 className="w-5 h-5 text-green-600 flex-shrink-0" />}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-between">
          <button onClick={onClose} className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors text-sm">
            Cancelar
          </button>
          <button
            onClick={handleConfirm}
            disabled={selected.size === 0}
            className="px-6 py-2.5 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 font-medium text-sm transition-colors shadow-sm"
          >
            {confirmLabel} {selected.size > 0 ? `(${selected.size})` : ''}
          </button>
        </div>
      </div>
    </div>
  )
}
