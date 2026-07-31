import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { TaskColorPicker, TaskIconPicker } from './TaskContainerAppearance'
import { TASK_OVERLAY_LAYERS } from './taskOverlayLayers'

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.useRealTimers()
})

function StatefulColorPicker() {
  const [value, setValue] = React.useState('#10B981')
  return <TaskColorPicker value={value} onChange={setValue} label="Color de lista" />
}

describe('task appearance pickers', () => {
  it('portals the color picker above its work window and closes only it with Escape', () => {
    render(<TaskColorPicker value="#10B981" onChange={vi.fn()} label="Color de lista" />)
    fireEvent.click(screen.getByRole('button', { name: /Color de lista/i }))
    expect(screen.getByRole('dialog', { name: 'Color de lista' })).toHaveStyle({ zIndex: String(TASK_OVERLAY_LAYERS.picker) })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Color de lista' })).not.toBeInTheDocument()
  })

  it('keeps icon results stable until the shared 500 ms search delay elapses', () => {
    vi.useFakeTimers()
    render(<TaskIconPicker value="list" onChange={vi.fn()} label="Icono de lista" />)
    fireEvent.click(screen.getByRole('button', { name: /Icono de lista/i }))
    const search = screen.getByPlaceholderText('Buscar por nombre o categoría…')
    fireEvent.change(search, { target: { value: 'cohete' } })
    expect(screen.getByRole('button', { name: 'Bandeja' })).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(499))
    expect(screen.getByRole('button', { name: 'Bandeja' })).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(1))
    expect(screen.queryByRole('button', { name: 'Bandeja' })).not.toBeInTheDocument()
    vi.useRealTimers()
  })

  it('traps focus in the color picker and restores it to its trigger', async () => {
    render(<TaskColorPicker value="#10B981" onChange={vi.fn()} label="Color de lista" />)
    const trigger = screen.getByRole('button', { name: /Color de lista:/i })
    trigger.focus()
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: 'Color de lista' })
    const close = within(dialog).getByRole('button', { name: 'Cerrar Color de lista' })
    const confirm = within(dialog).getByRole('button', { name: 'Usar este color' })

    await waitFor(() => expect(close).toHaveFocus())
    confirm.focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(close).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Color de lista' })).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('traps focus in the icon picker and restores it to its trigger', async () => {
    render(<TaskIconPicker value="list" onChange={vi.fn()} label="Icono de lista" />)
    const trigger = screen.getByRole('button', { name: /Icono de lista:/i })
    trigger.focus()
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: 'Icono de lista' })
    const search = within(dialog).getByPlaceholderText('Buscar por nombre o categoría…')

    await waitFor(() => expect(search).toHaveFocus())
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled])'))
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    last.focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(first).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Icono de lista' })).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('adds only a confirmed color to Recientes, not intermediate HSL values', () => {
    render(<StatefulColorPicker />)
    fireEvent.click(screen.getByRole('button', { name: /Color de lista:/i }))
    const dialog = screen.getByRole('dialog', { name: 'Color de lista' })
    const hue = dialog.querySelector<HTMLInputElement>('input[type="range"]')
    expect(hue).not.toBeNull()

    fireEvent.change(hue!, { target: { value: '120' } })
    fireEvent.change(hue!, { target: { value: '121' } })
    expect(localStorage.getItem('clarin:tasks:recent-colors:v1')).toBeNull()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Usar este color' }))
    const recent = JSON.parse(localStorage.getItem('clarin:tasks:recent-colors:v1') || '[]')
    expect(recent).toHaveLength(1)
    expect(recent[0]).toMatch(/^#[0-9A-F]{6}$/)
  })
})
