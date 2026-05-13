'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import PublicPageScroll from '@/components/PublicPageScroll'
import {
  ArrowRight,
  BarChart3,
  Check,
  ChevronDown,
  MessageSquare,
  ShieldCheck,
  Sparkles,
  Users,
  Zap,
  Star,
  Phone,
  Mail,
  Lock,
  Globe,
  Menu,
  X,
} from 'lucide-react'

const features = [
  { icon: MessageSquare, title: 'Bandeja WhatsApp para equipos', desc: 'Atiende todos tus numeros desde una sola vista, con historial, etiquetas, responsables y mensajes en tiempo real.' },
  { icon: Users, title: 'Contactos y leads ordenados', desc: 'Centraliza clientes, sincroniza fuentes externas y conserva el contexto comercial sin depender de hojas sueltas.' },
  { icon: BarChart3, title: 'Pipeline comercial visible', desc: 'Mira cada oportunidad por etapa, filtra por etiquetas y detecta rapido que conversaciones necesitan seguimiento.' },
  { icon: Zap, title: 'Campañas con control', desc: 'Prepara difusiones segmentadas, adjunta medios y mide estados de envio sin perder trazabilidad.' },
  { icon: ShieldCheck, title: 'Cuentas aisladas', desc: 'Cada empresa trabaja separada por cuenta, usuarios y permisos para mantener la operacion bajo control.' },
  { icon: Lock, title: 'Prueba sin friccion', desc: 'Empieza con 14 dias gratis, sin tarjeta de credito y con una configuracion pensada para equipos comerciales.' },
]

const pricing = [
  { code: 'starter', name: 'Starter', price: 'S/ 149', desc: 'Para equipos pequeños que empiezan.', features: ['3 dispositivos WhatsApp', '5 usuarios', '10 mil contactos', 'Kommo y Google Contacts'] },
  { code: 'pro', name: 'Pro', price: 'S/ 299', desc: 'Para equipos comerciales con más volumen.', features: ['8 dispositivos WhatsApp', '12 usuarios', '50 mil contactos', 'Campañas de difusión'], popular: true },
  { code: 'business', name: 'Business', price: 'S/ 599', desc: 'Para operaciones con automatizaciones.', features: ['20 dispositivos WhatsApp', '30 usuarios', '150 mil contactos', 'Automatizaciones avanzadas'] },
]

const testimonials = [
  { quote: 'Clarin nos ayudo a ordenar mas de 15 numeros de WhatsApp en una sola operacion. El pipeline cambio como seguimos leads.', author: 'Gerencia comercial', company: 'Retail multicanal' },
  { quote: 'Pasamos de responder con hojas de Excel abiertas todo el dia a tener campañas, contactos y conversaciones en una sola pantalla.', author: 'Direccion de marketing', company: 'Agencia digital' },
  { quote: 'La integracion con Kommo fue clave. Ahora el lead entra, se asigna y se atiende por WhatsApp sin perder informacion.', author: 'Direccion general', company: 'Consultora B2B' },
]

const stats = [
  { value: '20+', label: 'dispositivos por cuenta' },
  { value: '150k', label: 'contactos en planes altos' },
  { value: '14 dias', label: 'de prueba gratis' },
]

const faqs = [
  { q: '¿Necesito tarjeta de crédito para la prueba?', a: 'No. La prueba de 14 días es completamente gratuita y no requiere tarjeta de crédito para empezar.' },
  { q: '¿Puedo conectar varios números de WhatsApp?', a: 'Sí. Dependiendo del plan, puedes conectar desde 3 hasta 20 dispositivos WhatsApp a una sola cuenta.' },
  { q: '¿Qué pasa después de los 14 días de prueba?', a: 'Elige el plan que se ajuste a tu operación. Si decides no continuar, tu cuenta se pausa pero puedes exportar tus datos.' },
  { q: '¿Es seguro compartir mi cuenta con mi equipo?', a: 'Totalmente. Cada usuario tiene permisos controlados y cada cuenta está aislada de otras empresas.' },
  { q: '¿Se integra con otros CRMs?', a: 'Sí. Actualmente integramos con Kommo y Google Contacts. Estamos trabajando en más integraciones.' },
]

const APP_URL = (process.env.NEXT_PUBLIC_APP_URL || 'https://clarin.naperu.cloud').replace(/\/$/, '')
const LOGIN_URL = `${APP_URL}/login`
const SIGNUP_URL = `${APP_URL}/signup`

export default function HomePage() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const [openFaq, setOpenFaq] = useState<number | null>(null)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 10)
    window.addEventListener('scroll', onScroll)
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <main className="min-h-screen bg-white text-slate-900">
      <PublicPageScroll />
      {/* Header */}
      <header
        className={`sticky top-0 z-40 transition-all duration-300 ${
          scrolled ? 'border-b border-slate-200 bg-white/90 backdrop-blur shadow-sm' : 'bg-transparent'
        }`}
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="w-9 h-9 bg-emerald-600 rounded-lg flex items-center justify-center shadow-sm">
              <MessageSquare className="w-5 h-5 text-white" />
            </div>
            <span className="font-bold text-lg tracking-tight text-slate-900">Clarin</span>
          </Link>

          <nav className="hidden md:flex items-center gap-8 text-sm font-medium text-slate-600">
            <a href="#funciones" className="hover:text-emerald-600 transition-colors">Funciones</a>
            <a href="#precios" className="hover:text-emerald-600 transition-colors">Precios</a>
            <a href="#faq" className="hover:text-emerald-600 transition-colors">Preguntas</a>
          </nav>

          <div className="hidden md:flex items-center gap-3">
            <Link
              href={LOGIN_URL}
              className="text-sm font-medium text-slate-600 hover:text-slate-900 transition-colors px-4 py-2"
            >
              Ingresar
            </Link>
            <Link
              href={SIGNUP_URL}
              className="bg-emerald-600 hover:bg-emerald-700 text-white px-5 py-2.5 rounded-xl text-sm font-semibold transition-colors shadow-sm"
            >
              Empezar prueba
            </Link>
          </div>

          <button className="md:hidden p-2 text-slate-600" onClick={() => setMobileMenuOpen((v) => !v)}>
            {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
          </button>
        </div>

        {mobileMenuOpen && (
          <div className="md:hidden border-t border-slate-200 bg-white px-4 py-4 space-y-3">
            <a href="#funciones" onClick={() => setMobileMenuOpen(false)} className="block text-sm font-medium text-slate-600 hover:text-emerald-600">Funciones</a>
            <a href="#precios" onClick={() => setMobileMenuOpen(false)} className="block text-sm font-medium text-slate-600 hover:text-emerald-600">Precios</a>
            <a href="#faq" onClick={() => setMobileMenuOpen(false)} className="block text-sm font-medium text-slate-600 hover:text-emerald-600">Preguntas</a>
            <div className="pt-2 flex flex-col gap-2">
              <Link href={LOGIN_URL} className="text-center text-sm font-medium text-slate-600 hover:text-slate-900 border border-slate-200 rounded-xl py-2.5">Ingresar</Link>
              <Link href={SIGNUP_URL} className="text-center bg-emerald-600 hover:bg-emerald-700 text-white py-2.5 rounded-xl text-sm font-semibold transition-colors">Empezar prueba</Link>
            </div>
          </div>
        )}
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(16,185,129,0.16),_transparent_34%),linear-gradient(to_bottom,_#ecfdf5_0%,_#ffffff_48%,_#ffffff_100%)] pointer-events-none" />
        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 pt-14 pb-20 lg:pt-24 lg:pb-28">
          <div className="text-center max-w-3xl mx-auto">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-emerald-200 bg-emerald-50/80 text-emerald-700 text-xs font-semibold mb-6">
              <Sparkles className="w-3.5 h-3.5" />
              CRM para equipos que venden por WhatsApp
            </div>

            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold tracking-tight leading-[1.08] text-slate-900">
              Vende por WhatsApp sin perder{' '}
              <span className="text-emerald-600">leads, contexto ni control</span>
            </h1>

            <p className="mt-6 text-lg sm:text-xl text-slate-600 max-w-2xl mx-auto leading-relaxed">
              Clarin junta conversaciones, contactos, campañas, pipelines y tareas para que tu equipo responda mas rapido y cierre mejor.
            </p>

            <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4">
              <Link
                href={SIGNUP_URL}
                className="w-full sm:w-auto bg-emerald-600 hover:bg-emerald-700 text-white px-8 py-4 rounded-xl font-bold text-base transition-colors shadow-lg shadow-emerald-600/20 flex items-center justify-center gap-2"
              >
                Empezar prueba gratis <ArrowRight className="w-5 h-5" />
              </Link>
              <a
                href="#funciones"
                className="w-full sm:w-auto bg-white hover:bg-slate-50 text-slate-700 border border-slate-300 px-8 py-4 rounded-xl font-semibold text-base transition-colors flex items-center justify-center"
              >
                Conocer funciones
              </a>
            </div>

            <p className="mt-4 text-sm text-slate-400">Sin tarjeta de crédito · 14 días gratis · Cancela cuando quieras</p>

            <div className="mt-10 grid grid-cols-3 gap-3 max-w-xl mx-auto">
              {stats.map((stat) => (
                <div key={stat.label} className="rounded-xl border border-emerald-100 bg-white/75 px-3 py-4 shadow-sm">
                  <p className="text-2xl font-extrabold text-slate-900 tracking-tight">{stat.value}</p>
                  <p className="mt-1 text-xs font-medium text-slate-500">{stat.label}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Product mockup */}
          <div className="mt-14 lg:mt-20 max-w-5xl mx-auto">
            <div className="relative rounded-2xl border border-slate-200 bg-white shadow-2xl shadow-emerald-900/10 overflow-hidden">
              <div className="bg-slate-50 border-b border-slate-200 px-4 py-3 flex items-center gap-2">
                <div className="flex gap-1.5">
                  <div className="w-3 h-3 rounded-full bg-red-400" />
                  <div className="w-3 h-3 rounded-full bg-amber-400" />
                  <div className="w-3 h-3 rounded-full bg-emerald-400" />
                </div>
                <div className="ml-4 flex-1 max-w-md">
                  <div className="bg-white border border-slate-200 rounded-md px-3 py-1 text-xs text-slate-400">app.clarin.io/dashboard</div>
                </div>
              </div>
              <div className="grid grid-cols-12 min-h-[360px]">
                <div className="col-span-3 border-r border-slate-100 bg-slate-50/70 p-4 space-y-3 hidden sm:block">
                  <div className="h-9 bg-emerald-600 rounded-lg px-3 flex items-center text-xs font-bold text-white">Chats activos</div>
                  {['Maria Lopez', 'Carlos Vera', 'Inmobiliaria Sur', 'Lead Iquitos', 'Nuevo contacto'].map((name, i) => (
                    <div key={name} className="flex items-center gap-2 rounded-lg bg-white border border-slate-100 p-2">
                      <div className={`w-8 h-8 rounded-full ${i === 0 ? 'bg-emerald-100' : 'bg-slate-200'}`} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-semibold text-slate-700">{name}</p>
                        <p className="truncate text-[11px] text-slate-400">{i === 0 ? 'Quiere una demo hoy' : 'Mensaje pendiente'}</p>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="col-span-12 sm:col-span-9 p-4 sm:p-6">
                  <div className="flex items-center justify-between mb-6">
                    <div>
                      <p className="text-sm font-bold text-slate-900">Panel comercial</p>
                      <p className="text-xs text-slate-500">Seguimiento de conversaciones y oportunidades</p>
                    </div>
                    <div className="flex gap-2">
                      <div className="h-8 px-3 bg-emerald-100 text-emerald-700 rounded-lg text-xs font-bold flex items-center">+18%</div>
                      <div className="h-8 px-3 bg-slate-100 text-slate-500 rounded-lg text-xs font-bold flex items-center">Hoy</div>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
                    {[
                      ['Leads nuevos', '48', '12 sin asignar'],
                      ['Respuestas', '92%', 'promedio del dia'],
                      ['Campanas', '3', 'en ejecucion'],
                    ].map(([label, value, hint]) => (
                      <div key={label} className="border border-slate-100 rounded-xl p-4 bg-white shadow-sm">
                        <p className="text-xs font-medium text-slate-400">{label}</p>
                        <p className="mt-1 text-2xl font-extrabold text-slate-900">{value}</p>
                        <p className="mt-1 text-[11px] text-slate-400">{hint}</p>
                      </div>
                    ))}
                  </div>
                  <div className="border border-slate-100 rounded-xl overflow-hidden">
                    <div className="grid grid-cols-4 bg-slate-50 p-3 border-b border-slate-100 text-xs font-semibold text-slate-400">
                      <span>Contacto</span>
                      <span>Estado</span>
                      <span>Asignado</span>
                      <span>Último mensaje</span>
                    </div>
                    {[
                      ['Maria Lopez', 'Caliente', 'Ana', 'Puede hoy a las 4pm'],
                      ['Carlos Vera', 'Propuesta', 'Luis', 'Pidio cotizacion'],
                      ['Lead Iquitos', 'Seguimiento', 'Rosa', 'Enviar recordatorio'],
                      ['Empresa Norte', 'Nuevo', 'Sin asignar', 'Pregunta por plan Pro'],
                    ].map(([contact, status, owner, msg]) => (
                      <div key={contact} className="grid grid-cols-4 p-3 items-center border-b border-slate-50 last:border-0 text-xs">
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="w-7 h-7 rounded-full bg-slate-200 shrink-0" />
                          <span className="truncate font-semibold text-slate-700">{contact}</span>
                        </div>
                        <span className="w-fit rounded-full bg-emerald-50 px-2 py-1 font-semibold text-emerald-700">{status}</span>
                        <span className="text-slate-500">{owner}</span>
                        <span className="truncate text-slate-500">{msg}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Social proof */}
      <section className="py-10 border-y border-slate-100 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-6">Equipos de todo tipo confían en Clarin</p>
          <div className="flex flex-wrap items-center justify-center gap-x-10 gap-y-4 opacity-40 grayscale">
            {['Retail', 'Agencias', 'Consultoras', 'E-commerce', 'Inmobiliarias', 'Salud'].map((name) => (
              <span key={name} className="text-lg font-bold text-slate-700 tracking-tight">{name}</span>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="funciones" className="py-20 lg:py-28 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6">
          <div className="text-center max-w-2xl mx-auto mb-16">
            <h2 className="text-3xl sm:text-4xl font-bold text-slate-900">Todo lo que necesitas para vender más</h2>
            <p className="mt-4 text-lg text-slate-600">Una plataforma completa que reemplaza las hojas de cálculo y los grupos de WhatsApp desordenados.</p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-8">
            {features.map((item) => (
              <div key={item.title} className="group rounded-2xl p-6 transition-all hover:bg-emerald-50/40 border border-transparent hover:border-emerald-100">
                <div className="w-12 h-12 rounded-xl bg-emerald-50 flex items-center justify-center mb-5 group-hover:bg-emerald-100 transition-colors">
                  <item.icon className="w-6 h-6 text-emerald-600" />
                </div>
                <h3 className="font-semibold text-slate-900 text-lg mb-2">{item.title}</h3>
                <p className="text-slate-600 leading-relaxed">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Testimonials */}
      <section className="py-20 lg:py-28 bg-slate-50/50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6">
          <div className="text-center max-w-2xl mx-auto mb-16">
            <h2 className="text-3xl sm:text-4xl font-bold text-slate-900">Lo que dicen nuestros clientes</h2>
            <p className="mt-4 text-lg text-slate-600">Empresas que ya organizaron su operación con Clarin.</p>
          </div>

          <div className="grid md:grid-cols-3 gap-8">
            {testimonials.map((t, i) => (
              <div key={i} className="bg-white rounded-2xl p-8 border border-slate-100 shadow-sm">
                <div className="flex gap-1 mb-4">
                  {Array.from({ length: 5 }).map((_, j) => (
                    <Star key={j} className="w-4 h-4 text-amber-400 fill-amber-400" />
                  ))}
                </div>
                <p className="text-slate-700 leading-relaxed mb-6">&ldquo;{t.quote}&rdquo;</p>
                <div>
                  <p className="font-semibold text-slate-900 text-sm">{t.author}</p>
                  <p className="text-slate-500 text-sm">{t.company}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="precios" className="py-20 lg:py-28 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6">
          <div className="text-center max-w-2xl mx-auto mb-16">
            <h2 className="text-3xl sm:text-4xl font-bold text-slate-900">Planes simples y transparentes</h2>
            <p className="mt-4 text-lg text-slate-600">Empieza gratis por 14 días. Escoge el plan que se ajuste al tamaño de tu operación.</p>
          </div>

          <div className="grid md:grid-cols-3 gap-8 max-w-5xl mx-auto">
            {pricing.map((plan) => (
              <div
                key={plan.code}
                className={`relative rounded-2xl border p-8 flex flex-col transition-all hover:shadow-lg ${
                  plan.popular ? 'border-emerald-500 bg-white shadow-md' : 'border-slate-200 bg-white hover:border-slate-300'
                }`}
              >
                {plan.popular && (
                  <div className="absolute -top-4 left-1/2 -translate-x-1/2">
                    <span className="bg-emerald-600 text-white text-xs font-bold px-4 py-1.5 rounded-full shadow-sm">Más elegido</span>
                  </div>
                )}
                <div className="mb-6">
                  <h3 className="text-lg font-bold text-slate-900">{plan.name}</h3>
                  <p className="text-sm text-slate-500 mt-1">{plan.desc}</p>
                </div>
                <div className="mb-8">
                  <span className="text-4xl font-extrabold text-slate-900">{plan.price}</span>
                  <span className="text-slate-500 text-sm">/mes</span>
                </div>
                <ul className="space-y-4 mb-8 flex-1">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-start gap-3 text-sm text-slate-600">
                      <Check className="w-5 h-5 text-emerald-600 shrink-0" />
                      {f}
                    </li>
                  ))}
                </ul>
                <Link
                  href={SIGNUP_URL}
                  className={`w-full text-center py-3 rounded-xl text-sm font-bold transition-colors ${
                    plan.popular ? 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm' : 'bg-white border border-slate-300 hover:bg-slate-50 text-slate-700'
                  }`}
                >
                  Elegir {plan.name}
                </Link>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="py-20 lg:py-28 bg-slate-50/50">
        <div className="max-w-3xl mx-auto px-4 sm:px-6">
          <div className="text-center mb-16">
            <h2 className="text-3xl sm:text-4xl font-bold text-slate-900">Preguntas frecuentes</h2>
            <p className="mt-4 text-lg text-slate-600">Todo lo que necesitas saber antes de empezar.</p>
          </div>

          <div className="space-y-4">
            {faqs.map((faq, i) => (
              <div key={i} className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                <button
                  onClick={() => setOpenFaq(openFaq === i ? null : i)}
                  className="w-full flex items-center justify-between p-5 text-left"
                >
                  <span className="font-semibold text-slate-900 pr-4">{faq.q}</span>
                  <ChevronDown className={`w-5 h-5 text-slate-400 shrink-0 transition-transform ${openFaq === i ? 'rotate-180' : ''}`} />
                </button>
                {openFaq === i && (
                  <div className="px-5 pb-5 text-slate-600 leading-relaxed">
                    {faq.a}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-20 lg:py-28 bg-emerald-600">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 text-center">
          <h2 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight">
            Empieza a vender más por WhatsApp hoy
          </h2>
          <p className="mt-4 text-emerald-100 text-lg max-w-2xl mx-auto">
            Únete a los equipos que ya organizaron su operación comercial con Clarin.
          </p>
          <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link
              href={SIGNUP_URL}
              className="w-full sm:w-auto bg-white hover:bg-emerald-50 text-emerald-700 px-8 py-4 rounded-xl font-bold text-base transition-colors shadow-lg flex items-center justify-center gap-2"
            >
              Crear cuenta gratis <ArrowRight className="w-5 h-5" />
            </Link>
            <Link
              href={LOGIN_URL}
              className="w-full sm:w-auto bg-emerald-700 hover:bg-emerald-800 text-white border border-emerald-500 px-8 py-4 rounded-xl font-semibold text-base transition-colors flex items-center justify-center"
            >
              Ya tengo cuenta
            </Link>
          </div>
          <p className="mt-4 text-sm text-emerald-200/80">Sin tarjeta de crédito · Configuración en minutos</p>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-white border-t border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-12">
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-8 mb-12">
            <div>
              <div className="flex items-center gap-2 mb-4">
                <div className="w-8 h-8 bg-emerald-600 rounded-lg flex items-center justify-center">
                  <MessageSquare className="w-4 h-4 text-white" />
                </div>
                <span className="font-bold text-slate-900">Clarin</span>
              </div>
              <p className="text-sm text-slate-500 leading-relaxed">
                CRM WhatsApp para equipos comerciales que quieren crecer sin perder el control de sus conversaciones.
              </p>
            </div>
            <div>
              <h4 className="font-semibold text-slate-900 mb-4 text-sm">Producto</h4>
              <ul className="space-y-2 text-sm text-slate-500">
                <li><a href="#funciones" className="hover:text-emerald-600 transition-colors">Funciones</a></li>
                <li><a href="#precios" className="hover:text-emerald-600 transition-colors">Precios</a></li>
                <li><Link href={SIGNUP_URL} className="hover:text-emerald-600 transition-colors">Registro</Link></li>
                <li><Link href={LOGIN_URL} className="hover:text-emerald-600 transition-colors">Ingresar</Link></li>
              </ul>
            </div>
            <div>
              <h4 className="font-semibold text-slate-900 mb-4 text-sm">Legal</h4>
              <ul className="space-y-2 text-sm text-slate-500">
                <li><a href="#" className="hover:text-emerald-600 transition-colors">Términos de servicio</a></li>
                <li><a href="#" className="hover:text-emerald-600 transition-colors">Política de privacidad</a></li>
              </ul>
            </div>
            <div>
              <h4 className="font-semibold text-slate-900 mb-4 text-sm">Contacto</h4>
              <ul className="space-y-2 text-sm text-slate-500">
                <li className="flex items-center gap-2"><Mail className="w-4 h-4" /> hola@clarin.io</li>
                <li className="flex items-center gap-2"><Phone className="w-4 h-4" /> +51 999 888 777</li>
                <li className="flex items-center gap-2"><Globe className="w-4 h-4" /> www.clarin.io</li>
              </ul>
            </div>
          </div>
          <div className="border-t border-slate-100 pt-8 flex flex-col sm:flex-row items-center justify-between gap-4">
            <p className="text-sm text-slate-400">© {new Date().getFullYear()} Clarin CRM. Todos los derechos reservados.</p>
            <div className="flex items-center gap-2 text-sm text-slate-400">
              <ShieldCheck className="w-4 h-4" />
              Seguro y confiable
            </div>
          </div>
        </div>
      </footer>
    </main>
  )
}
