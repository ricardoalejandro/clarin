import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import CreateCampaignModal, { type CampaignFormResult } from '@/components/CreateCampaignModal'

vi.mock('@/components/chat/MessageBubble', () => ({ default: () => null }))
vi.mock('@/components/chat/EmojiPicker', () => ({ default: () => null }))
vi.mock('@/components/WhatsAppTextInput', async () => {
  const { forwardRef } = await import('react')
  return { default: forwardRef(function Input({ value, onChange }: { value: string; onChange: (value: string) => void }, _ref) {
    return <textarea aria-label="Mensaje de campaña" value={value} onChange={event => onChange(event.target.value)} />
  }) }
})

describe('Program campaign suspension', () => {
  it('preserves the draft, ignores hidden submit and Escape, then sends once from desktop', async () => {
    let complete!: () => void
    const onSubmit = vi.fn((_data: CampaignFormResult) => new Promise<void>(resolve => { complete = resolve }))
    const onClose = vi.fn()
    const props = { open: true, onClose, onSubmit, devices: [{ id: 'device-1', name: 'Device', status: 'connected' }], initialName: 'Aviso', initialData: { device_id: 'device-1', message_template: 'Recordatorio' } }
    const view = render(<CreateCampaignModal {...props} />)
    fireEvent.change(screen.getByPlaceholderText('Ej: Campaña #001'), { target: { value: 'Borrador del programa' } })
    const submit = screen.getAllByRole('button', { name: 'Crear Campaña' })[0]
    view.rerender(<CreateCampaignModal {...props} suspended />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(submit)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onSubmit).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    view.rerender(<CreateCampaignModal {...props} />)
    expect(screen.getByPlaceholderText('Ej: Campaña #001')).toHaveValue('Borrador del programa')
    expect(screen.getByLabelText('Mensaje de campaña')).toHaveValue('Recordatorio')
    fireEvent.click(screen.getAllByRole('button', { name: 'Crear Campaña' })[0])
    fireEvent.click(screen.getAllByRole('button', { name: 'Crear Campaña' })[0])
    expect(onSubmit).toHaveBeenCalledTimes(1)
    view.rerender(<CreateCampaignModal {...props} suspended />)
    await act(async () => complete())
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ name: 'Borrador del programa', message_template: 'Recordatorio' })
    expect(onClose).not.toHaveBeenCalled()
  })
})
