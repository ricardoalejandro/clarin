import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import QuickReplySequenceEditor from './QuickReplySequenceEditor'
import type { QuickReplyAttachment, QuickReplyItem } from '@/types/quick-reply'

vi.mock('@/components/WhatsAppTextInput', () => ({ default: () => null }))
vi.mock('./EmojiPicker', () => ({ default: () => null }))

const items: QuickReplyItem[] = [
  { id: 'photo', type: 'media', attachment_id: 'attachment' },
  { id: 'text', type: 'text', text: 'Gracias' },
]
const attachments: QuickReplyAttachment[] = [{ id: 'attachment', media_type: 'image', media_url: '/qa.png', media_filename: 'qa.png', caption: '*Confirmado* 😊', position: 0 }]

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('reorders the image through its accessible control without detaching its caption', () => {
  const onChange = vi.fn()
  render(<QuickReplySequenceEditor items={items} attachments={attachments} onChange={onChange} onRemoveAttachment={vi.fn()} />)
  fireEvent.click(screen.getAllByRole('button', { name: 'Bajar mensaje' })[0])
  expect(onChange).toHaveBeenCalledOnce()
  expect(onChange).toHaveBeenCalledWith([items[1], items[0]], attachments)
})

it('cancels keyboard ordering without writing or losing the attachment', async () => {
  const onChange = vi.fn()
  render(<QuickReplySequenceEditor items={items} attachments={attachments} onChange={onChange} onRemoveAttachment={vi.fn()} />)
  const handle = screen.getByRole('button', { name: 'Ordenar mensaje 1' })
  handle.focus()
  fireEvent.keyDown(handle, { code: 'Space' })
  await waitFor(() => expect(handle).toHaveAttribute('aria-pressed', 'true'))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  fireEvent.keyDown(document, { code: 'ArrowDown' })
  fireEvent.keyDown(document, { code: 'Escape' })
  await waitFor(() => expect(handle).not.toHaveAttribute('aria-pressed', 'true'))
  expect(onChange).not.toHaveBeenCalled()
  expect(screen.getByText('qa.png')).toBeVisible()
})
