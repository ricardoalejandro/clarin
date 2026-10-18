import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ProgramsPage from '@/app/dashboard/programs/page'

const fixture = vi.hoisted(() => ({ api: vi.fn(), width: 1100 }))
vi.mock('@/lib/api', () => ({ api: fixture.api }))
vi.mock('@/components/offline-v5/ClarinRuntimeProvider', () => ({ useClarinRuntime: () => ({ isOffline: false, requireOnline: () => true }) }))
vi.mock('@/components/responsive/useContainerWidth', () => ({ useContainerWidth: () => ({ ref: { current: null }, width: fixture.width }) }))
vi.mock('@/components/programs/useProgramWorkspacePolicy', () => ({ useProgramWorkspacePolicy: (width: number) => ({ mobile: width < 700, desktopActions: width >= 700, touch: width < 820 }) }))
vi.mock('@/components/programs/ProgramSettingsDialog', () => ({ ProgramSettingsDialog: () => null }))

const program = (id: string, status = 'active') => ({ id, account_id: 'account-1', name: id, type: 'course', status, color: '#10b981' })
const folders = { success: true, data: { success: true, folders: [] } }

beforeEach(() => {
  fixture.width = 1100
  fixture.api.mockReset()
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })) as unknown as typeof window.matchMedia
  fixture.api.mockImplementation(async (endpoint: string, options?: RequestInit) => {
    if (endpoint.startsWith('/api/programs/folders')) return folders
    if (endpoint.startsWith('/api/programs/dashboard')) return { success: false, error: 'Dashboard unavailable' }
    if (options?.method === 'DELETE') return { success: false, status: 409, error: 'Este programa contiene datos o actividad. Archívalo para conservar su historial.' }
    return { success: true, data: [program('Retained group')] }
  })
})

describe('ProgramsPage mobile consultation policy', () => {
  it('hides all administration for normal and legacy programs while preserving consultation', async () => {
    fixture.width = 522
    fixture.api.mockImplementation(async (endpoint: string) => endpoint.startsWith('/api/programs/folders') ? folders
      : endpoint.startsWith('/api/programs/dashboard') ? { success: false }
        : { success: true, data: [program('Class group'), { ...program('Legacy group'), type: 'event' }] })
    render(<ProgramsPage />)
    expect(await screen.findByRole('link', { name: /Class group/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Legacy group/ })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Administrar cursos' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Nuevo|Crear|Editar|Eliminar|Acciones|Carpeta|Metas/ })).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Buscar programas' })).toBeInTheDocument()
    expect(fixture.api.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
  })

  it('uses a consultation empty state without hidden creation affordances', async () => {
    fixture.width = 320
    fixture.api.mockImplementation(async (endpoint: string) => endpoint.startsWith('/api/programs/folders') ? folders
      : endpoint.startsWith('/api/programs/dashboard') ? { success: false }
        : { success: true, data: [] })
    render(<ProgramsPage />)
    expect(await screen.findByText('No hay grupos de clases')).toBeInTheDocument()
    expect(screen.getByText(/Los grupos se administran desde la vista de escritorio/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Nuevo|Crear/ })).not.toBeInTheDocument()
  })

  it('pauses creation without losing its draft and rejects an old submit until desktop resumes', async () => {
    const view = render(<ProgramsPage />)
    await screen.findByText('Retained group')
    fireEvent.click(screen.getByRole('button', { name: /^Nuevo grupo/ }))
    const name = screen.getByPlaceholderText('Ej: Taller de Verano 2024')
    fireEvent.change(name, { target: { value: 'Draft group' } })
    const form = name.closest('form')!
    fixture.width = 522
    view.rerender(<ProgramsPage />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(name.closest('[inert]')).not.toBeNull()
    fireEvent.submit(form)
    expect(fixture.api.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0)
    fixture.width = 1100
    view.rerender(<ProgramsPage />)
    expect(screen.getByPlaceholderText('Ej: Taller de Verano 2024')).toHaveValue('Draft group')
    fireEvent.submit(form)
    await waitFor(() => expect(fixture.api.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1))
  })

  it('preserves delete confirmation through mobile and never writes from its suspended callback', async () => {
    const view = render(<ProgramsPage />)
    await screen.findByText('Retained group')
    fireEvent.click(screen.getByRole('button', { name: 'Acciones de Retained group' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Eliminar' }))
    const confirm = screen.getByRole('button', { name: 'Confirmar' })
    fixture.width = 522
    view.rerender(<ProgramsPage />)
    fireEvent.click(confirm)
    expect(fixture.api.mock.calls.filter(([, options]) => options?.method === 'DELETE')).toHaveLength(0)
    fixture.width = 1100
    view.rerender(<ProgramsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }))
    await waitFor(() => expect(fixture.api.mock.calls.filter(([, options]) => options?.method === 'DELETE')).toHaveLength(1))
  })

  it('does not duplicate a creation already in flight when the viewport changes', async () => {
    let resolveCreate!: (value: unknown) => void
    const baseMock = fixture.api.getMockImplementation()!
    fixture.api.mockImplementation((endpoint: string, options?: RequestInit) => options?.method === 'POST'
      ? new Promise(resolve => { resolveCreate = resolve }) : baseMock(endpoint, options))
    const view = render(<ProgramsPage />)
    await screen.findByText('Retained group')
    fireEvent.click(screen.getByRole('button', { name: /^Nuevo grupo/ }))
    const form = screen.getByPlaceholderText('Ej: Taller de Verano 2024').closest('form')!
    fireEvent.change(screen.getByPlaceholderText('Ej: Taller de Verano 2024'), { target: { value: 'One create' } })
    fireEvent.submit(form)
    fireEvent.submit(form)
    fixture.width = 522
    view.rerender(<ProgramsPage />)
    await act(async () => resolveCreate({ success: true }))
    fixture.width = 1100
    view.rerender(<ProgramsPage />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(fixture.api.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
  })

  it('retains an in-flight creation error and draft until desktop resumes', async () => {
    let resolveCreate!: (value: unknown) => void
    const baseMock = fixture.api.getMockImplementation()!
    fixture.api.mockImplementation((endpoint: string, options?: RequestInit) => options?.method === 'POST'
      ? new Promise(resolve => { resolveCreate = resolve }) : baseMock(endpoint, options))
    const view = render(<ProgramsPage />)
    await screen.findByText('Retained group')
    fireEvent.click(screen.getByRole('button', { name: /^Nuevo grupo/ }))
    const name = screen.getByPlaceholderText('Ej: Taller de Verano 2024')
    fireEvent.change(name, { target: { value: 'Borrador recuperable' } })
    fireEvent.submit(name.closest('form')!)
    fixture.width = 522
    view.rerender(<ProgramsPage />)
    vi.useFakeTimers()
    try {
      await act(async () => resolveCreate({ success: false, error: 'Creación interrumpida' }))
      expect(screen.queryByText('Creación interrumpida')).not.toBeInTheDocument()
      act(() => vi.advanceTimersByTime(5000))
    } finally {
      vi.useRealTimers()
    }
    fixture.width = 1100
    view.rerender(<ProgramsPage />)
    expect(screen.getByText('Creación interrumpida')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Ej: Taller de Verano 2024')).toHaveValue('Borrador recuperable')
    expect(fixture.api.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
  })
})
afterEach(cleanup)

describe('ProgramsPage lifecycle scopes and preservation', () => {
  it.each(['Lista', 'Compacta'])('offers the complete lifecycle menu from %s without navigating or writing before confirmation', async viewName => {
    const source = { ...program('Managed group'), updated_at: '2026-10-18T12:00:00Z' }
    const baseMock = fixture.api.getMockImplementation()!
    fixture.api.mockImplementation(async (endpoint: string, options?: RequestInit) => {
      if (options?.method === 'PUT') return { success: true, data: { ...source, status: 'completed', updated_at: '2026-10-18T12:01:00Z' } }
      if (endpoint === '/api/programs?status=active') return { success: true, data: [source] }
      return baseMock(endpoint, options)
    })
    render(<ProgramsPage />)
    await screen.findByText('Managed group')
    fireEvent.click(screen.getByRole('button', { name: viewName }))
    const trigger = screen.getByRole('button', { name: 'Acciones de Managed group' })
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger.className).toContain('h-11 w-11')
    fireEvent.click(trigger)
    const menu = screen.getByRole('menu', { name: 'Acciones de Managed group' })
    expect(menu.parentElement).toBe(document.body)
    expect(trigger).toHaveAttribute('aria-controls', menu.id)
    expect(screen.getByRole('menuitem', { name: 'Editar' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Archivar programa' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Concluir programa' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('alertdialog', { name: 'Concluir programa' })).toBeInTheDocument()
    expect(fixture.api.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Concluir programa' }))
    await waitFor(() => expect(fixture.api.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(1))
    const [, request] = fixture.api.mock.calls.find(([, options]) => options?.method === 'PUT')!
    expect(JSON.parse(request.body)).toMatchObject({ status: 'completed', expected_updated_at: source.updated_at })
    await waitFor(() => expect(screen.queryByText('Managed group')).not.toBeInTheDocument())
  })

  it('closes the portaled menu on Escape, restores its trigger focus and drops it when mobile begins', async () => {
    const view = render(<ProgramsPage />)
    await screen.findByText('Retained group')
    const trigger = screen.getByRole('button', { name: 'Acciones de Retained group' })
    fireEvent.click(trigger)
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Editar' })).toHaveFocus())
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    fireEvent.click(trigger)
    fixture.width = 560
    view.rerender(<ProgramsPage />)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Acciones de Retained group' })).not.toBeInTheDocument()
  })

  it('shows the real empty state only for a successful array response', async () => {
    fixture.api.mockImplementation(async (endpoint: string) => endpoint.startsWith('/api/programs/folders') ? folders
      : endpoint.startsWith('/api/programs/dashboard') ? { success: false }
        : { success: true, data: [] })
    render(<ProgramsPage />)
    expect(await screen.findByText('Crea tu primer grupo de clases')).toBeInTheDocument()
    expect(screen.queryByText('La información no está disponible en este momento')).not.toBeInTheDocument()
  })

  it('shows one calm initial notice for an invalid response and recovers on retry', async () => {
    let attempts = 0
    fixture.api.mockImplementation(async (endpoint: string) => endpoint.startsWith('/api/programs/folders') ? folders
      : endpoint.startsWith('/api/programs/dashboard') ? new Promise(() => {})
        : { success: true, data: ++attempts === 1 ? null : [] })
    render(<ProgramsPage />)
    expect(await screen.findByText('La información no está disponible en este momento')).toBeInTheDocument()
    expect(screen.getAllByText('No pudimos cargar tus programas. Puedes volver a intentarlo.')).toHaveLength(1)
    expect(screen.queryByText('Crea tu primer grupo de clases')).not.toBeInTheDocument()
    expect(screen.getByRole('status').className).not.toContain('red-')
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }))
    expect(await screen.findByText('Crea tu primer grupo de clases')).toBeInTheDocument()
    expect(screen.queryByText('No pudimos cargar tus programas. Puedes volver a intentarlo.')).not.toBeInTheDocument()
  })

  it('preserves loaded rows when folders and later refreshes fail', async () => {
    let attempts = 0
    fixture.api.mockImplementation(async (endpoint: string) => endpoint.startsWith('/api/programs/folders') ? { success: false }
      : endpoint.startsWith('/api/programs/dashboard') ? new Promise(() => {})
        : ++attempts === 1 ? { success: true, data: [program('Preserved group')] } : { success: false })
    render(<ProgramsPage />)
    expect(await screen.findByText('Preserved group')).toBeInTheDocument()
    expect(screen.queryByText('La información no está disponible en este momento')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }))
    expect(await screen.findByText(/No pudimos cargar tus programas/)).toBeInTheDocument()
    expect(screen.getByText('Preserved group')).toBeInTheDocument()
    expect(screen.getAllByRole('status')).toHaveLength(1)
  })

  it('shows one health failure when expanded and never invents zero alerts', async () => {
    render(<ProgramsPage />)
    expect(await screen.findByText('La salud general no está disponible en este momento. Puedes volver a intentarlo.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Salud general/ }))
    expect(screen.getAllByText('La salud general no está disponible en este momento. Puedes volver a intentarlo.')).toHaveLength(1)
    expect(screen.queryByText('Sin alertas')).not.toBeInTheDocument()
  })

  it('renders a neutral zero only from a valid health snapshot', async () => {
    fixture.api.mockImplementation(async (endpoint: string) => endpoint.startsWith('/api/programs/folders') ? folders
      : endpoint.startsWith('/api/programs/dashboard') ? { success: true, data: { success: true, dashboard: { groups: [], critical_participants: 0, attendance_goal_percent: 80, transfer_goal_percent: 70, attendance_rate: null, transfer_rate: 0 } } }
        : { success: true, data: [] })
    render(<ProgramsPage />)
    const label = await screen.findByText('Sin alertas')
    expect(label.className).toContain('text-slate-500')
    expect(label.className).not.toContain('red-')
  })

  it('switches programs and folders together, rejects old rows, and leaves dashboard request alive', async () => {
    let resolveOld!: (response: unknown) => void
    let dashboardSignal: AbortSignal | undefined
    fixture.api.mockImplementation(async (endpoint: string, options?: RequestInit) => {
      if (endpoint.startsWith('/api/programs/folders')) return folders
      if (endpoint.startsWith('/api/programs/dashboard')) { dashboardSignal = options?.signal as AbortSignal; return new Promise(() => {}) }
      if (endpoint.includes('status=active')) return new Promise(done => { resolveOld = done })
      return { success: true, data: [program('Archived group', 'archived')] }
    })
    render(<ProgramsPage />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Estado de programas' }), { target: { value: 'archived' } })
    expect(await screen.findByText('Archived group')).toBeInTheDocument()
    expect(fixture.api).toHaveBeenCalledWith('/api/programs/folders?status=archived', expect.anything())
    expect(dashboardSignal?.aborted).toBe(false)
    await act(async () => resolveOld({ success: true, data: [program('Stale active group')] }))
    expect(screen.queryByText('Stale active group')).not.toBeInTheDocument()
  })

  it('keeps a retained program visible after deletion conflict and explains archive', async () => {
    render(<ProgramsPage />)
    expect(await screen.findByText('Retained group')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Acciones de Retained group' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Eliminar' }))
    expect(screen.getByText(/¿Eliminar este programa vacío/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }))
    expect(await screen.findByText('Este programa contiene datos o actividad. Archívalo para conservar su historial.')).toBeInTheDocument()
    expect(screen.getByText('Retained group')).toBeInTheDocument()
  })

  it('returns to the active scope after creating from historical programs', async () => {
    let created = false
    fixture.api.mockImplementation(async (endpoint: string, options?: RequestInit) => {
      if (endpoint.startsWith('/api/programs/folders')) return folders
      if (endpoint.startsWith('/api/programs/dashboard')) return { success: false, error: 'Dashboard unavailable' }
      if (options?.method === 'POST') { created = true; return { success: true, data: program('New group') } }
      return { success: true, data: endpoint.includes('status=archived') ? [program('Archived group', 'archived')] : created ? [program('New group')] : [] }
    })
    render(<ProgramsPage />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Estado de programas' }), { target: { value: 'archived' } })
    expect(await screen.findByText('Archived group')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^Nuevo grupo/ }))
    fireEvent.change(screen.getByPlaceholderText('Ej: Taller de Verano 2024'), { target: { value: 'New group' } })
    fireEvent.click(screen.getByRole('button', { name: 'Crear grupo' }))
    expect(await screen.findByText('New group')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Estado de programas' })).toHaveValue('active')
    await waitFor(() => expect(fixture.api).toHaveBeenCalledWith('/api/programs/folders?status=active', expect.anything()))
  })
})
