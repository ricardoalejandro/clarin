'use client'

import { useId, useRef, useState, type KeyboardEvent } from 'react'
import { Check, ChevronDown, Search, X } from 'lucide-react'
import EditorPopover from '@/components/documents/EditorPopover'
import { useDebouncedValue } from '@/lib/useDebouncedValue'
import { documentFormat, filterDocumentFormats, type DocumentFormat } from './documentFormats'

export function DocumentFormatPicker({ value, disabled, className, width, onChange }: {
  value: DocumentFormat; disabled?: boolean; className?: string; width: number; onChange: (format: DocumentFormat) => void
}) {
  const trigger = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [settledQuery, settleQuery] = useDebouncedValue(query)
  const [focused, setFocused] = useState<DocumentFormat>(value)
  const id = `document-format-${useId().replace(/:/g, '')}`
  const results = filterDocumentFormats(settledQuery)
  const active = results.some(format => format.id === focused) ? focused : results[0]?.id
  const choose = (format: DocumentFormat) => { onChange(format); setOpen(false); trigger.current?.focus({ preventScroll: true }) }
  const key = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && active) { event.preventDefault(); choose(active); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !results.length) return
    event.preventDefault()
    const index = results.findIndex(format => format.id === active)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? results.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + results.length) % results.length
    setFocused(results[next].id)
    document.getElementById(`${id}-${results[next].id}`)?.scrollIntoView?.({ block: 'nearest' })
  }
  return <>
    <button ref={trigger} type="button" role="combobox" aria-label="Formato del documento" aria-haspopup="listbox" aria-expanded={open}
      aria-controls={open ? id : undefined} aria-description={`Formato actual: ${documentFormat(value).label}`} disabled={disabled} className={`${className} inline-flex items-center justify-between gap-1`} style={{ width, paddingInline: 6 }} title={documentFormat(value).label}
      onKeyDown={event => { if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setFocused(value); setQuery(''); settleQuery(''); setOpen(true) } }}
      onClick={() => { setFocused(value); setQuery(''); settleQuery(''); setOpen(current => !current) }}>
      <span>{documentFormat(value).shortLabel}</span><ChevronDown size={13} aria-hidden className="shrink-0" />
    </button>
    {open && <EditorPopover anchor={trigger.current} width={320} label="Elegir formato del documento" onClose={() => setOpen(false)}>
      <div className="flex items-center gap-1 rounded-lg border border-slate-200 px-2" onKeyDown={key}>
        <Search size={15} aria-hidden className="shrink-0 text-slate-400" />
        <input role="combobox" aria-label="Buscar formato" aria-autocomplete="list" aria-expanded aria-controls={id} aria-activedescendant={active ? `${id}-${active}` : undefined}
          className="utility-field min-w-0 flex-1 bg-transparent text-xs outline-none" value={query} onChange={event => { setQuery(event.target.value); if (!event.target.value) settleQuery('') }} />
        {query && <button type="button" className="utility-control px-1" aria-label="Limpiar búsqueda de formatos" onClick={() => { setQuery(''); settleQuery('') }}><X size={14} aria-hidden /></button>}
      </div>
      {query !== settledQuery && <p role="status" className="px-2 py-1 text-xs text-slate-500">Preparando búsqueda…</p>}
      <div id={id} role="listbox" aria-label="Formatos del documento" className="mt-1 max-h-72 overflow-y-auto" onKeyDown={key}>
        {results.map(format => <button id={`${id}-${format.id}`} key={format.id} type="button" role="option" aria-selected={value === format.id}
          className={`flex min-h-11 w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 ${active === format.id ? 'bg-emerald-50' : 'hover:bg-slate-100'}`}
          onFocus={() => setFocused(format.id)} onClick={() => choose(format.id)}>
          <span className="min-w-0 flex-1"><span className="block text-xs font-medium">{format.label}</span><span className="block text-[11px] text-slate-500">{format.description}</span></span>
          {value === format.id && <Check size={15} aria-hidden className="shrink-0 text-emerald-700" />}
        </button>)}
        {!results.length && <p className="p-2 text-xs text-slate-500">No hay formatos que coincidan.</p>}
      </div>
    </EditorPopover>}
  </>
}
