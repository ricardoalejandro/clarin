import type { editor, languages } from 'monaco-editor'
import { LARGE_JSON_LANGUAGE } from './editorWorkspaceState'
import { FOLD_CHUNK_LENGTH, FOLD_DEADLINE_MS, FOLD_DEBOUNCE_MS, FOLD_READ_BUDGET_MS, type DocumentFoldingStatus, type FoldingResult, type FoldingResponse } from './documentFolding'

type FoldingModel = Pick<editor.ITextModel, 'getVersionId' | 'getLanguageId' | 'getValueLength' | 'getPositionAt' | 'getValueInRange' | 'isDisposed' | 'onDidChangeContent' | 'onDidChangeLanguage' | 'onWillDispose'>
type Registry = Pick<typeof languages, 'registerFoldingRangeProvider'>
const sessions = new WeakMap<FoldingModel, DocumentFoldingSession>()
const notifications = new Set<() => void>()
const registries = new WeakSet<Registry>()
const idle: DocumentFoldingStatus = { phase: 'idle', regions: 0 }

/** Always synchronous. A pending/cancelled Promise would trigger Monaco's indent fallback. */
export function documentFoldingRanges(model: FoldingModel): languages.FoldingRange[] | undefined {
  const session = sessions.get(model)
  if (!session) return model.getLanguageId() === LARGE_JSON_LANGUAGE ? [] : undefined
  return session.ranges()
}

export function registerDocumentFolding(registry: Registry) {
  if (registries.has(registry)) return
  registries.add(registry)
  const provider: languages.FoldingRangeProvider = {
    provideFoldingRanges: documentFoldingRanges,
    onDidChange(listener) {
      const notify = () => listener(provider)
      notifications.add(notify)
      return { dispose() { notifications.delete(notify) } }
    },
  }
  registry.registerFoldingRangeProvider([LARGE_JSON_LANGUAGE, 'xml'], provider)
}

function read(model: FoldingModel, start: number, end: number) {
  const from = model.getPositionAt(start), until = model.getPositionAt(end)
  return model.getValueInRange({ startLineNumber: from.lineNumber, startColumn: from.column, endLineNumber: until.lineNumber, endColumn: until.column })
}

export class DocumentFoldingSession {
  private enabled = false
  private disposed = false
  private generation = 0
  private cache?: { revision: number; language: string; result: FoldingResult; ranges: languages.FoldingRange[] }
  private worker?: Worker
  private debounce?: ReturnType<typeof setTimeout>
  private deadline?: ReturnType<typeof setTimeout>
  private scheduled?: ReturnType<typeof setTimeout>
  private listeners: { dispose(): void }[]
  private status: DocumentFoldingStatus = idle
  constructor(private model: FoldingModel, private report: (status: DocumentFoldingStatus) => void,
    private createWorker = () => new Worker(new URL('./documentFolding.worker.ts', import.meta.url), { type: 'module' })) {
    sessions.set(model, this)
    this.listeners = [model.onDidChangeContent(() => this.invalidate()), model.onDidChangeLanguage(() => this.invalidate()), model.onWillDispose(() => this.dispose())]
  }
  private eligible() { return this.enabled && !this.disposed && !this.model.isDisposed() && [LARGE_JSON_LANGUAGE, 'xml'].includes(this.model.getLanguageId()) }
  private fresh() { return this.cache?.revision === this.model.getVersionId() && this.cache.language === this.model.getLanguageId() }
  private update(status: DocumentFoldingStatus) {
    if (this.status.phase === status.phase && this.status.regions === status.regions && this.status.reason === status.reason) return
    this.status = status; this.report(status)
  }
  private notify() { for (const notify of notifications) notify() }
  private cancel() {
    this.generation++
    clearTimeout(this.debounce); clearTimeout(this.deadline); clearTimeout(this.scheduled)
    this.debounce = this.deadline = this.scheduled = undefined
    this.worker?.terminate(); this.worker = undefined
  }
  private settled(result: FoldingResult): DocumentFoldingStatus {
    return { phase: result.reason ? 'limited' : 'ready', regions: result.ranges.length, ...(result.reason ? { reason: result.reason } : {}) }
  }
  setEnabled(enabled: boolean) {
    if (this.enabled === enabled) return
    this.enabled = enabled
    this.invalidate()
  }
  private invalidate() {
    this.cancel()
    if (!this.eligible() || !this.model.getValueLength()) { this.update(idle); return }
    if (this.fresh()) { this.update(this.settled(this.cache!.result)); this.notify(); return }
    this.update({ phase: 'preparing', regions: 0 })
    this.debounce = setTimeout(() => this.start(), FOLD_DEBOUNCE_MS)
  }
  ranges(): languages.FoldingRange[] | undefined {
    if (!this.eligible()) return this.model.getLanguageId() === LARGE_JSON_LANGUAGE ? [] : undefined
    return this.fresh() ? this.cache!.ranges : []
  }
  private start() {
    this.debounce = undefined
    if (!this.eligible()) return
    const model = this.model, revision = model.getVersionId(), language = model.getLanguageId(), generation = this.generation
    const current = () => this.generation === generation && this.eligible() && model.getVersionId() === revision && model.getLanguageId() === language
    const fail = (phase: 'error' | 'timeout') => {
      if (!current()) return
      this.cancel(); this.cache = undefined; this.update({ phase, regions: 0 }); this.notify()
    }
    try {
      const worker = this.worker = this.createWorker()
      let offset = 0
      const next = () => {
        this.scheduled = undefined
        if (!current() || this.worker !== worker) return
        const started = performance.now(), length = model.getValueLength()
        let end = Math.min(length, offset + FOLD_CHUNK_LENGTH)
        if (end < length) {
          const around = read(model, end - 1, end + 1)
          if (/[\uD800-\uDBFF]/.test(around[0]) && /[\uDC00-\uDFFF]/.test(around[1])) end--
        }
        const text = read(model, offset, end)
        if (!current()) return
        offset = end
        const send = () => { this.scheduled = undefined; if (current() && this.worker === worker) worker.postMessage({ kind: 'chunk', id: generation, text, end: end === length }) }
        // One bounded read per task; yield before copying if its read spent the budget.
        if (performance.now() - started >= FOLD_READ_BUDGET_MS) this.scheduled = setTimeout(send, 0)
        else send()
      }
      worker.onmessage = (event: MessageEvent<FoldingResponse>) => {
        if (!current() || this.worker !== worker || event.data.id !== generation) return
        if (event.data.kind === 'ack') { this.scheduled = setTimeout(next, 0); return }
        const result = event.data.result
        this.cancel()
        this.cache = { revision, language, result, ranges: result.ranges.map(({ start, end, kind }) => ({ start, end, ...(kind ? { kind: { value: kind } } : {}) })) }
        this.update(this.settled(result)); this.notify()
      }
      worker.onerror = event => { event.preventDefault(); fail('error') }
      this.deadline = setTimeout(() => fail('timeout'), FOLD_DEADLINE_MS)
      worker.postMessage({ kind: 'start', id: generation, format: language === 'xml' ? 'xml' : 'json' })
    } catch { fail('error') }
  }
  dispose() {
    if (this.disposed) return
    this.cancel(); this.disposed = true
    for (const listener of this.listeners) listener.dispose()
    this.listeners = []; this.cache = undefined
    if (sessions.get(this.model) === this) sessions.delete(this.model)
  }
}
