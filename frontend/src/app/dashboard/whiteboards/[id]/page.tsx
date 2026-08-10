'use client'

import dynamic from 'next/dynamic'

const WhiteboardEditor = dynamic(() => import('@/components/whiteboards/WhiteboardEditor'), {
  ssr: false,
  loading: () => <div className="flex h-full items-center justify-center bg-slate-50 text-sm font-bold text-slate-500">Cargando editor…</div>,
})

export default function WhiteboardEditorPage({ params }: { params: { id: string } }) {
  return <WhiteboardEditor boardID={params.id} />
}
