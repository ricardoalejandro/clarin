import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '@/types/chat'
import MessageBubble from './MessageBubble'

afterEach(cleanup)

const baseMessage: Message = {
  id: 'row-1',
  message_id: 'message-1',
  device_id: 'device-1',
  body: 'Hola',
  message_type: 'text',
  is_from_me: false,
  is_read: true,
  status: 'delivered',
  timestamp: '2026-08-13T10:00:00Z',
}

describe('MessageBubble message actions', () => {
  it.each([
    ['texto', baseMessage],
    ['sticker', { ...baseMessage, message_type: 'sticker', body: undefined }],
    ['emoji único', { ...baseMessage, body: '👨‍👩‍👧‍👦' }],
    ['imagen', { ...baseMessage, message_type: 'image', body: undefined }],
  ])('uses the compact selection surface without detached action buttons for %s', (_label, message) => {
    const onSelect = vi.fn()
    render(<MessageBubble message={message as Message} compactSelection onSelect={onSelect} onReact={vi.fn()} />)
    const surface = screen.getByRole('group', { name: 'Mantén presionado para ver acciones del mensaje' })
    expect(screen.queryByRole('button', { name: 'Más acciones del mensaje' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reaccionar al mensaje' })).not.toBeInTheDocument()
    fireEvent.keyDown(surface, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith(message)
  })

  it('labels every quick reaction and restores focus after Escape', async () => {
    render(<MessageBubble message={baseMessage} onReact={vi.fn()} />)
    const trigger = screen.getByRole('button', { name: 'Reaccionar al mensaje' })
    fireEvent.click(trigger)

    expect(screen.getByRole('toolbar', { name: 'Reacciones rápidas' })).toBeInTheDocument()
    for (const emoji of ['👍', '❤️', '😂', '😮', '😢', '🙏']) {
      expect(screen.getByRole('button', { name: `Reaccionar con ${emoji}` })).toBeInTheDocument()
    }

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('toolbar', { name: 'Reacciones rápidas' })).not.toBeInTheDocument()
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('opens the same accessible action menu with right click on desktop', () => {
    const { container } = render(<MessageBubble message={baseMessage} onReply={vi.fn()} onReact={vi.fn()} />)

    fireEvent.contextMenu(container.firstElementChild as Element, { clientX: 120, clientY: 80 })

    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Reaccionar' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Responder' })).toBeInTheDocument()
  })

  it('shows an honest disabled reaction action with its reason', () => {
    render(<MessageBubble message={baseMessage} reactionUnavailableReason="El dispositivo no está conectado." />)
    const trigger = screen.getByRole('button', { name: /Reacciones no disponibles/ })
    expect(trigger).toHaveAttribute('aria-disabled', 'true')
    trigger.focus()
    expect(trigger).toHaveFocus()
    expect(trigger).toHaveAttribute('title', 'El dispositivo no está conectado.')
  })

  it('keeps skin tones available in the complete reaction picker', async () => {
    render(<MessageBubble message={baseMessage} onReact={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Reaccionar al mensaje' }))
    fireEvent.click(screen.getByRole('button', { name: 'Abrir selector completo de reacciones' }))

    const picker = await screen.findByRole('dialog', { name: 'Selector completo de reacciones' })
    expect(picker).toHaveAttribute('data-skin-tones-enabled', 'true')
  })
})
