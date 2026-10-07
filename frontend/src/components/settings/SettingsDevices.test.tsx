import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ params: new URLSearchParams('tab=devices'), listeners: new Set<(value: unknown) => void>() }))
vi.mock('next/navigation', () => ({ useSearchParams: () => mocks.params, useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }))
vi.mock('@/lib/api', () => ({ logoutFromBrowser: vi.fn(), subscribeWebSocket: (listener: (value: unknown) => void) => { mocks.listeners.add(listener); return () => mocks.listeners.delete(listener) } }))
vi.mock('@/components/NotificationProvider', () => ({ useNotifications: () => ({ refreshSettings: vi.fn() }) }))
vi.mock('@/lib/notificationSounds', () => ({ getNotificationSettings: async () => null, saveNotificationSettings: vi.fn(), playNotificationSound: vi.fn(), requestNotificationPermission: vi.fn(), SOUND_OPTIONS: [] }))
vi.mock('@/components/settings/OfflineAccessPanelV5', () => ({ default: () => null }))
vi.mock('@/components/settings/QuickRepliesSettings', () => ({ default: () => null }))
vi.mock('@/components/WhatsAppAPISettingsPanel', () => ({ default: () => null }))
vi.mock('@/components/pipelines/PipelineStageManager', () => ({ default: () => null }))
vi.mock('@/components/pipelines/PipelineManagementDialog', () => ({ default: () => null }))

import SettingsPage from '@/app/dashboard/settings/page'
const json = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response
const device = { id: 'device-1', name: 'Synthetic channel', status: 'connected', provider: 'whatsapp_web', receive_messages: true, phone: '', jid: '', qr_code: '', last_seen_at: '' }
beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('token', 'synthetic-settings-token')
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
