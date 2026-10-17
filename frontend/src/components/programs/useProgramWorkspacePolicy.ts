'use client'

import { useEffect, useState } from 'react'
import { programWorkspacePolicy } from './programWorkspacePolicy'

export interface ProgramLayoutViewport {
  width: number
  height: number
}

/** A keyboard may resize the layout viewport as well as the visual viewport. */
export function resolveProgramLayoutViewport(previous: ProgramLayoutViewport, next: ProgramLayoutViewport, editing: boolean): ProgramLayoutViewport {
  if (editing && previous.width === next.width && next.height < previous.height) return previous
  return next
}

export function useProgramWorkspacePolicy(workspaceWidth: number) {
  const [environment, setEnvironment] = useState({ coarsePointer: false, viewport: { width: 0, height: 900 } })

  useEffect(() => {
    const media = window.matchMedia('(hover: none), (pointer: coarse)')
    const update = () => {
      const active = document.activeElement
      const editing = active instanceof HTMLElement && (active.isContentEditable || active.matches('input, textarea, [role="textbox"]'))
      const next = { width: window.innerWidth, height: window.innerHeight }
      setEnvironment(previous => ({
        coarsePointer: media.matches,
        viewport: resolveProgramLayoutViewport(previous.viewport, next, editing),
      }))
    }
    update()
    media.addEventListener('change', update)
    window.addEventListener('resize', update)
    return () => {
      media.removeEventListener('change', update)
      window.removeEventListener('resize', update)
    }
  }, [])

  return programWorkspacePolicy(workspaceWidth, environment.coarsePointer, environment.viewport.height)
}
