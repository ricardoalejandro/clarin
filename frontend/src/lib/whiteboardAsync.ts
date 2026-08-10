export function whiteboardAbortError() {
  return new DOMException('La operación de Pizarras fue cancelada.', 'AbortError')
}

/**
 * Runs bounded async work while preserving source order. Workers stop claiming
 * new items as soon as the owning surface is aborted.
 */
export async function mapWhiteboardConcurrently<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  if (signal?.aborted) throw whiteboardAbortError()
  if (!items.length) return []

  const limit = Math.max(1, Math.min(items.length, Math.floor(concurrency) || 1))
  const results = new Array<R>(items.length)
  let nextIndex = 0

  const run = async () => {
    while (true) {
      if (signal?.aborted) throw whiteboardAbortError()
      const index = nextIndex
      if (index >= items.length) return
      nextIndex += 1
      const result = await worker(items[index], index)
      if (signal?.aborted) throw whiteboardAbortError()
      results[index] = result
    }
  }

  await Promise.all(Array.from({ length: limit }, () => run()))
  return results
}
