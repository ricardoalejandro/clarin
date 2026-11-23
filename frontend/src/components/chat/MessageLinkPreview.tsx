'use client'

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Message } from '@/types/chat'
import { getAuthScope, isAuthIdentityChanging, subscribeAuthScope } from '@/lib/authScope'
import { LINK_PREVIEW_THUMBNAIL_SIZE, visibleLinkPreview } from './linkPreviewState'

function Thumbnail({ src }: { src: string }) {
  const image = useRef<HTMLImageElement>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const node = image.current
    return () => { if (node && !node.isConnected) node.removeAttribute('src') }
  }, [])
  return <span aria-hidden="true" className="block h-[72px] w-[72px] shrink-0 overflow-hidden rounded-lg bg-slate-100">
    {!failed && <img ref={image} src={src} width={LINK_PREVIEW_THUMBNAIL_SIZE} height={LINK_PREVIEW_THUMBNAIL_SIZE} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} className="h-full w-full object-cover" />}
  </span>
}

export default function MessageLinkPreview({ message }: { message: Message }) {
  const scope = useSyncExternalStore(subscribeAuthScope, getAuthScope, () => 'server')
  const preview = visibleLinkPreview(message)
  if (!preview || isAuthIdentityChanging(scope)) return null
  return <a href={preview.href} target="_blank" rel="noopener noreferrer" title="Abrir enlace en una pestaña nueva"
    data-whatsapp-ignore="true" data-link-preview="true"
    className="mb-2 flex w-[330px] max-w-full items-start gap-3 rounded-xl border border-slate-900/10 bg-white/55 p-2 text-left hover:bg-white/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
    {preview.thumbnail && <Thumbnail key={`${scope}:${preview.thumbnail}`} src={preview.thumbnail} />}
    <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
      {preview.title && <span className="line-clamp-2 text-sm font-semibold leading-5 text-slate-800">{preview.title}</span>}
      {preview.description && <span className="mt-0.5 line-clamp-2 text-xs leading-4 text-slate-600">{preview.description}</span>}
      <span className="mt-1 block truncate text-[11px] leading-4 text-slate-500">{preview.domain}</span>
    </span>
  </a>
}
