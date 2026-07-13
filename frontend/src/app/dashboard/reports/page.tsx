'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, BarChart3, Search, ShieldAlert, UsersRound } from 'lucide-react'
import { REPORT_CATALOG } from '@/lib/reportCatalog'

type AccessState = 'loading' | 'allowed' | 'denied'

export default function ReportsPage() {
  const [access, setAccess] = useState<AccessState>('loading')
  const [search, setSearch] = useState('')

  useEffect(() => {
    let active = true
    const check = async () => {
      try {
        const token = localStorage.getItem('token')
        const response = await fetch('/api/me', { headers: token ? { Authorization: `Bearer ${token}` } : {}, credentials: 'include' })
        const data = await response.json()
        const user = data.user
        const allowed = Boolean(user && (user.is_admin || user.is_super_admin || user.permissions?.includes('*') || user.permissions?.includes('reports')))
        if (active) setAccess(allowed ? 'allowed' : 'denied')
      } catch {
        if (active) setAccess('denied')
      }
    }
    check()
    return () => { active = false }
  }, [])

  const reports = REPORT_CATALOG.filter(report => {
    const term = search.trim().toLocaleLowerCase('es')
    return !term || `${report.title} ${report.description} ${report.category}`.toLocaleLowerCase('es').includes(term)
  })

  if (access === 'loading') {
    return <div className="flex h-full items-center justify-center"><div className="h-8 w-8 animate-spin rounded-full border-2 border-emerald-200 border-t-emerald-600" /></div>
  }

  if (access === 'denied') {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <ShieldAlert className="mx-auto h-10 w-10 text-amber-500" />
          <h1 className="mt-4 text-xl font-bold text-slate-800">Acceso restringido</h1>
          <p className="mt-2 text-sm text-slate-500">Necesitas el permiso de Reportería para consultar esta sección.</p>
        </div>
      </div>
    )
  }

  return (
    <main className="h-full overflow-y-auto bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-5xl">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-emerald-600"><BarChart3 className="h-4 w-4" /> Reportería</div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">Centro de reportes</h1>
            <p className="mt-2 text-sm text-slate-500">Selecciona un reporte, completa sus parámetros y genera información lista para analizar.</p>
          </div>
          <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 shadow-sm">
            <Search className="h-4 w-4 text-slate-400" />
            <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Buscar reporte…" className="h-10 w-56 bg-transparent text-sm outline-none placeholder:text-slate-400" />
          </div>
        </div>

        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-bold text-slate-800">Reportes disponibles</h2>
              <p className="mt-0.5 text-xs text-slate-400">{reports.length} {reports.length === 1 ? 'reporte disponible' : 'reportes disponibles'}</p>
            </div>
          </div>
          {reports.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-200 py-14 text-center text-sm text-slate-400">No hay reportes que coincidan con tu búsqueda.</div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {reports.map(report => (
                <Link key={report.id} href={report.href} className="group rounded-2xl border border-slate-200 bg-slate-50/60 p-5 transition hover:-translate-y-0.5 hover:border-emerald-300 hover:bg-white hover:shadow-lg hover:shadow-emerald-900/5">
                  <div className="flex items-start gap-4">
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700"><UsersRound className="h-6 w-6" /></div>
                    <div className="min-w-0 flex-1">
                      <span className="rounded-full bg-emerald-50 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-emerald-700">{report.category}</span>
                      <h3 className="mt-3 text-base font-bold text-slate-800 group-hover:text-emerald-700">{report.title}</h3>
                      <p className="mt-1.5 text-sm leading-6 text-slate-500">{report.description}</p>
                      <div className="mt-4 flex items-center gap-1.5 text-xs font-bold text-emerald-600">Abrir reporte <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" /></div>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  )
}
