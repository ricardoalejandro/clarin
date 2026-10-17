import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProgramAcademicConfig, ProgramCourse } from '@/types/program'
import ProgramAcademicConfigPanel from './ProgramAcademicConfigPanel'

const fixture = vi.hoisted(() => ({ api: vi.fn(), fetch: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: fixture.api }))
vi.mock('@/components/LeadPolicyProvider', () => ({ useLeadPolicy: () => ({ leadsEnabled: true }) }))
vi.mock('@/components/FormulaEditor', () => ({ default: () => null }))
const course = (id: string, name: string): ProgramCourse => ({
  id, name, account_id: 'account-test', status: 'active', position: 0, usage_count: 0, topic_count: 0,
  active_topic_count: 0, topic_preview: [], created_at: '', updated_at: '', topics: [],
})
const first = course('first', 'Primer curso')
const second = course('second', 'Segundo curso')
const config: ProgramAcademicConfig = {
  program_id: 'program-test', updated_at: 'version-1', courses: [first, second],
  instructors: [{ contact_id: 'existing', contact_name: 'Instructor actual', avatar_url: '/instructor.png', position: 0 }],
}
const person = { id: 'new-instructor', name: 'Nueva instructora', phone: '', email: '', source_type: 'contact' }
const json = (body: unknown) => ({ ok: true, json: async () => body }) as Response
const makeProps = () => ({
  programId: config.program_id, config, loading: false, onRetry: vi.fn(), onChange: vi.fn(),
  onToast: vi.fn(), onDirtyChange: vi.fn(), onNavigateToCatalog: vi.fn(),
})

beforeEach(() => {
  fixture.api.mockReset().mockResolvedValue({ success: true, data: { courses: [], total: 0 } })
  fixture.fetch.mockReset().mockImplementation(async (url: string) => json(url.startsWith('/api/people/search')
    ? { success: true, people: [person], total: 1 }
    : { success: true, tags: [] }))
  vi.stubGlobal('fetch', fixture.fetch)
  document.body.style.overflow = ''
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('ProgramAcademicConfigPanel responsive suspension', () => {
  it('retains the academic draft and instructor selection across suspension and canonical conflict', async () => {
    const props = makeProps()
    const view = render(<ProgramAcademicConfigPanel {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Desasociar Primer curso' }))
    const savePlan = screen.getByRole('button', { name: 'Guardar plan' })
    fireEvent.click(screen.getByRole('button', { name: 'Agregar instructor' }))
    fireEvent.click(await screen.findByRole('button', { name: /Nueva instructora/ }))
    const latest = { ...config, updated_at: 'version-2' }
    view.rerender(<ProgramAcademicConfigPanel {...props} config={latest} suspended />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(savePlan.closest('[hidden][inert]')).not.toBeNull()
    fireEvent.click(savePlan)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(fixture.api).not.toHaveBeenCalled()
    expect(props.onDirtyChange).toHaveBeenLastCalledWith(true)

    view.rerender(<ProgramAcademicConfigPanel {...props} config={latest} />)
    expect(screen.queryByText('Primer curso')).not.toBeInTheDocument()
    expect(screen.getByText('El programa cambió mientras lo editabas')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Agregar instructores (1)' }))
    expect(screen.getByText('Nueva instructora')).toBeInTheDocument()
    const saved: ProgramAcademicConfig = { ...latest, updated_at: 'version-3', courses: [second], instructors: [...config.instructors, { contact_id: person.id, contact_name: person.name, position: 1 }] }
    fixture.api.mockResolvedValueOnce({ success: true, data: saved })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar instructores' }))
    await waitFor(() => expect(props.onChange).toHaveBeenCalledWith(saved))
    expect(fixture.api).toHaveBeenCalledExactlyOnceWith('/api/programs/program-test/academic-config', {
      method: 'PUT', body: JSON.stringify({ course_ids: ['second'], contact_ids: ['existing', 'new-instructor'], expected_updated_at: 'version-2' }),
    })
    expect(screen.getByRole('button', { name: 'Guardar plan' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Guardar instructores' })).toBeDisabled()
  })

  it('aborts course reads, preserves search, and rejects late results while its portal is paused', async () => {
    const props = makeProps()
    let resolveOld!: (value: unknown) => void
    let oldSignal!: AbortSignal
    fixture.api.mockImplementationOnce((_path: string, options: RequestInit) => {
      oldSignal = options.signal as AbortSignal
      return new Promise(resolve => { resolveOld = resolve })
    }).mockResolvedValue({ success: true, data: { courses: [course('new', 'Nuevo curso')], total: 1 } })
    const view = render(<ProgramAcademicConfigPanel {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Agregar curso' }))
    fireEvent.change(screen.getByPlaceholderText('Buscar por nombre o descripción'), { target: { value: 'Nuevo' } })
    view.rerender(<ProgramAcademicConfigPanel {...props} suspended />)
    expect(oldSignal.aborted).toBe(true)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(document.body.style.overflow).toBe('')
    await act(async () => {
      resolveOld({ success: true, data: { courses: [course('old', 'Nuevo obsoleto')], total: 1 } })
      await new Promise(resolve => window.setTimeout(resolve, 550))
    })
    expect(fixture.api).toHaveBeenCalledTimes(1)
    view.rerender(<ProgramAcademicConfigPanel {...props} />)
    expect(screen.getByPlaceholderText('Buscar por nombre o descripción')).toHaveValue('Nuevo')
    expect(await screen.findByRole('button', { name: /Nuevo curso/ })).toBeInTheDocument()
    expect(screen.queryByText('Nuevo obsoleto')).not.toBeInTheDocument()
    expect(fixture.api).toHaveBeenCalledTimes(2)
    expect(fixture.api.mock.calls[1][0]).toContain('search=Nuevo')
    expect(fixture.api.mock.calls.every(([, options]) => !options?.method)).toBe(true)
  })

  it('lets a PUT already sent finish once while suspended and keeps its canonical result on resume', async () => {
    const props = makeProps()
    let resolveSave!: (value: unknown) => void
    fixture.api.mockImplementationOnce(() => new Promise(resolve => { resolveSave = resolve }))
    const view = render(<ProgramAcademicConfigPanel {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Desasociar Primer curso' }))
    const save = screen.getByRole('button', { name: 'Guardar plan' })
    fireEvent.click(save)
    view.rerender(<ProgramAcademicConfigPanel {...props} suspended />)
    fireEvent.click(save)
    const saved = { ...config, updated_at: 'version-2', courses: [second] }
    await act(async () => { resolveSave({ success: true, data: saved }) })
    expect(fixture.api).toHaveBeenCalledTimes(1)
    expect(props.onChange).toHaveBeenCalledWith(saved)
    view.rerender(<ProgramAcademicConfigPanel {...props} config={saved} />)
    expect(screen.queryByText('Primer curso')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Guardar plan' })).toBeDisabled()
  })

  it('retains a suspended write conflict and failed retry without discarding the draft', async () => {
    const props = makeProps()
    let resolveConflict!: (value: unknown) => void
    const latest = { ...config, updated_at: 'version-2' }
    fixture.api.mockImplementationOnce(() => new Promise(resolve => { resolveConflict = resolve }))
      .mockResolvedValueOnce({ success: true, data: latest })
      .mockResolvedValueOnce({ success: false, error: 'No se pudo guardar' })
    const view = render(<ProgramAcademicConfigPanel {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Desasociar Primer curso' }))
    fireEvent.click(screen.getByRole('button', { name: 'Guardar plan' }))
    view.rerender(<ProgramAcademicConfigPanel {...props} suspended />)
    await act(async () => { resolveConflict({ success: false, status: 409 }) })
    expect(fixture.api).toHaveBeenCalledTimes(2)
    expect(props.onChange).not.toHaveBeenCalled()
    view.rerender(<ProgramAcademicConfigPanel {...props} />)
    expect(screen.getByText('El programa cambió mientras lo editabas')).toBeInTheDocument()
    expect(screen.queryByText('Primer curso')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Guardar plan' }))
    await waitFor(() => expect(props.onToast).toHaveBeenLastCalledWith('No se pudo guardar', 'error'))
    expect(JSON.parse(fixture.api.mock.calls[2][1].body)).toEqual({ course_ids: ['second'], contact_ids: ['existing'], expected_updated_at: 'version-2' })
    expect(screen.getByRole('button', { name: 'Guardar plan' })).toBeEnabled()
    expect(screen.queryByText('Primer curso')).not.toBeInTheDocument()
  })

  it('ignores a late write result after the owning program session is unmounted', async () => {
    const props = makeProps()
    let resolveSave!: (value: unknown) => void
    fixture.api.mockImplementationOnce(() => new Promise(resolve => { resolveSave = resolve }))
    const view = render(<ProgramAcademicConfigPanel {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Desasociar Primer curso' }))
    fireEvent.click(screen.getByRole('button', { name: 'Guardar plan' }))
    view.unmount()
    await act(async () => { resolveSave({ success: true, data: { ...config, courses: [second] } }) })
    expect(props.onChange).not.toHaveBeenCalled()
    expect(props.onToast).not.toHaveBeenCalled()
  })
})
