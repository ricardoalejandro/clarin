import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { operationalDateDayKey, operationalDateLocalValue } from '../operational-date/operationalDate'
import TaskDateRangePicker, { taskAllDayBoundary, taskDateRangeIsValid, taskDateRangeSummary } from './TaskDateRangePicker'
import { TASK_OVERLAY_LAYERS } from './taskOverlayLayers'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('TaskDateRangePicker', () => {
  it('describes empty, start-only, due-only and complete ranges from one trigger', () => {
    const onApply = vi.fn()
    const { rerender } = render(<TaskDateRangePicker label="Fechas" startValue="" endValue="" allDay={false} onApply={onApply} />)
    expect(screen.getByRole('button', { name: 'Fechas: Agregar fechas' })).toBeInTheDocument()

    rerender(<TaskDateRangePicker label="Fechas" startValue="2026-08-25T09:00" endValue="" allDay={false} onApply={onApply} />)
    expect(screen.getByRole('button', { name: /^Fechas: Desde / })).toBeInTheDocument()

    rerender(<TaskDateRangePicker label="Fechas" startValue="" endValue="2026-08-26T17:00" allDay={false} onApply={onApply} />)
    expect(screen.getByRole('button', { name: /^Fechas: Hasta / })).toBeInTheDocument()

    rerender(<TaskDateRangePicker label="Fechas" startValue="2026-08-25T09:00" endValue="2026-08-26T17:00" allDay onApply={onApply} />)
    expect(screen.getByRole('button', { name: /^Fechas: .+ → .+$/ })).toBeInTheDocument()
  })

  it('keeps a joint draft and emits one payload only through Apply', async () => {
    const onApply = vi.fn()
    render(<TaskDateRangePicker label="Fechas" startValue="2026-08-25T09:00" endValue="2026-08-26T17:00" allDay={false} onApply={onApply} />)
    const trigger = screen.getByRole('button', { name: /^Fechas:/ })

    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: 'Editar Fechas' })
    expect(dialog.parentElement).toBe(document.body)
    expect(dialog).toHaveStyle({ zIndex: String(TASK_OVERLAY_LAYERS.picker) })
    expect(screen.getByRole('button', { name: 'Cerrar Fechas' })).toHaveStyle({ zIndex: String(TASK_OVERLAY_LAYERS.pickerBackdrop) })

    fireEvent.click(screen.getByRole('button', { name: 'Quitar entrega' }))
    fireEvent.click(screen.getByRole('button', { name: /Todo el día/ }))
    expect(onApply).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }))

    expect(onApply).toHaveBeenCalledTimes(1)
    expect(onApply).toHaveBeenCalledWith({ startAt: '2026-08-25T00:00', endAt: '', isAllDay: true })
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('supports an end-only value, shared calendar selection and an explicit time', () => {
    const onApply = vi.fn()
    render(<TaskDateRangePicker label="Fechas" startValue="" endValue="" allDay={false} onApply={onApply} />)
    fireEvent.click(screen.getByRole('button', { name: 'Fechas: Agregar fechas' }))
    fireEvent.click(screen.getByRole('button', { name: /Entrega.*Sin fecha/ }))

    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    const day = document.querySelector(`[data-task-range-date="${operationalDateDayKey(tomorrow)}"]`) as HTMLButtonElement
    expect(day).toBeInTheDocument()
    fireEvent.click(day)
    fireEvent.change(screen.getByLabelText('Hora de entrega'), { target: { value: '17:30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }))

    const expected = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 17, 30)
    expect(onApply).toHaveBeenCalledWith({ startAt: '', endAt: operationalDateLocalValue(expected, 'datetime'), isAllDay: false })
  })

  it('moves calendar focus with the keyboard without committing the draft', async () => {
    const onApply = vi.fn()
    render(<TaskDateRangePicker label="Fechas" startValue="2026-08-25T09:00" endValue="" allDay={false} onApply={onApply} />)
    fireEvent.click(screen.getByRole('button', { name: /^Fechas:/ }))

    const current = document.querySelector('[data-task-range-date="2026-08-25"]') as HTMLButtonElement
    const next = document.querySelector('[data-task-range-date="2026-08-26"]') as HTMLButtonElement
    current.focus()
    fireEvent.keyDown(current, { key: 'ArrowRight' })

    await waitFor(() => expect(next).toHaveFocus())
    expect(onApply).not.toHaveBeenCalled()
  })

  it('stages total clearing and never writes before confirmation', () => {
    const onApply = vi.fn()
    render(<TaskDateRangePicker label="Fechas" startValue="2026-08-25T09:00" endValue="2026-08-26T17:00" allDay onApply={onApply} />)
    fireEvent.click(screen.getByRole('button', { name: /^Fechas:/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Quitar todas' }))
    expect(onApply).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }))
    expect(onApply).toHaveBeenCalledWith({ startAt: '', endAt: '', isAllDay: true })
  })

  it('rejects an inverted timed range while allowing the same all-day calendar date', () => {
    const onApply = vi.fn()
    render(<TaskDateRangePicker label="Fechas" startValue="2026-08-25T17:00" endValue="2026-08-25T09:00" allDay={false} onApply={onApply} />)
    fireEvent.click(screen.getByRole('button', { name: /^Fechas:/ }))

    expect(screen.getByRole('alert')).toHaveTextContent('La entrega no puede ser anterior al inicio.')
    expect(screen.getByRole('button', { name: 'Aplicar' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /Todo el día/ }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Aplicar' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }))
    expect(onApply).toHaveBeenCalledWith({ startAt: '2026-08-25T00:00', endAt: '2026-08-25T23:59', isAllDay: true })
  })

  it('discards edits on Escape and outside interaction, restoring the trigger focus', async () => {
    const onApply = vi.fn()
    render(<TaskDateRangePicker label="Fechas" startValue="2026-08-25T09:00" endValue="" allDay={false} onApply={onApply} />)
    const trigger = screen.getByRole('button', { name: /^Fechas:/ })

    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('button', { name: 'Quitar inicio' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Editar Fechas' })).not.toBeInTheDocument()
    expect(onApply).not.toHaveBeenCalled()
    await waitFor(() => expect(trigger).toHaveFocus())

    fireEvent.click(trigger)
    expect(screen.getByRole('button', { name: 'Quitar inicio' })).toBeInTheDocument()
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Cerrar Fechas' }))
    expect(screen.queryByRole('dialog', { name: 'Editar Fechas' })).not.toBeInTheDocument()
    expect(onApply).not.toHaveBeenCalled()
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('honestly disables opening while unavailable or pending', () => {
    const onApply = vi.fn()
    const { rerender } = render(<TaskDateRangePicker label="Fechas" startValue="" endValue="" allDay={false} disabled onApply={onApply} />)
    expect(screen.getByRole('button', { name: 'Fechas: Agregar fechas' })).toBeDisabled()

    rerender(<TaskDateRangePicker label="Fechas" startValue="" endValue="" allDay={false} pending onApply={onApply} />)
    const trigger = screen.getByRole('button', { name: 'Fechas: Agregar fechas' })
    expect(trigger).toBeDisabled()
    expect(trigger).toHaveAttribute('aria-busy', 'true')
    fireEvent.click(trigger)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('offers a compact trigger without changing its accessible contract', () => {
    render(<TaskDateRangePicker label="Fechas de la subtarea" startValue="" endValue="" allDay={false} compact onApply={vi.fn()} />)
    const trigger = screen.getByRole('button', { name: 'Fechas de la subtarea: Agregar fechas' })
    expect(trigger).toHaveAttribute('data-compact', 'true')
    expect(trigger).toHaveClass('min-h-9')
  })
})

describe('task date range rules', () => {
  it('keeps endpoint summaries explicit and validates all-day ranges by calendar date', () => {
    expect(taskDateRangeSummary('', '', false)).toBe('Agregar fechas')
    expect(taskDateRangeSummary('2026-08-25T09:00', '', false)).toMatch(/^Desde /)
    expect(taskDateRangeSummary('', '2026-08-25T17:00', false)).toMatch(/^Hasta /)
    expect(taskDateRangeIsValid('2026-08-25T17:00', '2026-08-25T09:00', false)).toBe(false)
    expect(taskDateRangeIsValid('2026-08-25T17:00', '2026-08-25T09:00', true)).toBe(true)
    expect(taskDateRangeIsValid('', '2026-08-25T09:00', false)).toBe(true)
    expect(taskAllDayBoundary('2026-08-25T17:00', 'start')).toBe('2026-08-25T00:00')
    expect(taskAllDayBoundary('2026-08-25T09:00', 'end')).toBe('2026-08-25T23:59')
  })
})
