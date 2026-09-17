import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'

const frontend = resolve(__dirname, '../frontend')
const frontendRequire = createRequire(resolve(frontend, 'package.json'))
const { build } = frontendRequire('esbuild') as typeof import('../frontend/node_modules/esbuild')
let fixtureScript: string

test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `
        export * from './src/lib/fabric/runtime';
        export { loadTemplateToCanvas } from './src/lib/fabric/serialization';
        export { exportCanvasToBlob } from './src/lib/fabric/export';
      `,
      resolveDir: frontend,
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'ClarinFabricFixture',
    platform: 'browser',
    define: { 'process.env.NODE_ENV': '"production"' },
  })
  fixtureScript = result.outputFiles[0].text
})

test.beforeEach(async ({ page }) => {
  // This fixture has no account data and makes no requests to Clarin or third parties.
  await page.route('**/*', route => route.abort())
  await page.setContent('<style>body{margin:0}</style><canvas id="canvas"></canvas>')
  await page.addScriptTag({ content: fixtureScript })
})

test('Fabric compatibility preserves top-left geometry and real pointer movement', async ({ page }) => {
  const initial = await page.evaluate(async () => {
    const api = (window as any).ClarinFabricFixture
    const canvas = new api.Canvas('canvas', { width: 240, height: 180, enableRetinaScaling: false })
    await api.loadTemplateToCanvas(canvas, {
      version: 3,
      fabricJson: { version: '6.9.1', objects: [{ type: 'Rect', left: 20, top: 30, width: 40, height: 50, fill: '#ff0000', strokeWidth: 0 }] },
    }, 120, 90)
    ;(window as any).fixtureCanvas = canvas
    return canvas.getObjects()[0].getBoundingRect()
  })
  expect(initial).toMatchObject({ left: 20, top: 30, width: 40, height: 50 })
  await page.mouse.move(40, 50)
  await page.mouse.down()
  await page.mouse.move(70, 80, { steps: 4 })
  await page.mouse.up()
  const moved = await page.evaluate(() => {
    const canvas = (window as any).fixtureCanvas
    const rect = canvas.getObjects()[0]
    return { bounds: rect.getBoundingRect(), originX: rect.originX, originY: rect.originY }
  })
  expect(moved).toMatchObject({ bounds: { left: 50, top: 60, width: 40, height: 50 }, originX: 'left', originY: 'top' })
  await page.evaluate(async () => (window as any).fixtureCanvas.dispose())
})

test('Fabric compatibility preserves browser raster output, gradient alpha and PDF export', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const api = (window as any).ClarinFabricFixture
    const canvas = new api.StaticCanvas('canvas', { width: 100, height: 80, enableRetinaScaling: false })
    await canvas.loadFromJSON({
      version: '6.9.1',
      objects: [{
        type: 'Rect', left: 0, top: 0, width: 100, height: 80, strokeWidth: 0,
        fill: { type: 'linear', coords: { x1: 0, y1: 0, x2: 100, y2: 0 }, colorStops: [{ offset: 0, color: 'red', opacity: 0.25 }, { offset: 1, color: 'red', opacity: 0.25 }] },
      }],
    })
    const viewport = [2, 0, 0, 2, 18, 24]
    canvas.setViewportTransform(viewport)
    const png = await api.exportCanvasToBlob(canvas, { format: 'png', multiplier: 1 })
    const bitmap = await createImageBitmap(png)
    const raster = document.createElement('canvas')
    raster.width = bitmap.width
    raster.height = bitmap.height
    const ctx = raster.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0)
    const first = Array.from(ctx.getImageData(2, 2, 1, 1).data)
    const last = Array.from(ctx.getImageData(97, 77, 1, 1).data)
    const dimensions = [bitmap.width, bitmap.height]
    bitmap.close()
    const pdf = await api.exportCanvasToBlob(canvas, { format: 'pdf', multiplier: 1 })
    const header = new TextDecoder().decode((await pdf.arrayBuffer()).slice(0, 5))
    const restored = canvas.viewportTransform.slice()
    await canvas.dispose()
    return { dimensions, first, last, header, restored }
  })
  expect(result.dimensions).toEqual([100, 80])
  for (const pixel of [result.first, result.last]) {
    expect(pixel.slice(0, 3)).toEqual([255, 0, 0])
    expect(pixel[3]).toBeGreaterThanOrEqual(63)
    expect(pixel[3]).toBeLessThanOrEqual(64)
  }
  expect(result.header).toBe('%PDF-')
  expect(result.restored).toEqual([2, 0, 0, 2, 18, 24])
})
