import type { CSSProperties } from 'react'
import type { TaskWindowMode } from './useTaskWindow'
import { operationalWindowVisualState } from '@/components/operational-window/operationalWindowVisuals'

export const TASK_DESCRIPTION_DEFAULT_HEIGHT = 112
export const TASK_DESCRIPTION_MIN_HEIGHT = 112
export const TASK_DESCRIPTION_MAX_HEIGHT = 480
export const TASK_DESCRIPTION_HEIGHT_STEP = 24

export type TaskWindowVisualState = {
  backdropStyle: CSSProperties
  blocksWorkspace: boolean
}

export function taskWindowVisualState(mode: TaskWindowMode, isMobile = false): TaskWindowVisualState {
  return operationalWindowVisualState(mode, isMobile)
}

export function clampTaskDescriptionHeight(value: number, availableHeight = TASK_DESCRIPTION_MAX_HEIGHT) {
  const maximum = Math.max(TASK_DESCRIPTION_MIN_HEIGHT, Math.min(TASK_DESCRIPTION_MAX_HEIGHT, availableHeight))
  return Math.min(Math.max(Math.round(value), TASK_DESCRIPTION_MIN_HEIGHT), maximum)
}

export function taskDescriptionHeightFromKey(current: number, key: string, availableHeight = TASK_DESCRIPTION_MAX_HEIGHT) {
  if (key === 'ArrowUp') return clampTaskDescriptionHeight(current - TASK_DESCRIPTION_HEIGHT_STEP, availableHeight)
  if (key === 'ArrowDown') return clampTaskDescriptionHeight(current + TASK_DESCRIPTION_HEIGHT_STEP, availableHeight)
  if (key === 'Home') return TASK_DESCRIPTION_MIN_HEIGHT
  if (key === 'End') return clampTaskDescriptionHeight(availableHeight, availableHeight)
  return null
}

export function taskDescriptionEditorRemainsOpen(saveSucceeded: boolean) {
  return !saveSucceeded
}

export function isTaskEditorSubmitShortcut(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'isComposing'>) {
  return event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing
}

export type ViewportRect = { width: number; height: number }
export type FloatingRect = { left: number; top: number; width: number; height: number }

export function taskWorkspaceMenuPosition(
  anchor: FloatingRect,
  menu: { width: number; height: number },
  viewport: ViewportRect,
  padding = 8,
  gap = 8,
) {
  const below = anchor.top + anchor.height + gap
  const above = anchor.top - menu.height - gap
  const top = below + menu.height <= viewport.height - padding
    ? below
    : Math.max(padding, above)
  const preferredLeft = anchor.left + anchor.width - menu.width
  const left = Math.min(
    Math.max(padding, preferredLeft),
    Math.max(padding, viewport.width - menu.width - padding),
  )
  return { left: Math.round(left), top: Math.round(top) }
}

export function taskAccordionVisualState(collapsed: boolean) {
  return {
    ariaHidden: collapsed,
    contentClass: collapsed
      ? 'invisible grid-rows-[0fr] opacity-0'
      : 'visible grid-rows-[1fr] opacity-100',
    chevronClass: collapsed ? '-rotate-90' : 'rotate-0',
  }
}
