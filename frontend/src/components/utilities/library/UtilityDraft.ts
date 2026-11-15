import type { UtilityDisplayStatus, UtilityDocumentSession, UtilitySlotSource, UtilitySlotValue } from './UtilityDocumentContext'
import { jsonRequest, libraryRequest, minimalTextEdit, operationId, readDocumentSlot, type UtilityDocument, type UtilityContent, UtilityRequestError } from './libraryApi'

export type SavePhase = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict'
type SlotDraft = { source: UtilitySlotSource; baseline?: string; revision: number; saved: number; blob?: Blob; version: number }
type SaveResult = { document: UtilityDocument; content: UtilityContent }
type PendingConfig = { revision: number; baseVersion: number; operation: string; config: Record<string, unknown> }
type PendingSlot = { revision: number; baseVersion: number; operation: string; value: UtilitySlotValue; blob?: Blob; edit: ReturnType<typeof minimalTextEdit> | undefined }

function definitivelyRejected(error: unknown) {
  // Timeouts/rate limits remain retryable with the same identity; conflicts keep
  // their explicit recovery flow. Other 4xx responses rejected the mutation.
  return error instanceof UtilityRequestError && error.status !== undefined
    && error.status >= 400 && error.status < 500 && ![408, 409, 429].includes(error.status)
}

export function mergeUtilityConfig(baseline: Record<string, unknown>, local: Record<string, unknown>, server: Record<string, unknown>, deletedKeys: ReadonlySet<string>) {
  const merged: Record<string, unknown> = {}, conflicts: string[] = []
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
  for (const key of new Set([...Object.keys(baseline), ...Object.keys(local), ...Object.keys(server)])) {
    const before = baseline[key], remote = server[key]
    const current = key === 'key_id' && deletedKeys.has(String(local[key])) ? '' : local[key]
    // Deleting the former selection cannot erase a different key selected later.
    const laterSelection = key === 'key_id' && deletedKeys.has(String(before)) && !remote && Boolean(current) && !deletedKeys.has(String(current))
    const value = same(current, before) ? remote : same(remote, before) || same(current, remote) || laterSelection ? current : (conflicts.push(key), current)
    if (value !== undefined) merged[key] = value
  }
  return { config: merged, conflicts }
}

function sameConfig(left: Record<string, unknown>, right: Record<string, unknown>) {
  return Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(key => Object.hasOwn(right, key) && JSON.stringify(left[key]) === JSON.stringify(right[key]))
}

/** Owns one document's draft. Nothing is written to browser persistence. */
export class UtilityDraft {
  document: UtilityDocument
  phase: SavePhase = 'saved'
  error = ''
  displayStatus?: UtilityDisplayStatus
  private slots = new Map<string, SlotDraft>()
  private configRevision = 0
  private savedConfigRevision = 0
  private saving: Promise<boolean> | null = null
  private disposed = false
  private pendingConfig?: PendingConfig
  private baselineConfig: Record<string, unknown>
  private configConflicts = new Set<string>()
  private vaultPending = new Set<string>()
  private vaultReconciled = new Set<string>()
  private reconciling: Promise<boolean> | null = null
  private stateListeners = new Set<(state: Record<string, unknown>) => void>()
  private pendingSlots = new Map<string, PendingSlot>()
  private readonly controller = new AbortController()
  private readers = new Map<string, Promise<Blob | null>>()
  private beforeDeactivate = new Set<() => void>()
  readonly session: UtilityDocumentSession

  constructor(document: UtilityDocument, private notify: () => void) {
    this.document = { ...document, config: { ...document.config } }
    this.baselineConfig = { ...document.config }
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
      reportDisplayStatus: status => {
        if (this.disposed || JSON.stringify(this.displayStatus) === JSON.stringify(status)) return
        this.displayStatus = status; this.notify()
      },
      reconcileVaultDeletion: keyId => this.reconcileVaultDeletion(keyId),
      subscribeState: listener => { this.stateListeners.add(listener); return () => { this.stateListeners.delete(listener) } },
      flush: () => this.flush(),
    }
  }

  private value(source: UtilitySlotSource): UtilitySlotValue { return typeof source === 'function' ? source() : source }
  private blob(source: UtilitySlotValue) { return typeof source === 'string' ? new Blob([source], { type: 'text/plain;charset=utf-8' }) : source }
  private changed() { this.phase = this.configConflicts.size ? 'conflict' : 'dirty'; if (!this.configConflicts.size) this.error = ''; this.notify() }
  get dirty() { return this.vaultPending.size > 0 || this.configRevision !== this.savedConfigRevision || [...this.slots.values()].some(slot => slot.saved !== slot.revision) }
  get reconcilingVault() { return this.vaultPending.size > 0 || this.reconciling !== null }
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
    if (this.reconciling || this.vaultPending.size) return this.reconcileVaultDeletion().then(success => success ? this.flush() : false)
    if (this.saving) return this.saving
    if (this.configConflicts.size) return Promise.resolve(false)
    if (!this.dirty) return Promise.resolve(true)
    this.saving = this.save().finally(() => { this.saving = null })
    return this.saving
  }

  private async save() {
    this.phase = 'saving'; this.notify()
    try {
      saveDraft: while (this.dirty && !this.disposed && !this.vaultPending.size) {
        if (this.configRevision !== this.savedConfigRevision) {
          const pending = this.pendingConfig ??= { revision: this.configRevision, config: { ...this.document.config }, baseVersion: this.document.version, operation: operationId() }
          const result = await libraryRequest<{ document: UtilityDocument }>(`/documents/${this.document.id}`, { ...jsonRequest('PATCH', { base_version: pending.baseVersion, operation_id: pending.operation, config: pending.config }), signal: this.controller.signal }).catch(error => {
            if (definitivelyRejected(error)) this.pendingConfig = undefined
            throw error
          })
          if (this.disposed) return false
          this.accept(result.document); this.baselineConfig = { ...pending.config }; this.savedConfigRevision = pending.revision; this.pendingConfig = undefined
        }
        // An import must never persist the editable interpretation before its opaque original.
        const slots = [...this.slots].sort(([a], [b]) => Number(/^original-[ab]$/.test(b)) - Number(/^original-[ab]$/.test(a)))
        for (const [name, slot] of slots) {
          // A previous upload may have yielded while an import replaced a lazy
          // editor source. Rebuild the order before reading that stale provider.
          if (this.slots.get(name) !== slot) continue saveDraft
          if (slot.saved === slot.revision || this.disposed) continue
          if (!/^original-[ab]$/.test(name) && [...this.slots].some(([candidate, draft]) => /^original-[ab]$/.test(candidate) && draft.saved !== draft.revision)) continue saveDraft
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
          try {
            if (patch && new Blob([patch.body as string]).size <= 1024 * 1024) {
              result = await libraryRequest<SaveResult>(`/documents/${this.document.id}/changes`, { ...patch, signal: this.controller.signal })
            } else {
              const blob = pending.blob ??= this.blob(value)
              result = await libraryRequest<SaveResult>(`/documents/${this.document.id}/content/${encodeURIComponent(name)}`, { method: 'PUT', body: blob, headers: { 'Content-Type': blob.type || 'application/octet-stream', 'If-Match': String(pending.baseVersion), 'X-Operation-Id': pending.operation }, signal: this.controller.signal })
            }
          } catch (error) {
            if (definitivelyRejected(error)) this.pendingSlots.delete(name)
            throw error
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
      if (this.vaultPending.size) return false
      this.phase = 'saved'; this.error = ''; this.notify(); return true
    } catch (error) {
      if (this.disposed) return false
      if (this.vaultPending.size) { this.phase = 'saving'; this.error = ''; this.notify(); return false }
      this.phase = error instanceof UtilityRequestError && error.status === 409 ? 'conflict' : 'error'
      this.error = error instanceof Error ? error.message : 'No se pudo guardar. Tu trabajo sigue abierto.'
      this.notify(); return false
    }
  }

  reconcileVaultDeletion(keyId?: string): Promise<boolean> {
    if (this.disposed || this.document.type !== 'criptografia') return Promise.resolve(false)
    if (keyId && !this.vaultReconciled.has(keyId)) this.vaultPending.add(keyId)
    if (this.reconciling) return this.reconciling
    if (!this.vaultPending.size) return Promise.resolve(!this.configConflicts.size)
    const saving = this.saving
    // Install the barrier synchronously, before awaiting any in-flight save or GET.
    this.reconciling = Promise.resolve().then(async () => {
      if (saving) await saving
      try {
        while (this.vaultPending.size && !this.disposed) {
          const deleted = new Set(this.vaultPending)
          const result = await libraryRequest<{ document: UtilityDocument }>(`/documents/${this.document.id}`, { signal: this.controller.signal })
          if (this.disposed) return false
          const canonical = result.document
          if (canonical.id !== this.document.id || canonical.type !== 'criptografia' || canonical.version < this.document.version) throw new Error('La versión del documento no está actualizada. Reintenta.')
          const merged = mergeUtilityConfig(this.baselineConfig, this.document.config, canonical.config, deleted)
          for (const key of this.configConflicts) if (JSON.stringify(merged.config[key]) !== JSON.stringify(canonical.config[key])) merged.conflicts.push(key)
          this.configConflicts = new Set(merged.conflicts)
          this.baselineConfig = { ...canonical.config }
          this.pendingConfig = undefined
          this.document = { ...canonical, config: merged.config }
          this.session.initialState = merged.config
          this.configRevision++
          if (sameConfig(merged.config, canonical.config)) this.savedConfigRevision = this.configRevision
          for (const id of deleted) { this.vaultPending.delete(id); this.vaultReconciled.add(id) }
          for (const listener of this.stateListeners) listener(merged.config)
          this.phase = this.configConflicts.size ? 'conflict' : this.dirty ? 'dirty' : 'saved'
          this.error = this.configConflicts.size ? 'Las preferencias cambiaron también en otra sesión. Tu borrador se conservó; recarga o guarda una copia para resolver el conflicto.' : ''
          this.notify()
        }
        return !this.disposed && !this.configConflicts.size
      } catch {
        if (!this.disposed) { this.phase = 'error'; this.error = 'La clave fue eliminada. Falta actualizar la versión del documento; reintenta para guardar tus preferencias.'; this.notify() }
        return false
      }
    }).finally(() => { this.reconciling = null })
    return this.reconciling
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
      this.beforeDeactivate.clear(); this.controller.abort(); this.slots.clear(); this.readers.clear(); this.pendingSlots.clear(); this.pendingConfig = undefined; this.stateListeners.clear(); this.vaultPending.clear(); this.vaultReconciled.clear()
    }
  }
}
