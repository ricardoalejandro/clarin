import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test, expect, type BrowserContext, type Page, type WebSocketRoute } from '@playwright/test'

// Real editor and browser gestures; HTTP/WebSocket/storage are deterministic mocks.
const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3011'
const boardID = '10000000-0000-4000-8000-000000000901'
const linkID = 'save-races-qa'
type Element = Record<string, any>
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value))
class SaveHarness {
  elements: Element[] = []
  sequence = 0
  holdNextAck = false
  releaseAck: (() => void) | null = null
  failUpload = false
  uploads = 0
  writes: Array<{ operationID: string; elements: Element[] }> = []
  blocked: string[] = []
  private readonly sockets = new Set<WebSocketRoute>()
  private readonly operations = new Map<string, number>()
  sceneRecord() {
    return { board_id: boardID, sequence: this.sequence, editor_version: '0.18.1-clarin.8', scene_schema_version: 'excalidraw', updated_at: '2026-10-12T00:00:00Z',
      scene: { type: 'excalidraw', version: 2, source: 'clarin', elements: clone(this.elements), appState: { viewBackgroundColor: '#ffffff' }, files: {} } }
  }
  commit(operationID: string, elements: Element[]) {
    this.writes.push({ operationID, elements: clone(elements) })
    if (this.operations.has(operationID)) return this.operations.get(operationID)!
    const canonical = new Map(this.elements.map(element => [element.id, element]))
    for (const element of elements) {
      const previous = canonical.get(element.id)
      if (!previous || element.version >= previous.version) canonical.set(element.id, clone(element))
    }
    this.elements = [...canonical.values()]
    this.operations.set(operationID, ++this.sequence)
    return this.sequence
  }
  async install(context: BrowserContext, name: string, realtime = true) {
    await context.routeWebSocket(/\/ws(?:\/whiteboards\/[^?]+)?(?:\?.*)?$/, socket => {
      this.sockets.add(socket)
      socket.onClose(() => this.sockets.delete(socket))
      socket.onMessage(raw => {
        const message = JSON.parse(String(raw))
        if (message.event === 'sync.request') {
          socket.send(JSON.stringify({ event: 'ack', sequence: this.sequence }))
          socket.send(JSON.stringify({ event: 'room.ready', actor: { kind: 'guest', id: name, display_name: name, access: 'edit' }, data: { actor_id: name } }))
          return
        }
        if (message.event !== 'scene.patch') return
        const sequence = this.commit(message.operation_id, message.elements)
        for (const peer of this.sockets) if (peer !== socket) peer.send(JSON.stringify({ event: 'scene.patch', sequence, operation_id: message.operation_id, data: { elements: message.elements, app_state: message.app_state || {} } }))
        const ack = JSON.stringify({ event: 'ack', sequence, operation_id: message.operation_id, data: { scene: this.sceneRecord().scene } })
        if (this.holdNextAck) { this.holdNextAck = false; this.releaseAck = () => socket.send(ack) }
        else socket.send(ack)
      })
    })
    await context.route('**/*', async route => {
      const request = route.request()
      const url = new URL(request.url())
      if (url.origin !== new URL(baseURL).origin) { this.blocked.push(url.href); await route.abort(); return }
      if (!url.pathname.startsWith('/api/')) {
        if (request.resourceType() === 'document' && process.env.PLAYWRIGHT_LOCAL_SERVER === '1') {
          const response = await route.fetch(); const headers = response.headers()
          if (headers['content-security-policy']) headers['content-security-policy'] = headers['content-security-policy'].replace("script-src 'self' 'unsafe-inline'", "script-src 'self' 'unsafe-inline' 'unsafe-eval'")
          await route.fulfill({ response, headers }); return
        }
        await route.continue(); return
      }
      const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
      if (url.pathname === '/api/whiteboard-guest/scene') {
        if (request.method() !== 'GET') {
          const payload = request.postDataJSON()
          this.commit(payload.operation_id, payload.patch?.elements || payload.scene.elements)
          await json({ success: true, result: { scene: this.sceneRecord() } }); return
        }
        await json({ success: true, session: { id: name, display_name: name, access_level: 'edit', expires_at: '2030-01-01T00:00:00Z' }, scene: this.sceneRecord(), allow_export: true }); return
      }
      if (url.pathname === '/api/whiteboard-guest/collab-ticket') { await json(realtime ? { success: true, ticket: name } : { error: 'Simulated unavailable room' }, realtime ? 201 : 503); return }
      if (url.pathname === '/api/whiteboard-guest/assets' && request.method() === 'POST') {
        this.uploads += 1
        if (this.failUpload) { this.failUpload = false; await json({ error: 'Subida simulada interrumpida' }, 500); return }
        const fileID = /name="file_id"\r\n\r\n([^\r]+)/.exec(request.postDataBuffer()?.toString('utf8') || '')?.[1]
        await json({ success: true, asset: { id: 'asset-qa', board_id: boardID, file_id: fileID, content_type: 'image/png', kind: 'scene', filename: 'qa.png', size_bytes: 100 } }, 201); return
      }
      if (url.pathname.startsWith('/api/whiteboard-guest/assets')) { await json({ success: true, assets: [], next_cursor: null }); return }
      await json({ success: true })
    })
  }
}
async function open(page: Page) {
  await page.goto(`${baseURL}/shared/whiteboards/${linkID}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('Pizarra compartida', { exact: true })).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('canvas.interactive')).toBeVisible({ timeout: 60_000 })
}
async function draw(page: Page, offset: number) {
  await page.getByTestId('toolbar-rectangle').check({ force: true })
  const bounds = (await page.locator('canvas.interactive').boundingBox())!
  const x = bounds.x + bounds.width * .48 + offset
  const y = bounds.y + bounds.height * .45 + offset
  await page.mouse.move(x, y); await page.mouse.down()
  await page.mouse.move(x + 65, y + 40, { steps: 4 }); await page.mouse.up()
}
async function exportedIDs(page: Page) {
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Exportar copia editable' }).click()
  const path = await (await download).path()
  const scene = JSON.parse(readFileSync(path!, 'utf8'))
  return scene.elements.filter((element: Element) => !element.isDeleted).map((element: Element) => element.id).sort()
}

test.describe('guardado en navegador con transporte simulado', () => {
  test.skip(({ browserName }) => browserName !== 'chromium')
  for (const sessions of [1, 2]) test(`ráfaga en ${sessions} sesión(es), ACK intercalado y reapertura`, async ({ browser }) => {
    test.setTimeout(150_000)
    const harness = new SaveHarness()
    const contexts: BrowserContext[] = []
    const pages: Page[] = []
    const errors: string[] = []
    try {
      for (let i = 0; i < sessions; i++) {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' })
        contexts.push(context); await harness.install(context, `Persona ${i}`)
        const page = await context.newPage(); pages.push(page)
        page.on('pageerror', error => errors.push(error.message)); await open(page)
      }
      harness.holdNextAck = true
      await draw(pages[0], 0)
      await expect.poll(() => Boolean(harness.releaseAck), { timeout: 20_000 }).toBe(true)
      await draw(pages[0], 22)
      if (sessions === 2) await draw(pages[1], 88)
      harness.releaseAck!()
      await Promise.all(pages.map(async (page, i) => { for (let n = 0; n < 3; n++) await draw(page, 44 + i * 100 + n * 16) }))
      const expected = sessions === 1 ? 5 : 9
      await expect.poll(() => harness.elements.filter(element => !element.isDeleted).length, { timeout: 30_000 }).toBe(expected)
      for (const page of pages) await expect(page.getByLabel('Guardado en Clarin')).toBeVisible({ timeout: 30_000 })
      const canonicalIDs = harness.elements.filter(element => !element.isDeleted).map(element => element.id).sort()
      for (const page of pages) {
        expect(await exportedIDs(page)).toEqual(canonicalIDs)
        await page.reload({ waitUntil: 'domcontentloaded' })
        await expect(page.locator('canvas.interactive')).toBeVisible({ timeout: 60_000 })
        expect(await exportedIDs(page)).toEqual(canonicalIDs)
      }
      expect(errors).toEqual([]); expect(harness.blocked).toEqual([])
    } finally { await Promise.all(contexts.map(context => context.close())) }
  })
  test('imagen con subida fallida conserva el lienzo y reintenta sin duplicar', async ({ browser }) => {
    test.setTimeout(120_000)
    const harness = new SaveHarness(); harness.failUpload = true
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' })
    await harness.install(context, 'Imagen QA', false)
    const page = await context.newPage()
    try {
      await open(page)
      const fixture = JSON.parse(readFileSync(resolve('.codex/skills/clarin-excalidraw-development/assets/compat-fixtures/v0.18.1/image-import.excalidraw'), 'utf8'))
      const dataURL = fixture.files[fixture.elements[0].fileId].dataURL as string
      const bytes = Array.from(Buffer.from(dataURL.split(',')[1], 'base64'))
      await page.keyboard.press('Escape')
      await page.keyboard.press('1')
      const canvas = (await page.locator('canvas.interactive').boundingBox())!
      await page.mouse.move(canvas.x + canvas.width * .55, canvas.y + canvas.height * .55)
      await page.mouse.click(canvas.x + canvas.width * .55, canvas.y + canvas.height * .55)
      await page.evaluate(bytes => { const data = new DataTransfer(); data.items.add(new File([new Uint8Array(bytes)], 'qa.png', { type: 'image/png' })); document.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })) }, bytes)
      await expect.poll(() => harness.uploads, { timeout: 20_000, message: 'Pasted image reaches the simulated upload' }).toBe(1)
      await expect(page.getByText('Subida simulada interrumpida')).toBeVisible({ timeout: 20_000 })
      // Excalidraw can persist its pending placeholder before resolving image bytes.
      // The failed binary must never be referenced by the canonical scene.
      expect(harness.elements.every(element => !element.fileId)).toBe(true)
      const localIDs = await exportedIDs(page); expect(localIDs).toHaveLength(1)
      await page.getByRole('button', { name: 'Guardar ahora' }).click()
      await expect(page.getByLabel('Guardado en Clarin')).toBeVisible({ timeout: 30_000 })
      expect(harness.uploads).toBe(2)
      expect(harness.elements.map(element => element.id)).toEqual(localIDs)
      expect(await exportedIDs(page)).toEqual(localIDs)
    } finally { await context.close() }
  })
})
