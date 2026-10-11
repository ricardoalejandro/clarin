import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DeviceSelector from './DeviceSelector'
afterEach(cleanup)
describe('chat device selector', () => {
  it('keeps deleting devices out of connected channel choices', () => {
    render(<DeviceSelector devices={[{ id: 'active', name: 'Active channel', status: 'connected' }, { id: 'pending', name: 'Deleting channel', status: 'connected', deletion: { operation_id: 'op', phase: 'pending', attempts: 0 } }]} selectedDeviceIds={[]} onDeviceChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Todos los dispositivos' }))
    expect(screen.getByRole('option', { name: 'Active channel' })).toBeVisible()
    expect(screen.queryByRole('option', { name: 'Deleting channel' })).toBeNull()
  })

  it('offers disconnected history and treats Todos as the empty filter', () => {
    const onDeviceChange = vi.fn()
    const { container } = render(<DeviceSelector devices={[{ id: 'online', name: 'Online', status: 'connected' }, { id: 'offline', name: 'Offline', status: 'disconnected' }, { id: 'cloud', name: 'Cloud', status: 'connected', provider: 'whatsapp_cloud_api' }]} selectedDeviceIds={['online', 'offline']} onDeviceChange={onDeviceChange} />)
    fireEvent.click(screen.getByRole('button', { name: '2 dispositivos' }))
    expect(screen.getByRole('option', { name: 'Offline' })).toBeVisible()
    expect(screen.getByText('Sin conexión · historial')).toBeVisible()
    expect(screen.queryByRole('option', { name: 'Cloud' })).toBeNull()
    expect(container.querySelector('[role="listbox"]')).toBeNull()
    const all = screen.getByRole('option', { name: /Todos los dispositivos/ })
    expect(all).toHaveAttribute('aria-selected', 'false')
    fireEvent.click(all)
    expect(onDeviceChange).toHaveBeenCalledWith([])
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.getByRole('button', { name: '2 dispositivos' })).toHaveFocus()
  })

  it('supports keyboard selection and closes with Escape restoring focus', () => {
    const onDeviceChange = vi.fn()
    render(<DeviceSelector devices={[{ id: 'online', name: 'Online', status: 'connected' }, { id: 'offline', name: 'Offline', status: 'disconnected' }]} selectedDeviceIds={[]} onDeviceChange={onDeviceChange} />)
    const trigger = screen.getByRole('button', { name: 'Todos los dispositivos' })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    const listbox = screen.getByRole('listbox')
    fireEvent.keyDown(listbox, { key: 'End' })
    expect(screen.getByRole('option', { name: 'Offline' })).toHaveFocus()
    fireEvent.keyDown(listbox, { key: 'Enter' })
    expect(onDeviceChange).toHaveBeenCalledWith(['offline'])
    fireEvent.keyDown(listbox, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(trigger).toHaveFocus()
  })

  it('closes on outside interaction without stealing focus', () => {
    render(<><DeviceSelector devices={[]} selectedDeviceIds={[]} onDeviceChange={vi.fn()} /><button type="button">Outside</button></>)
    fireEvent.click(screen.getByRole('button', { name: 'Todos los dispositivos' }))
    const outside = screen.getByRole('button', { name: 'Outside' })
    outside.focus()
    fireEvent.pointerDown(outside)
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(outside).toHaveFocus()
  })

  it('returns Tab order to the trigger before dismissing a portaled menu', () => {
    render(<DeviceSelector devices={[]} selectedDeviceIds={[]} onDeviceChange={vi.fn()} />)
    const trigger = screen.getByRole('button', { name: 'Todos los dispositivos' })
    fireEvent.click(trigger)
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Tab' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(trigger).toHaveFocus()
  })
})
