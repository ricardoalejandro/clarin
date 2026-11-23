import QRCode from 'qrcode'
import { expect, it, vi } from 'vitest'
import type { QrReadRequest, QrReadResponse } from './qrReader'

it('decodes generated Unicode QR pixels and reports an image without a QR', async () => {
  const worker = { onmessage: null as ((event: { data: QrReadRequest }) => void) | null, postMessage: vi.fn<(message: QrReadResponse) => void>() }
  vi.stubGlobal('self', worker)
  try {
    await import('./qrReader.worker')
    const text = 'Clarin: información y ñ'
    const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' })
    const scale = 5
    const margin = 4 * scale
    const side = modules.size * scale + 2 * margin
    const pixels = new Uint8ClampedArray(side * side * 4).fill(255)
    for (let y = margin; y < side - margin; y += 1) {
      for (let x = margin; x < side - margin; x += 1) {
        if (!modules.get(Math.floor((y - margin) / scale), Math.floor((x - margin) / scale))) continue
        const offset = (y * side + x) * 4
        pixels.fill(0, offset, offset + 3)
      }
    }
    worker.onmessage?.({ data: { pixels, width: side, height: side } })
    expect(worker.postMessage).toHaveBeenLastCalledWith({ kind: 'found', text })
    pixels.fill(255)
    worker.onmessage?.({ data: { pixels, width: side, height: side } })
    expect(worker.postMessage).toHaveBeenLastCalledWith({ kind: 'missing' })
  } finally {
    vi.unstubAllGlobals()
  }
})
