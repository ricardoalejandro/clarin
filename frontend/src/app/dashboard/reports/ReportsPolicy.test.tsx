import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { beginAuthIdentityChange, completeAuthIdentityChange } from '@/lib/authScope'
import ReportsPage from './page'
import WhatsAppAlias from './whatsapp-group-coverage/page'
import RetiredLeadAlias from './lead-intelligence/page'

const mocks = vi.hoisted(() => ({ redirect: vi.fn(() => { throw new Error('redirect') }) }))
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }))
vi.mock('@/components/reports/WhatsAppGroupCoverageReport', () => ({ default: () => <h1>WhatsApp por grupos</h1> }))
const response = (user: object, status = 200) => new Response(JSON.stringify({ user }), { status, headers: { 'Content-Type': 'application/json' } })
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  completeAuthIdentityChange()
  mocks.redirect.mockClear()
  fetchMock = vi.fn(async () => response({ permissions: ['reports'] }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('WhatsApp-only Reporteria', () => {
  it.each([{ is_admin: true }, { is_super_admin: true }, { permissions: ['*'] }, { permissions: ['reports'] }])('opens the only report directly with reporting access: %j', async user => {
    fetchMock.mockResolvedValue(response(user))
    render(<ReportsPage />)
    expect(await screen.findByRole('heading', { name: 'WhatsApp por grupos' })).toBeVisible()
    expect(screen.queryByText('Centro de reportes')).not.toBeInTheDocument()
    expect(screen.queryByText('Análisis inteligente de leads')).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it.each([200, 401, 403])('preserves restricted access for status %s', async status => {
    fetchMock.mockResolvedValue(response({ permissions: ['leads', 'chats'] }, status))
    render(<ReportsPage />)
    expect(await screen.findByText('Acceso restringido')).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'WhatsApp por grupos' })).not.toBeInTheDocument()
  })

  it('keeps the report unmounted while access is loading', () => {
    fetchMock.mockReturnValue(new Promise(() => {}))
    render(<ReportsPage />)
    expect(screen.getByRole('status')).toHaveTextContent('Comprobando acceso')
    expect(screen.queryByRole('heading')).not.toBeInTheDocument()
  })

  it('offers retry after an unavailable permission check', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network'))
    render(<ReportsPage />)
    expect(await screen.findByText('No pudimos comprobar el acceso')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }))
    expect(await screen.findByRole('heading', { name: 'WhatsApp por grupos' })).toBeVisible()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not reuse access or an old completion after authentication changes', async () => {
    let finish!: (value: Response) => void
    fetchMock.mockReturnValueOnce(new Promise<Response>(resolve => { finish = resolve }))
    fetchMock.mockResolvedValue(response({ permissions: [] }))
    render(<ReportsPage />)
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal
    act(() => { beginAuthIdentityChange() })
    expect(signal.aborted).toBe(true)
    expect(fetchMock).toHaveBeenCalledOnce()
    act(() => { completeAuthIdentityChange() })
    expect(await screen.findByText('Acceso restringido')).toBeVisible()
    await act(async () => { finish(response({ permissions: ['reports'] })) })
    await waitFor(() => expect(screen.getByText('Acceso restringido')).toBeVisible())
    expect(screen.queryByRole('heading', { name: 'WhatsApp por grupos' })).not.toBeInTheDocument()
  })

  it.each([WhatsAppAlias, RetiredLeadAlias])('redirects an old report URL to the only report', alias => {
    expect(() => alias()).toThrow('redirect')
    expect(mocks.redirect).toHaveBeenCalledExactlyOnceWith('/dashboard/reports')
  })
})
