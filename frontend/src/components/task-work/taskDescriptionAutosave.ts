export const TASK_DESCRIPTION_AUTOSAVE_DELAY_MS = 800
export const TASK_DESCRIPTION_SAVED_VISIBLE_MS = 1_500

export type TaskDescriptionSavePhase = 'idle' | 'dirty' | 'saving' | 'saved' | 'error' | 'conflict'

export type TaskDescriptionConflict = {
  description: string
  version: number
  updated_at?: string
}

export type TaskDescriptionSaveOutcome =
  | { kind: 'success'; description: string }
  | { kind: 'conflict'; message: string; current: TaskDescriptionConflict }
  | { kind: 'error'; message: string }

export type TaskDescriptionSaveRequest = {
  taskId: string
  description: string
  versionOverride?: number
}

export type TaskDescriptionAutosaveState = {
  taskId: string
  draft: string
  canonical: string
  phase: TaskDescriptionSavePhase
  message?: string
  conflict?: TaskDescriptionConflict
}

type Entry = TaskDescriptionAutosaveState & {
  composing: boolean
  timer: ReturnType<typeof setTimeout> | null
  savedTimer: ReturnType<typeof setTimeout> | null
  inFlight: Promise<boolean> | null
  inFlightValue?: string
  versionOverride?: number
}

type Options = {
  save: (request: TaskDescriptionSaveRequest) => Promise<TaskDescriptionSaveOutcome>
  onStateChange?: (taskId: string, state: TaskDescriptionAutosaveState) => void
  autosaveDelayMs?: number
  savedVisibleMs?: number
}

function publicState(entry: Entry): TaskDescriptionAutosaveState {
  return {
    taskId: entry.taskId,
    draft: entry.draft,
    canonical: entry.canonical,
    phase: entry.phase,
    message: entry.message,
    conflict: entry.conflict,
  }
}

export class TaskDescriptionAutosaveCoordinator {
  private readonly entries = new Map<string, Entry>()
  private readonly save: Options['save']
  private readonly onStateChange?: Options['onStateChange']
  private readonly autosaveDelayMs: number
  private readonly savedVisibleMs: number
  private disposed = false

  constructor(options: Options) {
    this.save = options.save
    this.onStateChange = options.onStateChange
    this.autosaveDelayMs = options.autosaveDelayMs ?? TASK_DESCRIPTION_AUTOSAVE_DELAY_MS
    this.savedVisibleMs = options.savedVisibleMs ?? TASK_DESCRIPTION_SAVED_VISIBLE_MS
  }

  hydrate(taskId: string, canonical: string, draft = canonical, canonicalState?: TaskDescriptionConflict) {
    this.disposed = false
    const existing = this.entries.get(taskId)
    if (existing) {
      this.syncCanonical(taskId, canonical, canonicalState)
      return publicState(existing)
    }
    const entry: Entry = {
      taskId,
      canonical,
      draft,
      phase: draft === canonical ? 'idle' : 'dirty',
      composing: false,
      timer: null,
      savedTimer: null,
      inFlight: null,
    }
    this.entries.set(taskId, entry)
    if (entry.phase === 'dirty') this.schedule(entry)
    this.emit(entry)
    return publicState(entry)
  }

  getState(taskId: string) {
    const entry = this.entries.get(taskId)
    return entry ? publicState(entry) : undefined
  }

  change(taskId: string, draft: string, composing = false) {
    const entry = this.entries.get(taskId) || this.createEntry(taskId, draft)
    entry.draft = draft
    entry.composing = composing
    this.clearSavedTimer(entry)

    if (entry.phase === 'conflict' && draft === entry.canonical) {
      entry.conflict = undefined
      entry.message = undefined
      entry.phase = 'idle'
      this.emit(entry)
      return
    }
    if (entry.phase === 'conflict') {
      this.emit(entry)
      return
    }
    if (entry.inFlight) {
      entry.phase = 'saving'
      entry.message = undefined
      this.emit(entry)
      return
    }
    if (draft === entry.canonical) {
      this.clearTimer(entry)
      entry.phase = 'idle'
      entry.message = undefined
      entry.versionOverride = undefined
      this.emit(entry)
      return
    }
    entry.phase = 'dirty'
    entry.message = undefined
    if (!composing) this.schedule(entry)
    else this.clearTimer(entry)
    this.emit(entry)
  }

  setComposing(taskId: string, composing: boolean) {
    const entry = this.entries.get(taskId)
    if (!entry) return
    entry.composing = composing
    if (!composing && entry.phase === 'dirty' && entry.draft !== entry.canonical) this.schedule(entry)
  }

  syncCanonical(taskId: string, canonical: string, current?: TaskDescriptionConflict) {
    const entry = this.entries.get(taskId)
    if (!entry) {
      this.hydrate(taskId, canonical)
      return
    }
    if (current) {
      this.receiveRemote(taskId, current)
      return
    }
    const wasClean = entry.draft === entry.canonical && !entry.inFlight && entry.phase !== 'conflict'
    entry.canonical = canonical
    if (wasClean) entry.draft = canonical
    this.emit(entry)
  }

  receiveRemote(taskId: string, current: TaskDescriptionConflict) {
    const entry = this.entries.get(taskId)
    if (!entry) {
      this.hydrate(taskId, current.description)
      return
    }
    if (current.description === entry.canonical) {
      if (entry.conflict) entry.conflict = current
      this.emit(entry)
      return
    }
    const matchesWriteInFlight = Boolean(entry.inFlight && entry.inFlightValue === current.description)
    const isDirty = entry.draft !== entry.canonical
    const remoteMatchesUnsavedDraft = !entry.inFlight && entry.draft === current.description
    entry.canonical = current.description
    if ((!isDirty && !entry.inFlight) || remoteMatchesUnsavedDraft) {
      entry.draft = current.description
      entry.phase = 'idle'
      entry.message = undefined
      entry.conflict = undefined
      this.clearTimer(entry)
    } else if (!matchesWriteInFlight) {
      this.clearTimer(entry)
      entry.phase = 'conflict'
      entry.message = 'La descripción cambió en otra sesión.'
      entry.conflict = current
    }
    this.emit(entry)
  }

  async flush(taskId: string): Promise<boolean> {
    const entry = this.entries.get(taskId)
    if (!entry) return true
    this.clearTimer(entry)
    if (entry.phase === 'conflict') return false
    if (entry.inFlight) return entry.inFlight
    if (entry.draft === entry.canonical) {
      entry.phase = 'idle'
      entry.message = undefined
      this.emit(entry)
      return true
    }

    const requestedDescription = entry.draft
    const versionOverride = entry.versionOverride
    entry.versionOverride = undefined
    entry.inFlightValue = requestedDescription
    entry.phase = 'saving'
    entry.message = undefined
    this.emit(entry)

    const request = this.save({ taskId, description: requestedDescription, versionOverride })
      .catch((): TaskDescriptionSaveOutcome => ({ kind: 'error', message: 'No se pudo guardar la descripción.' }))

    const completion = request.then(async outcome => {
      entry.inFlight = null
      entry.inFlightValue = undefined
      if (outcome.kind === 'success') {
        entry.canonical = outcome.description
        entry.conflict = undefined
        entry.message = undefined
        if (entry.draft !== entry.canonical) {
          entry.phase = 'dirty'
          this.emit(entry)
          return this.flush(taskId)
        }
        entry.phase = 'saved'
        this.emit(entry)
        this.showSavedTemporarily(entry)
        return true
      }
      if (outcome.kind === 'conflict') {
        entry.canonical = outcome.current.description
        entry.phase = 'conflict'
        entry.conflict = outcome.current
        entry.message = outcome.message
        this.emit(entry)
        return false
      }
      entry.phase = 'error'
      entry.message = outcome.message
      this.emit(entry)
      return false
    })
    entry.inFlight = completion
    return completion
  }

  retry(taskId: string) {
    const entry = this.entries.get(taskId)
    if (!entry || entry.phase !== 'error') return Promise.resolve(false)
    entry.phase = 'dirty'
    entry.message = undefined
    this.emit(entry)
    return this.flush(taskId)
  }

  keepLocal(taskId: string) {
    const entry = this.entries.get(taskId)
    if (!entry?.conflict) return Promise.resolve(false)
    entry.versionOverride = entry.conflict.version
    entry.conflict = undefined
    entry.message = undefined
    entry.phase = entry.draft === entry.canonical ? 'idle' : 'dirty'
    this.emit(entry)
    return this.flush(taskId)
  }

  useRemote(taskId: string) {
    const entry = this.entries.get(taskId)
    if (!entry?.conflict) return undefined
    const remote = entry.conflict
    this.clearTimer(entry)
    this.clearSavedTimer(entry)
    entry.canonical = remote.description
    entry.draft = remote.description
    entry.conflict = undefined
    entry.message = undefined
    entry.versionOverride = undefined
    entry.phase = 'saved'
    this.emit(entry)
    this.showSavedTemporarily(entry)
    return remote
  }

  hasUnsaved(taskId?: string) {
    const entries = taskId ? [this.entries.get(taskId)] : Array.from(this.entries.values())
    return entries.some(entry => Boolean(entry && (entry.draft !== entry.canonical || entry.inFlight || entry.phase === 'error' || entry.phase === 'conflict')))
  }

  flushAll(): Promise<boolean> {
    const pending = Array.from(this.entries.values(), entry => this.flush(entry.taskId))
    return Promise.all(pending).then(results => results.every(Boolean))
  }

  dispose() {
    this.disposed = true
    for (const entry of Array.from(this.entries.values())) {
      this.clearTimer(entry)
      this.clearSavedTimer(entry)
    }
  }

  private createEntry(taskId: string, canonical: string) {
    const entry: Entry = {
      taskId,
      canonical,
      draft: canonical,
      phase: 'idle',
      composing: false,
      timer: null,
      savedTimer: null,
      inFlight: null,
    }
    this.entries.set(taskId, entry)
    return entry
  }

  private schedule(entry: Entry) {
    this.clearTimer(entry)
    if (entry.composing || entry.phase === 'conflict') return
    entry.timer = setTimeout(() => {
      entry.timer = null
      void this.flush(entry.taskId)
    }, this.autosaveDelayMs)
  }

  private showSavedTemporarily(entry: Entry) {
    if (this.disposed) return
    this.clearSavedTimer(entry)
    entry.savedTimer = setTimeout(() => {
      entry.savedTimer = null
      if (entry.phase !== 'saved') return
      entry.phase = entry.draft === entry.canonical ? 'idle' : 'dirty'
      this.emit(entry)
    }, this.savedVisibleMs)
  }

  private clearTimer(entry: Entry) {
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = null
  }

  private clearSavedTimer(entry: Entry) {
    if (entry.savedTimer) clearTimeout(entry.savedTimer)
    entry.savedTimer = null
  }

  private emit(entry: Entry) {
    if (!this.disposed) this.onStateChange?.(entry.taskId, publicState(entry))
  }
}
