export type SearchRequestLease = {
  generation: number
  signal: AbortSignal
}

/**
 * Owns the lifetime of one remote search stream.
 *
 * Call invalidate as soon as the user edits or clears the query. That aborts
 * transport work immediately and also rejects a response from a transport
 * that completes after abort. Call begin only when the 500 ms debounce has
 * settled and the next request is ready to start.
 */
export class SearchRequestLifecycle {
  private generation = 0
  private controller: AbortController | null = null

  invalidate() {
    this.generation += 1
    this.controller?.abort()
    this.controller = null
  }

  begin(): SearchRequestLease {
    this.invalidate()
    const controller = new AbortController()
    this.controller = controller
    return { generation: this.generation, signal: controller.signal }
  }

  isCurrent(lease: SearchRequestLease) {
    return lease.generation === this.generation && !lease.signal.aborted
  }

  finish(lease: SearchRequestLease) {
    if (!this.isCurrent(lease)) return false
    this.controller = null
    return true
  }
}
