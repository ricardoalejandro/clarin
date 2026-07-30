import { test, expect } from '@playwright/test'

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://172.29.0.1:3001'

test('entry page keeps the authenticated viewport contract', async ({ page }) => {
  await page.goto(`${baseURL}/`)

  await expect(page.locator('input[type="password"]')).toBeVisible()
  await expect(page.locator('button[type="submit"]')).toBeVisible()
  await expect.poll(
    () => page.evaluate(() => document.documentElement.classList.contains('public-page-scroll'))
  ).toBe(false)

  const htmlOverflow = await page.evaluate(() => getComputedStyle(document.documentElement).overflowY)
  expect(htmlOverflow).toBe('hidden')
})

test('dashboard login page keeps overflow hidden', async ({ page }) => {
  await page.goto(`${baseURL}/login`)

  // En /login no debe haberse aplicado el modo de scroll publico.
  const hasPublicScroll = await page.evaluate(() => document.documentElement.classList.contains('public-page-scroll'))
  expect(hasPublicScroll).toBe(false)

  const htmlOverflow = await page.evaluate(() => getComputedStyle(document.documentElement).overflowY)
  expect(htmlOverflow).toBe('hidden')
})
