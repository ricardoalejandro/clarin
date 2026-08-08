'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import {
  ArrowLeft,
  BookOpenCheck,
  Building2,
  ClipboardList,
  Contact,
  LogOut,
  MessageSquare,
  ShieldAlert,
  UserRound,
  WifiOff,
  X,
  ListChecks,
  type LucideIcon,
} from 'lucide-react'
import AccountSwitcher from '@/components/AccountSwitcher'
import TaskBadge from '@/components/TaskBadge'
import { useAccessibleDialog } from '@/components/pipelines/useAccessibleDialog'
import type { MobileAppModule, MobileAppModuleKey } from '@/lib/mobileApp'

const MODULE_ICONS: Record<MobileAppModuleKey, LucideIcon> = {
  chats: MessageSquare,
  contacts: Contact,
  programs: BookOpenCheck,
  surveys: ClipboardList,
  tasks: ListChecks,
}

export interface MobileAppUserSummary {
  username: string
  display_name: string
  role: string
  account_id: string
  account_name: string
  is_admin: boolean
  is_super_admin: boolean
}

function roleLabel(user: MobileAppUserSummary) {
  if (user.is_super_admin) return 'Super Admin'
  if (user.is_admin) return 'Admin'
  return user.role || 'Usuario'
}

export function MobileAppHeader({
  user,
  accountCount,
  activeLabel,
  version,
  hidden,
  onSwitchAccount,
  onLogout,
}: {
  user: MobileAppUserSummary
  accountCount: number
  activeLabel: string
  version: string
  hidden: boolean
  onSwitchAccount: (accountID: string) => Promise<string | null>
  onLogout: () => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const close = () => { if (!loggingOut) setOpen(false) }
  useAccessibleDialog(open, panelRef, close, closeRef)

  const panel = open && typeof document !== 'undefined' ? createPortal(
    <div className="app-viewport fixed z-[220] flex items-end justify-center bg-slate-950/55 backdrop-blur-[2px] sm:items-center sm:p-4" onMouseDown={event => { if (event.target === event.currentTarget) close() }}>
      <div ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="mobile-account-title" className="animate-view-enter flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-3xl border border-white/70 bg-white shadow-[0_28px_80px_rgba(15,23,42,0.32)] outline-none motion-reduce:animate-none sm:max-w-md sm:rounded-3xl">
        <header className="flex items-start gap-3 border-b border-slate-100 px-4 py-4 sm:px-5">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-emerald-100 text-lg font-bold text-emerald-700">{(user.display_name || user.username).charAt(0).toUpperCase()}</span>
          <div className="min-w-0 flex-1"><h2 id="mobile-account-title" className="truncate text-xl font-bold tracking-tight text-slate-900">{user.display_name || user.username}</h2><p className="mt-1 truncate text-sm text-slate-500">{roleLabel(user)}</p></div>
          <button ref={closeRef} type="button" onClick={close} disabled={loggingOut} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 hover:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:opacity-40" aria-label="Cerrar cuenta"><X className="h-5 w-5" /></button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
          <p className="mb-2 px-1 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">Cuenta activa</p>
          <div className="rounded-2xl border border-slate-700/70 bg-slate-800 p-2 shadow-sm">
            <AccountSwitcher currentAccount={{ id: user.account_id, name: user.account_name || 'Cuenta' }} accountCount={accountCount} collapsed={false} onSwitch={onSwitchAccount} />
          </div>
          <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
            <div className="flex items-center gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white text-slate-500 shadow-sm"><Building2 className="h-4 w-4" /></span><div className="min-w-0"><p className="truncate text-sm font-semibold text-slate-800">{user.account_name || 'Cuenta'}</p><p className="mt-0.5 text-xs text-slate-500">Clarin móvil · v{version}</p></div></div>
          </div>
        </div>
        <div className="border-t border-slate-100 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 sm:px-5">
          <button type="button" disabled={loggingOut} onClick={async () => { setLoggingOut(true); await onLogout() }} className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 text-sm font-semibold text-rose-700 transition hover:bg-rose-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400 disabled:cursor-wait disabled:opacity-50"><LogOut className="h-4 w-4" />{loggingOut ? 'Cerrando sesión…' : 'Cerrar sesión'}</button>
        </div>
      </div>
    </div>, document.body
  ) : null

  if (hidden) return panel

  return (
    <>
      <header data-testid="mobile-app-header" className="safe-area-top safe-area-x flex min-h-[calc(3.5rem+env(safe-area-inset-top))] shrink-0 items-center border-b border-slate-700/80 bg-slate-800 text-white shadow-sm">
        <div className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-1.5 sm:px-4">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-emerald-500 text-white shadow-sm shadow-emerald-950/30"><MessageSquare className="h-[17px] w-[17px]" /></span>
          <div className="min-w-0"><p className="truncate text-sm font-bold leading-4">Clarin</p><p className="mt-0.5 truncate text-[10px] font-semibold uppercase tracking-[0.12em] text-emerald-300">{activeLabel}</p></div>
        </div>
        <button ref={triggerRef} type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open} className="mr-3 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-200 transition hover:bg-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 sm:mr-4" aria-label="Abrir cuenta"><span className="flex h-8 w-8 items-center justify-center rounded-xl bg-emerald-500/15 text-sm font-bold text-emerald-300 ring-1 ring-emerald-400/25">{(user.display_name || user.username).charAt(0).toUpperCase()}</span></button>
      </header>
      {panel}
    </>
  )
}

export function MobileAppBottomNavigation({
  modules,
  pathname,
  hidden,
}: {
  modules: readonly MobileAppModule[]
  pathname: string
  hidden: boolean
}) {
  if (hidden || modules.length === 0) return null

  return (
    <nav data-testid="mobile-app-bottom-navigation" aria-label="Módulos de Clarin móvil" className="safe-area-bottom safe-area-x z-20 shrink-0 border-t border-slate-200/90 bg-white/95 shadow-[0_-10px_30px_rgba(15,23,42,0.06)] backdrop-blur-xl">
      <div className="mx-auto grid min-h-16 max-w-2xl" style={{ gridTemplateColumns: `repeat(${modules.length}, minmax(0, 1fr))` }}>
        {modules.map(module => {
          const Icon = MODULE_ICONS[module.key]
          const active = pathname === module.href || pathname.startsWith(`${module.href}/`)
          return (
            <Link key={module.key} href={module.href} aria-current={active ? 'page' : undefined} className={`group relative flex min-h-16 min-w-0 flex-col items-center justify-center gap-1 px-1 py-1.5 text-[10px] font-semibold transition-colors focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500 ${active ? 'text-emerald-700' : 'text-slate-400 hover:bg-slate-50 hover:text-slate-700'}`}>
              <span className={`relative flex h-8 min-w-10 items-center justify-center rounded-xl px-2 transition-all duration-200 motion-reduce:transition-none ${active ? 'bg-emerald-100 text-emerald-700 shadow-sm shadow-emerald-600/10' : 'text-slate-400 group-hover:bg-slate-100 group-hover:text-slate-600'}`}><Icon className="h-[18px] w-[18px]" />{module.key === 'tasks' && <span className="absolute -right-1 -top-1 [&>span]:!m-0 [&>span]:!h-4 [&>span]:!min-w-4 [&>span]:!px-1 [&>span]:!text-[9px]"><TaskBadge /></span>}</span>
              <span className="max-w-full truncate">{module.label}</span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}

export function MobileOfflineStatus() {
  const [online, setOnline] = useState(true)

  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  if (online) return null
  return <div role="status" aria-live="polite" className="safe-area-x flex min-h-10 shrink-0 items-center justify-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2 text-center text-xs font-semibold text-amber-800"><WifiOff className="h-4 w-4 shrink-0" />Sin conexión. Conservamos esta pantalla; reintenta cuando vuelva internet.</div>
}

export function MobileUnavailableSurface({
  returnHref,
  noModules = false,
  permissionDenied = false,
}: {
  returnHref: string
  noModules?: boolean
  permissionDenied?: boolean
}) {
  const title = noModules
    ? 'Sin módulos móviles disponibles'
    : permissionDenied
      ? 'No tienes acceso a este módulo'
      : 'Disponible en la versión completa'
  const description = noModules
    ? 'Tu usuario no tiene acceso a ninguno de los módulos incluidos en Clarin móvil.'
    : permissionDenied
      ? 'El acceso depende de los permisos de tu cuenta. Puedes volver a uno de tus módulos disponibles.'
      : 'Este módulo no forma parte de Clarin móvil por ahora. La versión completa no ha sido modificada.'

  return (
    <section className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto bg-slate-50 p-4 sm:p-6">
      <div className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-6 text-center shadow-sm sm:p-8">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-slate-500">{noModules || permissionDenied ? <ShieldAlert className="h-6 w-6" /> : <UserRound className="h-6 w-6" />}</span>
        <h1 className="mt-4 text-xl font-bold tracking-tight text-slate-900">{title}</h1>
        <p className="mt-2 text-sm leading-6 text-slate-500">{description}</p>
        {returnHref && <Link href={returnHref} className="mt-5 inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-5 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2"><ArrowLeft className="h-4 w-4" />Volver a Clarin móvil</Link>}
      </div>
    </section>
  )
}
