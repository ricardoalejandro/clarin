import { describe, expect, it, vi } from 'vitest'
import { runWhiteboardWrite, whiteboardWriteTransportAvailable } from './whiteboardOfflineTransport'

describe('whiteboard v5 write transport', () => {
  it('invokes the canonical save while the browser is offline and runtime v5 is active', async () => {
    const saveWhiteboard = vi.fn().mockResolvedValue({ success: true })
    const attempt = await runWhiteboardWrite({ browserOnline: false, runtimeOffline: true, write: saveWhiteboard })
    expect(attempt).toEqual({ attempted: true, result: { success: true } })
    expect(saveWhiteboard).toHaveBeenCalledOnce()
  })

  it('does not attempt an online write when neither transport is available', async () => {
    const saveWhiteboard = vi.fn()
    expect(whiteboardWriteTransportAvailable(false, false)).toBe(false)
    expect(await runWhiteboardWrite({ browserOnline: false, runtimeOffline: false, write: saveWhiteboard })).toEqual({ attempted: false })
    expect(saveWhiteboard).not.toHaveBeenCalled()
  })
})
