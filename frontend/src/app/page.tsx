'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  ArrowRight,
  BarChart3,
  Check,
  Eye,
  EyeOff,
  Lock,
  MessageSquare,
  ShieldCheck,
  Sparkles,
  User,
  Users,
  Zap,
} from 'lucide-react'
import { tryRefreshToken } from '@/lib/api'

interface PublicPlan {
  code: string
  name: string
  description: string
  trial_days: number
  is_public: boolean
  sort_order: number
  entitlements?: Record<string, unknown>
}

const fallbackPlans: PublicPlan[] = [
  { code: 'starter', name: 'Starter', description: 'Para equipos pequeños que empiezan con WhatsApp CRM.', trial_days: 14, is_public: true, sort_order: 30 },
  { code: 'pro', name: 'Pro', description: 'Para equipos comerciales con más volumen y campañas.', trial_days: 14, is_public: true, sort_order: 40 },
  { code: 'business', name: 'Business', description: 'Para operaciones con automatizaciones y más capacidad.', trial_days: 14, is_public: true, sort_order: 50 },
]

const planDetails: Record<string, { price: string; badge?: string; features: string[] }> = {
  starter: {
    price: 'S/ 149',
    features: ['3 dispositivos WhatsApp', '5 usuarios', '10 mil contactos', 'Kommo y Google Contacts'],
  },
  pro: {
    price: 'S/ 299',
    badge: 'Más elegido',
    features: ['8 dispositivos WhatsApp', '12 usuarios', '50 mil contactos', 'Campañas de difusión'],
  },
  business: {
    price: 'S/ 599',
    features: ['20 dispositivos WhatsApp', '30 usuarios', '150 mil contactos', 'Automatizaciones avanzadas'],
  },
}

type AuthMode = 'signup' | 'login'

export default function HomePage() {
  const router = useRouter()
  const [mode, setMode] = useState<AuthMode>('signup')
  const [plans, setPlans] = useState<PublicPlan[]>([])
  const [selectedPlan, setSelectedPlan] = useState('pro')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [signupForm, setSignupForm] = useState({ account_name: '', display_name: '', email: '', password: '' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [checking, setChecking] = useState(true)

  const visiblePlans = useMemo(() => {
    const commercial = plans.filter(plan => ['starter', 'pro', 'business'].includes(plan.code))
    return commercial.length > 0 ? commercial : fallbackPlans
  }, [plans])

  useEffect(() => {
    const check = async () => {
      const token = localStorage.getItem('token')
      if (token) {
        try {
          const res = await fetch('/api/me', {
            headers: { Authorization: `Bearer ${token}` },
          })
          if (res.ok) {
            router.push('/dashboard')
            return
          }
        } catch { /* ignore */ }
        const refreshed = await tryRefreshToken()
        if (refreshed) {
          router.push('/dashboard')
          return
        }
      }
      setChecking(false)
    }
    check()
  }, [router])

  useEffect(() => {
    const loadPlans = async () => {
      try {
        const res = await fetch('/api/public/plans')
        const data = await res.json()
        if (data.success && Array.isArray(data.plans)) {
          setPlans(data.plans)
        }
      } catch { /* fallback plans keep page usable */ }
    }
    loadPlans()
  }, [])

  useEffect(() => {
    if (!visiblePlans.some(plan => plan.code === selectedPlan)) {
      setSelectedPlan(visiblePlans[0]?.code || 'starter')
    }
  }, [selectedPlan, visiblePlans])

  const handleLogin = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')
    setLoading(true)

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
        credentials: 'include',
      })
      const data = await res.json()
      if (!data.success) {
        setError(data.error || 'Error al iniciar sesión')
        return
      }
      localStorage.setItem('token', data.token)
      router.push('/dashboard')
      router.refresh()
    } catch {
      setError('Error de conexión')
    } finally {
      setLoading(false)
    }
  }

  const handleSignup = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')
    setLoading(true)

    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...signupForm, plan_code: selectedPlan }),
        credentials: 'include',
      })
      const data = await res.json()
      if (!data.success) {
        setError(data.error || 'No se pudo crear la cuenta')
        return
      }
      if (data.token) {
        localStorage.setItem('token', data.token)
        router.push('/dashboard')
        router.refresh()
        return
      }
      setMode('login')
      setUsername(signupForm.email)
      setError('Cuenta creada. Inicia sesión para continuar.')
    } catch {
      setError('Error de conexión')
    } finally {
      setLoading(false)
    }
  }

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-emerald-200/30 border-t-emerald-400" />
      </div>
    )
  }

  return (
    <main className="min-h-screen bg-slate-950 text-white overflow-x-hidden">
      <header className="border-b border-slate-800/80 bg-slate-950/95 backdrop-blur sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 bg-emerald-500 rounded-lg flex items-center justify-center shadow-lg shadow-emerald-500/20">
              <MessageSquare className="w-5 h-5 text-white" />
            </div>
            <span className="font-bold text-lg tracking-tight">Clarin</span>
          </div>
          <nav className="hidden md:flex items-center gap-6 text-sm text-slate-400">
            <a href="#planes" className="hover:text-white transition-colors">Planes</a>
            <a href="#crm" className="hover:text-white transition-colors">CRM WhatsApp</a>
            <button onClick={() => setMode('login')} className="hover:text-white transition-colors">Ingresar</button>
          </nav>
          <button
            onClick={() => setMode('signup')}
            className="bg-emerald-500 hover:bg-emerald-400 text-slate-950 px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-200 shadow-lg shadow-emerald-500/20"
          >
            Empezar prueba
          </button>
        </div>
      </header>

      <section className="max-w-7xl mx-auto px-4 sm:px-6 py-10 lg:py-16 grid lg:grid-cols-[1.1fr_0.9fr] gap-8 lg:gap-12 items-start">
        <div className="space-y-8">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-emerald-400/20 bg-emerald-400/10 text-emerald-300 text-xs font-medium">
            <Sparkles className="w-3.5 h-3.5" />
            SaaS CRM para equipos que venden por WhatsApp
          </div>

          <div className="space-y-5">
            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight leading-[1.05] max-w-4xl">
              Convierte tus chats de WhatsApp en una operación comercial ordenada.
            </h1>
            <p className="text-base sm:text-lg text-slate-300 max-w-2xl leading-relaxed">
              Centraliza conversaciones, contactos, leads, campañas, eventos y automatizaciones en un solo CRM listo para crecer por cuentas y planes.
            </p>
          </div>

          <div className="grid sm:grid-cols-3 gap-3 max-w-3xl">
            {[
              { icon: MessageSquare, label: 'Chats multi-dispositivo', value: 'WhatsApp Web y API' },
              { icon: BarChart3, label: 'Pipeline comercial', value: 'Leads y etapas' },
              { icon: Zap, label: 'Automatización', value: 'Campañas y flujos' },
            ].map(item => (
              <div key={item.label} className="border border-slate-800 bg-slate-900/70 rounded-xl p-4 transition-all duration-200 hover:border-emerald-500/40">
                <item.icon className="w-5 h-5 text-emerald-400 mb-3" />
                <p className="text-sm font-semibold text-slate-100">{item.label}</p>
                <p className="text-xs text-slate-500 mt-1">{item.value}</p>
              </div>
            ))}
          </div>

          <div id="crm" className="rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl shadow-black/30 overflow-hidden">
            <div className="h-11 border-b border-slate-800 flex items-center justify-between px-4">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-red-400" />
                <span className="w-2.5 h-2.5 rounded-full bg-amber-400" />
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-400" />
              </div>
              <span className="text-xs text-slate-500">Panel Clarin</span>
            </div>
            <div className="grid md:grid-cols-[220px_1fr] min-h-[320px]">
              <aside className="hidden md:block border-r border-slate-800 p-4 space-y-3">
                {['Chats', 'Leads', 'Campañas', 'Eventos', 'Ajustes'].map((item, index) => (
                  <div key={item} className={`h-9 rounded-lg flex items-center px-3 text-sm ${index === 0 ? 'bg-emerald-500/15 text-emerald-300' : 'text-slate-500 bg-slate-950/40'}`}>
                    {item}
                  </div>
                ))}
              </aside>
              <div className="p-4 sm:p-5 space-y-4">
                <div className="grid sm:grid-cols-3 gap-3">
                  {['Leads activos', 'Mensajes nuevos', 'Campañas'].map((item, index) => (
                    <div key={item} className="bg-slate-950 border border-slate-800 rounded-xl p-4">
                      <p className="text-xs text-slate-500">{item}</p>
                      <p className="text-2xl font-bold mt-2 text-slate-100">{[148, 37, 12][index]}</p>
                    </div>
                  ))}
                </div>
                <div className="grid sm:grid-cols-2 gap-3">
                  <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-3">
                    <p className="text-sm font-semibold text-slate-200">Conversación prioritaria</p>
                    <div className="space-y-2">
                      <div className="w-4/5 bg-slate-800 rounded-lg px-3 py-2 text-xs text-slate-300">Hola, quiero información del programa.</div>
                      <div className="ml-auto w-4/5 bg-emerald-500 text-slate-950 rounded-lg px-3 py-2 text-xs font-medium">Te envío los detalles y opciones de pago.</div>
                    </div>
                  </div>
                  <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-3">
                    <p className="text-sm font-semibold text-slate-200">Pipeline</p>
                    {['Nuevo', 'Contactado', 'Cierre'].map((item, index) => (
                      <div key={item} className="flex items-center gap-3">
                        <div className="h-2 rounded-full bg-emerald-400" style={{ width: `${80 - index * 18}%` }} />
                        <span className="text-xs text-slate-500 w-20">{item}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <aside className="lg:sticky lg:top-24 space-y-4">
          <div className="border border-slate-800 bg-slate-900 rounded-2xl shadow-2xl shadow-black/30 overflow-hidden">
            <div className="grid grid-cols-2 p-1 bg-slate-950/70 border-b border-slate-800">
              <button
                onClick={() => { setMode('signup'); setError('') }}
                className={`py-2.5 rounded-xl text-sm font-semibold transition-all ${mode === 'signup' ? 'bg-emerald-500 text-slate-950' : 'text-slate-400 hover:text-white'}`}
              >
                Suscribirme
              </button>
              <button
                onClick={() => { setMode('login'); setError('') }}
                className={`py-2.5 rounded-xl text-sm font-semibold transition-all ${mode === 'login' ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-white'}`}
              >
                Ingresar
              </button>
            </div>

            <div className="p-5 sm:p-6">
              {mode === 'signup' ? (
                <form onSubmit={handleSignup} className="space-y-4">
                  <div>
                    <p className="text-xl font-bold text-white">Crea tu cuenta SaaS</p>
                    <p className="text-sm text-slate-400 mt-1">Prueba gratis y configura tu operación en minutos.</p>
                  </div>

                  {error && <div className="bg-red-500/10 border border-red-500/20 text-red-300 px-4 py-3 rounded-xl text-sm">{error}</div>}

                  <div className="grid sm:grid-cols-2 gap-3">
                    <Field label="Empresa" value={signupForm.account_name} onChange={value => setSignupForm(form => ({ ...form, account_name: value }))} placeholder="Mi empresa" />
                    <Field label="Tu nombre" value={signupForm.display_name} onChange={value => setSignupForm(form => ({ ...form, display_name: value }))} placeholder="Nombre completo" />
                  </div>
                  <Field label="Correo" type="email" value={signupForm.email} onChange={value => setSignupForm(form => ({ ...form, email: value }))} placeholder="ventas@empresa.com" />
                  <PasswordField value={signupForm.password} show={showPassword} onShowChange={setShowPassword} onChange={value => setSignupForm(form => ({ ...form, password: value }))} />

                  <div id="planes" className="space-y-2">
                    <label className="block text-xs font-medium text-slate-400 uppercase tracking-wider">Plan de prueba</label>
                    <div className="grid gap-2">
                      {visiblePlans.map(plan => {
                        const details = planDetails[plan.code] || { price: 'A medida', features: ['Configuración personalizada'] }
                        const active = selectedPlan === plan.code
                        return (
                          <button
                            key={plan.code}
                            type="button"
                            onClick={() => setSelectedPlan(plan.code)}
                            className={`text-left border rounded-xl p-3 transition-all duration-200 ${active ? 'border-emerald-400 bg-emerald-400/10' : 'border-slate-800 bg-slate-950/60 hover:border-slate-700'}`}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <div className="flex items-center gap-2">
                                  <span className="font-semibold text-slate-100">{plan.name}</span>
                                  {details.badge && <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-400/15 text-emerald-300">{details.badge}</span>}
                                </div>
                                <p className="text-xs text-slate-500 mt-1">{plan.description}</p>
                              </div>
                              <div className="text-right shrink-0">
                                <p className="text-sm font-bold text-white">{details.price}</p>
                                <p className="text-[11px] text-slate-500">mensual</p>
                              </div>
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  <button
                    type="submit"
                    className="w-full bg-emerald-500 hover:bg-emerald-400 text-slate-950 py-3 rounded-xl font-bold transition-all disabled:opacity-50 flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/20"
                    disabled={loading}
                  >
                    {loading ? <div className="animate-spin rounded-full h-5 w-5 border-2 border-slate-950/20 border-t-slate-950" /> : <>Crear cuenta y empezar <ArrowRight className="w-4 h-4" /></>}
                  </button>
                </form>
              ) : (
                <form onSubmit={handleLogin} className="space-y-5">
                  <div>
                    <p className="text-xl font-bold text-white">Bienvenido de vuelta</p>
                    <p className="text-sm text-slate-400 mt-1">Ingresa a tu dashboard de Clarin.</p>
                  </div>
                  {error && <div className="bg-red-500/10 border border-red-500/20 text-red-300 px-4 py-3 rounded-xl text-sm">{error}</div>}
                  <div>
                    <label className="block text-xs font-medium text-slate-400 uppercase tracking-wider mb-1.5">Usuario</label>
                    <div className="relative">
                      <User className="absolute left-3.5 top-1/2 -translate-y-1/2 w-[18px] h-[18px] text-slate-500" />
                      <input
                        type="text"
                        value={username}
                        onChange={(event) => setUsername(event.target.value)}
                        placeholder="usuario o correo"
                        className="w-full pl-11 pr-4 py-3 bg-slate-950 border border-slate-700 text-white placeholder:text-slate-600 rounded-xl focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500 outline-none transition-all text-sm"
                        required
                        disabled={loading}
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-400 uppercase tracking-wider mb-1.5">Contraseña</label>
                    <div className="relative">
                      <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-[18px] h-[18px] text-slate-500" />
                      <input
                        type={showPassword ? 'text' : 'password'}
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        placeholder="tu contraseña"
                        className="w-full pl-11 pr-11 py-3 bg-slate-950 border border-slate-700 text-white placeholder:text-slate-600 rounded-xl focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500 outline-none transition-all text-sm"
                        required
                        disabled={loading}
                      />
                      <button type="button" onClick={() => setShowPassword(value => !value)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors" title={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}>
                        {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                  <button
                    type="submit"
                    className="w-full bg-emerald-500 hover:bg-emerald-400 text-slate-950 py-3 rounded-xl font-bold transition-all disabled:opacity-50 flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/20"
                    disabled={loading}
                  >
                    {loading ? <div className="animate-spin rounded-full h-5 w-5 border-2 border-slate-950/20 border-t-slate-950" /> : <>Iniciar sesión <ArrowRight className="w-4 h-4" /></>}
                  </button>
                </form>
              )}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3 text-center">
            {[
              { icon: ShieldCheck, label: 'Multi-tenant' },
              { icon: Users, label: 'Equipos' },
              { icon: Check, label: '14 días' },
            ].map(item => (
              <div key={item.label} className="border border-slate-800 bg-slate-900/70 rounded-xl p-3">
                <item.icon className="w-4 h-4 text-emerald-400 mx-auto" />
                <p className="text-[11px] text-slate-400 mt-2">{item.label}</p>
              </div>
            ))}
          </div>
        </aside>
      </section>
    </main>
  )
}

function Field({ label, value, onChange, placeholder, type = 'text' }: { label: string; value: string; onChange: (value: string) => void; placeholder: string; type?: string }) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-400 uppercase tracking-wider mb-1.5">{label}</label>
      <input
        type={type}
        value={value}
        onChange={event => onChange(event.target.value)}
        placeholder={placeholder}
        className="w-full px-3.5 py-3 bg-slate-950 border border-slate-700 text-white placeholder:text-slate-600 rounded-xl focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500 outline-none transition-all text-sm"
        required
      />
    </div>
  )
}

function PasswordField({ value, show, onShowChange, onChange }: { value: string; show: boolean; onShowChange: (show: boolean) => void; onChange: (value: string) => void }) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-400 uppercase tracking-wider mb-1.5">Contraseña</label>
      <div className="relative">
        <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-[18px] h-[18px] text-slate-500" />
        <input
          type={show ? 'text' : 'password'}
          value={value}
          onChange={event => onChange(event.target.value)}
          placeholder="mínimo 8 caracteres"
          className="w-full pl-11 pr-11 py-3 bg-slate-950 border border-slate-700 text-white placeholder:text-slate-600 rounded-xl focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500 outline-none transition-all text-sm"
          minLength={8}
          required
        />
        <button type="button" onClick={() => onShowChange(!show)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors" title={show ? 'Ocultar contraseña' : 'Mostrar contraseña'}>
          {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        </button>
      </div>
    </div>
  )
}