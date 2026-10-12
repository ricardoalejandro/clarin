'use client'

import { useEffect, useRef, useState } from 'react'
import { Loader2, Search, X } from 'lucide-react'
import { api } from '@/lib/api'
import { SEARCH_DEBOUNCE_MS } from '@/lib/useDebouncedValue'
import { type EventRuleDraft, type EventRuleTag } from './eventConfiguration'

export default function EventRulesEditor({ value, onChange, disabled = false }: { value: EventRuleDraft; onChange: (rule: EventRuleDraft) => void; disabled?: boolean }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<EventRuleTag[]>([])
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState('')
  const [exclude, setExclude] = useState(false)
  const [retry, setRetry] = useState(0)
  const sequence = useRef(0)
  useEffect(() => {
    const generation = ++sequence.current, controller = new AbortController()
    setError('')
    if (!query.trim() || disabled) { setResults([]); setSearching(false); return () => controller.abort() }
    setSearching(true)
    const timer = window.setTimeout(async () => {
      const response = await api<{ success: boolean; tags: EventRuleTag[] }>('/api/tags?' + new URLSearchParams({ search: query.trim(), limit: '20' }), { signal: controller.signal })
      if (generation !== sequence.current || controller.signal.aborted) return
      if (!response.success || !response.data?.success) setError(response.error || 'No se pudieron buscar etiquetas.')
      else setResults((response.data.tags || []).slice(0, 20))
      setSearching(false)
    }, SEARCH_DEBOUNCE_MS)
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [query, retry, disabled])
  const add = (tag: EventRuleTag) => {
    onChange({ ...value, tags: [...value.tags.filter(item => item.id !== tag.id), { ...tag, negate: exclude }] })
    setQuery(''); setResults([])
  }
  return <div className="space-y-5">
    <div><h3 className="text-base font-semibold text-slate-900">Reglas de incorporación</h3><p className="mt-1 text-sm leading-6 text-slate-500">Las reglas determinan quién puede participar. Revisa el impacto antes de aplicarlas; las salidas conservan su historial.</p></div>
    <div className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-1" role="group" aria-label="Tipo de regla">
      {(['simple', 'advanced'] as const).map(mode => <button key={mode} type="button" disabled={disabled} aria-pressed={value.tag_formula_type === mode} onClick={() => onChange({ ...value, tag_formula_type: mode })} className={'min-h-11 rounded-lg px-4 text-sm font-medium ' + (value.tag_formula_type === mode ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500')}>{mode === 'simple' ? 'Por etiquetas' : 'Fórmula avanzada'}</button>)}
    </div>
    {value.tag_formula_type === 'advanced' ? <div className="space-y-2"><label htmlFor="event-rule-formula" className="text-sm font-medium text-slate-700">Fórmula</label><textarea id="event-rule-formula" value={value.tag_formula} disabled={disabled} onChange={event => onChange({ ...value, tag_formula: event.target.value })} rows={6} spellCheck={false} className="w-full resize-y rounded-xl border border-slate-200 p-3 font-mono text-sm outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100" placeholder={'"Invitados" and not "No contactar"'} /><p className="text-xs leading-5 text-slate-500">Usa nombres entre comillas, and, or, not y paréntesis. La vista previa valida la fórmula con las etiquetas de la cuenta.</p></div> : <>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-sm font-medium text-slate-700">Coincidencia de etiquetas incluidas</span><div className="flex rounded-lg bg-slate-100 p-1">{(['OR', 'AND'] as const).map(mode => <button key={mode} type="button" disabled={disabled} aria-pressed={value.formula_mode === mode} onClick={() => onChange({ ...value, formula_mode: mode })} className={'min-h-11 rounded-lg px-3 text-xs font-medium ' + (value.formula_mode === mode ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500')}>{mode === 'OR' ? 'Cualquiera' : 'Todas'}</button>)}</div></div>
        {([false, true] as const).map(negate => <div key={String(negate)} className="rounded-xl border border-slate-200 p-3"><h4 className="mb-2 text-xs font-semibold text-slate-600">{negate ? 'Excluir siempre' : 'Incluir'}</h4><div className="flex flex-wrap gap-2">{value.tags.filter(tag => Boolean(tag.negate) === negate).map(tag => <span key={tag.id} className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-slate-100 pl-2.5 text-sm text-slate-700"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: tag.color }} />{tag.name}<button type="button" disabled={disabled} aria-label={'Quitar regla ' + tag.name} onClick={() => onChange({ ...value, tags: value.tags.filter(item => item.id !== tag.id) })} className="flex h-11 w-11 items-center justify-center rounded-lg hover:bg-slate-200"><X className="h-3.5 w-3.5" /></button></span>)}{!value.tags.some(tag => Boolean(tag.negate) === negate) && <span className="text-xs text-slate-400">Sin etiquetas</span>}</div></div>)}
      </div>
      <div className="space-y-2">
        <div className="flex items-center gap-2"><span className="text-xs text-slate-500">Añadir etiqueta a</span><button type="button" disabled={disabled} aria-pressed={!exclude} onClick={() => setExclude(false)} className={'min-h-11 rounded-lg px-3 text-xs font-semibold ' + (!exclude ? 'bg-emerald-50 text-emerald-700' : 'text-slate-500')}>Incluir</button><button type="button" disabled={disabled} aria-pressed={exclude} onClick={() => setExclude(true)} className={'min-h-11 rounded-lg px-3 text-xs font-semibold ' + (exclude ? 'bg-rose-50 text-rose-700' : 'text-slate-500')}>Excluir</button></div>
        <div className="relative"><Search className="absolute left-3 top-3.5 h-4 w-4 text-slate-400" /><input aria-label="Buscar etiquetas para reglas" disabled={disabled} value={query} onChange={event => setQuery(event.target.value)} placeholder="Buscar etiqueta…" className="min-h-11 w-full rounded-xl border border-slate-200 pl-10 pr-11 text-sm outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100" />{searching ? <Loader2 className="absolute right-3 top-3.5 h-4 w-4 animate-spin text-emerald-600" /> : query && <button type="button" aria-label="Limpiar búsqueda de etiquetas" onClick={() => setQuery('')} className="absolute right-0 top-0 flex h-11 w-11 items-center justify-center"><X className="h-4 w-4 text-slate-400" /></button>}</div>
        {error && <p role="alert" className="text-xs text-rose-600">{error} <button type="button" onClick={() => setRetry(value => value + 1)} className="min-h-11 px-2 font-semibold underline">Reintentar</button></p>}
        {query.trim() && <div className="max-h-60 overflow-y-auto rounded-xl border border-slate-200" aria-busy={searching}>{results.map(tag => <button key={tag.id} type="button" disabled={disabled || searching} onClick={() => add(tag)} className="flex min-h-11 w-full items-center gap-2 px-3 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-40"><span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: tag.color }} /><span className="min-w-0 flex-1 truncate">{tag.name}</span><span className="text-xs text-slate-400">{exclude ? 'Excluir' : 'Incluir'}</span></button>)}{!results.length && !searching && !error && <p className="p-4 text-sm text-slate-500">No se encontraron etiquetas.</p>}</div>}
      </div>
    </>}
    {!value.tags.length && value.tag_formula_type === 'simple' && <p className="rounded-xl bg-slate-50 p-3 text-sm leading-6 text-slate-600">Sin reglas, puedes incorporar contactos manualmente. Quitar reglas no reactiva automáticamente participaciones históricas.</p>}
  </div>
}
