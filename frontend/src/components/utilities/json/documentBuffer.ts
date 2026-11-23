import { JSON_INPUT_LIMIT, utf8ByteLength } from './jsonLimits'

export interface TextChange { rangeOffset: number; rangeLength: number; text: string }

/** Small edits split references to existing chunks instead of copying a 60 MiB string. */
export class DocumentBuffer {
  private pieces: string[]
  length: number
  bytes: number
  constructor(source = '') {
    this.pieces = [source]
    this.length = source.length
    this.bytes = utf8ByteLength(source)
  }

  slice(start: number, end: number) {
    const result: string[] = []
    let offset = 0
    for (const piece of this.pieces) {
      const until = offset + piece.length
      if (until > start && offset < end) result.push(piece.slice(Math.max(0, start - offset), Math.min(piece.length, end - offset)))
      offset = until
      if (offset >= end) break
    }
    return result.join('')
  }

  snapshot() { return this.pieces.join('') }

  apply(changes: readonly TextChange[], maxBytes = JSON_INPUT_LIMIT) {
    const ordered = [...changes].sort((a, b) => a.rangeOffset - b.rangeOffset)
    let previousEnd = 0
    let projectedBytes = this.bytes
    for (const change of ordered) {
      const end = change.rangeOffset + change.rangeLength
      if (!Number.isSafeInteger(change.rangeOffset) || !Number.isSafeInteger(change.rangeLength) || change.rangeOffset < previousEnd || change.rangeLength < 0 || end > this.length) return false
      projectedBytes += utf8ByteLength(change.text) - utf8ByteLength(this.slice(change.rangeOffset, end))
      // A half-surrogate at either boundary would produce a replacement character.
      for (const at of [change.rangeOffset, end]) {
        const around = this.slice(Math.max(0, at - 1), Math.min(this.length, at + 1))
        if (around.length === 2 && /[\uD800-\uDBFF]/.test(around[0]) && /[\uDC00-\uDFFF]/.test(around[1])) return false
      }
      previousEnd = end
    }
    if (projectedBytes > maxBytes) return false
    const pieces: string[] = []
    let cursor = 0
    const appendRange = (from: number, until: number) => {
      let offset = 0
      for (const piece of this.pieces) {
        const end = offset + piece.length
        if (end > from && offset < until) pieces.push(piece.slice(Math.max(0, from - offset), Math.min(piece.length, until - offset)))
        offset = end
        if (offset >= until) break
      }
    }
    for (const change of ordered) {
      appendRange(cursor, change.rangeOffset)
      if (change.text) pieces.push(change.text)
      cursor = change.rangeOffset + change.rangeLength
    }
    appendRange(cursor, this.length)
    this.pieces = pieces
    this.length += ordered.reduce((sum, change) => sum + change.text.length - change.rangeLength, 0)
    this.bytes = projectedBytes
    return true
  }
}
