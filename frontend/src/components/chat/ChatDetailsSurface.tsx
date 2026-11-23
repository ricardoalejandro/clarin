import type { ReactNode } from 'react'

/** One mounted detail session reflows between docked, drawer and mobile. */
export default function ChatDetailsSurface({ mode, width, suspended, children }: {
  mode: 'wide' | 'medium' | 'compact'; width: number; suspended: boolean; children: ReactNode
}) {
  return <div data-chat-details-surface
    className={mode === 'wide' ? 'shrink-0 overflow-hidden bg-white' : `absolute inset-y-0 right-0 z-30 overflow-hidden bg-white shadow-2xl ${mode === 'compact' ? 'left-0' : 'border-l border-slate-200'}`}
    hidden={mode !== 'wide' && suspended} inert={suspended}
    style={mode === 'wide' ? { width } : { ...(mode === 'compact' ? {} : { width: 'clamp(360px, 38vw, 440px)', maxWidth: '92%' }), ...(suspended ? { display: 'none' } : {}) }}
  >{children}</div>
}
