type Row = Record<string, unknown>
export const offlineTaskCreateFields = ['title', 'description', 'parent_task_id', 'start_at', 'due_at', 'due_end_at', 'is_all_day', 'priority', 'status_id', 'assigned_to', 'type', 'color']
export const offlineTaskUpdateFields = ['title', 'description', 'start_at', 'due_at', 'due_end_at', 'is_all_day', 'priority', 'starred', 'progress', 'manual_progress', 'progress_mode', 'is_milestone', 'notes', 'status_id', 'assigned_to', 'type', 'color']

/** The canonical editor submits the entire draft. Only discard known defaults
 * (or unchanged online-only fields), never a user's unsupported modification. */
export function offlineTaskMutationInput(change: Row, current?: Row) {
  const supported = current ? offlineTaskUpdateFields : offlineTaskCreateFields
  const payload: Row = {}, unsupported: string[] = []
  const defaults: Row = { progress: 0, manual_progress: 0, progress_mode: 'manual', is_milestone: false, recurrence_rule: '', reminder_minutes: 0 }
  for (const [key, raw] of Object.entries(change)) {
    if (['operation_id', 'version'].includes(key)) continue
    if (key === 'confirm_grants') { if (raw === true) unsupported.push(key); continue }
    if (key === 'id' || key === 'list_id') { if (current && raw !== current[key]) unsupported.push(key); continue }
    if (key === 'status' || key === 'status_category') { if (current) payload[key] = raw; else unsupported.push(key); continue }
    if (supported.includes(key)) {
      payload[key] = ['start_at', 'due_at', 'due_end_at'].includes(key) && raw === '' ? null : raw
      if (key === 'status_id' && (raw === '' || raw === null)) delete payload[key]
      continue
    }
    if (key === 'collaborator_ids') {
      const before = current && Array.isArray(current.collaborators) ? current.collaborators.map(person => String((person as Row).user_id)).sort() : []
      if (!Array.isArray(raw) || JSON.stringify([...raw].sort()) !== JSON.stringify(before)) unsupported.push(key)
      continue
    }
    if (key in defaults) {
      const expected = current?.[key] ?? defaults[key]
      if (raw !== expected && !(raw == null && expected === defaults[key])) unsupported.push(key)
      continue
    }
    unsupported.push(key)
  }
  return { payload, unsupported }
}
