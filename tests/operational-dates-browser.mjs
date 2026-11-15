import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { build } = require(path.join(root, 'frontend/node_modules/esbuild'))
const { chromium, expect } = require(path.join(root, 'node_modules/@playwright/test'))
const baselineRevision = 'c97f663b3855cb7120130046ffcdbe2b94b1dd3d'
const baseline = process.argv.includes('--baseline')
const onlyContact = process.argv.includes('--only=contact')
const onlyOffline = process.argv.includes('--only=offline')
const variant = baseline ? 'before' : 'after'
const work = path.join(root, '.qa/operational-dates-browser', variant)
const output = path.join(root, 'docs/qa/fechas-editables-20261115', variant)
fs.mkdirSync(work, { recursive: true }); fs.mkdirSync(output, { recursive: true })
const fixture = path.join(root, 'tests/fixtures/operational-dates.tsx')
const offlineFixture = path.join(root, 'tests/fixtures/operational-dates-offline.tsx')
const offlineCsp = fs.readFileSync(path.join(root, 'frontend/scripts/build-offline-v4.mjs'), 'utf8').match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1]
const report = { variant, source: baseline ? 'Exact baseline components, compiled without altering the checkout' : 'Current real OperationalDatePicker, TaskDateRangePicker, ContactDetailSurface and OfflineTasksView', baselineRevision, syntheticOnly: true, scenarios: [], errors: [] }
if ((onlyContact || onlyOffline) && fs.existsSync(path.join(output, 'report.json'))) report.scenarios = JSON.parse(fs.readFileSync(path.join(output, 'report.json'), 'utf8')).scenarios.filter(row => !(onlyContact ? row.name.startsWith('contact-real-') : row.name.startsWith('offline-real-')))
const widths = baseline ? [320, 1440] : [320, 375, 768, 1024, 1440]
const cases = widths.flatMap(width => [
  { width, sidebar: 'closed', eros: 'closed' },
  ...(width >= 768 ? [{ width, sidebar: 'open', eros: 'closed' }, { width, sidebar: 'open', eros: 'open' }] : []),
])
const plugins = baseline ? [{ name: 'exact-baseline', setup(plugin) {
  plugin.onResolve({ filter: /(?:operational-date\/OperationalDatePicker|task-work\/TaskDateRangePicker|\.\/TaskDateRangePicker)$/ }, args => {
    const name = args.path.includes('OperationalDatePicker') ? 'operational-date/OperationalDatePicker' : 'task-work/TaskDateRangePicker'
    return { path: path.join(root, `frontend/src/components/${name}.tsx`), namespace: 'baseline-date' }
  })
  plugin.onLoad({ filter: /.*/, namespace: 'baseline-date' }, args => {
    const file = path.relative(root, args.path).replaceAll('\\', '/')
    const result = spawnSync('git', ['show', `${baselineRevision}:${file}`], { cwd: root, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr)
    return { contents: result.stdout, loader: 'tsx', resolveDir: path.dirname(args.path) }
  })
} }] : []

plugins.push({ name: 'synthetic-contact-services', setup(plugin) {
  plugin.onResolve({ filter: /(?:useContactProfile|useGoogleContactSync|ContactAvatarControl|ContactTagEditor|ScopedActivityPanel)$/ }, args => ({ path: args.path, namespace: 'contact-stub' }))
  plugin.onResolve({ filter: /^@\/lib\/api$/ }, () => ({ path: 'api', namespace: 'contact-stub' }))
  plugin.onLoad({ filter: /.*/, namespace: 'contact-stub' }, args => {
    let contents = ''
    if (args.path.endsWith('useContactProfile')) contents = `import {useState} from 'react';const initial={id:'qa-contact',name:'Gabriela',custom_name:'Gaby',phone:'51900000000',birth_date:'1992-05-04',structured_tags:[],extra_phones:[],custom_field_values:[{id:'qa-value',field_id:'qa-field',contact_id:'qa-contact',field_name:'Renovación',field_type:'date',value_date:'2026-06-15',created_at:'',updated_at:''}]};export function useContactProfile(){const [contact,setContact]=useState(initial);return{contact,capabilities:{can_view:true,can_edit:true,can_manage_avatar:false,can_manage_observations:true,can_create_tags:false},availableTags:[],customFieldDefinitions:[{id:'qa-field',name:'Renovación',slug:'renovacion',field_type:'date',is_required:false}],loading:false,refreshing:false,error:'',saving:false,observations:[],observationCount:0,observationsLoaded:false,observationsLoading:false,observationsError:'',savingObservation:false,refresh(){},refreshObservations(){},async updateContact(patch){window.__dateQA.contactWrites.push(patch);const next={...contact,...patch};setContact(next);return{success:true,contact:next}},updateAvatarLocally(){},updateGoogleSyncLocally(){},async createObservation(){return{success:true}},loadMoreObservations(){},deleteObservation(){},updateObservation(){},setObservationPinned(){}}}`
    else if (args.path.endsWith('useGoogleContactSync')) contents = `export function useGoogleContactSync(){return{statusLoading:false,connected:false,permissionDenied:false,synced:false,mutation:null,statusError:'',actionError:'',feedback:'',retryStatus(){},sync(){},desync(){}}}`
    else if (args.path.endsWith('ContactAvatarControl')) contents = `import React from 'react';export default function Avatar(){return <span aria-label="Avatar sintético" className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-100 text-emerald-800">G</span>}`
    else if (args.path.endsWith('ContactTagEditor')) contents = `export default function Tags(){return null}`
    else if (args.path.endsWith('ScopedActivityPanel')) contents = `export function activityAuthorLabel(){return 'Usuario de prueba'};export default function Activity(){return null}`
    else contents = `export async function api(){return{success:true,data:{tags:[],can_create:false}}}`
    return { contents, loader: 'tsx', resolveDir: root }
  })
} })

async function assertDateReadability(page, result, phase, expectedFields) {
  await page.evaluate(() => document.fonts.ready)
  await expect.poll(async () => {
    const fields = await page.locator('[data-operational-date-field] input[type="text"]').evaluateAll(inputs => {
      const canvas = document.createElement('canvas'), context = canvas.getContext('2d')
      return inputs.filter(input => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(input.value) && input.getClientRects().length > 0).map(input => {
        const css = getComputedStyle(input)
        context.font = css.font || `${css.fontWeight} ${css.fontSize} ${css.fontFamily}`
        const spacing = Number.parseFloat(css.letterSpacing) || 0
        const required = context.measureText(input.value).width + spacing * Math.max(0, input.value.length - 1)
        const available = input.clientWidth - (Number.parseFloat(css.paddingLeft) || 0) - (Number.parseFloat(css.paddingRight) || 0)
        return { label: input.getAttribute('aria-label'), value: input.value, clientWidth: input.clientWidth, available, required, font: context.font, fits: available >= required }
      })
    })
    result.dateReadability ??= {}
    result.dateReadability[phase] = fields
    return fields.length === expectedFields && fields.every(field => field.fits)
  }, { message: `${result.name}: every DD/MM/AAAA value must fit fully inside its own input at ${phase}` }).toBe(true)
}

async function main() {
  await build({ entryPoints: [fixture], outfile: path.join(work, 'bundle.js'), bundle: true, format: 'iife', jsx: 'automatic', nodePaths: [path.join(root, 'frontend/node_modules')], alias: { '@': path.join(root, 'frontend/src') }, define: { 'process.env.NODE_ENV': '"development"' }, plugins })
  if (!baseline) await build({ entryPoints: [offlineFixture], outfile: path.join(work, 'offline-bundle.js'), bundle: true, format: 'iife', jsx: 'automatic', nodePaths: [path.join(root, 'frontend/node_modules')], alias: { '@': path.join(root, 'frontend/src') }, define: { 'process.env.NODE_ENV': '"development"' } })
  const config = { ...require(path.join(root, 'frontend/tailwind.config.js')), content: [fixture.replaceAll('\\', '/'), path.join(root, 'frontend/src/components/**/*.{ts,tsx}').replaceAll('\\', '/')] }
  fs.writeFileSync(path.join(work, 'tailwind.cjs'), `module.exports=${JSON.stringify(config)}`)
  fs.writeFileSync(path.join(work, 'input.css'), '@tailwind base;\n@tailwind components;\n@tailwind utilities;\nhtml,body,#root{margin:0;width:100%;height:100%;font-family:Arial,sans-serif}*{box-sizing:border-box}')
  const css = spawnSync(process.execPath, [path.join(root, 'frontend/node_modules/tailwindcss/lib/cli.js'), '-c', path.join(work, 'tailwind.cjs'), '-i', path.join(work, 'input.css'), '-o', path.join(work, 'style.css')], { encoding: 'utf8' })
  if (css.status) throw new Error(css.stderr)
  const server = http.createServer((request, response) => {
    const pathname = request.url?.split('?')[0]
    const file = ['/bundle.js', '/style.css', '/offline-bundle.js', '/offline-bundle.css'].includes(pathname) ? pathname.slice(1) : null
    if (pathname === '/offline') response.setHeader('Content-Security-Policy', offlineCsp)
    response.setHeader('Content-Type', file?.endsWith('.js') ? 'text/javascript' : file?.endsWith('.css') ? 'text/css' : 'text/html')
    response.end(file ? fs.readFileSync(path.join(work, file)) : pathname === '/offline' ? `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${offlineCsp}"><link rel="stylesheet" href="/offline-bundle.css"><div id="root"></div><script src="/offline-bundle.js"></script></html>` : '<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/bundle.js"></script></html>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true })
  try {
    for (const row of onlyContact || onlyOffline ? [] : cases) {
      const name = `${row.width}-sidebar-${row.sidebar}-eros-${row.eros}`
      fs.rmSync(path.join(output, `${name}-failure.png`), { force: true })
      const result = { ...row, name, failures: [], blockedExternalRequests: [], geometry: null }
      report.scenarios.push(result)
      const context = await browser.newContext({ viewport: { width: row.width, height: row.width < 768 ? 812 : 900 }, hasTouch: row.width < 768, isMobile: row.width < 768, timezoneId: 'America/Lima' })
      const page = await context.newPage(); page.setDefaultTimeout(8000)
      page.on('pageerror', error => result.failures.push(error.message))
      await page.route('**/*', route => {
        if (route.request().url().startsWith(origin)) return route.continue()
        result.blockedExternalRequests.push(route.request().url()); return route.abort()
      })
      try {
        await page.goto(`${origin}/?sidebar=${row.sidebar}&eros=${row.eros}`)
        await page.getByRole('heading', { name: 'Fechas · datos sintéticos' }).waitFor()
        if (!baseline) await assertDateReadability(page, result, 'initial', 4)
        await page.screenshot({ path: path.join(output, `${name}-fields.png`), fullPage: true })
        const trigger = page.getByTitle('Abrir calendario: Nacimiento')
        if (baseline) await page.getByRole('button', { name: /^Nacimiento:/ }).click()
        else if (row.width < 768) await trigger.tap()
        else await trigger.click()
        const calendar = page.getByRole('dialog', { name: 'Elegir Nacimiento' })
        await calendar.waitFor()
        const box = await calendar.boundingBox(), viewport = page.viewportSize()
        result.geometry = box
        expect(box.x).toBeGreaterThanOrEqual(-1); expect(box.y).toBeGreaterThanOrEqual(-1)
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1)
        expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1)
        expect(await calendar.getByRole('textbox', { name: 'Hora', exact: true }).count()).toBe(0)
        expect(await calendar.getByRole('button', { name: 'Todo el día', exact: true }).count()).toBe(0)
        if (!baseline && row.width < 768) {
          const icon = await trigger.boundingBox()
          const days = await calendar.locator('[data-date-key]').evaluateAll(nodes => nodes.map(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })))
          const buttons = await calendar.locator('button').evaluateAll(nodes => nodes.map(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })))
          result.touchTargets = { icon, days, buttons }
          expect(icon.width).toBeGreaterThanOrEqual(44); expect(icon.height).toBeGreaterThanOrEqual(44)
          expect(days.every(day => day.width >= 43.9 && day.height >= 44)).toBe(true)
          expect(buttons.every(button => button.width >= 43.9 && button.height >= 44)).toBe(true)
        }
        await page.screenshot({ path: path.join(output, `${name}-calendar.png`), fullPage: true })
        await page.keyboard.press('Escape'); await calendar.waitFor({ state: 'hidden' })
        if (!baseline) {
          await expect(trigger).toBeFocused()
          const date = page.getByRole('textbox', { name: 'Nacimiento', exact: true })
          await date.fill('15/11/')
          await page.getByRole('button', { name: 'Guardar fecha', exact: true }).click()
          await expect(date).toHaveValue('15/11/'); await expect(date).toHaveAttribute('aria-invalid', 'true')
          expect(await page.evaluate(() => window.__dateQA.writes.length)).toBe(0)
          await date.fill('29/02/2028')
          await page.getByRole('button', { name: 'Guardar fecha', exact: true }).click()
          expect(await page.evaluate(() => window.__dateQA.writes)).toEqual([{ birth: '2028-02-29' }])
          expect(await page.getByRole('textbox', { name: 'Nacimiento: hora', exact: true }).count()).toBe(0)
          await trigger.click(); await calendar.waitFor()
          await calendar.locator('[data-date-key="2028-02-20"]').click()
          await page.keyboard.press('Escape'); await calendar.waitFor({ state: 'hidden' })
          await expect(date).toHaveValue('29/02/2028')
          expect(await page.evaluate(() => window.__dateQA.writes.length)).toBe(1)
          const commitsBeforeIcon = await page.evaluate(() => window.__dateQA.commits.length)
          await date.fill('20/02/2028')
          if (row.width < 768) await trigger.tap(); else await trigger.click()
          await calendar.waitFor()
          expect(await page.evaluate(() => window.__dateQA.commits.length)).toBe(commitsBeforeIcon)
          await page.keyboard.press('Escape'); await calendar.waitFor({ state: 'hidden' })
          await expect(date).toHaveValue('20/02/2028')
          await date.fill('29/02/2028')
          const meeting = page.getByRole('textbox', { name: 'Reunión', exact: true })
          await meeting.fill('20/11/2026')
          await page.getByRole('button', { name: 'Guardar reunión', exact: true }).click()
          await expect(page.getByRole('textbox', { name: 'Reunión: hora', exact: true })).toHaveValue('14:35')
          expect(await page.evaluate(() => window.__dateQA.writes[1])).toEqual({ meeting: '2026-11-20T14:35' })
          const start = page.getByRole('textbox', { name: 'Inicio opcional', exact: true }), end = page.getByRole('textbox', { name: 'Entrega', exact: true })
          await end.fill('14/11/2026'); await end.press('Enter')
          expect(await page.evaluate(() => window.__dateQA.ranges.length)).toBe(0)
          await start.fill('17/11/2026'); await end.fill('18/11/2026'); await end.press('Enter')
          await expect.poll(() => page.evaluate(() => window.__dateQA.ranges.length)).toBe(1)
          expect(await page.evaluate(() => window.__dateQA.ranges[0])).toEqual({ startAt: '2026-11-17T09:00', endAt: '2026-11-18T10:00', isAllDay: false })
          await assertDateReadability(page, result, 'typed', 4)
          await expect.poll(() => page.locator('html').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
          await page.screenshot({ path: path.join(output, `${name}-typed.png`), fullPage: true })
        }
      } catch (error) {
        result.failures.push(error.stack || String(error))
        await page.screenshot({ path: path.join(output, `${name}-failure.png`), fullPage: true }).catch(() => {})
      } finally { await context.close() }
      console.log(`${variant} ${name}: ${result.failures.length ? 'FAIL' : 'PASS'}`)
    }
    if (!baseline && !onlyOffline) for (const width of [375, 1440]) {
      const result = { name: `contact-real-${width}`, width, failures: [] }
      fs.rmSync(path.join(output, `${result.name}-failure.png`), { force: true })
      report.scenarios.push(result)
      const context = await browser.newContext({ viewport: { width, height: 900 }, timezoneId: 'America/Lima', hasTouch: width < 768, isMobile: width < 768 })
      const page = await context.newPage(); page.setDefaultTimeout(8000)
      page.on('pageerror', error => result.failures.push(error.message))
      await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort())
      try {
        await page.goto(`${origin}/?surface=contact&sidebar=${width > 768 ? 'open' : 'closed'}`)
        await page.getByRole('button', { name: 'Editar', exact: true }).click()
        const birth = page.getByRole('textbox', { name: 'Fecha de nacimiento', exact: true })
        await birth.fill('31/02/1992')
        await expect(page.getByRole('button', { name: 'Guardar contacto', exact: true })).toBeDisabled()
        expect(await page.evaluate(() => window.__dateQA.contactWrites.length)).toBe(0)
        await expect(birth).toHaveValue('31/02/1992')
        await birth.fill('09/05/1992')
        const custom = page.getByRole('textbox', { name: 'Renovación', exact: true })
        await custom.fill('20/06/')
        await expect(page.getByRole('button', { name: 'Guardar contacto', exact: true })).toBeDisabled()
        expect(await page.evaluate(() => window.__dateQA.contactWrites.length)).toBe(0)
        await custom.fill('20/06/2026')
        await assertDateReadability(page, result, 'contact-editing', 2)
        const top = () => page.getByRole('form', { name: 'Editar contacto' }).evaluate(form => { for (let element = form; element; element = element.parentElement) element.scrollTop = 0 })
        await top()
        await page.getByTitle('Abrir calendario: Fecha de nacimiento').click()
        await page.getByRole('dialog', { name: 'Elegir Fecha de nacimiento' }).waitFor()
        await page.screenshot({ path: path.join(output, `${result.name}-calendar.png`), fullPage: true })
        await page.keyboard.press('Escape')
        await top()
        await page.screenshot({ path: path.join(output, `${result.name}-editing.png`), fullPage: true })
        await page.getByRole('button', { name: 'Guardar contacto', exact: true }).click()
        await expect.poll(() => page.evaluate(() => window.__dateQA.contactWrites.length)).toBe(1)
        expect(await page.evaluate(() => window.__dateQA.contactWrites[0])).toMatchObject({ birth_date: '1992-05-09', custom_field_values: [{ field_id: 'qa-field', value_date: '2026-06-20' }] })
        result.syntheticServices = ['useContactProfile', 'useGoogleContactSync', 'Avatar', 'ContactTagEditor', 'activityAuthorLabel', 'api']
      } catch (error) {
        result.failures.push(error.stack || String(error))
        await page.screenshot({ path: path.join(output, `${result.name}-failure.png`), fullPage: true }).catch(() => {})
      } finally { await context.close() }
      console.log(`${variant} ${result.name}: ${result.failures.length ? 'FAIL' : 'PASS'}`)
    }
    if (!baseline && !onlyContact) for (const width of [320, 375, 1440]) {
      const result = { name: `offline-real-csp-${width}`, width, csp: offlineCsp, css: 'offline-v4/offline-runtime.css + operational-date/operationalDate.css; no Tailwind', failures: [], cspViolations: [], styles: null, touchTargets: null }
      report.scenarios.push(result)
      fs.rmSync(path.join(output, `${result.name}-failure.png`), { force: true })
      const context = await browser.newContext({ viewport: { width, height: 900 }, timezoneId: 'America/Lima', hasTouch: width < 768, isMobile: width < 768 })
      const page = await context.newPage(); page.setDefaultTimeout(8000)
      page.on('pageerror', error => result.failures.push(error.message))
      await page.addInitScript(() => {
        window.__cspViolations = []
        document.addEventListener('securitypolicyviolation', event => window.__cspViolations.push({ directive: event.violatedDirective, blockedURI: event.blockedURI }))
      })
      await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort())
      try {
        const response = await page.goto(`${origin}/offline`)
        expect(response.headers()['content-security-policy']).toBe(offlineCsp)
        const title = page.getByPlaceholder('Nueva tarea en General')
        await title.fill('Comprobación de fecha local')
        const date = page.getByRole('textbox', { name: 'Fecha límite', exact: true }), save = page.getByRole('button', { name: 'Crear localmente', exact: true })
        await date.fill('20/11/')
        await expect(date).toHaveAttribute('aria-invalid', 'true'); await expect(save).toBeDisabled()
        expect(await page.evaluate(() => window.__offlineDateQA.writes.length)).toBe(0)
        await date.fill('20/11/2026')
        await expect(save).toBeEnabled()
        await assertDateReadability(page, result, 'offline-before-calendar', 1)
        const trigger = page.getByTitle('Abrir calendario: Fecha límite')
        if (width < 768) await trigger.tap(); else await trigger.click()
        const calendar = page.getByRole('dialog', { name: 'Elegir Fecha límite' })
        await calendar.waitFor()
        const box = await calendar.boundingBox()
        expect(box.x).toBeGreaterThanOrEqual(-1); expect(box.y).toBeGreaterThanOrEqual(-1)
        expect(box.x + box.width).toBeLessThanOrEqual(width + 1); expect(box.y + box.height).toBeLessThanOrEqual(901)
        result.styles = await calendar.evaluate(panel => { const css = getComputedStyle(panel); const input = document.querySelector('[data-operational-date-field] input'); const field = getComputedStyle(input); return { position: css.position, color: css.color, background: css.backgroundColor, fontFamily: css.fontFamily, fieldFontSize: field.fontSize, left: css.left, top: css.top, width: css.width, radius: css.borderRadius } })
        expect(result.styles.position).toBe('fixed'); expect(result.styles.background).toBe('rgb(255, 255, 255)'); expect(result.styles.color).toBe('rgb(15, 23, 42)')
        expect(result.styles.fontFamily).toContain('sans-serif'); expect(parseFloat(result.styles.fieldFontSize)).toBeGreaterThanOrEqual(14)
        if (width < 768) {
          const icon = await trigger.boundingBox(), days = await calendar.locator('[data-date-key]').evaluateAll(nodes => nodes.map(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })))
          const buttons = await calendar.locator('button').evaluateAll(nodes => nodes.map(node => ({ label: node.getAttribute('aria-label') || node.textContent, width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })))
          result.touchTargets = { icon, days, buttons }
          expect(icon.width).toBeGreaterThanOrEqual(44); expect(icon.height).toBeGreaterThanOrEqual(44)
          expect(days.every(day => day.width >= 43.9 && day.height >= 44)).toBe(true)
          expect(buttons.every(button => button.width >= 43.9 && button.height >= 44)).toBe(true)
        }
        await page.screenshot({ path: path.join(output, `${result.name}-calendar.png`), fullPage: true })
        await calendar.locator('[data-date-key="2026-11-21"]').click()
        expect(await page.evaluate(() => window.__offlineDateQA.writes.length)).toBe(0)
        await calendar.getByRole('button', { name: 'Aplicar', exact: true }).click()
        await expect(date).toHaveValue('21/11/2026')
        await trigger.click(); await page.keyboard.press('Escape'); await expect(date).toHaveValue('21/11/2026')
        await date.fill('22/11/2026')
        await assertDateReadability(page, result, 'offline-before-save', 1)
        await save.click()
        await expect.poll(() => page.evaluate(() => window.__offlineDateQA.writes.length)).toBe(1)
        const patch = await page.evaluate(() => window.__offlineDateQA.writes[0].patch)
        expect(patch).toMatchObject({ title: 'Comprobación de fecha local', due_at: '2026-11-23T04:59:59.000Z', is_all_day: true })
        await expect.poll(() => page.locator('html').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
        await page.screenshot({ path: path.join(output, `${result.name}-saved.png`), fullPage: true })
        result.cspViolations = await page.evaluate(() => window.__cspViolations)
        expect(result.cspViolations).toEqual([])
      } catch (error) {
        result.failures.push(error.stack || String(error))
        result.cspViolations = await page.evaluate(() => window.__cspViolations || []).catch(() => [])
        await page.screenshot({ path: path.join(output, `${result.name}-failure.png`), fullPage: true }).catch(() => {})
      } finally { await context.close() }
      console.log(`${variant} ${result.name}: ${result.failures.length ? 'FAIL' : 'PASS'}`)
    }
  } finally { server.closeAllConnections(); await browser.close(); await new Promise(resolve => server.close(resolve)) }
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
  if (report.scenarios.some(row => row.failures.length)) process.exitCode = 1
}
main().catch(error => { console.error(error); process.exitCode = 1 })
