import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import WhatsAppDevicePicker from '@/components/WhatsAppDevicePicker'
import { OperationalOverlayProvider } from '@/components/operational-window/OperationalOverlayContext'
import type { WhatsAppDeviceOption } from '@/lib/whatsappChatLauncher'

const device: WhatsAppDeviceOption = {
  id: 'device-1',
  name: 'WhatsApp principal',
  phone: '+51 999 999 999',
  status: 'connected',
  provider: 'whatsapp_web',
  historical_relation: 'same_historical_number',
  runtime_capabilities: {
    can_start_chat: true,
    can_check_whatsapp: true,
    can_send_reaction: true,
    can_send_sticker: true,
    can_send_animated_sticker: false,
    can_publish_status: false,
    can_sync_own_status: false,
  },
}

afterEach(() => {
  cleanup()
  document.querySelectorAll('[data-test-overlay-host]').forEach(node => node.remove())
})

function PickerHarness({ onSelect = vi.fn() }: { onSelect?: (value: WhatsAppDeviceOption) => void }) {
  const [open, setOpen] = useState(false)
  const host = document.querySelector<HTMLElement>('[data-test-overlay-host]')
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Abrir WhatsApp</button>
      <OperationalOverlayProvider portalTarget={host} registerOverlay={() => () => {}}>
        <WhatsAppDevicePicker
          open={open}
          idPrefix="qa"
          phone="51999999999"
          devices={[device]}
          onSelect={onSelect}
          onCancel={() => setOpen(false)}
        />
      </OperationalOverlayProvider>
    </>
  )
}

describe('WhatsAppDevicePicker', () => {
  it('portals into the operational boundary, closes with Escape and restores focus', async () => {
    const host = document.createElement('div')
    host.dataset.testOverlayHost = ''
    document.body.appendChild(host)
    render(<PickerHarness />)

    const trigger = screen.getByRole('button', { name: 'Abrir WhatsApp' })
    trigger.focus()
    fireEvent.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: 'Elegir canal de WhatsApp' })
    expect(host).toContainElement(dialog)
    expect(screen.getByRole('button', { name: /Usar WhatsApp principal/ })).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('exposes one labelled device choice', async () => {
    const host = document.createElement('div')
    host.dataset.testOverlayHost = ''
    document.body.appendChild(host)
    const onSelect = vi.fn()
    render(<PickerHarness onSelect={onSelect} />)

    fireEvent.click(screen.getByRole('button', { name: 'Abrir WhatsApp' }))
    fireEvent.click(await screen.findByRole('button', { name: /Usar WhatsApp principal/ }))
    expect(onSelect).toHaveBeenCalledWith(device)
  })
})
