import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SurveyInstanceSummary } from '@/types/survey-template'
import ProgramSurveyPanel, { RecipientLinksDialog } from './ProgramSurveyPanel'

const apiMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', () => ({ api: apiMock }))

const instance = { id: 'survey-1', name: 'Survey application', slug: 'application' } as SurveyInstanceSummary
const recipients = (name: string) => ({ success: true, data: { recipients: [{ id: name, contact_name: name, status: 'pending', recipient_token: 'token' }], total: 1 } })
beforeEach(() => { apiMock.mockReset() })
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

  it('pauses a recipient search, preserves its filter and rejects late rows', async () => {
    vi.useFakeTimers()
    let resolveOld!: (value: ReturnType<typeof recipients>) => void
    apiMock.mockImplementationOnce(() => new Promise(done => { resolveOld = done })).mockResolvedValue(recipients('Current recipient'))
    const props = { programId: 'program-1', instance, onClose: vi.fn() }
    const view = render(<RecipientLinksDialog {...props} />)
    fireEvent.change(screen.getByPlaceholderText('Buscar por nombre o teléfono'), { target: { value: 'ana' } })
    view.rerender(<RecipientLinksDialog {...props} suspended />)
    await act(async () => { vi.advanceTimersByTime(1000); resolveOld(recipients('Stale recipient')) })
    expect(apiMock).toHaveBeenCalledTimes(1)
    expect(apiMock.mock.calls[0][1].signal.aborted).toBe(true)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByText('Stale recipient')).not.toBeInTheDocument()
    view.rerender(<RecipientLinksDialog {...props} />)
    expect(screen.getByPlaceholderText('Buscar por nombre o teléfono')).toHaveValue('ana')
    await act(async () => { vi.advanceTimersByTime(499) })
    expect(apiMock).toHaveBeenCalledTimes(1)
    await act(async () => { vi.advanceTimersByTime(1) })
    expect(apiMock).toHaveBeenCalledTimes(2)
    expect(apiMock.mock.calls.at(-1)?.[0]).toContain('q=ana')
    expect(screen.getByText('Current recipient')).toBeInTheDocument()
  })
})

describe('program survey suspension', () => {
  const templates = [
    { id: 'template-a', name: 'Plantilla A', status: 'active', question_count: 2, instance_count: 0 },
    { id: 'template-b', name: 'Plantilla B', status: 'active', question_count: 3, instance_count: 0 },
  ]
  const programProps = { programId: 'program-1', programName: 'Programa', canManageSurveys: true }
  const reads = (url: string) => {
    if (url === '/api/survey-templates') return { success: true, data: templates }
    if (url.includes('/instance-name?')) return { success: true, data: { available: true, suggested_name: 'Suggested application' } }
    if (url.includes('/recipients?')) return recipients('Current recipient')
    return { success: true, data: [] }
  }

  it('retains the selected template, custom name and dirty state while hidden', async () => {
    apiMock.mockImplementation(async (url: string) => reads(url))
    const onDirtyChange = vi.fn()
    const props = { ...programProps, onDirtyChange }
    const view = render(<ProgramSurveyPanel {...props} />)
    await screen.findByText('Todavía no hay encuestas activas')
    fireEvent.click(screen.getAllByRole('button', { name: /Crear encuesta/ })[0])
    fireEvent.click(await screen.findByRole('button', { name: /Plantilla B/ }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Mi encuesta personalizada' } })
    const callsBeforePause = apiMock.mock.calls.length
    view.rerender(<ProgramSurveyPanel {...props} suspended />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)
    fireEvent.click(screen.getAllByRole('button', { name: /Crear encuesta/ })[0])
    expect(apiMock).toHaveBeenCalledTimes(callsBeforePause)
    view.rerender(<ProgramSurveyPanel {...props} />)
    const dialog = screen.getByRole('dialog', { name: 'Crear encuesta' })
    expect(within(dialog).getByRole('textbox')).toHaveValue('Mi encuesta personalizada')
    expect(within(dialog).getByRole('button', { name: /Plantilla B/ })).toHaveClass('border-emerald-500')
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }))
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
  })

  it('aborts a template catalog on pause and cannot accept its late result', async () => {
    let finish!: (value: unknown) => void
    apiMock.mockImplementation((url: string) => url === '/api/survey-templates' ? new Promise(resolve => { finish = resolve }) : Promise.resolve(reads(url)))
    const view = render(<ProgramSurveyPanel {...programProps} />)
    await screen.findByText('Todavía no hay encuestas activas')
    fireEvent.click(screen.getAllByRole('button', { name: /Crear encuesta/ })[0])
    const catalogRequest = apiMock.mock.calls.find(([url]) => url === '/api/survey-templates')
    view.rerender(<ProgramSurveyPanel {...programProps} suspended />)
    expect(catalogRequest?.[1].signal.aborted).toBe(true)
    await act(async () => finish({ success: true, data: templates }))
    expect(screen.queryByText('Plantilla A')).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('reconciles a creation already sent during pause without opening recipient UI', async () => {
    let finish!: (value: unknown) => void
    apiMock.mockImplementation((url: string, options?: { method?: string }) => options?.method === 'POST' ? new Promise(resolve => { finish = resolve }) : Promise.resolve(reads(url)))
    const onDirtyChange = vi.fn()
    const props = { ...programProps, onDirtyChange }
    const view = render(<ProgramSurveyPanel {...props} />)
    await screen.findByText('Todavía no hay encuestas activas')
    fireEvent.click(screen.getAllByRole('button', { name: /Crear encuesta/ })[0])
    const submit = await screen.findByRole('button', { name: 'Crear y obtener enlaces' })
    await waitFor(() => expect(submit).toBeEnabled())
    fireEvent.click(submit)
    fireEvent.click(submit)
    view.rerender(<ProgramSurveyPanel {...props} suspended />)
    await act(async () => finish({ success: true, data: { ...instance, name: 'Created application', audience_mode: 'program_participants', status: 'active', recipient_count: 1, response_count: 0 } }))
    expect(apiMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(apiMock.mock.calls.filter(([url]) => url.includes('/recipients?'))).toHaveLength(0)
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
    view.rerender(<ProgramSurveyPanel {...props} />)
    expect(screen.getByRole('dialog', { name: 'Enlaces por participante' })).toBeInTheDocument()
    expect(await screen.findByText('Current recipient')).toBeInTheDocument()
  })
})
