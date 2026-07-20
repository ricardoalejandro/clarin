'use client'

import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import NotificationProvider from '@/components/NotificationProvider'
import ErosAssistant from '@/components/ErosAssistant'
import TaskBadge from '@/components/TaskBadge'
import { ChatMobileChromeProvider } from '@/components/chat/ChatMobileChromeContext'
import { subscribeWebSocket, onServerVersionChange, initIdleTimeout, clearIdleTimeout, tryRefreshToken, clearAuthState, isAuthIdleExpired, logoutFromBrowser, markAuthSession } from '@/lib/api'
import {
  MessageSquare,
  Settings,
  LogOut,
  Menu,
  X,
  LayoutDashboard,
  Contact,
  PanelLeftClose,
  PanelLeftOpen,
  Tags,
  Shield,
  ChevronsUpDown,
  Building2,
  BookOpenCheck,
  Workflow,
  CalendarCheck,
  Radio,
  ClipboardList,
  ListChecks,
  Sparkles,
  Files,
  Database,
  Handshake,
  RefreshCw,
  FileText,
  Bot,
  AlertTriangle,
  CreditCard,
  Smartphone,
  Monitor,
  BarChart3,
  CloudCog,
} from 'lucide-react'

interface User {
  id: string
  username: string
  display_name: string
  is_admin: boolean
  is_super_admin: boolean
  role: string
  account_id: string
  account_name: string
  plan?: string
  subscription_status?: string
  subscription_active?: boolean
  subscription_reason?: string
  subscription_days_left?: number | null
  permissions?: string[]
  kommo_enabled?: boolean
}

interface UserAccount {
  account_id: string
  account_name: string
  account_slug: string
  role: string
  is_default: boolean
}

function subscriptionLabel(status?: string) {
  const labels: Record<string, string> = {
    trialing: 'Prueba',
    active: 'Activa',
    past_due: 'Pago pendiente',
    grace: 'Periodo de gracia',
    suspended: 'Suspendida',
    canceled: 'Cancelada',
    incomplete: 'Incompleta',
  }
  return labels[status || ''] || status || 'Sin suscripción'
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const router = useRouter()
  const pathname = usePathname()
  const [user, setUser] = useState<User | null>(null)
  const [accounts, setAccounts] = useState<UserAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [showAccountSwitcher, setShowAccountSwitcher] = useState(false)
  const accountSwitcherRef = useRef<HTMLDivElement>(null)
  const [updateAvailable, setUpdateAvailable] = useState(false)
  const [serverVersion, setServerVersion] = useState<string | null>(null)
  const [showChangelog, setShowChangelog] = useState(false)
  const [changelogContent, setChangelogContent] = useState('')
  const [isErosOpen, setIsErosOpen] = useState(false)
  const [chatComposerKeyboardOpen, setChatComposerKeyboardOpen] = useState(false)
  const [chatComposerAccessoryOpen, setChatComposerAccessoryOpen] = useState(false)
  const chatMobileChromeContextValue = useMemo(() => ({
    setComposerAccessoryOpen: setChatComposerAccessoryOpen,
  }), [])
  const chatKeyboardSessionRef = useRef(false)
  const clientVersion = process.env.NEXT_PUBLIC_BUILD_VERSION || 'dev'

  useEffect(() => {
    if (pathname !== '/dashboard/chats') {
      chatKeyboardSessionRef.current = false
      setChatComposerKeyboardOpen(false)
      setChatComposerAccessoryOpen(false)
      return
    }

    const viewport = window.visualViewport
    const coarsePointer = window.matchMedia('(pointer: coarse)')
    let baselineHeight = Math.max(window.innerHeight, viewport?.height || 0)
    let frame = 0
    let orientationTimer = 0

    const isComposerTarget = (target: EventTarget | null) =>
      target instanceof HTMLElement && target.dataset.chatKeyboardTarget === 'true'

    const isPhoneLayout = () => window.innerWidth < 768 || (
      coarsePointer.matches && Math.min(window.screen.width, window.screen.height) <= 600
    )

    const updateKeyboardState = () => {
      if (frame) window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        const activeComposer = isComposerTarget(document.activeElement)
        if (activeComposer) chatKeyboardSessionRef.current = true

        const visibleHeight = viewport?.height || window.innerHeight
        const viewportInset = Math.max(0, window.innerHeight - visibleHeight - (viewport?.offsetTop || 0))
        const baselineLoss = Math.max(0, baselineHeight - visibleHeight)
        const keyboardAmount = Math.max(viewportInset, baselineLoss)

        if (keyboardAmount < 72) {
          chatKeyboardSessionRef.current = false
          baselineHeight = Math.max(window.innerHeight, visibleHeight)
        }

        setChatComposerKeyboardOpen(
          isPhoneLayout() && chatKeyboardSessionRef.current && keyboardAmount > 96,
        )
      })
    }

    const handleFocusIn = (event: FocusEvent) => {
      if (isComposerTarget(event.target)) {
        chatKeyboardSessionRef.current = true
        baselineHeight = Math.max(baselineHeight, window.innerHeight, viewport?.height || 0)
      }
      updateKeyboardState()
    }

    const handleOrientationChange = () => {
      chatKeyboardSessionRef.current = false
      setChatComposerKeyboardOpen(false)
      if (orientationTimer) window.clearTimeout(orientationTimer)
      orientationTimer = window.setTimeout(() => {
        baselineHeight = Math.max(window.innerHeight, viewport?.height || 0)
        updateKeyboardState()
      }, 250)
    }

    document.addEventListener('focusin', handleFocusIn)
    window.addEventListener('resize', updateKeyboardState, { passive: true })
    window.addEventListener('orientationchange', handleOrientationChange, { passive: true })
    viewport?.addEventListener('resize', updateKeyboardState, { passive: true })
    viewport?.addEventListener('scroll', updateKeyboardState, { passive: true })
    updateKeyboardState()

    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      if (orientationTimer) window.clearTimeout(orientationTimer)
      document.removeEventListener('focusin', handleFocusIn)
      window.removeEventListener('resize', updateKeyboardState)
      window.removeEventListener('orientationchange', handleOrientationChange)
      viewport?.removeEventListener('resize', updateKeyboardState)
      viewport?.removeEventListener('scroll', updateKeyboardState)
      chatKeyboardSessionRef.current = false
    }
  }, [pathname])

  // Ctrl+I to toggle Eros
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'i') {
        e.preventDefault()
        setIsErosOpen(prev => !prev)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (accountSwitcherRef.current && !accountSwitcherRef.current.contains(e.target as Node)) {
        setShowAccountSwitcher(false)
      }
    }
    if (showAccountSwitcher) document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showAccountSwitcher])

  useEffect(() => {
    const saved = localStorage.getItem('sidebar_collapsed')
    if (saved === 'true') setSidebarCollapsed(true)
  }, [])

  const toggleSidebarCollapsed = () => {
    const next = !sidebarCollapsed
    setSidebarCollapsed(next)
    localStorage.setItem('sidebar_collapsed', String(next))
  }

  useEffect(() => {
    const checkAuth = async () => {
      try {
        if (isAuthIdleExpired()) {
          await logoutFromBrowser('idle')
          return
        }

        const token = localStorage.getItem('token')
        if (!token) {
          // Try refresh — maybe the JWT expired but refresh token cookie is valid
          const refreshed = await tryRefreshToken()
          if (!refreshed) {
            clearAuthState()
            router.push('/login')
            return
          }
        }

        const res = await fetch('/api/me', {
          credentials: 'include',
        })

        if (!res.ok) {
          // Try refreshing the token
          const refreshed = await tryRefreshToken()
          if (refreshed) {
            const retryRes = await fetch('/api/me', {
              credentials: 'include',
            })
            if (retryRes.ok) {
              const retryData = await retryRes.json()
              if (retryData.success) {
                setUser(retryData.user)
                if (retryData.accounts) setAccounts(retryData.accounts)
                localStorage.setItem('kommo_enabled', String(retryData.user.kommo_enabled || false))
                markAuthSession()
                initIdleTimeout()
                return
              }
            }
          }
          clearAuthState()
          router.push('/login')
          return
        }

        const data = await res.json()
        if (data.success) {
          setUser(data.user)
          if (data.accounts) setAccounts(data.accounts)
          localStorage.setItem('kommo_enabled', String(data.user.kommo_enabled || false))
          markAuthSession()
          initIdleTimeout() // Start idle timeout detector
        } else {
          clearAuthState()
          router.push('/login')
        }
      } catch {
        clearAuthState()
        router.push('/login')
      } finally {
        setLoading(false)
      }
    }

    checkAuth()
    return () => clearIdleTimeout()
  }, [router])

  // Version detection — WebSocket + header interception + polling fallback
  const checkForUpdate = useCallback((newVersion: string) => {
    if (clientVersion !== 'dev' && newVersion !== clientVersion) {
      setServerVersion(newVersion)
      const dismissed = sessionStorage.getItem('dismissed_version')
      if (dismissed !== newVersion) {
        setUpdateAvailable(true)
      }
    }
  }, [clientVersion])

  useEffect(() => {
    // 1. Listen for version changes from API response headers
    const unsubHeader = onServerVersionChange(checkForUpdate)

    // 2. Listen for WebSocket version_update events
    const unsubWS = subscribeWebSocket((data: any) => {
      if (data?.event === 'version_update' && data?.data?.version) {
        checkForUpdate(data.data.version)
      }
    })

    // 3. Polling fallback — check /api/version every 5 minutes
    const pollInterval = setInterval(async () => {
      try {
        const res = await fetch('/api/version')
        if (res.ok) {
          const json = await res.json()
          if (json.version) checkForUpdate(json.version)
        }
      } catch { /* ignore */ }
    }, 5 * 60 * 1000)

    return () => {
      unsubHeader()
      unsubWS()
      clearInterval(pollInterval)
    }
  }, [checkForUpdate])

  // Close changelog on Escape (capture phase to intercept before page handlers)
  useEffect(() => {
    if (!showChangelog) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        e.preventDefault()
        setShowChangelog(false)
      }
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [showChangelog])

  const dismissUpdate = () => {
    setUpdateAvailable(false)
    if (serverVersion) sessionStorage.setItem('dismissed_version', serverVersion)
  }

  const openChangelog = async () => {
    setShowChangelog(true)
    try {
      const res = await fetch('/api/version')
      if (res.ok) {
        const json = await res.json()
        if (json.changelog) setChangelogContent(json.changelog)
      }
    } catch { /* ignore */ }
  }

  const handleLogout = async () => {
    clearIdleTimeout()
    await logoutFromBrowser('manual')
  }

  const handleSwitchAccount = async (accountId: string) => {
    try {
      const res = await fetch('/api/auth/switch-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: accountId }),
        credentials: 'include',
      })
      const data = await res.json()
      if (data.success) {
        markAuthSession()
        localStorage.setItem('kommo_enabled', String(data.user.kommo_enabled || false))
        setUser(data.user)
        setShowAccountSwitcher(false)
        window.location.href = '/dashboard'
      }
    } catch (e) {
      console.error('Failed to switch account:', e)
    }
  }

  // Module permission map: route prefix → permission key
  const MODULE_PERMS: Record<string, string> = {
	'/dashboard/chat-api': 'chats',
    '/dashboard/chats': 'chats',
    '/dashboard/contacts': 'contacts',
    '/dashboard/programs': 'programs',
    '/dashboard/automations': 'automations',
    '/dashboard/bots': 'bots',
    '/dashboard/devices': 'devices',
    '/dashboard/leads': 'leads',
    '/dashboard/events': 'events',
    '/dashboard/broadcasts': 'broadcasts',
    '/dashboard/surveys': 'surveys',
    '/dashboard/dynamics': 'dynamics',
    '/dashboard/tasks': 'tasks',
    '/dashboard/documents': 'documents',
    '/dashboard/browser': 'shared_browser',
    '/dashboard/reports': 'reports',
    '/dashboard/tags': 'tags',
    '/dashboard/settings': 'settings',
  }

  function hasPermission(href: string): boolean {
    if (!user) return false
    if (href === '/dashboard/storage') return true
    if (user.is_admin || user.is_super_admin) return true
    const module = MODULE_PERMS[href]
    if (!module) return true // Dashboard and Admin (no module restriction)
    const perms = user.permissions || []
    return perms.includes('*') || perms.includes(module)
  }

  const navItems = [
    { href: '/dashboard', icon: LayoutDashboard, label: 'Dashboard', desc: 'Panel principal' },
    { href: '/dashboard/reports', icon: BarChart3, label: 'Reportería', desc: 'Centro de reportes' },
    { href: '/dashboard/chats', icon: MessageSquare, label: 'Chats', desc: 'Conversaciones WhatsApp' },
    { href: '/dashboard/chat-api', icon: CloudCog, label: 'Chat API', desc: 'Canal oficial de Meta' },
    { href: '/dashboard/contacts', icon: Contact, label: 'Contactos', desc: 'Directorio de contactos' },
    { href: '/dashboard/programs', icon: BookOpenCheck, label: 'Programas', desc: 'Programas educativos' },
    { href: '/dashboard/automations', icon: Workflow, label: 'Automatizaciones', desc: 'Flujos automáticos' },
    { href: '/dashboard/bots', icon: Bot, label: 'Bots', desc: 'Respuestas conversacionales' },
    { href: '/dashboard/devices', icon: Smartphone, label: 'Dispositivos', desc: 'Canales WhatsApp' },
    { href: '/dashboard/leads', icon: Handshake, label: 'Leads', desc: 'Prospectos y oportunidades' },
    { href: '/dashboard/events', icon: CalendarCheck, label: 'Eventos', desc: 'Gestión de eventos' },
    { href: '/dashboard/broadcasts', icon: Radio, label: 'Difusión', desc: 'Mensajes masivos' },
    { href: '/dashboard/surveys', icon: ClipboardList, label: 'Encuestas', desc: 'Formularios y encuestas' },
    { href: '/dashboard/tasks', icon: ListChecks, label: 'Tareas', desc: 'Pendientes y seguimiento' },
    { href: '/dashboard/dynamics', icon: Sparkles, label: 'Dinámicas', desc: 'Actividades interactivas' },
    { href: '/dashboard/documents', icon: Files, label: 'Plantillas', desc: 'Editor de plantillas' },
    { href: '/dashboard/browser', icon: Monitor, label: 'Navegador', desc: 'Sesión compartida' },
    { href: '/dashboard/tags', icon: Tags, label: 'Etiquetas', desc: 'Organización por etiquetas' },
    { href: '/dashboard/storage', icon: Database, label: 'Almacenamiento', desc: 'Archivos y espacio' },
    { href: '/dashboard/settings', icon: Settings, label: 'Configuración', desc: 'Ajustes del sistema' },
    ...(user?.is_super_admin ? [{ href: '/dashboard/admin', icon: Shield, label: 'Admin', desc: 'Administración global' }] : []),
  ].filter(item => hasPermission(item.href))

  // When mobile overlay is open, always show expanded (not collapsed)
  const isCollapsed = sidebarCollapsed && !sidebarOpen

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-slate-50">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 bg-emerald-600 rounded-xl flex items-center justify-center">
            <MessageSquare className="w-5 h-5 text-white" />
          </div>
          <div className="animate-spin rounded-full h-6 w-6 border-2 border-emerald-200 border-t-emerald-600" />
        </div>
      </div>
    )
  }

  if (!user) return null

  const subscriptionBlocked = user.subscription_active === false && !pathname?.startsWith('/dashboard/settings')

  if (subscriptionBlocked) {
    return (
      <NotificationProvider accountId={user.account_id}>
        <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
          <div className="w-full max-w-xl bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl shadow-black/30 p-6 sm:p-8 text-center">
            <div className="w-14 h-14 bg-amber-500/10 border border-amber-500/20 rounded-2xl flex items-center justify-center mx-auto mb-5">
              <AlertTriangle className="w-7 h-7 text-amber-300" />
            </div>
            <h1 className="text-2xl font-bold text-white tracking-tight">Suscripción requiere atención</h1>
            <p className="text-slate-400 text-sm mt-3 leading-relaxed">
              Tu cuenta {user.account_name || 'actual'} está en estado {subscriptionLabel(user.subscription_status)}. Para proteger la operación, las funciones del CRM quedan pausadas hasta reactivar el plan.
            </p>
            <div className="mt-6 grid sm:grid-cols-2 gap-3 text-left">
              <div className="bg-slate-950 border border-slate-800 rounded-xl p-4">
                <p className="text-xs text-slate-500 uppercase tracking-wider">Plan</p>
                <p className="text-sm font-semibold text-slate-100 mt-1">{user.plan || 'Sin plan'}</p>
              </div>
              <div className="bg-slate-950 border border-slate-800 rounded-xl p-4">
                <p className="text-xs text-slate-500 uppercase tracking-wider">Estado</p>
                <p className="text-sm font-semibold text-amber-300 mt-1">{subscriptionLabel(user.subscription_status)}</p>
              </div>
            </div>
            <div className="mt-7 flex flex-col sm:flex-row gap-3 justify-center">
              <Link href="/dashboard/settings" className="inline-flex items-center justify-center gap-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 px-4 py-2.5 rounded-xl text-sm font-bold transition-all shadow-lg shadow-emerald-500/20">
                <CreditCard className="w-4 h-4" />
                Ver configuración
              </Link>
              <button onClick={handleLogout} className="inline-flex items-center justify-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-200 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all border border-slate-700">
                <LogOut className="w-4 h-4" />
                Cerrar sesión
              </button>
            </div>
          </div>
        </div>
      </NotificationProvider>
    )
  }

  return (
    <NotificationProvider accountId={user.account_id}>
    <ChatMobileChromeProvider value={chatMobileChromeContextValue}>
    <div className="app-viewport bg-slate-50 flex overflow-hidden">
      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/30 backdrop-blur-sm z-30 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside data-dashboard-sidebar className={`
        fixed lg:static inset-y-0 left-0 z-40
        ${isCollapsed ? 'lg:w-[68px]' : 'lg:w-60'} w-64
        bg-slate-800/95 backdrop-blur-md border-r border-slate-700/50
        transform transition-all duration-200 ease-in-out
        ${sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
        flex flex-col shadow-xl shadow-slate-900/20
        pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] lg:pt-0 lg:pb-0
      `}>
        {/* Logo */}
        <div className={`h-14 flex items-center justify-between ${isCollapsed ? 'px-3' : 'px-4'} border-b border-slate-700/50 shrink-0`}>
          <Link href="/dashboard" className="flex items-center gap-2.5 overflow-hidden group">
            <div className="w-8 h-8 bg-gradient-to-br from-emerald-500 to-emerald-600 rounded-lg flex items-center justify-center shrink-0 shadow-lg shadow-emerald-500/25 group-hover:shadow-emerald-500/40 transition-all duration-200">
              <MessageSquare className="w-[18px] h-[18px] text-white" />
            </div>
            {!isCollapsed && <span className="font-bold text-lg text-white whitespace-nowrap tracking-tight">Clarin</span>}
          </Link>
          <button
            onClick={() => setSidebarOpen(false)}
            className="lg:hidden flex h-11 w-11 items-center justify-center hover:bg-slate-700 rounded-lg transition-colors"
            aria-label="Cerrar menú"
          >
            <X className="w-5 h-5 text-slate-400" />
          </button>
          <div className="flex items-center gap-0.5">
            <button
              onClick={toggleSidebarCollapsed}
              className="hidden lg:flex p-1.5 hover:bg-slate-700/60 rounded-lg text-slate-500 hover:text-slate-300 transition-all duration-200"
              title={sidebarCollapsed ? 'Expandir menú' : 'Colapsar menú'}
            >
              {sidebarCollapsed ? <PanelLeftOpen className="w-[18px] h-[18px]" /> : <PanelLeftClose className="w-[18px] h-[18px]" />}
            </button>
          </div>
        </div>

        {/* Navigation */}
        <nav className={`${isCollapsed ? 'px-2 py-3' : 'px-2.5 py-3'} space-y-0.5 flex-1 overflow-y-auto`}>
          {navItems.map((item) => {
            const isActive = pathname === item.href ||
              (item.href !== '/dashboard' && pathname.startsWith(item.href))

            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setSidebarOpen(false)}
                className={`
                  group/nav relative flex min-h-11 lg:min-h-0 items-center ${isCollapsed ? 'justify-center px-2' : 'gap-3 px-3'} py-2 rounded-lg transition-all duration-200 text-[13px]
                  ${isActive
                    ? 'bg-emerald-500/15 text-emerald-400 font-semibold shadow-sm shadow-emerald-500/10'
                    : 'text-slate-400 hover:bg-slate-700/50 hover:text-slate-200'
                  }
                `}
              >
                <item.icon className={`w-[18px] h-[18px] shrink-0 transition-transform duration-200 group-hover/nav:scale-110 ${isActive ? 'text-emerald-400' : ''}`} />
                {!isCollapsed && <span className="truncate">{item.label}</span>}
                {!isCollapsed && item.href === '/dashboard/tasks' && <TaskBadge />}
                {!isCollapsed && isActive && <div className="ml-auto w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />}
                {isCollapsed && (
                  <div className="absolute left-full ml-3 px-3 py-2 bg-slate-900 rounded-lg shadow-xl shadow-black/30 opacity-0 invisible group-hover/nav:opacity-100 group-hover/nav:visible transition-all duration-150 pointer-events-none z-50 whitespace-nowrap border border-slate-700/50">
                    <p className="text-sm font-medium text-white">{item.label}</p>
                    {'desc' in item && <p className="text-[11px] text-slate-400 mt-0.5">{(item as any).desc}</p>}
                    <div className="absolute top-1/2 -left-1 -translate-y-1/2 w-2 h-2 bg-slate-900 rotate-45 border-l border-b border-slate-700/50" />
                  </div>
                )}
              </Link>
            )
          })}
        </nav>

        {/* Eros launcher stays visible without exposing the mascot while closed. */}
        <div className={`shrink-0 border-t border-slate-700/50 ${isCollapsed ? 'p-2' : 'px-2.5 py-2'}`}>
          <button
            type="button"
            onClick={() => setIsErosOpen(true)}
            aria-label="Abrir Eros"
            aria-keyshortcuts="Control+I Meta+I"
            className={`w-full min-h-11 lg:min-h-0 flex items-center ${isCollapsed ? 'justify-center p-2' : 'gap-2.5 px-3 py-2'} rounded-lg border border-emerald-500/20 bg-emerald-500/10 text-emerald-300 transition-all hover:border-emerald-400/40 hover:bg-emerald-500/15 hover:text-emerald-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/60`}
            title={isCollapsed ? 'Abrir Eros (Ctrl+I)' : undefined}
          >
            <Sparkles className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
            {!isCollapsed && (
              <>
                <span className="flex-1 text-left text-[13px] font-semibold">Eros</span>
                <span className="text-[10px] text-emerald-400/70">Ctrl+I</span>
              </>
            )}
          </button>
        </div>

        {/* Account name / switcher */}
        {accounts.length >= 1 && (
          <div ref={accountSwitcherRef} className={`shrink-0 border-t border-slate-700/50 ${isCollapsed ? 'p-2' : 'px-2.5 py-2'} relative`}>
            {accounts.length > 1 ? (
              <button
                onClick={() => setShowAccountSwitcher(!showAccountSwitcher)}
                title={isCollapsed ? (user.account_name || 'Cambiar cuenta') : undefined}
                className={`w-full flex items-center ${isCollapsed ? 'justify-center p-2' : 'gap-2 px-2.5 py-1.5'} rounded-lg hover:bg-slate-700/50 transition-all duration-200 text-slate-400 hover:text-slate-300`}
              >
                <Building2 className="w-4 h-4 shrink-0 text-slate-500" />
                {!isCollapsed && (
                  <>
                    <span className="flex-1 text-left text-xs truncate font-medium">{user.account_name || 'Cuenta'}</span>
                    <ChevronsUpDown className="w-3.5 h-3.5 shrink-0 text-slate-500" />
                  </>
                )}
              </button>
            ) : (
              <div
                title={isCollapsed ? (user.account_name || 'Cuenta') : undefined}
                className={`w-full flex items-center ${isCollapsed ? 'justify-center p-2' : 'gap-2 px-2.5 py-1.5'} text-slate-400`}
              >
                <Building2 className="w-4 h-4 shrink-0 text-slate-500" />
                {!isCollapsed && (
                  <span className="flex-1 text-left text-xs truncate font-medium">{user.account_name || 'Cuenta'}</span>
                )}
              </div>
            )}
            {showAccountSwitcher && (
              <div className={`absolute ${isCollapsed ? 'left-full ml-2 bottom-0' : 'left-3 right-3 bottom-full mb-1'} bg-white border border-slate-200 rounded-xl shadow-lg shadow-slate-200/50 z-50 py-1 min-w-[180px]`}>
                <div className="px-3 py-1.5 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Cambiar cuenta</div>
                {accounts.map((acc) => (
                  <button
                    key={acc.account_id}
                    onClick={() => handleSwitchAccount(acc.account_id)}
                    className={`w-full text-left px-3 py-2 text-sm hover:bg-slate-50 transition-colors flex items-center gap-2 ${
                      acc.account_id === user.account_id ? 'text-emerald-700 bg-emerald-50 font-medium' : 'text-slate-600'
                    }`}
                  >
                    <Building2 className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate">{acc.account_name}</span>
                    {acc.account_id === user.account_id && <div className="ml-auto w-1.5 h-1.5 rounded-full bg-emerald-500" />}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* User section */}
        <div className={`shrink-0 ${isCollapsed ? 'p-2' : 'px-2.5 py-3'} border-t border-slate-700/50`}>
          {isCollapsed ? (
            <div className="flex flex-col items-center gap-2">
              <div className="w-9 h-9 bg-emerald-500/15 rounded-lg flex items-center justify-center ring-1 ring-emerald-500/20">
                <span className="text-emerald-400 font-semibold text-sm">
                  {user.display_name?.charAt(0) || user.username.charAt(0).toUpperCase()}
                </span>
              </div>
              <button
                onClick={handleLogout}
                title="Cerrar Sesión"
                className="p-1.5 text-slate-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-all duration-200"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 bg-emerald-500/15 rounded-lg flex items-center justify-center shrink-0 ring-1 ring-emerald-500/20">
                <span className="text-emerald-400 font-semibold text-sm">
                  {user.display_name?.charAt(0) || user.username.charAt(0).toUpperCase()}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-medium text-slate-200 truncate text-sm leading-tight">
                  {user.display_name || user.username}
                </p>
                <p className="text-[11px] text-slate-500 truncate">
                  {user.is_super_admin ? 'Super Admin' : user.is_admin ? 'Admin' : user.role || 'Usuario'}
                </p>
              </div>
              <button
                onClick={handleLogout}
                title="Cerrar Sesión"
                className="p-1.5 text-slate-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-all duration-200 shrink-0"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>

        {/* Version */}
        <div className={`shrink-0 ${isCollapsed ? 'px-2 pb-2' : 'px-2.5 pb-3'}`}>
          <button
            onClick={openChangelog}
            title="Ver changelog"
            className={`w-full flex items-center ${isCollapsed ? 'justify-center' : 'gap-1.5 px-2.5'} py-1 rounded-md hover:bg-slate-700/50 transition-all duration-200 group`}
          >
            <FileText className="w-3 h-3 text-slate-600 group-hover:text-slate-400 shrink-0" />
            {!isCollapsed && (
              <span className="text-[10px] text-slate-600 group-hover:text-slate-400 font-mono truncate">
                v{clientVersion}
              </span>
            )}
          </button>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* Update available banner */}
        {updateAvailable && (
          <div className="bg-gradient-to-r from-emerald-500 to-teal-500 text-white pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] sm:px-4 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2 flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between shrink-0 shadow-sm">
            <div className="flex min-w-0 items-center gap-2 text-sm">
              <RefreshCw className="w-4 h-4" />
              <span className="min-w-0 truncate font-medium">Nueva versión disponible</span>
              {serverVersion && <span className="text-emerald-100 text-xs">v{serverVersion}</span>}
            </div>
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={openChangelog}
                className="text-xs text-emerald-100 hover:text-white underline underline-offset-2 transition-colors"
              >
                Ver cambios
              </button>
              <button
                onClick={() => window.location.reload()}
                className="min-h-9 px-3 py-1 bg-white/20 hover:bg-white/30 rounded-md text-xs font-medium transition-colors"
              >
                Actualizar
              </button>
              <button
                onClick={dismissUpdate}
                className="flex h-9 w-9 items-center justify-center hover:bg-white/20 rounded transition-colors"
                aria-label="Descartar actualización"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}

        {/* Top bar - mobile only */}
        <header data-testid="dashboard-mobile-header" className={`${updateAvailable ? 'h-14' : 'h-[calc(3.5rem+env(safe-area-inset-top))] pt-[env(safe-area-inset-top)]'} ${chatComposerKeyboardOpen || chatComposerAccessoryOpen ? 'hidden' : 'flex'} items-center border-b border-slate-200/80 bg-white pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] sm:px-4 lg:hidden shrink-0`}>
          <button
            onClick={() => setSidebarOpen(true)}
            className="flex h-11 w-11 items-center justify-center hover:bg-slate-100 rounded-lg transition-colors"
            aria-label="Abrir menú"
          >
            <Menu className="w-5 h-5 text-slate-600" />
          </button>
          <div className="ml-3 flex items-center gap-2 flex-1">
            <div className="w-6 h-6 bg-emerald-600 rounded-md flex items-center justify-center">
              <MessageSquare className="w-3.5 h-3.5 text-white" />
            </div>
            <span className="font-semibold text-slate-800 text-sm">Clarin</span>
          </div>
          <button
            type="button"
            onClick={() => setIsErosOpen(true)}
            className="flex h-11 w-11 items-center justify-center rounded-lg text-emerald-600 transition-colors hover:bg-emerald-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50"
            aria-label="Abrir Eros"
          >
            <Sparkles className="h-5 w-5" aria-hidden="true" />
          </button>
        </header>

        {/* Page content */}
        <main className={`flex-1 flex flex-col overflow-hidden min-h-0 ${
          pathname === '/dashboard/chats' || pathname === '/dashboard/chat-api' || pathname?.startsWith('/dashboard/documents') ? 'p-0' : 'p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:p-4 lg:p-5'
        } ${(chatComposerKeyboardOpen || chatComposerAccessoryOpen) && !updateAvailable ? 'pt-[env(safe-area-inset-top)]' : ''}`}>
          {children}
        </main>
      </div>

      {/* In docked mode Eros is a real flex sibling and the CRM yields space to it. */}
      <ErosAssistant isOpenProp={isErosOpen} onClose={() => setIsErosOpen(false)} />

    </div>

    {/* Changelog Modal */}
    {showChangelog && (
      <div className="responsive-dialog-backdrop fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center">
        <div className="responsive-dialog-panel bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
          {/* Header */}
          <div className="flex shrink-0 items-center justify-between gap-3 px-4 pb-4 pt-[max(1rem,env(safe-area-inset-top))] sm:px-6 sm:py-5 border-b border-slate-100">
            <div className="flex min-w-0 flex-wrap items-center gap-2 sm:gap-3">
              <h2 className="text-lg font-bold text-slate-800">Novedades</h2>
              <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-emerald-50 border border-emerald-200 rounded-full">
                <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse" />
                <span className="text-xs font-semibold text-emerald-700 font-mono">v{clientVersion}</span>
              </span>
            </div>
            <button onClick={() => setShowChangelog(false)} className="flex h-11 w-11 shrink-0 items-center justify-center hover:bg-slate-100 rounded-lg transition-colors" title="Cerrar (Esc)" aria-label="Cerrar novedades">
              <X className="w-5 h-5 text-slate-400" />
            </button>
          </div>
          {/* Body */}
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6 sm:py-5">
            {changelogContent ? (
              <div className="space-y-6">
                {(() => {
                  const sections: { date: string; builds: { title: string; items: { emoji: string; text: string }[] }[] }[] = []
                  changelogContent.split('\n').forEach(line => {
                    if (line.startsWith('## ') && !line.startsWith('## Dev')) {
                      sections.push({ date: line.replace('## ', '').trim(), builds: [] })
                    } else if (line.startsWith('### Build ') && sections.length > 0) {
                      sections[sections.length - 1].builds.push({ title: line.replace('### ', '').trim(), items: [] })
                    } else if (line.startsWith('- ') && sections.length > 0) {
                      const current = sections[sections.length - 1]
                      if (current.builds.length > 0) {
                        const text = line.replace('- ', '').trim()
                        const emojis = ['✨', '🐛', '💄', '⚡', '🔧']
                        const emoji = emojis.find(e => text.startsWith(e))
                        current.builds[current.builds.length - 1].items.push({
                          emoji: emoji || '',
                          text: emoji ? text.slice(emoji.length).trim() : text,
                        })
                      }
                    }
                  })
                  const badgeColors: Record<string, string> = {
                    '✨': 'bg-blue-50 text-blue-600 border-blue-100',
                    '🐛': 'bg-red-50 text-red-600 border-red-100',
                    '💄': 'bg-purple-50 text-purple-600 border-purple-100',
                    '⚡': 'bg-amber-50 text-amber-600 border-amber-100',
                    '🔧': 'bg-slate-50 text-slate-600 border-slate-200',
                  }
                  return sections.map((dateSection, di) => (
                    <div key={di}>
                      <div className="flex items-center gap-2 mb-4">
                        <div className="w-2 h-2 bg-slate-300 rounded-full" />
                        <h3 className="text-sm font-bold text-slate-700">{dateSection.date}</h3>
                        <div className="flex-1 border-t border-slate-100" />
                      </div>
                      <div className="space-y-4 pl-2">
                        {dateSection.builds.map((build, bi) => (
                          <div key={bi} className="bg-slate-50/50 rounded-xl border border-slate-100 overflow-hidden">
                            <div className="px-4 py-2.5 border-b border-slate-100 bg-white">
                              <h4 className="text-xs font-semibold text-emerald-600">{build.title}</h4>
                            </div>
                            <div className="px-4 py-2.5 space-y-1.5">
                              {build.items.map((item, ii) => (
                                <div key={ii} className="flex items-start gap-2.5">
                                  {item.emoji ? (
                                    <span className={`text-[10px] px-1.5 py-0.5 rounded-md shrink-0 mt-0.5 border ${badgeColors[item.emoji] || 'bg-slate-50 text-slate-500 border-slate-200'}`}>{item.emoji}</span>
                                  ) : (
                                    <span className="w-1.5 h-1.5 bg-slate-300 rounded-full shrink-0 mt-2" />
                                  )}
                                  <span className="text-sm text-slate-600 leading-relaxed">{item.text}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))
                })()}
              </div>
            ) : (
              <div className="flex items-center justify-center py-12">
                <div className="animate-spin rounded-full h-6 w-6 border-2 border-emerald-200 border-t-emerald-600" />
              </div>
            )}
          </div>
        </div>
      </div>
    )}

    </ChatMobileChromeProvider>
    </NotificationProvider>
  )
}
