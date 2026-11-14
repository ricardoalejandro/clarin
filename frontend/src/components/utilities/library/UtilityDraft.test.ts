import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Blob as NodeBlob } from 'node:buffer'
import { UtilityDraft } from './UtilityDraft'
import { libraryRequest, readDocumentSlot, UtilityRequestError, type UtilityDocument } from './libraryApi'

vi.mock('./libraryApi', async original => ({ ...await original<typeof import('./libraryApi')>(), libraryRequest: vi.fn(), readDocumentSlot: vi.fn() }))
const request = vi.mocked(libraryRequest)
const base = (): UtilityDocument => ({ id: 'document-a', type: 'json', title: 'Documento', folder_id: null, favorite: false, version: 1, config: {}, slots: [], created_at: '2026-11-14', updated_at: '2026-11-14' })
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('Blob', NodeBlob) })
afterEach(() => vi.unstubAllGlobals())

describe('utility autosave session', () => {
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
    vi.mocked(readDocumentSlot).mockResolvedValue(new Blob([text], { type: 'text/plain' }))
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
    let finish!: (blob: Blob) => void
    vi.mocked(readDocumentSlot).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const reading = draft.session.readSlot('panel-a')
    expect(draft.loading).toBe(true)
    draft.session.setSlot('panel-a', 'new local edit')
    finish(new Blob(['old'], { type: 'text/plain' }))
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
