'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Building2, Check, ChevronsUpDown, Loader2, Search, X } from 'lucide-react'
import { api } from '@/lib/api'
import { accountOptionsURL, accountRoleLabel } from '@/lib/accountSwitcher'
import { useDebouncedValue } from '@/lib/useDebouncedValue'
import { useAccessibleDialog } from '@/components/pipelines/useAccessibleDialog'

export interface AccountSwitcherOption {
  account_id: string
  account_name: string
  account_slug: string
  role: string
  is_default: boolean
  last_selected_at?: string
}

interface AccountOptionsPage {
  success: boolean
  accounts: AccountSwitcherOption[]
  total: number
  has_more: boolean
  next_cursor?: string
}

interface Props {
  currentAccount: { id: string; name: string }
  accountCount: number
  collapsed: boolean
  onSwitch: (accountID: string) => Promise<string | null>
}

export default function AccountSwitcher({ currentAccount, accountCount, collapsed, onSwitch }: Props) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const requestRef = useRef<AbortController | null>(null)
  const requestGeneration = useRef(0)
  const [mounted, setMounted] = useState(false)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useDebouncedValue(query)
  const [items, setItems] = useState<AccountSwitcherOption[]>([])
  const [nextCursor, setNextCursor] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [switchingID, setSwitchingID] = useState('')
  const [highlighted, setHighlighted] = useState(0)

  useEffect(() => setMounted(true), [])

  const close = useCallback(() => {
    if (switchingID) return
    requestRef.current?.abort()
    requestGeneration.current += 1
    setOpen(false)
    setQuery('')
    setDebouncedQuery('')
    setError('')
  }, [setDebouncedQuery, switchingID])

  useAccessibleDialog(open, panelRef, close, inputRef)

  const load = useCallback(async (settledQuery: string, cursor = '', append = false) => {
    if (append) setLoadingMore(true)
    else setLoading(true)
    setError('')
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    const generation = ++requestGeneration.current
    const response = await api<AccountOptionsPage>(accountOptionsURL(settledQuery, cursor), { signal: controller.signal })
    if (controller.signal.aborted || generation !== requestGeneration.current) return
    setLoading(false)
    setLoadingMore(false)
    if (!response.success || !response.data) {
      setError(response.error || 'No se pudieron cargar tus cuentas.')
      return
    }
    setItems(current => append ? [...current, ...response.data!.accounts.filter(item => !current.some(existing => existing.account_id === item.account_id))] : response.data!.accounts)
    setNextCursor(response.data.next_cursor || '')
    setHighlighted(0)
  }, [])

  useEffect(() => {
    if (!open) return
    void load(debouncedQuery)
  }, [debouncedQuery, load, open])

  useEffect(() => () => requestRef.current?.abort(), [])

  const choose = async (item: AccountSwitcherOption) => {
    if (item.account_id === currentAccount.id || switchingID) return
    setSwitchingID(item.account_id)
    setError('')
    const failure = await onSwitch(item.account_id)
    if (failure) {
      setError(failure)
      setSwitchingID('')
    }
  }

  const activeDescendant = items[highlighted] ? `account-option-${items[highlighted].account_id}` : undefined
  const searched = debouncedQuery.trim().length > 0
  const waiting = query !== debouncedQuery
  const listLabel = searched ? 'Resultados' : 'Cuentas recientes'

  const panel = !mounted || !open ? null : createPortal(
    <div data-account-switcher-backdrop className="fixed inset-0 z-[225] flex items-end justify-center bg-slate-950/50 backdrop-blur-[2px] sm:items-center sm:p-4" onMouseDown={event => { if (event.target === event.currentTarget) close() }}>
      <div ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="account-switcher-title" aria-describedby="account-switcher-description" aria-busy={loading || Boolean(switchingID)} data-account-switcher-layout="centered-modal-mobile-sheet" className="animate-view-enter flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-3xl border border-white/70 bg-white shadow-[0_28px_80px_rgba(15,23,42,0.28)] ring-1 ring-slate-950/5 outline-none motion-reduce:animate-none sm:max-h-[min(680px,calc(100dvh-2rem))] sm:max-w-[520px] sm:rounded-3xl">
        <header className="flex items-start gap-3 border-b border-slate-100 px-4 py-4 sm:px-5 sm:py-5">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-700"><Building2 className="h-5 w-5" /></span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2"><h2 id="account-switcher-title" className="text-xl font-bold tracking-tight text-slate-900">Cambiar cuenta</h2><span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] text-emerald-700">{accountCount.toLocaleString('es-PE')} {accountCount === 1 ? 'cuenta' : 'cuentas'}</span></div>
            <p id="account-switcher-description" className="mt-1 text-sm leading-5 text-slate-500">Elige la cuenta con la que quieres trabajar.</p>
          </div>
          <button type="button" onClick={close} disabled={Boolean(switchingID)} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:cursor-wait disabled:opacity-40" aria-label="Cerrar selector"><X className="h-5 w-5" /></button>
        </header>
        <div className="shrink-0 border-b border-slate-100 px-4 py-3 sm:px-5 sm:py-4">
          <div className="flex min-h-12 items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3.5 transition focus-within:border-emerald-500 focus-within:bg-white focus-within:ring-2 focus-within:ring-emerald-100">
            <Search className="h-4 w-4 shrink-0 text-slate-400" />
            <input ref={inputRef} role="combobox" aria-expanded="true" aria-controls="account-options-list" aria-activedescendant={activeDescendant} disabled={Boolean(switchingID)} value={query} onChange={event => { const value = event.target.value; setQuery(value); if (!value) setDebouncedQuery(''); setHighlighted(0) }} onKeyDown={event => {
              if (event.key === 'Escape') { event.preventDefault(); close() }
              if (event.key === 'ArrowDown') { event.preventDefault(); setHighlighted(index => Math.min(items.length - 1, index + 1)) }
              if (event.key === 'ArrowUp') { event.preventDefault(); setHighlighted(index => Math.max(0, index - 1)) }
              if (event.key === 'Home') { event.preventDefault(); setHighlighted(0) }
              if (event.key === 'End') { event.preventDefault(); setHighlighted(Math.max(0, items.length - 1)) }
              if (event.key === 'Enter' && items[highlighted]) { event.preventDefault(); void choose(items[highlighted]) }
            }} placeholder="Buscar por nombre o slug…" className="min-w-0 flex-1 bg-transparent py-2.5 text-sm text-slate-800 outline-none placeholder:text-slate-400 disabled:cursor-wait" />
            {(waiting || loading) && <Loader2 aria-label={waiting ? 'Esperando para buscar' : 'Buscando cuentas'} className="h-4 w-4 animate-spin text-emerald-500" />}
            {query && !waiting && !switchingID && <button type="button" onClick={() => { setQuery(''); setDebouncedQuery('') }} className="inline-flex min-h-8 min-w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100" aria-label="Limpiar búsqueda"><X className="h-3.5 w-3.5" /></button>}
          </div>
          {error && <div role="alert" className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-700"><p className="min-w-0 flex-1">{error}</p><button type="button" onClick={() => void load(debouncedQuery)} disabled={Boolean(switchingID)} className="min-h-9 shrink-0 rounded-lg px-2 font-semibold underline decoration-rose-300 underline-offset-2 hover:bg-rose-100 disabled:opacity-50">Reintentar</button></div>}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 sm:p-4">
          <p className="px-1 pb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">{listLabel}</p>
          {loading && items.length === 0 && <div aria-label="Cargando cuentas" className="space-y-2">{Array.from({ length: 4 }, (_, index) => <div key={index} className="h-[66px] animate-pulse rounded-2xl border border-slate-100 bg-slate-50" />)}</div>}
          <div id="account-options-list" role="listbox" aria-label={listLabel} className="space-y-2">
            {items.map((item, index) => {
              const selected = item.account_id === currentAccount.id
              const pending = item.account_id === switchingID
              return <button id={`account-option-${item.account_id}`} key={item.account_id} type="button" role="option" aria-selected={selected} disabled={Boolean(switchingID)} onMouseEnter={() => setHighlighted(index)} onClick={() => void choose(item)} className={`flex min-h-[66px] w-full items-center gap-3 rounded-2xl border px-3 py-2.5 text-left outline-none transition duration-150 focus-visible:ring-2 focus-visible:ring-emerald-400 ${selected ? 'border-emerald-200 bg-emerald-50/80 shadow-sm' : index === highlighted ? 'border-slate-200 bg-slate-50 ring-1 ring-slate-100' : 'border-transparent hover:border-slate-200 hover:bg-slate-50'} disabled:cursor-wait disabled:opacity-70`}>
                <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${selected ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}><Building2 className="h-[18px] w-[18px]" /></span>
                <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-slate-800">{item.account_name}</span><span className="mt-0.5 block truncate text-xs text-slate-500">{[item.account_slug, accountRoleLabel(item.role)].filter(Boolean).join(' · ')}</span></span>
                {pending ? <span className="flex shrink-0 items-center gap-2 text-xs font-semibold text-emerald-700"><Loader2 className="h-4 w-4 animate-spin" /><span className="hidden sm:inline">Cambiando</span></span> : selected ? <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-emerald-200 bg-white px-2 py-1 text-[10px] font-bold uppercase tracking-[0.08em] text-emerald-700"><Check className="h-3.5 w-3.5" />Actual</span> : null}
              </button>
            })}
          </div>
          {!loading && items.length === 0 && !error && <div className="px-4 py-10 text-center"><span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-400"><Building2 className="h-5 w-5" /></span><p className="mt-3 text-sm font-semibold text-slate-700">Sin coincidencias</p><p className="mt-1 text-xs leading-5 text-slate-500">Prueba con otra parte del nombre o slug.</p></div>}
          {nextCursor && !error && <button type="button" disabled={loadingMore || Boolean(switchingID)} onClick={() => void load(debouncedQuery, nextCursor, true)} className="mt-2 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl text-sm font-semibold text-emerald-700 transition hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:cursor-wait disabled:opacity-50">{loadingMore && <Loader2 className="h-4 w-4 animate-spin" />}Cargar más</button>}
        </div>
        <p aria-live="polite" className="sr-only">{switchingID ? 'Cambiando de cuenta' : error || ''}</p>
      </div>
    </div>, document.body
  )

  if (accountCount <= 1) {
    return <div title={collapsed ? currentAccount.name : undefined} className={`flex w-full items-center text-slate-400 ${collapsed ? 'justify-center p-2' : 'gap-2 px-2.5 py-1.5'}`}><Building2 className="h-4 w-4 shrink-0 text-slate-500" />{!collapsed && <span className="min-w-0 flex-1 truncate text-left text-xs font-medium">{currentAccount.name || 'Cuenta'}</span>}</div>
  }

  return <>
    <button ref={triggerRef} type="button" onClick={() => setOpen(value => !value)} aria-haspopup="dialog" aria-expanded={open} title={collapsed ? currentAccount.name : undefined} className={`flex min-h-11 w-full items-center rounded-lg text-slate-400 transition hover:bg-slate-700/50 hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/60 ${collapsed ? 'justify-center p-2' : 'gap-2 px-2.5 py-1.5'}`}>
      <Building2 className="h-4 w-4 shrink-0 text-slate-500" />
      {!collapsed && <><span className="min-w-0 flex-1 truncate text-left text-xs font-medium">{currentAccount.name || 'Cuenta'}</span><ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-slate-500" /></>}
    </button>
    {panel}
  </>
}
