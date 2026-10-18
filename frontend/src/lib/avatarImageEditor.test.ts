import { afterEach, describe, expect, it, vi } from 'vitest'
import { avatarImageDimensions, exportCompactAvatar, validateProgramAvatarFile } from './avatarImageEditor'

function png(width: number, height: number) {
  const bytes = new Uint8Array(24)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82])
  const view = new DataView(bytes.buffer); view.setUint32(16, width); view.setUint32(20, height)
  return bytes
}
function file(bytes: Uint8Array, type = 'image/png') {
  return { type, size: bytes.length, arrayBuffer: async () => bytes.buffer } as File
}

describe('Program avatar source safety and output', () => {
  afterEach(() => vi.restoreAllMocks())
  it('reads PNG and baseline/progressive JPEG dimensions before decoding', () => {
    expect(avatarImageDimensions(png(5000, 8000), 'image/png')).toEqual({ width: 5000, height: 8000 })
    for (const marker of [0xc0, 0xc2]) {
      expect(avatarImageDimensions(new Uint8Array([255, 216, 255, marker, 0, 7, 8, 1, 224, 2, 128, 255, 217]), 'image/jpeg')).toEqual({ width: 640, height: 480 })
    }
    expect(() => avatarImageDimensions(png(100, 100), 'image/jpeg')).toThrow('válido')
    expect(() => avatarImageDimensions(new Uint8Array([255, 216, 255, 192, 255, 255]), 'image/jpeg')).toThrow('válido')
  })
  it('accepts exactly 40 MP and rejects larger images, zero dimensions, unsupported types and oversize before reading', async () => {
    await expect(validateProgramAvatarFile(file(png(5000, 8000)))).resolves.toEqual({ width: 5000, height: 8000 })
    await expect(validateProgramAvatarFile(file(png(5001, 8000)))).rejects.toThrow('40 megapíxeles')
    await expect(validateProgramAvatarFile(file(png(0, 8000)))).rejects.toThrow('40 megapíxeles')
    const read = vi.fn()
    await expect(validateProgramAvatarFile({ type: 'image/png', size: 20 * 1024 * 1024 + 1, arrayBuffer: read } as unknown as File)).rejects.toThrow('20 MiB')
    await expect(validateProgramAvatarFile({ type: 'image/svg+xml', size: 30, arrayBuffer: read } as unknown as File)).rejects.toThrow('JPEG o PNG')
    expect(read).not.toHaveBeenCalled()
  })
  it('reduces JPEG quality until the actual encoded bytes fit and rejects an unreducible output', async () => {
    const small = new Blob(['ok'], { type: 'image/jpeg' })
    const large = new Blob([new Uint8Array(250 * 1024 + 1)], { type: 'image/jpeg' })
    const toBlob = vi.fn().mockImplementationOnce((callback: BlobCallback) => callback(large)).mockImplementation((callback: BlobCallback) => callback(small))
    await expect(exportCompactAvatar({ toBlob } as unknown as HTMLCanvasElement)).resolves.toBe(small)
    expect(toBlob.mock.calls.map(call => call.slice(1))).toEqual([['image/jpeg', .86], ['image/jpeg', .82]])
    toBlob.mockImplementation((callback: BlobCallback) => callback(large))
    await expect(exportCompactAvatar({ toBlob } as unknown as HTMLCanvasElement)).rejects.toThrow('250 KiB')
  })
})
