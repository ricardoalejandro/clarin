import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ProgramsPage from '@/app/dashboard/programs/page'

const fixture = vi.hoisted(() => ({ api: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: fixture.api }))
vi.mock('@/components/offline-v5/ClarinRuntimeProvider', () => ({ useClarinRuntime: () => ({ isOffline: false, requireOnline: () => true }) }))
vi.mock('@/components/responsive/useContainerWidth', () => ({ useContainerWidth: () => ({ ref: { current: null }, width: 1100 }) }))
vi.mock('@/components/programs/ProgramSettingsDialog', () => ({ ProgramSettingsDialog: () => null }))

const program = (id: string, status = 'active') => ({ id, account_id: 'account-1', name: id, type: 'course', status, color: '#10b981' })
const folders = { success: true, data: { success: true, folders: [] } }

beforeEach(() => {
  fixture.api.mockReset()
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })) as unknown as typeof window.matchMedia
  fixture.api.mockImplementation(async (endpoint: string, options?: RequestInit) => {
    if (endpoint.startsWith('/api/programs/folders')) return folders
    if (endpoint.startsWith('/api/programs/dashboard')) return { success: false, error: 'Dashboard unavailable' }
    if (options?.method === 'DELETE') return { success: false, status: 409, error: 'Este programa contiene datos o actividad. Archívalo para conservar su historial.' }
    return { success: true, data: [program('Retained group')] }
  })
})
afterEach(cleanup)

describe('ProgramsPage lifecycle scopes and preservation', () => {
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
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar' }))
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
