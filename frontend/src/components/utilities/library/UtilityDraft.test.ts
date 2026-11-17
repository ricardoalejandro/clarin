import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Blob as NodeBlob } from 'node:buffer'
import { UtilityDraft, mergeUtilityConfig } from './UtilityDraft'
import { libraryRequest, readDocumentSlot, UtilityRequestError, type UtilityDocument } from './libraryApi'

vi.mock('./libraryApi', async original => ({ ...await original<typeof import('./libraryApi')>(), libraryRequest: vi.fn(), readDocumentSlot: vi.fn() }))
const request = vi.mocked(libraryRequest)
const base = (): UtilityDocument => ({ id: 'document-a', type: 'json', title: 'Documento', folder_id: null, favorite: false, version: 1, config: {}, slots: [], created_at: '2026-11-14', updated_at: '2026-11-14' })
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('Blob', NodeBlob) })
afterEach(() => vi.unstubAllGlobals())

describe('utility autosave session', () => {
  it('reports a per-document display mode without dirtying or persisting it', async () => {
    const notify = vi.fn(), draft = new UtilityDraft(base(), notify), neighbor = new UtilityDraft({ ...base(), id: 'b' }, vi.fn())
    const status = { lightPanels: ['a'], chunkedPanels: [] }
    draft.session.reportDisplayStatus?.(status)
    expect(draft.displayStatus).toEqual(status)
    expect(neighbor.displayStatus).toBeUndefined()
    expect(draft.dirty).toBe(false)
    expect(await draft.flush()).toBe(true)
    expect(request).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledTimes(1)
    draft.session.reportDisplayStatus?.(status)
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('backs up original bytes before persisting the editable import and retries safely after backup failure', async () => {
    const draft = new UtilityDraft(base(), vi.fn())
    const original = new Blob([new Uint8Array([0xe9, 0x80])], { type: 'application/octet-stream' })
    draft.session.setSlot('panel-a', 'é€')
    draft.session.setSlot('original-a', original)
    request.mockRejectedValueOnce(new UtilityRequestError('Backup unavailable', 503))
    expect(await draft.flush()).toBe(false)
    expect(request.mock.calls.map(([path]) => path)).toEqual(['/documents/document-a/content/original-a'])
    const operation = request.mock.calls[0][1]?.headers
    request.mockImplementation(async path => ({ document: { ...base(), version: 2 }, content: { slot: path.endsWith('original-a') ? 'original-a' : 'panel-a', version: 1, bytes: 4 } }) as never)
    expect(await draft.flush()).toBe(true)
    expect(request.mock.calls.map(([path]) => path)).toEqual(['/documents/document-a/content/original-a', '/documents/document-a/content/original-a', '/documents/document-a/content/panel-a'])
    expect(request.mock.calls[1][1]?.headers).toEqual(operation)
    expect(new Uint8Array(await (request.mock.calls[1][1]!.body as Blob).arrayBuffer())).toEqual(new Uint8Array([0xe9, 0x80]))
  })

  it.each([false, true])('backs up an import arriving during another panel upload before evaluating its text (backup failure: %s)', async backupFails => {
    const draft = new UtilityDraft(base(), vi.fn())
    let source = 'previous panel B'
    const staleProvider = vi.fn(() => source), importedProvider = vi.fn(() => source)
    draft.session.setSlot('panel-a', 'panel A')
    draft.session.setSlot('panel-b', staleProvider)
    let finishPanelA!: (result: unknown) => void
    request.mockImplementationOnce(() => new Promise(resolve => { finishPanelA = resolve }))
    request.mockImplementationOnce(async () => {
      expect(importedProvider).not.toHaveBeenCalled()
      if (backupFails) throw new UtilityRequestError('Backup unavailable', 503)
      return { document: { ...base(), version: 3 }, content: { slot: 'original-b', version: 1, bytes: 2 } } as never
    })
    request.mockResolvedValueOnce({ document: { ...base(), version: 4 }, content: { slot: 'panel-b', version: 1, bytes: 5 } })
    const saving = draft.flush()
    source = 'é€'
    draft.session.setSlot('original-b', new Blob([new Uint8Array([0xe9, 0x80])], { type: 'application/octet-stream' }))
    draft.session.setSlot('panel-b', importedProvider)
    finishPanelA({ document: { ...base(), version: 2 }, content: { slot: 'panel-a', version: 1, bytes: 7 } })
    expect(await saving).toBe(!backupFails)
    expect(staleProvider).not.toHaveBeenCalled()
    expect(request.mock.calls.map(([path]) => path)).toEqual([
      '/documents/document-a/content/panel-a', '/documents/document-a/content/original-b',
      ...backupFails ? [] : ['/documents/document-a/content/panel-b'],
    ])
    if (backupFails) {
      expect(importedProvider).not.toHaveBeenCalled()
      expect(draft.dirty).toBe(true)
      const failedBackup = request.mock.calls[1][1]!
      request.mockReset()
      request.mockImplementation(async path => ({ document: { ...base(), version: 4 }, content: { slot: path.endsWith('original-b') ? 'original-b' : 'panel-b', version: 1, bytes: 5 } }) as never)
      expect(await draft.flush()).toBe(true)
      expect(request.mock.calls.map(([path]) => path)).toEqual(['/documents/document-a/content/original-b', '/documents/document-a/content/panel-b'])
      expect(request.mock.calls[0][1]!.headers).toEqual(failedBackup.headers)
      expect(request.mock.calls[0][1]!.body).toBe(failedBackup.body)
    }
    expect(importedProvider).toHaveBeenCalledOnce()
    expect(await (request.mock.calls.at(-1)![1]!.body as Blob).text()).toBe('é€')
    expect(draft.dirty).toBe(false)
  })

  it('does not write empty/unmodified documents, merges configuration and saves once', async () => {
    const draft = new UtilityDraft(base(), vi.fn())
    expect(await draft.flush()).toBe(true)
    expect(request).not.toHaveBeenCalled()
    draft.session.setState({ indent: 2 }); draft.session.setState({ wrap: true })
    request.mockResolvedValue({ document: { ...base(), version: 2 } })
    const first = draft.flush()
    expect(draft.flush()).toBe(first)
    expect(await first).toBe(true)
    expect(JSON.parse(request.mock.calls[0][1]!.body as string)).toMatchObject({ base_version: 1, config: { indent: 2, wrap: true } })
    expect(draft.document.config).toEqual({ indent: 2, wrap: true })
    expect(draft.phase).toBe('saved')
  })

  it('evaluates a lazy editor snapshot only when saving and uploads content separately', async () => {
    const draft = new UtilityDraft(base(), vi.fn()), getter = vi.fn(() => '{"saved":true}')
    draft.session.setSlot('panel-a', getter)
    expect(getter).not.toHaveBeenCalled()
    request.mockResolvedValue({ document: { ...base(), version: 2, slots: [{ slot: 'panel-a', version: 1, bytes: 14 }] }, content: { slot: 'panel-a', version: 1, bytes: 14 } })
    expect(await draft.flush()).toBe(true)
    expect(getter).toHaveBeenCalledOnce()
    expect(request.mock.calls[0][0]).toBe('/documents/document-a/content/panel-a')
    expect(request.mock.calls[0][1]!.body).toBeInstanceOf(Blob)
    expect(draft.dirty).toBe(false)
  })

  it('journals small text edits against the slot version, preserving the current download', async () => {
    const document = { ...base(), slots: [{ slot: 'panel-a', version: 4, bytes: 1000 }] }
    const draft = new UtilityDraft(document, vi.fn())
    const text = 'x'.repeat(1000)
    vi.mocked(readDocumentSlot).mockResolvedValue({ blob: new Blob([text], { type: 'text/plain' }), version: 4 })
    await draft.session.readSlot('panel-a')
    draft.session.setSlot('panel-a', text.slice(0, 500) + 'ñ' + text.slice(501))
    request.mockResolvedValue({ document: { ...document, version: 2 }, content: { slot: 'panel-a', version: 5, bytes: 1001 } })
    expect(await draft.flush()).toBe(true)
    expect(request.mock.calls[0][0]).toBe('/documents/document-a/changes')
    expect(JSON.parse(request.mock.calls[0][1]!.body as string)).toMatchObject({ slot: 'panel-a', base_version: 4, edits: [{ offset: 500, delete_count: 1, text: 'ñ' }] })
    expect(await draft.session.getSlot('panel-a')!.text()).toContain('ñ')
  })

  it('owns the loading phase and a late download cannot replace a new local edit', async () => {
    const draft = new UtilityDraft({ ...base(), slots: [{ slot: 'panel-a', version: 1, bytes: 3 }] }, vi.fn())
    let finish!: (value: { blob: Blob; version: number }) => void
    vi.mocked(readDocumentSlot).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const reading = draft.session.readSlot('panel-a')
    expect(draft.loading).toBe(true)
    draft.session.setSlot('panel-a', 'new local edit')
    finish({ blob: new Blob(['old'], { type: 'text/plain' }), version: 1 })
    expect(await (await reading)!.text()).toBe('new local edit')
    expect(draft.loading).toBe(false)
    expect(draft.dirty).toBe(true)
  })

  it('keeps drafts on conflicts and retries ambiguous failures with the same operation identity', async () => {
    const draft = new UtilityDraft(base(), vi.fn())
    draft.session.setSlot('panel-a', 'my draft')
    request.mockRejectedValueOnce(new UtilityRequestError('Sin conexión', 503))
    expect(await draft.flush()).toBe(false)
    const operation = (request.mock.calls[0][1]!.headers as Record<string, string>)['X-Operation-Id']
    request.mockRejectedValueOnce(new UtilityRequestError('Versión incompatible', 409))
    expect(await draft.flush()).toBe(false)
    expect((request.mock.calls[1][1]!.headers as Record<string, string>)['X-Operation-Id']).toBe(operation)
    expect(draft.phase).toBe('conflict')
    expect(await draft.session.getSlot('panel-a')!.text()).toBe('my draft')
    draft.session.setSlot('panel-a', 'continued typing')
    draft.session.setState({ wrap: true })
    expect(draft.phase).toBe('conflict')
    expect(await draft.flush()).toBe(false)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('uses the downloaded content version instead of stale list metadata', async () => {
    const draft = new UtilityDraft({ ...base(), slots: [{ slot: 'panel-a', version: 1, bytes: 1000 }] }, vi.fn())
    vi.mocked(readDocumentSlot).mockResolvedValue({ blob: new Blob(['x'.repeat(1000)], { type: 'text/plain' }), version: 7 })
    await draft.session.readSlot('panel-a')
    draft.session.setSlot('panel-a', 'y' + 'x'.repeat(999))
    request.mockResolvedValue({ document: { ...base(), version: 8 }, content: { slot: 'panel-a', version: 8, bytes: 1000 } })
    expect(await draft.flush()).toBe(true)
    expect(JSON.parse(request.mock.calls[0][1]!.body as string).base_version).toBe(7)
  })

  it('ignores an old download arriving after our own newer successful save', async () => {
    const document = { ...base(), slots: [{ slot: 'panel-a', version: 1, bytes: 3 }] }
    const draft = new UtilityDraft(document, vi.fn())
    let finish!: (value: { blob: Blob; version: number }) => void
    vi.mocked(readDocumentSlot).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const reading = draft.session.readSlot('panel-a')
    draft.session.setSlot('panel-a', 'local saved text')
    request.mockResolvedValue({ document: { ...document, version: 2 }, content: { slot: 'panel-a', version: 2, bytes: 16 } })
    expect(await draft.flush()).toBe(true)
    finish({ blob: new Blob(['old'], { type: 'text/plain' }), version: 1 })
    expect(await (await reading)!.text()).toBe('local saved text')
    expect(draft.phase).toBe('saved')
    expect(await draft.flush()).toBe(true)
    expect(request).toHaveBeenCalledOnce()
  })

  it('does not mistake a GET of our committed content for another editor before the PUT acknowledgement', async () => {
    const document = { ...base(), slots: [{ slot: 'panel-a', version: 1, bytes: 3 }] }
    const draft = new UtilityDraft(document, vi.fn())
    let finishRead!: (value: { blob: Blob; version: number }) => void
    let finishSave!: (value: unknown) => void
    vi.mocked(readDocumentSlot).mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve }))
    const reading = draft.session.readSlot('panel-a')
    draft.session.setSlot('panel-a', 'new')
    request.mockImplementationOnce(() => new Promise(resolve => { finishSave = resolve }))
    const saving = draft.flush()
    finishRead({ blob: new Blob(['new'], { type: 'text/plain' }), version: 2 })
    finishSave({ document: { ...document, version: 2 }, content: { slot: 'panel-a', version: 2, bytes: 3 } })
    expect(await saving).toBe(true)
    expect(await (await reading)!.text()).toBe('new')
    expect(draft.phase).toBe('saved')
  })

  it('preserves an externally marked conflict if an in-flight save later fails by network', async () => {
    const draft = new UtilityDraft(base(), vi.fn())
    draft.session.setSlot('panel-a', 'local')
    let reject!: (reason: unknown) => void
    request.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail }))
    const saving = draft.flush()
    draft.markExternalConflict('Canonical conflict')
    reject(new UtilityRequestError('Offline', 503))
    expect(await saving).toBe(false)
    expect(draft.phase).toBe('conflict')
    expect(draft.error).toBe('Canonical conflict')
    expect(await draft.flush()).toBe(false)
  })

  it('serializes metadata with autosave, keeping edits made while metadata is pending', async () => {
    const draft = new UtilityDraft(base(), vi.fn())
    draft.session.setState({ wrap: true })
    request.mockResolvedValueOnce({ document: { ...base(), version: 2 } })
    let finish!: () => void
    let started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    const metadata = draft.mutate(async document => {
      expect(document.version).toBe(2)
      started()
      await new Promise<void>(resolve => { finish = resolve })
      draft.acceptMetadata({ ...document, title: 'Renamed', version: 3 })
    })
    await entered
    draft.session.setState({ wrap: false })
    request.mockResolvedValueOnce({ document: { ...base(), title: 'Renamed', version: 4 } })
    const saving = draft.flush()
    expect(request).toHaveBeenCalledTimes(1)
    finish()
    await metadata
    expect(await saving).toBe(true)
    expect(JSON.parse(request.mock.calls[1][1]!.body as string)).toMatchObject({ base_version: 3, config: { wrap: false } })
    expect(draft.document.title).toBe('Renamed')
  })

  it('blocks writes after successful deletion and resumes them after a definitively rejected deletion', async () => {
    const draft = new UtilityDraft(base(), vi.fn())
    await expect(draft.mutate(async () => { throw new UtilityRequestError('Forbidden', 403) }, { deleting: true })).rejects.toThrow('Forbidden')
    draft.session.setSlot('panel-a', 'retained')
    request.mockResolvedValue({ document: { ...base(), version: 2 }, content: { slot: 'panel-a', version: 1, bytes: 8 } })
    expect(await draft.flush()).toBe(true)
    await draft.mutate(async () => undefined, { deleting: true })
    draft.session.setSlot('panel-a', 'after deletion')
    expect(await draft.flush()).toBe(false)
    expect(request).toHaveBeenCalledOnce()
  })

  it('replays an uncertain metadata mutation before saving newly edited configuration', async () => {
    const draft = new UtilityDraft(base(), vi.fn())
    const versions: number[] = []
    const rename = vi.fn(async (document: UtilityDocument) => {
      versions.push(document.version)
      if (versions.length === 1) throw new UtilityRequestError('Lost acknowledgement', 503)
      draft.acceptMetadata({ ...document, title: 'Renamed', version: 2 })
    })
    await expect(draft.mutate(rename)).rejects.toThrow('Lost acknowledgement')
    draft.session.setState({ wrap: true })
    request.mockResolvedValueOnce({ document: { ...base(), title: 'Renamed', version: 3 } })
    expect(await draft.flush()).toBe(true)
    expect(rename).toHaveBeenCalledTimes(2)
    expect(JSON.parse(request.mock.calls[0][1]!.body as string).base_version).toBe(2)
    expect(draft.document.title).toBe('Renamed')
  })

  it('keeps uncertain metadata as a barrier while its replay still fails', async () => {
    const draft = new UtilityDraft(base(), vi.fn())
    const rename = vi.fn(async () => { throw new UtilityRequestError('Offline', 503) })
    await expect(draft.mutate(rename)).rejects.toThrow('Offline')
    draft.session.setSlot('panel-a', 'local text')
    expect(await draft.flush()).toBe(false)
    expect(request).not.toHaveBeenCalled()
    expect(await draft.session.getSlot('panel-a')!.text()).toBe('local text')
  })

  it('never retries an uncertain deletion from autosave, and requires another explicit confirmation', async () => {
    const draft = new UtilityDraft(base(), vi.fn())
    const outcome = { cleanup_pending: true, workspace: null }
    const deletion = vi.fn().mockRejectedValueOnce(new UtilityRequestError('Lost acknowledgement', 503)).mockResolvedValueOnce(outcome)
    await expect(draft.mutate(deletion, { deleting: true })).rejects.toThrow('Lost acknowledgement')
    draft.session.setSlot('panel-a', 'continued editing after closing the dialog')
    expect(draft.phase).toBe('error')
    expect(draft.error).toContain('confirmar la eliminación')
    expect(await draft.flush()).toBe(false)
    expect(deletion).toHaveBeenCalledOnce()
    expect(request).not.toHaveBeenCalled()
    const replacement = vi.fn()
    expect(await draft.mutate(replacement, { deleting: true })).toEqual(outcome)
    expect(deletion).toHaveBeenCalledTimes(2)
    expect(replacement).not.toHaveBeenCalled()
    expect(await draft.flush()).toBe(false)
  })

  it('retains conflict feedback after unrelated reads fail or vault reconciliation completes', async () => {
    const document = { ...base(), type: 'criptografia' as const, slots: [{ slot: 'input', version: 1, bytes: 1 }] }
    const draft = new UtilityDraft(document, vi.fn())
    draft.markExternalConflict('Keep this conflict')
    vi.mocked(readDocumentSlot).mockRejectedValueOnce(new UtilityRequestError('Offline', 503))
    await expect(draft.session.readSlot('input')).rejects.toThrow('Offline')
    expect(draft.phase).toBe('conflict')
    request.mockResolvedValueOnce({ document: { ...document, version: 2 } })
    await draft.session.reconcileVaultDeletion?.('removed-key')
    expect(draft.phase).toBe('conflict')
    expect(draft.error).toBe('Keep this conflict')
    expect(await draft.flush()).toBe(false)
  })

  it.each([400, 401, 403, 404, 413, 422])('saves corrected key preferences after a definitive HTTP %s rejection', async status => {
    const document = { ...base(), type: 'criptografia' as const }
    const draft = new UtilityDraft(document, vi.fn())
    draft.session.setState({ key_id: 'selected-key', active: 'hash' })
    request.mockRejectedValueOnce(new UtilityRequestError('Selección rechazada', status))
    expect(await draft.flush()).toBe(false)
    expect(draft.dirty).toBe(true)
    expect(draft.document.config).toMatchObject({ key_id: 'selected-key', active: 'hash' })
    const rejected = JSON.parse(request.mock.calls[0][1]!.body as string)
    // The metadata/WS reconciliation has confirmed that the selected key was deleted.
    draft.session.setState({ key_id: '', hash_algorithm: 'SHA-512' })
    request.mockResolvedValueOnce({ document: { ...document, version: 2 } })
    expect(await draft.flush()).toBe(true)
    const corrected = JSON.parse(request.mock.calls[1][1]!.body as string)
    expect(corrected.operation_id).not.toBe(rejected.operation_id)
    expect(corrected).toMatchObject({ base_version: 1, config: { key_id: '', active: 'hash', hash_algorithm: 'SHA-512' } })
    expect(draft.phase).toBe('saved')
    expect(draft.dirty).toBe(false)
  })

  it.each([undefined, 408, 429, 503])('retains the original config operation and payload after ambiguous status %s, then saves newer preferences', async status => {
    const draft = new UtilityDraft(base(), vi.fn())
    draft.session.setState({ key_id: 'selected-key' })
    request.mockRejectedValueOnce(status === undefined ? new TypeError('Conexión interrumpida') : new UtilityRequestError('Reintenta', status))
    expect(await draft.flush()).toBe(false)
    const original = request.mock.calls[0][1]!.body
    draft.session.setState({ key_id: '', active: 'hash' })
    request.mockResolvedValueOnce({ document: { ...base(), version: 2 } })
    request.mockResolvedValueOnce({ document: { ...base(), version: 3 } })
    expect(await draft.flush()).toBe(true)
    expect(request.mock.calls[1][1]!.body).toBe(original)
    const newer = JSON.parse(request.mock.calls[2][1]!.body as string)
    expect(newer).toMatchObject({ base_version: 2, config: { key_id: '', active: 'hash' } })
    expect(newer.operation_id).not.toBe(JSON.parse(original as string).operation_id)
    expect(draft.dirty).toBe(false)
  })

  it('uses corrected content after a definitive quota rejection without losing the editable draft', async () => {
    const draft = new UtilityDraft(base(), vi.fn())
    draft.session.setSlot('panel-a', 'rejected content')
    request.mockRejectedValueOnce(new UtilityRequestError('Sin espacio', 413))
    expect(await draft.flush()).toBe(false)
    const oldOperation = (request.mock.calls[0][1]!.headers as Record<string, string>)['X-Operation-Id']
    draft.session.setSlot('panel-a', 'smaller')
    request.mockResolvedValueOnce({ document: { ...base(), version: 2 }, content: { slot: 'panel-a', version: 1, bytes: 7 } })
    expect(await draft.flush()).toBe(true)
    expect((request.mock.calls[1][1]!.headers as Record<string, string>)['X-Operation-Id']).not.toBe(oldOperation)
    expect(await (request.mock.calls[1][1]!.body as Blob).text()).toBe('smaller')
    expect(await draft.session.getSlot('panel-a')!.text()).toBe('smaller')
    expect(draft.dirty).toBe(false)
  })

  it('replays an ambiguous content upload before saving its newer replacement', async () => {
    const draft = new UtilityDraft(base(), vi.fn())
    draft.session.setSlot('panel-a', 'first')
    request.mockRejectedValueOnce(new UtilityRequestError('Respuesta perdida', 503))
    expect(await draft.flush()).toBe(false)
    const original = request.mock.calls[0][1]!
    draft.session.setSlot('panel-a', 'second')
    request.mockResolvedValueOnce({ document: { ...base(), version: 2 }, content: { slot: 'panel-a', version: 1, bytes: 5 } })
    request.mockResolvedValueOnce({ document: { ...base(), version: 3 }, content: { slot: 'panel-a', version: 2, bytes: 6 } })
    expect(await draft.flush()).toBe(true)
    expect(request.mock.calls[1][1]!.headers).toEqual(original.headers)
    expect(request.mock.calls[1][1]!.body).toBe(original.body)
    expect((request.mock.calls[2][1]!.headers as Record<string, string>)['If-Match']).toBe('1')
    expect(await (request.mock.calls[2][1]!.body as Blob).text()).toBe('second')
    expect(draft.dirty).toBe(false)
  })

  it('does not lose newer edits that arrive during a save', async () => {
    const draft = new UtilityDraft(base(), vi.fn())
    draft.session.setSlot('panel-a', 'first')
    let finish!: (result: unknown) => void
    request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    request.mockResolvedValueOnce({ document: { ...base(), version: 3 }, content: { slot: 'panel-a', version: 2, bytes: 6 } })
    const save = draft.flush()
    draft.session.setSlot('panel-a', 'second')
    finish({ document: { ...base(), version: 2 }, content: { slot: 'panel-a', version: 1, bytes: 5 } })
    expect(await save).toBe(true)
    expect(request).toHaveBeenCalledTimes(2)
    expect((request.mock.calls[1][1]!.headers as Record<string, string>)['If-Match']).toBe('1')
    expect(await draft.session.getSlot('panel-a')!.text()).toBe('second')
  })

  it('aborts owned requests and rejects late completions after account/session disposal', async () => {
    const notify = vi.fn(), draft = new UtilityDraft(base(), notify)
    draft.session.setState({ wrap: true })
    let finish!: (result: unknown) => void
    request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const save = draft.flush(), signal = request.mock.calls[0][1]!.signal!
    draft.dispose(); const notices = notify.mock.calls.length
    expect(signal.aborted).toBe(true)
    finish({ document: { ...base(), version: 2 } })
    expect(await save).toBe(false)
    expect(notify).toHaveBeenCalledTimes(notices)
    expect(draft.session.getSlot('panel-a')).toBeUndefined()
  })

  it('freezes dirty model-backed sources before their editor is disposed', async () => {
    const draft = new UtilityDraft(base(), vi.fn())
    let modelSource = 'first'
    draft.session.setSlot('panel-a', () => modelSource)
    modelSource = 'late edit during a pending document request'
    expect(draft.freezeSources()).toBe(true)
    modelSource = '' // Disposed editor models no longer own the draft.
    expect(await draft.session.getSlot('panel-a')!.text()).toBe('late edit during a pending document request')
    request.mockResolvedValue({ document: { ...base(), version: 2 }, content: { slot: 'panel-a', version: 1, bytes: 42 } })
    expect(await draft.flush()).toBe(true)
    expect(await (request.mock.calls[0][1]!.body as Blob).text()).toBe('late edit during a pending document request')
  })

  it('always clears and aborts disposal even if a resource cleanup callback throws', async () => {
    const notify = vi.fn(), draft = new UtilityDraft(base(), notify)
    draft.session.setSlot('panel-a', 'private content')
    draft.session.registerBeforeDeactivate?.(() => { draft.session.setSlot('late', 'must not survive'); throw new Error('worker failed') })
    let finish!: (result: unknown) => void
    request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const saving = draft.flush(), signal = request.mock.calls[0][1]!.signal!
    expect(() => draft.dispose()).not.toThrow()
    expect(signal.aborted).toBe(true)
    expect(draft.session.slotNames?.()).toEqual([])
    expect(draft.session.getSlot('late')).toBeUndefined()
    finish({ document: base(), content: { slot: 'panel-a', version: 1, bytes: 15 } })
    expect(await saving).toBe(false)
  })
})

describe('vault deletion canonical reconciliation', () => {
  const cryptoDocument = (): UtilityDocument => ({ ...base(), type: 'criptografia', config: { key_id: 'old-key', active: 'cipher', hash_algorithm: 'SHA-256' } })
  const removed = () => ({ ...cryptoDocument(), version: 2, config: { ...cryptoDocument().config, key_id: '' } })
  beforeEach(() => { request.mockReset() })

  it('adopts server version++ without creating another save, and deduplicates HTTP and websocket echoes', async () => {
    const draft = new UtilityDraft(cryptoDocument(), vi.fn()), observe = vi.fn()
    draft.session.subscribeState?.(observe)
    request.mockResolvedValue({ document: removed() })
    const first = draft.reconcileVaultDeletion('old-key')
    expect(draft.reconcileVaultDeletion('old-key')).toBe(first)
    expect(await first).toBe(true)
    expect(await draft.flush()).toBe(true)
    expect(await draft.reconcileVaultDeletion('old-key')).toBe(true)
    expect(request).toHaveBeenCalledTimes(1)
    expect(draft.document.version).toBe(2)
    expect(draft.document.config.key_id).toBe('')
    expect(draft.dirty).toBe(false)
    expect(observe).toHaveBeenCalledWith(removed().config)
  })

  it('merges disjoint dirty preferences against the canonical baseline and writes only with the new version', async () => {
    const draft = new UtilityDraft(cryptoDocument(), vi.fn())
    draft.session.setState({ active: 'hash' })
    request.mockResolvedValueOnce({ document: { ...removed(), config: { ...removed().config, hash_algorithm: 'SHA-512' } } })
    expect(await draft.reconcileVaultDeletion('old-key')).toBe(true)
    expect(draft.document.config).toMatchObject({ key_id: '', active: 'hash', hash_algorithm: 'SHA-512' })
    request.mockImplementation(async (_path, options) => ({ document: { ...removed(), version: 3, config: JSON.parse(options!.body as string).config } }) as never)
    expect(await draft.flush()).toBe(true)
    expect(JSON.parse(request.mock.calls[1][1]!.body as string)).toMatchObject({ base_version: 2, config: draft.document.config })
  })

  it('waits for an in-flight 409, blocks new saves, preserves a later selection and retries on the canonical version', async () => {
    const draft = new UtilityDraft(cryptoDocument(), vi.fn())
    draft.session.setState({ active: 'hash' })
    let rejectSave!: (reason: unknown) => void
    request.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSave = reject }))
    const saving = draft.flush()
    request.mockResolvedValueOnce({ document: removed() })
    request.mockImplementationOnce(async (_path, options) => ({ document: { ...removed(), version: 3, config: JSON.parse(options!.body as string).config } }) as never)
    const reconciliation = draft.reconcileVaultDeletion('old-key'), blockedFlush = draft.flush()
    draft.session.setState({ key_id: 'later-key' })
    expect(request).toHaveBeenCalledTimes(1)
    rejectSave(new UtilityRequestError('La eliminación avanzó la versión', 409))
    expect(await saving).toBe(false)
    expect(await reconciliation).toBe(true)
    expect(await blockedFlush).toBe(true)
    expect(request.mock.calls.map(([, options]) => options?.method || 'GET')).toEqual(['PATCH', 'GET', 'PATCH'])
    expect(JSON.parse(request.mock.calls[2][1]!.body as string)).toMatchObject({ base_version: 2, config: { key_id: 'later-key', active: 'hash' } })
    expect(draft.document.version).toBe(3)
    expect(draft.phase).toBe('saved')
  })

  it('retains a retry barrier after a canonical fetch 503 and never resends the old base version', async () => {
    const draft = new UtilityDraft(cryptoDocument(), vi.fn())
    draft.session.setState({ active: 'hash' })
    request.mockRejectedValueOnce(new UtilityRequestError('Temporal', 503))
    expect(await draft.reconcileVaultDeletion('old-key')).toBe(false)
    expect(draft.phase).toBe('error')
    expect(draft.reconcilingVault).toBe(true)
    request.mockResolvedValueOnce({ document: removed() })
    request.mockImplementationOnce(async (_path, options) => ({ document: { ...removed(), version: 3, config: JSON.parse(options!.body as string).config } }) as never)
    expect(await draft.flush()).toBe(true)
    expect(request.mock.calls.map(([, options]) => options?.method || 'GET')).toEqual(['GET', 'GET', 'PATCH'])
    expect(JSON.parse(request.mock.calls[2][1]!.body as string).base_version).toBe(2)
  })

  it('keeps true same-field conflicts visible and never overwrites the remote preference on an echo', async () => {
    const draft = new UtilityDraft(cryptoDocument(), vi.fn())
    draft.session.setState({ active: 'hash' })
    request.mockResolvedValue({ document: { ...removed(), config: { ...removed().config, active: 'base64' } } })
    expect(await draft.reconcileVaultDeletion('old-key')).toBe(false)
    expect(draft.document.config.active).toBe('hash')
    expect(draft.document.version).toBe(2)
    expect(draft.phase).toBe('conflict')
    expect(await draft.reconcileVaultDeletion('old-key')).toBe(false)
    draft.session.setState({ hash_algorithm: 'SHA-384' })
    expect(await draft.flush()).toBe(false)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('uses edits arriving during the canonical fetch, and refuses a snapshot older than its current token', async () => {
    const draft = new UtilityDraft(cryptoDocument(), vi.fn())
    let finish!: (result: unknown) => void
    request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const reconciliation = draft.reconcileVaultDeletion('old-key')
    await Promise.resolve()
    draft.session.setState({ key_id: 'later-key' })
    finish({ document: removed() })
    expect(await reconciliation).toBe(true)
    expect(draft.document.config.key_id).toBe('later-key')
    const newer = new UtilityDraft({ ...cryptoDocument(), version: 8 }, vi.fn())
    request.mockResolvedValueOnce({ document: removed() })
    expect(await newer.reconcileVaultDeletion('old-key')).toBe(false)
    expect(newer.document.version).toBe(8)
    expect(newer.reconcilingVault).toBe(true)
  })

  it('three-way comparison distinguishes a remote-only option from an actual concurrent conflict', () => {
    expect(mergeUtilityConfig({ active: 'cipher', key_id: 'old' }, { active: 'hash', key_id: 'later' }, { active: 'cipher', key_id: '', hash_algorithm: 'SHA-512' }, new Set(['old']))).toEqual({ config: { active: 'hash', key_id: 'later', hash_algorithm: 'SHA-512' }, conflicts: [] })
    expect(mergeUtilityConfig({ active: 'cipher' }, { active: 'hash' }, { active: 'base64' }, new Set()).conflicts).toEqual(['active'])
  })
})
