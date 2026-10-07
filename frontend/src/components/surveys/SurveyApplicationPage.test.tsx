import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SurveyDetailPage from '@/app/dashboard/surveys/[id]/page'

const fixture = vi.hoisted(() => ({ tab: 'share', api: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: fixture.api, apiBlob: vi.fn() }))
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'survey-1' }), useSearchParams: () => new URLSearchParams({ tab: fixture.tab }), useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@nivo/bar', () => ({ ResponsiveBar: () => null }))
vi.mock('@nivo/pie', () => ({ ResponsivePie: () => null }))
vi.mock('@nivo/radar', () => ({ ResponsiveRadar: () => null }))
vi.mock('qrcode.react', () => ({ QRCodeSVG: () => null }))
vi.mock('@/components/surveys/SurveyApplicationLifecycleActions', () => ({ default: () => null }))

const survey = { id: 'survey-1', account_id: 'account-1', name: 'Application', slug: 'application', status: 'active', template_id: 'template-1', audience_mode: 'public', description: '', welcome_title: '', welcome_description: '', thank_you_title: '', thank_you_message: '', thank_you_redirect_url: '', branding: {} }

beforeEach(() => {
  fixture.tab = 'share'
  fixture.api.mockReset()
  fixture.api.mockImplementation(async (endpoint: string) => {
    if (endpoint === '/api/surveys/survey-1') return { success: true, data: survey }
    if (endpoint.endsWith('/questions')) return { success: true, data: [] }
    return { success: true, data: null }
  })
})
afterEach(cleanup)

describe('survey application real page async states', () => {
  it('keeps one pending PATCH, exposes 403, and only reconciles after success', async () => {
    let resolve!: (response: { success: boolean; error?: string }) => void
    let canonical = survey
    fixture.api.mockImplementation(async (endpoint: string) => {
      if (endpoint.endsWith('/status')) return new Promise(done => { resolve = done })
      if (endpoint.endsWith('/questions')) return { success: true, data: [] }
      return { success: true, data: canonical }
    })
    render(<SurveyDetailPage />)
    const close = await screen.findByRole('button', { name: 'Cerrada' })
    fireEvent.click(close)
    expect(close).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Activa' })).toBeDisabled()
    fireEvent.click(close)
    expect(fixture.api.mock.calls.filter(([endpoint]) => endpoint.endsWith('/status'))).toHaveLength(1)
    await act(async () => resolve({ success: false, error: 'No puedes cerrar esta encuesta (403)' }))
    expect(screen.getByRole('alert')).toHaveTextContent('No puedes cerrar esta encuesta')
    expect(screen.getByRole('button', { name: 'Activa' })).toHaveAttribute('aria-pressed', 'true')
    expect(close).toBeEnabled()
    expect(fixture.api.mock.calls.filter(([endpoint]) => endpoint === '/api/surveys/survey-1')).toHaveLength(1)
    fireEvent.click(close)
    canonical = { ...survey, status: 'closed' }
    await act(async () => resolve({ success: true }))
    await waitFor(() => expect(fixture.api.mock.calls.filter(([endpoint]) => endpoint === '/api/surveys/survey-1')).toHaveLength(2))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cerrada' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('shows independent initial errors and successful empty responses only after retry', async () => {
    fixture.tab = 'analytics'
    let recovered = false
    fixture.api.mockImplementation(async (endpoint: string) => {
      if (endpoint.endsWith('/analytics')) return { success: false, error: 'Estadísticas temporalmente inaccesibles' }
      if (endpoint.includes('/responses?')) return recovered ? { success: true, data: { responses: [], total: 0 } } : { success: false, error: 'Respuestas temporalmente inaccesibles' }
      if (endpoint.endsWith('/questions')) return { success: true, data: [] }
      return { success: true, data: survey }
    })
    render(<SurveyDetailPage />)
    expect(await screen.findByText('Estadísticas temporalmente inaccesibles')).toBeInTheDocument()
    expect(await screen.findByText('Respuestas temporalmente inaccesibles')).toBeInTheDocument()
    expect(screen.queryByText('No hay respuestas aún')).not.toBeInTheDocument()
    recovered = true
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar respuestas' }))
    expect(await screen.findByText('No hay respuestas aún')).toBeInTheDocument()
    expect(screen.getByText('Estadísticas temporalmente inaccesibles')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar estadísticas' }))
    await waitFor(() => expect(fixture.api.mock.calls.filter(([endpoint]) => endpoint.endsWith('/analytics'))).toHaveLength(2))
  })

  it('retains the mounted response and canonical range when a later page fails, then advances on retry', async () => {
    fixture.tab = 'analytics'
    let resolve!: (response: unknown) => void
    fixture.api.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/responses?') && endpoint.includes('offset=50')) return new Promise(done => { resolve = done })
      if (endpoint.includes('/responses?')) return { success: true, data: { responses: [{ id: 'response-1', source: 'first page' }], total: 75 } }
      if (endpoint.endsWith('/questions')) return { success: true, data: [] }
      if (endpoint.endsWith('/analytics')) return { success: false, error: 'Statistics unavailable' }
      return { success: true, data: survey }
    })
    render(<SurveyDetailPage />)
    const responseNode = await screen.findByText('via first page')
    fireEvent.click(screen.getByRole('button', { name: 'Siguiente' }))
    expect(responseNode).toBeInTheDocument()
    expect(screen.getByText('Mostrando 1-50 de 75')).toBeInTheDocument()
    await act(async () => resolve({ success: false, error: 'Next page unavailable' }))
    expect(screen.getByText('Next page unavailable')).toBeInTheDocument()
    expect(responseNode).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar respuestas' }))
    await act(async () => resolve({ success: true, data: { responses: [{ id: 'response-51', source: 'second page' }], total: 75 } }))
    expect(await screen.findByText('via second page')).toBeInTheDocument()
    expect(screen.getByText('Mostrando 51-75 de 75')).toBeInTheDocument()
  })

  it('surfaces response detail failure and opens the exact response after retry', async () => {
    fixture.tab = 'analytics'
    let resolve!: (response: unknown) => void
    fixture.api.mockImplementation(async (endpoint: string) => {
      if (endpoint.endsWith('/responses/response-1')) return new Promise(done => { resolve = done })
      if (endpoint.includes('/responses?')) return { success: true, data: { responses: [{ id: 'response-1', source: 'first page' }], total: 1 } }
      if (endpoint.endsWith('/questions')) return { success: true, data: [] }
      if (endpoint.endsWith('/analytics')) return { success: false, error: 'Statistics unavailable' }
      return { success: true, data: survey }
    })
    render(<SurveyDetailPage />)
    const detailButton = await screen.findByRole('button', { name: 'Ver detalle' })
    fireEvent.click(detailButton)
    expect(detailButton).toBeDisabled()
    expect(screen.getByText('Cargando detalle de respuesta…')).toBeInTheDocument()
    await act(async () => resolve({ success: false, error: 'Detail permission denied' }))
    expect(screen.getByText('Detail permission denied')).toBeInTheDocument()
    expect(screen.queryByText('Detalle de respuesta')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar detalle' }))
    await act(async () => resolve({ success: true, data: { id: 'response-1', answers: [{ id: 'answer-1', question_id: 'question-1', value: 'Exact answer' }] } }))
    expect(await screen.findByText('Detalle de respuesta')).toBeInTheDocument()
    expect(screen.getByText('Exact answer')).toBeInTheDocument()
    expect(screen.queryByText('Detail permission denied')).not.toBeInTheDocument()
  })
})
