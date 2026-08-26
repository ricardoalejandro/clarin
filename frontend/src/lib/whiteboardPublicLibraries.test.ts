import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildWhiteboardPublicLibraryImportCompletePath,
  buildWhiteboardPublicLibraryImportPath,
  buildWhiteboardPublicLibraryReturnPath,
  buildWhiteboardPublicLibraryStartPath,
  acknowledgeWhiteboardPublicLibraryImportAfterConflict,
  consumeWhiteboardPublicLibraryImport,
  consumeWhiteboardPublicLibraryWorkReturn,
  installWhiteboardPublicLibraryStartPath,
  isWhiteboardPublicLibraryStartPath,
  parseWhiteboardPublicLibraryCallbackFragment,
  readWhiteboardPublicLibraryImportID,
  rememberWhiteboardPublicLibraryWorkReturn,
  stripWhiteboardPublicLibraryImportFromPath,
  validateWhiteboardPublicLibraryNavigationPath,
  validateWhiteboardPublicLibraryImportRecord,
  whiteboardPublicLibraryCallbackError,
  type WhiteboardPublicLibraryImportRecord,
} from './whiteboardPublicLibraries'
import {
  completeWhiteboardPublicLibraryImport,
  getWhiteboardPublicLibraryImport,
  startWhiteboardPublicLibraryImport,
  submitWhiteboardPublicLibraryCallback,
  WHITEBOARD_PUBLIC_LIBRARY_START_HEADER,
} from './whiteboardPublicLibrariesApi'

const boardID = '11111111-1111-4111-8111-111111111111'
const libraryID = '22222222-2222-4222-8222-222222222222'
const importID = '33333333-3333-4333-8333-333333333333'
const token = 'abcdefghijklmnopqrstuvwxyz_123456'
const libraryURL = 'https://libraries.example.invalid/libraries/team/forms.excalidrawlib'

afterEach(() => {
  vi.restoreAllMocks()
  delete globalThis.__CLARIN_WHITEBOARD_LIBRARY_START_URL__
  window.localStorage.clear()
  window.sessionStorage.clear()
})

describe('public whiteboard library routing', () => {
  it('builds only bounded same-origin API and return paths', () => {
    expect(buildWhiteboardPublicLibraryStartPath(boardID, libraryID)).toBe(
      `/api/whiteboards/${boardID}/public-library-import/start?library_id=${libraryID}`,
    )
    expect(buildWhiteboardPublicLibraryImportPath(boardID, importID)).toBe(
      `/api/whiteboards/${boardID}/public-library-imports/${importID}`,
    )
    expect(buildWhiteboardPublicLibraryImportCompletePath(boardID, importID)).toBe(
      `/api/whiteboards/${boardID}/public-library-imports/${importID}/complete`,
    )
    expect(buildWhiteboardPublicLibraryReturnPath(boardID, importID)).toBe(
      `/dashboard/whiteboards/${boardID}?library_import=${importID}`,
    )
    expect(buildWhiteboardPublicLibraryStartPath('not-a-board', libraryID)).toBeNull()
    expect(buildWhiteboardPublicLibraryReturnPath(boardID, '../escape')).toBeNull()
  })

  it('installs and ownership-cleans the native button route during fast board switches', () => {
    const cleanupFirst = installWhiteboardPublicLibraryStartPath(boardID, libraryID)
    const first = globalThis.__CLARIN_WHITEBOARD_LIBRARY_START_URL__
    expect(first).toBe(buildWhiteboardPublicLibraryStartPath(boardID, libraryID))

    const nextBoard = '44444444-4444-4444-8444-444444444444'
    const cleanupSecond = installWhiteboardPublicLibraryStartPath(nextBoard, libraryID)
    cleanupFirst()
    expect(globalThis.__CLARIN_WHITEBOARD_LIBRARY_START_URL__).toBe(
      buildWhiteboardPublicLibraryStartPath(nextBoard, libraryID),
    )
    cleanupSecond()
    expect(globalThis.__CLARIN_WHITEBOARD_LIBRARY_START_URL__).toBeUndefined()
  })

  it('keeps an already-rendered canonical browse link as document navigation after global cleanup', () => {
    const cleanup = installWhiteboardPublicLibraryStartPath(boardID, libraryID)
    const renderedPath = globalThis.__CLARIN_WHITEBOARD_LIBRARY_START_URL__
    cleanup()

    expect(renderedPath).toBe(buildWhiteboardPublicLibraryStartPath(boardID, libraryID))
    expect(globalThis.__CLARIN_WHITEBOARD_LIBRARY_START_URL__).toBeUndefined()
    expect(isWhiteboardPublicLibraryStartPath(renderedPath || '', boardID, libraryID)).toBe(true)
    expect(isWhiteboardPublicLibraryStartPath(renderedPath || '', '44444444-4444-4444-8444-444444444444', libraryID)).toBe(false)
    expect(isWhiteboardPublicLibraryStartPath(renderedPath || '', boardID, importID)).toBe(false)
    expect(isWhiteboardPublicLibraryStartPath(`${renderedPath}&extra=1`, boardID, libraryID)).toBe(false)
    expect(isWhiteboardPublicLibraryStartPath(`https://attacker.example${renderedPath}`, boardID, libraryID)).toBe(false)
    expect(isWhiteboardPublicLibraryStartPath(renderedPath || '', boardID, null)).toBe(false)
  })

  it('accepts only the canonical query-free navigation path for the active board', () => {
    const path = `/api/whiteboards/${boardID}/public-library-imports/${importID}/navigate`
    expect(validateWhiteboardPublicLibraryNavigationPath(path, boardID)).toEqual({ path, importID })
    expect(validateWhiteboardPublicLibraryNavigationPath(`https://clarin.example${path}`, boardID)).toBeNull()
    expect(validateWhiteboardPublicLibraryNavigationPath(path.replace(boardID, libraryID), boardID)).toBeNull()
    expect(validateWhiteboardPublicLibraryNavigationPath(`${path}?handoff=${token}`, boardID)).toBeNull()
    expect(validateWhiteboardPublicLibraryNavigationPath(`${path}?extra=1`, boardID)).toBeNull()
    expect(validateWhiteboardPublicLibraryNavigationPath(`${path}#fragment`, boardID)).toBeNull()
    expect(validateWhiteboardPublicLibraryNavigationPath(path.replace(importID, '../escape'), boardID)).toBeNull()
  })

  it('reads and removes only the import query while preserving unrelated state', () => {
    expect(readWhiteboardPublicLibraryImportID(`?view=library&library_import=${importID}`)).toBe(importID)
    expect(readWhiteboardPublicLibraryImportID('?library_import=invalid')).toBeNull()
    expect(stripWhiteboardPublicLibraryImportFromPath(
      `/dashboard/whiteboards/${boardID}`,
      `?view=library&library_import=${importID}`,
      '#selection',
    )).toBe(`/dashboard/whiteboards/${boardID}?view=library#selection`)
  })

  it('round-trips a single-use Work destination without accepting arbitrary return URLs', () => {
    const workViewID = '44444444-4444-4444-8444-444444444444'
    expect(rememberWhiteboardPublicLibraryWorkReturn(
      boardID,
      `/dashboard/tasks?work_view=${workViewID}`,
      window.sessionStorage,
    )).toBe(true)
    expect(consumeWhiteboardPublicLibraryWorkReturn(boardID, importID, window.sessionStorage)).toBe(
      `/dashboard/tasks?work_view=${workViewID}&library_import=${importID}`,
    )
    expect(consumeWhiteboardPublicLibraryWorkReturn(boardID, importID, window.sessionStorage)).toBeNull()
    expect(rememberWhiteboardPublicLibraryWorkReturn(
      boardID,
      `https://attacker.example/dashboard/tasks?work_view=${workViewID}`,
      window.sessionStorage,
    )).toBe(false)
    expect(rememberWhiteboardPublicLibraryWorkReturn(
      boardID,
      `/dashboard/tasks?work_view=not-a-view`,
      window.sessionStorage,
    )).toBe(false)
  })
})

describe('public whiteboard library callback fragment', () => {
  it('accepts the official hash shape without contacting its URL', () => {
    const parsed = parseWhiteboardPublicLibraryCallbackFragment(
      `#addLibrary=${encodeURIComponent(libraryURL)}&token=${token}`,
    )
    expect(parsed).toEqual({ ok: true, tokens: { token, libraryURL } })
  })

  it.each([
    ['', 'vacío'],
    [`#addLibrary=${encodeURIComponent(`http://libraries.example.invalid/forms.excalidrawlib`)}&token=${token}`, 'segura'],
    [`#addLibrary=${encodeURIComponent('https://user:pass@libraries.example.invalid/forms.excalidrawlib')}&token=${token}`, 'segura'],
    [`#addLibrary=${encodeURIComponent('https://libraries.example.invalid/forms.json')}&token=${token}`, 'compatible'],
    [`#addLibrary=${encodeURIComponent(libraryURL)}&token=short`, 'autorización'],
    [`#addLibrary=${encodeURIComponent(libraryURL)}&addLibrary=${encodeURIComponent(libraryURL)}&token=${token}`, 'formato'],
  ])('rejects an unsafe or ambiguous callback without echoing credentials', (hash, expectedMessage) => {
    const parsed = parseWhiteboardPublicLibraryCallbackFragment(hash)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.error).toContain(expectedMessage)
      expect(parsed.error).not.toContain(token)
      expect(parsed.error).not.toContain(libraryURL)
    }
  })

  it('maps backend failures to bounded messages that never echo input', () => {
    expect(whiteboardPublicLibraryCallbackError(422)).toContain('rechazó')
    expect(whiteboardPublicLibraryCallbackError(410)).toContain('venció')
    expect(whiteboardPublicLibraryCallbackError(500)).not.toContain(token)
  })
})

describe('validated public library consumption', () => {
  const record: WhiteboardPublicLibraryImportRecord = {
    id: importID,
    board_id: boardID,
    library_id: libraryID,
    status: 'ready',
    library_json: { type: 'excalidrawlib', libraryItems: [{ id: 'stable-item' }] },
  }

  it('merges and persists before one idempotent completion acknowledgement', async () => {
    const calls: string[] = []
    const mergeAndPersist = vi.fn(async () => {
      calls.push('persist')
      return { libraryVersion: 9 }
    })
    const complete = vi.fn(async () => { calls.push('complete') })

    const result = await consumeWhiteboardPublicLibraryImport({
      boardID,
      importID,
      libraryID,
      load: async () => record,
      mergeAndPersist,
      complete,
    })

    expect(calls).toEqual(['persist', 'complete'])
    expect(mergeAndPersist).toHaveBeenCalledWith(record.library_json, record)
    expect(complete).toHaveBeenCalledWith({ operationID: importID, libraryVersion: 9 })
    expect(result.alreadyCompleted).toBe(false)
  })

  it('does not merge or acknowledge an already completed or mismatched import', async () => {
    const mergeAndPersist = vi.fn()
    const complete = vi.fn()
    const completed = await consumeWhiteboardPublicLibraryImport({
      boardID,
      importID,
      libraryID,
      load: async () => ({ ...record, status: 'completed' }),
      mergeAndPersist,
      complete,
    })
    expect(completed.alreadyCompleted).toBe(true)
    expect(mergeAndPersist).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()

    await expect(consumeWhiteboardPublicLibraryImport({
      boardID,
      importID,
      libraryID,
      load: async () => ({ ...record, library_id: '44444444-4444-4444-8444-444444444444' }),
      mergeAndPersist,
      complete,
    })).rejects.toThrow('no válida')
    expect(complete).not.toHaveBeenCalled()
  })

  it('rejects a ready record without a validated document', () => {
    expect(validateWhiteboardPublicLibraryImportRecord(
      { ...record, library_json: undefined },
      boardID,
      importID,
      libraryID,
    )).toBeNull()
    expect(validateWhiteboardPublicLibraryImportRecord(
      { ...record, status: 'fetching', library_json: undefined },
      boardID,
      importID,
      libraryID,
    )?.status).toBe('fetching')
  })

  it('refuses to acknowledge before persistence returns a positive canonical version', async () => {
    const complete = vi.fn()
    await expect(consumeWhiteboardPublicLibraryImport({
      boardID,
      importID,
      libraryID,
      load: async () => record,
      mergeAndPersist: async () => ({ libraryVersion: 0 }),
      complete,
    })).rejects.toThrow('versión persistida')
    expect(complete).not.toHaveBeenCalled()
  })

  it('reconciles one concurrent version advance before retrying the same ACK operation', async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce({ success: false, status: 409 })
      .mockResolvedValueOnce({ success: true, status: 200 })
    const reconcileLibraryVersion = vi.fn(async () => 11)

    const result = await acknowledgeWhiteboardPublicLibraryImportAfterConflict({
      operationID: importID,
      libraryVersion: 10,
      complete,
      reconcileLibraryVersion,
    })

    expect(result).toEqual({
      response: { success: true, status: 200 },
      libraryVersion: 11,
      reconciled: true,
    })
    expect(complete).toHaveBeenNthCalledWith(1, { operationID: importID, libraryVersion: 10 })
    expect(complete).toHaveBeenNthCalledWith(2, { operationID: importID, libraryVersion: 11 })
    expect(reconcileLibraryVersion).toHaveBeenCalledTimes(1)
  })

  it('stops after one bounded reconciliation instead of looping on repeated conflicts', async () => {
    const complete = vi.fn().mockResolvedValue({ success: false, status: 409 })

    const result = await acknowledgeWhiteboardPublicLibraryImportAfterConflict({
      operationID: importID,
      libraryVersion: 10,
      complete,
      reconcileLibraryVersion: async () => 11,
    })

    expect(result.response).toEqual({ success: false, status: 409 })
    expect(complete).toHaveBeenCalledTimes(2)
  })
})

describe('public whiteboard library API boundary', () => {
  it('posts the fragment payload only to Clarin and uses same-origin import endpoints', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, navigation_path: `/api/whiteboards/${boardID}/public-library-imports/${importID}/navigate` }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, import_id: importID, board_id: boardID }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, import: { id: importID } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, import: { id: importID, status: 'completed' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))

    await startWhiteboardPublicLibraryImport(boardID, libraryID)
    await submitWhiteboardPublicLibraryCallback({ token, libraryURL })
    await getWhiteboardPublicLibraryImport(boardID, importID)
    await completeWhiteboardPublicLibraryImport(boardID, importID, { operationID: importID, libraryVersion: 9 })

    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/whiteboards/${boardID}/public-library-import/start?library_id=${libraryID}`)
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: 'POST', credentials: 'include', body: '{}', redirect: 'error',
    })
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get(WHITEBOARD_PUBLIC_LIBRARY_START_HEADER)).toBe('1')
    const callbackRequest = fetchMock.mock.calls[1]
    expect(callbackRequest[0]).toBe('/api/whiteboards/public-library-import/callback')
    expect(callbackRequest[1]).toMatchObject({ method: 'POST', credentials: 'include' })
    expect(JSON.parse(String(callbackRequest[1]?.body))).toEqual({ token, library_url: libraryURL })
    expect(fetchMock.mock.calls.slice(1).map(call => String(call[0]))).toEqual([
      '/api/whiteboards/public-library-import/callback',
      `/api/whiteboards/${boardID}/public-library-imports/${importID}`,
      `/api/whiteboards/${boardID}/public-library-imports/${importID}/complete`,
    ])
    expect(fetchMock.mock.calls.map(call => String(call[0]))).toEqual([
      `/api/whiteboards/${boardID}/public-library-import/start?library_id=${libraryID}`,
      '/api/whiteboards/public-library-import/callback',
      `/api/whiteboards/${boardID}/public-library-imports/${importID}`,
      `/api/whiteboards/${boardID}/public-library-imports/${importID}/complete`,
    ])
    expect(fetchMock.mock.calls.every(call => String(call[0]).startsWith('/api/'))).toBe(true)
    expect(JSON.parse(String(fetchMock.mock.calls[3][1]?.body))).toEqual({
      operation_id: importID,
      library_version: 9,
    })
  })
})
