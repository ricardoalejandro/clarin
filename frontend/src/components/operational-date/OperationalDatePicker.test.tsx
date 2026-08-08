import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TaskDateTimePicker from '../task-work/TaskDateTimePicker'
import OperationalDatePicker from './OperationalDatePicker'

afterEach(cleanup)

describe('OperationalDatePicker', () => {
  it('keeps date-only changes as a draft until Apply and supports direct month/year navigation', async () => {
    const onChange = vi.fn()
    render(<OperationalDatePicker mode="date" label="Fecha de nacimiento" value="1992-05-04" onChange={onChange} />)

    const trigger = screen.getByRole('button', { name: 'Fecha de nacimiento: 04/05/1992' })
    fireEvent.click(trigger)
    expect(screen.getByRole('dialog', { name: 'Elegir Fecha de nacimiento' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Hora')).not.toBeInTheDocument()
    expect(screen.queryByText('Todo el día')).not.toBeInTheDocument()
    expect(screen.queryByText('Mañana')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Elegir mes y año' }))
    fireEvent.change(screen.getByLabelText('Año'), { target: { value: '1990' } })
    fireEvent.click(screen.getByRole('button', { name: /may/i }))
    fireEvent.click(document.querySelector('[data-date-key="1990-05-08"]') as HTMLButtonElement)
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }))

    expect(onChange).toHaveBeenCalledWith('1990-05-08')
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('cancels with Escape, restores focus and clears only through Quitar', async () => {
    const onChange = vi.fn()
    render(<OperationalDatePicker mode="date" label="Fecha de nacimiento" value="1992-05-04" onChange={onChange} />)
    const trigger = screen.getByRole('button', { name: 'Fecha de nacimiento: 04/05/1992' })

    fireEvent.click(trigger)
    fireEvent.click(document.querySelector('[data-date-key="1992-05-10"]') as HTMLButtonElement)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Elegir Fecha de nacimiento' })).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
    await waitFor(() => expect(trigger).toHaveFocus())

    fireEvent.click(trigger)
    fireEvent.click(document.querySelector('[data-date-key="1992-05-11"]') as HTMLButtonElement)
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Cerrar Fecha de nacimiento' }))
    await waitFor(() => expect(trigger).toHaveFocus())
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('button', { name: 'Quitar' }))
    expect(onChange).toHaveBeenCalledWith('')
  })

  it('renders an honest empty state and disables days outside date-only limits', () => {
    render(<OperationalDatePicker mode="date" label="Fecha de nacimiento" value="" min="1992-05-04" max="1992-05-08" onChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Fecha de nacimiento: Sin fecha' }))

    expect(screen.getByRole('button', { name: 'Quitar' })).toBeDisabled()
    expect(document.querySelector('[data-date-key="1992-05-03"]')).toBeDisabled()
    expect(document.querySelector('[data-date-key="1992-05-04"]')).toBeEnabled()
    expect(document.querySelector('[data-date-key="1992-05-09"]')).toBeDisabled()
  })

  it('keeps TaskDateTimePicker as a compatible datetime adapter', () => {
    render(<TaskDateTimePicker label="Vencimiento" value="2026-07-31T09:05" onChange={vi.fn()} allDay={false} onAllDayChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Vencimiento:/ }))
    expect(screen.getByLabelText('Hora')).toHaveValue('09:05')
    expect(screen.getByRole('button', { name: 'Todo el día' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Mañana' })).toBeInTheDocument()
  })
})
