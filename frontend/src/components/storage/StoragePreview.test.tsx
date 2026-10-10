import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StoragePreview, StorageThumbnail } from './StoragePreview'
import { apiBlob } from '@/lib/api'
import { PREVIEW_MAX_BYTES, PREVIEW_TIMEOUT_MS, type StorageFile } from './storageModel'

const identity = vi.hoisted(() => ({ scope: 'account-a' }))
vi.mock('@/lib/api', () => ({ apiBlob: vi.fn() }))
vi.mock('@/components/chat/ChatDocumentViewer', () => ({ default: ({ document, onClose }: { document: { sessionId: string; src: string }; onClose: () => void }) => <div role="dialog" aria-label="PDF canónico"><span data-testid="pdf-source">{document.src}</span><span data-testid="pdf-session">{document.sessionId}</span><button onClick={onClose}>Cerrar PDF</button></div> }))
vi.mock('@/lib/authScope', () => ({ getAuthScope: () => identity.scope }))
const file: StorageFile = { object_key: 'account-a/photo.png', filename: 'Foto.png', media_type: 'image', size_bytes: 4096, origins: [{ type: 'chats', label: 'Chat', href: '/dashboard/chats' }], references_count: 1, can_remove: true, status: 'active' }
const mockBlob = vi.mocked(apiBlob)
let createURL = vi.fn(() => 'blob:private-file')
let revokeURL = vi.fn()
beforeEach(() => { identity.scope = 'account-a'; mockBlob.mockReset(); createURL = vi.fn(() => 'blob:private-file'); revokeURL = vi.fn(); URL.createObjectURL = createURL; URL.revokeObjectURL = revokeURL })
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
  it('avoids downloading large videos merely by opening details', () => {
    render(<StoragePreview file={{ ...file, filename: 'Video.mp4', media_type: 'video', size_bytes: PREVIEW_MAX_BYTES + 1 }} scope={identity.scope} onClose={() => {}} />)
    expect(mockBlob).not.toHaveBeenCalled(); expect(screen.getByText('Este archivo es grande')).toBeTruthy()
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

})
