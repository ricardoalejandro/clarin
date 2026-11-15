import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import type { SurveyTemplate } from '@/types/survey-template'
import StandaloneSurveyApplicationDialog from './StandaloneSurveyApplicationDialog'

vi.mock('@/lib/api', () => ({ api: vi.fn() }))
vi.mock('./SurveyInstanceNameField', () => ({ default: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => <input aria-label="Nombre de aplicación" value={value} onChange={event => onChange(event.target.value)} /> }))
const template = { id: 'template-a', revision: 2 } as SurveyTemplate
afterEach(() => { cleanup(); vi.clearAllMocks() })

function open() {
  const onCreated = vi.fn()
  render(<StandaloneSurveyApplicationDialog template={template} onClose={vi.fn()} onCreated={onCreated} />)
  fireEvent.change(screen.getByRole('textbox', { name: 'Nombre de aplicación' }), { target: { value: 'Aplicación con fechas' } })
  return onCreated
}

it('blocks a partial date/time, retains the draft, then submits the latest focused complete values once', async () => {
  vi.mocked(api).mockResolvedValue({ success: true, status: 200, data: { id: 'application-a' } })
  const onCreated = open()
  const date = screen.getByRole('textbox', { name: 'Apertura' })
  const time = screen.getByRole('textbox', { name: 'Apertura: hora' })
  fireEvent.change(date, { target: { value: '05/09/' } })
  fireEvent.click(screen.getByRole('button', { name: 'Crear aplicación' }))
  expect(api).not.toHaveBeenCalled()
  expect(date).toHaveValue('05/09/')
  fireEvent.change(date, { target: { value: '05/09/2026' } })
  fireEvent.change(time, { target: { value: '10:' } })
  fireEvent.click(screen.getByRole('button', { name: 'Crear aplicación' }))
  expect(api).not.toHaveBeenCalled()
  fireEvent.focus(time)
  fireEvent.change(time, { target: { value: '10:30' } })
  fireEvent.click(screen.getByRole('button', { name: 'Crear aplicación' }))
  await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
  expect(api).toHaveBeenCalledTimes(1)
  expect(JSON.parse(String(vi.mocked(api).mock.calls[0][1]?.body))).toMatchObject({
    opens_at: new Date('2026-09-05T10:30').toISOString(), closes_at: null,
  })
})

it('preserves an invalid range and retries with the corrected closing snapshot without shifting the opening', async () => {
  vi.mocked(api).mockResolvedValue({ success: false, status: 503, error: 'Conexión temporalmente no disponible' })
  open()
  for (const [label, date] of [['Apertura', '05/09/2026'], ['Cierre', '04/09/2026']]) {
    fireEvent.change(screen.getByRole('textbox', { name: label }), { target: { value: date } })
    fireEvent.change(screen.getByRole('textbox', { name: `${label}: hora` }), { target: { value: '12:00' } })
  }
  fireEvent.click(screen.getByRole('button', { name: 'Crear aplicación' }))
  expect(api).not.toHaveBeenCalled()
  expect(screen.getByRole('alert')).toHaveTextContent('El cierre debe ser posterior a la apertura')
  fireEvent.change(screen.getByRole('textbox', { name: 'Cierre' }), { target: { value: '06/09/2026' } })
  fireEvent.click(screen.getByRole('button', { name: 'Crear aplicación' }))
  await screen.findByText('Conexión temporalmente no disponible')
  expect(api).toHaveBeenCalledTimes(1)
  expect(JSON.parse(String(vi.mocked(api).mock.calls[0][1]?.body))).toMatchObject({
    opens_at: new Date('2026-09-05T12:00').toISOString(), closes_at: new Date('2026-09-06T12:00').toISOString(),
  })
  expect(screen.getByRole('textbox', { name: 'Apertura' })).toHaveValue('05/09/2026')
  expect(screen.getByRole('textbox', { name: 'Cierre' })).toHaveValue('06/09/2026')
})
