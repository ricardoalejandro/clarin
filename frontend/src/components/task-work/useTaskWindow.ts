'use client'

import useOperationalWindow, {
  OPERATIONAL_WINDOW_MARGIN,
  OPERATIONAL_WINDOW_PREFERENCE_VERSION,
  clampOperationalWindowGeometry,
  defaultOperationalWindowGeometry,
  operationalWindowScopedStorageKey,
  parseLegacyOperationalWindowMode,
  parseOperationalWindowPreference,
  type OperationalWindowGeometry,
  type OperationalWindowMode,
  type OperationalWindowOptions,
  type OperationalWindowPreference,
  type OperationalWindowResizeEdge,
  type OperationalWindowViewport,
} from '@/components/operational-window/useOperationalWindow'

export type TaskWindowMode = OperationalWindowMode
export type TaskWindowResizeEdge = OperationalWindowResizeEdge
export type TaskWindowGeometry = OperationalWindowGeometry
export type TaskWindowViewport = OperationalWindowViewport
export type TaskWindowPreference = OperationalWindowPreference
export type TaskWindowOptions = OperationalWindowOptions

export const TASK_WINDOW_PREFERENCE_VERSION = OPERATIONAL_WINDOW_PREFERENCE_VERSION
export const TASK_WINDOW_MARGIN = OPERATIONAL_WINDOW_MARGIN
export const taskWindowScopedStorageKey = operationalWindowScopedStorageKey
export const defaultTaskWindowGeometry = defaultOperationalWindowGeometry
export const clampTaskWindowGeometry = clampOperationalWindowGeometry
export const parseTaskWindowPreference = parseOperationalWindowPreference
export const parseLegacyTaskWindowMode = parseLegacyOperationalWindowMode

export default useOperationalWindow
