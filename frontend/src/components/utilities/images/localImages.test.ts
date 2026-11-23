import { describe, expect, it } from 'vitest'
import { encodeImageBase64, inspectImageBytes, MAX_IMAGE_BYTES, readImageBase64 } from './localImages'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const pngBytes = () => Uint8Array.from(atob(PNG), value => value.charCodeAt(0))

describe('local image validation', () => {
  it('preserves all PNG bytes and accepts pasted Base64 and Data URLs', async () => {
    const bytes = pngBytes()
    const signal = new AbortController().signal
    expect(await encodeImageBase64(new Blob([bytes], { type: 'image/png' }), signal)).toBe(`data:image/png;base64,${PNG}`)
    expect(readImageBase64(`${PNG.slice(0, 44)}\r\n${PNG.slice(44)}`)).toEqual(readImageBase64(`data:image/png;base64,${PNG}`))
    expect(readImageBase64(PNG)).toEqual({ bytes, info: { type: 'image/png', width: 1, height: 1 } })
  })

  it('recognizes actual JPEG and WebP dimensions from their headers', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc2, 0, 8, 8, 0, 16, 0, 32, 1, 0xff, 0xd9])
    expect(inspectImageBytes(jpeg)).toEqual({ type: 'image/jpeg', width: 32, height: 16 })

    const webp = new Uint8Array(30)
    const view = new DataView(webp.buffer)
    webp.set([82, 73, 70, 70], 0) // RIFF
    webp.set([87, 69, 66, 80, 86, 80, 56, 88], 8) // WEBPVP8X
    view.setUint32(4, 22, true)
    view.setUint32(16, 10, true)
    webp[24] = 31
    webp[27] = 15
    expect(inspectImageBytes(webp)).toEqual({ type: 'image/webp', width: 32, height: 16 })
  })

  it('rejects mislabeled, oversized, empty, malformed and SVG payloads', () => {
    expect(() => readImageBase64(`data:image/jpeg;base64,${PNG}`)).toThrow('no coincide')
    expect(() => readImageBase64('data:image/svg+xml;base64,PHN2Zz4=')).toThrow('Data URL Base64')
    expect(() => readImageBase64('test===')).toThrow('texto Base64 válido')
    expect(() => readImageBase64('')).toThrow('texto Base64 válido')
    expect(() => inspectImageBytes(new Uint8Array(MAX_IMAGE_BYTES + 1))).toThrow('10 MiB')
    const oversized = pngBytes()
    const view = new DataView(oversized.buffer)
    view.setUint32(16, 4001)
    view.setUint32(20, 4000)
    expect(() => inspectImageBytes(oversized)).toThrow('16 megapíxeles')
    expect(() => inspectImageBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0xff, 0xff]))).toThrow('imagen válida')
  })
})
