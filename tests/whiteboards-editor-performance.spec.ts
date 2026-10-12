import { readFileSync, writeFileSync } from 'node:fs'
import { test, expect } from '@playwright/test'

// Opt-in measurement of the real guest editor, not a pure scene helper.
// Run alone, after the production QA server is ready:
// CLARIN_WHITEBOARD_PERF=1 PLAYWRIGHT_BASE_URL=http://localhost:3011 npx playwright test tests/whiteboards-editor-performance.spec.ts --project=chromium --workers=1 --output=/tmp/clarin-wb-editor-perf
const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3011'
const boardID = '10000000-0000-4000-8000-000000000950'

function elementsFor(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    // One target sits in a visible gap, so every size edits without adding 50,001.
    id: `perf-${index}`, type: 'rectangle', x: index === 0 ? 400 : (index % 100) * 45, y: index === 0 ? 335 : Math.floor(index / 100) * 45,
    width: 24, height: 16, angle: 0, strokeColor: '#6b7280', backgroundColor: 'transparent',
    fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid', roughness: 0, opacity: 100,
    groupIds: [], frameId: null, index: `a0${index.toString(36).padStart(6, '0')}1`,
    roundness: null, seed: index + 1, version: 1, versionNonce: index + 1,
    isDeleted: false, boundElements: null, updated: 1, link: null, locked: false,
  }))
}

for (const count of [1_000, 10_000, 50_000]) test(`perfil opt-in del editor completo · ${count} elementos`, async ({ browser, browserName }, testInfo) => {
  test.skip(process.env.CLARIN_WHITEBOARD_PERF !== '1' || browserName !== 'chromium')
  test.setTimeout(180_000)
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' })
  let elements: Array<Record<string, any>> = elementsFor(count)
  let sequence = 0
  let patches = 0
  let editStartedAt = 0
  let firstPatchAfterEditMs: number | null = null
  const blocked: string[] = []
  const errors: string[] = []
  const consoleErrors: string[] = []
  const workerURLs: string[] = []
  const record: Record<string, unknown> = {
    count, engine: '0.18.1-clarin.8', browser: browser.version(), viewport: '1440x900',
    sampleCount: 1, shape: 'unfilled roughness-0 rectangles on a 100-column grid with one visible edit target; viewport culling applies',
    edit: 'Select perf-0 and move it one pixel right; cardinality stays fixed, including the 50,000-element canonical limit.',
    limitations: 'Guest editor; HTTP/WebSocket mocked locally; includes browser decoding, fonts, render, save debounce and mock ACK. No server/DB latency, images, rich text, FPS, or device-wide memory claim. Context cache starts empty; server is warm.',
  }
  const scene = () => ({ type: 'excalidraw', version: 2, source: 'clarin', elements, appState: { viewBackgroundColor: '#ffffff', scrollX: 0, scrollY: 0, zoom: { value: 1 } }, files: {} })
  const sceneRecord = () => ({ board_id: boardID, sequence, editor_version: '0.18.1-clarin.8', scene_schema_version: 'excalidraw', scene: scene() })
  const commit = (patch: Array<Record<string, any>>) => {
    if (editStartedAt && firstPatchAfterEditMs === null) firstPatchAfterEditMs = performance.now() - editStartedAt
    patches += 1
    const canonical = new Map(elements.map(element => [element.id, element]))
    for (const element of patch) canonical.set(element.id, element)
    elements = [...canonical.values()]
    expect(elements.length).toBeLessThanOrEqual(50_000)
    sequence += 1
  }
  await context.addInitScript(() => {
    const samples: Array<{ start: number; duration: number }> = []
    Object.assign(window, { __whiteboardLongTasks: samples })
    try { new PerformanceObserver(list => { for (const entry of list.getEntries()) samples.push({ start: entry.startTime, duration: entry.duration }) }).observe({ type: 'longtask', buffered: true }) } catch { /* Unsupported measurement remains absent. */ }
  })
  await context.routeWebSocket(/\/ws(?:\/whiteboards\/[^?]+)?(?:\?.*)?$/, socket => {
    socket.onMessage(raw => {
      const message = JSON.parse(String(raw))
      if (message.event === 'sync.request') {
        socket.send(JSON.stringify({ event: 'ack', sequence }))
        socket.send(JSON.stringify({ event: 'room.ready', actor: { kind: 'guest', id: 'perf-guest', display_name: 'Perfil QA', access: 'edit' }, data: { actor_id: 'perf-guest' } }))
      } else if (message.event === 'scene.patch') {
        expect(message.elements.length).toBeLessThanOrEqual(2_000)
        commit(message.elements)
        socket.send(JSON.stringify({ event: 'ack', sequence, operation_id: message.operation_id, data: { scene: scene() } }))
      }
    })
  })
  await context.route('**/*', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin !== new URL(baseURL).origin) { blocked.push(url.href); await route.abort(); return }
    if (!url.pathname.startsWith('/api/')) { await route.continue(); return }
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (url.pathname === '/api/whiteboard-guest/scene') {
      if (request.method() !== 'GET') {
        const payload = request.postDataJSON()
        commit(payload.patch?.elements || payload.scene.elements)
        await json({ success: true, result: { scene: sceneRecord() } }); return
      }
      await json({ success: true, session: { id: 'perf-guest', display_name: 'Perfil QA', access_level: 'edit', expires_at: '2030-01-01T00:00:00Z' }, scene: sceneRecord(), allow_export: true }); return
    }
    if (url.pathname === '/api/whiteboard-guest/collab-ticket') { await json({ success: true, ticket: 'perf-ticket' }, 201); return }
    if (url.pathname.startsWith('/api/whiteboard-guest/assets')) { await json({ success: true, assets: [], next_cursor: null }); return }
    await json({ success: true })
  })
  const page = await context.newPage()
  page.on('worker', worker => workerURLs.push(worker.url()))
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  try {
    record.sceneJSONBytes = Buffer.byteLength(JSON.stringify(scene()))
    const mountStarted = performance.now()
    await page.goto(`${baseURL}/shared/whiteboards/performance-qa`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await expect(page.locator('canvas.interactive')).toBeVisible({ timeout: 90_000 })
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    record.navigationToCanvasAndTwoFramesMs = +(performance.now() - mountStarted).toFixed(2)
    const patchCountBeforeEdit = patches
    await page.getByTestId('toolbar-selection').check({ force: true })
    const canvas = (await page.locator('canvas.interactive').boundingBox())!
    editStartedAt = performance.now()
    await page.mouse.click(canvas.x + 412, canvas.y + 336)
    await page.keyboard.press('ArrowRight')
    record.pointerAndKeyboardGestureMs = +(performance.now() - editStartedAt).toFixed(2)
    await expect.poll(() => elements.find(element => element.id === 'perf-0')?.x, { timeout: 60_000 }).toBe(401)
    await expect(page.getByLabel('Guardado en Clarin')).toBeVisible({ timeout: 60_000 })
    record.editThroughConfirmedSaveMs = +(performance.now() - editStartedAt).toFixed(2)
    record.firstPatchAfterEditMs = firstPatchAfterEditMs
    record.patchesForGesture = patches - patchCountBeforeEdit
    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 })
    await page.getByRole('button', { name: 'Exportar copia editable' }).click()
    const exported = JSON.parse(readFileSync((await (await downloadPromise).path())!, 'utf8'))
    expect(exported.elements.filter((element: Record<string, unknown>) => !element.isDeleted)).toHaveLength(count)
    expect(exported.elements.find((element: Record<string, unknown>) => element.id === 'perf-0')).toMatchObject({ x: 401, y: 335 })
    record.exportedElementCount = exported.elements.length
    expect(blocked).toEqual([])
    expect(errors).toEqual([])
    record.outcome = 'completed'
  } catch (error) {
    record.outcome = 'failed-or-timed-out'
    record.failure = String(error)
    throw error
  } finally {
    record.browserMetrics = await page.evaluate(() => {
      const metrics = window as unknown as { __whiteboardLongTasks?: Array<{ start: number; duration: number }> }
      const memory = performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }
      return { longTasks: metrics.__whiteboardLongTasks || [], approximateJSHeapBytes: memory.memory?.usedJSHeapSize ?? null }
    }).catch(() => null)
    record.blockedRequests = blocked
    record.pageErrors = errors
    record.consoleErrors = consoleErrors
    record.workerURLs = workerURLs
    const path = testInfo.outputPath(`editor-performance-${count}.json`)
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`)
    await testInfo.attach(`editor-performance-${count}`, { path, contentType: 'application/json' })
    console.log(JSON.stringify(record))
    await context.close()
  }
})
