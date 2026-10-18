import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProgramScopePicker, programScopePickerPosition } from './ProgramScopePicker'

afterEach(() => { cleanup(); vi.restoreAllMocks() })
const options = [{ value: 'active', label: 'Activos', count: 23 }, { value: 'history', label: 'Historial', count: 0 }] as const
describe('compact Program scope control', () => {
  it('keeps the active scope and total visible and selects empty history by keyboard', () => {
    const onChange = vi.fn()
    render(<ProgramScopePicker value="active" options={options} onChange={onChange} label="Estado de participantes" resultCount={1} />)
    const trigger = screen.getByRole('button', { name: 'Estado de participantes: Activos 23' })
    expect(trigger).toHaveTextContent('1/23')
    expect(trigger).toHaveAccessibleDescription('1 coincidencias de 23')
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    const menu = screen.getByRole('listbox')
    expect(menu).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'End' })
    fireEvent.keyDown(menu, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledExactlyOnceWith('history')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })
  it('Escape cancels without changing the filter and restores focus', () => {
    const onChange = vi.fn()
    render(<ProgramScopePicker value="active" options={options} onChange={onChange} label="Estado" />)
    const trigger = screen.getByRole('button')
    fireEvent.click(trigger)
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' })
    expect(onChange).not.toHaveBeenCalled()
    expect(trigger).toHaveFocus()
  })
  it('clamps to the visual viewport and flips above a bottom-edge trigger', () => {
    const position = programScopePickerPosition({ left: 220, right: 330, top: 280, bottom: 324 }, { width: 320, height: 350, left: 0, top: 0 })
    expect(Number(position.left) + Number(position.width)).toBeLessThanOrEqual(312)
    expect(Number(position.top) + Number(position.maxHeight)).toBeLessThan(280)
    expect(Number(position.left)).toBeGreaterThanOrEqual(8)
  })
  it('preserves keyboard exploration while canonical counts and result totals refresh', () => {
    const onChange = vi.fn()
    const { rerender } = render(<ProgramScopePicker value="active" options={options} onChange={onChange} label="Estado" resultCount={1} />)
    fireEvent.click(screen.getByRole('button'))
    const menu = screen.getByRole('listbox')
    fireEvent.keyDown(menu, { key: 'End' })
    rerender(<ProgramScopePicker value="active" options={[{ value: 'active', label: 'Activos', count: 24 }, { value: 'history', label: 'Historial', count: 2 }]} onChange={onChange} label="Estado" resultCount={2} />)
    expect(screen.getByRole('button', { name: 'Estado: Activos 24' })).toHaveTextContent('2/24')
    expect(menu).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: 'Historial 2' }).id)
    expect(menu).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledExactlyOnceWith('history')
  })
  it.each([
    { rect: { left: 260, right: 370, top: 440, bottom: 484 }, viewport: { width: 320, height: 160, left: 30, top: 200 } },
    { rect: { left: 10, right: 100, top: 190, bottom: 234 }, viewport: { width: 320, height: 60, left: 0, top: 200 } },
  ])('keeps the menu inside a short, offset visual viewport', ({ rect, viewport }) => {
    const position = programScopePickerPosition(rect, viewport)
    expect(Number(position.top)).toBeGreaterThanOrEqual(viewport.top + 8)
    expect(Number(position.top) + Number(position.maxHeight)).toBeLessThanOrEqual(viewport.top + viewport.height - 8)
    expect(Number(position.left) + Number(position.width)).toBeLessThanOrEqual(viewport.left + viewport.width - 8)
  })
  it('dismisses when scrolling moves the trigger out of view without changing selection', () => {
    const onChange = vi.fn()
    render(<ProgramScopePicker value="active" options={options} onChange={onChange} label="Estado" />)
    const trigger = screen.getByRole('button')
    const rect = vi.spyOn(trigger, 'getBoundingClientRect')
    rect.mockReturnValue({ left: 20, right: 140, top: 100, bottom: 144 } as DOMRect)
    fireEvent.click(trigger)
    expect(screen.getByRole('listbox')).toBeVisible()
    rect.mockReturnValue({ left: 20, right: 140, top: -100, bottom: -56 } as DOMRect)
    fireEvent.scroll(window)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })
})
