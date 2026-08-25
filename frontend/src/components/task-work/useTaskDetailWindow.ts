'use client'

import useTaskWindow, { type TaskWindowMode, type TaskWindowResizeEdge } from './useTaskWindow'
import { taskDetailInspectorLayout } from './taskDetailInspectorState'

export type TaskDetailWindowMode = TaskWindowMode
export type TaskDetailResizeEdge = TaskWindowResizeEdge

export default function useTaskDetailWindow(storageScope?: string, availableWorkspaceWidth = 0) {
  const layout = taskDetailInspectorLayout(availableWorkspaceWidth)
  const measured = availableWorkspaceWidth > 0
  const windowState = useTaskWindow({
    storageKey: 'clarin:tasks:detail-window',
    storageScope,
    defaultMode: 'docked',
    defaultWidth: 880,
    defaultHeight: 720,
    minWidth: 440,
    minHeight: 460,
    dockedWidth: layout.dockedWidth,
    align: 'right',
    temporaryMode: measured ? layout.temporaryMode : undefined,
  })
  return { ...windowState, canDock: !measured || layout.canDock, dockedWidth: layout.dockedWidth, availableWorkspaceWidth: layout.availableWidth }
}
