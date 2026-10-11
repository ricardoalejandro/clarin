import {expect, type BrowserContext, type Page} from '@playwright/test'

type AuthState = Awaited<ReturnType<BrowserContext['storageState']>>
const sessions = new Map<string, AuthState>()

// Reuse only a session obtained by the normal native login. Keep credentials and
// session material in worker memory, never in reports, traces or committed files.
export async function isolatedNativeLogin(page: Page, base: string, actor: {username: string; password: string}) {
  const origin = new URL(base).origin
  if (!['localhost', '127.0.0.1'].includes(new URL(origin).hostname)) throw new Error('Only isolated loopback browser QA')
  const key = `${origin}:${actor.username}`
  const state = sessions.get(key)
  if (state) {
    await page.context().addCookies(state.cookies)
    await page.addInitScript(({origin, entries}) => {
      if (location.origin === origin) for (const {name, value} of entries) localStorage.setItem(name, value)
    }, {origin, entries: state.origins.find(entry => entry.origin === origin)?.localStorage || []})
    await page.goto(origin + '/dashboard/documents', {waitUntil: 'domcontentloaded'})
    await expect(page.getByRole('heading', {name: 'Plantillas', exact: true})).toBeVisible()
    return
  }
  const ready = page.waitForResponse(response => new URL(response.url()).pathname === '/api/public/security-config')
  await page.goto(origin + '/login', {waitUntil: 'domcontentloaded'})
  expect((await ready).status()).toBe(200)
  await page.getByPlaceholder('usuario o correo').fill(actor.username)
  try { await page.getByPlaceholder('tu contraseña').fill(actor.password) } catch { throw new Error('Unable to fill private QA login') }
  const signed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/login' && response.request().method() === 'POST')
  await page.getByRole('button', {name: 'Iniciar sesión', exact: true}).click()
  expect((await signed).status()).toBe(200)
  await page.waitForURL(/\/dashboard(?:\/|$|\?)/)
  sessions.set(key, await page.context().storageState())
}
