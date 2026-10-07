import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SurveyInstanceSummary } from '@/types/survey-template'
import { RecipientLinksDialog } from './ProgramSurveyPanel'

const apiMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', () => ({ api: apiMock }))

const instance = { id: 'survey-1', name: 'Survey application', slug: 'application' } as SurveyInstanceSummary
const recipients = (name: string) => ({ success: true, data: { recipients: [{ id: name, contact_name: name, status: 'pending', recipient_token: 'token' }], total: 1 } })
beforeEach(() => apiMock.mockReset())
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('program frozen recipient search', () => {
  it('restarts a cancelled empty query when clearing before debounce and rejects its late result', async () => {
    let resolveOld!: (value: ReturnType<typeof recipients>) => void
    apiMock.mockImplementationOnce(() => new Promise(done => { resolveOld = done })).mockResolvedValueOnce(recipients('Canonical recipient'))
    render(<RecipientLinksDialog programId="program-1" instance={instance} onClose={vi.fn()} />)
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByPlaceholderText('Buscar por nombre o teléfono'), { target: { value: 'search' } })
    fireEvent.click(screen.getByRole('button', { name: 'Limpiar búsqueda de destinatarios' }))
    expect(await screen.findByText('Canonical recipient')).toBeInTheDocument()
    expect(apiMock).toHaveBeenCalledTimes(2)
    expect(apiMock.mock.calls[0][1].signal.aborted).toBe(true)
    await act(async () => resolveOld(recipients('Stale recipient')))
    expect(screen.queryByText('Stale recipient')).not.toBeInTheDocument()
  })

  it('debounces exactly 500ms and reloads when a cancelled query returns to its same applied value', async () => {
    vi.useFakeTimers()
    apiMock.mockResolvedValue(recipients('Recipient'))
    render(<RecipientLinksDialog programId="program-1" instance={instance} onClose={vi.fn()} />)
    await act(async () => {})
    const input = screen.getByPlaceholderText('Buscar por nombre o teléfono')
    fireEvent.change(input, { target: { value: 'ana' } })
    await act(async () => { vi.advanceTimersByTime(499) })
    expect(apiMock).toHaveBeenCalledTimes(1)
    await act(async () => { vi.advanceTimersByTime(1) })
    expect(apiMock).toHaveBeenCalledTimes(2)
    fireEvent.change(input, { target: { value: 'another' } })
    fireEvent.change(input, { target: { value: 'ana' } })
    await act(async () => { vi.advanceTimersByTime(500) })
    expect(apiMock).toHaveBeenCalledTimes(3)
    expect(apiMock.mock.calls[2][0]).toContain('q=ana')
  })

  it('exposes a failed recipient load and retry instead of reporting an empty audience', async () => {
    apiMock.mockResolvedValueOnce({ success: false, error: 'Recipients unavailable' }).mockResolvedValueOnce(recipients('Recovered recipient'))
    render(<RecipientLinksDialog programId="program-1" instance={instance} onClose={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Recipients unavailable')
    expect(screen.queryByText('No hay destinatarios para esta búsqueda.')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }))
    expect(await screen.findByText('Recovered recipient')).toBeInTheDocument()
  })
})
