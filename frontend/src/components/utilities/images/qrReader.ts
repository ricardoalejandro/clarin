import { loadLocalImage, type LocalImage } from './localImages'

export type QrReadRequest = { pixels: Uint8ClampedArray<ArrayBuffer>; width: number; height: number }
export type QrReadResponse = { kind: 'found'; text: string } | { kind: 'missing' | 'failed' }

export async function readLocalQr(source: LocalImage, signal: AbortSignal): Promise<QrReadResponse> {
  const image = await loadLocalImage(source.blob, signal)
  signal.throwIfAborted()
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  let request: QrReadRequest
  try {
    const context = canvas.getContext('2d')
    if (!context) throw new Error('No pudimos preparar la imagen para leer el QR.')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0)
    request = { pixels: context.getImageData(0, 0, canvas.width, canvas.height).data, width: canvas.width, height: canvas.height }
  } finally {
    canvas.width = 0
    canvas.height = 0
    image.removeAttribute('src')
  }

  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./qrReader.worker.ts', import.meta.url))
    const dispose = () => {
      worker.terminate()
      window.clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
    const abort = () => {
      dispose()
      reject(signal.reason)
    }
    const timer = window.setTimeout(() => {
      dispose()
      reject(new Error('La lectura tomó demasiado tiempo. Recorta la imagen alrededor del QR y vuelve a intentarlo.'))
    }, 20_000)
    worker.onmessage = (event: MessageEvent<QrReadResponse>) => {
      dispose()
      if (event.data.kind === 'failed') reject(new Error('No pudimos leer el QR. Prueba con otra imagen.'))
      else resolve(event.data)
    }
    worker.onerror = () => {
      dispose()
      reject(new Error('No pudimos iniciar el lector QR. Vuelve a intentarlo.'))
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      worker.postMessage(request, [request.pixels.buffer])
    } catch (error) {
      dispose()
      reject(error)
    }
  })
}
