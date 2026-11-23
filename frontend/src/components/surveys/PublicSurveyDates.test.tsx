import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import PublicFormPage from '@/app/f/[slug]/page'

vi.mock('next/navigation', () => ({ useParams: () => ({ slug: 'fecha-sintetica' }), useSearchParams: () => new URLSearchParams() }))
afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear() })

function setup(required: boolean, withNext = false, withPrevious = false) {
  const submissions: { answers: { question_id: string; value: string }[] }[] = []
  const questions = [...(withPrevious ? [{ id: 'text-before', type: 'short_text', title: 'Datos previos', description: '', required: false, config: {}, logic_rules: [] }] : []),
    { id: 'date-a', type: 'date', title: 'Fecha de atención', description: '', required, config: {}, logic_rules: [] },
    ...(withNext ? [{ id: 'text-b', type: 'short_text', title: 'Observación', description: '', required: true, config: {}, logic_rules: [] }] : [])]
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/submit')) submissions.push(JSON.parse(String(init?.body)))
    return { ok: true, json: async () => url.endsWith('/fecha-sintetica') ? { survey: { id: 'survey-a', name: 'Fechas', slug: 'fecha-sintetica', status: 'active', branding: {} }, questions } : { success: true } } as Response
  }))
  render(<PublicFormPage />)
  return submissions
}

it('does not submit partial dates or advance on the date input Enter; explicit send uses the ISO snapshot', async () => {
  const submissions = setup(true)
  const input = await screen.findByRole('textbox', { name: 'Fecha de atención' })
  fireEvent.change(input, { target: { value: '20/06/' } })
  fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
  expect(submissions).toEqual([])
  expect(input).toHaveValue('20/06/')
  fireEvent.change(input, { target: { value: '20/06/2026' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(submissions).toEqual([])
  fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
  await waitFor(() => expect(submissions).toHaveLength(1))
  expect(submissions[0].answers).toEqual([{ question_id: 'date-a', value: '2026-06-20' }])
})

it('keeps a complete focused date while moving to another question and includes it in the final response', async () => {
  const submissions = setup(true, true)
  fireEvent.change(await screen.findByRole('textbox', { name: 'Fecha de atención' }), { target: { value: '29/02/2028' } })
  fireEvent.click(screen.getByRole('button', { name: 'Siguiente' }))
  const observation = await screen.findByPlaceholderText('Escribe tu respuesta...')
  fireEvent.change(observation, { target: { value: 'Texto posterior intacto' } })
  fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
  await waitFor(() => expect(submissions).toHaveLength(1))
  expect(submissions[0].answers).toEqual([{ question_id: 'date-a', value: '2028-02-29' }, { question_id: 'text-b', value: 'Texto posterior intacto' }])
})

it('blocks an optional partial date but permits clearing it without inventing an answer', async () => {
  const submissions = setup(false)
  const input = await screen.findByRole('textbox', { name: 'Fecha de atención' })
  fireEvent.change(input, { target: { value: '31/02/2026' } })
  fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
  expect(submissions).toEqual([])
  fireEvent.change(input, { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
  await waitFor(() => expect(submissions).toHaveLength(1))
  expect(submissions[0].answers).toEqual([])
})

it('retains a partial date on Back and preserves the focused complete ISO value through Back and Forward', async () => {
  const submissions = setup(true, false, true)
  fireEvent.change(await screen.findByPlaceholderText('Escribe tu respuesta...'), { target: { value: 'Datos previos conservados' } })
  fireEvent.click(screen.getByRole('button', { name: 'Siguiente' }))
  const date = await screen.findByRole('textbox', { name: 'Fecha de atención' })
  fireEvent.change(date, { target: { value: '29/02/' } })
  fireEvent.click(screen.getByRole('button', { name: 'Pregunta anterior' }))
  expect(date).toBeVisible()
  expect(date).toHaveValue('29/02/')
  expect(screen.getByText('Revisa la fecha antes de volver a la pregunta anterior. Tu respuesta se conserva.')).toBeVisible()
  expect(submissions).toEqual([])

  fireEvent.change(date, { target: { value: '29/02/2028' } })
  fireEvent.focus(date)
  fireEvent.click(screen.getByRole('button', { name: 'Pregunta anterior' }))
  expect(await screen.findByPlaceholderText('Escribe tu respuesta...')).toHaveValue('Datos previos conservados')
  fireEvent.click(screen.getByRole('button', { name: 'Siguiente' }))
  expect(await screen.findByRole('textbox', { name: 'Fecha de atención' })).toHaveValue('29/02/2028')
  fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
  await waitFor(() => expect(submissions).toHaveLength(1))
  expect(submissions[0].answers).toEqual([{ question_id: 'text-before', value: 'Datos previos conservados' }, { question_id: 'date-a', value: '2028-02-29' }])
})
