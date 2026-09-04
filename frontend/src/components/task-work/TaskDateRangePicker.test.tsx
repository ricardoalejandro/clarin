import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { operationalDateDayKey, operationalDateLocalValue } from '../operational-date/operationalDate'
import TaskDateRangePicker, { taskAllDayBoundary, taskDateRangeIsValid, taskDateRangeSummary, taskDueDateOnlyValue } from './TaskDateRangePicker'
import { TASK_OVERLAY_LAYERS } from './taskOverlayLayers'

const originalInnerWidth = window.innerWidth
const originalInnerHeight = window.innerHeight

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight })
})

describe('TaskDateRangePicker', () => {
  it('describes empty, start-only, due-only and complete ranges from one trigger', () => {
    const onApply = vi.fn()
    const { rerender } = render(<TaskDateRangePicker label="Fechas" startValue="" endValue="" allDay={false} onApply={onApply} />)
    expect(screen.getByRole('button', { name: 'Fechas: Agregar fecha de entrega' })).toBeInTheDocument()

    rerender(<TaskDateRangePicker label="Fechas" startValue="2026-08-25T09:00" endValue="" allDay={false} onApply={onApply} />)
    expect(screen.getByRole('button', { name: /^Fechas: Inicio: / })).toBeInTheDocument()

    rerender(<TaskDateRangePicker label="Fechas" startValue="" endValue="2026-08-26T17:00" allDay={false} onApply={onApply} />)
    expect(screen.getByRole('button', { name: /^Fechas: Entrega: / })).toBeInTheDocument()

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
    fireEvent.click(screen.getByRole('button', { name: 'Usar todo el día' }))
    expect(onApply).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }))

    expect(onApply).toHaveBeenCalledTimes(1)
    expect(onApply).toHaveBeenCalledWith({ startAt: '2026-08-25T00:00', endAt: '', isAllDay: true })
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('opens on delivery and applies a date-only deadline without inventing a start', () => {
    const onApply = vi.fn()
    render(<TaskDateRangePicker label="Fechas" startValue="" endValue="" allDay={false} onApply={onApply} />)
    fireEvent.click(screen.getByRole('button', { name: 'Fechas: Agregar fecha de entrega' }))

    expect(screen.getByRole('button', { name: /Fecha de entrega.*Sin fecha/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('button', { name: /Inicio opcional.*Sin fecha/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Añadir fecha de inicio' })).toBeInTheDocument()

    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    const day = document.querySelector(`[data-task-range-date="${operationalDateDayKey(tomorrow)}"]`) as HTMLButtonElement
    expect(day).toBeInTheDocument()
    fireEvent.click(day)
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }))

    expect(onApply).toHaveBeenCalledWith({
      startAt: '',
      endAt: taskDueDateOnlyValue(operationalDateDayKey(tomorrow)),
      isAllDay: true,
    })
  })

  it('preserves an existing start-only task without filling its delivery', () => {
    const onApply = vi.fn()
    render(<TaskDateRangePicker label="Fechas" startValue="2026-08-25T09:00" endValue="" allDay={false} onApply={onApply} />)
    fireEvent.click(screen.getByRole('button', { name: /^Fechas: Inicio:/ }))

    expect(screen.getByRole('button', { name: /Inicio opcional/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /Fecha de entrega.*Sin fecha/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }))

    expect(onApply).toHaveBeenCalledWith({ startAt: '2026-08-25T09:00', endAt: '', isAllDay: false })
  })

  it('adds an exact delivery time only after the explicit action', () => {
    const onApply = vi.fn()
    render(<TaskDateRangePicker label="Fechas" startValue="" endValue="" allDay={false} onApply={onApply} />)
    fireEvent.click(screen.getByRole('button', { name: 'Fechas: Agregar fecha de entrega' }))

    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    fireEvent.click(document.querySelector(`[data-task-range-date="${operationalDateDayKey(tomorrow)}"]`) as HTMLButtonElement)
    expect(screen.queryByLabelText('Hora de entrega')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Añadir hora/ }))
    fireEvent.change(screen.getByLabelText('Hora de entrega'), { target: { value: '17:30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }))

    const expected = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 17, 30)
    expect(onApply).toHaveBeenCalledWith({ startAt: '', endAt: operationalDateLocalValue(expected, 'datetime'), isAllDay: false })
  })

  it('reveals an optional start without losing the delivery draft or writing early', () => {
    const onApply = vi.fn()
    render(<TaskDateRangePicker label="Fechas" startValue="" endValue="" allDay={false} onApply={onApply} />)
    fireEvent.click(screen.getByRole('button', { name: 'Fechas: Agregar fecha de entrega' }))
    fireEvent.click(screen.getByRole('button', { name: 'Mañana' }))
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    const tomorrowKey = operationalDateDayKey(tomorrow)

    fireEvent.click(screen.getByRole('button', { name: 'Añadir fecha de inicio' }))

    expect(onApply).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /Inicio opcional.*Sin fecha/ })).toHaveAttribute('aria-pressed', 'true')
    const tomorrowLabel = tomorrow.toLocaleString('es-PE', { dateStyle: 'medium' })
    expect(screen.getByRole('button', { name: `Fecha de entrega ${tomorrowLabel}` })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Hoy' }))
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }))

    expect(onApply).toHaveBeenCalledWith({
      startAt: taskAllDayBoundary(operationalDateLocalValue(new Date(), 'datetime'), 'start'),
      endAt: taskDueDateOnlyValue(tomorrowKey),
      isAllDay: true,
    })
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

  it.each([320, 375, 768, 1024, 1440])('keeps due-only and expanded range modes inside a %d px viewport edge', async viewportWidth => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: viewportWidth })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 760 })
    render(<TaskDateRangePicker label="Fechas" startValue="" endValue="" allDay={false} onApply={vi.fn()} />)
    const trigger = screen.getByRole('button', { name: 'Fechas: Agregar fecha de entrega' })
    trigger.getBoundingClientRect = vi.fn(() => ({
      left: viewportWidth - 28,
      right: viewportWidth - 12,
      top: 724,
      bottom: 742,
      width: 16,
      height: 18,
      x: viewportWidth - 28,
      y: 724,
      toJSON: () => ({}),
    }))

    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: 'Editar Fechas' })
    await waitFor(() => expect(Number.parseFloat(dialog.style.width)).toBeGreaterThan(0))
    const dueWidth = Number.parseFloat(dialog.style.width)
    const dueLeft = Number.parseFloat(dialog.style.left)
    expect(dueWidth).toBeLessThanOrEqual(Math.min(360, viewportWidth - 24))
    expect(dueLeft).toBeGreaterThanOrEqual(12)
    expect(dueLeft + dueWidth).toBeLessThanOrEqual(viewportWidth - 12)

    fireEvent.click(screen.getByRole('button', { name: 'Añadir fecha de inicio' }))
    await waitFor(() => expect(Number.parseFloat(dialog.style.width)).toBe(Math.min(680, viewportWidth - 24)))
    const rangeWidth = Number.parseFloat(dialog.style.width)
    const rangeLeft = Number.parseFloat(dialog.style.left)
    expect(rangeLeft).toBeGreaterThanOrEqual(12)
    expect(rangeLeft + rangeWidth).toBeLessThanOrEqual(viewportWidth - 12)
    expect(Number.parseFloat(dialog.style.top)).toBeGreaterThanOrEqual(12)
  })

  it('stages total clearing and never writes before confirmation', () => {
    const onApply = vi.fn()
    render(<TaskDateRangePicker label="Fechas" startValue="2026-08-25T09:00" endValue="2026-08-26T17:00" allDay onApply={onApply} />)
    fireEvent.click(screen.getByRole('button', { name: /^Fechas:/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Quitar fechas' }))
    expect(onApply).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }))
    expect(onApply).toHaveBeenCalledWith({ startAt: '', endAt: '', isAllDay: false })
  })

  it('rejects an inverted timed range while allowing the same all-day calendar date', () => {
    const onApply = vi.fn()
    render(<TaskDateRangePicker label="Fechas" startValue="2026-08-25T17:00" endValue="2026-08-25T09:00" allDay={false} onApply={onApply} />)
    fireEvent.click(screen.getByRole('button', { name: /^Fechas:/ }))

    expect(screen.getByRole('alert')).toHaveTextContent('La entrega no puede ser anterior al inicio.')
    expect(screen.getByRole('button', { name: 'Aplicar' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Usar todo el día' }))
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
    expect(screen.getByRole('button', { name: 'Fechas: Agregar fecha de entrega' })).toBeDisabled()

    rerender(<TaskDateRangePicker label="Fechas" startValue="" endValue="" allDay={false} pending onApply={onApply} />)
    const trigger = screen.getByRole('button', { name: 'Fechas: Agregar fecha de entrega' })
    expect(trigger).toBeDisabled()
    expect(trigger).toHaveAttribute('aria-busy', 'true')
    fireEvent.click(trigger)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('offers a compact trigger without changing its accessible contract', () => {
    render(<TaskDateRangePicker label="Fechas de la subtarea" startValue="" endValue="" allDay={false} compact onApply={vi.fn()} />)
    const trigger = screen.getByRole('button', { name: 'Fechas de la subtarea: Agregar fecha de entrega' })
    expect(trigger).toHaveAttribute('data-compact', 'true')
    expect(trigger).toHaveClass('min-h-9')
  })
})

describe('task date range rules', () => {
  it('keeps endpoint summaries explicit and validates all-day ranges by calendar date', () => {
    expect(taskDateRangeSummary('', '', false)).toBe('Agregar fecha de entrega')
    expect(taskDateRangeSummary('2026-08-25T09:00', '', false)).toMatch(/^Inicio: /)
    expect(taskDateRangeSummary('', '2026-08-25T17:00', false)).toMatch(/^Entrega: /)
    expect(taskDateRangeIsValid('2026-08-25T17:00', '2026-08-25T09:00', false)).toBe(false)
    expect(taskDateRangeIsValid('2026-08-25T17:00', '2026-08-25T09:00', true)).toBe(true)
    expect(taskDateRangeIsValid('', '2026-08-25T09:00', false)).toBe(true)
    expect(taskAllDayBoundary('2026-08-25T17:00', 'start')).toBe('2026-08-25T00:00')
    expect(taskAllDayBoundary('2026-08-25T09:00', 'end')).toBe('2026-08-25T23:59')
    expect(taskDueDateOnlyValue('2026-08-25')).toBe('2026-08-25T23:59')
    expect(taskDueDateOnlyValue('fecha-inválida')).toBe('')
  })
})
