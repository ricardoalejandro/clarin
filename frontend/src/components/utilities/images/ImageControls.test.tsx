import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ImageInput, ImageModePicker } from './ImageControls'
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
  const preview = await screen.findByRole('img', { name: 'Código QR generado' }, { timeout: 6000 })
  expect(preview.getAttribute('src')).toMatch(/^data:image\/png;base64,/)
  const download = screen.getByRole('button', { name: 'Descargar QR' })
  fireEvent.click(download)
  expect(screen.getByRole('menuitem', { name: 'Descargar PNG' })).toBeEnabled()
  expect(screen.getByRole('menuitem', { name: 'Descargar SVG' })).toBeEnabled()
  fireEvent.keyDown(screen.getByRole('menu', { name: 'Descargar QR' }), { key: 'Escape' })
  expect(download).toHaveFocus()
  expect(input).toHaveValue('QR de prueba ñ')
  fireEvent.change(input, { target: { value: 'Otro QR' } })
  expect(screen.queryByRole('button', { name: 'Descargar QR' })).not.toBeInTheDocument()
  expect(screen.queryByRole('img', { name: 'Código QR generado' })).not.toBeInTheDocument()
}, 10_000)

it('keeps the compact mode selector and one primary action in the same toolbar', () => {
  render(<QrUtility />)
  const toolbar = screen.getByRole('group', { name: 'Acciones de QR' })
  expect(within(toolbar).getByRole('combobox', { name: 'Operación de QR' })).toHaveValue('create')
  expect(within(toolbar).getByRole('button', { name: 'Generar QR' })).toBeDisabled()
  fireEvent.change(within(toolbar).getByRole('combobox'), { target: { value: 'read' } })
  const readToolbar = screen.getByRole('group', { name: 'Acciones de QR' })
  expect(within(readToolbar).getByRole('combobox')).toHaveValue('read')
  expect(within(readToolbar).getByRole('combobox')).toHaveFocus()
  expect(within(readToolbar).getByRole('button', { name: 'Leer QR' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Seleccionar archivo' })).toHaveAccessibleName('Seleccionar archivo')
  expect(screen.getByRole('button', { name: 'Pegar imagen' })).toHaveAccessibleName('Pegar imagen')
})

it('changes a compact output format through a labelled native selector', () => {
  const onChange = vi.fn()
  render(<ImageModePicker label="Formato de salida" mode="raw" onChange={onChange} options={[{ value: 'raw', label: 'Base64' }, { value: 'url', label: 'Data URL' }]} />)
  fireEvent.change(screen.getByRole('combobox', { name: 'Formato de salida' }), { target: { value: 'url' } })
  expect(onChange).toHaveBeenCalledExactlyOnceWith('url')
})

it('cancels image opening from its header and restores focus to the paste target', () => {
  const onClear = vi.fn()
  render(<ImageInput label="Imagen original" source={{ status: 'pending' }} onSelect={vi.fn()} onClear={onClear} />)
  fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
  expect(onClear).toHaveBeenCalledOnce()
  expect(screen.getByRole('group', { name: 'Área para pegar o soltar una imagen' })).toHaveFocus()
})

it('ignores a clipboard result after cancelling its header action', async () => {
  const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  let resolve: (items: ClipboardItems) => void = () => {}
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { read: vi.fn(() => new Promise<ClipboardItems>(done => { resolve = done })) } })
  try {
    const onSelect = vi.fn()
    const onClear = vi.fn()
    render(<ImageInput source={{ status: 'idle' }} onSelect={onSelect} onClear={onClear} />)
    fireEvent.click(screen.getByRole('button', { name: 'Pegar imagen' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    await act(async () => resolve([{ types: ['image/png'], getType: async () => new Blob(['stale'], { type: 'image/png' }) } as unknown as ClipboardItem]))
    expect(onSelect).not.toHaveBeenCalled()
    expect(onClear).not.toHaveBeenCalled()
    expect(screen.getByRole('group', { name: 'Área para pegar o soltar una imagen' })).toHaveFocus()
  } finally {
    if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
})
