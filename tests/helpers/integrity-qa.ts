import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, type BrowserContext, type Locator, type Page, type Route } from '@playwright/test'

export const integrityWidths = [320, 375, 768, 1024, 1280, 1440] as const
export const contactContexts = ['contact', 'lead', 'chat', 'event_participant', 'program_participant'] as const
export type ContactContext = typeof contactContexts[number]

export interface IntegrityFixture {
  contact_id: string
  contact_name: string
  lead_id: string
  event_id: string
  event_participant_id: string
  program_id: string
  program_name?: string
  program_participant_id: string
  chat_id: string
  survey_id: string
}
export interface IntegrityLab {
  base_url: string
  api_url?: string
  token?: string
  refresh_token?: string
  cookies?: Parameters<BrowserContext['addCookies']>[0]
  account_id: string
  synthetic: true
  fixture: IntegrityFixture
}

// Deliberately opt in to a disposable laboratory. Never fall back to a live URL
// or to the older production browser credential files in .runtime.
const credentialFile = process.env.CLARIN_INTEGRITY_QA_FILE || resolve('.runtime/qa-lab-credentials.json')
export function readIntegrityLab(): IntegrityLab | undefined {
  if (!existsSync(credentialFile)) return undefined
  const lab = JSON.parse(readFileSync(credentialFile, 'utf8')) as IntegrityLab
  if (lab.synthetic !== true || !lab.account_id || !lab.fixture?.contact_id) {
    throw new Error('Integrity E2E requires an explicitly synthetic QA fixture/account.')
  }
  for (const field of ['contact_id', 'contact_name', 'lead_id', 'event_id', 'event_participant_id', 'program_id', 'program_participant_id', 'chat_id', 'survey_id'] as const) {
    if (!lab.fixture[field]) throw new Error(`The isolated QA fixture is missing ${field}.`)
  }
  for (const value of [lab.base_url, lab.api_url].filter(Boolean) as string[]) {
    const url = new URL(value)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol)) {
      throw new Error('Integrity E2E only accepts a loopback URL to the isolated QA laboratory.')
    }
  }
  return lab
}

export async function authenticateLab(page: Page, lab: IntegrityLab) {
  await page.context().route('**/api/**', async route => {
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(route.request().url()).hostname)) {
      await route.abort('blockedbyclient')
      throw new Error('The QA frontend attempted to contact an API outside the isolated loopback laboratory.')
    }
    await route.fallback()
  })
  const cookies = lab.cookies || [
    ...(lab.token ? [{ name: 'auth-token', value: lab.token, url: lab.base_url, httpOnly: true, sameSite: 'Lax' as const }] : []),
    ...(lab.refresh_token ? [{ name: 'refresh-token', value: lab.refresh_token, url: lab.base_url, httpOnly: true, sameSite: 'Lax' as const }] : []),
  ]
  if (cookies.length === 0) throw new Error('The isolated laboratory has no browser session credentials.')
  await page.context().addCookies(cookies)
  await page.context().addInitScript(() => {
    localStorage.setItem('token', 'cookie-session')
    localStorage.setItem('clarin:last_activity_at', String(Date.now()))
    localStorage.setItem('clarin:auth_refreshed_at', String(Date.now()))
  })
  const me = await labRequest(page, lab, '/api/me')
  expect(me.user?.account_id, 'The browser must be scoped to the synthetic QA account').toBe(lab.account_id)
}

export async function labRequest(page: Page, lab: IntegrityLab, path: string, options: { method?: string; data?: unknown; expectedStatus?: number } = {}): Promise<any> {
  if (!path.startsWith('/api/')) throw new Error('Expected an account-scoped QA API path.')
  const response = await page.request.fetch(new URL(path, lab.api_url || lab.base_url).href, {
    method: options.method || 'GET',
    ...(options.data === undefined ? {} : { data: options.data }),
    // Share the browser cookie jar so a genuine refresh also updates probes.
    // An old bearer header must not override the refreshed canonical cookie.
  })
  if (options.expectedStatus !== undefined) expect(response.status(), `${options.method || 'GET'} ${path}`).toBe(options.expectedStatus)
  else expect(response.ok(), `${options.method || 'GET'} ${path}: HTTP ${response.status()}`).toBeTruthy()
  return response.status() === 204 ? undefined : response.json()
}

export function contextID(lab: IntegrityLab, type: ContactContext) {
  return type === 'contact' ? lab.fixture.contact_id : lab.fixture[`${type}_id` as keyof IntegrityFixture] as string
}
export function contextQuery(lab: IntegrityLab, type: ContactContext) {
  return new URLSearchParams({ context_type: type, context_id: contextID(lab, type) }).toString()
}

export function canonicalContactImage(page: Page, lab: IntegrityLab) {
  return page.getByRole('button', { name: 'Gestionar foto del contacto', exact: true })
    .locator('..')
    .getByRole('button', { name: `Ampliar foto de ${lab.fixture.contact_name}`, exact: true })
    .locator('img')
}

export async function openContactContext(page: Page, lab: IntegrityLab, type: ContactContext) {
  const f = lab.fixture
  const profile = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === `/api/contact-profiles/${f.contact_id}` && url.searchParams.get('context_type') === type && response.request().method() === 'GET' && response.ok()
  }, { timeout: 90_000 })
  if (type === 'contact') {
    await page.goto(`${lab.base_url}/dashboard/contacts`, { waitUntil: 'commit' })
    await page.getByText(f.contact_name, { exact: true }).first().click()
  }
  else if (type === 'lead') await page.goto(`${lab.base_url}/dashboard/leads?lead_id=${f.lead_id}`, { waitUntil: 'commit' })
  else if (type === 'chat') {
    await page.goto(`${lab.base_url}/dashboard/chats`, { waitUntil: 'commit' })
    await page.getByRole('button', { name: `Conversación con ${f.contact_name}`, exact: true }).click()
    await page.getByRole('button', { name: 'Ver detalles de la conversación', exact: true }).click()
  } else {
    await page.goto(`${lab.base_url}/dashboard/${type === 'event_participant' ? 'events' : 'programs'}/${type === 'event_participant' ? f.event_id : f.program_id}`, { waitUntil: 'commit' })
    await page.getByText(f.contact_name, { exact: true }).first().click()
  }
  const data = await (await profile).json()
  expect(data.contact.id).toBe(f.contact_id)
  expect(data.capabilities.can_manage_avatar).toBe(true)
  await expect(page.getByRole('button', { name: 'Gestionar foto del contacto', exact: true })).toBeVisible()
  return data
}

export async function expectInViewport(page: Page, locator: Locator) {
  await expect(locator).toBeVisible()
  const box = await locator.boundingBox()
  const viewport = page.viewportSize()!
  expect(box).not.toBeNull()
  expect(box!.x).toBeGreaterThanOrEqual(-1)
  expect(box!.y).toBeGreaterThanOrEqual(-1)
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1)
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1)
}
export async function expectNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth)).toBeLessThanOrEqual(1)
}

export async function syntheticPhoto(page: Page, variant = 0) {
  const base64 = await page.evaluate(index => {
    const canvas = document.createElement('canvas')
    canvas.width = 64; canvas.height = 64
    const context = canvas.getContext('2d')!
    const colors = ['#059669', '#0369a1', '#7c3aed', '#be123c', '#b45309', '#334155']
    context.fillStyle = colors[index % colors.length]; context.fillRect(0, 0, 64, 64)
    context.fillStyle = '#fef3c7'; context.fillRect(8, 8, 24, 24)
    context.fillStyle = '#1e293b'; context.fillRect(32, 32, 24, 24)
    return canvas.toDataURL('image/png').split(',')[1]
  }, variant)
  return { name: 'synthetic-integrity-photo.png', mimeType: 'image/png', buffer: Buffer.from(base64, 'base64') }
}
export async function openPhotoEditor(page: Page, photo?: Awaited<ReturnType<typeof syntheticPhoto>>) {
  await page.getByRole('button', { name: 'Gestionar foto del contacto', exact: true }).click()
  const fileChooser = page.waitForEvent('filechooser')
  await page.getByRole('menuitem', { name: /Subir (una imagen|o reemplazar)/ }).click()
  await (await fileChooser).setFiles(photo || await syntheticPhoto(page))
  const dialog = page.getByRole('dialog', { name: 'Gestionar foto del contacto', exact: true })
  await expect(dialog.getByRole('heading', { name: 'Editar foto', exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Guardar foto', exact: true })).toBeEnabled()
  return dialog
}

// One targeted failure only; every other request, including retry, reaches QA.
export async function failNext(page: Page, predicate: (url: URL, method: string) => boolean, message: string, status = 500) {
  let failed = false
  const handler = async (route: Route) => {
    if (!failed && predicate(new URL(route.request().url()), route.request().method())) {
      failed = true
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ success: false, error: message }) })
    } else await route.fallback()
  }
  await page.route('**/api/**', handler)
  return { didFail: () => failed, remove: () => page.unroute('**/api/**', handler) }
}
