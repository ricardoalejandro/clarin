'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { ArrowRight, Braces, Image, LockKeyhole, QrCode, ShieldCheck } from 'lucide-react'
import { UTILITIES_HREF, utilities, type Utility } from './catalog'

const icons = { json: Braces, qr: QrCode, 'imagen-base64': Image, criptografia: LockKeyhole }

function UtilityPreview({ id }: { id: Utility['id'] }) {
  const Icon = icons[id]
  return (
    <div aria-hidden="true" className="flex h-24 items-center justify-center gap-3 overflow-hidden rounded-xl border border-slate-200/80 bg-slate-50 px-3">
      <span className="flex size-12 shrink-0 items-center justify-center rounded-xl border border-emerald-100 bg-white text-emerald-700 shadow-sm"><Icon size={24} /></span>
      {id === 'json' && <span className="whitespace-pre rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono text-[11px] leading-4 text-slate-600">{'{\n  "id": 42\n}'}</span>}
      {id === 'qr' && <span className="rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono text-xs text-slate-600">Leer ↔ Generar</span>}
      {id === 'imagen-base64' && <span className="rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono text-xs text-slate-600">iVBORw0…</span>}
      {id === 'criptografia' && <span className="rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono text-xs text-slate-600">AES · RSA</span>}
    </div>
  )
}

export function UtilityPrivacyNote() {
  return <p className="flex items-start gap-2 text-xs leading-5 text-slate-600"><ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-emerald-700" />Tus datos se procesan en este navegador. El contenido se descarta al salir de la herramienta.</p>
}

export function UtilitiesCatalog() {
  useEffect(() => {
    const hash = window.location.hash
    if (utilities.some(tool => `#utilitario-${tool.id}` === hash)) document.getElementById(hash.slice(1))?.focus()
  }, [])

  return (
    <section aria-labelledby="utilities-title" className="min-h-0 min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-6xl px-1 py-2 sm:px-2">
        <header className="mb-5 space-y-1">
          <h1 id="utilities-title" className="text-2xl font-semibold tracking-tight text-slate-900">Utilitarios</h1>
          <p className="text-sm text-slate-600">Herramientas para editar, convertir y verificar datos.</p>
        </header>
        <ul className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 14rem), 1fr))' }}>
          {utilities.map(utility => (
            <li key={utility.id} className="min-w-0">
              <Link prefetch={false} id={`utilitario-${utility.id}`} href={`${UTILITIES_HREF}/${utility.id}`} className="group block h-full rounded-2xl border border-slate-200 bg-white p-3 outline-none transition hover:border-emerald-400 focus-visible:ring-2 focus-visible:ring-emerald-600">
                <UtilityPreview id={utility.id} />
                <div className="flex items-start justify-between gap-2 px-1 pt-3">
                  <div>
                    <h2 className="text-sm font-semibold text-slate-900">{utility.title}</h2>
                    <p className="mt-1 text-sm leading-5 text-slate-600">{utility.description}</p>
                  </div>
                  <ArrowRight aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-slate-400 group-hover:text-emerald-700 group-focus-visible:text-emerald-700" />
                </div>
              </Link>
            </li>
          ))}
        </ul>
        <div className="mt-5"><UtilityPrivacyNote /></div>
      </div>
    </section>
  )
}
