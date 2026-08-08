'use client'

import { ArrowLeft } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'
import { useContainerWidth } from '@/components/responsive/useContainerWidth'

type Props = {
  detail: ReactNode
  chat?: ReactNode
  chatOpen?: boolean
  onBackToDetail?: () => void
}

export function crmDetailWorkspaceLayout(width: number, chatOpen: boolean) {
  if (!chatOpen) return 'detail' as const
  return width >= 980 ? 'split' as const : 'chat' as const
}

export default function CrmDetailWorkspace({ detail, chat, chatOpen = false, onBackToDetail }: Props) {
  const { ref, width } = useContainerWidth<HTMLDivElement>()
  const layout = crmDetailWorkspaceLayout(width, chatOpen)
  const split = layout === 'split'

  useEffect(() => {
    if (!chatOpen || split) return
    const closeChat = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      event.stopPropagation()
      onBackToDetail?.()
    }
    document.addEventListener('keydown', closeChat, true)
    return () => document.removeEventListener('keydown', closeChat, true)
  }, [chatOpen, onBackToDetail, split])

  return (
    <div ref={ref} className="flex h-full min-h-0 min-w-0 bg-slate-50">
      {chatOpen && chat && (
        <section className={`${split ? 'min-w-[480px] flex-1 border-r' : 'w-full'} flex min-h-0 min-w-0 flex-col border-slate-200 bg-slate-50`} aria-label="Conversación">
          {!split && (
            <div className="shrink-0 border-b border-slate-200 bg-white px-3 py-2">
              <button type="button" onClick={onBackToDetail} className="inline-flex min-h-10 items-center gap-2 rounded-xl px-3 text-xs font-bold text-slate-700 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
                <ArrowLeft className="h-4 w-4" /> Volver al detalle
              </button>
            </div>
          )}
          <div className="min-h-0 flex-1">{chat}</div>
        </section>
      )}
      <section className={`${chatOpen && !split ? 'hidden' : 'flex'} ${split ? 'w-[440px] shrink-0' : 'min-w-0 flex-1'} min-h-0 flex-col bg-white`} aria-label="Detalle CRM">
        {detail}
      </section>
    </div>
  )
}
