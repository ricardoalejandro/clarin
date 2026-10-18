/** A raw search hides context immediately; filtering remains independently debounced. */
export function programAttendanceDetailsVisible(rawSearch: string, expanded: boolean) {
  return !rawSearch.trim() && expanded
}

export interface SessionObservationState {
  dirty: boolean
  saving: boolean
  error: string
  count: number
}

export const EMPTY_SESSION_OBSERVATION_STATE: SessionObservationState = { dirty: false, saving: false, error: '', count: 0 }

export function attendanceCloseDecision(dirtyAttendanceCount: number, comments: SessionObservationState) {
  if (comments.saving) return 'wait' as const
  return dirtyAttendanceCount > 0 || comments.dirty ? 'confirm' as const : 'close' as const
}
