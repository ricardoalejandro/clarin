import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import TaskWorkWindowShell from './TaskWorkWindowShell'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

function renderShell(onClose = () => undefined, children: React.ReactNode = <button type="button">Contenido</button>) {
  return render(
    <TaskWorkWindowShell
      open
      storageKey="test:task-window"
      title="Filtros"
      eyebrow="Clarin Work"
      onRequestClose={onClose}
    >
      {children}
    </TaskWorkWindowShell>,
  )
}

describe('TaskWorkWindowShell', () => {
  it('switches between floating, docked and maximized modes', () => {
    renderShell()
    const shell = document.querySelector('[data-task-work-window-shell]')
    expect(shell).toHaveAttribute('data-window-mode', 'floating')

    fireEvent.click(screen.getByRole('button', { name: 'Acoplar a la derecha' }))
    expect(shell).toHaveAttribute('data-window-mode', 'docked')

    fireEvent.click(screen.getByRole('button', { name: 'Maximizar' }))
    expect(shell).toHaveAttribute('data-window-mode', 'maximized')
    expect(screen.getByRole('button', { name: 'Restaurar' })).toBeInTheDocument()
  })

  it('closes the top-level work window with Escape', () => {
    let closes = 0
    renderShell(() => { closes += 1 })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(closes).toBe(1)
  })

  it('keeps floating workspace interaction non-modal', () => {
    renderShell()
    const dialog = screen.getByRole('dialog', { name: 'Filtros' })
    expect(dialog).toHaveAttribute('aria-modal', 'false')
    expect(document.querySelector('[data-task-work-window-shell]')).toHaveAttribute('data-backdrop-mode', 'floating')
  })

  it('preserves a child autofocus target instead of replacing it with the window panel', async () => {
    renderShell(() => undefined, <input autoFocus aria-label="Buscar tareas" />)
    const search = screen.getByRole('textbox', { name: 'Buscar tareas' })

    await waitFor(() => expect(search).toHaveFocus())
    expect(screen.getByRole('dialog', { name: 'Filtros' })).not.toHaveFocus()
  })
})
