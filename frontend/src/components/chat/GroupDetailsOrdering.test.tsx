import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Chat, GroupParticipant } from '@/types/chat'
import GroupDetailsPanel from './GroupDetailsPanel'
vi.mock('@/lib/api', () => ({ subscribeWebSocket: () => () => {} }))
const chat = { id: 'ordered-group', device_id: 'ordered-device', kind: 'group', jid: 'ordered@g.us', name: 'Grupo QA', group: { subject: 'Grupo QA', participant_count: 123, membership_status: 'member', can_send: true } } as Chat
const response = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as Response
const member = (i: number): GroupParticipant => ({ jid: `${String(i).padStart(4, '0')}@lid`, lid: `${String(i).padStart(4, '0')}@lid`, name: `Persona QA ${i}`, role: i === 50 ? 'admin' : 'member', is_self: false })
const buttons = () => screen.getAllByRole('button', { name: /^Ver integrante:/ })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
it('requests admin ordering on every page and restarts a changed cursor without losing loaded rows or scroll', async () => {
  let revision = 1
  const people = Array.from({ length: 123 }, (_, i) => member(i))
  const requests: URL[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'https://qa.example')
    if (!url.pathname.endsWith('/participants')) return response({ success: true, group: chat.group })
    requests.push(url)
    const cursor = url.searchParams.get('cursor')
    if (cursor && !cursor.startsWith(`${revision}:`)) return response({ success: false, code: 'participants_cursor_reset', error: 'Reiniciar integrantes' }, 409)
    const start = cursor ? Number(cursor.split(':')[1]) : 0
    const sorted = [...people].sort((a, b) => Number(b.role !== 'member') - Number(a.role !== 'member') || a.jid.localeCompare(b.jid))
    return response({ success: true, order: 'admins_first', identity_revision: 1, group_revision: revision, participants: sorted.slice(start, start + 50), next_cursor: start + 50 < sorted.length ? `${revision}:${start + 50}` : '' })
  }))
  render(<GroupDetailsPanel chat={chat} onClose={vi.fn()} />)
  await waitFor(() => expect(buttons()).toHaveLength(50))
  expect(buttons()[0]).toHaveTextContent('Persona QA 50')
  fireEvent.click(screen.getByRole('button', { name: 'Mostrar más' }))
  await waitFor(() => expect(buttons()).toHaveLength(100))
  const retained = screen.getByRole('button', { name: 'Ver integrante: Persona QA 20' })
  const scroll = document.querySelector<HTMLElement>('[aria-label="Detalles del grupo"] .overflow-y-auto')!
  scroll.scrollTop = 132
  people[0] = { ...people[0], role: 'super_admin' }
  revision = 2
  fireEvent.click(screen.getByRole('button', { name: 'Mostrar más' }))
  await waitFor(() => expect(buttons()[0]).toHaveTextContent('Persona QA 0'))
  expect(buttons()).toHaveLength(100)
  expect(retained).toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  await waitFor(() => expect(scroll.scrollTop).toBe(132))
  expect(requests.slice(-3).map(url => url.searchParams.get('cursor'))).toEqual(['1:100', null, '2:50'])
  expect(requests.every(url => url.searchParams.get('order') === 'admins_first' && url.searchParams.get('limit') === '50')).toBe(true)
}, 15000)
it('bounds repeated cursor conflicts and retains visible rows with a retry', async () => {
  let conflict = false, reads = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'https://qa.example')
    if (!url.pathname.endsWith('/participants')) return response({ success: true, group: chat.group })
    reads++
    return conflict ? response({ success: false, code: 'participants_cursor_reset', error: 'El grupo sigue cambiando' }, 409) : response({ success: true, order: 'admins_first', identity_revision: 1, group_revision: 1, participants: [member(1)], next_cursor: '1:1' })
  }))
  render(<GroupDetailsPanel chat={chat} onClose={vi.fn()} />)
  await screen.findByText('Persona QA 1')
  conflict = true
  fireEvent.click(screen.getByRole('button', { name: 'Mostrar más' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('El grupo sigue cambiando')
  expect(screen.getByText('Persona QA 1')).toBeInTheDocument()
  expect(reads).toBe(3)
  conflict = false
  fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }))
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
})

it('rejects a server that silently ignores the requested ordering', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => response(String(input).includes('/participants?') ? { success: true, identity_revision: 1, group_revision: 1, participants: [member(1)], next_cursor: '' } : { success: true, group: chat.group })))
  render(<GroupDetailsPanel chat={chat} onClose={vi.fn()} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('El servidor no confirmó el orden')
  expect(screen.queryByText('Persona QA 1')).not.toBeInTheDocument()
})
