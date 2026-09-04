import { describe, expect, it } from 'vitest'
import {
  buildWhiteboardListQuery,
  buildWhiteboardManualRevisionRequest,
  buildWhiteboardAccessUpdate,
  buildWhiteboardAccountUserSearchPath,
  buildWhiteboardGuestBootstrap,
  buildWhiteboardImportPlan,
  buildWhiteboardCursorUpdate,
  buildWhiteboardFollowChange,
  buildWhiteboardPresenceUpdate,
  buildWhiteboardViewportUpdate,
  buildWhiteboardPurgeRequest,
  buildWhiteboardRealtimePatch,
  buildWhiteboardSceneWritePlan,
  closeWhiteboardElementPatch,
  buildWhiteboardSavePayload,
  filterWhiteboards,
  filterWhiteboardAccountUsers,
  formatWhiteboardUpdatedAt,
  hasWhiteboardDocumentMutation,
  isWhiteboardSceneSequence,
  flattenWhiteboardFolders,
  mergeWhiteboardFileRecords,
  mergeWhiteboardSessionAppState,
  reconcileWhiteboardSummary,
  reconcileWhiteboardScopeCapability,
  reconcileWhiteboardCanonicalAck,
  reconcileWhiteboardLibraryConflict,
  reconcileWhiteboardCollaborators,
  reconcileWhiteboardConnectionOpen,
  whiteboardRealtimeSyncRecoveryPlan,
  retainWhiteboardPendingSave,
  combineWhiteboardLibraryItems,
  parseWhiteboardLibraryItems,
  planWhiteboardAssetPersistence,
  personalWhiteboardLibraryItems,
  parseWhiteboardViewMode,
  sameWhiteboardAccessGrants,
  sanitizeWhiteboardExternalLink,
  sanitizeWhiteboardFilesForPersistence,
  selectWhiteboardPersonalLibrary,
  snapshotWhiteboardFiles,
  shouldApplyWhiteboardRealtimeEvent,
  shouldRetryWhiteboardDirtySave,
  validateWhiteboardImport,
  whiteboardManagerLayout,
  whiteboardNavigationAction,
  whiteboardNavigationWritesCovered,
  whiteboardPurgeEligibleAt,
  whiteboardRoomSocketPath,
  whiteboardSceneSaveMethod,
  whiteboardThumbnailDelay,
  whiteboardDuplicateName,
  whiteboardEditorAccess,
  whiteboardEditorCanvasActions,
  whiteboardEditorLayout,
  whiteboardImageExportDialogAppState,
  whiteboardMoreMenuPosition,
  whiteboardToolbarShowsShare,
  whiteboardToolbarStacksBelowTools,
  whiteboardSaveFailureAction,
  whiteboardSaveRetryStateAfterReconnect,
  whiteboardSaveRetryDelay,
  WHITEBOARD_COMMENTS_UI_ENABLED,
  WHITEBOARD_SHARE_EXPORT_DEFAULT,
  WHITEBOARD_SHOW_DEPRECATED_OFFICIAL_FONTS,
  type WhiteboardSummary,
} from './whiteboards'
import {
  decodeSvgDataURL,
  isSvgWhiteboardFile,
  rasterizeWhiteboardFiles,
  referencedWhiteboardFileIDs,
  sanitizeWhiteboardSvg,
  validateWhiteboardImageDataURL,
} from './whiteboardMedia'
import { mapWhiteboardConcurrently, whiteboardAsyncResultIsStale } from './whiteboardAsync'
import {
  buildWhiteboardAssetListPath,
  buildWhiteboardLibrariesPath,
  buildWhiteboardShareLinksPath,
  buildWhiteboardVersionsPath,
  collectWhiteboardAssetPages,
  parseWhiteboardRealtimeEvent,
} from './whiteboardsApi'

const base: WhiteboardSummary = {
  id: 'board-1',
  name: 'Mapa de atención',
  folder_id: 'folder-1',
  folder_name: 'Operaciones',
  owner_name: 'Ana',
  created_at: '2026-08-09T08:00:00Z',
  updated_at: '2026-08-09T09:00:00Z',
  version: 2,
  scene_sequence: 3,
  effective_access: { level: 'manage', can_view: true, can_edit: true, can_manage_access: true },
}

describe('whiteboard frontend contracts', () => {
  it('reconciles comments only when a realtime room reconnects', () => {
    expect(reconcileWhiteboardConnectionOpen(false)).toEqual({ hasOpened: true, reloadComments: false })
    expect(reconcileWhiteboardConnectionOpen(true)).toEqual({ hasOpened: true, reloadComments: true })
  })

  it('merges canonical checkpoints without replacing the active editor session', () => {
    const activeTool = { type: 'rectangle', customType: null, locked: false, lastActiveTool: null }
    const selectedElementIds = { 'rect-1': true }
    const editingTextElement = { id: 'text-1', type: 'text' }
    const current = {
      viewBackgroundColor: '#ffffff',
      gridSize: 20,
      gridStep: 5,
      gridModeEnabled: false,
      scrollX: 900,
      scrollY: -200,
      zoom: { value: 1.8 },
      activeTool,
      selectedElementIds,
      editingTextElement,
      draggingElement: { id: 'rect-1', type: 'rectangle' },
    }

    const merged = mergeWhiteboardSessionAppState(current, {
      viewBackgroundColor: '#f8fafc',
      gridSize: 40,
      gridStep: 10,
      gridModeEnabled: true,
      scrollX: 0,
      scrollY: 0,
      zoom: { value: 1 },
      activeTool: { type: 'selection' },
      selectedElementIds: {},
      editingTextElement: null,
      draggingElement: null,
    })

    expect(merged).toMatchObject({
      viewBackgroundColor: '#f8fafc',
      gridSize: 40,
      gridStep: 10,
      gridModeEnabled: true,
      scrollX: 900,
      scrollY: -200,
      zoom: { value: 1.8 },
    })
    expect(merged.activeTool).toBe(activeTool)
    expect(merged.selectedElementIds).toBe(selectedElementIds)
    expect(merged.editingTextElement).toBe(editingTextElement)
    expect(merged.draggingElement).toBe(current.draggingElement)
  })

  it('keeps presence, viewport and selection ephemeral while persisting document changes', () => {
    const elements = [{ id: 'rect-1', version: 1, versionNonce: 10, isDeleted: false }]
    const canonicalAppState = { viewBackgroundColor: '#ffffff', gridSize: 20, gridStep: 5, gridModeEnabled: false }
    expect(hasWhiteboardDocumentMutation({
      currentElements: elements,
      previousElements: elements,
      currentAppState: {
        ...canonicalAppState,
        scrollX: 900,
        scrollY: -200,
        zoom: { value: 1.8 },
        selectedElementIds: { 'rect-1': true },
        collaborators: new Map([['peer-1', { username: 'Ana' }]]),
      },
      previousAppState: canonicalAppState,
      currentFiles: { image: { id: 'image', mimeType: 'image/png', created: 1, dataURL: 'data:image/png;base64,new' } },
      previousFiles: { image: { id: 'image', mimeType: 'image/png', created: 1, dataURL: 'data:image/png;base64,old' } },
    })).toBe(false)

    expect(hasWhiteboardDocumentMutation({
      currentElements: [{ ...elements[0], version: 2, versionNonce: 11 }],
      previousElements: elements,
      // A presence projection can arrive in the exact same editor callback as
      // the user's document mutation. Collaborators must remain ephemeral
      // without masking the real edit.
      currentAppState: {
        ...canonicalAppState,
        collaborators: new Map([['peer-1', { username: 'Ana' }]]),
      },
      previousAppState: canonicalAppState,
    })).toBe(true)
    expect(hasWhiteboardDocumentMutation({
      currentElements: elements,
      previousElements: elements,
      currentAppState: { ...canonicalAppState, viewBackgroundColor: '#f8fafc' },
      previousAppState: canonicalAppState,
    })).toBe(true)
    expect(hasWhiteboardDocumentMutation({
      currentElements: elements,
      previousElements: elements,
      currentAppState: canonicalAppState,
      previousAppState: canonicalAppState,
      currentFiles: { image: { id: 'image', mimeType: 'image/webp', created: 1 } },
      previousFiles: { image: { id: 'image', mimeType: 'image/png', created: 1 } },
    })).toBe(true)

    expect(hasWhiteboardDocumentMutation({
      currentElements: [{ id: 'image-1', type: 'image', fileId: 'file-1', status: 'saved', version: 1, versionNonce: 10 }],
      previousElements: [{ id: 'image-1', type: 'image', fileId: null, status: 'pending', version: 1, versionNonce: 10 }],
      currentAppState: canonicalAppState,
      previousAppState: canonicalAppState,
    })).toBe(true)
    expect(hasWhiteboardDocumentMutation({
      currentElements: [{ id: 'image-1', type: 'image', fileId: 'file-1', status: 'saved', version: 1, versionNonce: 10 }],
      previousElements: [{ id: 'image-1', type: 'image', fileId: 'file-1', status: 'saved', version: 1, versionNonce: 10 }],
      currentAppState: canonicalAppState,
      previousAppState: canonicalAppState,
      currentFiles: { 'file-1': { id: 'file-1', mimeType: 'image/png', dataURL: 'data:image/png;base64,ready' } },
      previousFiles: { 'file-1': { id: 'file-1', mimeType: 'image/png' } },
    })).toBe(true)
  })

  it('snapshots mutable image records and plans only durable referenced assets', () => {
    const mutable = { id: 'file-1', mimeType: 'image/png' }
    const snapshot = snapshotWhiteboardFiles({ 'file-1': mutable })
    ;(mutable as Record<string, unknown>).dataURL = 'data:image/png;base64,ready'
    expect(snapshot['file-1']).toEqual({ id: 'file-1', mimeType: 'image/png' })

    const plan = planWhiteboardAssetPersistence(
      [
        { id: 'image-1', type: 'image', fileId: 'file-1' },
        { id: 'image-2', type: 'image', fileId: 'file-2' },
        { id: 'image-3', type: 'image', fileId: 'persisted' },
        { id: 'deleted', type: 'image', fileId: 'deleted-file', isDeleted: true },
      ],
      { 'file-1': mutable, 'file-2': { id: 'file-2', mimeType: 'image/jpeg' } },
      new Set(['persisted']),
    )
    expect(plan.referencedFileIDs).toEqual(['file-1', 'file-2', 'persisted'])
    expect(plan.uploadFileIDs).toEqual(['file-1'])
    expect(plan.missingFileIDs).toEqual(['file-2'])

    const saveWhileCanonicalImageHydrates = planWhiteboardAssetPersistence(
      [{ id: 'canonical-image', type: 'image', fileId: 'canonical-file' }],
      {},
      new Set(['canonical-file']),
    )
    expect(saveWhileCanonicalImageHydrates).toEqual({
      referencedFileIDs: ['canonical-file'],
      uploadFileIDs: [],
      missingFileIDs: [],
    })
  })

  it('flushes before SPA navigation and confirms only after an unsuccessful flush', () => {
    expect(whiteboardNavigationAction({ dirty: false, pending: false, saving: false, flushAttempted: false })).toBe('leave')
    expect(whiteboardNavigationAction({ dirty: true, pending: true, saving: false, flushAttempted: false })).toBe('flush')
    expect(whiteboardNavigationAction({ dirty: true, pending: true, saving: true, flushAttempted: false })).toBe('wait')
    expect(whiteboardNavigationAction({ dirty: true, pending: true, saving: false, assetSaving: true, flushAttempted: false })).toBe('wait')
    expect(whiteboardNavigationAction({ dirty: false, pending: false, saving: false, commentSaving: true, flushAttempted: false })).toBe('wait')
    expect(whiteboardNavigationAction({ dirty: false, pending: false, saving: false, commentDirty: true, flushAttempted: false })).toBe('confirm')
    expect(whiteboardNavigationAction({
      dirty: false,
      pending: false,
      saving: false,
      libraryDirty: true,
      librarySaving: false,
      flushAttempted: false,
    })).toBe('flush')
    expect(whiteboardNavigationAction({ dirty: true, pending: true, saving: false, flushAttempted: true })).toBe('confirm')
  })

  it('allows SPA navigation only when successful writes cover the versions present at the click', () => {
    expect(whiteboardNavigationWritesCovered({
      requiredSceneVersion: 7,
      savedSceneVersion: 7,
      requiredLibraryVersion: 3,
      savedLibraryVersion: 3,
    })).toBe(true)
    expect(whiteboardNavigationWritesCovered({
      requiredSceneVersion: 8,
      savedSceneVersion: 7,
      requiredLibraryVersion: null,
      savedLibraryVersion: 0,
    })).toBe(false)
    expect(whiteboardNavigationWritesCovered({
      requiredSceneVersion: null,
      savedSceneVersion: 0,
      requiredLibraryVersion: 4,
      savedLibraryVersion: 3,
    })).toBe(false)
    expect(whiteboardNavigationWritesCovered({
      requiredSceneVersion: null,
      savedSceneVersion: 0,
      requiredLibraryVersion: null,
      savedLibraryVersion: 0,
      commentsPending: true,
    })).toBe(false)
    expect(whiteboardNavigationWritesCovered({
      requiredSceneVersion: null,
      savedSceneVersion: 0,
      requiredLibraryVersion: null,
      savedLibraryVersion: 0,
      commentsDirty: true,
    })).toBe(false)
  })

  it('falls back immediately and bounds automatic retries without discarding the operation', () => {
    expect(whiteboardSaveFailureAction(undefined, 1)).toBe('retry')
    expect(whiteboardSaveFailureAction(503, 2)).toBe('retry')
    expect(whiteboardSaveFailureAction(503, 3)).toBe('transient_exhausted')
    expect(whiteboardSaveFailureAction(404, 1)).toBe('terminal')
    expect(whiteboardSaveFailureAction(400, 1)).toBe('terminal')
    expect(whiteboardSaveFailureAction(403, 1)).toBe('terminal')
    expect(whiteboardSaveFailureAction(409, 1)).toBe('conflict')
    expect(whiteboardSaveRetryDelay(1)).toBe(1_000)
    expect(whiteboardSaveRetryDelay(2)).toBe(2_500)
  })

  it('unblocks only transiently exhausted pending saves after a real reconnect', () => {
    const payload = { expected_sequence: 7, operation_id: 'same-operation', scene: { elements: [{ id: 'same-payload' }] } }
    const pending = {
      operationID: 'same-operation',
      payload,
      automaticFailures: 3,
      automaticRetryBlockReason: 'transient_exhausted' as const,
    }
    const recoveredState = whiteboardSaveRetryStateAfterReconnect({
      previouslyOpened: true,
      automaticFailures: pending.automaticFailures,
      automaticRetryBlockReason: pending.automaticRetryBlockReason,
    })
    const recovered = { ...pending, ...recoveredState }

    expect(recovered).toMatchObject({
      operationID: 'same-operation',
      automaticFailures: 0,
      automaticRetryBlockReason: null,
      shouldRetry: true,
    })
    expect(recovered.payload).toBe(payload)

    for (const automaticRetryBlockReason of ['terminal', 'conflict'] as const) {
      expect(whiteboardSaveRetryStateAfterReconnect({
        previouslyOpened: true,
        automaticFailures: 1,
        automaticRetryBlockReason,
      })).toEqual({
        shouldRetry: false,
        automaticFailures: 1,
        automaticRetryBlockReason,
      })
    }
    expect(whiteboardSaveRetryStateAfterReconnect({
      previouslyOpened: false,
      automaticFailures: 3,
      automaticRetryBlockReason: 'transient_exhausted',
    })).toEqual({
      shouldRetry: false,
      automaticFailures: 3,
      automaticRetryBlockReason: 'transient_exhausted',
    })
  })

  it('selects the whiteboard chrome from measured available width', () => {
    expect(whiteboardEditorLayout(375)).toBe('mobile')
    expect(whiteboardEditorLayout(759)).toBe('mobile')
    expect(whiteboardEditorLayout(760)).toBe('compact')
    expect(whiteboardEditorLayout(1_279)).toBe('compact')
    expect(whiteboardEditorLayout(1_280)).toBe('wide')
    expect(whiteboardEditorLayout(Number.NaN)).toBe('mobile')
    expect(whiteboardToolbarShowsShare(1_279, true)).toBe(false)
    expect(whiteboardToolbarShowsShare(1_280, true)).toBe(true)
    expect(whiteboardToolbarShowsShare(1_440, false)).toBe(false)
    expect(whiteboardToolbarShowsShare(Number.NaN, true)).toBe(false)
    expect(whiteboardToolbarStacksBelowTools(959)).toBe(true)
    expect(whiteboardToolbarStacksBelowTools(960)).toBe(false)
    expect(whiteboardToolbarStacksBelowTools(Number.NaN)).toBe(true)
    expect(WHITEBOARD_COMMENTS_UI_ENABLED).toBe(false)
  })

  it('keeps native image export permission-aware and exposes every official pinned font', () => {
    expect(whiteboardEditorCanvasActions(true)).toEqual({
      loadScene: false,
      saveToActiveFile: false,
      saveAsImage: true,
      export: false,
      toggleTheme: false,
    })
    expect(whiteboardEditorCanvasActions(false).saveAsImage).toBe(false)
    expect(whiteboardImageExportDialogAppState()).toEqual({
      openDialog: { name: 'imageExport' },
    })
    expect(WHITEBOARD_SHOW_DEPRECATED_OFFICIAL_FONTS).toBe(true)
  })

  it('keeps the portaled More menu inside narrow and wide viewports', () => {
    expect(whiteboardMoreMenuPosition(
      { right: 256, bottom: 180 },
      { width: 320, height: 720 },
    )).toEqual({ top: 188, right: 12 })
    expect(whiteboardMoreMenuPosition(
      { right: 1_420, bottom: 60 },
      { width: 1_440, height: 900 },
    )).toEqual({ top: 68, right: 20 })
  })

  it('keeps the exact pending operation and payload through a lost ACK retry', () => {
    const pending = {
      operationID: 'operation-lost-ack',
      payload: { expected_sequence: 7, operation_id: 'operation-lost-ack', patch: { elements: [{ id: 'same-delta' }] } },
    }
    let rebuilt = 0
    const retry = retainWhiteboardPendingSave(pending, () => {
      rebuilt += 1
      return { operationID: 'wrong-new-operation', payload: {} }
    })

    expect(retry).toBe(pending)
    expect(retry).toEqual(pending)
    expect(rebuilt).toBe(0)
    expect(shouldRetryWhiteboardDirtySave({ dirty: true, saving: false, online: true, canEdit: true })).toBe(true)
    expect(shouldRetryWhiteboardDirtySave({ dirty: true, saving: true, online: true, canEdit: true })).toBe(false)
  })

  it('keeps guest export opt-in for newly created share links', () => {
    expect(WHITEBOARD_SHARE_EXPORT_DEFAULT).toBe(false)
  })

  it('debounces thumbnails and never schedules them more frequently than once per minute', () => {
    expect(whiteboardThumbnailDelay(0, 100_000)).toBe(1_500)
    expect(whiteboardThumbnailDelay(90_000, 100_000)).toBe(50_000)
    expect(whiteboardThumbnailDelay(40_000, 100_000)).toBe(1_500)
  })

  it('creates a real manual revision request with optimistic sequence and stable operation id', () => {
    expect(buildWhiteboardManualRevisionRequest(14, 'checkpoint-operation')).toEqual({
      expected_sequence: 14,
      operation_id: 'checkpoint-operation',
    })
  })

  it('derives a bounded explicit name for an atomic duplicate', () => {
    expect(whiteboardDuplicateName('Mapa')).toBe('Mapa (copia)')
    expect(whiteboardDuplicateName('x'.repeat(250))).toHaveLength(200)
  })

  it('opens only explicit http, https and mailto element links', () => {
    expect(sanitizeWhiteboardExternalLink(' https://clarin.example/ruta?q=1 ')).toBe('https://clarin.example/ruta?q=1')
    expect(sanitizeWhiteboardExternalLink('mailto:equipo@clarin.test')).toBe('mailto:equipo@clarin.test')
    expect(sanitizeWhiteboardExternalLink('javascript:alert(1)')).toBeNull()
    expect(sanitizeWhiteboardExternalLink('/ruta-relativa')).toBeNull()
    expect(sanitizeWhiteboardExternalLink('data:text/html,boom')).toBeNull()
  })

  it('collects every asset cursor page before exposing one complete manifest', async () => {
    const cursors: Array<string | null> = []
    const result = await collectWhiteboardAssetPages(async cursor => {
      cursors.push(cursor)
      if (cursor === null) {
        return { success: true, data: { assets: [{ id: 'asset-1' }], next_cursor: 'page-2' }, status: 200 }
      }
      return { success: true, data: { assets: [{ id: 'asset-2' }], next_cursor: null }, status: 200 }
    })

    expect(cursors).toEqual([null, 'page-2'])
    expect(result).toEqual({
      success: true,
      data: { success: true, assets: [{ id: 'asset-1' }, { id: 'asset-2' }], next_cursor: null },
      status: 200,
    })
  })

  it('selects only live image references and stops asset pagination once all are resolved', async () => {
    const fileIDs = referencedWhiteboardFileIDs([
      { id: 'image-1', type: 'image', fileId: 'file-1' },
      { id: 'shape', type: 'rectangle', fileId: 'ignored' },
      { id: 'deleted-image', type: 'image', fileId: 'deleted-file', isDeleted: true },
      { id: 'image-duplicate', type: 'image', fileId: 'file-1' },
      { id: 'image-2', type: 'image', fileId: 'file-2' },
    ])
    expect(fileIDs).toEqual(['file-1', 'file-2'])

    let calls = 0
    const result = await collectWhiteboardAssetPages(async () => {
      calls += 1
      return {
        success: true,
        data: {
          assets: [
            { file_id: 'orphan' },
            { file_id: 'file-1' },
            { file_id: 'file-2' },
          ],
          next_cursor: 'unused-next-page',
        },
        status: 200,
      }
    }, fileIDs)
    expect(calls).toBe(1)
    expect(result.data?.assets).toEqual([{ file_id: 'file-1' }, { file_id: 'file-2' }])
    expect(buildWhiteboardAssetListPath('board/1', null, true)).toBe('/api/whiteboards/board%2F1/assets?limit=200&referenced_only=1')
  })

  it('bounds concurrent whiteboard work to four workers', async () => {
    let active = 0
    let maximum = 0
    const result = await mapWhiteboardConcurrently([1, 2, 3, 4, 5, 6, 7, 8], 4, async value => {
      active += 1
      maximum = Math.max(maximum, active)
      await new Promise(resolve => setTimeout(resolve, 2))
      active -= 1
      return value * 2
    })
    expect(maximum).toBe(4)
    expect(result).toEqual([2, 4, 6, 8, 10, 12, 14, 16])
  })

  it('ignores stale async results after abort or editor unmount', () => {
    const controller = new AbortController()
    expect(whiteboardAsyncResultIsStale({ signal: controller.signal, mounted: true })).toBe(false)
    controller.abort()
    expect(whiteboardAsyncResultIsStale({ signal: controller.signal, mounted: true })).toBe(true)
    expect(whiteboardAsyncResultIsStale({ mounted: false })).toBe(true)
  })

  it('rejects a repeated asset cursor instead of returning a partial manifest', async () => {
    let calls = 0
    const result = await collectWhiteboardAssetPages(async () => {
      calls += 1
      return { success: true, data: { assets: [{ id: `asset-${calls}` }], next_cursor: 'same-cursor' }, status: 200 }
    })

    expect(calls).toBe(2)
    expect(result.success).toBe(false)
    expect(result.error).toContain('cursor repetido')
    expect(result.data).toBeUndefined()
  })

  it('builds one bounded account-scoped list request from settled filters', () => {
    expect(buildWhiteboardListQuery({ scope: 'shared', folderID: 'folder/1', search: '  mapa  ', limit: 500 }))
      .toBe('scope=shared&limit=200&folder_id=folder%2F1&q=mapa')
		expect(buildWhiteboardListQuery({ scope: 'work' }))
			.toBe('scope=all&origin=work&limit=50')
		expect(reconcileWhiteboardScopeCapability('work', false)).toBe('mine')
		expect(reconcileWhiteboardScopeCapability('work', true)).toBe('work')
		expect(reconcileWhiteboardScopeCapability('trash', false)).toBe('trash')
  })

  it('builds cursor-safe API paths for old share links and revisions', () => {
    expect(buildWhiteboardShareLinksPath('board/1', 'cursor/old')).toBe('/api/whiteboards/board%2F1/share-links?limit=50&cursor=cursor%2Fold')
    expect(buildWhiteboardVersionsPath('board/1', 42)).toBe('/api/whiteboards/board%2F1/revisions?limit=100&before_sequence=42')
  })

  it('loads only the bounded first library summary catalog', () => {
    expect(buildWhiteboardLibrariesPath()).toBe('/api/whiteboard-libraries?limit=50')
    expect(buildWhiteboardLibrariesPath('  Mi biblioteca  ')).toBe('/api/whiteboard-libraries?limit=50&q=Mi+biblioteca')
  })

  it('rejects remote or unsupported imported file sources before rendering', async () => {
    expect(() => validateWhiteboardImageDataURL('https://example.invalid/image.png', 'image/png')).toThrow(/no se permiten recursos remotos/i)
    expect(() => validateWhiteboardImageDataURL('data:text/html;base64,PGgxPmJvb208L2gxPg==', 'text/html')).toThrow(/tipo de imagen no permitido/i)
    await expect(rasterizeWhiteboardFiles({
      'remote-file': { id: 'remote-file', mimeType: 'image/png', dataURL: '//example.invalid/image.png', created: 1 },
    })).rejects.toThrow(/no se permiten recursos remotos/i)
    await expect(rasterizeWhiteboardFiles({
      'metadata-only': { id: 'metadata-only', mimeType: 'image/png', created: 1 },
    })).resolves.toEqual({})
  })

  it('filters the settled query across name, folder and owner without changing source order', () => {
    const second = { ...base, id: 'board-2', name: 'Calendario', folder_name: 'Equipo', owner_name: 'Luis' }
    expect(filterWhiteboards([base, second], 'operaciones').map(item => item.id)).toEqual(['board-1'])
    expect(filterWhiteboards([base, second], 'luis').map(item => item.id)).toEqual(['board-2'])
    expect(filterWhiteboards([{ ...base, description: 'Proceso de admisión' }, second], 'admisión').map(item => item.id)).toEqual(['board-1'])
    expect(filterWhiteboards([base, second], '').map(item => item.id)).toEqual(['board-1', 'board-2'])
		const contextual = {
			...base,
			id: 'board-work',
			origin: 'work' as const,
			work_location: {
				task_view_id: 'view-1',
				environment_id: 'environment-1',
				scope_type: 'list' as const,
				scope_id: 'list-1',
				scope_name: 'Operación diaria',
				breadcrumb: [{ type: 'environment' as const, id: 'environment-1', name: 'General' }, { type: 'list' as const, id: 'list-1', name: 'Operación diaria' }],
				lifecycle: 'active' as const,
			},
		}
		expect(filterWhiteboards([base, contextual], 'operación diaria').map(item => item.id)).toEqual(['board-work'])
  })

  it('persists only durable scene app state and carries optimistic concurrency metadata', () => {
    const payload = buildWhiteboardSavePayload({
      sceneSequence: 7,
      operationID: 'operation-1',
      reason: 'autosave',
      elements: [{ id: 'element-1' }],
      files: { file: { id: 'file', mimeType: 'image/png', created: 123, dataURL: 'data:image/png;base64,secret' } },
      appState: {
        viewBackgroundColor: '#ffffff',
        gridSize: 20,
        gridStep: 5,
        gridModeEnabled: true,
        frameRendering: { enabled: false, clip: true, name: false, outline: true },
        theme: 'dark',
        name: 'estado de usuario',
        objectsSnapModeEnabled: true,
        futureCanvasMode: { enabled: true },
        selectedElementIds: { secret: true },
        collaborators: new Map([['socket', { username: 'Otro usuario' }]]),
        openDialog: 'help',
      },
    })
    expect(payload).toEqual({
      expected_sequence: 7,
      operation_id: 'operation-1',
      scene: {
        type: 'excalidraw',
        version: 2,
        source: 'clarin',
        elements: [{ id: 'element-1' }],
        files: { file: { id: 'file', mimeType: 'image/png', created: 123 } },
        appState: {
          viewBackgroundColor: '#ffffff',
          gridSize: 20,
          gridStep: 5,
          gridModeEnabled: true,
        },
      },
      scene_schema_version: 'excalidraw',
      editor_version: '0.18.1-clarin.6',
    })
  })

  it('persists forward-compatible file metadata without bytes or storage locations', () => {
    const metadata = sanitizeWhiteboardFilesForPersistence({
      'file-1': {
        id: 'file-1',
        mimeType: 'image/png',
        created: 123,
        futureMetadata: { colorProfile: 'p3', remoteUrl: 'https://upstream.invalid/image.png', bytes: [1, 2, 3] },
        dataURL: 'data:image/png;base64,secret',
        src: '/private/object',
        storage_key: 'account/private/object',
        binary: new Uint8Array([1, 2, 3]),
      },
      invalid: new Blob(['secret']),
    })
    expect(metadata).toEqual({
      'file-1': {
        id: 'file-1',
        mimeType: 'image/png',
        created: 123,
        futureMetadata: { colorProfile: 'p3' },
      },
    })
    expect(JSON.stringify(metadata)).not.toContain('secret')
    expect(JSON.stringify(metadata)).not.toContain('upstream.invalid')
    expect(mergeWhiteboardFileRecords(metadata, {
      'file-1': { id: 'file-1', dataURL: 'data:image/png;base64,editable-export', lastRetrieved: 789 },
    })).toEqual({
      'file-1': {
        id: 'file-1',
        mimeType: 'image/png',
        created: 123,
        futureMetadata: { colorProfile: 'p3' },
        dataURL: 'data:image/png;base64,editable-export',
        lastRetrieved: 789,
      },
    })
  })

  it('round-trips unknown root extensions without allowing stale core fields to win', () => {
    const payload = buildWhiteboardSavePayload({
      sceneSequence: 2,
      operationID: 'future-scene',
      reason: 'manual',
      elements: [{ id: 'current' }],
      appState: {},
      rootExtensions: { futureFeature: { mode: 'new' }, elements: [{ id: 'stale' }], source: 'upstream' },
    })
    expect(payload.scene.futureFeature).toEqual({ mode: 'new' })
    expect(payload.scene.elements).toEqual([{ id: 'current' }])
    expect(payload.scene.source).toBe('clarin')
  })

  it('imports by creating an empty board and committing one sequence-zero snapshot after assets', () => {
    const plan = buildWhiteboardImportPlan({
      name: 'Flujo importado',
      folderID: 'folder-1',
      operationID: 'import-operation',
      elements: [{ id: 'image-1', fileId: 'file-1' }],
      appState: { viewBackgroundColor: '#fff', selectedElementIds: { transient: true } },
      files: { 'file-1': { id: 'file-1', mimeType: 'image/png', created: 456, dataURL: 'data:image/png;base64,secret' } },
    })
    expect(plan.create).toEqual({ name: 'Flujo importado', folder_id: 'folder-1' })
    expect(plan.snapshot.expected_sequence).toBe(0)
    expect(plan.snapshot.operation_id).toBe('import-operation')
    expect(plan.snapshot.patch).toBeUndefined()
    expect(plan.snapshot.scene.elements).toEqual([{ id: 'image-1', fileId: 'file-1' }])
    expect(plan.snapshot.scene.files).toEqual({ 'file-1': { id: 'file-1', mimeType: 'image/png', created: 456 } })
  })

  it('rejects realtime echoes/stale revisions and accepts the next canonical revision', () => {
    expect(isWhiteboardSceneSequence(0)).toBe(true)
    expect(isWhiteboardSceneSequence(7)).toBe(true)
    expect(isWhiteboardSceneSequence(undefined)).toBe(false)
    expect(isWhiteboardSceneSequence(-1)).toBe(false)
    expect(isWhiteboardSceneSequence(1.5)).toBe(false)
    expect(isWhiteboardSceneSequence(Number.NaN)).toBe(false)
    expect(shouldApplyWhiteboardRealtimeEvent({ currentSceneSequence: 4, localOperationID: 'own', event: { sequence: 5, operation_id: 'own' } })).toBe(false)
    expect(shouldApplyWhiteboardRealtimeEvent({ currentSceneSequence: 4, localOperationID: 'own', event: { sequence: 4, operation_id: 'other' } })).toBe(false)
    expect(shouldApplyWhiteboardRealtimeEvent({ currentSceneSequence: 4, localOperationID: 'own', event: { sequence: 5, operation_id: 'other' } })).toBe(true)
    expect(shouldApplyWhiteboardRealtimeEvent({ currentSceneSequence: 0, localOperationID: null, event: { sequence: 0 } })).toBe(false)
    expect(shouldApplyWhiteboardRealtimeEvent({ currentSceneSequence: 0, localOperationID: null, event: {} })).toBe(false)
  })

  it('accepts a canonical rebased ACK and reapplies only edits made after its captured payload', () => {
    const canonical = [
      { id: 'remote-b', version: 1, versionNonce: 10, x: 20 },
      { id: 'local-a', version: 1, versionNonce: 11, x: 10 },
    ]
    const captured = [{ id: 'local-a', version: 1, versionNonce: 11, x: 10 }]
    const current = [{ id: 'local-a', version: 2, versionNonce: 12, x: 30 }]
    expect(reconcileWhiteboardCanonicalAck({
      canonicalElements: canonical,
      capturedElements: captured,
      currentElements: current,
      canonicalAppState: { viewBackgroundColor: '#ffffff', gridSize: 20 },
      capturedAppState: { viewBackgroundColor: '#ffffff', gridSize: 20 },
      currentAppState: { viewBackgroundColor: '#ffffff', gridSize: 40, selectedElementIds: { transient: true } },
    })).toEqual({
      elements: [
        { id: 'remote-b', version: 1, versionNonce: 10, x: 20 },
        { id: 'local-a', version: 2, versionNonce: 12, x: 30 },
      ],
      appState: { viewBackgroundColor: '#ffffff', gridSize: 40 },
      laterLocalChanges: [{ id: 'local-a', version: 2, versionNonce: 12, x: 30 }],
    })
    expect(parseWhiteboardRealtimeEvent({
      event: 'ack',
      data: {
        sequence: 2,
        operation_id: 'operation-a',
        rebased: true,
        scene: { type: 'excalidraw', version: 2, source: 'clarin', elements: canonical, appState: {}, files: {} },
      },
    })).toMatchObject({ event: 'ack', sequence: 2, operation_id: 'operation-a', rebased: true, scene: { elements: canonical } })
  })

  it('parses a bounded realtime sync requirement for REST recovery', () => {
    expect(parseWhiteboardRealtimeEvent({
      event: 'sync.required',
      sequence: 19,
      data: { reason: 'scene_too_large' },
    })).toMatchObject({ event: 'sync.required', sequence: 19, reason: 'scene_too_large' })
  })

  it('keeps the operation id on realtime errors so only that save falls back', () => {
    expect(parseWhiteboardRealtimeEvent({
      event: 'error',
      operation_id: 'operation-failed',
      code: 'invalid_whiteboard_payload',
      error: 'No se pudo aplicar el cambio en tiempo real',
    })).toMatchObject({
      event: 'error',
      operation_id: 'operation-failed',
      code: 'invalid_whiteboard_payload',
    })
  })

  it('preserves member-only comment payloads for board-local reconciliation', () => {
    const thread = { id: 'thread-1', board_id: 'board-1', version: 2 }
    expect(parseWhiteboardRealtimeEvent({
      event: 'comment.changed',
      data: { board_id: 'board-1', action: 'replied', thread },
    })).toMatchObject({
      event: 'comment.changed',
      data: { board_id: 'board-1', action: 'replied', thread },
    })
  })

  it('builds the dedicated-room patch with the exact event envelope', () => {
    expect(buildWhiteboardRealtimePatch({
      sceneSequence: 9,
      operationID: 'operation-2',
      elements: [{ id: 'element-2' }],
      appState: { viewBackgroundColor: '#fff', selectedElementIds: { hidden: true } },
    })).toEqual({
      event: 'scene.patch',
      operation_id: 'operation-2',
      base_sequence: 9,
      elements: [{ id: 'element-2' }],
      app_state: { viewBackgroundColor: '#fff' },
    })
  })

  it('builds bounded ephemeral presence/cursor messages and reconciles collaborators', () => {
    expect(buildWhiteboardPresenceUpdate()).toEqual({ event: 'presence.update', data: { status: 'active' } })
    expect(buildWhiteboardCursorUpdate({
      pointer: { x: Number.POSITIVE_INFINITY, y: -2_000_000, tool: 'laser' },
      button: 'down',
    })).toEqual({
      event: 'cursor.update',
      data: { pointer: { x: 0, y: -1_000_000, tool: 'laser' }, button: 'down' },
    })
    const snapshot = reconcileWhiteboardCollaborators(new Map(), {
      event: 'presence.snapshot',
      data: [{ kind: 'user', id: 'socket-1', display_name: 'Ana', access: 'edit' }],
    })
    const moved = reconcileWhiteboardCollaborators(snapshot, {
      event: 'cursor.update',
      actor: { kind: 'user', id: 'socket-1', display_name: 'Ana', access: 'edit' },
      data: { pointer: { x: 12, y: 8, tool: 'pointer' }, button: 'up' },
    })
    expect(moved.get('socket-1')).toMatchObject({ username: 'Ana', pointer: { x: 12, y: 8 } })
    expect(reconcileWhiteboardCollaborators(moved, {
      event: 'presence.update',
      actor: { kind: 'user', id: 'socket-1', display_name: 'Ana', access: 'edit' },
      data: { status: 'left' },
    }).size).toBe(0)
  })

  it('builds and parses bounded presentation transport events', () => {
    expect(buildWhiteboardFollowChange('presenter-1', 'FOLLOW')).toEqual({
      event: 'follow.change', data: { target_actor_id: 'presenter-1', action: 'FOLLOW' },
    })
    expect(buildWhiteboardFollowChange('', 'FOLLOW')).toBeNull()
    expect(buildWhiteboardViewportUpdate([0, 0, 120, 80])).toEqual({
      event: 'viewport.update', data: { bounds: [0, 0, 120, 80] },
    })
    expect(buildWhiteboardViewportUpdate([0, 0, 0, 80])).toBeNull()
    expect(parseWhiteboardRealtimeEvent({
      event: 'presentation.snapshot',
      data: { presentation: { presentation_id: 'p-1' } },
    })).toMatchObject({ event: 'presentation.snapshot', data: { presentation: { presentation_id: 'p-1' } } })
    expect(parseWhiteboardRealtimeEvent({ event: 'room.ready', actor: { id: 'self-1', display_name: 'Ana' } }))
      .toMatchObject({ event: 'room.ready', actor: { id: 'self-1' } })
  })

  it('diffs by id/version/versionNonce, keeps tombstones and snapshots deltas over 2000 elements', () => {
    const acknowledged = [
      { id: 'same', version: 2, versionNonce: 10, isDeleted: false, x: 1 },
      { id: 'deleted', version: 1, versionNonce: 20, isDeleted: false },
    ]
    const current = [
      { id: 'same', version: 2, versionNonce: 10, isDeleted: false, x: 999 },
      { id: 'deleted', version: 2, versionNonce: 21, isDeleted: true },
    ]
    expect(buildWhiteboardSceneWritePlan(current, acknowledged)).toEqual({
      kind: 'patch',
      elements: [{ id: 'deleted', version: 2, versionNonce: 21, isDeleted: true }],
    })

    const largeDelta = Array.from({ length: 2001 }, (_, index) => ({ id: `element-${index}`, version: 1, versionNonce: index }))
    expect(buildWhiteboardSceneWritePlan(largeDelta, [])).toEqual({ kind: 'snapshot', elements: [] })
    expect(whiteboardSceneSaveMethod(buildWhiteboardSavePayload({
      sceneSequence: 1,
      operationID: 'large-snapshot',
      reason: 'autosave',
      elements: largeDelta,
      appState: {},
      includePatch: false,
    }))).toBe('PUT')
  })

  it('detects freedraw variability patches through element version metadata', () => {
    const acknowledged = {
      id: 'freedraw-pressure',
      type: 'freedraw',
      version: 4,
      versionNonce: 40,
      isDeleted: false,
      points: [[0, 0], [10, 5]],
      pressures: [0.2, 0.8],
      simulatePressure: false,
      strokeOptions: { variability: 'constant', streamline: 0.5 },
    }
    const sameRevision = {
      ...acknowledged,
      strokeOptions: { variability: 'variable', streamline: 0.5 },
    }
    expect(hasWhiteboardDocumentMutation({
      currentElements: [sameRevision],
      previousElements: [acknowledged],
      currentAppState: {},
      previousAppState: {},
    })).toBe(false)

    const changed = {
      ...sameRevision,
      version: 5,
      versionNonce: 41,
    }
    expect(hasWhiteboardDocumentMutation({
      currentElements: [changed],
      previousElements: [acknowledged],
      currentAppState: {},
      previousAppState: {},
    })).toBe(true)
    expect(buildWhiteboardSceneWritePlan([changed], [acknowledged])).toEqual({
      kind: 'patch',
      elements: [changed],
    })
  })

  it('closes patches over bound text, containers, arrows and frames even without a container version bump', () => {
    const acknowledged = [
      { id: 'frame', type: 'frame', version: 1, versionNonce: 1, boundElements: null },
      { id: 'diamond', type: 'diamond', version: 1, versionNonce: 2, frameId: 'frame', boundElements: [] },
      { id: 'label', type: 'text', version: 1, versionNonce: 3, containerId: 'diamond' },
      { id: 'arrow', type: 'arrow', version: 1, versionNonce: 4, startBinding: { elementId: 'diamond' } },
    ]
    const current = [
      acknowledged[0],
      { ...acknowledged[1], boundElements: [{ id: 'label', type: 'text' }, { id: 'arrow', type: 'arrow' }] },
      { ...acknowledged[2], version: 2, versionNonce: 30 },
      acknowledged[3],
    ]

    expect(buildWhiteboardSceneWritePlan(current, acknowledged)).toEqual({
      kind: 'patch',
      elements: current,
    })
    expect(closeWhiteboardElementPatch(current, [current[2]])).toEqual(current)
  })

  it('preserves a later relationship-only edit while applying a canonical ACK', () => {
    const captured = [
      { id: 'diamond', version: 3, versionNonce: 10, boundElements: [] },
      { id: 'label', version: 2, versionNonce: 11, containerId: null },
    ]
    const current = [
      { ...captured[0], boundElements: [{ id: 'label', type: 'text' }] },
      { ...captured[1], containerId: 'diamond' },
    ]
    const reconciled = reconcileWhiteboardCanonicalAck({
      canonicalElements: captured,
      capturedElements: captured,
      currentElements: current,
    })
    expect(reconciled.elements).toEqual(current)
    expect(reconciled.laterLocalChanges).toEqual(current)
  })

  it('never resumes a different guest cookie when opening a new link with a fragment secret', () => {
    expect(buildWhiteboardGuestBootstrap('link-b', true)).toEqual({ kind: 'exchange' })
    expect(buildWhiteboardGuestBootstrap('link-b', false)).toEqual({
      kind: 'resume',
      path: '/api/whiteboard-guest/scene?link_id=link-b',
    })
    expect(whiteboardRoomSocketPath('board/one', 'ticket+one')).toBe('/ws/whiteboards/board%2Fone?ticket=ticket%2Bone')
  })

  it('writes access with the exact optimistic policy revision', () => {
    expect(buildWhiteboardAccessUpdate({
      board_id: 'board-1',
      access_mode: 'private',
      access_revision: 7,
      effective_access: base.effective_access,
      grants: [{ id: 'grant-1', user_id: 'user-1', access_level: 'edit', can_manage_access: false }],
    }, 'account')).toEqual({
      access_mode: 'account',
      expected_access_revision: 7,
      grants: [{ user_id: 'user-1', access_level: 'edit' }],
    })
  })

  it('preserves comment-only access for authenticated members', () => {
    expect(buildWhiteboardAccessUpdate({
      board_id: 'board-1',
      access_mode: 'private',
      access_revision: 4,
      effective_access: { ...base.effective_access, level: 'manage', can_comment: true },
      grants: [{ id: 'grant-1', user_id: 'user-1', access_level: 'comment', can_manage_access: false }],
    }, 'private')).toEqual({
      access_mode: 'private',
      expected_access_revision: 4,
      grants: [{ user_id: 'user-1', access_level: 'comment' }],
    })
  })

  it('keeps comment-only members in scene view mode while enabling comment mutations', () => {
    expect(whiteboardEditorAccess({
      level: 'comment',
      can_view: true,
      can_comment: true,
      can_edit: false,
      can_manage_access: false,
    })).toEqual({
      canEdit: false,
      canComment: true,
      viewModeEnabled: true,
    })
    expect(whiteboardEditorAccess({
      level: 'edit',
      can_view: true,
      can_comment: true,
      can_edit: true,
      can_manage_access: false,
    }, '2026-08-15T00:00:00Z')).toEqual({
      canEdit: false,
      canComment: false,
      viewModeEnabled: true,
    })
  })

  it('compares ACL drafts by canonical user and level rather than response metadata', () => {
    const canonical = [{ id: 'one', user_id: 'user-1', access_level: 'edit' as const, can_manage_access: false }]
    expect(sameWhiteboardAccessGrants(canonical, [{ ...canonical[0], id: 'draft', display_name: 'Ana' }])).toBe(true)
    expect(sameWhiteboardAccessGrants(canonical, [{ ...canonical[0], access_level: 'view' }])).toBe(false)
  })

  it('selects the actor private library and combines account catalogues as immutable items', () => {
    const personal = {
      id: 'personal', name: 'Mi biblioteca · user-1', description: '', library_json: { libraryItems: [{ id: 'mine' }] },
      visibility: 'private' as const, version: 2, created_by: 'user-1', created_at: '2026-08-09', updated_at: '2026-08-09',
    }
    const otherPrivate = { ...personal, id: 'other', name: 'Mi biblioteca · user-2', created_by: 'user-2' }
    expect(selectWhiteboardPersonalLibrary([otherPrivate, personal], 'user-1')?.id).toBe('personal')
    expect(parseWhiteboardLibraryItems(JSON.stringify(personal.library_json))).toEqual([{ id: 'mine' }])
    const merged = combineWhiteboardLibraryItems([{ id: 'mine', source: 'personal' }], [
      [{ id: 'shared', source: 'catalog-a' }, { id: 'mine', source: 'catalog-a' }],
      [{ id: 'second', source: 'catalog-b' }],
    ])
    expect(merged.combined.map(item => item.id)).toEqual(['mine', 'shared', 'second'])
    expect(Array.from(merged.readOnlyItemIDs)).toEqual(['shared', 'second'])
    expect(personalWhiteboardLibraryItems(merged.combined, merged.readOnlyItemIDs).map(item => item.id)).toEqual(['mine'])
  })

  it('reconciles a library conflict without overwriting canonical item ids', () => {
    expect(reconcileWhiteboardLibraryConflict(
      [{ id: 'same', value: 'server' }, { id: 'remote', value: 'server' }],
      [{ id: 'same', value: 'local' }, { id: 'local', value: 'local' }],
    )).toEqual([
      { id: 'same', value: 'server' },
      { id: 'remote', value: 'server' },
      { id: 'local', value: 'local' },
    ])
  })

  it('builds an account-scoped member search and bounds client results', () => {
    expect(buildWhiteboardAccountUserSearchPath(' Ana + Ops ')).toBe('/api/account/users?q=Ana+%2B+Ops&limit=50')
    const users = Array.from({ length: 55 }, (_, index) => ({ id: `user-${index}`, display_name: `Ana ${index}`, username: `ana${index}` }))
    expect(filterWhiteboardAccountUsers(users, 'ana', new Set(['user-0']))).toHaveLength(50)
    expect(filterWhiteboardAccountUsers(users, '', new Set())).toEqual([])
  })

  it('removes a board that leaves the active scope and accepts canonical trash state', () => {
    expect(reconcileWhiteboardSummary([base], { ...base, archived_at: '2026-08-09T10:00:00Z' }, 'all')).toEqual([])
    expect(reconcileWhiteboardSummary([], { ...base, archived_at: '2026-08-09T10:00:00Z' }, 'trash')).toHaveLength(1)
    expect(reconcileWhiteboardSummary([base], { ...base, shared: true }, 'mine')).toEqual([])
    expect(reconcileWhiteboardSummary([base], { ...base, shared: false }, 'shared')).toEqual([])
  })

  it('validates import type/size and formats recent updates deterministically', () => {
    expect(validateWhiteboardImport({ name: 'flujo.excalidraw', size: 200, type: 'application/json' })).toBeNull()
    expect(validateWhiteboardImport({ name: 'flujo.svg', size: 200, type: 'image/svg+xml' })).toContain('.excalidraw')
    expect(validateWhiteboardImport({ name: 'flujo.json', size: 26 * 1024 * 1024, type: 'application/json' })).toContain('25 MB')
    expect(formatWhiteboardUpdatedAt('2026-08-09T09:59:30Z', Date.parse('2026-08-09T10:00:00Z'))).toBe('Ahora')
    expect(formatWhiteboardUpdatedAt('2026-08-09T09:40:00Z', Date.parse('2026-08-09T10:00:00Z'))).toBe('Hace 20 min')
    expect(whiteboardPurgeEligibleAt('2026-08-01T00:00:00.000Z', 7)).toBe('2026-08-08T00:00:00.000Z')
    expect(whiteboardPurgeEligibleAt(undefined, 30)).toBeNull()
    expect(buildWhiteboardPurgeRequest('Mapa exacto', 'purge-operation')).toEqual({ confirmation_name: 'Mapa exacto', operation_id: 'purge-operation' })
  })

  it('derives responsive density from the measured module container', () => {
    expect(whiteboardManagerLayout(759)).toBe('narrow')
    expect(whiteboardManagerLayout(760)).toBe('compact')
    expect(whiteboardManagerLayout(1080)).toBe('wide')
  })

  it('defaults the manager to compact view and restores only supported persisted views', () => {
    expect(parseWhiteboardViewMode(null)).toBe('compact')
    expect(parseWhiteboardViewMode(undefined)).toBe('compact')
    expect(parseWhiteboardViewMode('')).toBe('compact')
    expect(parseWhiteboardViewMode('cards')).toBe('compact')
    expect(parseWhiteboardViewMode('grid')).toBe('grid')
    expect(parseWhiteboardViewMode('compact')).toBe('compact')
    expect(parseWhiteboardViewMode('list')).toBe('list')
  })

  it('recovers comments as well as scene when a member queue requires canonical sync', () => {
    expect(whiteboardRealtimeSyncRecoveryPlan('member')).toEqual({ reloadScene: true, reloadComments: true })
    expect(whiteboardRealtimeSyncRecoveryPlan('guest')).toEqual({ reloadScene: true, reloadComments: false })
  })

  it('flattens active folder hierarchy once and contains malformed cycles', () => {
    const access = { level: 'manage' as const, can_view: true, can_edit: true, can_manage_access: true }
    const folders = [
      { id: 'child', name: 'Child', parent_id: 'root', whiteboard_count: 1, version: 1, effective_access: access },
      { id: 'root', name: 'Root', parent_id: null, whiteboard_count: 2, version: 1, effective_access: access },
      { id: 'archived', name: 'Archived', parent_id: null, archived_at: '2026-08-09', whiteboard_count: 0, version: 1, effective_access: access },
      { id: 'cycle-a', name: 'Cycle A', parent_id: 'cycle-b', whiteboard_count: 0, version: 1, effective_access: access },
      { id: 'cycle-b', name: 'Cycle B', parent_id: 'cycle-a', whiteboard_count: 0, version: 1, effective_access: access },
    ]
    expect(flattenWhiteboardFolders(folders).map(row => [row.folder.id, row.depth])).toEqual([
      ['root', 0],
      ['child', 1],
      ['cycle-a', 0],
      ['cycle-b', 0],
    ])
  })

  it('renders the durable folder order before names at every hierarchy level', () => {
    const ordered = flattenWhiteboardFolders([
      { id: 'root-z', name: 'Zeta', parent_id: null, sort_order: 1024, version: 1 },
      { id: 'root-a', name: 'Alfa', parent_id: null, sort_order: 2048, version: 1 },
      { id: 'child-z', name: 'Zeta hija', parent_id: 'root-z', sort_order: -1024, version: 1 },
      { id: 'child-a', name: 'Alfa hija', parent_id: 'root-z', sort_order: 1024, version: 1 },
    ])
    expect(ordered.map(row => row.folder.id)).toEqual(['root-z', 'child-z', 'child-a', 'root-a'])
  })

  it('detects and sanitizes SVG resources before they can reach internal storage', () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><script>alert(1)</script><foreignObject>bad</foreignObject><image href="https://outside.invalid/a.png" onload="alert(2)"/><image href="/api/private.png"/><image href="blob:unsafe"/><path style="fill:url(https://outside.invalid/a)" d="M0 0h1v1z"/></svg>'
    const dataURL = `data:image/svg+xml,${encodeURIComponent(source)}`
    expect(isSvgWhiteboardFile({ id: 'svg', dataURL, mimeType: 'image/svg+xml', created: 1 })).toBe(true)
    expect(decodeSvgDataURL(dataURL)).toBe(source)
    const sanitized = sanitizeWhiteboardSvg(source)
    expect(sanitized).not.toContain('<script')
    expect(sanitized).not.toContain('foreignObject')
    expect(sanitized).not.toContain('outside.invalid')
    expect(sanitized).not.toContain('/api/private.png')
    expect(sanitized).not.toContain('blob:unsafe')
    expect(sanitized).not.toContain('onload')
  })
})
