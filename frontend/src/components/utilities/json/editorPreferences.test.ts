import { expect, it } from 'vitest'
import { EDITOR_PANEL_VIEW_BUDGET, editorViewsNeedCompaction, projectEditorViewState, safeEditorFont, safeJsonViews, safePanel, validJsonPreference } from './editorPreferences'
import { utf8ByteLength } from './jsonLimits'

it('rejects malformed persisted configuration instead of crashing a reopened editor', () => {
  expect(safePanel('unknown')).toBe('a')
  expect(safeEditorFont(5000)).toBe(14)
  expect(validJsonPreference('json.formats', { a: 'xml', b: 'strict' })).toBe(true)
  expect(validJsonPreference('json.formats', null)).toBe(false)
  expect(validJsonPreference('json.wrap', { a: true })).toBe(false)
  expect(validJsonPreference('json.chunks', { a: -1, b: 0 })).toBe(false)
  expect(validJsonPreference('json.chunks', { a: 0, b: 1 })).toBe(true)
  expect(validJsonPreference('json.originalNames', { a: 'original.xml', '../other': 'bad' })).toBe(false)
  expect(safeJsonViews('bad')).toEqual({})
  expect(safeJsonViews({ a: { cursorState: 'bad' } })).toEqual({})
  const state = { cursorState: [{ inSelectionMode: false, selectionStart: { lineNumber: 2, column: 3 }, position: { lineNumber: 2, column: 3 } }], viewState: { scrollLeft: 0, firstPosition: { lineNumber: 2, column: 1 }, firstPositionDeltaTop: 0 }, contributionsState: {} }
  expect(safeJsonViews({ a: state, b: null })).toEqual({ a: state, b: null })
})

function editorView() {
  return {
    cursorState: [{ inSelectionMode: false, selectionStart: { lineNumber: 20, column: 3 }, position: { lineNumber: 20, column: 8 } }],
    viewState: { firstPosition: { lineNumber: 15, column: 1 }, scrollLeft: 12, scrollTop: 320, scrollTopWithoutViewZones: 320, firstPositionDeltaTop: 2 },
    contributionsState: {} as Record<string, unknown>,
  }
}

it('keeps cursor and scroll when 1000 folded regions exceed the opaque state budget', () => {
  const state = editorView()
  state.contributionsState['editor.contrib.folding'] = { collapsedRegions: Array.from({ length: 1000 }, (_, index) => ({ startLineNumber: index * 3 + 1, endLineNumber: index * 3 + 2, startColumn: 1, endColumn: 100, kind: 'region' })) }
  state.contributionsState['editor.contrib.find'] = { searchString: 'nombre', matchCase: false }
  expect(utf8ByteLength(JSON.stringify(state))).toBeGreaterThan(64 * 1024)
  expect(editorViewsNeedCompaction({ a: state })).toBe(true)
  const projected = projectEditorViewState(state)!
  expect(utf8ByteLength(JSON.stringify(projected))).toBeLessThanOrEqual(EDITOR_PANEL_VIEW_BUDGET)
  expect(projected.cursorState).toEqual(state.cursorState)
  expect(projected.viewState).toEqual(state.viewState)
  expect(projected.contributionsState['editor.contrib.folding']).toBeUndefined()
  expect(projected.contributionsState['editor.contrib.find']).toEqual({ searchString: 'nombre', matchCase: false })
  expect(safeJsonViews({ a: state }).a).toEqual(projected)
  expect(editorViewsNeedCompaction({ a: projected })).toBe(false)
})

it('bounds two panels below the unchanged 64 KiB server limit with 8 KiB reserved for other configuration', () => {
  const state = editorView()
  const searchString = 'á'.repeat(Math.floor((EDITOR_PANEL_VIEW_BUDGET - utf8ByteLength(JSON.stringify(state)) - 80) / 2))
  state.contributionsState['editor.contrib.find'] = { searchString }
  const a = projectEditorViewState(state)!, b = projectEditorViewState(state)!
  expect(a.contributionsState['editor.contrib.find']).toBeDefined()
  expect(utf8ByteLength(JSON.stringify(a))).toBeLessThanOrEqual(EDITOR_PANEL_VIEW_BUDGET)
  expect(utf8ByteLength(JSON.stringify(a))).toBeGreaterThan(EDITOR_PANEL_VIEW_BUDGET - 256)
  const config = { other: 'x'.repeat(8 * 1024 - 20), 'json.views': { a, b } }
  expect(utf8ByteLength(JSON.stringify(config))).toBeLessThan(64 * 1024)
  state.contributionsState['editor.contrib.find'] = { searchString: 'changed' }
  expect(a.contributionsState['editor.contrib.find']).toEqual({ searchString })
})

it('retains the principal selection for huge cursor sets and safely drops cyclic or malformed contributions', () => {
  const state = editorView()
  const first = state.cursorState[0]
  state.cursorState = Array.from({ length: 10_000 }, () => first)
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
  state.contributionsState.cyclic = cyclic
  const projected = projectEditorViewState(state)!
  expect(projected.cursorState).toEqual([first])
  expect(projected.viewState).toEqual(state.viewState)
  expect(projected.contributionsState).toEqual({})
  expect(safeJsonViews({ a: state, b: { cursorState: 'invalid' } })).toEqual({ a: projected })
})
