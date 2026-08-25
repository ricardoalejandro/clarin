import { StrictMode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WhiteboardPublicLibraryCallback, {
  refreshWhiteboardPublicLibraryCallbackSession,
  resetWhiteboardPublicLibraryCallbackMemoryForTests,
  type WhiteboardPublicLibraryCallbackRuntime,
} from './WhiteboardPublicLibraryCallback'
import { tryRefreshTokenOutcome } from '@/lib/api'
import { buildWhiteboardPublicLibraryLoginPath } from '@/lib/whiteboardPublicLibraries'
import { submitWhiteboardPublicLibraryCallback } from '@/lib/whiteboardPublicLibrariesApi'

vi.mock('@/lib/whiteboardPublicLibrariesApi', () => ({
  submitWhiteboardPublicLibraryCallback: vi.fn(),
}))
vi.mock('@/lib/api', () => ({
  tryRefreshTokenOutcome: vi.fn(),
}))

const boardID = '11111111-1111-4111-8111-111111111111'
const libraryID = '22222222-2222-4222-8222-222222222222'
const importID = '33333333-3333-4333-8333-333333333333'
const token = 'abcdefghijklmnopqrstuvwxyz_123456'
const libraryURL = 'https://libraries.example.invalid/libraries/team/forms.excalidrawlib'
const mockedSubmit = vi.mocked(submitWhiteboardPublicLibraryCallback)
const mockedRefresh = vi.mocked(tryRefreshTokenOutcome)

afterEach(() => {
  cleanup()
  resetWhiteboardPublicLibraryCallbackMemoryForTests()
  vi.clearAllMocks()
})

function callbackRuntime(
  hashValue: string,
  order: string[] = [],
  storage = new Map<string, string>(),
  refreshSession: WhiteboardPublicLibraryCallbackRuntime['refreshSession'] = vi.fn(async () => 'refreshed' as const),
) {
  let hash = hashValue
  const navigate = vi.fn((path: string) => { order.push(`navigate:${path}`) })
  const clearHash = vi.fn(() => {
    order.push('clear')
    hash = ''
  })
  const runtime: WhiteboardPublicLibraryCallbackRuntime = {
    identity: () => '/whiteboards/library-import',
    readHash: () => hash,
    clearHash,
    navigate,
    readSession: key => storage.get(key) || null,
    writeSession: (key, value) => { storage.set(key, value) },
    removeSession: key => { storage.delete(key) },
    refreshSession,
  }
  return { clearHash, navigate, refreshSession, runtime, storage }
}

describe('WhiteboardPublicLibraryCallback', () => {
  it('lets the callback own the allow-listed login redirect when inactivity expires the session', async () => {
    mockedRefresh.mockResolvedValue('expired')

    await expect(refreshWhiteboardPublicLibraryCallbackSession()).resolves.toBe('expired')

    expect(mockedRefresh).toHaveBeenCalledWith({ redirectOnIdle: false })
  })

  it('clears the secret fragment before posting and returns only with a nonsensitive import id', async () => {
    const order: string[] = []
    mockedSubmit.mockImplementation(async () => {
      order.push('submit')
      return { success: true, data: { success: true, board_id: boardID, import_id: importID }, status: 200 }
    })
    const { clearHash, navigate, runtime } = callbackRuntime(
      `#addLibrary=${encodeURIComponent(libraryURL)}&token=${token}`,
      order,
    )

    render(<WhiteboardPublicLibraryCallback runtime={runtime} />)
    expect(screen.getByRole('status')).toHaveTextContent('Tu navegador no se conecta directamente')
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(
      `/dashboard/whiteboards/${boardID}?library_import=${importID}`,
    ))
    expect(clearHash).toHaveBeenCalledTimes(1)
    expect(mockedSubmit).toHaveBeenCalledWith({ token, libraryURL })
    expect(order.slice(0, 2)).toEqual(['clear', 'submit'])
    expect(navigate.mock.calls[0][0]).not.toContain(token)
    expect(navigate.mock.calls[0][0]).not.toContain(libraryURL)
  })

  it('deduplicates the one-time callback through a React StrictMode remount', async () => {
    mockedSubmit.mockResolvedValue({
      success: true,
      data: { success: true, board_id: boardID, import_id: importID },
      status: 200,
    })
    const { navigate, runtime } = callbackRuntime(
      `#addLibrary=${encodeURIComponent(libraryURL)}&token=${token}`,
    )
    render(<StrictMode><WhiteboardPublicLibraryCallback runtime={runtime} /></StrictMode>)
    await waitFor(() => expect(navigate).toHaveBeenCalled())
    expect(mockedSubmit).toHaveBeenCalledTimes(1)
  })

  it('keeps a retryable safe error without revealing the token or remote URL', async () => {
    mockedSubmit
      .mockResolvedValueOnce({ success: false, error: `rejected ${token}`, status: 503 })
      .mockResolvedValueOnce({
        success: true,
        data: { success: true, board_id: boardID, import_id: importID },
        status: 200,
      })
    const { navigate, runtime } = callbackRuntime(
      `#addLibrary=${encodeURIComponent(libraryURL)}&token=${token}`,
    )
    render(<WhiteboardPublicLibraryCallback runtime={runtime} />)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('No se pudo validar la biblioteca')
    expect(alert).not.toHaveTextContent(token)
    expect(alert).not.toHaveTextContent(libraryURL)
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }))
    await waitFor(() => expect(navigate).toHaveBeenCalled())
    expect(mockedSubmit).toHaveBeenCalledTimes(2)
  })

  it('allows retry when an ambiguous callback is still being fetched by Clarin', async () => {
    mockedSubmit
      .mockResolvedValueOnce({
        success: false,
        status: 409,
        error: 'not ready',
        data: { code: 'whiteboard_library_import_unavailable' },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { success: true, board_id: boardID, import_id: importID },
        status: 200,
      })
    const { navigate, runtime } = callbackRuntime(
      `#addLibrary=${encodeURIComponent(libraryURL)}&token=${token}`,
    )
    render(<WhiteboardPublicLibraryCallback runtime={runtime} />)

    expect(await screen.findByRole('button', { name: 'Reintentar' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(
      `/dashboard/whiteboards/${boardID}?library_import=${importID}`,
    ))
    expect(mockedSubmit).toHaveBeenCalledTimes(2)
  })

  it('does not retry a library that the server rejected as unsafe', async () => {
    mockedSubmit.mockResolvedValue({ success: false, error: `rejected ${token}`, status: 422 })
    const { runtime } = callbackRuntime(
      `#addLibrary=${encodeURIComponent(libraryURL)}&token=${token}`,
    )
    render(<WhiteboardPublicLibraryCallback runtime={runtime} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Clarin rechazó la biblioteca')
    expect(screen.queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument()
  })

  it('prioritizes and clears a new callback fragment after an earlier import failed', async () => {
    const nextToken = 'zyxwvutsrqponmlkjihgfedcba_654321'
    const nextLibraryURL = 'https://libraries.example.invalid/libraries/team/architecture.excalidrawlib'
    mockedSubmit
      .mockResolvedValueOnce({ success: false, error: 'unsafe', status: 422 })
      .mockResolvedValueOnce({
        success: true,
        data: { success: true, board_id: boardID, import_id: importID },
        status: 200,
      })

    const first = callbackRuntime(`#addLibrary=${encodeURIComponent(libraryURL)}&token=${token}`)
    const firstRender = render(<WhiteboardPublicLibraryCallback runtime={first.runtime} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Clarin rechazó la biblioteca')
    firstRender.unmount()

    const second = callbackRuntime(`#addLibrary=${encodeURIComponent(nextLibraryURL)}&token=${nextToken}`)
    render(<WhiteboardPublicLibraryCallback runtime={second.runtime} />)
    await waitFor(() => expect(second.navigate).toHaveBeenCalledWith(
      `/dashboard/whiteboards/${boardID}?library_import=${importID}`,
    ))

    expect(first.clearHash).toHaveBeenCalledTimes(1)
    expect(second.clearHash).toHaveBeenCalledTimes(1)
    expect(mockedSubmit).toHaveBeenCalledTimes(2)
    expect(mockedSubmit).toHaveBeenNthCalledWith(2, {
      token: nextToken,
      libraryURL: nextLibraryURL,
    })
  })

  it('does not offer an inert retry when the fragment itself is invalid', async () => {
    const { runtime } = callbackRuntime('#token=short')
    render(<WhiteboardPublicLibraryCallback runtime={runtime} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('formato esperado')
    expect(screen.queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument()
    expect(mockedSubmit).not.toHaveBeenCalled()
  })

  it('keeps an expired-session callback only in session storage and resumes after login', async () => {
    const storage = new Map<string, string>()
    mockedSubmit
      .mockResolvedValueOnce({ success: false, error: 'unauthorized', status: 401 })
      .mockResolvedValueOnce({
        success: true,
        data: { success: true, board_id: boardID, import_id: importID },
        status: 200,
      })
    const first = callbackRuntime(
      `#addLibrary=${encodeURIComponent(libraryURL)}&token=${token}`,
      [],
      storage,
      vi.fn(async () => 'expired' as const),
    )
    const firstRender = render(<WhiteboardPublicLibraryCallback runtime={first.runtime} />)

    await waitFor(() => expect(first.navigate).toHaveBeenCalledWith(buildWhiteboardPublicLibraryLoginPath()))
    expect(first.clearHash).toHaveBeenCalledTimes(1)
    expect(Array.from(storage.values()).join('')).toContain(token)
    firstRender.unmount()

    // A full navigation loses module memory. The second callback therefore has
    // no fragment and must recover exclusively from the tab's sessionStorage.
    resetWhiteboardPublicLibraryCallbackMemoryForTests()
    const resumed = callbackRuntime('', [], storage)
    render(<WhiteboardPublicLibraryCallback runtime={resumed.runtime} />)
    await waitFor(() => expect(resumed.navigate).toHaveBeenCalledWith(
      `/dashboard/whiteboards/${boardID}?library_import=${importID}`,
    ))
    expect(storage.size).toBe(0)
    expect(mockedSubmit).toHaveBeenCalledTimes(2)
  })

  it('keeps a temporarily unavailable session check retryable without navigating to login', async () => {
    mockedSubmit.mockResolvedValue({ success: false, error: 'unauthorized', status: 401 })
    const { navigate, runtime } = callbackRuntime(
      `#addLibrary=${encodeURIComponent(libraryURL)}&token=${token}`,
      [],
      new Map<string, string>(),
      vi.fn(async () => 'unavailable' as const),
    )

    render(<WhiteboardPublicLibraryCallback runtime={runtime} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo verificar tu sesión temporalmente')
    expect(screen.getByRole('button', { name: 'Reintentar' })).toBeVisible()
    expect(navigate).not.toHaveBeenCalled()
  })
})
