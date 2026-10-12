import { expect, test } from '@playwright/test'
import { buildNavigationHistoryScript } from '../frontend/src/lib/navigationHistory'

// Real browser History API; this controller fixture has no Next or backend.
test('Back/Forward conservan el cursor exacto al cancelar y agrupan las pulsaciones rápidas', async ({ page }) => {
  await page.route('https://history.clarin.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>History controller QA</title>' }))
  await page.goto('https://history.clarin.test/list?exact=1#start')
  await page.addScriptTag({ content: buildNavigationHistoryScript() })
  await page.evaluate(() => {
    const qa = window as any
    qa.calls = 0; qa.delivered = 0; qa.revision = 1
    history.pushState({ __NA: true, tree: ['board'] }, '', '/board?exact=2#editor')
    history.pushState({ __NA: true, tree: ['future'] }, '', '/future?exact=3#later')
    window.addEventListener('popstate', () => { qa.delivered += 1 })
  })
  await page.evaluate(() => history.back())
  await expect(page).toHaveURL('https://history.clarin.test/board?exact=2#editor')
  await page.evaluate(() => {
    const qa = window as any
    qa.delivered = 0
    qa.unregister = qa.__CLARIN_NAVIGATION_HISTORY__.register({
      requestLeave: () => { qa.calls += 1; return new Promise(resolve => { qa.allow = resolve }) },
      revision: () => String(qa.revision),
    })
    history.back()
  })
  await expect.poll(() => page.evaluate(() => (window as any).calls)).toBe(1)
  await expect(page).toHaveURL('https://history.clarin.test/board?exact=2#editor')
  await page.evaluate(() => history.back())
  await page.waitForTimeout(100)
  await expect(page).toHaveURL('https://history.clarin.test/board?exact=2#editor')
  await page.evaluate(() => (window as any).allow(false))
  expect(await page.evaluate(() => ({ calls: (window as any).calls, delivered: (window as any).delivered, length: history.length, tree: history.state.tree }))).toMatchObject({ calls: 1, delivered: 0, tree: ['board'] })
  await page.evaluate(() => history.forward())
  await expect.poll(() => page.evaluate(() => (window as any).calls)).toBe(2)
  await expect(page).toHaveURL('https://history.clarin.test/board?exact=2#editor')
  await page.evaluate(() => (window as any).allow(false))
  await page.evaluate(() => (window as any).unregister())
  await page.evaluate(() => history.forward())
  await expect(page).toHaveURL('https://history.clarin.test/future?exact=3#later')
  await page.evaluate(() => history.back())
  await expect(page).toHaveURL('https://history.clarin.test/board?exact=2#editor')
})

test('una ráfaga antes de restaurar no sobrepasa la entrada original ni repite la navegación', async ({ page }) => {
  await page.route('https://history.clarin.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>History controller QA</title>' }))
  await page.goto('https://history.clarin.test/first')
  await page.addScriptTag({ content: buildNavigationHistoryScript() })
  await page.evaluate(() => {
    const qa = window as any
    for (let n = 1; n <= 5; n += 1) history.pushState({ tree: [n] }, '', `/entry-${n}?exact=${n}#position`)
    qa.calls = 0; qa.delivered = []
    qa.__CLARIN_NAVIGATION_HISTORY__.register({ requestLeave: () => { qa.calls += 1; return new Promise(resolve => { qa.allow = resolve }) }, revision: () => 'dirty' })
    window.addEventListener('popstate', () => qa.delivered.push(location.href))
    history.back(); history.back()
  })
  await expect.poll(() => page.evaluate(() => (window as any).calls)).toBe(1)
  await expect(page).toHaveURL('https://history.clarin.test/entry-5?exact=5#position')
  await page.evaluate(() => { history.back(); history.back(); history.back() })
  await page.waitForTimeout(200)
  await expect(page).toHaveURL('https://history.clarin.test/entry-5?exact=5#position')
  expect(await page.evaluate(() => (window as any).delivered)).toEqual([])
  await page.evaluate(() => (window as any).allow(true))
  await expect(page).toHaveURL('https://history.clarin.test/entry-4?exact=4#position')
  expect(await page.evaluate(() => ({ calls: (window as any).calls, delivered: (window as any).delivered }))).toEqual({ calls: 1, delivered: ['https://history.clarin.test/entry-4?exact=4#position'] })
})
