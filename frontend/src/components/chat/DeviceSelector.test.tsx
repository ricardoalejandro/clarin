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
})
