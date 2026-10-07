import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import {
  authenticateLab, expectInViewport, expectNoHorizontalOverflow, failNext,
  integrityWidths, labRequest, readIntegrityLab, type IntegrityLab,
} from './helpers/integrity-qa'

const lab = readIntegrityLab()

async function openResults(page: Page, qa: IntegrityLab) {
  await page.goto(`${qa.base_url}/dashboard/surveys/${qa.fixture.survey_id}?mode=instance&tab=analytics`, { waitUntil: 'commit' })
  await expect(page.getByRole('heading', { name: /^Respuestas individuales/ })).toBeVisible()
}
async function programHistorySnapshot(page: Page, qa: IntegrityLab) {
  const program = `/api/programs/${qa.fixture.program_id}`
  const [participants, sessions, recipients, responses] = await Promise.all([
    labRequest(page, qa, `${program}/participants`),
    labRequest(page, qa, `${program}/sessions`),
    labRequest(page, qa, `${program}/surveys/${qa.fixture.survey_id}/recipients?limit=200&offset=0`),
    labRequest(page, qa, `/api/surveys/${qa.fixture.survey_id}/responses?limit=50&offset=0`),
  ])
  const allResponses = [...responses.responses]
  for (let offset = 50; offset < responses.total; offset += 50) {
    const next = await labRequest(page, qa, `/api/surveys/${qa.fixture.survey_id}/responses?limit=50&offset=${offset}`)
    expect(next.total).toBe(responses.total)
    expect(next.responses.length).toBeGreaterThan(0)
    allResponses.push(...next.responses)
  }
  expect(new Set(allResponses.map((row: any) => row.id)).size).toBe(responses.total)
  return {
    participants: participants.map((row: any) => ({ id: row.id, contact_id: row.contact_id, enrolled_at: row.enrolled_at, dropped_at: row.dropped_at, completed_at: row.completed_at, status: row.status })),
    sessions: sessions.map((row: any) => ({ id: row.id, date: row.date, status: row.status })),
    recipients: (recipients.recipients || recipients.items || recipients).map((row: any) => ({ id: row.id, contact_id: row.contact_id, program_participant_id: row.program_participant_id })),
    responses: allResponses.map((row: any) => ({ id: row.id, contact_id: row.contact_id, program_id: row.program_id, program_participant_id: row.program_participant_id, recipient_id: row.recipient_id })),
    responsesTotal: responses.total,
  }
}

test.describe('Program and survey integrity on the isolated real API', () => {
  test.describe.configure({ mode: 'default' })
  test.skip(!lab, 'Requires .runtime/qa-lab-credentials.json for the disposable synthetic QA laboratory.')
  test.setTimeout(150_000)
  test.beforeEach(async ({ page }) => { await authenticateLab(page, lab!) })

  for (const width of integrityWidths) {
    test(`program navigation and survey results remain operable at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`${lab!.base_url}/dashboard/programs/${lab!.fixture.program_id}`, { waitUntil: 'commit' })
      await expect(page.getByText(lab!.fixture.contact_name, { exact: true }).first()).toBeVisible()
      const mobileSections = page.getByRole('button', { name: /^Cambiar sección\. Actual:/ })
      if (await mobileSections.isVisible()) {
        await mobileSections.focus()
        await page.keyboard.press('Enter')
        const choices = page.getByRole('dialog', { name: 'Secciones del programa', exact: true })
        await expectInViewport(page, choices)
        await choices.getByRole('button', { name: /^Encuestas Aplicaciones y resultados/ }).click()
      } else await page.getByRole('button', { name: 'Encuestas', exact: true }).click()
      await expectNoHorizontalOverflow(page)
      await page.screenshot({ path: testInfo.outputPath(`program-surveys-${width}.png`) })
      await openResults(page, lab!)
      await expect(page.getByRole('button', { name: 'Ver detalle', exact: true })).toHaveCount(50)
      await expect(page.getByText(/^Mostrando 1-50 de /)).toBeVisible()
      await expectNoHorizontalOverflow(page)
      const nextPage = page.getByRole('button', { name: 'Siguiente', exact: true })
      await nextPage.scrollIntoViewIfNeeded()
      await expectInViewport(page, nextPage)
      await expectInViewport(page, page.getByRole('button', { name: 'Anterior', exact: true }))
      if (width < 768) expect((await nextPage.boundingBox())!.height, 'Mobile pagination must keep a usable touch target').toBeGreaterThanOrEqual(44)
      await nextPage.focus()
      const next = page.waitForResponse(response => {
        const url = new URL(response.url())
        return url.pathname === `/api/surveys/${lab!.fixture.survey_id}/responses` && url.searchParams.get('offset') === '50' && response.ok()
      })
      await page.keyboard.press('Enter')
      await next
      await expect(page.getByText(/^Mostrando 51-/)).toBeVisible()
      await expect(page.getByText(/^Página 2 de /)).toBeVisible()
      await page.screenshot({ path: testInfo.outputPath(`survey-results-${width}.png`) })
    })
  }

  test('a rejected status PATCH leaves the canonical selection and allows one real retry', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    const survey = await labRequest(page, lab!, `/api/surveys/${lab!.fixture.survey_id}`)
    expect(['active', 'closed']).toContain(survey.status)
    const nextStatus = survey.status === 'active' ? 'closed' : 'active'
    const originalLabel = survey.status === 'active' ? 'Activa' : 'Cerrada'
    const nextLabel = nextStatus === 'active' ? 'Activa' : 'Cerrada'
    const rejected = await failNext(page, (url, method) => url.pathname === `/api/surveys/${lab!.fixture.survey_id}/status` && method === 'PATCH', 'QA status permission failure', 403)
    await page.goto(`${lab!.base_url}/dashboard/surveys/${lab!.fixture.survey_id}?mode=instance&tab=share`, { waitUntil: 'commit' })
    await page.getByRole('button', { name: nextLabel, exact: true }).click()
    await expect(page.getByRole('alert').filter({ hasText: 'QA status permission failure' })).toBeVisible()
    expect(rejected.didFail()).toBe(true)
    await expect(page.getByRole('button', { name: originalLabel, exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('button', { name: nextLabel, exact: true })).toBeEnabled()
    expect((await labRequest(page, lab!, `/api/surveys/${lab!.fixture.survey_id}`)).status).toBe(survey.status)
    try {
      const changed = page.waitForResponse(response => new URL(response.url()).pathname === `/api/surveys/${lab!.fixture.survey_id}/status` && response.request().method() === 'PATCH' && response.ok())
      await page.getByRole('button', { name: nextLabel, exact: true }).click()
      await changed
      await expect(page.getByRole('button', { name: nextLabel, exact: true })).toHaveAttribute('aria-pressed', 'true')
      await expect(page.getByRole('alert').filter({ hasText: 'QA status permission failure' })).toHaveCount(0)
      expect((await labRequest(page, lab!, `/api/surveys/${lab!.fixture.survey_id}`)).status).toBe(nextStatus)
    } finally {
      await rejected.remove()
      await labRequest(page, lab!, `/api/surveys/${lab!.fixture.survey_id}/status`, { method: 'PATCH', data: { status: survey.status } })
    }
  })

  test('analytics and response errors are distinct from an empty result and recover independently', async ({ page }) => {
    const analytics = await failNext(page, (url, method) => url.pathname === `/api/surveys/${lab!.fixture.survey_id}/analytics` && method === 'GET', 'QA analytics unavailable')
    const responses = await failNext(page, (url, method) => url.pathname === `/api/surveys/${lab!.fixture.survey_id}/responses` && method === 'GET', 'QA responses unavailable')
    await openResults(page, lab!)
    await expect(page.getByRole('alert').filter({ hasText: 'QA analytics unavailable' })).toBeVisible()
    await expect(page.getByRole('alert').filter({ hasText: 'QA responses unavailable' })).toBeVisible()
    await expect(page.getByText('No hay respuestas aún', { exact: true })).toHaveCount(0)
    expect(analytics.didFail()).toBe(true)
    expect(responses.didFail()).toBe(true)
    await page.getByRole('button', { name: 'Reintentar estadísticas', exact: true }).click()
    await expect(page.getByRole('alert').filter({ hasText: 'QA analytics unavailable' })).toHaveCount(0)
    await expect(page.getByRole('alert').filter({ hasText: 'QA responses unavailable' })).toBeVisible()
    await page.getByRole('button', { name: 'Reintentar respuestas', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Ver detalle', exact: true })).toHaveCount(50)
    await expect(page.getByRole('alert').filter({ hasText: 'QA responses unavailable' })).toHaveCount(0)
    await analytics.remove(); await responses.remove()
  })

  test('failed response pagination preserves mounted rows and canonical page until retry succeeds', async ({ page }) => {
    await openResults(page, lab!)
    await expect(page.getByRole('button', { name: 'Ver detalle', exact: true })).toHaveCount(50)
    const firstRows = await page.getByRole('heading', { name: /^Respuestas individuales/ }).locator('..').locator('..').innerText()
    const rejected = await failNext(page, (url, method) => url.pathname === `/api/surveys/${lab!.fixture.survey_id}/responses` && url.searchParams.get('offset') === '50' && method === 'GET', 'QA page two unavailable')
    await page.getByRole('button', { name: 'Siguiente', exact: true }).click()
    await expect(page.getByRole('alert').filter({ hasText: 'QA page two unavailable' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Ver detalle', exact: true })).toHaveCount(50)
    await expect(page.getByText(/^Mostrando 1-50 de /)).toBeVisible()
    await expect(page.getByText(/^Página 1 de /)).toBeVisible()
    const mounted = await page.getByRole('heading', { name: /^Respuestas individuales/ }).locator('..').locator('..').innerText()
    expect(mounted.replace(/QA page two unavailable[\s\S]*?Reintentar respuestas\s*/, '')).toBe(firstRows)
    await page.getByRole('button', { name: 'Reintentar respuestas', exact: true }).click()
    await expect(page.getByText(/^Mostrando 51-/)).toBeVisible()
    await expect(page.getByText(/^Página 2 de /)).toBeVisible()
    await expect(page.getByRole('alert').filter({ hasText: 'QA page two unavailable' })).toHaveCount(0)
    await rejected.remove()
  })

  test('real results XLSX is downloadable and contains a workbook rather than a failed JSON response', async ({ page }) => {
    await openResults(page, lab!)
    const downloaded = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Exportar resultados', exact: true }).click()
    const download = await downloaded
    expect(download.suggestedFilename()).toMatch(/\.xlsx$/)
    const bytes = await readFile((await download.path())!)
    expect(bytes.subarray(0, 2).toString()).toBe('PK')
    expect(bytes.length).toBeGreaterThan(1000)
  })

  test('a retained Program rejects deletion and archive/restore preserves participation and frozen survey identities', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    const programPath = `/api/programs/${lab!.fixture.program_id}`
    const original = await labRequest(page, lab!, programPath)
    expect(original.status).toBe('active')
    const before = await programHistorySnapshot(page, lab!)
    expect(before.participants.some((row: any) => row.id === lab!.fixture.program_participant_id && row.contact_id === lab!.fixture.contact_id)).toBe(true)
    expect(before.sessions.length).toBeGreaterThan(0)
    expect(before.recipients.length).toBeGreaterThan(0)
    expect(before.responsesTotal).toBeGreaterThan(50)
    await page.goto(`${lab!.base_url}/dashboard/programs/${lab!.fixture.program_id}`, { waitUntil: 'commit' })
    await page.getByTitle('Más opciones', { exact: true }).click()
    await page.getByRole('button', { name: 'Eliminar Programa', exact: true }).click()
    await expect(page.getByText(/¿Eliminar este programa vacío\?/)).toBeVisible()
    const deletion = page.waitForResponse(response => new URL(response.url()).pathname === programPath && response.request().method() === 'DELETE')
    await page.getByRole('button', { name: 'Confirmar', exact: true }).click()
    const denied = await deletion
    expect(denied.status()).toBe(409)
    expect((await denied.json()).code).toBe('PROGRAM_HAS_DEPENDENCIES')
    await expect(page.getByText(/Archívalo para conservar su historial/)).toBeVisible()
    expect(await programHistorySnapshot(page, lab!)).toEqual(before)
    try {
      await page.getByTitle('Más opciones', { exact: true }).click()
      const archive = page.waitForRequest(request => new URL(request.url()).pathname === programPath && request.method() === 'PUT')
      await page.getByRole('button', { name: 'Archivar', exact: true }).click()
      expect((await archive).postDataJSON().expected_updated_at).toBeTruthy()
      await expect.poll(async () => (await labRequest(page, lab!, programPath)).status).toBe('archived')
      expect(await programHistorySnapshot(page, lab!)).toEqual(before)
      await page.goto(`${lab!.base_url}/dashboard/programs`, { waitUntil: 'commit' })
      await page.getByRole('combobox', { name: 'Estado de programas', exact: true }).selectOption('archived')
      await expect(page.getByRole('link', { name: new RegExp(original.name) }).first()).toBeVisible()
      await page.goto(`${lab!.base_url}/dashboard/programs/${lab!.fixture.program_id}`, { waitUntil: 'commit' })
      await page.getByTitle('Más opciones', { exact: true }).click()
      await page.getByRole('button', { name: 'Desarchivar', exact: true }).click()
      await expect.poll(async () => (await labRequest(page, lab!, programPath)).status).toBe('active')
      expect(await programHistorySnapshot(page, lab!)).toEqual(before)
    } finally {
      const canonical = await labRequest(page, lab!, programPath)
      if (canonical.status !== original.status) await labRequest(page, lab!, programPath, { method: 'PUT', data: { ...canonical, status: original.status, expected_updated_at: canonical.updated_at } })
    }
  })
})
