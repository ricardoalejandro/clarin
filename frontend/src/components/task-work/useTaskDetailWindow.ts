'use client'

import useTaskWindow, { type TaskWindowMode, type TaskWindowResizeEdge } from './useTaskWindow'

export type TaskDetailWindowMode = TaskWindowMode
export type TaskDetailResizeEdge = TaskWindowResizeEdge

export default function useTaskDetailWindow(storageScope?: string) {
  return useTaskWindow({ storageKey: 'clarin:tasks:detail-window', storageScope, defaultMode: 'docked', defaultWidth: 880, defaultHeight: 720, minWidth: 440, minHeight: 460, align: 'right' })
}
