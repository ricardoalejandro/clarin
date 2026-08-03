import { expect, test } from '@playwright/test'

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3001'

test('un enlace retirado muestra un cierre permanente y accesible', async ({ page }) => {
  await page.route('**/api/public/surveys/enlace-retirado', route => route.fulfill({
    status: 410,
    contentType: 'application/json',
    body: JSON.stringify({ code: 'survey_link_retired', error: 'Este enlace de encuesta fue retirado' }),
  }))
  await page.goto(`${baseURL}/f/enlace-retirado`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('Este enlace de encuesta fue retirado permanentemente y ya no está disponible.')).toBeVisible()
})

test('la lógica condicional omite una requerida y Atrás conserva el recorrido real', async ({ page }) => {
  const firstID = '10000000-0000-4000-8000-000000000001'
  const skippedID = '10000000-0000-4000-8000-000000000002'
  const finalID = '10000000-0000-4000-8000-000000000003'
  let submittedPayload: { answers?: Array<{ question_id: string; value: string }> } | null = null
  const trackedPhases: Array<{ phase: string; question_id?: string }> = []
  let openedSessionToken = ''

  await page.route('**/api/public/surveys/flujo-condicional/session', async route => {
    trackedPhases.push(route.request().postDataJSON())
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) })
  })

  await page.route('**/api/public/surveys/flujo-condicional?recipient=destinatario-1', async route => {
    openedSessionToken = route.request().headers()['x-survey-session-token'] || ''
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        respondent_token: openedSessionToken,
        survey: {
          id: '20000000-0000-4000-8000-000000000001',
          name: 'Encuesta condicional',
          description: '',
          slug: 'flujo-condicional',
          status: 'active',
          welcome_title: '',
          welcome_description: '',
          thank_you_title: 'Respuesta registrada',
          thank_you_message: 'Gracias',
          thank_you_redirect_url: '',
          branding: {},
        },
        questions: [
          {
            id: firstID,
            type: 'single_choice',
            title: '¿Deseas omitir la segunda pregunta?',
            description: '',
            required: true,
            config: { options: ['Sí', 'No'] },
            logic_rules: [{ value: 'Sí', operator: 'eq', jump_to: finalID }],
          },
          {
            id: skippedID,
            type: 'short_text',
            title: 'Esta pregunta requerida debe omitirse',
            description: '',
            required: true,
            config: {},
            logic_rules: [],
          },
          {
            id: finalID,
            type: 'short_text',
            title: 'Pregunta final',
            description: '',
            required: true,
            config: {},
            logic_rules: [],
          },
        ],
      }),
    })
  })
  await page.route('**/api/public/surveys/flujo-condicional/submit', async route => {
    submittedPayload = route.request().postDataJSON()
    await new Promise(resolve => setTimeout(resolve, 80))
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ success: true }) })
  })

  await page.goto(`${baseURL}/f/flujo-condicional?recipient=destinatario-1`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Sí' }).click()
  await page.getByRole('button', { name: /Siguiente$/ }).click()
  await expect(page.getByRole('heading', { name: 'Pregunta final' })).toBeVisible()
  await expect(page.getByText('Esta pregunta requerida debe omitirse')).toHaveCount(0)

  await page.getByRole('button', { name: 'Pregunta anterior' }).click()
  await expect(page.getByRole('heading', { name: '¿Deseas omitir la segunda pregunta?' })).toBeVisible()
  await page.getByRole('button', { name: /Siguiente$/ }).click()
  await page.getByPlaceholder('Escribe tu respuesta...').fill('Completado')
  await page.getByRole('button', { name: 'Enviar' }).click()

  await expect(page.getByRole('heading', { name: 'Respuesta registrada' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Cerrar' })).toBeVisible()
  expect(submittedPayload).not.toBeNull()
  expect(submittedPayload!.answers?.map(answer => answer.question_id)).toEqual([firstID, finalID])
  expect(openedSessionToken).toMatch(/^[0-9a-f-]{36}$/)
  expect(trackedPhases.some(event => event.phase === 'opened')).toBe(false)
  expect(trackedPhases.some(event => event.phase === 'started')).toBe(true)
  expect(trackedPhases.some(event => event.phase === 'reached' && event.question_id === finalID)).toBe(true)
  expect(trackedPhases.some(event => event.phase === 'answered' && event.question_id === firstID)).toBe(true)
  expect(trackedPhases.some(event => event.question_id === skippedID)).toBe(false)
})

test('el formulario público respeta reducción de movimiento y no desborda los anchos objetivo', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.route('**/api/public/surveys/responsive/session', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))
  await page.route('**/api/public/surveys/responsive', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      survey: {
        id: 'survey-responsive', name: 'Encuesta responsive', slug: 'responsive', status: 'active',
        welcome_title: 'Una encuesta clara en cualquier pantalla', welcome_description: 'El contenido conserva sus proporciones y áreas seguras.',
        thank_you_title: 'Gracias', thank_you_message: 'Respuesta enviada', thank_you_redirect_url: '',
        branding: { accent_color: '#047857', bg_color: '#FFFFFF', text_color: '#0F172A', button_style: 'rounded' },
      },
      questions: [{ id: 'question-responsive', type: 'long_text', title: 'Cuéntanos tu experiencia', description: '', required: false, config: {}, logic_rules: [] }],
    }),
  }))

  for (const viewport of [
    { width: 320, height: 568 }, { width: 375, height: 667 }, { width: 768, height: 720 },
    { width: 1046, height: 622 }, { width: 1280, height: 720 }, { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport)
    await page.goto(`${baseURL}/f/responsive`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('button', { name: /Comenzar/ })).toBeVisible()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow, `desborde horizontal en ${viewport.width}×${viewport.height}`).toBeLessThanOrEqual(0)
    await expect(page.locator('.survey-step-enter')).toHaveCSS('animation-name', 'none')
  }

  await page.setViewportSize({ width: 375, height: 667 })
  await page.goto(`${baseURL}/f/responsive`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /Comenzar/ }).click()
  const longText = page.getByPlaceholder('Escribe tu respuesta...')
  await longText.fill('Primera línea')
  await longText.press('Enter')
  await longText.type('Segunda línea')
  await expect(page.getByRole('heading', { name: 'Cuéntanos tu experiencia' })).toBeVisible()
  await expect(longText).toHaveValue('Primera línea\nSegunda línea')
})
