import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import type { SurveyInstanceSummary, SurveyTemplate } from '@/types/survey-template'
import SurveyApplicationsBrowser from './SurveyApplicationsBrowser'

const navigation = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => navigation }))
vi.mock('@/lib/api', () => ({ api: vi.fn() }))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
})

const template: SurveyTemplate = {
  id: 'template-1', account_id: 'account-1', name: 'Seguimiento', description: '', status: 'active',
  welcome_title: '', welcome_description: '', thank_you_title: '', thank_you_message: '', thank_you_redirect_url: '',
  branding: {}, measurement_config: { dimensions: [] }, revision: 3, created_at: '', updated_at: '',
  question_count: 4, instance_count: 2, archived_instance_count: 1, response_count: 9,
}

const instance: SurveyInstanceSummary = {
  id: 'survey-1', account_id: 'account-1', template_id: 'template-1', template_revision: 2,
  origin_type: 'standalone', origin_label: 'Aplicación independiente', name: 'Seguimiento real', slug: 'seguimiento-real',
  status: 'active', audience_mode: 'public', legacy_instance: false, analytics_tracking_started_at: '',
  question_count: 4, recipient_count: 0, response_count: 9, can_delete: false, can_archive: true, can_restore: false,
  deletion_block_reason: 'has_responses', created_at: '2026-08-01T12:00:00Z', updated_at: '2026-08-01T12:00:00Z',
}

describe('SurveyApplicationsBrowser', () => {
  it('keeps current rows while a 500 ms remote search supersedes the previous request', async () => {
    vi.useFakeTimers()
    const signals: AbortSignal[] = []
    vi.mocked(api).mockImplementation(async (_url, options) => {
      signals.push(options?.signal as AbortSignal)
      return { success: true, status: 200, data: { items: [instance], next_cursor: '', has_more: false, counts: { current: 2, archived: 1 } } }
    })
    render(<SurveyApplicationsBrowser template={template} variant="embedded" />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(screen.getByText('Seguimiento real')).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('Buscar por nombre, origen o slug'), { target: { value: 'final' } })
    expect(screen.getByText('Seguimiento real')).toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(499) })
    expect(api).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(api).toHaveBeenCalledTimes(2)
    expect(vi.mocked(api).mock.calls[1][0]).toContain('query=final')
    expect(signals[0].aborted).toBe(true)
  })

  it('appends a cursor page without dropping the first page', async () => {
    vi.mocked(api)
      .mockResolvedValueOnce({ success: true, status: 200, data: { items: [instance], next_cursor: 'page-2', has_more: true, counts: { current: 2, archived: 1 } } })
      .mockResolvedValueOnce({ success: true, status: 200, data: { items: [{ ...instance, id: 'survey-2', name: 'Segundo seguimiento' }], next_cursor: '', has_more: false, counts: { current: 2, archived: 1 } } })
    render(<SurveyApplicationsBrowser template={template} variant="embedded" />)
    expect(await screen.findByText('Seguimiento real')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }))
    expect(await screen.findByText('Segundo seguimiento')).toBeInTheDocument()
    expect(screen.getByText('Seguimiento real')).toBeInTheDocument()
    expect(vi.mocked(api).mock.calls[1][0]).toContain('cursor=page-2')
  })
})

