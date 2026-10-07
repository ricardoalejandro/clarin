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
