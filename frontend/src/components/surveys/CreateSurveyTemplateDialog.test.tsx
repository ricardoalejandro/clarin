import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import CreateSurveyTemplateDialog from './CreateSurveyTemplateDialog'

vi.mock('@/lib/api', () => ({ api: vi.fn() }))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('CreateSurveyTemplateDialog', () => {
  it('creates a private template and hands it to the designer flow', async () => {
    const created = { id: 'template-1', name: 'Satisfacción' }
    vi.mocked(api).mockResolvedValue({ success: true, status: 201, data: created })
    const onCreated = vi.fn()
    render(<CreateSurveyTemplateDialog onClose={vi.fn()} onCreated={onCreated} />)
    expect(screen.getByText('La plantilla todavía no será pública')).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('Ej. Satisfacción del programa'), { target: { value: 'Satisfacción' } })
    expect(screen.getByText('12/180')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Crear y diseñar' }))
    await waitFor(() => expect(api).toHaveBeenCalledWith('/api/survey-templates', { method: 'POST', body: JSON.stringify({ name: 'Satisfacción', description: '' }) }))
    expect(onCreated).toHaveBeenCalledWith(created)
  })

  it('asks before discarding a typed draft', () => {
    const onClose = vi.fn()
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<CreateSurveyTemplateDialog onClose={onClose} onCreated={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText('Ej. Satisfacción del programa'), { target: { value: 'Borrador' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }))
    expect(window.confirm).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })
})

