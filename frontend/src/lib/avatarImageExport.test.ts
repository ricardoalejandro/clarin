import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeAvatarCanvas } from './avatarImageExport'

describe('avatar canvas encoding', () => {
  afterEach(() => vi.useRealTimers())
  it('returns JPEG bytes and preserves null/exception as recoverable failures', async () => {
    const blob = new Blob(['jpeg'], { type: 'image/jpeg' })
    await expect(encodeAvatarCanvas({ toBlob: (callback: BlobCallback) => callback(blob) } as HTMLCanvasElement, .86)).resolves.toBe(blob)
    await expect(encodeAvatarCanvas({ toBlob: (callback: BlobCallback) => callback(null) } as HTMLCanvasElement, .86)).rejects.toThrow('Vuelve a intentarlo')
    await expect(encodeAvatarCanvas({ toBlob: () => { throw new Error('security') } } as unknown as HTMLCanvasElement, .86)).rejects.toThrow('Vuelve a seleccionarla')
  })
  it('settles timeout and ignores late canvas completion', async () => {
    vi.useFakeTimers()
    let callback: BlobCallback = () => {}
    const promise = encodeAvatarCanvas({ toBlob: (value: BlobCallback) => { callback = value } } as HTMLCanvasElement, .86)
    const assertion = expect(promise).rejects.toThrow('tardó demasiado')
    await vi.advanceTimersByTimeAsync(10000)
    await assertion
    callback(new Blob(['late']))
    expect(vi.getTimerCount()).toBe(0)
  })
  it('aborts when the contact or account changes', async () => {
    const controller = new AbortController()
    const promise = encodeAvatarCanvas({ toBlob: () => {} } as unknown as HTMLCanvasElement, .86, controller.signal)
    controller.abort()
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
  })
})
