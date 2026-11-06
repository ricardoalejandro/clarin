import jsQR from 'jsqr'
import type { QrReadRequest, QrReadResponse } from './qrReader'

const worker = self as unknown as {
  onmessage: ((event: MessageEvent<QrReadRequest>) => void) | null
  postMessage(message: QrReadResponse): void
}

worker.onmessage = ({ data }) => {
  try {
    const result = jsQR(data.pixels, data.width, data.height, { inversionAttempts: 'attemptBoth' })
    worker.postMessage(result ? { kind: 'found', text: result.data } : { kind: 'missing' })
  } catch {
    worker.postMessage({ kind: 'failed' })
  }
}
