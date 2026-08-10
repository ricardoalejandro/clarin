'use client'

import dynamic from 'next/dynamic'

const GuestWhiteboardEditor = dynamic(() => import('@/components/whiteboards/GuestWhiteboardEditor'), {
  ssr: false,
  loading: () => <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm font-bold text-slate-500">Cargando pizarra…</div>,
})

export default function SharedWhiteboardPage({ params }: { params: { id: string } }) {
  return <GuestWhiteboardEditor key={params.id} shareLinkID={params.id} />
}
