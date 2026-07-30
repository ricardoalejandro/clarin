'use client'

import useTaskWindow, { type TaskWindowMode, type TaskWindowResizeEdge } from './useTaskWindow'

export type TaskDetailWindowMode = TaskWindowMode
export type TaskDetailResizeEdge = TaskWindowResizeEdge

export default function useTaskDetailWindow() {
  return useTaskWindow({ storageKey: 'clarin:tasks:detail-window:v2', defaultMode: 'docked', defaultWidth: 760, defaultHeight: 760, minWidth: 440, minHeight: 460, align: 'right' })
}
