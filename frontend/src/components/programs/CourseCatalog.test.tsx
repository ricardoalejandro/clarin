import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Course } from '@/types/course'
import CourseCatalog from './CourseCatalog'

const mocks = vi.hoisted(() => ({ api: vi.fn(), width: 768 }))
vi.mock('@/lib/api', () => ({ api: mocks.api }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/components/responsive/useContainerWidth', () => ({ useContainerWidth: () => ({ ref: { current: null }, width: mocks.width }) }))

const course: Course = {
  id: 'course-test', account_id: 'account-test', name: 'Curso de prueba', description: 'Descripción del curso',
  status: 'active', position: 1, usage_count: 0, topic_count: 1, active_topic_count: 1, topic_preview: ['Primer tema'],
  created_at: '2026-09-14T12:00:00Z', updated_at: '2026-09-14T12:00:00Z', topics: [],
}

beforeEach(() => {
  mocks.width = 768
  mocks.api.mockReset().mockResolvedValue({ success: true, data: { courses: [course], total: 1, page: 1, page_size: 10 } })
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
