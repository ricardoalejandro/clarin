export const DOCUMENT_REQUEST_TIMEOUT_MS = 30_000
export class DocumentRequestTimeoutError extends Error {
  constructor() { super('No se pudo confirmar la operación en 30 segundos. Revisa el estado antes de volver a intentarlo.'); this.name = 'DocumentRequestTimeoutError' }
}
/** Bounds even transports that ignore AbortSignal; late completions cannot continue a session. */
export async function withDocumentRequestDeadline<T>(work: (signal: AbortSignal) => Promise<T>, parent: AbortSignal): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let abortParent = () => {}
  const interrupted = new Promise<never>((_, reject) => {
    abortParent = () => { controller.abort(); reject(new DOMException('La operación fue cancelada.', 'AbortError')) }
    if (parent.aborted) { abortParent(); return }
    parent.addEventListener('abort', abortParent, { once: true })
    timer = setTimeout(() => { controller.abort(); reject(new DocumentRequestTimeoutError()) }, DOCUMENT_REQUEST_TIMEOUT_MS)
  })
  try {
    return await Promise.race([interrupted, controller.signal.aborted ? Promise.reject(new DOMException('La operación fue cancelada.', 'AbortError')) : work(controller.signal)])
  } finally {
    if (timer) clearTimeout(timer)
    parent.removeEventListener('abort', abortParent)
  }
}
