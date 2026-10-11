import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createRef, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContactDetailSurfaceHandle } from '@/components/contact-details/ContactDetailSurface'
import ContactPanel, { type ContactPanelHandle } from './ContactPanel'

const mocks = vi.hoisted(() => ({ canClose: vi.fn() }))
vi.mock('@/components/LeadDetailPanel', () => ({ default: () => null }))
vi.mock('@/components/contact-details/ContactDetailSurface', async () => {
  const { forwardRef, useImperativeHandle, useState } = await import('react')
  return {
  default: forwardRef<ContactDetailSurfaceHandle, { onClose: () => void; onSendMessage?: () => void; contextContent?: ReactNode }>(function Detail({ onClose, onSendMessage, contextContent }, ref) {
    const [draft, setDraft] = useState('')
    useImperativeHandle(ref, () => ({ canClose: mocks.canClose, requestClose: () => { if (!mocks.canClose()) return false; onClose(); return true } }))
    return <><input aria-label="Borrador de nota" value={draft} onChange={event => setDraft(event.target.value)} /><button onClick={onSendMessage} disabled={!onSendMessage}>Mensaje</button>{contextContent}</>
  }),
  }
})

beforeEach(() => {
  mocks.canClose.mockReset().mockReturnValue(true)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ success: true, contact: { id: 'contact-1', name: 'Contacto de prueba', phone: '51999999999', is_group: false }, opportunities: [] }) } as Response)))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('ContactPanel conversation continuity', () => {
  it('guards Message and exposes a synchronous non-closing draft guard to its owner', async () => {
    const ref = createRef<ContactPanelHandle>()
    const onClose = vi.fn()
    const onFocus = vi.fn()
    render(<ContactPanel ref={ref} chatId="chat-1" isOpen onClose={onClose} onFocusConversation={onFocus} />)
    const message = await screen.findByRole('button', { name: 'Mensaje' })
    mocks.canClose.mockReturnValue(false)
    expect(ref.current?.canClose()).toBe(false)
    fireEvent.click(message)
    expect(onFocus).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    mocks.canClose.mockReturnValue(true)
    expect(ref.current?.canClose()).toBe(true)
    fireEvent.click(message)
    expect(onFocus).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar detalles' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps a note draft mounted while refreshing contextual contact actions', async () => {
    const body = { success: true, contact: { id: 'contact-1', name: 'Contacto', phone: '51999999999', is_group: false, do_not_contact: true }, opportunities: [] }
    let reads = 0
    let finishRefresh!: (response: Response) => void
    vi.mocked(fetch).mockImplementation(async (_input, options) => {
      if (!options?.method) {
        reads++
        if (reads === 2) return new Promise(resolve => { finishRefresh = resolve })
      }
      return { ok: true, json: async () => body } as Response
    })
    render(<ContactPanel chatId="chat-1" isOpen onClose={vi.fn()} />)
    const draft = await screen.findByRole('textbox', { name: 'Borrador de nota' })
    fireEvent.change(draft, { target: { value: 'Continúa aquí' } })
    fireEvent.click(screen.getByRole('button', { name: 'Permitir contacto' }))
    await waitFor(() => expect(reads).toBe(2))
    expect(screen.getByRole('textbox', { name: 'Borrador de nota' })).toBe(draft)
    expect(draft).toHaveValue('Continúa aquí')
    await act(async () => { finishRefresh({ ok: true, json: async () => body } as Response) })
    expect(draft).toHaveValue('Continúa aquí')
  })

  it('focuses the conversation without asking to discard a note when wide Details stays open', async () => {
    const onFocus = vi.fn()
    mocks.canClose.mockReturnValue(false)
    render(<ContactPanel chatId="chat-1" isOpen onClose={vi.fn()} onFocusConversation={onFocus} focusConversationClosesDetails={false} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Mensaje' }))
    expect(onFocus).toHaveBeenCalledTimes(1)
    expect(mocks.canClose).not.toHaveBeenCalled()
  })
})
