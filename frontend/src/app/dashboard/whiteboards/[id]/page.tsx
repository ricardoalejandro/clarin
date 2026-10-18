'use client'

import dynamic from 'next/dynamic'
import { useEffect, useState } from 'react'
import { useParams, usePathname } from 'next/navigation'
import { canonicalResourceID } from '@/lib/offlineCanonicalRoute'

const WhiteboardEditor = dynamic(() => import('@/components/whiteboards/WhiteboardEditor'), {
  ssr: false,
  loading: () => <div className="flex h-full items-center justify-center bg-slate-50 text-sm font-bold text-slate-500">Cargando editor…</div>,
})

export default function WhiteboardEditorPage() {
  const params = useParams<{ id: string }>()
  const pathname = usePathname()
  const [committedPathname, setCommittedPathname] = useState('')
  // A cached static shell can render before Next commits the address bar.
  // Subscribe to route changes and read the committed URL after navigation.
  useEffect(() => { setCommittedPathname(window.location.pathname) }, [pathname])
  const boardID = canonicalResourceID(params?.id, 'whiteboards', pathname || '')
    || canonicalResourceID(undefined, 'whiteboards', committedPathname)
  if (!boardID) return <div className="flex h-full items-center justify-center bg-slate-50 text-sm font-bold text-slate-500">Cargando editor…</div>
  return <WhiteboardEditor boardID={boardID} />
}
