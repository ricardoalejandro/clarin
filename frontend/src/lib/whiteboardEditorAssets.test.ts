import { describe, expect, it } from 'vitest'

import {
  WHITEBOARD_EDITOR_ASSET_PATH,
  whiteboardEditorAssetBase,
} from './whiteboardEditorAssets'

describe('whiteboard editor asset base', () => {
  it('builds an absolute same-origin base for every self-hosted editor asset', () => {
    const base = whiteboardEditorAssetBase('https://clarin.example.invalid/dashboard/whiteboards/board-1')
    expect(base).toBe(`https://clarin.example.invalid${WHITEBOARD_EDITOR_ASSET_PATH}`)
    expect(new URL('fonts/Excalifont/Excalifont-Regular.woff2', base).href).toBe(
      'https://clarin.example.invalid/vendor/whiteboards-editor/0.18.1-clarin.5/fonts/Excalifont/Excalifont-Regular.woff2',
    )
  })

  it('preserves development ports and rejects non-web origins', () => {
    expect(whiteboardEditorAssetBase('http://127.0.0.1:3011')).toBe(
      'http://127.0.0.1:3011/vendor/whiteboards-editor/0.18.1-clarin.5/',
    )
    expect(() => whiteboardEditorAssetBase('file:///tmp/clarin')).toThrow(TypeError)
  })
})
