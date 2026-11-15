import { DOCUMENT_DEPTH_LIMIT, JSON_INPUT_LIMIT } from './jsonLimits'

export const FOLD_MAX_REGIONS = 5000
export const FOLD_DEBOUNCE_MS = 500
export const FOLD_DEADLINE_MS = 10_000
export const FOLD_CHUNK_LENGTH = 64 * 1024
export const FOLD_READ_BUDGET_MS = 4
export type FoldReason = 'regions' | 'depth' | 'syntax' | 'doctype' | 'size'
export interface DocumentFoldRange { start: number; end: number; kind?: 'comment' | 'region' }
export interface DocumentFoldingStatus {
  phase: 'idle' | 'preparing' | 'ready' | 'limited' | 'timeout' | 'error'
  regions: number
  reason?: FoldReason
}
export interface FoldingResult { ranges: DocumentFoldRange[]; reason?: FoldReason }
interface Candidate extends DocumentFoldRange { depth: number; index: number }

/** Retain shallow sections before their descendants, without collecting every node. */
class BoundedRanges {
  private heap: Candidate[] = []
  private byStart = new Map<number, Candidate>()
  limited = false
  lineLimited = false
  private worse(a: Candidate, b: Candidate) { return a.depth > b.depth || a.depth === b.depth && a.start > b.start }
  private swap(a: number, b: number) {
    const heap = this.heap
    ;[heap[a], heap[b]] = [heap[b], heap[a]]
    heap[a].index = a; heap[b].index = b
  }
  private fix(index: number) {
    while (index > 0) {
      const parent = (index - 1) >> 1
      if (!this.worse(this.heap[index], this.heap[parent])) break
      this.swap(index, parent); index = parent
    }
    for (;;) {
      const left = index * 2 + 1, right = left + 1
      let next = index
      if (left < this.heap.length && this.worse(this.heap[left], this.heap[next])) next = left
      if (right < this.heap.length && this.worse(this.heap[right], this.heap[next])) next = right
      if (next === index) break
      this.swap(index, next); index = next
    }
  }
  offer(start: number, end: number, depth: number, kind?: DocumentFoldRange['kind']) {
    if (end <= start) return
    if (start > 0xffffff || end > 0xffffff) { this.lineLimited = true; return }
    const previous = this.byStart.get(start)
    if (previous) {
      if (depth < previous.depth || depth === previous.depth && end > previous.end) {
        previous.end = end; previous.depth = depth; previous.kind = kind; this.fix(previous.index)
      }
      return
    }
    const entry: Candidate = { start, end, depth, kind, index: this.heap.length }
    if (this.heap.length < FOLD_MAX_REGIONS) {
      this.heap.push(entry); this.byStart.set(start, entry); this.fix(entry.index)
    } else {
      this.limited = true
      if (!this.worse(this.heap[0], entry)) return
      this.byStart.delete(this.heap[0].start)
      entry.index = 0; this.heap[0] = entry; this.byStart.set(start, entry); this.fix(0)
    }
  }
  result() {
    return [...this.heap].sort((a, b) => a.start - b.start).map(({ start, end, kind }) => ({ start, end, ...(kind ? { kind } : {}) }))
  }
}

interface Frame { name: string; start: number }
type JsonState = 'code' | 'string' | 'escape' | 'slash' | 'line' | 'block' | 'star'
type XmlState = 'text' | 'lt' | 'bang' | 'open-name' | 'open-body' | 'close-name' | 'close-body' | 'comment' | 'cdata' | 'pi'
const space = (char: string) => char === ' ' || char === '\t' || char === '\r' || char === '\n'

/** Streaming lexical index. Scalar values and opaque XML contents are never retained. */
export class DocumentFoldingScanner {
  private ranges = new BoundedRanges()
  private stack: Frame[] = []
  private line = 1
  private previousCR = false
  private units = 0
  private reason?: FoldReason
  private stopped = false
  private jsonState: JsonState = 'code'
  private xmlState: XmlState = 'text'
  private markupLine = 1
  private opaqueLine = 1
  private name = ''
  private tail = ''
  private quote = ''
  private lastBody = ''
  constructor(private format: 'json' | 'xml') {}
  get halted() { return this.stopped }
  private stop(reason: FoldReason) { this.reason = reason; this.stopped = true }
  private push(name: string, start: number) {
    if (this.stack.length >= DOCUMENT_DEPTH_LIMIT) { this.stop('depth'); return }
    this.stack.push({ name, start })
  }
  private close(name: string, line: number) {
    const frame = this.stack.at(-1)
    if (!frame || frame.name !== name) { this.stack = []; this.reason ??= 'syntax'; return }
    this.stack.pop()
    this.ranges.offer(frame.start, line - 1, this.stack.length)
  }
  private json(char: string) {
    switch (this.jsonState) {
      case 'string': if (char === '\\') this.jsonState = 'escape'; else if (char === '"') this.jsonState = 'code'; return
      case 'escape': this.jsonState = 'string'; return
      case 'line': if (char === '\r' || char === '\n') this.jsonState = 'code'; return
      case 'block': if (char === '*') this.jsonState = 'star'; return
      case 'star':
        if (char === '/') { this.ranges.offer(this.opaqueLine, this.line - 1, this.stack.length, 'comment'); this.jsonState = 'code' }
        else if (char !== '*') this.jsonState = 'block'
        return
      case 'slash':
        if (char === '/') { this.jsonState = 'line'; return }
        if (char === '*') { this.jsonState = 'block'; this.opaqueLine = this.line; return }
        this.jsonState = 'code'
    }
    if (char === '"') this.jsonState = 'string'
    else if (char === '/') this.jsonState = 'slash'
    else if (char === '{' || char === '[') this.push(char, this.line)
    else if (char === '}' || char === ']') this.close(char === '}' ? '{' : '[', this.line)
  }
  private openBody(char: string) {
    if (this.quote) { if (char === this.quote) this.quote = ''; return }
    if (char === '"' || char === "'") { this.quote = char; this.lastBody = ''; return }
    if (char === '>') {
      if (this.lastBody === '/') this.ranges.offer(this.markupLine, this.line - 1, this.stack.length)
      else this.push(this.name, this.markupLine)
      this.name = ''; this.lastBody = ''; this.xmlState = 'text'
    } else {
      if (char === '<') { this.stop('syntax'); return }
      this.lastBody = char
    }
  }
  private xml(char: string) {
    switch (this.xmlState) {
      case 'text': if (char === '<') { this.markupLine = this.line; this.xmlState = 'lt' }; return
      case 'lt':
        this.name = ''; this.tail = ''; this.quote = ''; this.lastBody = ''
        if (char === '/') this.xmlState = 'close-name'
        else if (char === '!') this.xmlState = 'bang'
        else if (char === '?') this.xmlState = 'pi'
        else { this.name = char; this.xmlState = 'open-name' }
        return
      case 'bang': {
        this.tail += char
        if (this.tail === '--') { this.xmlState = 'comment'; this.tail = '' }
        else if (this.tail === '[CDATA[') { this.xmlState = 'cdata'; this.tail = '' }
        else if (this.tail === 'DOCTYPE') this.stop('doctype')
        else if (!['--', '[CDATA[', 'DOCTYPE'].some(prefix => prefix.startsWith(this.tail))) this.stop('syntax')
        return
      }
      case 'open-name':
        if (space(char) || char === '/' || char === '>') { this.xmlState = 'open-body'; this.openBody(char) }
        else if (char === '<') this.stop('syntax')
        else this.name += char
        return
      case 'open-body': this.openBody(char); return
      case 'close-name':
        if (char === '>') { this.close(this.name, this.markupLine); this.name = ''; this.xmlState = 'text' }
        else if (space(char)) this.xmlState = 'close-body'
        else if (char === '<') this.stop('syntax')
        else this.name += char
        return
      case 'close-body':
        if (char === '>') { this.close(this.name, this.markupLine); this.name = ''; this.xmlState = 'text' }
        else if (!space(char)) { this.stack = []; this.reason ??= 'syntax'; this.xmlState = 'text' }
        return
      case 'comment': case 'cdata': case 'pi': {
        this.tail = (this.tail + char).slice(-3)
        const terminator = this.xmlState === 'comment' ? '-->' : this.xmlState === 'cdata' ? ']]>' : '?>'
        if (this.tail.endsWith(terminator)) {
          this.ranges.offer(this.markupLine, this.line - 1, this.stack.length, this.xmlState === 'comment' ? 'comment' : 'region')
          this.tail = ''; this.xmlState = 'text'
        }
      }
    }
  }
  append(chunk: string) {
    this.units += chunk.length
    if (this.units > JSON_INPUT_LIMIT) this.stop('size')
    for (let index = 0; index < chunk.length && !this.stopped; index++) {
      const char = chunk[index]
      if (this.format === 'json') this.json(char); else this.xml(char)
      if (char === '\r') this.line++
      else if (char === '\n' && !this.previousCR) this.line++
      this.previousCR = char === '\r'
    }
  }
  finish(): FoldingResult {
    if (this.stack.length || this.format === 'json' && !['code', 'line'].includes(this.jsonState) || this.format === 'xml' && this.xmlState !== 'text') this.reason ??= 'syntax'
    return { ranges: this.ranges.result(), reason: this.reason ?? (this.ranges.lineLimited ? 'size' : this.ranges.limited ? 'regions' : undefined) }
  }
}

export type FoldingRequest = { kind: 'start'; id: number; format: 'json' | 'xml' } | { kind: 'chunk'; id: number; text: string; end: boolean }
export type FoldingResponse = { kind: 'ack'; id: number } | { kind: 'result'; id: number; result: FoldingResult }
