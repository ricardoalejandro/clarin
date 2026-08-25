'use client'

import { Fragment, useState, type ReactNode } from 'react'
import { OperationalOverlayProvider, useOperationalOverlayRegistry } from './OperationalOverlayContext'

interface Props {
  children: ReactNode
  hostZIndex?: number
}

/**
 * Gives legacy drawers a semantic portal host without changing their window
 * behavior. New complex surfaces should prefer OperationalWindowShell.
 */
export default function OperationalOverlayBoundary({ children, hostZIndex = 90 }: Props) {
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const [, setOverlayCount] = useState(0)
  const registerOverlay = useOperationalOverlayRegistry(setOverlayCount)

  return (
    <OperationalOverlayProvider portalTarget={host} registerOverlay={registerOverlay}>
      <Fragment>{children}</Fragment>
      <div ref={setHost} data-operational-overlay-host className="pointer-events-none fixed inset-0" style={{ zIndex: hostZIndex }} />
    </OperationalOverlayProvider>
  )
}
