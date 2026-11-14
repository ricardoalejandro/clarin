import type { UtilityDocumentSession, UtilitySlotSource, UtilitySlotValue } from './UtilityDocumentContext'
import { jsonRequest, libraryRequest, minimalTextEdit, operationId, readDocumentSlot, type UtilityDocument, type UtilityContent, UtilityRequestError } from './libraryApi'

export type SavePhase = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict'
type SlotDraft = { source: UtilitySlotSource; baseline?: string; revision: number; saved: number; blob?: Blob; version: number }
type SaveResult = { document: UtilityDocument; content: UtilityContent }
type PendingConfig = { revision: number; baseVersion: number; operation: string; config: Record<string, unknown> }
type PendingSlot = { revision: number; baseVersion: number; operation: string; value: UtilitySlotValue; blob?: Blob; edit: ReturnType<typeof minimalTextEdit> | undefined }

/** Owns one document's draft. Nothing is written to browser persistence. */
export class UtilityDraft {
  document: UtilityDocument
  phase: SavePhase = 'saved'
  error = ''
  private slots = new Map<string, SlotDraft>()
  private configRevision = 0
  private savedConfigRevision = 0
  private saving: Promise<boolean> | null = null
  private disposed = false
  private pendingConfig?: PendingConfig
  private pendingSlots = new Map<string, PendingSlot>()
  private readonly controller = new AbortController()
  private readers = new Map<string, Promise<Blob | null>>()
  private beforeDeactivate = new Set<() => void>()
  readonly session: UtilityDocumentSession

  constructor(document: UtilityDocument, private notify: () => void) {
    this.document = { ...document, config: { ...document.config } }
    this.session = {
      documentId: document.id, initialState: this.document.config,
      readSlot: name => this.read(name),
      setState: state => {
        if (this.disposed) return
        const next = { ...this.document.config, ...state }
        if (JSON.stringify(next) === JSON.stringify(this.document.config)) return
        this.document = { ...this.document, config: next }; this.session.initialState = next; this.configRevision++; this.changed()
      },
      setSlot: (name, source) => {
        if (this.disposed) return
        const previous = this.slots.get(name)
        if (previous?.source === source) return
        this.slots.set(name, { ...previous, source, blob: undefined, revision: (previous?.revision ?? 0) + 1, saved: previous?.saved ?? 0, version: previous?.version ?? this.document.slots.find(slot => slot.slot === name)?.version ?? 0 })
        this.changed()
      },
      getSlot: name => {
        const slot = this.slots.get(name)
        if (!slot) return undefined
        return this.blob(this.value(slot.source))
      },
      slotNames: () => [...new Set([...this.document.slots.map(slot => slot.slot), ...this.slots.keys()])],
      registerBeforeDeactivate: callback => { this.beforeDeactivate.add(callback); return () => { this.beforeDeactivate.delete(callback) } },
      flush: () => this.flush(),
    }
  }

  private value(source: UtilitySlotSource): UtilitySlotValue { return typeof source === 'function' ? source() : source }
  private blob(source: UtilitySlotValue) { return typeof source === 'string' ? new Blob([source], { type: 'text/plain;charset=utf-8' }) : source }
  private changed() { this.phase = 'dirty'; this.error = ''; this.notify() }
  get dirty() { return this.configRevision !== this.savedConfigRevision || [...this.slots.values()].some(slot => slot.saved !== slot.revision) }
  get loading() { return this.readers.size > 0 }

  private async read(name: string): Promise<Blob | null> {
    const current = this.slots.get(name)
    if (current) return this.blob(this.value(current.source))
    if (!this.document.slots.some(slot => slot.slot === name)) return null
    const existing = this.readers.get(name)
    if (existing) return existing
    const read = readDocumentSlot(this.document.id, name, this.controller.signal).then(async blob => {
      if (this.disposed) return null
      const baseline = blob.type.startsWith('text/') ? await blob.text() : undefined
      // An edit made while downloading must win over the old server snapshot.
      if (this.disposed) return null
      if (!this.slots.has(name)) this.slots.set(name, { source: blob, blob, baseline, revision: 0, saved: 0, version: this.document.slots.find(slot => slot.slot === name)!.version })
      return this.slots.has(name) ? this.blob(this.value(this.slots.get(name)!.source)) : blob
    }).catch(error => { if (!this.disposed) { this.phase = 'error'; this.error = error instanceof Error ? error.message : 'No se pudo abrir el archivo.'; this.notify() } throw error }).finally(() => { this.readers.delete(name); if (!this.disposed) this.notify() })
    this.readers.set(name, read)
    this.notify()
    return read
  }

  flush(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false)
    if (this.saving) return this.saving
    if (!this.dirty) return Promise.resolve(true)
    this.saving = this.save().finally(() => { this.saving = null })
    return this.saving
  }

  private async save() {
    this.phase = 'saving'; this.notify()
    try {
      while (this.dirty && !this.disposed) {
        if (this.configRevision !== this.savedConfigRevision) {
          const pending = this.pendingConfig ??= { revision: this.configRevision, config: { ...this.document.config }, baseVersion: this.document.version, operation: operationId() }
          const result = await libraryRequest<{ document: UtilityDocument }>(`/documents/${this.document.id}`, { ...jsonRequest('PATCH', { base_version: pending.baseVersion, operation_id: pending.operation, config: pending.config }), signal: this.controller.signal })
          if (this.disposed) return false
          this.accept(result.document); this.savedConfigRevision = pending.revision; this.pendingConfig = undefined
        }
        for (const [name, slot] of this.slots) {
          if (slot.saved === slot.revision || this.disposed) continue
          let pending = this.pendingSlots.get(name)
          if (!pending) {
            const value = this.value(slot.source)
            pending = { revision: slot.revision, baseVersion: slot.version, operation: operationId(), value, blob: typeof value === 'string' ? undefined : value, edit: typeof value === 'string' && slot.baseline !== undefined ? minimalTextEdit(slot.baseline, value) : undefined }
            this.pendingSlots.set(name, pending)
          }
          const { revision, value, edit } = pending
          let result: SaveResult
          if (edit === null) { slot.saved = revision; this.pendingSlots.delete(name); continue }
          const patch = edit && edit.text.length < 1_000_000 && typeof value === 'string' && edit.text.length < value.length / 2
            ? jsonRequest('PATCH', { slot: name, base_version: pending.baseVersion, operation_id: pending.operation, edits: [edit] }) : null
          if (patch && new Blob([patch.body as string]).size <= 1024 * 1024) {
            result = await libraryRequest<SaveResult>(`/documents/${this.document.id}/changes`, { ...patch, signal: this.controller.signal })
          } else {
            const blob = pending.blob ??= this.blob(value)
            result = await libraryRequest<SaveResult>(`/documents/${this.document.id}/content/${encodeURIComponent(name)}`, { method: 'PUT', body: blob, headers: { 'Content-Type': blob.type || 'application/octet-stream', 'If-Match': String(pending.baseVersion), 'X-Operation-Id': pending.operation }, signal: this.controller.signal })
          }
          if (this.disposed) return false
          this.accept(result.document)
          const latest = this.slots.get(name)!
          latest.version = result.content.version; latest.saved = revision; latest.baseline = typeof value === 'string' ? value : undefined
          latest.blob = latest.revision === revision ? pending.blob : undefined
          this.pendingSlots.delete(name)
          // Release callbacks closing over an editor before it is unmounted.
          if (latest.revision === revision) latest.source = value
        }
      }
      if (this.disposed) return false
      this.phase = 'saved'; this.error = ''; this.notify(); return true
    } catch (error) {
      if (this.disposed) return false
      this.phase = error instanceof UtilityRequestError && error.status === 409 ? 'conflict' : 'error'
      this.error = error instanceof Error ? error.message : 'No se pudo guardar. Tu trabajo sigue abierto.'
      this.notify(); return false
    }
  }

  private accept(document: UtilityDocument) { this.document = { ...document, config: this.document.config }; this.notify() }
  freezeSources() {
    if (this.disposed) return false
    try {
      for (const slot of this.slots.values()) if (typeof slot.source === 'function') slot.source = slot.source()
      return true
    } catch {
      this.phase = 'error'; this.error = 'No se pudo conservar el borrador antes de cambiar de documento. Descárgalo o reintenta.'; this.notify(); return false
    }
  }
  prepareDeactivate() {
    try {
      for (const callback of this.beforeDeactivate) callback()
      return this.freezeSources()
    } catch {
      this.phase = 'error'; this.error = 'No se pudo detener la operación. El documento sigue abierto para reintentar.'; this.notify(); return false
    }
  }
  markExternalConflict(message: string) { if (!this.disposed) { this.phase = 'conflict'; this.error = message; this.notify() } }
  reconcileIndexing(document: UtilityDocument) {
    if (this.disposed) return
    this.document = { ...this.document, slots: this.document.slots.map(slot => {
      const current = document.slots.find(candidate => candidate.slot === slot.slot && candidate.version === slot.version)
      return current ? { ...slot, indexing: current.indexing } : slot
    }) }
    this.notify()
  }
  dispose() {
    if (this.disposed) return
    this.disposed = true
    try {
      for (const callback of this.beforeDeactivate) { try { callback() } catch { /* Resource teardown must continue even when one worker fails. */ } }
    } finally {
      this.beforeDeactivate.clear(); this.controller.abort(); this.slots.clear(); this.readers.clear(); this.pendingSlots.clear(); this.pendingConfig = undefined
    }
  }
}
