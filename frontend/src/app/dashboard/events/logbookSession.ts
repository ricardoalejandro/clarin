import { SearchRequestLifecycle, type SearchRequestLease } from '@/lib/searchRequestLifecycle'

type ReadKind = 'list' | 'detail' | 'preview'
export type LogbookSelectionLease = { generation: number; id: string | null }
type LogbookReadLease = LogbookSelectionLease & { request: SearchRequestLease; signal: AbortSignal }

/** Owns one event's logbook requests, selection and late mutation responses. */
export class LogbookSession {
  private alive = true
  private id: string | null = null
  private generation = 0
  private reads = { list: new SearchRequestLifecycle(), detail: new SearchRequestLifecycle(), preview: new SearchRequestLifecycle() }

  activate() { this.alive = true }
  isActive() { return this.alive }
  selectedId() { return this.id }
  selection(): LogbookSelectionLease { return { generation: this.generation, id: this.id } }

  select(id: string | null) {
    if (id === this.id) return
    this.id = id
    this.generation += 1
    this.reads.detail.invalidate()
    this.reads.preview.invalidate()
  }

  isSelected(lease: LogbookSelectionLease) {
    return this.alive && lease.id === this.id && lease.generation === this.generation
  }

  begin(kind: ReadKind): LogbookReadLease {
    const request = this.reads[kind].begin()
    return { ...this.selection(), request, signal: request.signal }
  }

  isCurrent(kind: ReadKind, lease: LogbookReadLease) {
    return this.alive && this.reads[kind].isCurrent(lease.request) && (kind === 'list' || this.isSelected(lease))
  }

  dispose() {
    this.alive = false
    this.generation += 1
    Object.values(this.reads).forEach(read => read.invalidate())
  }
}
