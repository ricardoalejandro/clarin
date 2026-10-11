import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StoragePreview, StorageThumbnail } from './StoragePreview'
import { apiBlob, api } from '@/lib/api'
import { PREVIEW_MAX_BYTES, PREVIEW_TIMEOUT_MS, STORAGE_READ_TIMEOUT_MS, type StorageFile } from './storageModel'

const identity = vi.hoisted(() => ({ scope: 'account-a' }))
vi.mock('@/lib/api', () => ({ apiBlob: vi.fn(), api: vi.fn() }))
vi.mock('@/components/chat/ChatDocumentViewer', () => ({ default: ({ document, onClose, suspended = false }: { document: { sessionId: string; src: string }; onClose: () => void; suspended?: boolean }) => <div role="dialog" aria-label="PDF canónico" hidden={suspended} inert={suspended}><input aria-label="Página actual" defaultValue="1" /><span data-testid="pdf-source">{document.src}</span><span data-testid="pdf-session">{document.sessionId}</span><button onClick={onClose}>Cerrar PDF</button></div> }))
vi.mock('@/lib/authScope', () => ({ getAuthScope: () => identity.scope }))
const file: StorageFile = { object_key: 'account-a/photo.png', filename: 'Foto.png', media_type: 'image', size_bytes: 4096, origins: [{ type: 'chats', label: 'Chat', href: '/dashboard/chats' }], references_count: 1, can_remove: true, status: 'active' }
const mockBlob = vi.mocked(apiBlob)
const mockGet = vi.mocked(api)
let createURL = vi.fn(() => 'blob:private-file')
let revokeURL = vi.fn()
beforeEach(() => { identity.scope = 'account-a'; mockBlob.mockReset(); mockGet.mockReset(); mockGet.mockResolvedValue({ success: true, status: 200 }); vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {}); vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {}); createURL = vi.fn(() => 'blob:private-file'); revokeURL = vi.fn(); URL.createObjectURL = createURL; URL.revokeObjectURL = revokeURL })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('authenticated storage preview sessions', () => {
  it('opens only an authenticated same-origin content endpoint and revokes its URL on close', async () => {
    mockBlob.mockResolvedValue({ success: true, blob: new Blob(['image'], { type: 'image/png' }) })
    const { unmount } = render(<StoragePreview file={{ ...file, preview_url: 'https://untrusted.test/content' }} scope={identity.scope} onClose={() => {}} />)
    await screen.findByRole('img', { name: 'Foto.png' })
    expect(mockBlob.mock.calls[0][0]).toBe('/api/storage/content?object_key=account-a%2Fphoto.png')
    const signal = mockBlob.mock.calls[0][1]?.signal
    expect(screen.getByRole('img').getAttribute('src')).toBe('blob:private-file')
    unmount(); expect(signal?.aborted).toBe(true); expect(revokeURL).toHaveBeenCalledWith('blob:private-file')
  })
  it('rejects late responses after a close even when transport ignores abort', async () => {
    let resolve: (value: unknown) => void = () => {}
    mockBlob.mockImplementation(() => new Promise(done => { resolve = done as typeof resolve }))
    const { unmount } = render(<StoragePreview file={file} scope={identity.scope} onClose={() => {}} />)
    unmount()
    await act(async () => resolve({ success: true, blob: new Blob(['image'], { type: 'image/png' }) }))
    expect(createURL).not.toHaveBeenCalled()
  })
  it('never renders a previous account response after identity changes', async () => {
    let resolve: (value: unknown) => void = () => {}
    mockBlob.mockImplementation(() => new Promise(done => { resolve = done as typeof resolve }))
    render(<StoragePreview file={file} scope={identity.scope} onClose={() => {}} />)
    identity.scope = 'account-b'
    await act(async () => resolve({ success: true, blob: new Blob(['image'], { type: 'image/png' }) }))
    expect(createURL).not.toHaveBeenCalled(); expect(screen.queryByRole('img')).toBeNull()
  })
  it('times out a hanging preview and can retry without an endless spinner', async () => {
    vi.useFakeTimers(); mockBlob.mockImplementation(() => new Promise(() => {}))
    render(<StoragePreview file={file} scope={identity.scope} onClose={() => {}} />)
    const signal = mockBlob.mock.calls[0][1]?.signal
    await act(async () => vi.advanceTimersByTime(PREVIEW_TIMEOUT_MS))
    expect(signal?.aborted).toBe(true)
    expect(screen.getByRole('alert').textContent).toContain('tardando demasiado')
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' })); expect(mockBlob).toHaveBeenCalledTimes(2)
  })
  it('streams even large videos after a bounded authorization check without creating a full-file blob', async () => {
    render(<StoragePreview file={{ ...file, filename: 'Video.mp4', media_type: 'video', size_bytes: PREVIEW_MAX_BYTES + 1 }} scope={identity.scope} onClose={() => {}} />)
    await waitFor(() => expect(document.querySelector('video')).toBeTruthy())
    expect(mockGet.mock.calls[0][1]?.method).toBe('HEAD')
    expect(document.querySelector('video')).toHaveAttribute('src', '/api/storage/content?object_key=account-a%2Fphoto.png')
    expect(document.querySelector('video')).toHaveAttribute('preload', 'metadata')
    expect(mockBlob).not.toHaveBeenCalled(); expect(createURL).not.toHaveBeenCalled()
  })
  it('revalidates a failed media stream before retrying, and tears the player down on close', async () => {
    const view = render(<StoragePreview file={{ ...file, filename: 'Video.mp4', media_type: 'video' }} scope={identity.scope} onClose={() => {}} />)
    await waitFor(() => expect(document.querySelector('video')).toBeTruthy())
    const player = document.querySelector('video')!
    const pause = vi.spyOn(player, 'pause')
    const load = vi.spyOn(player, 'load')
    Object.defineProperty(player, 'error', { value: { code: 4 } })
    fireEvent.error(player)
    expect(screen.getByRole('alert')).toHaveTextContent('no puede reproducir')
    let finish: (value: unknown) => void = () => {}
    mockGet.mockImplementationOnce(() => new Promise(resolve => { finish = resolve as typeof finish }))
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }))
    expect(document.querySelector('video')).toBeNull()
    expect(mockGet.mock.calls[1][1]?.method).toBe('HEAD')
    await act(async () => finish({ success: true, status: 200 }))
    expect(document.querySelector('video')).toHaveAttribute('src', '/api/storage/content?object_key=account-a%2Fphoto.png')
    expect(pause).toHaveBeenCalled(); expect(load).toHaveBeenCalled()
    expect(player).not.toHaveAttribute('src')
    view.unmount(); expect(mockBlob).not.toHaveBeenCalled()
  })
  it('does not embed active or mismatched content returned as an image', async () => {
    mockBlob.mockResolvedValue({ success: true, blob: new Blob(['<script>evil()</script>'], { type: 'text/html' }) })
    render(<StoragePreview file={file} scope={identity.scope} onClose={() => {}} />)
    await screen.findByText('Descarga el archivo para abrirlo')
    expect(screen.queryByRole('img')).toBeNull(); expect(document.querySelector('iframe')).toBeNull()
  })
  it('does not fetch full-size large files as thumbnails and disposes small ones', async () => {
    const big = render(<StorageThumbnail file={{ ...file, size_bytes: PREVIEW_MAX_BYTES }} scope={identity.scope} />)
    expect(mockBlob).not.toHaveBeenCalled(); big.unmount()
    mockBlob.mockResolvedValue({ success: true, blob: new Blob(['image'], { type: 'image/png' }) })
    const small = render(<StorageThumbnail file={file} scope={identity.scope} />)
    await waitFor(() => expect(createURL).toHaveBeenCalledOnce())
    small.unmount(); expect(revokeURL).toHaveBeenCalledWith('blob:private-file')
  })
  it('opens PDFs with the canonical renderer and restores the details action instead of relying on browser plugins', async () => {
    render(<StoragePreview file={{ ...file, filename: 'Informe.pdf', media_type: 'document' }} scope={identity.scope} onClose={() => {}} />)
    expect(document.querySelector('iframe')).toBeNull()
    expect(mockBlob).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Abrir vista previa' }))
    expect(screen.getByRole('dialog', { name: 'PDF canónico' })).toBeTruthy()
    expect(screen.getByTestId('pdf-source').textContent).toBe('/api/storage/content?object_key=account-a%2Fphoto.png')
    expect(screen.getByTestId('pdf-session').textContent).toBe('account-a:account-a/photo.png')
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar PDF' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Abrir vista previa' })).toHaveFocus())
    expect(screen.getByText('Dónde se usa')).toBeTruthy()
  })

  it('hides cached media while revalidating and destroys it when access is revoked', async () => {
    mockBlob.mockResolvedValue({ success: true, blob: new Blob(['image'], { type: 'image/png' }) })
    const onUnavailable = vi.fn()
    const view = render(<StoragePreview file={file} scope={identity.scope} refresh={0} onClose={vi.fn()} onUnavailable={onUnavailable} />)
    await screen.findByRole('img')
    let finish: (value: unknown) => void = () => {}
    mockGet.mockImplementationOnce(() => new Promise(resolve => { finish = resolve as typeof finish }))
    view.rerender(<StoragePreview file={file} scope={identity.scope} refresh={1} onClose={vi.fn()} onUnavailable={onUnavailable} />)
    expect(screen.queryByRole('img')).toBeNull()
    expect(revokeURL).not.toHaveBeenCalled()
    expect(mockGet.mock.calls[0][0]).toBe('/api/storage/content?object_key=account-a%2Fphoto.png')
    await act(async () => finish({ success: false, status: 404 }))
    expect(onUnavailable).toHaveBeenCalledOnce()
    expect(revokeURL).toHaveBeenCalledWith('blob:private-file')
    expect(mockBlob).toHaveBeenCalledTimes(1)
  })
  it('preserves the mounted PDF and selected page across successful canonical revalidation', async () => {
    const pdf = { ...file, filename: 'Informe.pdf', media_type: 'document' as const }
    const view = render(<StoragePreview file={pdf} scope={identity.scope} refresh={0} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Abrir vista previa' }))
    const pdfSession = screen.getByRole('dialog', { name: 'PDF canónico' })
    fireEvent.change(screen.getByRole('textbox', { name: 'Página actual' }), { target: { value: '4' } })
    let finish: (value: unknown) => void = () => {}
    mockGet.mockImplementationOnce(() => new Promise(resolve => { finish = resolve as typeof finish }))
    view.rerender(<StoragePreview file={pdf} scope={identity.scope} refresh={1} onClose={vi.fn()} />)
    expect(screen.queryByRole('dialog', { name: 'PDF canónico' })).toBeNull()
    await act(async () => finish({ success: true, data: { success: true, uses: [], has_more: false, limit: 40 } }))
    expect(screen.getByRole('dialog', { name: 'PDF canónico' })).toBe(pdfSession)
    expect(screen.getByRole('textbox', { name: 'Página actual' })).toHaveValue('4')
    expect(mockBlob).not.toHaveBeenCalled()
  })
  it('keeps failed revalidation explicit and retries without rendering the cached image', async () => {
    mockBlob.mockResolvedValue({ success: true, blob: new Blob(['image'], { type: 'image/png' }) })
    const view = render(<StoragePreview file={file} scope={identity.scope} refresh={0} onClose={vi.fn()} />)
    await screen.findByRole('img')
    mockGet.mockResolvedValueOnce({ success: false, status: 503, error: 'No se pudo revalidar' })
    view.rerender(<StoragePreview file={file} scope={identity.scope} refresh={1} onClose={vi.fn()} />)
    await screen.findByText('No se pudo revalidar')
    expect(screen.queryByRole('img')).toBeNull()
    mockGet.mockResolvedValueOnce({ success: true, data: { success: true, uses: [], limit: 40, has_more: false } })
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar verificación' }))
    expect(await screen.findByRole('img')).toBeTruthy()
  })
  it('aborts revalidation on close and ignores an old account completion', async () => {
    mockBlob.mockResolvedValue({ success: true, blob: new Blob(['image'], { type: 'image/png' }) })
    const onUnavailable = vi.fn()
    const view = render(<StoragePreview file={file} scope={identity.scope} refresh={0} onClose={vi.fn()} onUnavailable={onUnavailable} />)
    await screen.findByRole('img')
    let finish: (value: unknown) => void = () => {}
    mockGet.mockImplementationOnce(() => new Promise(resolve => { finish = resolve as typeof finish }))
    view.rerender(<StoragePreview file={file} scope={identity.scope} refresh={1} onClose={vi.fn()} onUnavailable={onUnavailable} />)
    const signal = mockGet.mock.calls[0][1]?.signal
    view.unmount(); identity.scope = 'account-b'
    await act(async () => finish({ success: false, status: 404 }))
    expect(signal?.aborted).toBe(true)
    expect(onUnavailable).not.toHaveBeenCalled()
    expect(createURL).toHaveBeenCalledOnce()
  })

  it.each(['video', 'audio'] as const)('pauses %s while checking and resumes the same player at its preserved position after 200', async media_type => {
    mockBlob.mockResolvedValue({ success: true, blob: new Blob(['media'], { type: `${media_type}/mp4` }) })
    const mediaFile = { ...file, filename: 'Grabación.mp4', media_type }
    const view = render(<StoragePreview file={mediaFile} scope={identity.scope} refresh={0} onClose={vi.fn()} />)
    await waitFor(() => expect(document.querySelector(media_type)).toBeTruthy())
    const player = document.querySelector(media_type) as HTMLMediaElement
    player.currentTime = 37.5
    let playing = true
    vi.spyOn(player, 'paused', 'get').mockImplementation(() => !playing)
    const pause = vi.spyOn(player, 'pause').mockImplementation(() => { playing = false })
    const play = vi.spyOn(player, 'play').mockImplementation(async () => { playing = true })
    let finish: (value: unknown) => void = () => {}
    mockGet.mockImplementationOnce(() => new Promise(resolve => { finish = resolve as typeof finish }))
    view.rerender(<StoragePreview file={mediaFile} scope={identity.scope} refresh={1} onClose={vi.fn()} />)
    expect(player).not.toBeVisible()
    expect(pause).toHaveBeenCalledOnce()
    expect(player.currentTime).toBe(37.5)
    expect(revokeURL).not.toHaveBeenCalled()
    await act(async () => finish({ success: true, data: { success: true, uses: [], has_more: false, limit: 40 } }))
    expect(document.querySelector(media_type)).toBe(player)
    expect(player).toBeVisible()
    expect(player.currentTime).toBe(37.5)
    expect(play).toHaveBeenCalledOnce()
    expect(mockBlob).not.toHaveBeenCalled()
  })
  it('keeps a paused player paused after revalidation', async () => {
    mockBlob.mockResolvedValue({ success: true, blob: new Blob(['media'], { type: 'audio/mp4' }) })
    const mediaFile = { ...file, filename: 'Grabación.mp4', media_type: 'audio' as const }
    const view = render(<StoragePreview file={mediaFile} scope={identity.scope} refresh={0} onClose={vi.fn()} />)
    await waitFor(() => expect(document.querySelector('audio')).toBeTruthy())
    const player = document.querySelector('audio')!
    const play = vi.spyOn(player, 'play').mockResolvedValue()
    mockGet.mockResolvedValueOnce({ success: true, data: { success: true, uses: [], has_more: false, limit: 40 } })
    view.rerender(<StoragePreview file={mediaFile} scope={identity.scope} refresh={1} onClose={vi.fn()} />)
    await waitFor(() => expect(player).toBeVisible())
    expect(play).not.toHaveBeenCalled()
    expect(document.querySelector('audio')).toBe(player)
  })

  it('coalesces revalidation hints without aborting the active read or resetting its deadline', async () => {
    vi.useFakeTimers()
    mockBlob.mockResolvedValue({ success: true, blob: new Blob(['image'], { type: 'image/png' }) })
    mockGet.mockImplementation(() => new Promise(() => {}))
    const onClose = vi.fn()
    const view = render(<StoragePreview file={file} scope={identity.scope} refresh={0} onClose={onClose} />)
    await act(async () => {})
    view.rerender(<StoragePreview file={file} scope={identity.scope} refresh={1} onClose={onClose} />)
    const firstSignal = mockGet.mock.calls[0][1]?.signal
    await act(async () => vi.advanceTimersByTime(PREVIEW_TIMEOUT_MS - 1000))
    view.rerender(<StoragePreview file={file} scope={identity.scope} refresh={2} onClose={onClose} />)
    view.rerender(<StoragePreview file={file} scope={identity.scope} refresh={3} onClose={onClose} />)
    expect(firstSignal?.aborted).toBe(false)
    expect(mockGet).toHaveBeenCalledTimes(1)
    await act(async () => vi.advanceTimersByTime(1000))
    expect(screen.getByRole('alert')).toHaveTextContent('No se pudo verificar tu acceso')
    expect(firstSignal?.aborted).toBe(true)
    expect(screen.getByRole('button', { name: 'Reintentar verificación' })).toBeEnabled()
  })

  it('bounds simultaneous thumbnails and cancels queued work when it unmounts', async () => {
    const completions: ((value: unknown) => void)[] = []
    mockBlob.mockImplementation(() => new Promise(resolve => completions.push(resolve as (value: unknown) => void)))
    const view = render(<>{Array.from({ length: 40 }, (_, index) => <StorageThumbnail key={index} file={{ ...file, object_key: `account-a/${index}.png` }} scope={identity.scope} />)}</>)
    await act(async () => {})
    expect(mockBlob).toHaveBeenCalledTimes(4)
    await act(async () => completions[0]({ success: false, status: 404 }))
    expect(mockBlob).toHaveBeenCalledTimes(5)
    const signals = mockBlob.mock.calls.map(([, options]) => options?.signal)
    view.unmount()
    await act(async () => completions[1]({ success: false, status: 404 }))
    expect(signals.every(signal => signal?.aborted)).toBe(true)
    expect(mockBlob).toHaveBeenCalledTimes(5)
  })

  it('resumes the same PDF session after a successful read while its coalesced follow-up continues', async () => {
    const completions: ((value: unknown) => void)[] = []
    mockGet.mockImplementation(() => new Promise(resolve => completions.push(resolve as (value: unknown) => void)))
    const pdf = { ...file, filename: 'Informe.pdf', media_type: 'document' as const }
    const onClose = vi.fn()
    const view = render(<StoragePreview file={pdf} scope={identity.scope} refresh={0} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Abrir vista previa' }))
    const session = screen.getByRole('dialog', { name: 'PDF canónico' })
    fireEvent.change(screen.getByRole('textbox', { name: 'Página actual' }), { target: { value: '4' } })
    view.rerender(<StoragePreview file={pdf} scope={identity.scope} refresh={1} onClose={onClose} />)
    view.rerender(<StoragePreview file={pdf} scope={identity.scope} refresh={2} onClose={onClose} />)
    view.rerender(<StoragePreview file={pdf} scope={identity.scope} refresh={3} onClose={onClose} />)
    expect(mockGet).toHaveBeenCalledTimes(1)
    const valid = { success: true, data: { success: true, uses: [], has_more: false, limit: 40 } }
    await act(async () => completions[0](valid))
    expect(mockGet).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('dialog', { name: 'PDF canónico' })).toBe(session)
    await act(async () => completions[1](valid))
    expect(screen.getByRole('dialog', { name: 'PDF canónico' })).toBe(session)
    expect(screen.getByRole('textbox', { name: 'Página actual' })).toHaveValue('4')
    expect(mockBlob).not.toHaveBeenCalled()
  })

  it('keeps resuming verified PDFs under continuous hints without timing out successful reads', async () => {
    vi.useFakeTimers()
    const completions: ((value: unknown) => void)[] = []
    mockGet.mockImplementation(() => new Promise(resolve => completions.push(resolve as (value: unknown) => void)))
    const pdf = { ...file, filename: 'Informe.pdf', media_type: 'document' as const }
    const onClose = vi.fn(), onUnavailable = vi.fn()
    const view = render(<StoragePreview file={pdf} scope={identity.scope} refresh={0} onClose={onClose} onUnavailable={onUnavailable} />)
    fireEvent.click(screen.getByRole('button', { name: 'Abrir vista previa' }))
    const session = screen.getByRole('dialog', { name: 'PDF canónico' })
    fireEvent.change(screen.getByRole('textbox', { name: 'Página actual' }), { target: { value: '4' } })
    view.rerender(<StoragePreview file={pdf} scope={identity.scope} refresh={1} onClose={onClose} onUnavailable={onUnavailable} />)
    for (let index = 0; index < 4; index++) {
      view.rerender(<StoragePreview file={pdf} scope={identity.scope} refresh={index + 2} onClose={onClose} onUnavailable={onUnavailable} />)
      await act(async () => vi.advanceTimersByTime(30_000))
      await act(async () => completions[index]({ success: true, data: { success: true, uses: [], has_more: false, limit: 40 } }))
      expect(mockGet).toHaveBeenCalledTimes(index + 2)
      expect(screen.getByRole('dialog', { name: 'PDF canónico' })).toBe(session)
      expect(screen.getByRole('textbox', { name: 'Página actual' })).toHaveValue('4')
      expect(screen.queryByRole('alert')).toBeNull()
    }
    await act(async () => completions[4]({ success: false, status: 404 }))
    expect(onUnavailable).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog', { name: 'PDF canónico' })).toBeNull()
  })

  it('releases stalled thumbnail permits and ignores their late media bodies', async () => {
    vi.useFakeTimers()
    const completions: ((value: unknown) => void)[] = []
    mockBlob.mockImplementation(() => new Promise(resolve => completions.push(resolve as (value: unknown) => void)))
    render(<>{Array.from({ length: 5 }, (_, index) => <StorageThumbnail key={index} file={{ ...file, object_key: `account-a/${index}.png` }} scope={identity.scope} />)}</>)
    await act(async () => {})
    expect(mockBlob).toHaveBeenCalledTimes(4)
    const firstSignals = mockBlob.mock.calls.map(([, options]) => options?.signal)
    await act(async () => vi.advanceTimersByTime(STORAGE_READ_TIMEOUT_MS))
    expect(firstSignals.every(signal => signal?.aborted)).toBe(true)
    expect(mockBlob).toHaveBeenCalledTimes(5)
    await act(async () => completions[0]({ success: true, blob: new Blob(['late'], { type: 'image/png' }) }))
    expect(createURL).not.toHaveBeenCalled()
  })

  it('does not start queued old-account thumbnails with the new account credentials', async () => {
    const completions: ((value: unknown) => void)[] = []
    mockBlob.mockImplementation(() => new Promise(resolve => completions.push(resolve as (value: unknown) => void)))
    const oldScope = identity.scope
    render(<>{Array.from({ length: 6 }, (_, index) => <StorageThumbnail key={index} file={{ ...file, object_key: `account-a/${index}.png` }} scope={oldScope} />)}</>)
    await act(async () => {})
    expect(mockBlob).toHaveBeenCalledTimes(4)
    identity.scope = 'account-b'
    render(<StorageThumbnail file={{ ...file, object_key: 'account-b/new.png' }} scope={identity.scope} />)
    await act(async () => {})
    expect(mockBlob).toHaveBeenCalledTimes(5)
    expect(mockBlob.mock.calls[4][0]).toContain('account-b%2Fnew.png')
    await act(async () => completions[0]({ success: true, blob: new Blob(['old'], { type: 'image/png' }) }))
    expect(mockBlob).toHaveBeenCalledTimes(5)
    expect(createURL).not.toHaveBeenCalled()
  })

})
