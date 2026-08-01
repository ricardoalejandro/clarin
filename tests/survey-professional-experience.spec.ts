import { expect, test, type Page, type Route } from '@playwright/test'

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3011'
const templateID = '10000000-0000-4000-8000-000000000021'
const now = '2026-08-01T05:00:00.000Z'
const transparentPNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

function surveyTemplate(status: 'active' | 'archived' = 'active', branding: Record<string, unknown> = {}) {
  return {
    id: templateID, account_id: 'account-survey-qa', name: 'Seguimiento profesional', description: 'Encuesta mensual', status,
    welcome_title: 'Queremos escucharte', welcome_description: 'Solo tomará unos minutos', thank_you_title: 'Gracias', thank_you_message: 'Respuesta enviada', thank_you_redirect_url: '',
    branding, measurement_config: { dimensions: [] }, revision: 2, question_count: 4, instance_count: 2, response_count: 8, created_at: now, updated_at: now,
  }
}

async function installAuthenticatedSurveyMocks(page: Page) {
  let archived = false
  let designBody: Buffer | null = null
  await page.addInitScript(() => {
    const timestamp = String(Date.now())
    localStorage.setItem('token', 'cookie-session')
    localStorage.setItem('clarin:auth_refreshed_at', timestamp)
    localStorage.setItem('clarin:last_activity_at', timestamp)
  })
  await page.context().addCookies([{ name: 'refresh-token', value: 'survey-qa', url: baseURL, httpOnly: true, sameSite: 'Lax' }])
  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    if (path === '/api/me') return json(route, {
      success: true,
      user: { id: 'user-survey-qa', username: 'survey_qa', display_name: 'Survey QA', role: 'admin', is_admin: true, account_id: 'account-survey-qa', account_name: 'QA', permissions: ['surveys'] },
      accounts: [{ account_id: 'account-survey-qa', account_name: 'QA', role: 'admin', is_default: true }],
    })
    if (path === '/api/version') return json(route, { version: 'test' })
    if (path.startsWith('/api/media/file/')) return route.fulfill({ status: 200, contentType: 'image/png', body: transparentPNG })
    if (path === '/api/survey-templates' && request.method() === 'GET') return json(route, [surveyTemplate(archived ? 'archived' : 'active')])
    if (path === `/api/survey-templates/${templateID}` && request.method() === 'PATCH') {
      archived = request.postDataJSON()?.status === 'archived'
      return json(route, surveyTemplate(archived ? 'archived' : 'active'))
    }
    if (path === `/api/survey-templates/${templateID}` && request.method() === 'GET') return json(route, surveyTemplate())
    if (path === `/api/survey-templates/${templateID}/questions`) return json(route, [])
    if (path === `/api/survey-templates/${templateID}/instance-name`) {
      const requested = url.searchParams.get('name') || ''
      if (!requested || requested === 'Seguimiento profesional') return json(route, { available: requested === '', suggested_name: 'Seguimiento profesional · 2' })
      return json(route, { available: true, suggested_name: requested })
    }
    if (path === `/api/survey-templates/${templateID}/instances` && request.method() === 'GET') return json(route, [])
    if (path === `/api/survey-templates/${templateID}/instances` && request.method() === 'POST') return json(route, {
      id: 'survey-instance-new', account_id: 'account-survey-qa', template_id: templateID, template_revision: 2,
      origin_type: 'standalone', origin_label: 'Aplicación independiente', name: request.postDataJSON()?.name,
      slug: 'seguimiento-profesional-2', status: 'active', audience_mode: 'public', legacy_instance: false,
      analytics_tracking_started_at: now, question_count: 4, recipient_count: 0, response_count: 0, created_at: now, updated_at: now,
    }, 201)
    if (path === `/api/survey-templates/${templateID}/design` && request.method() === 'PUT') {
      designBody = request.postDataBuffer()
      return json(route, surveyTemplate('active', { accent_color: '#2DD4BF', bg_color: '#0F172A', text_color: '#F8FAFC', font_family: 'Space Grotesk', button_style: 'pill', logo_url: '/api/media/file/account-survey-qa/surveys/logo.png' }))
    }
    return json(route, { success: true })
  })
  return { archived: () => archived, designBody: () => designBody }
}

test('persiste fichas, lista y compacta, y confirma antes de archivar', async ({ page }) => {
  const mock = await installAuthenticatedSurveyMocks(page)
  await page.setViewportSize({ width: 1440, height: 760 })
  await page.goto(`${baseURL}/dashboard/surveys`, { waitUntil: 'domcontentloaded' })

  await page.getByRole('button', { name: 'Lista' }).click()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('clarin.surveys.catalog.view.v1'))).toBe('list')
  await expect(page.getByText('Actualizada')).toBeVisible()

  await page.getByRole('button', { name: 'Compacta' }).click()
  await expect(page.getByRole('group', { name: 'Vista del catálogo' })).toBeVisible()
  await expect(page.getByLabel('Acciones de Seguimiento profesional')).toBeVisible()

  await page.getByRole('button', { name: 'Fichas' }).click()
  await page.getByRole('button', { name: 'Archivar plantilla' }).click()
  const dialog = page.getByRole('dialog', { name: 'Archivar plantilla' })
  await expect(dialog).toContainText('Se conservarán todos los datos y enlaces existentes')
  await expect(dialog).toContainText('8')
  await dialog.getByRole('button', { name: 'Archivar' }).click()
  await expect.poll(mock.archived).toBe(true)
})

test('fuerza fichas en móvil aunque la preferencia persistida sea lista', async ({ page }) => {
  await installAuthenticatedSurveyMocks(page)
  await page.setViewportSize({ width: 375, height: 667 })
  await page.addInitScript(() => localStorage.setItem('clarin.surveys.catalog.view.v1', 'list'))
  await page.goto(`${baseURL}/dashboard/surveys`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByLabel('Editar Seguimiento profesional')).toBeVisible()
  await expect(page.getByText('Preguntas')).toBeVisible()
})

test('mantiene guardado fijo, carga logo y refleja la pantalla final', async ({ page }, testInfo) => {
  const mock = await installAuthenticatedSurveyMocks(page)
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`${baseURL}/dashboard/surveys/${templateID}?mode=template`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Diseño' }).click()
  await page.getByRole('button', { name: /Nocturno/ }).click()

  await page.locator('input[type="file"]').first().setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: transparentPNG })
  await expect(page.getByText('Cambios sin guardar')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Guardar diseño' })).toBeVisible()
  await page.getByRole('button', { name: 'Guardar diseño' }).click()
  await expect.poll(() => mock.designBody()?.includes(Buffer.from('logo.png')) || false).toBe(true)
  await expect(page.getByText(/Diseño de plantilla guardado/)).toBeVisible()

  await page.getByRole('button', { name: 'Gracias' }).click()
  await expect(page.getByRole('button', { name: 'Cerrar', exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('survey-design-thanks.png'), fullPage: true })
})

test('detecta un nombre de aplicación repetido a los 500 ms y ofrece el ordinal libre', async ({ page }) => {
  await installAuthenticatedSurveyMocks(page)
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`${baseURL}/dashboard/surveys/${templateID}?mode=template`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Aplicaciones' }).click()
  await page.getByRole('button', { name: 'Aplicar plantilla' }).click()
  const dialog = page.getByRole('dialog', { name: 'Aplicación pública' })
  const name = dialog.getByLabel('Nombre de esta aplicación')
  await expect(name).toHaveValue('Seguimiento profesional · 2')
  await name.fill('Seguimiento profesional')
  await expect(dialog.getByRole('button', { name: /Usar “Seguimiento profesional · 2”/ })).toBeVisible({ timeout: 2_000 })
  await dialog.getByRole('button', { name: /Usar “Seguimiento profesional · 2”/ }).click()
  await expect(name).toHaveValue('Seguimiento profesional · 2')
})
