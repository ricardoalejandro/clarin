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
  it('lets nested links own keyboard activation and their native context menu in compact and desktop modes', () => {
    const onSelect = vi.fn()
    const linked = { ...baseMessage, body: 'https://example.com/a_b' }
    const { rerender } = render(<MessageBubble message={linked} compactSelection onSelect={onSelect} onReply={vi.fn()} />)
    const link = screen.getByRole('link')
    expect(fireEvent.keyDown(link, { key: 'Enter' })).toBe(true)
    expect(fireEvent.contextMenu(link)).toBe(true)
    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    rerender(<MessageBubble message={linked} onReply={vi.fn()} />)
    expect(fireEvent.contextMenu(screen.getByRole('link'))).toBe(true)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('renders one compact received card, original text and a fixed local thumbnail that fails quietly', () => {
    const thumbnail = `/api/media/file/00000000-0000-4000-8000-000000000000/link-previews/${'a'.repeat(64)}.jpg`
    const linked = { ...baseMessage, body: 'Ver https://example.com/a_b', link_preview: { url: 'https://example.com/a_b', title: 'Título recibido', description: 'Descripción recibida', thumbnail_url: thumbnail } }
    const { container, rerender } = render(<MessageBubble message={linked} />)
    expect(container.querySelectorAll('[data-link-preview]')).toHaveLength(1)
    expect(screen.getByRole('link', { name: 'https://example.com/a_b' })).toBeInTheDocument()
    expect(screen.getByText('Título recibido')).toHaveClass('line-clamp-2')
    const image = container.querySelector('[data-link-preview] img')!
    expect(image).toHaveAttribute('src', thumbnail)
    expect(image).toHaveAttribute('width', '72')
    expect(image).toHaveAttribute('height', '72')
    const frame = image.parentElement
    fireEvent.error(image)
    expect(container.querySelector('[data-link-preview] img')).toBeNull()
    expect(frame).toHaveClass('h-[72px]', 'w-[72px]')
    expect(screen.getByText('Título recibido')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    rerender(<MessageBubble message={{ ...linked, link_preview: { ...linked.link_preview, thumbnail_url: 'https://external.example/track.jpg' } }} />)
    expect(container.querySelector('[data-link-preview] img')).toBeNull()
    rerender(<MessageBubble message={{ ...linked, link_preview: null }} />)
    expect(container.querySelector('[data-link-preview]')).toBeNull()
    expect(screen.getByRole('link', { name: 'https://example.com/a_b' })).toBeInTheDocument()
    rerender(<MessageBubble message={{ ...linked, is_revoked: true }} />)
    expect(container.querySelector('[data-link-preview]')).toBeNull()
  })
  it('keeps unavailable media from issuing a request or offering playback', () => {
    const { container } = render(<MessageBubble message={{ ...baseMessage, message_type: 'video', media_url: '/missing.mp4', media_deleted: true }} />)
    expect(screen.getByText('Archivo eliminado')).toBeInTheDocument()
    expect(container.querySelector('video')).toBeNull()
  })

  it('removes the repeated sender only for an explicit group and preserves message actions', () => {
    const { rerender } = render(<MessageBubble message={baseMessage} contactName="Ana" onReply={vi.fn()} />)
    expect(screen.getByText('Ana')).toBeInTheDocument()
    rerender(<MessageBubble message={baseMessage} contactName="Ana" groupedWithPrevious onReply={vi.fn()} />)
    expect(screen.queryByText('Ana')).not.toBeInTheDocument()
    expect(screen.getByText('Hola')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Más acciones del mensaje' })).toBeInTheDocument()
  })

  it('offers an accessible send retry only when the action is available', () => {
    const onRetry = vi.fn()
    const failed = { ...baseMessage, is_from_me: true, status: 'failed' }
    const { rerender } = render(<MessageBubble message={failed} onRetry={onRetry} />)
    fireEvent.click(screen.getByRole('button', { name: 'No se envió el mensaje. Reintentar envío' }))
    expect(onRetry).toHaveBeenCalledWith(failed)
    rerender(<MessageBubble message={failed} />)
    expect(screen.queryByRole('button', { name: /Reintentar envío/ })).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('No se envió')
  })

  it('opens PDF documents in the internal viewer with their original metadata', () => {
    const onDocumentClick = vi.fn()
    render(<MessageBubble message={{
      ...baseMessage,
      message_type: 'document',
      media_url: '/api/media/file/account/contrato.pdf',
      media_filename: 'Contrato firmado.pdf',
      media_mimetype: 'application/pdf',
      media_size: 2048,
    }} onDocumentClick={onDocumentClick} />)

    fireEvent.click(screen.getByRole('button', { name: 'Abrir vista previa de Contrato firmado.pdf' }))

    expect(onDocumentClick).toHaveBeenCalledWith(expect.objectContaining({
      src: '/api/media/file/account/contrato.pdf',
      filename: 'Contrato firmado.pdf',
      mimeType: 'application/pdf',
      size: 2048,
    }))
  })

  it('keeps non-PDF documents as explicit downloads', () => {
    render(<MessageBubble message={{
      ...baseMessage,
      message_type: 'document',
      media_url: '/api/media/file/account/presupuesto.xlsx',
      media_filename: 'Presupuesto.xlsx',
      media_mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }} onDocumentClick={vi.fn()} />)

    const download = screen.getByRole('link', { name: 'Descargar Presupuesto.xlsx' })
    expect(download).toHaveAttribute('href', '/api/media/file/account/presupuesto.xlsx')
    expect(download).toHaveAttribute('download', 'Presupuesto.xlsx')
  })

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


describe('WhatsApp forwarding provenance', () => {
  it('shows forwarding separately from the group sender and keeps it for media and own forwarded echoes', () => {
    const forwarded = { ...baseMessage, from_jid: 'hidden@lid', from_name: 'Ale', forwarding: { state: 'forwarded' as const, score: 1 } }
    const view = render(<MessageBubble message={forwarded} isGroup />)
    expect(screen.getByText('Ale')).toBeInTheDocument()
    expect(screen.getByLabelText('Reenviado')).toBeInTheDocument()
    expect(screen.getByText('Hola')).toBeInTheDocument()
    view.rerender(<MessageBubble message={{ ...forwarded, is_from_me: true, message_type: 'image', media_url: '/api/media/file/one/image.jpg', forwarding: { state: 'frequently_forwarded', score: 5 } }} isGroup />)
    expect(screen.getByLabelText('Reenviado muchas veces')).toBeInTheDocument()
    view.rerender(<MessageBubble message={{ ...forwarded, is_from_me: true, forwarding: { state: 'not_forwarded', score: 0 } }} />)
    expect(screen.queryByLabelText('Reenviado')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Reenviado muchas veces')).not.toBeInTheDocument()
  })
  it('opens sharing for historical unknown messages and blocks only unavailable content', async () => {
    const onForward = vi.fn()
    const view = render(<MessageBubble message={baseMessage} onForward={onForward} />)
    fireEvent.click(screen.getByRole('button', { name: 'Más acciones del mensaje' }))
    const action = await screen.findByRole('menuitem', { name: /Reenviar/ })
    expect(action).toBeEnabled()
    fireEvent.click(action)
    expect(onForward).toHaveBeenCalledWith(baseMessage)
    view.rerender(<MessageBubble message={{ ...baseMessage, is_view_once: true }} onForward={onForward} />)
    fireEvent.click(screen.getByRole('button', { name: 'Más acciones del mensaje' }))
    expect(await screen.findByRole('menuitem', { name: /Reenviar/ })).toBeDisabled()
  })
})
