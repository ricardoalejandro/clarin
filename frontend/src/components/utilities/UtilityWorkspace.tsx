'use client'

import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { ArrowLeft } from 'lucide-react'
import { UTILITIES_HREF, type Utility } from './catalog'
import { UtilityPrivacyNote } from './UtilitiesCatalog'

const workspaces = {
  json: dynamic(() => import('./json/JsonUtility'), {
    ssr: false,
    loading: () => <p role="status" className="p-4 text-sm text-slate-600">Abriendo editor…</p>,
  }),
  qr: lazy(() => import('./images/QrUtility')),
  'imagen-base64': lazy(() => import('./images/ImageBase64Utility')),
  criptografia: lazy(() => import('./crypto/CryptoUtility')),
}

export function UtilityWorkspace({ utility }: { utility: Utility }) {
  const heading = useRef<HTMLHeadingElement>(null)
  const [documentGeneration, setDocumentGeneration] = useState(0)
  const Workspace = workspaces[utility.id]
  useEffect(() => { heading.current?.focus({ preventScroll: true }) }, [utility.id])
  useEffect(() => {
    const discardBeforeCaching = (event: PageTransitionEvent) => {
      if (event.persisted) flushSync(() => setDocumentGeneration(generation => generation + 1))
    }
    window.addEventListener('pagehide', discardBeforeCaching)
    return () => window.removeEventListener('pagehide', discardBeforeCaching)
  }, [])

  if (utility.id === 'json') {
    return <section aria-labelledby="utility-title" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
      <header className="flex shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-2 sm:px-3">
        <Link prefetch={false} href={`${UTILITIES_HREF}#utilitario-json`} className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-slate-600 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-emerald-600">
          <ArrowLeft aria-hidden="true" size={16} /> Utilitarios
        </Link>
        <h1 ref={heading} tabIndex={-1} id="utility-title" className="border-l border-slate-200 pl-2 text-sm font-semibold text-slate-900 focus:outline-none sm:text-base">{utility.title}</h1>
      </header>
      <Workspace key={documentGeneration} />
    </section>
  }

  return (
    <section aria-labelledby="utility-title" className="@container min-h-0 min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-7xl px-1 pb-3 sm:px-2">
        <header className="mb-4 space-y-1">
          <Link prefetch={false} href={`${UTILITIES_HREF}#utilitario-${utility.id}`} className="inline-flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm font-medium text-slate-600 outline-none hover:bg-slate-100 hover:text-slate-900 focus-visible:ring-2 focus-visible:ring-emerald-600">
            <ArrowLeft aria-hidden="true" size={16} /> Utilitarios
          </Link>
          <h1 ref={heading} tabIndex={-1} id="utility-title" className="text-2xl font-semibold tracking-tight text-slate-900 focus:outline-none">{utility.title}</h1>
          <p className="text-sm text-slate-600">{utility.description}</p>
        </header>
        <Suspense fallback={<p role="status" className="p-4 text-sm text-slate-600">Abriendo herramienta…</p>}>
          <Workspace key={documentGeneration} />
        </Suspense>
        <div className="mt-5"><UtilityPrivacyNote /></div>
      </div>
    </section>
  )
}
