import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import EventConfigurationWindow from './EventConfigurationWindow'

const { mockApi, socketListeners } = vi.hoisted(() => ({ mockApi: vi.fn(), socketListeners: new Set<(message: unknown) => void>() }))
vi.mock('@/lib/api', () => ({ api: mockApi, subscribeWebSocket: (listener: (message: unknown) => void) => { socketListeners.add(listener); return () => socketListeners.delete(listener) } }))
vi.mock('@/lib/authScope', () => ({ getAuthScope: () => 'account:user', subscribeAuthScope: () => () => {} }))
vi.mock('@/components/operational-window/OperationalWindowShell', () => ({ default: ({ open, children, footer }: { open: boolean; children: ReactNode; footer: ReactNode }) => open ? <section>{children}{footer}</section> : null }))
vi.mock('@/components/task-work/TaskContainerAppearance', () => ({ TaskColorPicker: () => <span>Color</span> }))
vi.mock('@/components/task-work/TaskSelectPicker', () => ({ TaskSelectPicker: ({ value, options, onChange, label }: { value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void; label: string }) => <select aria-label={label} value={value} onChange={event => onChange(event.target.value)}>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select> }))
vi.mock('@/components/operational-date/OperationalDatePicker', () => ({ default: () => <span>Fecha</span> }))
vi.mock('./EventStageEditor', () => ({ default: ({ stages, onChange }: { stages: Array<{ name: string }>; onChange: (stages: Array<{ name: string }>) => void }) => <input aria-label="Etapa de prueba" value={stages[0]?.name || ''} onChange={event => onChange(stages.map((stage, index) => index ? stage : { ...stage, name: event.target.value }))} /> }))
vi.mock('./EventRulesEditor', () => ({ default: () => <span>Reglas cargadas</span> }))

const event = { id: 'event-a', name: 'Evento original', color: '#123456', status: 'active', updated_at: '2026-10-12T12:00:00Z' }
const layout = { success: true, pipeline_id: 'pipeline-a', revision: 2, stages: [{ id: 'stage-a', name: 'Invitados', color: '#123456', position: 0, participant_count: 20 }] }
afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  mockApi.mockImplementation(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/stages/layout')) return { success: true, data: layout }
    if (url.endsWith('/tags')) return { success: true, data: { success: true, tags: [], formula_mode: 'OR', tag_formula_type: 'simple' } }
    return { success: true, data: { success: true, event: options?.method === 'PUT' ? { ...event, ...JSON.parse(String(options.body)) } : event } }
  })
})
describe('event configuration sections', () => {
  it('saves only metadata and leaves the window open', async () => {
    const saved = vi.fn(), close = vi.fn()
    render(<EventConfigurationWindow open eventId="event-a" onClose={close} onSaved={saved} />)
    const name = await screen.findByLabelText('Nombre del evento')
    fireEvent.change(name, { target: { value: 'Nueva jornada' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar datos' }))
    await waitFor(() => expect(saved).toHaveBeenCalledWith('event-a', 'data', expect.anything()))
    const mutations = mockApi.mock.calls.filter(([, options]) => options?.method === 'PUT')
    expect(mutations).toHaveLength(1)
    expect(mutations[0][0]).toBe('/api/events/event-a')
    expect(JSON.parse(mutations[0][1].body)).toMatchObject({ name: 'Nueva jornada', expected_updated_at: event.updated_at })
    expect(mockApi.mock.calls.some(([url]) => url.includes('/tags'))).toBe(false)
    expect(close).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Nombre del evento')).toHaveValue('Nueva jornada')
  })
  it('preserves independent drafts across tabs and a failed stage save', async () => {
    const saved = vi.fn()
    render(<EventConfigurationWindow open eventId="event-a" onClose={vi.fn()} onSaved={saved} />)
    fireEvent.change(await screen.findByLabelText('Nombre del evento'), { target: { value: 'Borrador de datos' } })
    fireEvent.click(screen.getByRole('tab', { name: 'Etapas' }))
    fireEvent.change(await screen.findByLabelText('Etapa de prueba'), { target: { value: 'Primer contacto' } })
    fireEvent.click(screen.getByRole('tab', { name: /Datos/ }))
    expect(screen.getByLabelText('Nombre del evento')).toHaveValue('Borrador de datos')
    fireEvent.click(screen.getByRole('tab', { name: /Etapas/ }))
    expect(screen.getByLabelText('Etapa de prueba')).toHaveValue('Primer contacto')
    mockApi.mockResolvedValueOnce({ success: false, error: 'Sin conexión', status: 503 })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar etapas' }))
    expect(await screen.findByText('Sin conexión')).toBeVisible()
    expect(screen.getByLabelText('Etapa de prueba')).toHaveValue('Primer contacto')
    expect(saved).not.toHaveBeenCalled()
  })
  it('retains a conflict draft and requires explicit reload', async () => {
    render(<EventConfigurationWindow open eventId="event-a" initialSection="stages" onClose={vi.fn()} />)
    fireEvent.change(await screen.findByLabelText('Etapa de prueba'), { target: { value: 'Pendiente local' } })
    mockApi.mockResolvedValueOnce({ success: false, error: 'Etapas cambiaron', status: 409 })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar etapas' }))
    await screen.findByText('Etapas cambiaron')
    expect(screen.getByLabelText('Etapa de prueba')).toHaveValue('Pendiente local')
    expect(screen.getByRole('button', { name: 'Guardar etapas' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Recargar esta sección' }))
    expect(screen.getByRole('alertdialog', { name: 'Recargar la sección' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    expect(screen.getByLabelText('Etapa de prueba')).toHaveValue('Pendiente local')
  })
  it('creates a safe draft and enables configuration without navigating away', async () => {
    const created = vi.fn()
    mockApi.mockResolvedValue({ success: true, data: { success: true, event: { ...event, status: 'draft' } } })
    render(<EventConfigurationWindow open onClose={vi.fn()} onCreated={created} folderId="folder-a" />)
    fireEvent.change(screen.getByLabelText('Nombre del evento'), { target: { value: 'Jornada nueva' } })
    expect(screen.getByRole('tab', { name: 'Etapas' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Crear borrador' }))
    await waitFor(() => expect(created).toHaveBeenCalledWith('event-a'))
    expect(JSON.parse(mockApi.mock.calls[0][1].body)).toMatchObject({ status: 'draft', folder_id: 'folder-a' })
    expect(screen.getByRole('tab', { name: 'Etapas' })).toBeEnabled()
  })
})

describe('metadata baseline after contextual saves', () => {
  it('preserves a dirty data draft and uses the canonical version after saving stages', async () => {
    const saved = vi.fn()
    let metadataReads = 0
    mockApi.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url.endsWith('/stages/layout')) return { success: true, data: layout }
      if (options?.method === 'PUT') return { success: true, data: { success: true, event: { ...event, ...JSON.parse(String(options.body)) } } }
      metadataReads++
      return { success: true, data: { success: true, event: { ...event, updated_at: metadataReads > 1 ? '2026-10-12T13:00:00Z' : event.updated_at } } }
    })
    render(<EventConfigurationWindow open eventId="event-a" onClose={vi.fn()} onSaved={saved} />)
    fireEvent.change(await screen.findByLabelText('Nombre del evento'), { target: { value: 'Mi borrador' } })
    fireEvent.click(screen.getByRole('tab', { name: 'Etapas' }))
    fireEvent.change(await screen.findByLabelText('Etapa de prueba'), { target: { value: 'Contacto inicial' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar etapas' }))
    await waitFor(() => expect(saved).toHaveBeenCalledWith('event-a', 'stages', expect.anything()))
    fireEvent.click(screen.getByRole('tab', { name: /Datos/ }))
    expect(screen.getByLabelText('Nombre del evento')).toHaveValue('Mi borrador')
    fireEvent.click(screen.getByRole('button', { name: 'Guardar datos' }))
    await waitFor(() => expect(saved).toHaveBeenCalledWith('event-a', 'data', expect.anything()))
    const dataWrite = mockApi.mock.calls.find(([url, options]) => url === '/api/events/event-a' && options?.method === 'PUT')
    expect(JSON.parse(dataWrite![1].body)).toMatchObject({ name: 'Mi borrador', expected_updated_at: '2026-10-12T13:00:00Z' })
  })
  it('does not bless a stale data draft when another editor changed metadata', async () => {
    const saved = vi.fn()
    let metadataReads = 0
    mockApi.mockImplementation(async (url: string) => {
      if (url.endsWith('/stages/layout')) return { success: true, data: layout }
      metadataReads++
      return { success: true, data: { success: true, event: metadataReads > 1 ? { ...event, name: 'Cambio remoto', updated_at: '2026-10-12T13:00:00Z' } : event } }
    })
    render(<EventConfigurationWindow open eventId="event-a" onClose={vi.fn()} onSaved={saved} />)
    fireEvent.change(await screen.findByLabelText('Nombre del evento'), { target: { value: 'Mi borrador' } })
    fireEvent.click(screen.getByRole('tab', { name: 'Etapas' }))
    fireEvent.change(await screen.findByLabelText('Etapa de prueba'), { target: { value: 'Contacto inicial' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar etapas' }))
    await waitFor(() => expect(saved).toHaveBeenCalledWith('event-a', 'stages', expect.anything()))
    fireEvent.click(screen.getByRole('tab', { name: /Datos/ }))
    expect(screen.getByLabelText('Nombre del evento')).toHaveValue('Mi borrador')
    expect(screen.getByRole('button', { name: 'Guardar datos' })).toBeDisabled()
    expect(screen.getByText(/Los datos cambiaron en otra sesión/)).toBeVisible()
  })
})

it('freezes an open window after a remote close while preserving the local draft', async () => {
  render(<EventConfigurationWindow open eventId="event-a" onClose={vi.fn()} />)
  fireEvent.change(await screen.findByLabelText('Nombre del evento'), { target: { value: 'Borrador local' } })
  mockApi.mockResolvedValueOnce({ success: true, data: { success: true, event: { ...event, status: 'completed', updated_at: '2026-10-12T14:00:00Z' } } })
  socketListeners.forEach(listener => listener({ event: 'event_update', data: { event_id: 'event-a' } }))
  await screen.findByText('Este evento está cerrado. Su configuración e historial se conservan.')
  expect(screen.getByLabelText('Nombre del evento')).toHaveValue('Borrador local')
  expect(screen.getByLabelText('Nombre del evento')).toBeDisabled()
  expect(screen.queryByRole('button', { name: 'Guardar datos' })).not.toBeInTheDocument()
  expect(screen.getByText(/Los datos cambiaron en otra sesión/)).toBeVisible()
})

it('navigates external section requests without resetting drafts', async () => {
  const props = { open: true, eventId: 'event-a', onClose: vi.fn() }
  const view = render(<EventConfigurationWindow {...props} initialSection="data" />)
  fireEvent.change(await screen.findByLabelText('Nombre del evento'), { target: { value: 'Nombre pendiente' } })
  view.rerender(<EventConfigurationWindow {...props} initialSection="stages" />)
  fireEvent.change(await screen.findByLabelText('Etapa de prueba'), { target: { value: 'Etapa pendiente' } })
  view.rerender(<EventConfigurationWindow {...props} initialSection="rules" />)
  await screen.findByText('Reglas cargadas')
  fireEvent.click(screen.getByRole('tab', { name: /Datos/ }))
  expect(screen.getByLabelText('Nombre del evento')).toHaveValue('Nombre pendiente')
  fireEvent.click(screen.getByRole('tab', { name: /Etapas/ }))
  expect(screen.getByLabelText('Etapa de prueba')).toHaveValue('Etapa pendiente')
  expect(mockApi.mock.calls.filter(([url]) => url === '/api/events/event-a')).toHaveLength(1)
})

it('dismisses a pending lifecycle mutation when the event closes remotely', async () => {
  render(<EventConfigurationWindow open eventId="event-a" onClose={vi.fn()} />)
  await screen.findByLabelText('Nombre del evento')
  fireEvent.change(screen.getByLabelText('Estado del evento'), { target: { value: 'completed' } })
  fireEvent.click(screen.getByRole('button', { name: 'Guardar datos' }))
  expect(screen.getByRole('alertdialog', { name: 'Cerrar el evento' })).toBeVisible()
  mockApi.mockResolvedValueOnce({ success: true, data: { success: true, event: { ...event, status: 'completed', updated_at: '2026-10-12T14:00:00Z' } } })
  socketListeners.forEach(listener => listener({ event: 'event_update', data: { event_id: 'event-a' } }))
  await waitFor(() => expect(screen.queryByRole('alertdialog', { name: 'Cerrar el evento' })).not.toBeInTheDocument())
  expect(screen.getByLabelText('Nombre del evento')).toBeDisabled()
  expect(mockApi.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(0)
})
