interface StorageReadQueueOptions<T> {
  timeoutMs: number
  read: (signal: AbortSignal) => Promise<T>
  onStart: () => void
  onResult: (result: T, revision: number) => boolean
  onError: (reason: 'timeout' | 'request') => void
  onSettled: () => void
}

/** One resource session. Ordinary invalidations queue one follow-up read;
 * explicit resource/scope changes dispose the session immediately. */
export class StorageReadQueue<T> {
  private controller: AbortController | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private queued = false
  private stopped = false

  constructor(private revision: number, private readonly options: StorageReadQueueOptions<T>) {}

  invalidate(revision: number) {
    if (this.revision === revision || this.stopped) return
    this.revision = revision
    this.start()
  }

  start() {
    if (this.stopped) return
    if (this.controller) { this.queued = true; return }
    const controller = new AbortController()
    this.controller = controller
    this.options.onStart()
    void this.run(controller)
  }

  private async run(controller: AbortController) {
    do {
      this.queued = false
      // Each actual read gets its own deadline. Hints neither cancel the read
      // nor extend its deadline; successful reads do not accumulate wait time.
      this.timer = setTimeout(() => {
        if (this.controller !== controller) return
        this.stopped = true
        controller.abort()
        this.controller = null
        this.queued = false
        this.options.onError('timeout')
        this.options.onSettled()
      }, this.options.timeoutMs)
      try {
        const result = await this.options.read(controller.signal)
        if (this.controller !== controller || controller.signal.aborted) return
        clearTimeout(this.timer)
        // Canonical success can release the current view immediately even
        // when hints received during this read require a follow-up.
        if (!this.options.onResult(result, this.revision)) {
          this.stopped = true
          break
        }
      } catch {
        if (this.controller !== controller || controller.signal.aborted) return
        this.stopped = true
        this.options.onError('request')
        break
      }
    } while (this.queued && !this.stopped)
    if (this.controller !== controller) return
    clearTimeout(this.timer)
    this.controller = null
    this.queued = false
    this.options.onSettled()
  }

  dispose() {
    this.stopped = true
    this.queued = false
    clearTimeout(this.timer)
    this.controller?.abort()
    this.controller = null
  }
}
