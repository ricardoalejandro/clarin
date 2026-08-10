import { describe, expect, it } from 'vitest'
import {
  buildWhiteboardLibraryAssetListPath,
  buildWhiteboardLibraryAssetPath,
  buildWhiteboardLibraryAssetUploadForm,
  collectWhiteboardLibraryAssetPages,
  uploadWhiteboardLibraryAsset,
  WHITEBOARD_LIBRARY_ASSET_MAX_BYTES,
  type WhiteboardLibraryAsset,
} from './whiteboardLibraryAssets'

function asset(id: string, fileID: string): WhiteboardLibraryAsset {
  return {
    id,
    library_id: 'library-1',
    file_id: fileID,
    kind: 'asset',
    filename: `${fileID}.png`,
    content_type: 'image/png',
    media_type: 'image',
    size_bytes: 3,
    created_at: '2026-08-09T10:00:00Z',
  }
}

describe('whiteboard library asset client contract', () => {
  it('encodes library, asset and cursor IDs and keeps the server page bound', () => {
    expect(buildWhiteboardLibraryAssetListPath('library/one', 'cursor/next', true)).toBe(
      '/api/whiteboard-libraries/library%2Fone/assets?limit=200&referenced_only=1&cursor=cursor%2Fnext',
    )
    expect(buildWhiteboardLibraryAssetPath('library/one', 'asset/two')).toBe(
      '/api/whiteboard-libraries/library%2Fone/assets/asset%2Ftwo',
    )
  })

  it('collects cursor pages but exposes only exact requested file IDs', async () => {
    const cursors: Array<string | null> = []
    const result = await collectWhiteboardLibraryAssetPages(async cursor => {
      cursors.push(cursor)
      if (cursor === null) {
        return {
          success: true,
          status: 200,
          data: {
            assets: [asset('orphan', 'not-requested'), asset('first', 'file-a')],
            next_cursor: 'page-2',
          },
        }
      }
      return {
        success: true,
        status: 200,
        data: { assets: [asset('second', 'file-b')], next_cursor: 'unused-page' },
      }
    }, ['file-a', 'file-b'])

    expect(cursors).toEqual([null, 'page-2'])
    expect(result).toEqual({
      success: true,
      status: 200,
      data: {
        success: true,
        assets: [asset('first', 'file-a'), asset('second', 'file-b')],
        next_cursor: null,
      },
    })
  })

  it('rejects repeated cursors instead of returning a partial library manifest', async () => {
    let calls = 0
    const result = await collectWhiteboardLibraryAssetPages(async () => {
      calls += 1
      return {
        success: true,
        status: 200,
        data: { assets: [asset(`asset-${calls}`, `file-${calls}`)], next_cursor: 'same-cursor' },
      }
    })

    expect(calls).toBe(2)
    expect(result.success).toBe(false)
    expect(result.error).toContain('cursor repetido')
    expect(result.data).toBeUndefined()
  })

  it('builds only the multipart fields accepted by the backend', () => {
    const blob = new Blob(['png'], { type: 'image/png' })
    const form = buildWhiteboardLibraryAssetUploadForm({
      fileID: '  library_file-1  ',
      blob,
      filename: 'imagen.png',
    })

    expect(Array.from(form.keys())).toEqual(['file_id', 'file'])
    expect(form.get('file_id')).toBe('library_file-1')
    const file = form.get('file')
    expect(file).toBeInstanceOf(File)
    expect((file as File).name).toBe('imagen.png')
    expect((file as File).size).toBe(3)
  })

  it('rejects invalid IDs, empty files and files over the 10 MiB client bound', () => {
    expect(() => buildWhiteboardLibraryAssetUploadForm({
      fileID: '../escape',
      blob: new Blob(['x']),
      filename: 'x.png',
    })).toThrow(/identificador/i)
    expect(() => buildWhiteboardLibraryAssetUploadForm({
      fileID: 'file-1',
      blob: new Blob([]),
      filename: 'empty.png',
    })).toThrow(/vacío/i)
    expect(() => buildWhiteboardLibraryAssetUploadForm({
      fileID: 'file-1',
      blob: new Blob([new Uint8Array(WHITEBOARD_LIBRARY_ASSET_MAX_BYTES + 1)]),
      filename: 'large.png',
    })).toThrow(/10 MB/i)
  })

  it('honors an already-aborted owner session without starting an upload', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(uploadWhiteboardLibraryAsset('library-1', {
      fileID: 'file-1',
      blob: new Blob(['png'], { type: 'image/png' }),
      filename: 'image.png',
    }, controller.signal)).resolves.toEqual({ success: false, error: 'Solicitud cancelada' })
  })
})
