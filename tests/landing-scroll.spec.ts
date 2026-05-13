import { test, expect } from '@playwright/test'

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://172.29.0.1:3001'

test('landing page scroll is enabled', async ({ page }) => {
  await page.goto(`${baseURL}/`)

  await expect.poll(
    () => page.evaluate(() => document.documentElement.classList.contains('public-page-scroll'))
  ).toBe(true)

  const htmlOverflow = await page.evaluate(() => getComputedStyle(document.documentElement).overflowY)
  expect(htmlOverflow).toBe('visible')

  const bodyOverflow = await page.evaluate(() => getComputedStyle(document.body).overflowY)
  expect(bodyOverflow).toBe('visible')

  const htmlMaxHeight = await page.evaluate(() => getComputedStyle(document.documentElement).maxHeight)
  expect(htmlMaxHeight).toBe('none')

  const bodyMaxHeight = await page.evaluate(() => getComputedStyle(document.body).maxHeight)
  expect(bodyMaxHeight).toBe('none')

  const htmlContain = await page.evaluate(() => getComputedStyle(document.documentElement).contain)
  expect(htmlContain).toBe('none')

  // Verificar que realmente se pueda hacer scroll
  const canScroll = await page.evaluate(() => {
    return document.documentElement.scrollHeight > window.innerHeight
  })
  expect(canScroll).toBe(true)

  // Simular la rueda del mouse: esto cubre el bug donde scrollTo funcionaba
  // pero Chrome/otros navegadores no bajaban con la rueda.
  await page.mouse.move(640, 360)
  await page.mouse.wheel(0, 900)
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
})

test('dashboard login page keeps overflow hidden', async ({ page }) => {
  await page.goto(`${baseURL}/login`)

  // En /login no debe haberse aplicado el modo de scroll publico.
  const hasPublicScroll = await page.evaluate(() => document.documentElement.classList.contains('public-page-scroll'))
  expect(hasPublicScroll).toBe(false)

  const htmlOverflow = await page.evaluate(() => getComputedStyle(document.documentElement).overflowY)
  expect(htmlOverflow).toBe('hidden')
})
