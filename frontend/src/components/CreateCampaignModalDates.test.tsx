import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import CreateCampaignModal from './CreateCampaignModal'

vi.mock('@/components/chat/MessageBubble', () => ({ default: () => null }))
vi.mock('@/components/chat/EmojiPicker', () => ({ default: () => null }))
vi.mock('@/components/WhatsAppTextInput', async () => {
  const { forwardRef } = await import('react')
  return { default: forwardRef(function Message({ value, onChange }: { value: string; onChange: (value: string) => void }, _ref) {
    return <textarea aria-label="Mensaje de campaña" value={value} onChange={event => onChange(event.target.value)} />
  }) }
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

it.each([false, true])('preserves an invalid date when schedule is collapsed and blocks submission (existing schedule: %s)', async existingSchedule => {
  const tomorrow = new Date(Date.now() + 86_400_000)
  const day = tomorrow.toISOString().slice(0, 10)
  const onSubmit = vi.fn().mockResolvedValue(undefined)
  render(<CreateCampaignModal open onClose={vi.fn()} onSubmit={onSubmit} devices={[{ id: 'device-a', name: 'Device QA', status: 'connected' }]}
    initialName="Aviso conservado" initialData={{ device_id: 'device-a', message_template: 'Mensaje conservado', ...(existingSchedule ? { scheduled_at: tomorrow.toISOString() } : {}) }} />)
  const disclosure = screen.getByRole('button', { name: /Programar envío/ })
  fireEvent.click(disclosure)
  const date = screen.getByRole('textbox', { name: 'Fecha de envío' })
  fireEvent.focus(date)
  fireEvent.change(date, { target: { value: '20/11/' } })
  fireEvent.click(disclosure)
  expect(date).not.toBeVisible()
  expect(date).toHaveValue('20/11/')
  fireEvent.click(screen.getAllByRole('button', { name: /^(Crear|Programar) Campaña$/ })[0])
  expect(onSubmit).not.toHaveBeenCalled()
  await waitFor(() => expect(date).toBeVisible())
  expect(date).toHaveValue('20/11/')
  expect(screen.getByText('Revisa la fecha de envío antes de continuar. Tu programación se conserva.')).toBeVisible()
  expect(screen.getByPlaceholderText('Ej: Campaña #001')).toHaveValue('Aviso conservado')
  expect(screen.getByRole('textbox', { name: 'Mensaje de campaña' })).toHaveValue('Mensaje conservado')

  fireEvent.change(date, { target: { value: day } })
  const time = screen.getByText('Hora', { exact: true }).parentElement!.querySelector('input')!
  fireEvent.change(time, { target: { value: '12:00' } })
  fireEvent.click(disclosure)
  fireEvent.click(screen.getAllByRole('button', { name: /^(Crear|Programar) Campaña$/ })[0])
  await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
  expect(onSubmit.mock.calls[0][0]).toMatchObject({ name: 'Aviso conservado', message_template: 'Mensaje conservado', scheduled_at: new Date(`${day}T12:00:00`).toISOString() })
})
