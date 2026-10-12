import { describe, expect, it } from 'vitest'
import { applyWhiteboardProgrammaticScene, captureWhiteboardScene, observeWhiteboardScene, whiteboardMissingAssetIDs } from './whiteboardSaveState'
import { buildWhiteboardSavePayload, planWhiteboardAssetPersistence, retainWhiteboardPendingSave } from './whiteboards'

function image(id: string) {
  return { id, type: 'image', fileId: id, version: 1, versionNonce: 1, isDeleted: false, points: [[0, 0]] }
}

function scene(elements = [image('a')]) {
  return { elements, appState: { viewBackgroundColor: '#ffffff' }, files: { a: { id: 'a', dataURL: 'data:image/png;base64,a' } } }
}

describe('whiteboard save capture and observation', () => {
  it('observes a gesture immediately after a canonical update, before any animation frame', () => {
    const latest = { current: scene() }
    const canonical = scene()
    const emitted: boolean[] = []
    applyWhiteboardProgrammaticScene(latest, canonical, () => {
      emitted.push(observeWhiteboardScene(latest, canonical))
      emitted.push(observeWhiteboardScene(latest, scene([{ ...image('a'), version: 2, versionNonce: 2 }])))
    })
    expect(emitted).toEqual([false, true])
    expect(observeWhiteboardScene(latest, latest.current)).toBe(false)
  })

  it('does not confuse a hydrated file with a gesture arriving in the same frame', () => {
    const latest = { current: scene() }
    const hydrated = { ...latest.current, files: { a: { id: 'a', dataURL: 'data:image/png;base64,hydrated' } } }
    applyWhiteboardProgrammaticScene(latest, hydrated, () => {
      expect(observeWhiteboardScene(latest, hydrated)).toBe(false)
    })
    expect(observeWhiteboardScene(latest, { ...hydrated, elements: [{ ...image('a'), version: 2 }] })).toBe(true)
  })

  it('keeps the prepared scene immutable when a second image or gesture arrives during upload', async () => {
    const live = scene()
    const captured = captureWhiteboardScene(live)
    let completeUpload!: () => void
    const uploaded: string[] = []
    const upload = new Promise<void>(resolve => { completeUpload = resolve })
    const preparation = (async () => {
      uploaded.push(...planWhiteboardAssetPersistence(captured.elements, captured.files, new Set()).uploadFileIDs)
      await upload
      return buildWhiteboardSavePayload({ sceneSequence: 3, operationID: 'write-a', reason: 'autosave', ...captured })
    })()
    live.elements[0].points[0][0] = 99
    live.elements[0].version = 2
    live.elements.push(image('b'))
    live.appState.viewBackgroundColor = '#000000'
    completeUpload()
    const payload = await preparation
    expect(uploaded).toEqual(['a'])
    expect(payload.scene.elements).toHaveLength(1)
    expect(payload.scene.elements[0]).toMatchObject({ version: 1, points: [[0, 0]] })
    expect(payload.scene.appState.viewBackgroundColor).toBe('#ffffff')
    expect(live.elements).toHaveLength(2)
  })

  it('re-uploads an undone image after the canonical deletion removes its asset link', () => {
    const local = scene()
    const afterDeletion = planWhiteboardAssetPersistence([{ ...image('a'), isDeleted: true }], local.files, new Set(['a']))
    const canonicalFileIDs = new Set(afterDeletion.referencedFileIDs)
    expect(planWhiteboardAssetPersistence(local.elements, local.files, canonicalFileIDs).uploadFileIDs).toEqual(['a'])
  })

  it('does not infer that a locally inserted image was persisted by an earlier ACK', () => {
    const canonical = scene()
    const local = { ...scene([image('a'), image('b')]), files: { ...scene().files, b: { id: 'b', dataURL: 'data:image/png;base64,b' } } }
    const canonicalFileIDs = new Set(planWhiteboardAssetPersistence(canonical.elements, canonical.files, new Set()).referencedFileIDs)
    expect(planWhiteboardAssetPersistence(local.elements, local.files, canonicalFileIDs).uploadFileIDs).toEqual(['b'])
  })

  it('requires a specific uncommitted rejection before invalidating asset knowledge', () => {
    expect(whiteboardMissingAssetIDs('whiteboard_assets_missing', ['a', 'a', '', 12, 'b'])).toEqual(['a', 'b'])
    expect(whiteboardMissingAssetIDs('whiteboard_internal_error', ['a'])).toEqual([])
    expect(whiteboardMissingAssetIDs(undefined, ['a'])).toEqual([])
    const pending = { operationID: 'same-id', payload: captureWhiteboardScene(scene()) }
    expect(retainWhiteboardPendingSave(pending, () => { throw new Error('must not replace unknown outcome') })).toBe(pending)
  })
})
