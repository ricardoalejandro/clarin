import { DEFAULT_FONT, MAX_FONT, MIN_FONT, type DocumentFormat, type Panel } from './editorWorkspaceState'
import type { editor } from 'monaco-editor'
import { utf8ByteLength } from './jsonLimits'

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const format = (value: unknown): value is DocumentFormat => value === 'strict' || value === 'jsonc' || value === 'xml'

/** Stored configuration is untrusted even when it belongs to the current user. */
export function validJsonPreference(key: string, value: unknown) {
  switch (key) {
    case 'json.split': case 'json.dark': case 'json.structuralXml': return typeof value === 'boolean'
    case 'json.active': return value === 'a' || value === 'b'
    case 'json.font': return typeof value === 'number' && Number.isFinite(value) && value >= MIN_FONT && value <= MAX_FONT
    case 'json.indent': return value === '2' || value === '4' || value === 'tab'
    case 'json.wrap': case 'json.plainText': return record(value) && typeof value.a === 'boolean' && typeof value.b === 'boolean'
    case 'json.formats': return record(value) && format(value.a) && format(value.b)
    case 'json.chunks': return record(value) && ['a', 'b'].every(panel => Number.isSafeInteger(value[panel]) && Number(value[panel]) >= 0)
    case 'json.originalNames': return record(value) && Object.keys(value).every(panel => (panel === 'a' || panel === 'b') && typeof value[panel] === 'string' && String(value[panel]).length <= 1024)
    default: return false
  }
}

export function safeEditorFont(font: unknown) { return validJsonPreference('json.font', font) ? Number(font) : DEFAULT_FONT }
export function safePanel(panel: unknown): Panel { return panel === 'b' ? 'b' : 'a' }

// Two panels leave 8 KiB for other configuration plus JSON framing below the
// server's existing 64 KiB limit. Opaque folding state must never block text saves.
export const EDITOR_PANEL_VIEW_BUDGET = 28 * 1024 - 128
const MAX_SAVED_CURSORS = 100

export function editorViewsNeedCompaction(value: unknown) {
  if (!record(value)) return false
  for (const panel of ['a', 'b'] as const) {
    if (value[panel] == null) continue
    try { if (utf8ByteLength(JSON.stringify(value[panel])) > EDITOR_PANEL_VIEW_BUDGET) return true } catch { return true }
  }
  return false
}

function position(value: unknown) {
  return record(value) && ['lineNumber', 'column'].every(key => Number.isSafeInteger(value[key]) && Number(value[key]) > 0)
    ? { lineNumber: Number(value.lineNumber), column: Number(value.column) } : null
}

/** Clone only JSON data, stopping as soon as its byte/depth budget is exceeded. */
function boundedJsonClone(value: unknown, bytes: number): unknown {
  const ancestors = new Set<object>()
  const spend = (text: string) => { bytes -= utf8ByteLength(text); if (bytes < 0) throw new RangeError('view budget') }
  const visit = (input: unknown, depth: number): unknown => {
    if (depth > 16) throw new RangeError('view depth')
    if (input === null || input === undefined || typeof input === 'function') { spend('null'); return null }
    if (typeof input === 'string') {
      if (input.length > bytes) throw new RangeError('view budget')
      spend(JSON.stringify(input)); return input
    }
    if (typeof input === 'number' || typeof input === 'boolean') { spend(JSON.stringify(input)); return typeof input === 'number' && !Number.isFinite(input) ? null : input }
    if (typeof input !== 'object' || ancestors.has(input)) throw new RangeError('invalid view data')
    ancestors.add(input)
    try {
      if (Array.isArray(input)) {
        if (input.length > bytes) throw new RangeError('view budget')
        spend('[]')
        return Array.from(input, (item, index) => { if (index) spend(','); return visit(item, depth + 1) })
      }
      if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) throw new RangeError('invalid view data')
      const result: Record<string, unknown> = Object.create(null)
      spend('{}')
      let first = true
      for (const key of Object.keys(input)) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key)
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.value === undefined || typeof descriptor.value === 'function') continue
        if (key.length > bytes) throw new RangeError('view budget')
        spend(`${first ? '' : ','}${JSON.stringify(key)}:`); first = false
        result[key] = visit(descriptor.value, depth + 1)
      }
      return result
    } finally { ancestors.delete(input) }
  }
  return visit(value, 0)
}

export function projectEditorViewState(value: unknown): editor.ICodeEditorViewState | null {
  if (!record(value) || !Array.isArray(value.cursorState) || !record(value.viewState)) return null
  const inputCursors = value.cursorState.length > MAX_SAVED_CURSORS ? value.cursorState.slice(0, 1) : value.cursorState
  const cursors: editor.ICursorState[] = []
  for (const input of inputCursors) {
    if (!record(input) || typeof input.inSelectionMode !== 'boolean') return null
    const start = position(input.selectionStart), current = position(input.position)
    if (!start || !current) return null
    cursors.push({ inSelectionMode: input.inSelectionMode, selectionStart: start, position: current })
  }
  const view = value.viewState, first = position(view.firstPosition)
  if (!first || typeof view.scrollLeft !== 'number' || !Number.isFinite(view.scrollLeft) || typeof view.firstPositionDeltaTop !== 'number' || !Number.isFinite(view.firstPositionDeltaTop)) return null
  const projected: editor.ICodeEditorViewState = {
    cursorState: cursors,
    viewState: { firstPosition: first, scrollLeft: view.scrollLeft, firstPositionDeltaTop: view.firstPositionDeltaTop },
    contributionsState: {},
  }
  for (const key of ['scrollTop', 'scrollTopWithoutViewZones'] as const) {
    if (typeof view[key] === 'number' && Number.isFinite(view[key])) projected.viewState[key] = view[key]
  }
  if (utf8ByteLength(JSON.stringify(projected)) > EDITOR_PANEL_VIEW_BUDGET) projected.cursorState = cursors.slice(0, 1)
  if (record(value.contributionsState)) {
    for (const key of Object.keys(value.contributionsState)) {
      if (key.length > EDITOR_PANEL_VIEW_BUDGET) continue
      const available = EDITOR_PANEL_VIEW_BUDGET - utf8ByteLength(JSON.stringify(projected)) - utf8ByteLength(JSON.stringify(key)) - 4
      try {
        const contribution = boundedJsonClone(value.contributionsState[key], available)
        const candidate = { ...projected, contributionsState: { ...projected.contributionsState, [key]: contribution } }
        if (utf8ByteLength(JSON.stringify(candidate)) <= EDITOR_PANEL_VIEW_BUDGET) projected.contributionsState = candidate.contributionsState
      } catch { /* Only optional contribution state is dropped; source/cursor/scroll stay intact. */ }
    }
  }
  return projected
}

export function safeJsonViews(value: unknown): Partial<Record<Panel, editor.ICodeEditorViewState | null>> {
  if (!record(value)) return {}
  const result: Partial<Record<Panel, editor.ICodeEditorViewState | null>> = {}
  for (const panel of ['a', 'b'] as const) {
    if (value[panel] === null) result[panel] = null
    else {
      const projected = projectEditorViewState(value[panel])
      if (projected) result[panel] = projected
    }
  }
  return result
}
