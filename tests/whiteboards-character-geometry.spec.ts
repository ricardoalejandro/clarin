import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'

const repository = resolve(__dirname, '..')
const fork = join(repository, 'frontend/vendor/excalidraw-clarin/packages/excalidraw')
const requireFrontend = createRequire(join(repository, 'frontend/package.json'))
const { build } = requireFrontend('esbuild') as typeof import('../frontend/node_modules/esbuild')
const { PNG } = requireFrontend('pngjs')
const catalog = JSON.parse(readFileSync(join(repository, 'frontend/third_party/whiteboard-fonts/catalog.json'), 'utf8'))

/**
 * Bundle the real formatting, range, bidi, layout and paint sources. Only the
 * ambient font-name adapter, Canvas width provider and decorative icon values
 * are supplied locally, avoiding the Next server and unrelated editor UI.
 * Font bytes/metrics and the first-strong direction predicate remain canonical.
 */
async function buildProbe(output: string) {
  const exports = [
    ['createClarinCharacterStyle', 'element/clarinCharacterStyle'],
    ['createClarinTextFormat', 'element/clarinRichText'],
    ['getClarinCharacterLineMetrics', 'element/clarinCharacterLayout'],
    ['wrapClarinText', 'element/textWrapping'],
    ['applyClarinTextColorHighlights', 'element/clarinTextColorHighlights'],
    ['drawClarinCharacterText, appendClarinCharacterSvgText, getClarinPositionedCharacterGroups', 'renderer/clarinCharacterRendering'],
  ].map(([names, file]) => `export { ${names} } from ${JSON.stringify(join(fork, file).replaceAll('\\', '/'))}`).join('\n')
  const utils = readFileSync(join(fork, 'utils.ts'), 'utf8')
  const directionStart = utils.indexOf('const RS_LTR_CHARS')
  const directionFunction = utils.indexOf('export const isRTL', directionStart)
  const directionEnd = utils.indexOf(';', directionFunction) + 1
  if (directionStart < 0 || directionFunction < 0 || directionEnd <= directionFunction) throw new Error('La fuente canónica de dirección cambió; revisa el adaptador de prueba.')
  const direction = utils.slice(directionStart, directionEnd)
  const customMetrics = Object.fromEntries(catalog.entries.map((entry: any) => [entry.id, { metrics: entry.metrics }]))
  await build({
    stdin: { contents: exports, loader: 'ts', resolveDir: repository, sourcefile: 'clarin-character-probe.ts' },
    outfile: output, bundle: true, format: 'iife', globalName: 'ClarinCharacterProbe', platform: 'browser', target: 'es2022',
    define: { 'import.meta.env.MODE': '"production"', 'import.meta.env.DEV': 'false' },
    plugins: [{ name: 'standalone-character-browser-adapters', setup(builder) {
      builder.onResolve({ filter: /(?:^|\/)utils$/ }, () => ({ path: 'utils', namespace: 'character-probe' }))
      builder.onResolve({ filter: /textMeasurements$/ }, () => ({ path: 'width', namespace: 'character-probe' }))
      builder.onResolve({ filter: /components\/icons$/ }, () => ({ path: 'icons', namespace: 'character-probe' }))
      builder.onLoad({ filter: /[/\\]fonts[/\\]FontMetadata\.ts$/ }, args => ({
        contents: `${readFileSync(args.path, 'utf8')}\nObject.assign(FONT_METADATA, ${JSON.stringify(customMetrics)});`,
        resolveDir: dirname(args.path), loader: 'ts',
      }))
      builder.onLoad({ filter: /.*/, namespace: 'character-probe' }, args => ({
        contents: args.path === 'utils'
          ? `${direction}\nconst families={2:'Arial',3:'ClarinCascadiaProbe, monospace',5:'ClarinExcalifontProbe, Arial',10019:'ClarinLoraProbe, serif'};export const getFontFamilyString=({fontFamily})=>families[fontFamily]||'Arial';export const getFontString=style=>style.fontSize+'px '+getFontFamilyString(style);`
          : args.path === 'icons'
            ? 'export const FreedrawIcon=null,FontFamilyNormalIcon=null,FontFamilyHeadingIcon=null,FontFamilyCodeIcon=null;'
            : "const canvas=document.createElement('canvas');const context=canvas.getContext('2d');export const getLineWidth=(text,font,direction)=>{context.font=font;const before=context.direction;if(direction)context.direction=direction;try{return context.measureText(text).width;}finally{if(direction)context.direction=before;}};export const charWidth={calculate(){throw new Error('Legacy character-width path is outside this focused probe.')}};",
        loader: 'ts',
      }))
    } }],
  })
}

test('geometría de caracteres · conserva kerning, árabe, bidi y alpha al colorear', async ({ page }, testInfo) => {
  test.setTimeout(90_000)
  const bundle = testInfo.outputPath('character-source.js')
  await buildProbe(bundle)
  const font = (file: string) => readFileSync(file).toString('base64')
  const lora = catalog.entries.find((entry: any) => entry.id === 10019)
  const cascadiaDirectory = join(fork, 'fonts/Cascadia')
  const cascadiaFile = readdirSync(cascadiaDirectory).find(file => file.endsWith('.woff2'))!
  const faces = [
    ['ClarinExcalifontProbe', join(fork, 'fonts/Excalifont/Excalifont-Regular-a88b72a24fb54c9f94e3b5fdaa7481c9.woff2')],
    ['ClarinCascadiaProbe', join(cascadiaDirectory, cascadiaFile)],
    ['ClarinLoraProbe', join(repository, 'frontend/third_party/whiteboard-fonts', lora.fontFaces.find((face: any) => face.subset === 'latin').file)],
  ].map(([family, file]) => `@font-face{font-family:${family};src:url(data:font/woff2;base64,${font(file)})}`).join('\n')
  const network: string[] = []
  page.on('request', request => network.push(request.url()))
  await page.route('**/*', route => route.abort('blockedbyclient'))
  await page.setViewportSize({ width: 1800, height: 2200 })
  await page.setContent(`<style>${faces}body{padding:20px;font:16px Arial}.row{display:flex;gap:50px;align-items:flex-start;margin-bottom:24px}.sample{white-space:pre;display:inline-block}canvas,svg{border:1px solid #ddd}</style><p>Texto nativo · Canvas Clarin · SVG Clarin</p><div id="cases"></div>`)
  await page.addScriptTag({ path: bundle })
  const evidence = await page.evaluate(async () => {
    const api = (window as any).ClarinCharacterProbe
    if (!CSS.highlights || typeof Highlight !== 'function') throw new Error('CSS Custom Highlights no está disponible.')
    await Promise.all(['ClarinExcalifontProbe', 'ClarinCascadiaProbe', 'ClarinLoraProbe'].map(family => document.fonts.load(`60px ${family}`, 'AV')))
    const cases = [
      { text: 'AV', family: 5, css: 'ClarinExcalifontProbe, Arial', from: 1, to: 2, rtl: false },
      { text: 'سلام', family: 2, css: 'Arial', from: 1, to: 3, rtl: true },
      { text: 'AV', family: 5, css: 'ClarinExcalifontProbe, Arial', from: 1, to: 2, rtl: false, italic: true, opacity: 0.5 },
      { text: 'سلام', family: 2, css: 'Arial', from: 1, to: 3, rtl: true, opacity: 0.5, angle: 0.17 },
      { text: 'AV', family: 2, css: 'Arial', from: 1, to: 2, rtl: false },
      { text: 'AV', family: 10019, css: 'ClarinLoraProbe, serif', from: 1, to: 2, rtl: false },
      { text: 'AV', family: 2, css: 'Arial', from: 1, to: 2, rtl: false, marks: 4 },
      { text: 'AV', family: 2, css: 'Arial', from: 1, to: 2, rtl: false, marks: 8 },
      { text: 'سلام', family: 2, css: 'Arial', from: 1, to: 3, rtl: true, marks: 12 },
    ]
    const shaped = cases.map((entry, index) => {
      const row = document.createElement('div'); row.className = 'row'; document.getElementById('cases')!.appendChild(row)
      const font = `${entry.italic ? 'italic ' : ''}60px ${entry.css}`
      const native = document.createElement('div'); native.className = 'sample'; native.style.font = font
      native.style.opacity = String(entry.opacity ?? 1); native.dir = entry.rtl ? 'rtl' : 'ltr'
      const node = document.createTextNode(entry.text); native.appendChild(node); row.appendChild(native)
      native.dataset.probeCase = String(index); native.dataset.probeFrom = String(entry.from); native.dataset.probeTo = String(entry.to)
      native.dataset.probeMarks = String(entry.marks ?? 0)
      if (!api.applyClarinTextColorHighlights(native, [
        { node, from: 0, to: entry.from, color: '#111111', marks: 0 },
        { node, from: entry.from, to: entry.to, color: '#DD0000', marks: entry.marks ?? 0 },
        { node, from: entry.to, to: entry.text.length, color: '#111111', marks: 0 },
      ])) throw new Error('No se pudo aplicar el pintado nativo de caracteres.')
      const element = {
        type: 'text', text: entry.text, originalText: entry.text, fontFamily: entry.family, fontSize: 60,
        lineHeight: 1.25, textAlign: 'left', strokeColor: '#111111', width: 250, height: 75, version: 1,
        customData: { clarinCharacterStyle: api.createClarinCharacterStyle(entry.text, [{ from: entry.from, to: entry.to, color: '#DD0000' }]) } as Record<string, any>,
      }
      if (entry.italic) element.customData.clarinTextFormat = api.createClarinTextFormat(entry.text, [{ from: 0, to: entry.text.length, marks: 2 }])
      else if (entry.marks) element.customData.clarinTextFormat = api.createClarinTextFormat(entry.text, [{ from: entry.from, to: entry.to, marks: entry.marks }])
      const [line] = api.getClarinCharacterLineMetrics(element)
      const ratio = window.devicePixelRatio || 1
      const canvas = document.createElement('canvas'); canvas.width = Math.ceil(250 * ratio); canvas.height = Math.ceil(110 * ratio)
      canvas.style.width = '250px'; canvas.style.height = '110px'; canvas.dir = native.dir; row.appendChild(canvas)
      const context = canvas.getContext('2d')!; context.scale(ratio, ratio); context.translate(20.375, 5.25)
      if (entry.angle) context.rotate(entry.angle)
      context.globalAlpha = entry.opacity ?? 1
      const originalText = CanvasRenderingContext2D.prototype.fillText
      const originalImage = CanvasRenderingContext2D.prototype.drawImage
      let mask: HTMLCanvasElement | null = null
      let before: Uint8ClampedArray | null = null
      let maskAlphaDifference = 0; let maskCount = 0; let maskPixels = 0
      CanvasRenderingContext2D.prototype.fillText = function (...args: Parameters<typeof originalText>) {
        originalText.apply(this, args)
        if (this !== context) {
          mask = this.canvas; before = this.getImageData(0, 0, mask.width, mask.height).data
          maskCount++; maskPixels = Math.max(maskPixels, mask.width * mask.height)
        }
      }
      CanvasRenderingContext2D.prototype.drawImage = function (...args: any[]) {
        if (this === context && args[0] === mask && mask && before) {
          const after = mask.getContext('2d')!.getImageData(0, 0, mask.width, mask.height).data
          for (let pixel = 3; pixel < after.length; pixel += 4) maskAlphaDifference = Math.max(maskAlphaDifference, Math.abs(after[pixel] - before[pixel]))
        }
        ;(originalImage as any).apply(this, args)
      }
      try { api.drawClarinCharacterText(context, element) }
      finally { CanvasRenderingContext2D.prototype.fillText = originalText; CanvasRenderingContext2D.prototype.drawImage = originalImage }
      const releasedMask = mask as HTMLCanvasElement | null
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
      let redPixels = 0; let blackPixels = 0; let maxOutputAlpha = 0
      for (let pixel = 3; pixel < pixels.length; pixel += 4) {
        maxOutputAlpha = Math.max(maxOutputAlpha, pixels[pixel])
        if (pixels[pixel] <= 20) continue
        if (pixels[pixel - 3] > pixels[pixel - 2] * 3) redPixels++
        else if (Math.abs(pixels[pixel - 3] - pixels[pixel - 2]) < 4) blackPixels++
      }
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('width', '250'); svg.setAttribute('height', '110'); svg.style.opacity = String(entry.opacity ?? 1)
      row.appendChild(svg); api.appendClarinCharacterSvgText(document, svg, element)
      const unsplit = native.cloneNode(false) as HTMLElement; unsplit.textContent = entry.text
      unsplit.style.position = 'fixed'; unsplit.style.visibility = 'hidden'; document.body.appendChild(unsplit)
      const unsplitWidth = unsplit.getBoundingClientRect().width; unsplit.remove()
      return {
        index, fontFamily: entry.family, text: entry.text, marks: entry.marks ?? 0,
        italic: entry.italic ?? false, opacity: entry.opacity ?? 1,
        nativeWidth: native.getBoundingClientRect().width, unsplitWidth, layoutWidth: line.width,
        svgWidth: svg.querySelector('text')!.getComputedTextLength(), maskAlphaDifference, maskCount,
        maskPixels, targetPixels: canvas.width * canvas.height,
        maskReleased: Boolean(releasedMask && releasedMask.width === 0 && releasedMask.height === 0),
        maxOutputAlpha, redPixels, blackPixels,
      }
    })
    const bidi = [
      { text: 'ABC אבג DEF', from: 5, to: 6, rtl: false, family: 3, scale: 2 / 3 },
      { text: 'אבג ABC דהו', from: 5, to: 6, rtl: true, family: 3, scale: 2 / 3 },
      { text: 'سلام', from: 1, to: 2, rtl: true, family: 3, scale: 2 / 3 },
      { text: 'سلام', from: 1, to: 2, rtl: true, family: 2, scale: 2 / 3 },
      { text: 'سلام', from: 1, to: 2, rtl: true, family: 3, scale: 1 },
    ].map(entry => {
      const row = document.createElement('div'); row.className = 'row'; document.getElementById('cases')!.appendChild(row)
      const native = document.createElement('div'); native.className = 'sample'; native.style.font = '60px Arial'; native.dir = entry.rtl ? 'rtl' : 'ltr'
      const before = document.createElement('span'); before.textContent = entry.text.slice(0, entry.from)
      const selected = document.createElement('span'); selected.textContent = entry.text.slice(entry.from, entry.to)
      selected.style.font = `${60 * entry.scale}px ${entry.family === 3 ? 'ClarinCascadiaProbe, monospace' : 'Arial'}`; selected.style.color = '#DD0000'
      const after = document.createElement('span'); after.textContent = entry.text.slice(entry.to)
      native.append(before, selected, after); row.appendChild(native)
      const element = {
        type: 'text', text: entry.text, originalText: entry.text, fontFamily: 2, fontSize: 60, lineHeight: 1.25,
        textAlign: 'left', strokeColor: '#111111', width: 500, height: 75, version: 1,
        customData: { clarinCharacterStyle: api.createClarinCharacterStyle(entry.text, [{ from: entry.from, to: entry.to, color: '#DD0000', fontFamily: entry.family, fontScale: entry.scale }]) },
      }
      const [line] = api.getClarinCharacterLineMetrics(element)
      const [groups] = api.getClarinPositionedCharacterGroups(element)
      const rendered = groups.find((group: any) => group.segments.some((segment: any) => segment.run.color === '#DD0000'))
      const ratio = window.devicePixelRatio || 1
      const canvas = document.createElement('canvas'); canvas.width = Math.ceil(500 * ratio); canvas.height = Math.ceil(110 * ratio)
      canvas.style.width = '500px'; canvas.style.height = '110px'; canvas.dir = native.dir
      const context = canvas.getContext('2d')!; context.scale(ratio, ratio)
      const canvasGlyphs: Array<{ text: string; renderedWidth: number }> = []
      const fillText = context.fillText.bind(context)
      context.fillText = (text, x, y, maxWidth) => {
        canvasGlyphs.push({ text, renderedWidth: context.measureText(text).width })
        if (maxWidth === undefined) fillText(text, x, y); else fillText(text, x, y, maxWidth)
      }
      row.appendChild(canvas); api.drawClarinCharacterText(context, element)
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('width', '500'); svg.setAttribute('height', '110')
      row.appendChild(svg); api.appendClarinCharacterSvgText(document, svg, element)
      const nativeWidth = native.getBoundingClientRect().width
      const fits = api.wrapClarinText(element, nativeWidth + 0.5)
      const narrow = entry.text === 'سلام' ? api.wrapClarinText(element, nativeWidth - 2) : null
      return {
        text: entry.text, family: entry.family, scale: entry.scale,
        nativeWidth, layoutWidth: line.width, fits, narrow,
        narrowLineWidths: narrow === null ? null : api.getClarinCharacterLineMetrics({ ...element, text: narrow }).map((line: any) => line.width),
        expectedX: selected.getBoundingClientRect().left - native.getBoundingClientRect().left, renderedX: rendered.x,
        fragments: groups.map((group: any) => {
          const diagnostic = document.createElement('canvas').getContext('2d')!; diagnostic.font = group.font; diagnostic.direction = group.rtl ? 'rtl' : 'ltr'
          return { text: group.text, font: group.font, x: group.x, width: group.width, rtl: group.rtl,
            candidates: [group.text, `\u200D${group.text}`, `${group.text}\u200D`, `\u200D${group.text}\u200D`].map(text => [text, diagnostic.measureText(text).width]) }
        }),
        glyphAdvances: [...svg.querySelectorAll('text')].map((text, index) => ({
          text: text.textContent!, nativeWidth: groups[index].width,
          renderedWidth: text.getComputedTextLength(), canvasWidth: canvasGlyphs[index].renderedWidth,
          canvasText: canvasGlyphs[index].text,
        })),
      }
    })
    const diagnosticContext = document.createElement('canvas').getContext('2d')!
    const fontMeasurements = ['Arial', 'Helvetica', 'Liberation Sans', 'sans-serif', 'ClarinExcalifontProbe', 'ClarinLoraProbe'].map(family => {
      diagnosticContext.font = `60px ${family === 'sans-serif' ? family : `"${family}"`}`
      return { requestedFamily: family, av: diagnosticContext.measureText('AV').width, arabic: diagnosticContext.measureText('سلام').width }
    })
    return { environment: { userAgent: navigator.userAgent, devicePixelRatio, fontMeasurements }, shaped, bidi }
  })
  const decorationPaint = []
  for (const row of evidence.shaped.filter(row => row.marks)) {
    const native = page.locator(`[data-probe-case="${row.index}"]`)
    const repaint = (marks: number) => native.evaluate((element, value) => {
      const node = element.firstChild as Text
      const from = Number((element as HTMLElement).dataset.probeFrom); const to = Number((element as HTMLElement).dataset.probeTo)
      return (window as any).ClarinCharacterProbe.applyClarinTextColorHighlights(element, [
        { node, from: 0, to: from, color: '#111111', marks: 0 },
        { node, from, to, color: '#DD0000', marks: value },
        { node, from: to, to: node.length, color: '#111111', marks: 0 },
      ])
    }, marks)
    expect(await repaint(0)).toBe(true)
    const before = PNG.sync.read(await native.screenshot({ animations: 'disabled' }))
    expect(await repaint(row.marks)).toBe(true)
    const decoratedPath = testInfo.outputPath(`character-decoration-${row.marks}.png`)
    const after = PNG.sync.read(await native.screenshot({ path: decoratedPath, animations: 'disabled' }))
    expect([after.width, after.height]).toEqual([before.width, before.height])
    let changedRedPixels = 0
    for (let pixel = 0; pixel < after.data.length; pixel += 4) {
      const change = Math.abs(after.data[pixel] - before.data[pixel]) + Math.abs(after.data[pixel + 1] - before.data[pixel + 1]) + Math.abs(after.data[pixel + 2] - before.data[pixel + 2])
      if (change > 30 && after.data[pixel] > after.data[pixel + 1] * 2 && after.data[pixel] > after.data[pixel + 2] * 2) changedRedPixels++
    }
    decorationPaint.push({ marks: row.marks, changedRedPixels })
    expect(changedRedPixels, `Decoración ${row.marks} realmente pintada por ::highlight`).toBeGreaterThan(5)
    await testInfo.attach(`character-native-decoration-${row.marks}`, { path: decoratedPath, contentType: 'image/png' })
  }
  const evidencePath = testInfo.outputPath('character-evidence.json')
  const screenshotPath = testInfo.outputPath('character-visible.png')
  writeFileSync(evidencePath, JSON.stringify({ ...evidence, decorationPaint }, null, 2))
  await page.screenshot({ path: screenshotPath, animations: 'disabled', fullPage: true })
  await testInfo.attach('character-geometry-evidence', { path: evidencePath, contentType: 'application/json' })
  await testInfo.attach('character-geometry-visible', { path: screenshotPath, contentType: 'image/png' })
  for (const row of evidence.shaped) {
    const label = `${row.fontFamily} ${row.text} italic=${row.italic} opacity=${row.opacity}`
    expect(Math.abs(row.nativeWidth - row.unsplitWidth), label).toBeLessThan(0.1)
    expect(Math.abs(row.nativeWidth - row.layoutWidth), label).toBeLessThan(0.1)
    expect(Math.abs(row.nativeWidth - row.svgWidth), label).toBeLessThan(0.1)
    expect(row.maskAlphaDifference, label).toBe(0)
    expect(row.maskCount, label).toBe(1)
    expect(row.maskReleased, label).toBe(true)
    expect(row.maskPixels, label).toBeLessThanOrEqual(row.targetPixels)
    expect(row.maxOutputAlpha, label).toBeLessThanOrEqual(Math.ceil(255 * row.opacity))
    expect(row.redPixels, label).toBeGreaterThan(0)
    expect(row.blackPixels, label).toBeGreaterThan(0)
  }
  for (const row of evidence.bidi) {
    expect(Math.abs(row.nativeWidth - row.layoutWidth), row.text).toBeLessThan(0.1)
    expect(Math.abs(row.expectedX - row.renderedX), row.text).toBeLessThan(0.1)
    expect(row.fits, row.text).toBe(row.text)
    if (row.narrow !== null) {
      expect(row.narrow, row.text).toContain('\n')
      expect(row.narrow.replaceAll('\n', ''), row.text).toBe(row.text)
      expect(Math.max(...row.narrowLineWidths!), row.text).toBeLessThanOrEqual(row.nativeWidth - 2 + 0.2)
    }
    for (const glyph of row.glyphAdvances) {
      const label = `${row.text} family=${row.family} scale=${row.scale}: ${glyph.text}`
      expect(Math.abs(glyph.nativeWidth - glyph.renderedWidth), label).toBeLessThan(0.2)
      expect(Math.abs(glyph.nativeWidth - glyph.canvasWidth), label).toBeLessThan(0.2)
      expect(glyph.canvasText, label).toBe(glyph.text)
    }
  }
  expect(network).toEqual([])
})
