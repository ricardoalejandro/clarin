import { expect, test, type Page, type Route } from '@playwright/test'

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3011'
const surveyID = '30000000-0000-4000-8000-000000000001'
const templateID = '30000000-0000-4000-8000-000000000002'
const questionID = '30000000-0000-4000-8000-000000000003'
const choiceQuestionID = '30000000-0000-4000-8000-000000000004'
const now = '2026-08-01T15:00:00.000Z'

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

async function installSurveyDetailMocks(page: Page, options: { failFirstExport?: boolean } = {}) {
  let archived = false
  let exportAttempts = 0
  const exportPayloads: Array<{ chart_types?: Record<string, string> }> = []
  await page.addInitScript(() => {
    const timestamp = String(Date.now())
    localStorage.setItem('token', 'cookie-session')
    localStorage.setItem('clarin:auth_refreshed_at', timestamp)
    localStorage.setItem('clarin:last_activity_at', timestamp)
  })
  await page.context().addCookies([{ name: 'refresh-token', value: 'survey-lifecycle-qa', url: baseURL, httpOnly: true, sameSite: 'Lax' }])
  await page.route('**/api/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/me') return json(route, {
      success: true,
      user: { id: 'survey-user', username: 'survey_user', display_name: 'Survey QA', role: 'admin', is_admin: true, account_id: 'survey-account', account_name: 'QA', permissions: ['surveys'] },
      accounts: [{ account_id: 'survey-account', account_name: 'QA', role: 'admin', is_default: true }],
    })
    if (path === '/api/version') return json(route, { version: 'test' })
    if (path === `/api/surveys/${surveyID}` && request.method() === 'GET') return json(route, {
      id: surveyID, account_id: 'survey-account', template_id: templateID, template_revision: 4,
      name: 'Seguimiento de experiencia', description: '', slug: 'seguimiento-experiencia',
      status: archived ? 'closed' : 'active', welcome_title: '', welcome_description: '',
      thank_you_title: 'Gracias', thank_you_message: '', thank_you_redirect_url: '', branding: {},
      measurement_config: { dimensions: [] }, analytics_tracking_started_at: now, is_template: false,
      origin_type: 'standalone', origin_label: 'Aplicación independiente', audience_mode: 'public',
      legacy_instance: false, archived_at: archived ? now : undefined, created_at: now, updated_at: now,
      question_count: 2, response_count: 2, can_delete: false, can_archive: !archived,
      can_restore: archived, deletion_block_reason: 'has_responses',
    })
    if (path === `/api/surveys/${surveyID}/questions`) return json(route, [
      {
        id: questionID, survey_id: surveyID, order_index: 0, type: 'long_text',
        title: '¿Qué deberíamos mejorar?', description: '', required: false, config: {}, logic_rules: [],
        created_at: now, updated_at: now,
      },
      {
        id: choiceQuestionID, survey_id: surveyID, order_index: 1, type: 'single_choice',
        title: '¿Recomendarías el programa?', description: '', required: false, config: { options: ['Sí', 'No'] }, logic_rules: [],
        created_at: now, updated_at: now,
      },
    ])
    if (path === `/api/surveys/${surveyID}/analytics`) return json(route, {
      total_responses: 2, completion_rate: 100, avg_completion_seconds: 75,
      funnel: { tracking_started_at: now, opened_count: 2, started_count: 2, completed_count: 2, abandoned_count: 0, question_dropoff: [] },
      question_stats: [
        { question_id: questionID, question_type: 'long_text', title: '¿Qué deberíamos mejorar?', total_answers: 2 },
        { question_id: choiceQuestionID, question_type: 'single_choice', title: '¿Recomendarías el programa?', total_answers: 2, option_counts: { Sí: 2, No: 0 } },
      ],
    })
    if (path === `/api/surveys/${surveyID}/responses`) return json(route, { responses: [], total: 0 })
    if (path === `/api/surveys/${surveyID}/questions/${questionID}/text-answers`) return json(route, {
      items: [{ id: 'answer-1', response_id: 'response-1', value: 'Primera línea\nSegunda línea con el detalle completo.', completed_at: now }],
      total: 1,
    })
    if (path === `/api/surveys/${surveyID}/export/xlsx` && request.method() === 'POST') {
      exportAttempts += 1
      exportPayloads.push(request.postDataJSON())
      await new Promise(resolve => setTimeout(resolve, 120))
      if (options.failFirstExport && exportAttempts === 1) return json(route, { error: 'No se pudo generar el informe de prueba.' }, 500)
      return route.fulfill({
        status: 200,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        headers: { 'Content-Disposition': 'attachment; filename="resultados_seguimiento_2026-08-02.xlsx"' },
        body: Buffer.from('mock-xlsx'),
      })
    }
    if (path === `/api/surveys/${surveyID}/archive` && request.method() === 'POST') {
      archived = true
      return json(route, {
        id: surveyID, account_id: 'survey-account', template_id: templateID, template_revision: 4,
        name: 'Seguimiento de experiencia', slug: 'seguimiento-experiencia', status: 'closed',
        origin_type: 'standalone', origin_label: 'Aplicación independiente', audience_mode: 'public',
        legacy_instance: false, archived_at: now, archived_from_status: 'active',
        analytics_tracking_started_at: now, question_count: 1, recipient_count: 0, response_count: 2,
        can_delete: false, can_archive: false, can_restore: true, deletion_block_reason: 'has_responses',
        created_at: now, updated_at: now,
      })
    }
    return json(route, { success: true })
  })
  return { getExportAttempts: () => exportAttempts, exportPayloads }
}

test('muestra observaciones completas y cierra todas las acciones públicas al archivar', async ({ page }) => {
  await installSurveyDetailMocks(page)
  await page.setViewportSize({ width: 1280, height: 760 })
  await page.goto(`${baseURL}/dashboard/surveys/${surveyID}?mode=instance&tab=analytics`, { waitUntil: 'domcontentloaded' })

  await page.getByRole('button', { name: /2 respuestas de texto/ }).click()
  await expect(page.getByText('Respuesta anónima')).toBeVisible()
  await expect(page.getByText(/Primera línea/)).toHaveCSS('white-space', 'pre-wrap')
  await expect(page.getByText(/Segunda línea con el detalle completo/)).toBeVisible()

  await page.getByRole('button', { name: 'Archivar aplicación' }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Archivar aplicación' })
  await expect(dialog).toContainText('quedará cerrada')
  await dialog.getByRole('button', { name: 'Archivar' }).click()
  await expect(page.getByText(/Aplicación archivada: conserva resultados/)).toBeVisible()

  await page.getByRole('button', { name: 'Compartir' }).click()
  await expect(page.getByRole('button', { name: /Copiar enlace/ })).toBeDisabled()
  await expect(page.getByRole('heading', { name: 'Código QR' })).toHaveCount(0)
})

test('exporta toda la analítica en Excel, conserva el gráfico elegido y reintenta sin doble envío', async ({ page }) => {
  const exportState = await installSurveyDetailMocks(page, { failFirstExport: true })
  await page.setViewportSize({ width: 886, height: 622 })
  await page.goto(`${baseURL}/dashboard/surveys/${surveyID}?mode=instance&tab=analytics`, { waitUntil: 'domcontentloaded' })

  const exportButton = page.getByRole('button', { name: 'Exportar resultados' })
  for (const viewport of [
    { width: 320, height: 568 }, { width: 375, height: 667 }, { width: 768, height: 720 },
    { width: 886, height: 622 }, { width: 1024, height: 720 }, { width: 1280, height: 800 }, { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport)
    await expect(exportButton).toBeVisible()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow, `desborde horizontal en ${viewport.width}×${viewport.height}`).toBeLessThanOrEqual(0)
    const size = await exportButton.boundingBox()
    expect(size?.height || 0).toBeGreaterThanOrEqual(44)
  }
  await page.setViewportSize({ width: 886, height: 622 })
  await expect(page.getByText('Exportar CSV')).toHaveCount(0)
  await page.getByTitle('Circular').click()

  await page.getByRole('button', { name: 'Exportar resultados' }).dblclick()
  await expect(page.getByRole('button', { name: 'Generando Excel…' })).toBeVisible()
  await expect(page.locator('#survey-export-error')).toContainText('No se pudo generar el informe de prueba.')
  expect(exportState.getExportAttempts()).toBe(1)
  expect(exportState.exportPayloads[0].chart_types).toEqual({ [questionID]: 'bar', [choiceQuestionID]: 'pie' })

  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Reintentar' }).click()
  const completedDownload = await download
  expect(completedDownload.suggestedFilename()).toBe('resultados_seguimiento_2026-08-02.xlsx')
  expect(exportState.getExportAttempts()).toBe(2)
})
