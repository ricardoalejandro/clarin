import type { Page } from '@playwright/test'

export async function editorAction(page: Page, name: string) {
  const direct = page.getByRole('button', { name, exact: true })
  if (await direct.isVisible()) return direct
  const menu = page.getByRole('menu', { name: 'Más acciones del editor', exact: true })
  if (!await menu.isVisible()) await page.getByRole('button', { name: 'Más acciones del editor', exact: true }).click()
  return page.getByRole('menuitem', { name, exact: true })
}

export async function clickEditorAction(page: Page, name: string) {
  await (await editorAction(page, name)).click()
}
