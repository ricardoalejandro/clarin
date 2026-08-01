import { expect, test, type Page, type Route } from '@playwright/test'

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3011'
const sourceID = '10000000-0000-4000-8000-000000000010'
const copyID = '10000000-0000-4000-8000-000000000011'
const now = '2026-08-01T05:00:00.000Z'

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

function template(id: string, name: string) {
  return {
    id,
    account_id: '20000000-0000-4000-8000-000000000001',
    name,
    description: 'Seguimiento del programa',
    status: 'active',
    welcome_title: '',
    welcome_description: '',
    thank_you_title: 'Gracias',
    thank_you_message: '',
    thank_you_redirect_url: '',
    branding: {},
    measurement_config: { dimensions: [{ key: 'bienestar', name: 'Bienestar', minimum_answered_ratio: 1 }] },
    revision: 1,
    question_count: 2,
    instance_count: 0,
    response_count: 0,
    created_at: now,
    updated_at: now,
  }
}

async function installSurveyMock(page: Page) {
  let duplicateBody: { name?: string } | null = null
  await page.addInitScript(() => {
    const timestamp = String(Date.now())
    localStorage.setItem('token', 'cookie-session')
    localStorage.setItem('clarin:auth_refreshed_at', timestamp)
    localStorage.setItem('clarin:last_activity_at', timestamp)
  })
  await page.context().addCookies([{
    name: 'refresh-token',
    value: 'playwright-survey-session',
    url: baseURL,
    httpOnly: true,
    sameSite: 'Lax',
  }])
  await page.route('**/api/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/me') return json(route, {
      success: true,
      user: { id: 'user-surveys', username: 'encuestas_qa', display_name: 'Encuestas QA', role: 'admin', is_admin: true, account_id: '20000000-0000-4000-8000-000000000001', account_name: 'Cuenta QA', permissions: ['surveys'] },
      accounts: [{ account_id: '20000000-0000-4000-8000-000000000001', account_name: 'Cuenta QA', role: 'admin', is_default: true }],
    })
    if (path === '/api/survey-templates' && request.method() === 'GET') return json(route, [template(sourceID, 'Bienestar inicial')])
    if (path === `/api/survey-templates/${sourceID}/duplicate` && request.method() === 'POST') {
      duplicateBody = request.postDataJSON()
      return json(route, template(copyID, duplicateBody?.name || 'Copia'))
    }
    if (path === `/api/survey-templates/${copyID}`) return json(route, template(copyID, 'Bienestar seguimiento'))
    if (path === `/api/survey-templates/${copyID}/questions`) return json(route, [])
    if (path === '/api/version') return json(route, { version: 'test' })
    return json(route, { success: true })
  })
  return { duplicateBody: () => duplicateBody }
}

test('duplica una plantilla aislada y abre la copia en edición', async ({ page }) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 375, height: 667 })
  const mock = await installSurveyMock(page)
  await page.goto(`${baseURL}/dashboard/surveys`, { waitUntil: 'domcontentloaded' })

  await page.getByRole('button', { name: 'Duplicar Bienestar inicial' }).click()
  const dialog = page.getByRole('dialog', { name: 'Duplicar plantilla' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('No se copiarán aplicaciones, enlaces, destinatarios, respuestas ni resultados')
  await expect(dialog.getByLabel('Nombre de la copia')).toHaveValue('Copia de Bienestar inicial')
  await dialog.getByLabel('Nombre de la copia').fill('Bienestar seguimiento')
  await dialog.getByRole('button', { name: 'Duplicar y editar' }).click()

  await expect.poll(mock.duplicateBody).toEqual({ name: 'Bienestar seguimiento' })
  await expect(page).toHaveURL(new RegExp(`/dashboard/surveys/${copyID}`), { timeout: 20_000 })
  await expect(page.getByRole('heading', { name: 'Bienestar seguimiento' })).toBeVisible()
})
