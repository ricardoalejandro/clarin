import type { CSSProperties } from 'react'
import type { OperationalWindowMode } from './useOperationalWindow'

export type OperationalWindowVisualState = {
  backdropStyle: CSSProperties
  blocksWorkspace: boolean
}

export function operationalWindowVisualState(mode: OperationalWindowMode, isMobile = false): OperationalWindowVisualState {
  const effectiveMode = isMobile ? 'maximized' : mode
  if (effectiveMode === 'maximized') return { backdropStyle: { backgroundColor: 'rgba(2, 6, 23, 0.45)', backdropFilter: 'blur(3px)' }, blocksWorkspace: true }
  if (effectiveMode === 'docked') return { backdropStyle: { backgroundColor: 'rgba(2, 6, 23, 0.08)', backdropFilter: 'blur(1px)' }, blocksWorkspace: false }
  return { backdropStyle: { backgroundColor: 'rgba(2, 6, 23, 0.18)', backdropFilter: 'blur(2px)' }, blocksWorkspace: false }
}
