'use client'

import OperationalWindowShell, { type OperationalWindowShellProps } from '@/components/operational-window/OperationalWindowShell'
import { TASK_OVERLAY_LAYERS } from './taskOverlayLayers'

export type TaskWorkWindowShellProps = OperationalWindowShellProps

export default function TaskWorkWindowShell(props: TaskWorkWindowShellProps) {
  return (
    <OperationalWindowShell
      {...props}
      overlayZIndex={props.overlayZIndex ?? TASK_OVERLAY_LAYERS.window}
      temporaryOverlaySelector={props.temporaryOverlaySelector ?? '[data-task-picker-backdrop], [data-task-destructive-dialog], [data-task-color-picker], [data-task-icon-picker]'}
      dataAttribute={props.dataAttribute ?? 'task-work-window'}
    />
  )
}
