import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import OfflinePreparedDownloads, { preparedTaskDownloadPath } from './OfflinePreparedDownloads'
const runtime = vi.hoisted(() => ({ isOffline: true, snapshot: { accountId: 'account', userId: 'user' } }))
vi.mock('./ClarinRuntimeProvider', () => ({ useClarinRuntime: () => runtime }))

describe('the canonical offline attachment download control', () => {
  it('only intercepts same-origin original task download paths', () => {
    expect(preparedTaskDownloadPath('/api/tasks/task/attachments/file/download', 'http://localhost:19445')).toBe('/api/tasks/task/attachments/file/download')
    for (const path of ['https://clarin.naperu.cloud/api/tasks/task/attachments/file/download', '/api/tasks/task', 'blob:http://localhost:19445/one', '/api/tasks/task/attachments/file/preview/download']) {
      expect(preparedTaskDownloadPath(path, 'http://localhost:19445')).toBeUndefined()
    }
  })
  it('uses local fetch for a normal link and preserves a recoverable failure', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 503 }))
    vi.stubGlobal('fetch', fetcher)
    const { unmount } = render(<><OfflinePreparedDownloads /><a href="/api/tasks/task/attachments/file/download">Descargar archivo</a></>)
    fireEvent.click(screen.getByRole('link', { name: 'Descargar archivo' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('no está preparado'))
    expect(fetcher).toHaveBeenCalledTimes(1)
    const signal = fetcher.mock.calls[0][1]!.signal!
    unmount()
    expect(signal.aborted).toBe(true)
    vi.unstubAllGlobals()
  })
})
