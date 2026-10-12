import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { transform } from 'esbuild'

// npm dependencies must be installed. Examples, from frontend:
// node scripts/benchmark-whiteboard-patch.mjs
// node scripts/benchmark-whiteboard-patch.mjs --baseline=d349f386f62739a81379338761780e71c721e552
// node scripts/benchmark-whiteboard-patch.mjs --browser
const baseline = process.argv.find(arg => arg.startsWith('--baseline='))?.slice('--baseline='.length)
const browserMode = process.argv.includes('--browser')
const source = baseline
  ? execFileSync('git', ['show', `${baseline}:frontend/src/lib/whiteboards.ts`], { cwd: fileURLToPath(new URL('../..', import.meta.url)), encoding: 'utf8' })
  : await readFile(new URL('../src/lib/whiteboards.ts', import.meta.url), 'utf8')
const { code } = await transform(source, { loader: 'ts', format: 'esm' })
const input = { code, sizes: baseline ? [1000, 10000] : [1000, 10000, 50000] }
async function measure({ code, sizes }) {
  const { closeWhiteboardElementPatch } = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`)
  const results = []
  for (const count of sizes) {
    const elements = Array.from({ length: count }, (_, index) => ({ id: `e-${index}`, type: 'rectangle', version: 1, versionNonce: index, x: index, y: index, width: 40, height: 30 }))
    for (const [changed, patch] of [['all', elements], ['one', [elements.at(-1)]]]) {
      closeWhiteboardElementPatch(elements, patch)
      const samples = []
      for (let iteration = 0; iteration < 7; iteration++) {
        const start = performance.now()
        const result = closeWhiteboardElementPatch(elements, patch)
        samples.push(performance.now() - start)
        if (result.length !== patch.length) throw new Error('Unexpected closure')
      }
      samples.sort((a, b) => a - b)
      results.push({ count, changed, samples_ms: samples.map(value => +value.toFixed(2)), median_ms: +samples[3].toFixed(2), maximum_ms: +samples[6].toFixed(2) })
    }
  }
  return results
}
let results
let runtime
if (browserMode) {
  const { chromium } = await import('@playwright/test')
  const browser = await chromium.launch({ headless: true })
  try {
    runtime = `Chromium ${browser.version()}`
    const page = await browser.newPage()
    results = await page.evaluate(measure, input)
  } finally { await browser.close() }
} else {
  runtime = `Node ${process.version}`
  results = await measure(input)
}
console.log(JSON.stringify({ runtime, source: baseline || 'working-tree', results }, null, 2))
