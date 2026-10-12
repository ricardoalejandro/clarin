import { describe, expect, it } from 'vitest'
import { buildWhiteboardSceneWritePlan, closeWhiteboardElementPatch } from './whiteboards'

describe('whiteboard patch closure at scale', () => {
  it('does bounded linear membership work before falling back to a snapshot', () => {
    let idReads = 0
    const count = 3_000
    const elements = Array.from({ length: count }, (_, index) => ({
      get id() { idReads += 1; return `element-${index}` },
      type: 'rectangle', version: 1, versionNonce: index + 1,
    }))
    expect(buildWhiteboardSceneWritePlan(elements, []).kind).toBe('snapshot')
    // Count work instead of asserting machine-dependent milliseconds.
    expect(idReads).toBeLessThan(count * 40)
  })

  it('preserves scene order and both directions of relational closure', () => {
    const frame = { id: 'frame', version: 1, type: 'frame' }
    const box = { id: 'box', version: 1, frameId: 'frame', boundElements: [{ id: 'text' }] }
    const text = { id: 'text', version: 1, containerId: 'box' }
    const unrelated = { id: 'other', version: 1 }
    const external = { id: 'external', version: 2 }
    expect(closeWhiteboardElementPatch([unrelated, frame, box, text], [text, external]))
      .toEqual([frame, box, text, external])
  })
})
