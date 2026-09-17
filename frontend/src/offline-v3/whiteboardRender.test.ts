import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, webcrypto } from 'node:crypto'
import { assertOfflineWhiteboardSVG, offlineWhiteboardRenderInput } from './whiteboardRender'
import type { OfflineWhiteboard } from './types'

const board: OfflineWhiteboard = { id: 'board', name: 'Private board', version: 1, updated_at: '2026-09-14', editor_version: '0.18.1-clarin.7', scene: { elements: [{ id: 'rect', type: 'rectangle', link: 'https://outside.invalid', isDeleted: false }], appState: { viewBackgroundColor: '#ffffff' } } }
const svg = (children: string) => new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg">${children}</svg>`, 'image/svg+xml').documentElement as unknown as SVGSVGElement
afterEach(() => vi.unstubAllGlobals())

describe('offline whiteboard rendering boundary', () => {
  it.each([
    undefined, '', '0.18.1',
    '0.18.1-clarin.1', '0.18.1-clarin.2', '0.18.1-clarin.3',
    '0.18.1-clarin.4', '0.18.1-clarin.5', '0.18.1-clarin.6', '0.18.1-clarin.7',
  ])('accepts the reviewed editor version %s without rewriting the canonical scene', async (editor_version) => {
    const source = { ...board, editor_version }
    const original = JSON.stringify(source)
    const input = await offlineWhiteboardRenderInput(source)
    expect(input.elements).toEqual([{ ...board.scene!.elements[0] as object, link: null }])
    expect(input.files).toEqual({})
    expect(JSON.stringify(source)).toBe(original)
  })
  it.each([
    '0.18.1-clarin.0', '0.18.1-clarin.8', '0.18.1-clarin.10',
    '0.18.1-clarin.70', '0.18.1-clarin.7-canary', '0.18.1-clarin.7.1',
    '0.18.2', '0.19.0', '0.99.0',
  ])('rejects unreviewed, future or malformed editor version %s', async (editor_version) => {
    await expect(offlineWhiteboardRenderInput({ ...board, editor_version })).rejects.toThrow('lector actualizado')
  })
  it('checks raster bytes against the signed manifest hash and rejects substitution', async () => {
    vi.stubGlobal('crypto', webcrypto)
    const data = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
    const bytes = Buffer.from(data, 'base64')
    const asset = { file_id: 'gif', content_type: 'image/gif', content_hash: createHash('sha256').update(bytes).digest('hex'), data_base64: data, size_bytes: bytes.length }
    const imageBoard = { ...board, scene: { elements: [{ type: 'image', fileId: 'gif' }] }, assets: [asset] }
    const result = await offlineWhiteboardRenderInput(imageBoard)
    expect(result.files.gif.dataURL).toBe(`data:image/gif;base64,${data}`)
    await expect(offlineWhiteboardRenderInput({ ...imageBoard, assets: [{ ...asset, content_hash: 'f'.repeat(64) }] })).rejects.toThrow('integridad')
    await expect(offlineWhiteboardRenderInput({ ...imageBoard, assets: [{ ...asset, size_bytes: bytes.length + 1 }] })).rejects.toThrow('tamaño')
  })
  it('removes navigation only from the ephemeral render copy', async () => {
    const input = await offlineWhiteboardRenderInput(board)
    expect(input.elements[0].link).toBe(null)
    expect((board.scene!.elements[0] as { link: string }).link).toBe('https://outside.invalid')
    expect(input.appState.exportEmbedScene).toBe(false)
    expect(input.files).toEqual({})
  })
  it('rejects missing, extra and unsafe image content rather than showing incomplete data', async () => {
    await expect(offlineWhiteboardRenderInput({ ...board, scene: { elements: [{ type: 'image', fileId: 'missing' }] } })).rejects.toThrow('imágenes descargadas')
    const assets = [{ file_id: 'missing', content_type: 'image/svg+xml', content_hash: 'a'.repeat(64), size_bytes: 4, data_base64: 'PHN2Zz4=' }]
    await expect(offlineWhiteboardRenderInput({ ...board, assets })).rejects.toThrow('manifiesto')
    await expect(offlineWhiteboardRenderInput({ ...board, assets, scene: { elements: [{ type: 'image', fileId: 'missing' }] } })).rejects.toThrow('no es válida')
    await expect(offlineWhiteboardRenderInput({ ...board, editor_version: '0.99.0' })).rejects.toThrow('lector actualizado')
  })
  it('allows inert vectors and embedded fonts, blocks scripts, links, embeds and remote font fallback', () => {
    expect(() => assertOfflineWhiteboardSVG(svg('<defs><style>@font-face{src:url(data:font/woff2;base64,AA==)}</style></defs><rect fill="#ffffff" width="20" height="10"/>'))).not.toThrow()
    for (const content of ['<script/>', '<foreignObject/>', '<a href="https://outside.invalid"/>', '<image href="https://outside.invalid/x.png"/>', '<rect onload="x()"/>', '<style>@font-face{src:url(https://outside.invalid/f.woff2)}</style>', '<rect fill="url(https://outside.invalid/f.svg)"/>']) expect(() => assertOfflineWhiteboardSVG(svg(content))).toThrow()
  })
})
