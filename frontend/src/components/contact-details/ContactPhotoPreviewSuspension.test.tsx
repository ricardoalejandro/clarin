import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import ContactPhotoPreview from '@/components/ContactPhotoPreview'
import { beginAuthIdentityChange, completeAuthIdentityChange } from '@/lib/authScope'

beforeEach(() => completeAuthIdentityChange())
afterEach(cleanup)

describe('ContactPhotoPreview suspended owner', () => {
  it('closes a transient photo portal and releases scroll instead of reopening it on resume', () => {
    const props = { name: 'Instructor de prueba', url: '/photo-test.png' }
    const view = render(<ContactPhotoPreview {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Ampliar foto de Instructor de prueba' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(document.body.style.overflow).toBe('hidden')
    view.rerender(<ContactPhotoPreview {...props} suspended />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(document.body.style.overflow).not.toBe('hidden')
    expect(screen.getByRole('button', { name: 'Ampliar foto de Instructor de prueba' })).toBeDisabled()
    view.rerender(<ContactPhotoPreview {...props} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})


it('zooms only the photo on Ctrl+wheel and restores the existing dialog focus and body lease on close', async () => {
  render(<ContactPhotoPreview ownerKey="contact:one" name="Ana" url="/photo.png" />)
  const trigger = screen.getByRole('button', { name: 'Ampliar foto de Ana' })
  fireEvent.click(trigger)
  const dialog = screen.getByRole('dialog', { name: 'Foto de Ana' })
  fireEvent.load(screen.getByAltText('Foto ampliada de Ana'))
  const viewport = dialog.querySelector<HTMLElement>('[data-image-viewport]')!
  const ordinary = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 })
  fireEvent(viewport, ordinary)
  expect(ordinary.defaultPrevented).toBe(false)
  const zoom = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100 })
  fireEvent(viewport, zoom)
  expect(zoom.defaultPrevented).toBe(true)
  const wheelScale = Number(viewport.dataset.imageScale)
  expect(wheelScale).toBeGreaterThan(1)
  const touch = (type: string, id: number, x: number) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 100 })
    Object.defineProperties(event, { pointerId: { value: id }, pointerType: { value: 'touch' } })
    fireEvent(viewport, event)
  }
  touch('pointerdown', 1, 100); touch('pointerdown', 2, 200); touch('pointermove', 2, 300)
  expect(Number(viewport.dataset.imageScale)).toBeGreaterThan(wheelScale)
  touch('pointerup', 2, 300); touch('pointercancel', 1, 100)
  const outside = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100 })
  fireEvent(document.body, outside)
  expect(outside.defaultPrevented).toBe(false)
  const close = screen.getByRole('button', { name: 'Cerrar foto' })
  close.focus()
  expect(fireEvent.keyDown(close, { key: 'Tab', cancelable: true })).toBe(true)
  expect(fireEvent.keyDown(close, { key: 'Tab', shiftKey: true, cancelable: true })).toBe(false)
  expect(screen.getByRole('button', { name: 'Ajustar imagen' })).toHaveFocus()
  expect(screen.getByRole('dialog', { name: 'Foto de Ana' })).toBe(dialog)
  fireEvent.click(screen.getByRole('button', { name: 'Cerrar foto' }))
  expect(document.body.style.overflow).not.toBe('hidden')
  const retained = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100 })
  fireEvent(viewport, retained)
  expect(retained.defaultPrevented).toBe(false)
  await waitFor(() => expect(trigger).toHaveFocus())
})

it('closes immediately for another owner with the same URL and destroys the old account photo session', () => {
  const props = { name: 'Ana', url: '/shared-photo.png' }
  const view = render(<ContactPhotoPreview {...props} ownerKey="contact:one" />)
  fireEvent.click(screen.getByRole('button', { name: 'Ampliar foto de Ana' }))
  view.rerender(<ContactPhotoPreview {...props} ownerKey="contact:two" />)
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(document.body.style.overflow).not.toBe('hidden')
  fireEvent.click(screen.getByRole('button', { name: 'Ampliar foto de Ana' }))
  act(() => { beginAuthIdentityChange() })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(document.body.style.overflow).not.toBe('hidden')
  act(() => { completeAuthIdentityChange() })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
