import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ params: new URLSearchParams('tab=devices'), listeners: new Set<(value: unknown) => void>(), router: { replace: vi.fn(), push: vi.fn() } }))
vi.mock('next/navigation', () => ({ useSearchParams: () => mocks.params, useRouter: () => mocks.router }))
vi.mock('@/lib/api', () => ({ logoutFromBrowser: vi.fn(), subscribeWebSocket: (listener: (value: unknown) => void) => { mocks.listeners.add(listener); return () => mocks.listeners.delete(listener) } }))
vi.mock('@/components/NotificationProvider', () => ({ useNotifications: () => ({ refreshSettings: vi.fn() }) }))
vi.mock('@/lib/notificationSounds', () => ({ getNotificationSettings: async () => null, saveNotificationSettings: vi.fn(), playNotificationSound: vi.fn(), requestNotificationPermission: vi.fn(), SOUND_OPTIONS: [] }))
vi.mock('@/components/settings/OfflineAccessPanelV5', () => ({ default: () => null }))
vi.mock('@/components/settings/QuickRepliesSettings', () => ({ default: () => null }))
vi.mock('@/components/WhatsAppAPISettingsPanel', () => ({ default: () => null }))
vi.mock('@/components/pipelines/PipelineStageManager', () => ({ default: () => null }))
vi.mock('@/components/pipelines/PipelineManagementDialog', () => ({ default: () => null }))

import SettingsPage from '@/app/dashboard/settings/page'
import { CLOUD_DELETION_UNAVAILABLE, LOCAL_DEVICE_DELETION_MESSAGE } from './deviceAdministration'
const json = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response
const device = { id: 'device-1', name: 'Synthetic channel', status: 'connected', provider: 'whatsapp_web', receive_messages: true, phone: '', jid: '', qr_code: '', last_seen_at: '' }
beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('token', 'synthetic-settings-token')
  mocks.router.push.mockClear()
  vi.stubGlobal('matchMedia', vi.fn((media: string) => ({ matches: false, media, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); mocks.listeners.clear() })
function fixture(devices: unknown[], mutation: (input: string, options: RequestInit) => Promise<Response>) {
  const request = vi.fn((input: RequestInfo | URL, options: RequestInit = {}) => {
    const url = String(input)
    if (options.method === 'DELETE' || options.method === 'PUT' || options.method === 'POST') return mutation(url, options)
    if (url === '/api/devices') return Promise.resolve(json({ success: true, devices }))
    if (url === '/api/me') return Promise.resolve(json({ success: true, user: { id: 'actor', username: 'QA', email: '', account_id: 'synthetic-account', account_name: 'Synthetic Account', role: 'admin', is_admin: true } }))
    return Promise.resolve(json({ success: false }))
  })
  vi.stubGlobal('fetch', request)
  return request
}
describe('device administration controls', () => {
  it('routes official signup to Meta without offering a rejected manual POST', async () => {
    const request = fixture([], async () => json({ success: false }))
    render(<SettingsPage />)
    await screen.findByText('No hay dispositivos')
    fireEvent.click(screen.getByRole('button', { name: 'Agregar' }))
    fireEvent.click(screen.getByRole('button', { name: 'Conectar con Meta' }))
    expect(mocks.router.push).toHaveBeenCalledWith('/dashboard/settings?tab=whatsapp-api')
    expect(request.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: 'Crear Canal' })).toBeNull()
  })

  it('single-flights Enter while a create is pending and rejects an oversized name', async () => {
    const request = fixture([], async () => new Promise<Response>(() => {}))
    render(<SettingsPage />)
    await screen.findByText('No hay dispositivos')
    fireEvent.click(screen.getByRole('button', { name: 'Agregar' }))
    const name = screen.getByPlaceholderText('Nombre del canal')
    // HTML maxlength counts UTF-16 units; 255 Unicode code points may need
    // 510 units. The logical validation still rejects 256 ASCII characters.
    expect(name).toHaveAttribute('maxlength', '510')
    fireEvent.change(name, { target: { value: '😀'.repeat(255) } })
    expect(screen.getByRole('button', { name: 'Crear y Conectar' })).toBeEnabled()
    fireEvent.change(name, { target: { value: 'N'.repeat(256) } })
    expect(screen.getByRole('button', { name: 'Crear y Conectar' })).toBeDisabled()
    fireEvent.keyDown(name, { key: 'Enter' })
    expect(request.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0)
    fireEvent.change(name, { target: { value: 'Synthetic pending device' } })
    fireEvent.keyDown(name, { key: 'Enter' })
    fireEvent.keyDown(name, { key: 'Enter' })
    expect(request.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Creando...' })).toBeDisabled()
  })

  it('rolls back a failed row receive mutation, reports the error, and permits retry', async () => {
    let complete!: (response: Response) => void
    const request = fixture([device], async () => new Promise<Response>(resolve => { complete = resolve }))
    render(<SettingsPage />)
    await screen.findByText(device.name)
    const toggle = screen.getByTitle('Recepción activa — clic para desactivar')
    fireEvent.click(toggle)
    fireEvent.click(toggle)
    expect(request.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(1)
    expect(toggle).toBeDisabled()
    await act(async () => { complete(json({ success: false, error: 'Recepción no guardada' }, 500)) })
    expect(await screen.findByRole('alert')).toHaveTextContent('Recepción no guardada')
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(toggle).toBeEnabled()
  })

  it('stages receive editing until Save, allows Cancel without writes, and retains a failed draft', async () => {
    const request = fixture([device], async () => json({ success: false, error: 'No se guardó el canal' }, 500))
    render(<SettingsPage />)
    await screen.findByText(device.name)
    fireEvent.click(screen.getByTitle('Editar'))
    let editor = screen.getByText('Editar Canal').closest('header')!.parentElement!
    let toggle = within(editor).getAllByRole('button').find(button => button.hasAttribute('aria-pressed'))!
    fireEvent.click(toggle)
    expect(request.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(0)
    fireEvent.click(within(editor).getByRole('button', { name: 'Cancelar' }))
    fireEvent.click(screen.getByTitle('Editar'))
    editor = screen.getByText('Editar Canal').closest('header')!.parentElement!
    toggle = within(editor).getAllByRole('button').find(button => button.hasAttribute('aria-pressed'))!
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(toggle)
    fireEvent.click(within(editor).getByRole('button', { name: 'Guardar' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('No se guardó el canal')
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTitle('Recepción activa — clic para desactivar')).toHaveAttribute('aria-pressed', 'true')
    const update = request.mock.calls.find(([, options]) => options?.method === 'PUT')!
    expect(JSON.parse(String(update[1]?.body))).toEqual({ name: device.name, receive_messages: false })
    expect(screen.getByText('Editar Canal')).toBeVisible()
  })

  it('reflects enabled Cloud sending and explains its unavailable delete before interaction', async () => {
    const request = fixture([{ ...device, provider: 'whatsapp_cloud_api', api_sending_enabled: true, api_billing_status: 'configured' }], async () => json({ success: false }))
    render(<SettingsPage />)
    await screen.findByText(device.name)
    expect(screen.getByText('Envío activo')).toBeVisible()
    expect(screen.getByText('Facturación configurada')).toBeVisible()
    const unavailable = screen.getByTitle(CLOUD_DELETION_UNAVAILABLE)
    expect(unavailable).toBeDisabled()
    fireEvent.click(unavailable)
    expect(request.mock.calls.filter(([, options]) => options?.method === 'DELETE')).toHaveLength(0)
  })

  it('announces canonical local-only completion without claiming WhatsApp was unlinked', async () => {
    const pending = { ...device, status: 'deleting', deletion: { operation_id: 'operation-1', phase: 'pending', attempts: 1 } }
    const rows = [pending]
    fixture(rows, async () => json({ success: false }))
    render(<SettingsPage />)
    await screen.findByText(device.name)
    rows.splice(0)
    await act(async () => { mocks.listeners.forEach(listener => listener({ event: 'device_deletion', data: { device_id: device.id, operation_id: 'operation-1', deletion_status: 'completed', cleanup_scope: 'local', devices_total: 0, devices_available: 0, contacts_detached: 0, chats_detached: 0 } })) })
    expect(await screen.findByText(LOCAL_DEVICE_DELETION_MESSAGE)).toBeVisible()
    expect(screen.queryByText(device.name)).toBeNull()
  })
  it('keeps a failed delete visible and a 202 pending row disables every operational action', async () => {
    let fail = true
    const rows = [device] as Array<typeof device & { deletion?: { operation_id: string; phase: string; attempts: number } }>
    fixture(rows, async () => {
      if (fail) { fail = false; return json({ success: false, error: 'No se pudo confirmar la eliminación' }, 500) }
      rows[0] = { ...device, status: 'deleting', deletion: { operation_id: 'operation-1', phase: 'pending', attempts: 0 } }
      return json({ success: true, device_id: device.id, operation_id: 'operation-1', deletion_status: 'pending', devices_total: 1, devices_available: 0, contacts_detached: 2, chats_detached: 3 }, 202)
    })
    render(<SettingsPage />)
    await screen.findByText(device.name)
    fireEvent.click(screen.getByTitle('Eliminar'))
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo confirmar la eliminación')
    expect(screen.getByTitle('Eliminar')).toBeEnabled()
    fireEvent.click(screen.getByTitle('Eliminar'))
    await screen.findByText('Eliminando')
    expect(screen.getByText(device.name)).toBeVisible()
    const card = screen.getByText(device.name).closest('article')!
    within(card).getAllByRole('button').forEach(button => expect(button).toBeDisabled())
    expect(screen.queryByTitle('Conectar')).toBeNull()
    expect(screen.queryByTitle('Ver QR')).toBeNull()
    expect(screen.getByText(/0 disponibles · 1 en la cuenta/)).toBeVisible()
  })

  it('renames Cloud channels with name only and retains the editor with a network error', async () => {
    const cloud = { ...device, provider: 'whatsapp_cloud_api', phone_number_id: 'synthetic-meta-number', waba_id: 'synthetic-meta-account' }
    const request = fixture([cloud], async () => { throw new TypeError('Synthetic network failure') })
    render(<SettingsPage />)
    await screen.findByText(device.name)
    fireEvent.click(screen.getByTitle('Editar'))
    expect(screen.getByLabelText('Phone Number ID administrado por Meta')).toHaveAttribute('readonly')
    expect(screen.getByLabelText('WABA ID administrado por Meta')).toHaveAttribute('readonly')
    const editor = screen.getByText('Editar Canal').closest('header')!.parentElement!
    const name = within(editor).getAllByRole('textbox').find(input => (input as HTMLInputElement).value === device.name)!
    fireEvent.change(name, { target: { value: 'Nombre nuevo' } })
    fireEvent.click(within(editor).getByRole('button', { name: 'Guardar' }))
    await screen.findByText('No se pudo guardar el dispositivo. Inténtalo de nuevo.')
    expect(screen.getByText('Editar Canal')).toBeVisible()
    const write = request.mock.calls.find(([, options]) => options?.method === 'PUT')!
    expect(JSON.parse(String(write[1]?.body))).toEqual({ name: 'Nombre nuevo' })
    await waitFor(() => expect(within(editor).getByRole('button', { name: 'Guardar' })).toBeEnabled())
  })
})
