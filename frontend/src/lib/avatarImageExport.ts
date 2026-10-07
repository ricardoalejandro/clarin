/** Canvas encoding must settle so an editor can retry after browser failures. */
export function encodeAvatarCanvas(canvas: HTMLCanvasElement, quality: number, signal?: AbortSignal): Promise<Blob> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (blob?: Blob | null, error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (error || !blob) reject(error || new Error('No se pudo preparar la imagen. Vuelve a intentarlo.'))
      else resolve(blob)
    }
    const abort = () => finish(null, new DOMException('Cancelado', 'AbortError'))
    const timer = setTimeout(() => finish(null, new Error('La imagen tardó demasiado en prepararse. Vuelve a intentarlo.')), 10000)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) { abort(); return }
    try { canvas.toBlob(blob => finish(blob), 'image/jpeg', quality) }
    catch { finish(null, new Error('No se pudo preparar la imagen. Vuelve a seleccionarla.')) }
  })
}
