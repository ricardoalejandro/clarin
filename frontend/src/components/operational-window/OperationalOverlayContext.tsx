'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react'

export const OPERATIONAL_OVERLAY_LAYERS = {
  popover: 10,
  menu: 20,
  picker: 30,
  sheet: 40,
  dialog: 50,
  confirmation: 60,
} as const

interface OperationalOverlayContextValue {
  portalTarget: HTMLElement | null
  registerOverlay: (overlayId: string) => () => void
}

const OperationalOverlayContext = createContext<OperationalOverlayContextValue | null>(null)

interface ProviderProps {
  portalTarget: HTMLElement | null
  registerOverlay: (overlayId: string) => () => void
  children: ReactNode
}

export function OperationalOverlayProvider({ portalTarget, registerOverlay, children }: ProviderProps) {
  const value = useMemo(() => ({ portalTarget, registerOverlay }), [portalTarget, registerOverlay])
  return <OperationalOverlayContext.Provider value={value}>{children}</OperationalOverlayContext.Provider>
}

export function useOperationalOverlayPortal() {
  return useContext(OperationalOverlayContext)?.portalTarget ?? null
}

export function useOperationalOverlayRegistration(active: boolean, overlayId: string) {
  const registerOverlay = useContext(OperationalOverlayContext)?.registerOverlay

  useEffect(() => {
    if (!active || !registerOverlay) return
    return registerOverlay(overlayId)
  }, [active, overlayId, registerOverlay])
}

export function useOperationalOverlayTarget(explicitTarget?: HTMLElement | null) {
  const contextualTarget = useOperationalOverlayPortal()
  return explicitTarget ?? contextualTarget
}

export function useOperationalOverlayRegistry(onCountChange: (count: number) => void) {
  const overlays = useMemo(() => new Set<string>(), [])
  return useCallback((overlayId: string) => {
    overlays.add(overlayId)
    onCountChange(overlays.size)
    return () => {
      overlays.delete(overlayId)
      onCountChange(overlays.size)
    }
  }, [onCountChange, overlays])
}
