import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import EventsPage from './page'

const fixture = vi.hoisted(() => ({ fetch: vi.fn(), router: { push: vi.fn() } }))
vi.mock('next/navigation', () => ({ useRouter: () => fixture.router, useSearchParams: () => new URLSearchParams() }))
vi.mock('@/components/responsive/useContainerWidth', () => ({ useContainerWidth: () => ({ ref: { current: null }, width: 1100 }) }))
vi.mock('@/components/events/EventConfigurationWindow', () => ({ default: () => null }))
vi.mock('@/lib/api', () => ({ subscribeWebSocket: () => () => {}, api: async (url: string, options: unknown) => { const response = await fixture.fetch(url, options); const data = await response.json(); return { success: response.ok, data } } }))

const response = (body: unknown) => Promise.resolve({ ok: true, json: async () => body })

beforeEach(() => {
  fixture.fetch.mockReset()
  fixture.fetch.mockImplementation((url: string) => response(url.startsWith('/api/events?')
    ? { success: true, events: [], total: 0 }
    : url === '/api/events/folders' ? { success: true, folders: [] } : { success: true, tags: [] }))
  vi.stubGlobal('fetch', fixture.fetch)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('EventsPage cancellation visibility', () => {
  it('exposes an accessible neutral inclusion control only for all states', async () => {
    render(<EventsPage />)
    const statusFilter = await screen.findByRole('combobox', { name: 'Estado de eventos' })
    expect(screen.queryByRole('button', { name: 'Incluir cancelados' })).not.toBeInTheDocument()
    fireEvent.change(statusFilter, { target: { value: '' } })
    const toggle = await screen.findByRole('button', { name: 'Incluir cancelados' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(toggle.className).not.toContain('red-')
    await waitFor(() => expect(fixture.fetch).toHaveBeenCalledWith(expect.stringContaining('exclude_cancelled=true'), expect.anything()))
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => {
      const calls = fixture.fetch.mock.calls.filter(([url]) => url.startsWith('/api/events?'))
      expect(calls.at(-1)?.[0]).not.toContain('exclude_cancelled')
    })
    fireEvent.change(screen.getByRole('combobox', { name: 'Estado de eventos' }), { target: { value: 'cancelled' } })
    expect(screen.queryByRole('button', { name: 'Incluir cancelados' })).not.toBeInTheDocument()
    await waitFor(() => expect(fixture.fetch).toHaveBeenCalledWith(expect.stringContaining('status=cancelled'), expect.anything()))
  })
})


it('renders canonical stage summaries and requests global sorting', async () => {
  const event={id:'event-one',name:'Encuentro',status:'active',color:'#334455',created_at:'2026-10-01',total_participants:7,stage_summary:[{id:'stage-one',name:'En conversación',color:'#334455',position:0,count:5},{id:null,name:'Sin etapa',color:'#94a3b8',position:1,count:2}]}
  fixture.fetch.mockImplementation((url:string)=>response(url.startsWith('/api/events?') ? {success:true,events:[event],total:1} : {success:true,folders:[]}))
  render(<EventsPage/>)
  expect(await screen.findByRole('button',{name:'Encuentro'})).toBeInTheDocument()
  expect(screen.getByText('En conversación')).toBeInTheDocument()
  expect(screen.getByText('Sin etapa')).toBeInTheDocument()
  expect(screen.queryByText('Asistentes')).not.toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button',{name:'Participantes'}))
  await waitFor(()=>expect(fixture.fetch).toHaveBeenCalledWith(expect.stringContaining('sort=participants'),expect.anything()))
  expect(screen.getByRole('button',{name:'Encuentro'})).toBeInTheDocument()
})
