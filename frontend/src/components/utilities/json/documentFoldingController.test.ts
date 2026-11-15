import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { editor, languages } from 'monaco-editor'
import { LARGE_JSON_LANGUAGE } from './editorWorkspaceState'
import { documentFoldingRanges, DocumentFoldingSession, registerDocumentFolding } from './documentFoldingController'
import { FOLD_CHUNK_LENGTH, type DocumentFoldingStatus, type FoldingRequest, type FoldingResponse } from './documentFolding'

function model(source = '[\n1\n]', initialLanguage = LARGE_JSON_LANGUAGE) {
  let revision = 1, language = initialLanguage
  const contents = new Set<() => void>(), languagesChanged = new Set<() => void>(), disposing = new Set<() => void>()
  const offset = (position: { lineNumber: number; column: number }) => source.split('\n').slice(0, position.lineNumber - 1).reduce((sum, line) => sum + line.length + 1, 0) + position.column - 1
  const value = {
    getVersionId: () => revision, getLanguageId: () => language, getValueLength: () => source.length, isDisposed: () => false,
    getPositionAt: (at: number) => { const rows = source.slice(0, at).split('\n'); return { lineNumber: rows.length, column: rows.at(-1)!.length + 1 } },
    getValueInRange: vi.fn((range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }) => source.slice(offset({ lineNumber: range.startLineNumber, column: range.startColumn }), offset({ lineNumber: range.endLineNumber, column: range.endColumn }))),
    onDidChangeContent: (listener: () => void) => { contents.add(listener); return { dispose() { contents.delete(listener) } } },
    onDidChangeLanguage: (listener: () => void) => { languagesChanged.add(listener); return { dispose() { languagesChanged.delete(listener) } } },
    onWillDispose: (listener: () => void) => { disposing.add(listener); return { dispose() { disposing.delete(listener) } } },
  }
  return { value: value as unknown as editor.ITextModel,
    change(next: string) { source = next; revision++; contents.forEach(listener => listener()) },
    language(next: string) { language = next; languagesChanged.forEach(listener => listener()) },
    listeners: () => contents.size + languagesChanged.size + disposing.size,
    dispose() { disposing.forEach(listener => listener()) },
  }
}

class FoldWorker {
  requests: FoldingRequest[] = []
  onmessage?: (event: { data: FoldingResponse }) => void
  onerror?: (event: { preventDefault(): void }) => void
  terminated = false
  postMessage(request: FoldingRequest) { this.requests.push(request) }
  terminate() { this.terminated = true }
  respond(response: FoldingResponse) { this.onmessage?.({ data: response }) }
  get id() { return this.requests[0].id }
}
const sessions: DocumentFoldingSession[] = []
beforeEach(() => vi.useFakeTimers())
afterEach(() => { sessions.splice(0).forEach(session => session.dispose()); vi.useRealTimers() })
function setup(source?: string, language?: string) {
  const document = model(source, language), workers: FoldWorker[] = [], statuses: DocumentFoldingStatus[] = []
  const session = new DocumentFoldingSession(document.value, status => statuses.push(status), () => { const worker = new FoldWorker(); workers.push(worker); return worker as unknown as Worker })
  sessions.push(session)
  return { document, workers, statuses, session }
}

it('returns only synchronous arrays and keeps small/native models outside the large-file provider', async () => {
  const register = vi.fn(), registry = { registerFoldingRangeProvider: register }
  registerDocumentFolding(registry); registerDocumentFolding(registry)
  expect(register).toHaveBeenCalledTimes(1)
  const provider = register.mock.calls[0][1] as languages.FoldingRangeProvider
  const changed = vi.fn(), subscription = provider.onDidChange!(changed)
  const { document, workers, session } = setup(undefined, 'xml')
  expect(documentFoldingRanges(document.value)).toBeUndefined()
  session.setEnabled(true)
  expect(documentFoldingRanges(document.value)).toEqual([])
  await vi.advanceTimersByTimeAsync(499)
  expect(workers).toHaveLength(0)
  await vi.advanceTimersByTimeAsync(1)
  workers[0].respond({ kind: 'result', id: workers[0].id, result: { ranges: [{ start: 1, end: 2, kind: 'comment' }] } })
  expect(documentFoldingRanges(document.value)).toEqual([{ start: 1, end: 2, kind: { value: 'comment' } }])
  expect(changed).toHaveBeenCalled()
  expect(workers[0].terminated).toBe(true)
  subscription.dispose()
  const small = setup(undefined, 'json')
  small.session.setEnabled(true)
  await vi.advanceTimersByTimeAsync(500)
  expect(small.workers).toHaveLength(0)
})

it('feeds one bounded surrogate-safe block per acknowledgement instead of a whole-file snapshot', async () => {
  const { workers, session } = setup('x'.repeat(FOLD_CHUNK_LENGTH - 1) + '😀\nend')
  session.setEnabled(true)
  await vi.advanceTimersByTimeAsync(500)
  const worker = workers[0]
  expect(worker.requests).toHaveLength(1)
  worker.respond({ kind: 'ack', id: worker.id })
  await vi.advanceTimersByTimeAsync(1)
  const first = worker.requests[1]
  expect(first.kind).toBe('chunk')
  if (first.kind !== 'chunk') throw new Error('missing first block')
  expect(first.text).toHaveLength(FOLD_CHUNK_LENGTH - 1)
  expect(first.end).toBe(false)
  await vi.advanceTimersByTimeAsync(100)
  expect(worker.requests).toHaveLength(2)
  worker.respond({ kind: 'ack', id: worker.id })
  await vi.advanceTimersByTimeAsync(1)
  const last = worker.requests[2]
  expect(last.kind === 'chunk' && last.text).toBe('😀\nend')
  expect(last.kind === 'chunk' && last.end).toBe(true)
})

it('cancels stale revisions immediately, enforces 500 ms and ignores old worker responses', async () => {
  const { document, workers, statuses, session } = setup()
  session.setEnabled(true)
  await vi.advanceTimersByTimeAsync(500)
  const old = workers[0]
  document.change('[\n2\n]')
  expect(old.terminated).toBe(true)
  old.respond({ kind: 'result', id: old.id, result: { ranges: [{ start: 1, end: 2 }] } })
  expect(documentFoldingRanges(document.value)).toEqual([])
  expect(statuses.at(-1)?.phase).toBe('preparing')
  await vi.advanceTimersByTimeAsync(499)
  document.change('[\n3\n]')
  await vi.advanceTimersByTimeAsync(499)
  expect(workers).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(workers).toHaveLength(2)
  const current = workers[1]
  current.respond({ kind: 'result', id: current.id, result: { ranges: [{ start: 1, end: 2 }] } })
  session.setEnabled(false)
  session.setEnabled(true)
  await vi.advanceTimersByTimeAsync(500)
  expect(workers).toHaveLength(2)
  expect(documentFoldingRanges(document.value)).toEqual([{ start: 1, end: 2 }])
})

it('releases pending timers, workers, subscriptions and caches on hide, language change and disposal', async () => {
  const { document, workers, session } = setup()
  session.setEnabled(true); session.setEnabled(false)
  await vi.advanceTimersByTimeAsync(500)
  expect(workers).toHaveLength(0)
  session.setEnabled(true)
  await vi.advanceTimersByTimeAsync(500)
  workers[0].respond({ kind: 'ack', id: workers[0].id })
  document.language('plaintext')
  await vi.advanceTimersByTimeAsync(500)
  expect(workers[0].terminated).toBe(true)
  expect(workers[0].requests).toHaveLength(1)
  expect(documentFoldingRanges(document.value)).toBeUndefined()
  document.language('xml')
  await vi.advanceTimersByTimeAsync(500)
  session.dispose()
  expect(workers[1].terminated).toBe(true)
  expect(document.listeners()).toBe(0)
  expect(documentFoldingRanges(document.value)).toBeUndefined()
  expect(vi.getTimerCount()).toBe(0)
})

it('bounds stalled and failing work with recoverable status, independently for both panels', async () => {
  const a = setup(), b = setup()
  a.session.setEnabled(true); b.session.setEnabled(true)
  await vi.advanceTimersByTimeAsync(500)
  a.workers[0].onerror?.({ preventDefault() {} })
  expect(a.statuses.at(-1)?.phase).toBe('error')
  expect(a.workers[0].terminated).toBe(true)
  expect(b.workers[0].terminated).toBe(false)
  await vi.advanceTimersByTimeAsync(10_000)
  expect(b.statuses.at(-1)?.phase).toBe('timeout')
  expect(b.workers[0].terminated).toBe(true)
  b.session.setEnabled(false); b.session.setEnabled(true)
  await vi.advanceTimersByTimeAsync(500)
  expect(b.workers).toHaveLength(2)
})
