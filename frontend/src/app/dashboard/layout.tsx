"use client";

import { useState, useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import { 
  MessageSquare, 
  Users, 
  Settings, 
  LogOut, 
  Menu, 
  X, 
  Smartphone, 
  UserCircle,
  Target,
  Tag,
  Megaphone,
  Calendar,
  BookOpen
} from 'lucide-react';
import { api } from '@/lib/api';
import NotificationProvider from '@/components/NotificationProvider';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [user, setUser] = useState<any>(null);

  useEffect(() => {
    const fetchUser = async () => {
      try {
        const response = await api('/api/me');
        if (response.success) {
          setUser(response.data);
        } else {
          router.push('/');
        }
      } catch (error) {
        router.push('/');
      }
    };
    fetchUser();
  }, [router]);

  const handleLogout = async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
      localStorage.removeItem('token');
      router.push('/');
    } catch (error) {
      console.error('Logout failed:', error);
    }
  };

  const navigation = [
    { name: 'Chats', href: '/dashboard/chats', icon: MessageSquare },
    { name: 'Leads', href: '/dashboard/leads', icon: Target },
    { name: 'Contactos', href: '/dashboard/contacts', icon: Users },
    { name: 'Programas', href: '/dashboard/programs', icon: BookOpen },
    { name: 'Campañas', href: '/dashboard/broadcasts', icon: Megaphone },
    { name: 'Eventos', href: '/dashboard/events', icon: Calendar },
    { name: 'Etiquetas', href: '/dashboard/tags', icon: Tag },
    { name: 'Dispositivos', href: '/dashboard/devices', icon: Smartphone },
    { name: 'Configuración', href: '/dashboard/settings', icon: Settings },
  ];

  // Add admin panel if user is super admin
  if (user?.is_super_admin) {
    navigation.push({ name: 'Admin', href: '/dashboard/admin', icon: UserCircle });
  }

  return (
    <NotificationProvider accountId={user?.account_id || ''}>
      <div className="min-h-screen bg-slate-50 flex">
        {/* Mobile sidebar backdrop */}
        {!isSidebarOpen && (
          <div 
            className="fixed inset-0 bg-slate-900/50 z-20 lg:hidden"
            onClick={() => setIsSidebarOpen(true)}
          />
        )}

        {/* Sidebar */}
        <aside className={`
          fixed lg:static inset-y-0 left-0 z-30
          w-64 bg-white border-r border-slate-200
          transform transition-transform duration-200 ease-in-out
          flex flex-col
          ${!isSidebarOpen ? '-translate-x-full lg:translate-x-0' : 'translate-x-0'}
        `}>
          <div className="h-16 flex items-center justify-between px-6 border-b border-slate-200">
            <span className="text-xl font-bold text-emerald-600">Clarin CRM</span>
            <button 
              onClick={() => setIsSidebarOpen(false)}
              className="lg:hidden text-slate-500 hover:text-slate-700"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto py-4">
            <nav className="space-y-1 px-3">
              {navigation.map((item) => {
                const isActive = pathname.startsWith(item.href);
                return (
                  <Link
                    key={item.name}
                    href={item.href}
                    className={`
                      flex items-center px-3 py-2.5 rounded-lg text-sm font-medium transition-colors
                      ${isActive 
                        ? 'bg-emerald-50 text-emerald-700' 
                        : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                      }
                    `}
                  >
                    <item.icon className={`w-5 h-5 mr-3 ${isActive ? 'text-emerald-600' : 'text-slate-400'}`} />
                    {item.name}
                  </Link>
                );
              })}
            </nav>
          </div>

          <div className="p-4 border-t border-slate-200">
            <div className="flex items-center mb-4 px-3">
              <div className="w-8 h-8 rounded-full bg-emerald-100 flex items-center justify-center text-emerald-700 font-bold">
                {user?.username?.charAt(0).toUpperCase() || 'U'}
              </div>
              <div className="ml-3 overflow-hidden">
                <p className="text-sm font-medium text-slate-900 truncate">{user?.username}</p>
                <p className="text-xs text-slate-500 truncate">{user?.role}</p>
              </div>
            </div>
            <button
              onClick={handleLogout}
              className="flex items-center w-full px-3 py-2 text-sm font-medium text-red-600 rounded-lg hover:bg-red-50 transition-colors"
            >
              <LogOut className="w-5 h-5 mr-3" />
              Cerrar Sesión
            </button>
          </div>
        </aside>

        {/* Main content */}
        <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {/* Mobile header */}
          <header className="lg:hidden h-16 bg-white border-b border-slate-200 flex items-center px-4">
            <button
              onClick={() => setIsSidebarOpen(true)}
              className="text-slate-500 hover:text-slate-700"
            >
              <Menu className="w-6 h-6" />
            </button>
            <span className="ml-4 text-lg font-bold text-emerald-600">Clarin CRM</span>
          </header>

          <div className="flex-1 overflow-y-auto">
            {children}
          </div>
        </main>
      </div>
    </NotificationProvider>
  );
}
