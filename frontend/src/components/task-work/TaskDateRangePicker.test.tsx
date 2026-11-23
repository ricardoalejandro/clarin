import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useOperationalDateFields } from '../operational-date/useOperationalDateFields'
import TaskDateRangePicker, { taskAllDayBoundary, taskDateRangeInitialDraft, taskDateRangeIsValid, taskDateRangeSummary, taskDueDateOnlyValue } from './TaskDateRangePicker'

afterEach(cleanup)
const write = (name: string, value: string) => fireEvent.change(screen.getByRole('textbox', { name }), { target: { value } })
const enter = (name: string) => fireEvent.keyDown(screen.getByRole('textbox', { name }), { key: 'Enter' })

describe('visible atomic task dates', () => {
  it('starts empty without inventing today or hours and identifies expanded endpoints', () => {
    const onApply = vi.fn()
    render(<TaskDateRangePicker label="Entrega" startValue="" endValue="" allDay={false} onApply={onApply} />)
    expect(screen.getByRole('textbox', { name: 'Entrega' })).toHaveValue('')
    expect(screen.queryByRole('textbox', { name: /hora/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Añadir fecha de inicio' }))
    expect(screen.getByLabelText('Inicio')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Entrega' })).toBeInTheDocument()
    expect(onApply).not.toHaveBeenCalled()
  })
  it('keeps Tab between endpoints local and commits both latest values once on Enter', () => {
    const onApply = vi.fn()
    render(<TaskDateRangePicker label="Entrega" startValue="2026-08-25T00:00" endValue="2026-08-26T23:59" allDay onApply={onApply} />)
    write('Inicio opcional', '28/08/2026')
    const first = screen.getByRole('textbox', { name: 'Inicio opcional' }), last = screen.getByRole('textbox', { name: 'Entrega' })
    fireEvent.blur(first, { relatedTarget: last })
    expect(onApply).not.toHaveBeenCalled()
    write('Entrega', '30/08/2026'); enter('Entrega'); fireEvent.blur(last)
    expect(onApply).toHaveBeenCalledExactlyOnceWith({ startAt: '2026-08-28T00:00', endAt: '2026-08-30T23:59', isAllDay: true })
  })
  it('commits on leaving the group and retains exact existing hours', async () => {
    const onApply = vi.fn()
    render(<><TaskDateRangePicker label="Entrega" startValue="2026-08-25T09:45" endValue="2026-08-26T17:15" allDay={false} onApply={onApply} /><button>Fuera</button></>)
    write('Inicio opcional', '27/08/2026'); write('Entrega', '28/08/2026')
    const outside = screen.getByRole('button', { name: 'Fuera' }); outside.focus()
    fireEvent.blur(screen.getByRole('textbox', { name: 'Entrega' }), { relatedTarget: outside })
    await waitFor(() => expect(onApply).toHaveBeenCalledExactlyOnceWith({ startAt: '2026-08-27T09:45', endAt: '2026-08-28T17:15', isAllDay: false }))
  })
  it('keeps malformed text visible and blocks reversed ranges including parent Save', () => {
    const onApply = vi.fn(), saved = vi.fn()
    function Form() {
      const fields = useOperationalDateFields()
      return <><TaskDateRangePicker label="Entrega" startValue="2026-08-25T00:00" endValue="2026-08-26T23:59" allDay onApply={onApply} onStartDraftStateChange={fields.track('start')} onEndDraftStateChange={fields.track('end')} /><button onClick={() => { if (fields.validate()) saved() }}>Guardar</button></>
    }
    render(<Form />)
    write('Entrega', '31/04/2026'); enter('Entrega')
    expect(screen.getByRole('textbox', { name: 'Entrega' })).toHaveValue('31/04/2026')
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))
    expect(saved).not.toHaveBeenCalled(); expect(onApply).not.toHaveBeenCalled()
    write('Entrega', '20/08/2026'); enter('Entrega')
    expect(screen.getByRole('alert')).toHaveTextContent('La entrega no puede ser anterior al inicio.')
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))
    expect(saved).not.toHaveBeenCalled(); expect(onApply).not.toHaveBeenCalled()
  })
  it('lets parent Save read the latest valid pair without requiring blur', () => {
    const saved = vi.fn()
    function Form() {
      const fields = useOperationalDateFields()
      const [value, setValue] = useState({ startAt: '', endAt: '', isAllDay: true })
      return <><TaskDateRangePicker label="Entrega" startValue={value.startAt} endValue={value.endAt} allDay={value.isAllDay} onApply={setValue} onStartDraftStateChange={fields.track('start')} onEndDraftStateChange={fields.track('end')} /><button onClick={() => { if (fields.validate()) saved(fields.value('start', value.startAt), fields.value('end', value.endAt)) }}>Guardar</button></>
    }
    render(<Form />); write('Entrega', '12/03/2028'); fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))
    expect(saved).toHaveBeenCalledExactlyOnceWith('', '2028-03-12T23:59')
  })
  it.each(['escape', 'outside'])('calendar %s preserves pre-open text without saving', async action => {
    const onApply = vi.fn()
    render(<TaskDateRangePicker label="Entrega" startValue="" endValue="2026-08-26T23:59" allDay onApply={onApply} />)
    write('Entrega', '28/08/2026')
    const input = screen.getByRole('textbox', { name: 'Entrega' }), trigger = screen.getByRole('button', { name: 'Entrega: 26/08/2026' })
    fireEvent.blur(input, { relatedTarget: trigger }); fireEvent.click(trigger)
    expect(onApply).not.toHaveBeenCalled()
    fireEvent.click(document.querySelector('[data-date-key="2026-08-30"]') as HTMLElement)
    if (action === 'escape') fireEvent.keyDown(window, { key: 'Escape' })
    else fireEvent.mouseDown(document.querySelector('[data-operational-picker-backdrop]') as HTMLElement)
    await waitFor(() => expect(trigger).toHaveFocus())
    expect(input).toHaveValue('28/08/2026'); expect(onApply).not.toHaveBeenCalled()
  })
  it('calendar Apply saves both endpoints once and opening does not confirm text', () => {
    const onApply = vi.fn()
    render(<TaskDateRangePicker label="Entrega" startValue="2026-08-25T00:00" endValue="2026-08-26T23:59" allDay onApply={onApply} />)
    write('Inicio opcional', '27/08/2026')
    fireEvent.click(screen.getByRole('button', { name: 'Entrega: 26/08/2026' }))
    expect(onApply).not.toHaveBeenCalled()
    fireEvent.click(document.querySelector('[data-date-key="2026-08-30"]') as HTMLElement)
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }))
    expect(onApply).toHaveBeenCalledExactlyOnceWith({ startAt: '2026-08-27T00:00', endAt: '2026-08-30T23:59', isAllDay: true })
  })
  it('removes optional start atomically without manufacturing delivery', () => {
    const onApply = vi.fn()
    render(<TaskDateRangePicker label="Entrega" startValue="2026-08-25T09:00" endValue="" allDay={false} onApply={onApply} />)
    fireEvent.click(screen.getByRole('button', { name: 'Quitar inicio' }))
    expect(onApply).toHaveBeenCalledExactlyOnceWith({ startAt: '', endAt: '', isAllDay: false })
    expect(screen.queryByRole('textbox', { name: 'Inicio opcional' })).not.toBeInTheDocument()
  })
  it('adds hours only on demand and disables pending fields', () => {
    const onApply = vi.fn()
    const { rerender } = render(<TaskDateRangePicker label="Entrega" startValue="" endValue="2026-08-26T23:59" allDay onApply={onApply} />)
    fireEvent.click(screen.getByRole('button', { name: 'Añadir hora' }))
    expect(screen.getByRole('textbox', { name: 'Entrega: hora' })).toHaveValue('23:59')
    expect(onApply).toHaveBeenCalledExactlyOnceWith({ startAt: '', endAt: '2026-08-26T23:59', isAllDay: false })
    rerender(<TaskDateRangePicker label="Entrega" startValue="" endValue="2026-08-26T23:59" allDay pending onApply={onApply} />)
    expect(screen.getByRole('textbox', { name: 'Entrega' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Añadir fecha de inicio' })).toBeDisabled()
  })
})

describe('task calendar rules', () => {
  it('does not seed optional dates from today', () => {
    expect(taskDateRangeInitialDraft('', '', false, new Date(2028, 1, 29))).toEqual({ startAt: '', endAt: '', isAllDay: false })
  })
  it('validates calendar dates independently of exact hours and preserves endpoint meaning', () => {
    expect(taskDateRangeSummary('', '', false)).toBe('Agregar fecha de entrega')
    expect(taskDateRangeSummary('2026-08-25T09:00', '', false)).toMatch(/^Inicio: /)
    expect(taskDateRangeSummary('', '2026-08-25T17:00', false)).toMatch(/^Entrega: /)
    expect(taskDateRangeIsValid('2026-08-25T17:00', '2026-08-25T09:00', false)).toBe(false)
    expect(taskDateRangeIsValid('2026-08-25T17:00', '2026-08-25T09:00', true)).toBe(true)
    expect(taskDateRangeIsValid('fecha-inválida', '', false)).toBe(false)
    expect(taskAllDayBoundary('2026-08-25T17:00', 'start')).toBe('2026-08-25T00:00')
    expect(taskDueDateOnlyValue('2026-08-25')).toBe('2026-08-25T23:59')
    expect(taskDueDateOnlyValue('fecha-inválida')).toBe('')
  })
})
