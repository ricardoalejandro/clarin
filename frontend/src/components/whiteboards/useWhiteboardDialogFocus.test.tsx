import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup } from '@testing-library/react'
import { useWhiteboardDialogFocus } from './useWhiteboardDialogFocus'

afterEach(() => cleanup())

function Dialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState('')
  useWhiteboardDialogFocus(dialogRef, onClose, inputRef)
  return <div ref={dialogRef} tabIndex={-1} role="dialog" aria-label="Crear recurso">
    <button type="button" data-whiteboard-dialog-close aria-label="Cerrar" onClick={onClose}>×</button>
    <input ref={inputRef} aria-label="Nombre" value={name} onChange={event => setName(event.target.value)} />
    <button type="button">Cancelar</button>
    <button type="button">Crear</button>
  </div>
}

function Harness() {
  const [open, setOpen] = useState(false)
  return <>
    <button type="button" onClick={() => setOpen(true)}>Nueva pizarra</button>
    {open && <Dialog onClose={() => setOpen(false)} />}
  </>
}

describe('useWhiteboardDialogFocus', () => {
  it('keeps the editable field focused through every controlled-input rerender', async () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Nueva pizarra' }))
    const input = screen.getByRole('textbox', { name: 'Nombre' })
    await waitFor(() => expect(input).toHaveFocus())

    for (const value of ['P', 'Pi', 'Piz', 'Piza', 'Pizarra completa']) {
      fireEvent.change(input, { target: { value } })
      expect(input).toHaveValue(value)
      expect(input).toHaveFocus()
    }
    expect(screen.getByRole('button', { name: 'Cerrar' })).not.toHaveFocus()
  })

  it('traps Tab, closes with Escape, and restores the invoking focus', async () => {
    render(<Harness />)
    const trigger = screen.getByRole('button', { name: 'Nueva pizarra' })
    trigger.focus()
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: 'Crear recurso' })
    const close = screen.getByRole('button', { name: 'Cerrar' })
    const create = screen.getByRole('button', { name: 'Crear' })
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Nombre' })).toHaveFocus())

    create.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(close).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(create).toHaveFocus()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(dialog).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })
})
