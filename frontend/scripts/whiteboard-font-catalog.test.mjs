import assert from 'node:assert/strict'
import test from 'node:test'
import { loadWhiteboardFontCatalog, runtimeWhiteboardFontCatalog, verifyWhiteboardFontCatalog } from './whiteboard-font-catalog.mjs'

test('verifies the immutable 32-font catalog, local files, hashes and licenses', async () => {
  const { catalog, root } = await loadWhiteboardFontCatalog()
  const result = await verifyWhiteboardFontCatalog(catalog, root)
  assert.deepEqual(result, { customFonts: 25, fontFaces: 49, totalSelectableFonts: 32 })
  const runtime = runtimeWhiteboardFontCatalog(catalog)
  assert.equal(runtime[0].id, 10001)
  assert.equal(runtime.at(-1).id, 10025)
  assert.equal(runtime.some(entry => JSON.stringify(entry).includes('googleapis.com')), false)
  assert.equal(runtime.some(entry => JSON.stringify(entry).includes('gstatic.com')), false)
})

test('fails closed when a reserved ID is recycled', async () => {
  const { catalog, root } = await loadWhiteboardFontCatalog()
  const tampered = structuredClone(catalog)
  tampered.entries[1].id = 10001
  await assert.rejects(() => verifyWhiteboardFontCatalog(tampered, root), /ID\/familia\/categoría reservados/u)
})
