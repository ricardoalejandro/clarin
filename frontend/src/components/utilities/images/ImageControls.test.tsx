import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ImageInput } from './ImageControls'
import QrUtility from './QrUtility'

afterEach(cleanup)

it('focuses the paste target when clipboard permission is denied and accepts native image paste', async () => {
  const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { read: vi.fn().mockRejectedValue(new Error('denied')) } })
  try {
    const onSelect = vi.fn()
    render(<ImageInput source={{ status: 'idle' }} onSelect={onSelect} onClear={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Pegar imagen' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('no dio acceso al portapapeles')
    const target = screen.getByRole('group', { name: 'Área para pegar o soltar una imagen' })
    expect(target).toHaveFocus()

    const file = new File(['example'], 'captura.png', { type: 'image/png' })
    fireEvent.paste(target, { clipboardData: { items: [{ kind: 'file', getAsFile: () => file }] } })
    expect(onSelect).toHaveBeenCalledOnce()
    expect(onSelect).toHaveBeenCalledWith(file)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  } finally {
    if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
})

it('generates QR downloads and invalidates the preview when the input changes', async () => {
  render(<QrUtility />)
  const input = screen.getByRole('textbox', { name: 'Texto o enlace' })
  fireEvent.change(input, { target: { value: 'QR de prueba ñ' } })
  fireEvent.click(screen.getByRole('button', { name: 'Generar QR' }))
  const png = await screen.findByRole('link', { name: 'Descargar PNG' }, { timeout: 6000 })
  expect(png.getAttribute('href')).toMatch(/^data:image\/png;base64,/)
  expect(screen.getByRole('button', { name: 'Descargar SVG' })).toBeEnabled()
  fireEvent.change(input, { target: { value: 'Otro QR' } })
  expect(screen.queryByRole('link', { name: 'Descargar PNG' })).not.toBeInTheDocument()
}, 10_000)
