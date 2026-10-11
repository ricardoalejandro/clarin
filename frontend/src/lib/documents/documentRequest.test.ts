import { afterEach, expect, it, vi } from 'vitest'
import { DOCUMENT_REQUEST_TIMEOUT_MS, DocumentRequestTimeoutError, withDocumentRequestDeadline } from './documentRequest'
afterEach(() => vi.useRealTimers())
it('bounds an uncooperative transport and aborts its signal at the deadline', async () => {
  vi.useFakeTimers(); let signal!: AbortSignal; let finish!: (value: string) => void
  const pending = withDocumentRequestDeadline(value => { signal = value; return new Promise(resolve => { finish = resolve }) }, new AbortController().signal)
  const rejection = expect(pending).rejects.toBeInstanceOf(DocumentRequestTimeoutError)
  await vi.advanceTimersByTimeAsync(DOCUMENT_REQUEST_TIMEOUT_MS - 1); expect(signal.aborted).toBe(false)
  await vi.advanceTimersByTimeAsync(1); await rejection; expect(signal.aborted).toBe(true)
  finish('late'); await Promise.resolve(); expect(vi.getTimerCount()).toBe(0)
})
it('aborts and settles immediately when the owning session closes', async () => {
  vi.useFakeTimers(); const parent = new AbortController(); let signal!: AbortSignal
  const pending = withDocumentRequestDeadline(value => { signal = value; return new Promise(() => {}) }, parent.signal)
  const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' }); parent.abort(); await rejection
  expect(signal.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0)
})
it('never starts work for a closed session and clears successful timers', async () => {
  vi.useFakeTimers(); const parent = new AbortController(); parent.abort(); const work = vi.fn(async () => 4)
  await expect(withDocumentRequestDeadline(work, parent.signal)).rejects.toMatchObject({ name: 'AbortError' }); expect(work).not.toHaveBeenCalled()
  await expect(withDocumentRequestDeadline(work, new AbortController().signal)).resolves.toBe(4); expect(vi.getTimerCount()).toBe(0)
})
