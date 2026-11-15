'use client'

import { createContext, useContext, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export const CryptoToolbarContext = createContext<HTMLElement | null>(null)
export const CryptoHelpContext = createContext(false)

export function CryptoHelp({ children }: { children: ReactNode }) {
  return useContext(CryptoHelpContext) ? <p className="text-xs leading-5 text-slate-600">{children}</p> : null
}

/** Moves commands only; the operation and its draft remain in their original panel. */
export function CryptoToolbarActions({ children }: { children: ReactNode }) {
  const host = useContext(CryptoToolbarContext)
  return host ? createPortal(children, host) : <div className="flex flex-wrap items-center gap-1">{children}</div>
}
