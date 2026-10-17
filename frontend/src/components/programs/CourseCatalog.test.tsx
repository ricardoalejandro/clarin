import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Course } from '@/types/course'
import CourseCatalog from './CourseCatalog'

const mocks = vi.hoisted(() => ({ api: vi.fn(), width: 768 }))
vi.mock('@/lib/api', () => ({ api: mocks.api }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/components/responsive/useContainerWidth', () => ({ useContainerWidth: () => ({ ref: { current: null }, width: mocks.width }) }))
vi.mock('./useProgramWorkspacePolicy', () => ({ useProgramWorkspacePolicy: (width: number) => ({ mobile: width < 700, desktopActions: width >= 700 }) }))

const course: Course = {
  id: 'course-test', account_id: 'account-test', name: 'Curso de prueba', description: 'Descripción del curso',
  status: 'active', position: 1, usage_count: 0, topic_count: 1, active_topic_count: 1, topic_preview: ['Primer tema'],
  created_at: '2026-09-14T12:00:00Z', updated_at: '2026-09-14T12:00:00Z', topics: [],
}

beforeEach(() => {
  mocks.width = 768
  mocks.api.mockReset().mockResolvedValue({ success: true, data: { courses: [course], total: 1, page: 1, page_size: 10 } })
})

describe('CourseCatalog mobile consultation and suspended administration', () => {
  const writes = () => mocks.api.mock.calls.filter(([, options]) => options?.method && options.method !== 'GET')
  const fullCourse: Course = {
    ...course,
    topic_count: 4,
    active_topic_count: 3,
    topics: Array.from({ length: 4 }, (_, index) => ({
      id: `topic-${index}`, account_id: course.account_id, course_id: course.id,
      title: `Tema completo ${index + 1}`, description: `Detalle ${index + 1}\nSegunda línea`,
      status: index === 3 ? 'archived' as const : 'active' as const,
      position: index, usage_count: 0, created_at: course.created_at, updated_at: course.updated_at,
    })),
  }

  it('shows all course topics and descriptions by GET on direct mobile access without administration', async () => {
    mocks.width = 522
    mocks.api.mockImplementation(async (endpoint: string) => endpoint.includes('?')
      ? { success: true, data: { courses: [course], total: 1 } }
      : { success: true, data: { course: fullCourse } })
    render(<CourseCatalog />)
    fireEvent.click(await screen.findByRole('button', { name: 'Ver detalles de Curso de prueba' }))
    expect(await screen.findByText(/4\. Tema completo 4/)).toBeInTheDocument()
    expect(screen.getByText(/Detalle 4/)).toHaveTextContent('Detalle 4 Segunda línea')
    expect(screen.getByText('Retirado')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Nuevo|Crear|Editar|Archivar|Restaurar|Eliminar|Guardar/ })).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Buscar cursos' })).toBeInTheDocument()
    expect(writes()).toHaveLength(0)
  })

  it('offers a consultation empty state without creation entry points', async () => {
    mocks.width = 320
    mocks.api.mockResolvedValue({ success: true, data: { courses: [], total: 0 } })
    render(<CourseCatalog />)
    expect(await screen.findByText('No hay cursos registrados')).toBeInTheDocument()
    expect(screen.getByText('Los cursos se administran desde la vista de escritorio.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Nuevo|Crear/ })).not.toBeInTheDocument()
  })

  it('exposes a retry for a failed plan read and never submits the editor', async () => {
    mocks.width = 522
    let reads = 0
    mocks.api.mockImplementation(async (endpoint: string) => endpoint.includes('?')
      ? { success: true, data: { courses: [course], total: 1 } }
      : ++reads === 1 ? { success: false, error: 'Plan no disponible' } : { success: true, data: { course: fullCourse } })
    render(<CourseCatalog />)
    fireEvent.click(await screen.findByRole('button', { name: 'Ver detalles de Curso de prueba' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Reintentar plan completo' }))
    expect(await screen.findByText(/4\. Tema completo 4/)).toBeInTheDocument()
    expect(writes()).toHaveLength(0)
  })

  it('rejects a late course read after another card is selected', async () => {
    mocks.width = 522
    const second = { ...course, id: 'course-second', name: 'Segundo curso' }
    let resolveOld!: (value: unknown) => void
    let oldSignal: AbortSignal | undefined
    mocks.api.mockImplementation((endpoint: string, options?: RequestInit) => endpoint.includes('?')
      ? Promise.resolve({ success: true, data: { courses: [course, second], total: 2 } })
      : endpoint.endsWith(course.id) ? new Promise(resolve => { resolveOld = resolve; oldSignal = options?.signal as AbortSignal })
        : Promise.resolve({ success: true, data: { course: { ...second, topics: [] } } }))
    render(<CourseCatalog />)
    fireEvent.click(await screen.findByRole('button', { name: 'Ver detalles de Curso de prueba' }))
    fireEvent.click(screen.getByRole('button', { name: 'Ver detalles de Segundo curso' }))
    expect(await screen.findByText('Este curso no tiene temas registrados.')).toBeInTheDocument()
    expect(oldSignal?.aborted).toBe(true)
    await act(async () => resolveOld({ success: true, data: { course: fullCourse } }))
    expect(screen.queryByText(/Tema completo 4/)).not.toBeInTheDocument()
    expect(writes()).toHaveLength(0)
  })

  it('preserves an unsaved desktop draft through mobile and refuses a suspended submit or Escape', async () => {
    const view = render(<CourseCatalog />)
    await screen.findByRole('button', { name: 'Ver detalles de Curso de prueba' })
    fireEvent.click(screen.getByRole('button', { name: /Nuevo curso/ }))
    const name = screen.getByPlaceholderText('Ej: Fundamentos de liderazgo')
    fireEvent.change(name, { target: { value: 'Borrador intacto' } })
    const form = name.closest('form')!
    mocks.width = 522
    view.rerender(<CourseCatalog />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.submit(form)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(writes()).toHaveLength(0)
    mocks.width = 768
    view.rerender(<CourseCatalog />)
    expect(screen.getByPlaceholderText('Ej: Fundamentos de liderazgo')).toHaveValue('Borrador intacto')
    expect(screen.getByRole('button', { name: 'Guardar curso' })).toBeEnabled()
  })

  it('restores focus to the same editor field after mobile suspension', async () => {
    const view = render(<CourseCatalog />)
    await screen.findByRole('button', { name: 'Ver detalles de Curso de prueba' })
    fireEvent.click(screen.getByRole('button', { name: /Nuevo curso/ }))
    const description = document.getElementById('course-description')!
    description.focus()
    mocks.width = 522
    view.rerender(<CourseCatalog />)
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Buscar cursos' })).toHaveFocus())
    mocks.width = 768
    view.rerender(<CourseCatalog />)
    await waitFor(() => expect(document.getElementById('course-description')).toHaveFocus())
  })

  it('pauses an archive preflight before its PUT and resumes only after explicit desktop confirmation', async () => {
    let resolvePreflight!: (value: unknown) => void
    let reads = 0
    mocks.api.mockImplementation((endpoint: string, options?: RequestInit) => {
      if (endpoint.includes('?')) return Promise.resolve({ success: true, data: { courses: [course], total: 1 } })
      if (options?.method === 'PUT') return Promise.resolve({ success: true, data: { course: { ...course, status: 'archived' } } })
      return ++reads === 1 ? new Promise(resolve => { resolvePreflight = resolve }) : Promise.resolve({ success: true, data: { course } })
    })
    const view = render(<CourseCatalog />)
    fireEvent.click(await screen.findByRole('button', { name: 'Ver detalles de Curso de prueba' }))
    fireEvent.click(screen.getByRole('button', { name: 'Archivar Curso de prueba' }))
    fireEvent.click(screen.getByRole('button', { name: 'Archivar' }))
    mocks.width = 522
    view.rerender(<CourseCatalog />)
    await act(async () => resolvePreflight({ success: true, data: { course } }))
    expect(writes()).toHaveLength(0)
    mocks.width = 768
    view.rerender(<CourseCatalog />)
    expect(screen.getByText('Cambio de estado pausado')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Archivar' }))
    await waitFor(() => expect(writes()).toHaveLength(1))
  })

  it('reconciles an in-flight save once and preserves its failure and draft after suspension', async () => {
    let resolveSave!: (value: unknown) => void
    mocks.api.mockImplementation((endpoint: string, options?: RequestInit) => options?.method === 'POST'
      ? new Promise(resolve => { resolveSave = resolve })
      : Promise.resolve({ success: true, data: { courses: [course], total: 1 } }))
    const view = render(<CourseCatalog />)
    await screen.findByRole('button', { name: 'Ver detalles de Curso de prueba' })
    fireEvent.click(screen.getByRole('button', { name: /Nuevo curso/ }))
    const name = screen.getByPlaceholderText('Ej: Fundamentos de liderazgo')
    fireEvent.change(name, { target: { value: 'Reintentar sin pérdida' } })
    const form = name.closest('form')!
    fireEvent.submit(form)
    fireEvent.submit(form)
    mocks.width = 522
    view.rerender(<CourseCatalog />)
    await act(async () => resolveSave({ success: false, error: 'Fallo controlado' }))
    expect(writes()).toHaveLength(1)
    mocks.width = 768
    view.rerender(<CourseCatalog />)
    expect(screen.getByPlaceholderText('Ej: Fundamentos de liderazgo')).toHaveValue('Reintentar sin pérdida')
    expect(screen.getByText('Fallo controlado')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Guardar curso' })).toBeEnabled()
    expect(writes()).toHaveLength(1)
  })
})
afterEach(cleanup)

describe('CourseCatalog React 19 inert contract', () => {
  it('keeps compact card actions inert until expanded and makes them inert again on collapse', async () => {
    render(<CourseCatalog />)
    const toggle = await screen.findByRole('button', { name: 'Ver detalles de Curso de prueba' })
    const panel = document.getElementById('course-course-test-panel')
    expect(panel).toHaveAttribute('inert')
    expect(panel).toHaveAttribute('aria-hidden', 'true')
    expect(screen.queryByRole('button', { name: 'Editar' })).not.toBeInTheDocument()

    fireEvent.click(toggle)
    expect(panel).not.toHaveAttribute('inert')
    expect(panel).toHaveAttribute('aria-hidden', 'false')
    expect(screen.getByRole('button', { name: 'Editar' })).toBeInTheDocument()
    fireEvent.click(toggle)
    expect(panel).toHaveAttribute('inert')
    expect(screen.queryByRole('button', { name: 'Editar' })).not.toBeInTheDocument()
    expect(mocks.api).toHaveBeenCalledTimes(1)
  })

  it('does not leave desktop card actions inert after responsive expansion', async () => {
    const view = render(<CourseCatalog />)
    await screen.findByRole('button', { name: 'Ver detalles de Curso de prueba' })
    expect(document.querySelector('[inert]')).not.toBeNull()
    mocks.width = 1200
    view.rerender(<CourseCatalog />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Editar' })).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Editar' }).closest('[inert]')).toBeNull()
  })
})
