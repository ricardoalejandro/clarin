'use client'

import { useEffect, useState, useRef } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import NotificationProvider from '@/components/NotificationProvider'
import {
  MessageSquare,
  Smartphone,
  Users,
  Settings,
  LogOut,
  Menu,
  X,
  LayoutDashboard,
  ChevronRight,
  BookUser,
  PanelLeftClose,
  PanelLeftOpen,
  Radio,
  Tags,
  CalendarDays,
  Shield,
  ChevronsUpDown,
  Building2
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
}

interface UserAccount {
  account_id: string
  account_name: string
  account_slug: string
  role: string
  is_default: boolean
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
        const token = localStorage.getItem('token')
        if (!token) {
          router.push('/')
          return
        }

        const res = await fetch('/api/me', {
          headers: { Authorization: `Bearer ${token}` },
        })

        if (!res.ok) {
          localStorage.removeItem('token')
          router.push('/')
          return
        }

        const data = await res.json()
        if (data.success) {
          setUser(data.user)
          if (data.accounts) setAccounts(data.accounts)
        } else {
          router.push('/')
        }
      } catch {
        router.push('/')
      } finally {
        setLoading(false)
      }
    }

    checkAuth()
  }, [router])

  const handleLogout = async () => {
    localStorage.removeItem('token')
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
    router.push('/')
  }

  const handleSwitchAccount = async (accountId: string) => {
    const token = localStorage.getItem('token')
    if (!token) return
    try {
      const res = await fetch('/api/auth/switch-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ account_id: accountId }),
      })
      const data = await res.json()
      if (data.success) {
        localStorage.setItem('token', data.token)
        setUser(data.user)
        setShowAccountSwitcher(false)
        window.location.href = '/dashboard'
      }
    } catch (e) {
      console.error('Failed to switch account:', e)
    }
  }

  const navItems = [
    { href: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
    { href: '/dashboard/chats', icon: MessageSquare, label: 'Chats' },
    { href: '/dashboard/contacts', icon: BookUser, label: 'Contactos' },
    { href: '/dashboard/devices', icon: Smartphone, label: 'Dispositivos' },
    { href: '/dashboard/leads', icon: Users, label: 'Leads' },
    { href: '/dashboard/events', icon: CalendarDays, label: 'Eventos' },
    { href: '/dashboard/broadcasts', icon: Radio, label: 'Difusión' },
    { href: '/dashboard/tags', icon: Tags, label: 'Etiquetas' },
    { href: '/dashboard/settings', icon: Settings, label: 'Configuración' },
    ...(user?.is_super_admin ? [{ href: '/dashboard/admin', icon: Shield, label: 'Admin' }] : []),
  ]

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

  return (
    <NotificationProvider accountId={user.account_id}>
    <div className="bg-slate-50 flex overflow-hidden" style={{ height: 'var(--app-height, 100vh)' }}>
      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/30 backdrop-blur-sm z-30 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside className={`
        fixed lg:static inset-y-0 left-0 z-40
        ${isCollapsed ? 'lg:w-[68px]' : 'lg:w-60'} w-64
        bg-white border-r border-slate-200/80
        transform transition-all duration-200 ease-in-out
        ${sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
        flex flex-col
      `}>
        {/* Logo */}
        <div className={`h-14 flex items-center justify-between ${isCollapsed ? 'px-3' : 'px-4'} border-b border-slate-100 shrink-0`}>
          <Link href="/dashboard" className="flex items-center gap-2.5 overflow-hidden">
            <div className="w-8 h-8 bg-emerald-600 rounded-lg flex items-center justify-center shrink-0">
              <MessageSquare className="w-[18px] h-[18px] text-white" />
            </div>
            {!isCollapsed && <span className="font-bold text-lg text-slate-800 whitespace-nowrap tracking-tight">Clarin</span>}
          </Link>
          <button
            onClick={() => setSidebarOpen(false)}
            className="lg:hidden p-1 hover:bg-slate-100 rounded-lg"
          >
            <X className="w-5 h-5 text-slate-500" />
          </button>
          <button
            onClick={toggleSidebarCollapsed}
            className="hidden lg:flex p-1 hover:bg-slate-100 rounded-lg text-slate-400 hover:text-slate-600 transition-colors"
            title={sidebarCollapsed ? 'Expandir menú' : 'Colapsar menú'}
          >
            {sidebarCollapsed ? <PanelLeftOpen className="w-[18px] h-[18px]" /> : <PanelLeftClose className="w-[18px] h-[18px]" />}
          </button>
        </div>

        {/* Navigation */}
        <nav className={`${isCollapsed ? 'px-2 py-3' : 'px-3 py-3'} space-y-0.5 flex-1 overflow-y-auto`}>
          {navItems.map((item) => {
            const isActive = pathname === item.href ||
              (item.href !== '/dashboard' && pathname.startsWith(item.href))

            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setSidebarOpen(false)}
                title={isCollapsed ? item.label : undefined}
                className={`
                  flex items-center ${isCollapsed ? 'justify-center px-2' : 'gap-3 px-3'} py-2 rounded-lg transition-all text-[13px]
                  ${isActive
                    ? 'bg-emerald-50 text-emerald-700 font-semibold'
                    : 'text-slate-500 hover:bg-slate-50 hover:text-slate-800'
                  }
                `}
              >
                <item.icon className={`w-[18px] h-[18px] shrink-0 ${isActive ? 'text-emerald-600' : ''}`} />
                {!isCollapsed && <span>{item.label}</span>}
                {!isCollapsed && isActive && <ChevronRight className="w-3.5 h-3.5 ml-auto opacity-50" />}
              </Link>
            )
          })}
        </nav>

        {/* Account switcher */}
        {accounts.length > 1 && (
          <div ref={accountSwitcherRef} className={`shrink-0 border-t border-slate-100 ${isCollapsed ? 'p-2' : 'px-3 py-2'} relative`}>
            <button
              onClick={() => setShowAccountSwitcher(!showAccountSwitcher)}
              title={isCollapsed ? (user.account_name || 'Cambiar cuenta') : undefined}
              className={`w-full flex items-center ${isCollapsed ? 'justify-center p-2' : 'gap-2 px-2.5 py-1.5'} rounded-lg hover:bg-slate-50 transition-colors text-slate-600`}
            >
              <Building2 className="w-4 h-4 shrink-0 text-slate-400" />
              {!isCollapsed && (
                <>
                  <span className="flex-1 text-left text-xs truncate font-medium">{user.account_name || 'Cuenta'}</span>
                  <ChevronsUpDown className="w-3.5 h-3.5 shrink-0 text-slate-300" />
                </>
              )}
            </button>
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
        <div className={`shrink-0 ${isCollapsed ? 'p-2' : 'px-3 py-3'} border-t border-slate-100`}>
          {isCollapsed ? (
            <div className="flex flex-col items-center gap-2">
              <div className="w-9 h-9 bg-emerald-50 rounded-lg flex items-center justify-center">
                <span className="text-emerald-700 font-semibold text-sm">
                  {user.display_name?.charAt(0) || user.username.charAt(0).toUpperCase()}
                </span>
              </div>
              <button
                onClick={handleLogout}
                title="Cerrar Sesión"
                className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 bg-emerald-50 rounded-lg flex items-center justify-center shrink-0">
                <span className="text-emerald-700 font-semibold text-sm">
                  {user.display_name?.charAt(0) || user.username.charAt(0).toUpperCase()}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-medium text-slate-800 truncate text-sm leading-tight">
                  {user.display_name || user.username}
                </p>
                <p className="text-[11px] text-slate-400 truncate">
                  {user.is_super_admin ? 'Super Admin' : user.is_admin ? 'Admin' : user.role || 'Usuario'}
                </p>
              </div>
              <button
                onClick={handleLogout}
                title="Cerrar Sesión"
                className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors shrink-0"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* Top bar - mobile only */}
        <header className="h-14 bg-white border-b border-slate-200/80 flex items-center px-4 lg:hidden shrink-0">
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-2 hover:bg-slate-100 rounded-lg transition-colors"
          >
            <Menu className="w-5 h-5 text-slate-600" />
          </button>
          <div className="ml-3 flex items-center gap-2">
            <div className="w-6 h-6 bg-emerald-600 rounded-md flex items-center justify-center">
              <MessageSquare className="w-3.5 h-3.5 text-white" />
            </div>
            <span className="font-semibold text-slate-800 text-sm">Clarin</span>
          </div>
        </header>

        {/* Page content */}
        <main className={`flex-1 flex flex-col overflow-hidden min-h-0 ${
          pathname === '/dashboard/chats' ? 'p-0 md:p-4 lg:p-5' : 'p-3 sm:p-4 lg:p-5'
        }`}>
          {children}
        </main>
      </div>
    </div>
    </NotificationProvider>
  )
}
