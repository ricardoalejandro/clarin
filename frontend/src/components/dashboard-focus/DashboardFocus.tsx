'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import { ArrowLeft, Maximize2 } from 'lucide-react'
import {
  DASHBOARD_FOCUS_ARIA_SHORTCUTS,
  DASHBOARD_FOCUS_MEDIA_QUERY,
  DASHBOARD_FOCUS_SHORTCUT_LABEL,
  DASHBOARD_FOCUS_SIDEBAR_ID,
  dashboardFocusHasTemporarySurface,
  dashboardFocusShortcutAllowed,
  dashboardFocusShortcutMatches,
} from './dashboardFocusState'

interface DashboardFocusContextValue {
  hidden: boolean
  available: boolean
  specializedOwnerActive: boolean
  sidebarRef: RefObject<HTMLElement | null>
  restoreBarRef: RefObject<HTMLDivElement | null>
  toggle: () => void
  restore: () => void
  registerSpecializedOwner: (token: symbol) => () => void
}

const DashboardFocusContext = createContext<DashboardFocusContextValue | undefined>(undefined)

export function useDashboardFocus() {
  return useContext(DashboardFocusContext)
}

export function DashboardFocusProvider({ scopeKey, enabled, children }: {
  scopeKey: string
  enabled: boolean
  children: ReactNode
}) {
  const [desktop, setDesktop] = useState(false)
  const [state, setState] = useState({ scopeKey, hidden: false })
  const [specializedOwnerActive, setSpecializedOwnerActive] = useState(false)
  const sidebarRef = useRef<HTMLElement | null>(null)
  const restoreBarRef = useRef<HTMLDivElement | null>(null)
  const specializedOwnersRef = useRef(new Set<symbol>())
  const pointerIDsRef = useRef(new Set<number>())
  const nativeDragRef = useRef(false)
  const invokerRef = useRef<HTMLElement | null>(null)
  const focusAfterCommitRef = useRef<'restore-bar' | 'sidebar' | null>(null)
  const scopeRef = useRef(scopeKey)
  scopeRef.current = scopeKey
  const available = enabled && desktop
  const hidden = available && !specializedOwnerActive && state.scopeKey === scopeKey && state.hidden
  const currentRef = useRef({ available, hidden })
  currentRef.current = { available, hidden }

  useLayoutEffect(() => {
    const media = window.matchMedia(DASHBOARD_FOCUS_MEDIA_QUERY)
    const update = () => setDesktop(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  const clear = useCallback(() => {
    pointerIDsRef.current.clear()
    nativeDragRef.current = false
    invokerRef.current = null
    focusAfterCommitRef.current = null
    setState({ scopeKey: scopeRef.current, hidden: false })
  }, [])

  useLayoutEffect(() => {
    clear()
  }, [clear, scopeKey, available])

  const restore = useCallback(() => {
    if (!currentRef.current.hidden) return
    const active = document.activeElement
    if (active instanceof Node && restoreBarRef.current?.contains(active)) focusAfterCommitRef.current = 'sidebar'
    setState({ scopeKey: scopeRef.current, hidden: false })
  }, [])

  const toggle = useCallback(() => {
    if (!currentRef.current.available || specializedOwnersRef.current.size > 0) return
    if (currentRef.current.hidden) {
      restore()
      return
    }
    const active = document.activeElement
    invokerRef.current = active instanceof HTMLElement && sidebarRef.current?.contains(active) ? active : null
    if (invokerRef.current) focusAfterCommitRef.current = 'restore-bar'
    setState({ scopeKey: scopeRef.current, hidden: true })
  }, [restore])

  const registerSpecializedOwner = useCallback((token: symbol) => {
    specializedOwnersRef.current.add(token)
    setSpecializedOwnerActive(true)
    setState({ scopeKey: scopeRef.current, hidden: false })
    let released = false
    return () => {
      if (released) return
      released = true
      specializedOwnersRef.current.delete(token)
      setSpecializedOwnerActive(specializedOwnersRef.current.size > 0)
    }
  }, [])

  useLayoutEffect(() => {
    const requested = focusAfterCommitRef.current
    focusAfterCommitRef.current = null
    if (requested === 'restore-bar' && hidden) {
      restoreBarRef.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
    } else if (requested === 'sidebar' && !hidden) {
      const target = invokerRef.current?.isConnected
        ? invokerRef.current
        : sidebarRef.current?.querySelector<HTMLElement>('[data-dashboard-focus-enter]')
          || sidebarRef.current?.querySelector<HTMLElement>('button:not([disabled]), a[href]')
      target?.focus({ preventScroll: true })
      invokerRef.current = null
    }
  }, [hidden])

  useEffect(() => {
    const onPageLifecycle = () => clear()
    window.addEventListener('pagehide', onPageLifecycle)
    window.addEventListener('pageshow', onPageLifecycle)
    return () => {
      window.removeEventListener('pagehide', onPageLifecycle)
      window.removeEventListener('pageshow', onPageLifecycle)
    }
  }, [clear])

  useEffect(() => {
    const pointerDown = (event: PointerEvent) => pointerIDsRef.current.add(event.pointerId)
    const pointerEnd = (event: PointerEvent) => pointerIDsRef.current.delete(event.pointerId)
    const dragStart = (event: DragEvent) => { nativeDragRef.current = !event.defaultPrevented }
    const releaseGestures = () => {
      pointerIDsRef.current.clear()
      nativeDragRef.current = false
    }
    const shortcut = (event: KeyboardEvent) => {
      if (!dashboardFocusShortcutMatches(event) || !dashboardFocusShortcutAllowed({
        available: currentRef.current.available,
        specializedOwnerActive: specializedOwnersRef.current.size > 0,
        pointerActive: pointerIDsRef.current.size > 0 || nativeDragRef.current || document.documentElement.classList.contains('kanban-panning'),
        temporarySurfaceOpen: dashboardFocusHasTemporarySurface(),
      })) return
      event.preventDefault()
      toggle()
    }
    document.addEventListener('pointerdown', pointerDown, true)
    document.addEventListener('pointerup', pointerEnd, true)
    document.addEventListener('pointercancel', pointerEnd, true)
    document.addEventListener('dragstart', dragStart)
    document.addEventListener('dragend', releaseGestures, true)
    document.addEventListener('drop', releaseGestures, true)
    window.addEventListener('blur', releaseGestures)
    document.addEventListener('keydown', shortcut)
    return () => {
      document.removeEventListener('pointerdown', pointerDown, true)
      document.removeEventListener('pointerup', pointerEnd, true)
      document.removeEventListener('pointercancel', pointerEnd, true)
      document.removeEventListener('dragstart', dragStart)
      document.removeEventListener('dragend', releaseGestures, true)
      document.removeEventListener('drop', releaseGestures, true)
      window.removeEventListener('blur', releaseGestures)
      document.removeEventListener('keydown', shortcut)
    }
  }, [toggle])

  const context = useMemo(() => ({
    hidden, available, specializedOwnerActive, sidebarRef, restoreBarRef, toggle, restore, registerSpecializedOwner,
  }), [available, hidden, registerSpecializedOwner, restore, specializedOwnerActive, toggle])

  return <DashboardFocusContext.Provider value={context}>{children}</DashboardFocusContext.Provider>
}

export function useDashboardSpecializedFocusOwner() {
  const register = useDashboardFocus()?.registerSpecializedOwner
  const token = useRef(Symbol('dashboard-specialized-focus-owner'))
  useLayoutEffect(() => register?.(token.current), [register])
}

export function DashboardFocusSidebar({ children, className = '' }: { children: ReactNode; className?: string }) {
  const focus = useDashboardFocus()
  const hidden = Boolean(focus?.hidden)
  return <aside
    ref={focus?.sidebarRef}
    id={DASHBOARD_FOCUS_SIDEBAR_ID}
    data-dashboard-sidebar
    data-dashboard-sidebar-hidden={hidden ? 'true' : 'false'}
    aria-hidden={hidden ? true : undefined}
    inert={hidden || undefined}
    style={hidden ? { display: 'none' } : undefined}
    className={className}
  >{children}</aside>
}

export function DashboardFocusEnterButton({ className = '' }: { className?: string }) {
  const focus = useDashboardFocus()
  if (!focus?.available || focus.specializedOwnerActive) return null
  return <button
    type="button"
    data-dashboard-focus-enter
    hidden={focus.hidden || undefined}
    style={focus.hidden ? { display: 'none' } : undefined}
    aria-label="Ocultar menú"
    aria-controls={DASHBOARD_FOCUS_SIDEBAR_ID}
    aria-expanded={!focus.hidden}
    aria-keyshortcuts={DASHBOARD_FOCUS_ARIA_SHORTCUTS}
    title={`Ocultar menú (${DASHBOARD_FOCUS_SHORTCUT_LABEL})`}
    onClick={event => { event.currentTarget.focus({ preventScroll: true }); focus.toggle() }}
    className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-400 transition-colors hover:bg-slate-700/70 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 motion-reduce:transition-none ${className}`}
  ><Maximize2 className="h-[18px] w-[18px]" aria-hidden="true" /></button>
}

export function DashboardFocusRestoreBar() {
  const focus = useDashboardFocus()
  if (!focus?.hidden) return null
  return <div ref={focus.restoreBarRef} data-dashboard-focus-restore-bar className="flex h-11 min-h-11 shrink-0 items-center border-b border-slate-200/80 bg-white px-2">
    <button
      type="button"
      onClick={focus.restore}
      aria-controls={DASHBOARD_FOCUS_SIDEBAR_ID}
      aria-expanded={false}
      aria-keyshortcuts={DASHBOARD_FOCUS_ARIA_SHORTCUTS}
      className="inline-flex h-11 items-center gap-2 rounded-lg px-2 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500 motion-reduce:transition-none"
    ><ArrowLeft className="h-4 w-4" aria-hidden="true" /><span>Mostrar menú</span><kbd className="ml-2 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">{DASHBOARD_FOCUS_SHORTCUT_LABEL}</kbd></button>
    <span role="status" aria-live="polite" className="sr-only">Menú oculto. Puedes mostrarlo con el botón Mostrar menú o con {DASHBOARD_FOCUS_SHORTCUT_LABEL}.</span>
  </div>
}
