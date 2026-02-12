'use client'

import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
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
  ChevronLeft,
  BookUser,
  PanelLeftClose,
  PanelLeftOpen,
  Radio,
  Tags,
  CalendarDays
} from 'lucide-react'

interface User {
  id: string
  username: string
  display_name: string
  is_admin: boolean
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const router = useRouter()
  const pathname = usePathname()
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

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

  const navItems = [
    { href: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
    { href: '/dashboard/chats', icon: MessageSquare, label: 'Chats' },
    { href: '/dashboard/contacts', icon: BookUser, label: 'Contactos' },
    { href: '/dashboard/devices', icon: Smartphone, label: 'Dispositivos' },
    { href: '/dashboard/leads', icon: Users, label: 'Leads' },
    { href: '/dashboard/events', icon: CalendarDays, label: 'Eventos' },
    { href: '/dashboard/broadcasts', icon: Radio, label: 'Envíos Masivos' },
    { href: '/dashboard/tags', icon: Tags, label: 'Etiquetas' },
    { href: '/dashboard/settings', icon: Settings, label: 'Configuración' },
  ]

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-50">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-green-600" />
      </div>
    )
  }

  if (!user) return null

  return (
    <div className="bg-gray-50 flex overflow-hidden" style={{ height: 'var(--app-height, 100vh)' }}>
      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div 
          className="fixed inset-0 bg-black/50 z-30 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside className={`
        fixed lg:static inset-y-0 left-0 z-40
        ${sidebarCollapsed ? 'lg:w-16' : 'lg:w-64'} w-64
        bg-white border-r border-gray-200
        transform transition-all duration-200 ease-in-out
        ${sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
        flex flex-col
      `}>
        {/* Logo */}
        <div className="h-16 flex items-center justify-between px-4 border-b border-gray-200 shrink-0">
          <Link href="/dashboard" className="flex items-center gap-2 overflow-hidden">
            <div className="w-8 h-8 bg-green-600 rounded-lg flex items-center justify-center shrink-0">
              <MessageSquare className="w-5 h-5 text-white" />
            </div>
            {!sidebarCollapsed && <span className="font-bold text-xl text-gray-800 whitespace-nowrap">Clarin</span>}
          </Link>
          <button 
            onClick={() => setSidebarOpen(false)}
            className="lg:hidden p-1 hover:bg-gray-100 rounded"
          >
            <X className="w-5 h-5" />
          </button>
          <button 
            onClick={toggleSidebarCollapsed}
            className="hidden lg:flex p-1 hover:bg-gray-100 rounded text-gray-500"
            title={sidebarCollapsed ? 'Expandir menú' : 'Colapsar menú'}
          >
            {sidebarCollapsed ? <PanelLeftOpen className="w-5 h-5" /> : <PanelLeftClose className="w-5 h-5" />}
          </button>
        </div>

        {/* Navigation */}
        <nav className={`${sidebarCollapsed ? 'p-2' : 'p-4'} space-y-1 flex-1 overflow-y-auto`}>
          {navItems.map((item) => {
            const isActive = pathname === item.href || 
              (item.href !== '/dashboard' && pathname.startsWith(item.href))
            
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setSidebarOpen(false)}
                title={sidebarCollapsed ? item.label : undefined}
                className={`
                  flex items-center ${sidebarCollapsed ? 'justify-center px-2' : 'gap-3 px-3'} py-2.5 rounded-lg transition-colors
                  ${isActive 
                    ? 'bg-green-50 text-green-700 font-medium' 
                    : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                  }
                `}
              >
                <item.icon className="w-5 h-5 shrink-0" />
                {!sidebarCollapsed && <span>{item.label}</span>}
                {!sidebarCollapsed && isActive && <ChevronRight className="w-4 h-4 ml-auto" />}
              </Link>
            )
          })}
        </nav>

        {/* User section */}
        <div className="shrink-0 p-4 border-t border-gray-200">
          {sidebarCollapsed ? (
            <div className="flex flex-col items-center gap-2">
              <div className="w-10 h-10 bg-green-100 rounded-full flex items-center justify-center">
                <span className="text-green-700 font-medium">
                  {user.display_name?.charAt(0) || user.username.charAt(0).toUpperCase()}
                </span>
              </div>
              <button
                onClick={handleLogout}
                title="Cerrar Sesión"
                className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 bg-green-100 rounded-full flex items-center justify-center shrink-0">
                  <span className="text-green-700 font-medium">
                    {user.display_name?.charAt(0) || user.username.charAt(0).toUpperCase()}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-gray-900 truncate">
                    {user.display_name || user.username}
                  </p>
                  <p className="text-sm text-gray-500 truncate">
                    {user.is_admin ? 'Administrador' : 'Usuario'}
                  </p>
                </div>
              </div>
              <button
                onClick={handleLogout}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
              >
                <LogOut className="w-4 h-4" />
                <span>Cerrar Sesión</span>
              </button>
            </>
          )}
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* Top bar - mobile only */}
        <header className="h-16 bg-white border-b border-gray-200 flex items-center px-4 lg:hidden shrink-0">
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-2 hover:bg-gray-100 rounded-lg"
          >
            <Menu className="w-6 h-6" />
          </button>
          <span className="ml-3 font-semibold text-gray-800">Clarin</span>
        </header>

        {/* Page content */}
        <main className={`flex-1 flex flex-col overflow-hidden min-h-0 ${
          pathname === '/dashboard/chats' ? 'p-0 md:p-4 lg:p-6' : 'p-2 sm:p-4 lg:p-6'
        }`}>
          {children}
        </main>
      </div>
    </div>
  )
}
