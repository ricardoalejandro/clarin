import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import OperationalDatePicker from './OperationalDatePicker'
import { useOperationalDateFields } from './useOperationalDateFields'
import { useAccessibleDialog } from '../pipelines/useAccessibleDialog'
import { useDialogTabTrap } from '../programs/useDialogTabTrap'

afterEach(cleanup)

describe('editable operational date field', () => {
  it('keeps partial/invalid text and confirms only one canonical value on Enter then blur', () => {
    const onChange = vi.fn(), onCommit = vi.fn(), submit = vi.fn()
    render(<form onSubmit={event => { event.preventDefault(); submit() }}><OperationalDatePicker mode="date" label="Nacimiento" value="2000-01-01" onChange={onChange} onCommit={onCommit} /></form>)
    const input = screen.getByRole('textbox', { name: 'Nacimiento' })
    fireEvent.change(input, { target: { value: '31/04/196' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input).toHaveValue('31/04/196')
    expect(screen.getByRole('alert')).toHaveTextContent('DD/MM/AAAA')
    expect(onChange).not.toHaveBeenCalled()
    expect(onCommit).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '03/04/1965' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)
    expect(onChange).toHaveBeenCalledExactlyOnceWith('1965-04-03')
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(submit).not.toHaveBeenCalled()
  })

  it('opens without saving and cancels calendar selection back to the typed draft', async () => {
    const onChange = vi.fn()
    render(<OperationalDatePicker mode="date" label="Nacimiento" value="2000-01-01" onChange={onChange} />)
    const input = screen.getByRole('textbox', { name: 'Nacimiento' })
    fireEvent.change(input, { target: { value: '3/4/1965' } })
    const trigger = screen.getByRole('button', { name: 'Nacimiento: 01/01/2000' })
    fireEvent.blur(input, { relatedTarget: trigger })
    fireEvent.click(trigger)
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(document.querySelector('[data-date-key="1965-04-12"]') as HTMLElement)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(input).toHaveValue('3/4/1965')
    expect(onChange).not.toHaveBeenCalled()
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('does not invent a selected value in an empty calendar and supports optional clear', () => {
    const onChange = vi.fn()
    render(<OperationalDatePicker mode="date" label="Fecha" value="" onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Fecha: Sin fecha' }))
    expect(screen.getByRole('button', { name: 'Aplicar' })).toBeDisabled()
    expect(document.querySelector('[role="gridcell"][aria-pressed="true"]')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('retains the existing time when editing only the date', () => {
    const onChange = vi.fn()
    render(<OperationalDatePicker mode="datetime" label="Comienza" value="2000-01-01T09:45" onChange={onChange} />)
    const input = screen.getByRole('textbox', { name: 'Comienza' })
    fireEvent.change(input, { target: { value: '03/04/1965' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledExactlyOnceWith('1965-04-03T09:45')
    expect(screen.getByRole('textbox', { name: 'Comienza: hora' })).toHaveValue('09:45')
  })

  it('does not rewrite an untouched timestamp or discard its seconds on blur', () => {
    const onChange = vi.fn(), onDraftStateChange = vi.fn()
    render(<OperationalDatePicker mode="datetime" label="Comienza" value="2000-01-01T09:45:30.000Z" onChange={onChange} onDraftStateChange={onDraftStateChange} />)
    fireEvent.blur(screen.getByRole('textbox', { name: 'Comienza' }))
    expect(onChange).not.toHaveBeenCalled()
    expect(onDraftStateChange).toHaveBeenLastCalledWith(expect.objectContaining({ value: '2000-01-01T09:45:30.000Z', dirty: false }))
  })

  it('preserves typed content across remote updates and Escape returns to the latest canonical value', () => {
    const onChange = vi.fn()
    const { rerender } = render(<OperationalDatePicker mode="date" label="Fecha" value="2000-01-01" onChange={onChange} />)
    const input = screen.getByRole('textbox', { name: 'Fecha' })
    fireEvent.change(input, { target: { value: '03/04/19' } })
    rerender(<OperationalDatePicker mode="date" label="Fecha" value="2010-02-02" onChange={onChange} />)
    expect(input).toHaveValue('03/04/19')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input).toHaveValue('02/02/2010')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('acknowledges an explicitly saved typed snapshot and releases its dirty state', () => {
    const onChange = vi.fn(), onDraftStateChange = vi.fn()
    const { rerender } = render(<OperationalDatePicker mode="date" label="Fecha" value="2000-01-01" onChange={onChange} onDraftStateChange={onDraftStateChange} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '1990-12-31' } })
    rerender(<OperationalDatePicker mode="date" label="Fecha" value="1990-12-31" onChange={onChange} onDraftStateChange={onDraftStateChange} />)
    expect(screen.getByRole('textbox')).toHaveValue('31/12/1990')
    expect(onDraftStateChange).toHaveBeenLastCalledWith(expect.objectContaining({ dirty: false, valid: true, value: '1990-12-31' }))
  })

  it('closes an open calendar without committing when the control becomes disabled', async () => {
    const onChange = vi.fn()
    const { rerender } = render(<OperationalDatePicker mode="date" label="Fecha" value="2000-01-01" onChange={onChange} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '03/04/19' } })
    fireEvent.click(screen.getByRole('button', { name: 'Fecha: 01/01/2000' }))
    fireEvent.click(document.querySelector('[data-date-key="2000-01-12"]') as HTMLElement)
    rerender(<OperationalDatePicker mode="date" label="Fecha" value="2000-01-01" onChange={onChange} disabled />)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByRole('textbox')).toHaveValue('03/04/19')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('owns Escape and Tab above its parent modal and restores the calendar trigger', async () => {
    const closeParent = vi.fn()
    function ParentDialog() {
      const ref = useRef<HTMLDivElement>(null)
      useAccessibleDialog(true, ref, closeParent)
      useDialogTabTrap(true, ref)
      return <div ref={ref} role="dialog" aria-label="Formulario"><OperationalDatePicker mode="date" label="Nacimiento" value="2000-01-01" onChange={vi.fn()} /><button>Guardar</button></div>
    }
    render(<ParentDialog />)
    const trigger = screen.getByRole('button', { name: 'Nacimiento: 01/01/2000' })
    fireEvent.click(trigger)
    const panel = screen.getByRole('dialog', { name: 'Elegir Nacimiento' })
    const day = document.querySelector('[data-date-key="2000-01-01"]') as HTMLButtonElement
    day.focus()
    fireEvent.keyDown(day, { key: 'Tab' })
    expect(panel.contains(document.activeElement)).toBe(true)
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(closeParent).not.toHaveBeenCalled()
    await waitFor(() => expect(trigger).toHaveFocus())
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(closeParent).toHaveBeenCalledTimes(1)
  })
})

function SaveForm({ save }: { save: (value: string) => void }) {
  const dates = useOperationalDateFields()
  const [value, setValue] = useState('2000-01-01')
  const [visible, setVisible] = useState(true)
  return <>
    {visible && <OperationalDatePicker mode="date" label="Fecha guardada" value={value} required onChange={setValue} onDraftStateChange={dates.track('date')} />}
    <button type="button" onClick={() => { if (dates.validate()) save(dates.value('date', value)) }}>Guardar</button>
    <button type="button" onClick={() => setVisible(false)}>Ocultar</button>
    <button type="button" onClick={dates.reset}>Restablecer registro</button>
    <output>{dates.valid ? 'válido' : 'inválido'} · {dates.dirty ? 'pendiente' : 'limpio'}</output>
  </>
}

describe('date form snapshots', () => {
  it('saves the current valid text without needing blur or an intermediate parent render', () => {
    const save = vi.fn()
    render(<SaveForm save={save} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '1990-12-31' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))
    expect(save).toHaveBeenCalledExactlyOnceWith('1990-12-31')
  })
  it('blocks invalid and required empty input instead of saving the previous valid value', () => {
    const save = vi.fn()
    render(<SaveForm save={save} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '31/02/1990' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))
    expect(save).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('no existe')
    expect(screen.getByRole('textbox')).toHaveFocus()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))
    expect(save).not.toHaveBeenCalled()
    expect(screen.getByRole('status')).toHaveTextContent('inválido · pendiente')
  })
  it('unregisters removed fields and restores registration after a reset', async () => {
    render(<SaveForm save={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'partial' } })
    fireEvent.click(screen.getByRole('button', { name: 'Restablecer registro' }))
    expect(screen.getByRole('status')).toHaveTextContent('inválido · pendiente')
    fireEvent.click(screen.getByRole('button', { name: 'Ocultar' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('válido · limpio'))
  })
})
