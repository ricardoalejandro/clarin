import { DOCUMENT_DEPTH_LIMIT, JSON_OUTPUT_LIMIT, utf8ByteLength } from './jsonLimits'

const CHUNK_LENGTH = 16 * 1024

export class DocumentLimitError extends Error {}

export class BoundedDocumentText {
  private readonly chunks: string[] = []
  private readonly parts: string[] = []
  private partLength = 0
  private bytes = 0

  append(text: string) {
    if (!text) return
    this.bytes += utf8ByteLength(text)
    if (this.bytes > JSON_OUTPUT_LIMIT) throw new DocumentLimitError('El resultado supera el límite de 50 MiB. Reduce la sangría o procesa una parte del documento.')
    if (text.length >= CHUNK_LENGTH) {
      this.flush()
      this.chunks.push(text)
      return
    }
    this.parts.push(text)
    this.partLength += text.length
    if (this.partLength >= CHUNK_LENGTH || this.parts.length >= 1024) this.flush()
  }

  private flush() {
    if (this.parts.length) this.chunks.push(this.parts.join(''))
    this.parts.length = 0
    this.partLength = 0
  }

  finish() {
    this.flush()
    return this.chunks.join('')
  }
}

export function indentationLines(indent: '2' | '4' | 'tab') {
  const unit = indent === 'tab' ? '\t' : ' '.repeat(Number(indent))
  return Array.from({ length: DOCUMENT_DEPTH_LIMIT + 2 }, (_, depth) => `\n${unit.repeat(depth)}`)
}
