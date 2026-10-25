import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import ChatDetailsSurface from './ChatDetailsSurface'
import { hasGroupMemberHistoryLayer } from './groupParticipantIdentity'

afterEach(cleanup)

it('keeps private Back within the source detail even when opened on desktop before switching to mobile', () => {
  expect(hasGroupMemberHistoryLayer({ __clarinGroupParticipant: 'account:group:device' })).toBe(true)
  expect(hasGroupMemberHistoryLayer({ __clarinGroupParticipant: 'account:group:device', __clarinGroupMemberChat: true })).toBe(true)
  expect(hasGroupMemberHistoryLayer({ clarinChatSurface: 'conversation', clarinChatId: 'group' })).toBe(false)
  expect(hasGroupMemberHistoryLayer(null)).toBe(false)
})

it('preserves the participant draft, list and scroll across responsive changes and private chat suspension', () => {
  function Detail() {
    const [draft, setDraft] = useState('')
    return <section><input aria-label="Borrador de la ficha" value={draft} onChange={event => setDraft(event.target.value)} /><div data-testid="participants-scroll">Participantes</div></section>
  }
  const surface = (mode: 'wide' | 'medium' | 'compact', suspended = false) => <ChatDetailsSurface mode={mode} width={380} suspended={suspended}><Detail /></ChatDetailsSurface>
  const view = render(surface('wide'))
  const input = screen.getByRole('textbox', { name: 'Borrador de la ficha' })
  const list = screen.getByTestId('participants-scroll')
  fireEvent.change(input, { target: { value: 'Consulta pendiente' } }); list.scrollTop = 180
  for (const mode of ['medium', 'compact', 'wide'] as const) {
    view.rerender(surface(mode, true))
    expect(screen.getByRole('textbox', { name: 'Borrador de la ficha', hidden: true })).toBe(input)
    expect(input.closest('[inert]')).toBeInTheDocument()
    view.rerender(surface(mode))
    expect(screen.getByRole('textbox', { name: 'Borrador de la ficha' })).toBe(input)
    expect(input).toHaveValue('Consulta pendiente')
    expect(screen.getByTestId('participants-scroll')).toBe(list)
    expect(list.scrollTop).toBe(180)
  }
})
