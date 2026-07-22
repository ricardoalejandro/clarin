import { expect, test } from '@playwright/test'

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3001'

test('la lógica condicional omite una requerida y Atrás conserva el recorrido real', async ({ page }) => {
  const firstID = '10000000-0000-4000-8000-000000000001'
  const skippedID = '10000000-0000-4000-8000-000000000002'
  const finalID = '10000000-0000-4000-8000-000000000003'
  let submittedPayload: { answers?: Array<{ question_id: string; value: string }> } | null = null

  await page.route('**/api/public/surveys/flujo-condicional?recipient=destinatario-1', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
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
  expect(submittedPayload).not.toBeNull()
  expect(submittedPayload!.answers?.map(answer => answer.question_id)).toEqual([firstID, finalID])
})
